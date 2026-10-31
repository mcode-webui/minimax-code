import { createRequire } from "node:module";

import {
  WORKSPACE_ARCHIVE_MAX_ENTRIES,
  WORKSPACE_ARCHIVE_MAX_EXPANSION_RATIO,
  normalizeEntryName,
  nameVerdict,
  readEntryBounded,
  ZIP_DIRECTORY_CORRUPT,
  ZIP_ENTRY_CORRUPT,
  ZIP_UNREADABLE,
  ZIP_UNSAFE_NAME_PATTERN,
} from "./archive-policy.js";
import {
  resolveEntryPath,
  rootPrefix,
  writeExtractedFile,
} from "./archive-filesystem.js";
import { entryPathUnderPrefix } from "./archive-listing.js";
import type {
  ArchiveContents,
  ArchiveEntry,
  ExpansionBudget,
  NameVerdict,
  ZipParserEntry,
  ZipParserFile,
  ZipParserModule,
} from "./archive-types.js";

const require = createRequire(import.meta.url);

/** Resolved per call so a missing optional dependency fails only when used. */
function loadZipParser(): ZipParserModule {
  return require("yauzl") as ZipParserModule;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export const ZIP_END_RECORD_SIZE = 22;

const ZIP_MAX_COMMENT = 0xffff;

/** The count/offset sentinels that mean "the real value is in the zip64 records". */
const ZIP_SENTINEL_ENTRIES = 0xffff;

const ZIP_SENTINEL_32 = 0xffffffff;

/**
 * ZIP: `yauzl` walks the container, this module keeps the policy.
 *
 * The hand-rolled central-directory walk this replaced was a re-implementation
 * of a mature format — the class of code this repository does not keep for its
 * own sake. What stays here is what is *this* product's policy and not the
 * format's: the zip64 refusal keeps its named outcome, the entry ceiling still
 * stops a listing from building a million strings, every name still goes
 * through `nameVerdict`, the symlink refusal is unchanged, and the byte budget
 * still charges the bytes as they arrive rather than trusting the header.
 *
 * The parser's own failures are translated into the module's messages, because
 * those messages are what the panel shows and what the conformance corpus
 * asserts; yauzl's text is about a zip, not about this workspace.
 */
export async function readZipEntries(buffer: Buffer): Promise<ArchiveContents> {
  const endRecord = findZipEndRecord(buffer);
  const declaredEntries = buffer.readUInt16LE(endRecord + 10);
  const directoryOffset = buffer.readUInt32LE(endRecord + 16);
  const directorySize = buffer.readUInt32LE(endRecord + 12);
  // The sentinels mean "look in the zip64 end-of-central-directory records".
  // yauzl could read those; this reader deliberately does not, so the outcome a
  // zip64 archive gets is the one it already had rather than a silent capability
  // change.
  if (
    declaredEntries === ZIP_SENTINEL_ENTRIES ||
    directoryOffset === ZIP_SENTINEL_32 ||
    directorySize === ZIP_SENTINEL_32
  ) {
    throw new Error("这是 ZIP64 压缩包，工作区面板暂不支持。");
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new Error("ZIP 中央目录越界，文件可能已损坏。");
  }

  let zip: ZipParserFile;
  try {
    zip = await loadZipParser().fromBufferPromise(buffer, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      autoClose: false,
    });
  } catch {
    throw new Error(ZIP_UNREADABLE);
  }

  const entries: ArchiveEntry[] = [];
  let walked = 0;
  let ended = false;
  try {
    while (walked < WORKSPACE_ARCHIVE_MAX_ENTRIES) {
      const record = await readNextZipEntry(zip);
      if (!record) {
        ended = true;
        break;
      }
      walked += 1;
      const entry = zipEntry(zip, record);
      if (entry) entries.push(entry);
    }
  } catch (error) {
    zip.close();
    const message = error instanceof Error ? error.message : "";
    // A refusal this module already named keeps its text.
    if (message === ZIP_ENTRY_CORRUPT) throw error;
    const unsafeName = ZIP_UNSAFE_NAME_PATTERN.exec(message)?.[1]?.trim();
    if (unsafeName) throw new Error(`压缩包中存在不安全的条目：${unsafeName}`);
    throw new Error(ZIP_DIRECTORY_CORRUPT);
  }

  return {
    entries,
    totalEntries: declaredEntries,
    truncated: !ended || walked < declaredEntries,
    close: () => zip.close(),
  };
}

/** One step of yauzl's lazy entry walk, as a promise; `undefined` ends it. */
function readNextZipEntry(
  zip: ZipParserFile,
): Promise<ZipParserEntry | undefined> {
  return new Promise((resolve, reject) => {
    const settle = <T>(value: T): T => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
      return value;
    };
    const onEntry = (entry: ZipParserEntry): void => resolve(settle(entry));
    const onEnd = (): void => resolve(settle(undefined));
    const onError = (error: Error): void => reject(settle(error));
    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });
}

/**
 * Scans backwards for the end-of-central-directory record.
 *
 * Scanned rather than read at a fixed offset because the record is followed by
 * an archive comment of up to 64 KiB. A candidate is accepted only when its own
 * comment length lands exactly on the end of the file, which is what stops the
 * same four signature bytes appearing inside compressed data from being read as
 * the real record — and what turns a truncated archive into a clear "this is
 * not a zip" instead of a wild offset.
 */
function findZipEndRecord(buffer: Buffer): number {
  const earliest = Math.max(
    0,
    buffer.length - (ZIP_END_RECORD_SIZE + ZIP_MAX_COMMENT),
  );
  for (
    let offset = buffer.length - ZIP_END_RECORD_SIZE;
    offset >= earliest;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    if (
      offset + ZIP_END_RECORD_SIZE + buffer.readUInt16LE(offset + 20) ===
      buffer.length
    )
      return offset;
  }
  throw new Error(
    "这不是可识别的 ZIP 压缩包（缺少中央目录结束记录，文件可能已截断）。",
  );
}

/**
 * One `yauzl` entry as this module's entry.
 *
 * The unix-mode read is the one the central directory carried — yauzl exposes
 * the same `externalFileAttributes`/`versionMadeBy` pair this module used to
 * decode by hand, so the directory test and the symlink refusal keep their
 * meaning exactly.
 */
function zipEntry(
  zip: ZipParserFile,
  record: ZipParserEntry,
): ArchiveEntry | undefined {
  const unixHost = record.versionMadeBy >> 8 === 3;
  const unixMode = unixHost
    ? (record.externalFileAttributes >>> 16) & 0xffff
    : undefined;
  const isDirectory =
    record.fileName.endsWith("/") ||
    (unixMode !== undefined && (unixMode & 0o040000) !== 0);
  // Refuse the link rather than materialise one, because a symlink written into
  // a workspace is a write primitive pointing wherever the attacker likes.
  const symbolicLink =
    unixMode !== undefined && (unixMode & 0o170000) === 0o120000;
  const verdict = symbolicLink
    ? ({ reason: "条目是符号链接" } satisfies NameVerdict)
    : nameVerdict(normalizeEntryName(record.fileName), isDirectory);
  if (verdict.drop) return undefined;
  return {
    rawName: record.fileName,
    ...(verdict.path ? { path: verdict.path } : {}),
    isDirectory,
    declaredSize: record.uncompressedSize,
    compressedSize: record.compressedSize,
    ...(verdict.reason ? { unsafeReason: verdict.reason } : {}),
    read: (budget) => readZipEntryData(zip, record, isDirectory, budget),
  };
}

/**
 * Streams one entry's bytes, charging the shared budget as they arrive.
 *
 * The cap is enforced during the stream, not after it: a header claiming twelve
 * bytes and delivering a gigabyte is stopped while it is still arriving instead
 * of being allowed to allocate what it asked for. yauzl's own size validation
 * covers the mismatch between the declared and delivered lengths; both failures
 * leave the operation with this module's message.
 */
async function readZipEntryData(
  zip: ZipParserFile,
  record: ZipParserEntry,
  isDirectory: boolean,
  budget: ExpansionBudget,
): Promise<Buffer> {
  if (isDirectory) return Buffer.alloc(0);
  if (budget.remaining <= 0)
    throw new Error("压缩包展开后的体积过大，已拒绝读取。");
  try {
    const stream = await zip.openReadStreamPromise(record);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      if (total > budget.remaining) {
        (stream as { destroy?: () => void }).destroy?.();
        throw new Error("压缩包展开后的体积过大，已拒绝读取。");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("压缩包展开后")) throw error;
    throw new Error(ZIP_ENTRY_CORRUPT);
  }
}

/** The extraction pass for a zip: the walk already happened, so each entry is read in turn. */
export async function writeZipSelection(
  root: string,
  selected: readonly ArchiveEntry[],
  prefix: string,
  budget: ExpansionBudget,
): Promise<number> {
  let writtenFiles = 0;
  for (const entry of selected) {
    if (entry.isDirectory) continue;
    const target = resolveEntryPath(root, entryPathUnderPrefix(entry, prefix));
    await writeExtractedFile(root, target, entry, budget);
    writtenFiles += 1;
  }
  return writtenFiles;
}
