// Reads and extracts the workspace archives the panel previews.
//
// Two container formats, parsed here with Node built-ins only: `zip` (scan back
// for the End Of Central Directory record, walk the central directory it points
// at, inflate the local file data with `inflateRawSync`) and `tar` (512-byte
// blocks, `gunzipSync` first for `.tar.gz` / `.tgz`). `@mavis/webui` is a
// published package, so neither `jszip` nor `tar` may be added as a dependency
// without changing what every consumer installs; the parsers below are the
// smallest thing that reads those two formats honestly.
//
// The hardening is ported from the runtime's two battle-tested extractors:
//   * `packages/local-runtime/src/website-management/deployed-website-source.ts`
//     — `extractArchive`, `assertSafeZipEntry`, `isSymbolicLink`,
//     `resolveEntryPath`, `readUncompressedSize`.
//   * `packages/local-runtime/src/skills/remote/archive.ts` —
//     `loadZipSkillFiles`, `shouldStripArchiveRoot`.
// Neither can be imported across the package boundary (webui may not depend on
// local-runtime, and the runtime already depends on webui), so the checks are
// re-implemented against the raw bytes and the two-phase shape is kept: every
// entry is validated and the declared sizes summed *before* a single byte is
// written, so a hostile archive leaves nothing behind.
//
// `shouldStripArchiveRoot` is the one deliberate non-port — see the comment on
// `listOneLevel`.

import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import type {
  WebuiArchiveEntry,
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
} from "./port.js";

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * Largest compressed archive this module will read into memory.
 *
 * 200 MiB, the same figure `deployed-website-source.ts` uses for a *downloaded*
 * archive. The panel is previewing a file the user already has in their own
 * workspace tree, so nothing is arriving over a network, and a cap far below
 * this would refuse legitimate build outputs (`target/`, `.next/`) that are
 * routinely zipped up and opened for inspection.
 */
const WORKSPACE_ARCHIVE_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * Largest total expansion, enforced against the declared sizes (before
 * inflating anything), against the bytes each entry actually produced (after),
 * and *during* inflation via zlib's `maxOutputLength`.
 *
 * 512 MiB, matching `DEPLOYED_WEBSITE_SOURCE_MAX_UNCOMPRESSED_BYTES`. The
 * declared pass is the cheap pre-flight; the runtime pass is the one that
 * matters, because a header can lie. Enforcing it during inflation rather than
 * after is what stops a lying header from getting to allocate the memory it
 * asked for in the first place.
 */
const WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * Per-entry expansion ceiling: `uncompressed / compressed`.
 *
 * DEFLATE's format maximum is about 1032:1 (a 258-byte match encoded in a
 * fraction of a token), so 2000:1 admits everything a conforming compressor can
 * emit — including a maximally compressible file of zeroes — while still
 * refusing the classic "a 1 KB archive expands to gigabytes" shape entry by
 * entry. The absolute total-bytes cap is the real memory guard; this one exists
 * so a single member cannot quietly consume the whole budget.
 */
const WORKSPACE_ARCHIVE_MAX_EXPANSION_RATIO = 2000;

/**
 * Most entries the reader will materialise.
 *
 * 10,000, one notch above the sibling extractor's 5,000. The difference is the
 * consumer: a headless install has to *write* every entry, while this reader
 * only ever renders one level, so the ceiling exists to bound parse memory
 * rather than disk. "A zip with a million tiny entries" is the shape that would
 * exhaust memory while building a listing, and 10,000 stays two orders of
 * magnitude below it while remaining past any real project tree.
 */
const WORKSPACE_ARCHIVE_MAX_ENTRIES = 10_000;

/**
 * Most rows one listing level reports before it declares itself truncated.
 *
 * 500, the same page size the workspace directory picker uses
 * (`WORKSPACE_DIRECTORY_LIMIT` in `src/server/operation/workspace.ts`): enough
 * for a directory to stay browsable, few enough that the response does not.
 * The entry ceiling above sits well past this, so `totalEntries` can honestly
 * report how much of the archive the page left out.
 */
const WORKSPACE_ARCHIVE_MAX_LISTED_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Format set
// ---------------------------------------------------------------------------

/**
 * The extensions the client routes to the archive preview, mirrored from
 * `WORKSPACE_ARCHIVE_EXTENSIONS` in `src/client/components/WorkspacePanels.tsx`.
 *
 * Mirrored rather than imported because that module is browser-side and this is
 * the server, but the two lists must not drift: a format this module cannot
 * read still has to be a *recognised* archive here, so the user gets "unsupported
 * format" rather than "this is not an archive". Which of them can actually be
 * opened is decided by `archiveFormatFor`.
 */
const WORKSPACE_ARCHIVE_EXTENSIONS = [
  ".zip",
  ".tar",
  ".tgz",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
] as const;

type ArchiveFormat = "zip" | "tar" | "tar.gz";

/**
 * Which of the client's extensions this reader can open, and by what name it
 * refuses the rest.
 *
 * `.gz` is in the client list as a suffix match, so `x.tar.gz` routes here too;
 * a bare `.gz` is one compressed stream with no directory structure and no way
 * to tell a gzipped tar from a gzipped text file, so it is refused rather than
 * guessed at. `.bz2` and `.xz` have no decompressor in `node:zlib`. `.7z` and
 * `.rar` are proprietary container formats this module does not parse.
 */
function archiveFormatFor(archivePath: string): { readonly format: ArchiveFormat } | { readonly error: string } {
  const lower = archivePath.toLowerCase();
  if (!WORKSPACE_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return { error: "只有 .zip、.tar、.tgz 和 .tar.gz 可以在工作区面板中打开。" };
  }
  if (lower.endsWith(".zip")) return { format: "zip" };
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return { format: "tar.gz" };
  if (lower.endsWith(".tar")) return { format: "tar" };
  if (lower.endsWith(".gz")) return { error: ".gz 是单个压缩流、没有目录结构；请改用 .tar.gz 或 .tgz。" };
  if (lower.endsWith(".bz2") || lower.endsWith(".xz")) {
    return { error: "Node 内置压缩库不支持 bzip2 或 xz；请改用 .zip、.tar 或 .tar.gz。" };
  }
  return { error: "不支持的压缩包格式（.7z / .rar）；请改用 .zip、.tar 或 .tar.gz。" };
}

// ---------------------------------------------------------------------------
// Entry model
// ---------------------------------------------------------------------------

type ArchiveEntry = {
  /** The name exactly as the container stored it, before normalisation. */
  readonly rawName: string;
  /**
   * Archive-internal POSIX path, absent when `unsafeReason` is set. An entry
   * without a path is never named to the client and never written.
   */
  readonly path?: string;
  readonly isDirectory: boolean;
  /** Size the container claims for this entry; the header may be lying. */
  readonly declaredSize: number;
  /** Compressed size, the denominator of the expansion-ratio ceiling. */
  readonly compressedSize: number;
  /** Why this entry is refused, in the panel's own words. */
  readonly unsafeReason?: string;
  /** Materialises the entry's bytes, charged against `budget`. */
  read(budget: ExpansionBudget): Buffer;
};

type ArchiveContents = {
  readonly entries: readonly ArchiveEntry[];
  /** Entries the archive holds, which may exceed `entries.length`. */
  readonly totalEntries: number;
  /** True when the entry ceiling cut the container short. */
  readonly truncated: boolean;
};

/**
 * Byte budget shared by every entry in one operation, so neither the
 * per-entry ratio ceiling nor the total cap can be sidestepped by splitting a
 * bomb across many entries.
 */
type ExpansionBudget = { remaining: number };

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One level of an archive, as the panel's preview shows it.
 *
 * The read path only ever names entries it is willing to write, which is what
 * the port's contract asks for ("the view renders only what this call is willing
 * to name"): an entry whose name is unsafe is dropped and the listing is marked
 * truncated, rather than displayed now and refused at extraction time.
 */
export async function readWorkspaceArchiveListing(request: {
  readonly workspaceDir: string;
  readonly path: string;
  readonly prefix?: string;
}): Promise<WebuiWorkspaceArchiveListing> {
  const archivePath = await resolveArchiveFile(request.workspaceDir, request.path);
  const { format, buffer } = await readArchive(archivePath);
  const prefix = normalizePrefix(request.prefix);
  const contents = readContents(buffer, format);
  const level = listOneLevel(contents, prefix);
  return {
    archivePath: normalizeArchiveRelativePath(request.path),
    entries: level.entries,
    totalEntries: contents.totalEntries,
    // Two honest reasons to be truncated, and the view has to say so either way
    // rather than render a partial list as if it were the whole archive: the
    // reader stopped at the entry ceiling, or this one level held more rows
    // than a page carries (or an entry the reader refused to name).
    truncated: contents.truncated || level.truncated,
  };
}

/**
 * Writes the entries under `prefix` (or the whole archive) into `destination`.
 *
 * `destination` is a path *inside* the workspace, chosen by the view: a browser
 * cannot ask for an arbitrary absolute path, and a free-text destination would
 * make this a path-traversal endpoint rather than a feature. It is resolved and
 * validated against the workspace root before anything is created, and every
 * written path is re-validated against the extraction root after joining, so a
 * hostile entry name cannot escape either one.
 *
 * Two phases, as in the sibling extractor: every name is validated and the
 * declared sizes summed *before* the destination is created, so an archive with
 * a hostile name or a lying header leaves nothing at all behind. A failure
 * discovered per entry — a corrupt stream, an expansion blow-up, a file that
 * already exists — happens after some directories exist, and the invariant
 * there is that no *file* is ever half-written: bytes are read in full, capped
 * and checked before `writeFile` is called.
 */
export async function extractWorkspaceArchiveDirectory(request: {
  readonly workspaceDir: string;
  readonly path: string;
  readonly destination: string;
  readonly prefix?: string;
}): Promise<WebuiWorkspaceArchiveExtractResult> {
  const archivePath = await resolveArchiveFile(request.workspaceDir, request.path);
  const { format, buffer } = await readArchive(archivePath);
  const prefix = normalizePrefix(request.prefix);
  const contents = readContents(buffer, format);
  const selected = selectForExtraction(contents, prefix);

  let declared = 0;
  for (const entry of selected) {
    if (entry.unsafeReason) throw new Error(`压缩包中存在不安全的条目：${entry.unsafeReason}`);
    declared += entry.declaredSize;
    if (declared > WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
      throw new Error("压缩包声明的展开后体积过大，已拒绝解压。");
    }
  }

  const root = await prepareExtractionRoot(request.workspaceDir, request.destination);
  const budget: ExpansionBudget = { remaining: WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES };
  let writtenFiles = 0;
  for (const entry of selected) {
    if (entry.isDirectory) continue;
    const target = resolveEntryPath(root, entryPathUnderPrefix(entry, prefix));
    await writeExtractedFile(root, target, entry, budget);
    writtenFiles += 1;
  }

  return {
    archivePath: normalizeArchiveRelativePath(request.path),
    destination: normalizeArchiveRelativePath(request.destination),
    writtenFiles,
    // The port asks for this rather than a refusal: the destination now holds a
    // partial tree, and the view has to say so instead of implying the archive
    // was written out in full.
    ...(contents.truncated ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Workspace path handling
// ---------------------------------------------------------------------------

/**
 * Resolves the archive's own path inside the workspace.
 *
 * The relative path arrives from the browser, so it gets the same treatment as
 * an entry name: `resolve` collapses every `..`, and what is left to reject is
 * an absolute path or a sibling that merely shares a prefix (`/repo-evil`
 * against root `/repo`) — hence the separator-terminated comparison rather than
 * a bare `startsWith(root)`.
 */
async function resolveArchiveFile(workspaceDir: string, relative: string): Promise<string> {
  if (!relative.trim()) throw new Error("压缩包路径为空。");
  const root = await realpath(path.resolve(workspaceDir));
  const target = resolveInside(root, relative, "压缩包路径");
  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    if (isMissingPath(error)) throw new Error("工作区中找不到这个压缩包。");
    throw error;
  }
  if (!stats.isFile()) throw new Error("压缩包不是一个文件。");
  // Checked before `readFile`, so an oversized archive is refused rather than
  // allocated and then refused.
  if (stats.size > WORKSPACE_ARCHIVE_MAX_ARCHIVE_BYTES) throw new Error("压缩包过大，无法在面板中打开。");
  return target;
}

/**
 * Validates and creates the directory an extraction may write into.
 *
 * The destination is untrusted input like everything else here: resolved
 * against the workspace root, refused if it lands outside, and re-checked
 * *after* `realpath` so a symlinked ancestor cannot redirect the writes
 * somewhere else. Only then is anything created — a refused destination must
 * not leave a directory behind.
 */
async function prepareExtractionRoot(workspaceDir: string, destination: string): Promise<string> {
  if (!destination.trim()) throw new Error("解压目标为空。");
  const root = await realpath(path.resolve(workspaceDir));
  const requested = resolveInside(root, destination, "解压目标");
  await mkdir(requested, { recursive: true });
  const resolved = await realpath(requested);
  // Re-anchored on the resolved path: the same check that passed above can pass
  // through a symlinked ancestor, and only the resolved pair proves containment.
  resolveInside(root, resolved, "解压目标");
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink()) throw new Error("解压目标不能是符号链接。");
  if (!stats.isDirectory()) throw new Error("解压目标不是一个目录。");
  return resolved;
}

/**
 * `resolve`, then a separator-terminated containment check.
 *
 * Ported from `resolveEntryPath` in `deployed-website-source.ts` and kept in
 * the form the sibling's own comment argues for: a string prefix wrongly
 * accepts `/tmp/evil` for a root of `/tmp/ev`.
 */
function resolveInside(root: string, name: string, what: string): string {
  const destination = path.resolve(root, name);
  if (destination !== root && !destination.startsWith(rootPrefix(root))) {
    throw new Error(`${what}越界：${name}`);
  }
  return destination;
}

/** The same check, re-anchored on the extraction root for one entry name. */
function resolveEntryPath(root: string, name: string): string {
  const destination = path.resolve(root, name);
  if (destination !== root && !destination.startsWith(rootPrefix(root))) {
    throw new Error(`压缩包条目越界：${name}`);
  }
  return destination;
}

function rootPrefix(root: string): string {
  return root.endsWith(path.sep) ? root : `${root}${path.sep}`;
}

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Ported from `assertSafeZipEntry` in `deployed-website-source.ts`, widened from
 * zip to every container: no NUL, not absolute on any platform, no `..`
 * segment, and no Windows drive letter.
 *
 * Two deliberate differences from the sibling, both about not refusing archives
 * that are not attacks:
 *
 *   * A `.` segment is *dropped* rather than refused. `tar cf x.tar .` and
 *     `zip -r x.zip .` put `./` on every single member, so the sibling's rule
 *     would make the most common tarball in existence unreadable. A `.` cannot
 *     escape anything — `resolve` collapses it — and the traversal that matters,
 *     `..`, stays refused.
 *   * A name that normalises away to nothing (`./`, `.`) is reported as a *root
 *     marker* rather than as a refusal, because it is the container saying
 *     "this archive is rooted here", not content. Counting it as refused would
 *     mark every such archive truncated.
 *
 * The drive-letter clause is the one `win32.isAbsolute` does not cover on its
 * own — it accepts `C:\x` but not the drive-relative `C:x`, which resolves to
 * that drive's current directory on Windows.
 */
type NormalizedName = { readonly path: string } | { readonly root: true } | { readonly reason: string };

function normalizeEntryName(rawName: string): NormalizedName {
  if (!rawName) return { reason: "条目名为空" };
  if (rawName.includes("\0")) return { reason: "条目名包含 NUL 字节" };
  const unified = rawName.replace(/\\/gu, "/");
  if (
    unified.startsWith("/") ||
    path.isAbsolute(rawName) ||
    path.posix.isAbsolute(unified) ||
    path.win32.isAbsolute(rawName)
  ) {
    return { reason: "条目名是绝对路径" };
  }
  const parts = unified.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return { reason: "条目名包含 .. 路径段" };
  if (parts.length === 0) return { root: true };
  if (/^[A-Za-z]:/u.test(parts[0]!)) return { reason: "条目名包含 Windows 盘符" };
  return { path: parts.join("/") };
}

/** A normalised name resolved into what an entry should carry. */
type NameVerdict = { readonly path?: string; readonly reason?: string; readonly drop?: boolean };

function nameVerdict(normalized: NormalizedName, isDirectory: boolean): NameVerdict {
  if ("root" in normalized) return isDirectory ? { drop: true } : { reason: "条目名为空" };
  if ("reason" in normalized) return { reason: normalized.reason };
  return { path: normalized.path };
}

/** The workspace-relative form echoed back to the client for display. */
function normalizeArchiveRelativePath(value: string): string {
  const normalized = normalizeEntryName(value);
  return "path" in normalized ? normalized.path : "root" in normalized ? "" : value;
}

/**
 * The prefix a listing is scoped to, validated with the same rules as an entry
 * name. It round-trips through the client, so it is attacker-influenced even
 * though this module is what produced it.
 */
function normalizePrefix(raw: string | undefined): string {
  if (!raw) return "";
  const normalized = normalizeEntryName(raw);
  if ("path" in normalized) return normalized.path;
  if ("root" in normalized) return "";
  throw new Error(`无法识别的压缩包内路径：${normalized.reason}`);
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_END_RECORD_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;
/** The count/offset sentinels that mean "the real value is in the zip64 records". */
const ZIP_SENTINEL_ENTRIES = 0xffff;
const ZIP_SENTINEL_32 = 0xffffffff;

type ZipDirectoryEntry = {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly unixMode: number | undefined;
  readonly nameLength: number;
  readonly extraLength: number;
  readonly commentLength: number;
};

function readZipEntries(buffer: Buffer): ArchiveContents {
  const endRecord = findZipEndRecord(buffer);
  const declaredEntries = buffer.readUInt16LE(endRecord + 10);
  const directoryOffset = buffer.readUInt32LE(endRecord + 16);
  const directorySize = buffer.readUInt32LE(endRecord + 12);
  // The sentinels mean "look in the zip64 end-of-central-directory records",
  // which this reader does not parse. Refusing by name beats reading a shifted
  // offset and writing whatever the garbage points at.
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

  const entries: ArchiveEntry[] = [];
  let cursor = directoryOffset;
  let walked = 0;
  for (let index = 0; index < declaredEntries; index += 1) {
    // The walk stops at the ceiling: the count is attacker-controlled, and a
    // listing must not build a million strings to report that it cannot show a
    // million strings.
    if (walked >= WORKSPACE_ARCHIVE_MAX_ENTRIES) break;
    walked += 1;
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
      throw new Error("ZIP 中央目录已损坏，条目记录不完整。");
    }
    const record = readZipDirectoryEntry(buffer, cursor);
    cursor += 46 + record.nameLength + record.extraLength + record.commentLength;
    if (cursor > buffer.length) throw new Error("ZIP 中央目录已损坏，条目记录越界。");
    const entry = zipEntry(buffer, record);
    if (entry) entries.push(entry);
  }

  return { entries, totalEntries: declaredEntries, truncated: walked < declaredEntries };
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
  const earliest = Math.max(0, buffer.length - (ZIP_END_RECORD_SIZE + ZIP_MAX_COMMENT));
  for (let offset = buffer.length - ZIP_END_RECORD_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    if (offset + ZIP_END_RECORD_SIZE + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw new Error("这不是可识别的 ZIP 压缩包（缺少中央目录结束记录，文件可能已截断）。");
}

function readZipDirectoryEntry(buffer: Buffer, offset: number): ZipDirectoryEntry {
  const flags = buffer.readUInt16LE(offset + 8);
  const nameLength = buffer.readUInt16LE(offset + 28);
  const nameStart = offset + 46;
  return {
    // Bit 11 marks UTF-8 names; without it the spec says CP437, which this
    // module approximates with latin1. The two agree on every ASCII name and
    // differ only in the C1 box-drawing range.
    name: buffer.toString(flags & 0x800 ? "utf8" : "latin1", nameStart, nameStart + nameLength),
    method: buffer.readUInt16LE(offset + 10),
    compressedSize: buffer.readUInt32LE(offset + 20),
    uncompressedSize: buffer.readUInt32LE(offset + 24),
    localHeaderOffset: buffer.readUInt32LE(offset + 42),
    // The unix mode lives in the high 16 bits of the external attributes, and
    // only when the archive was written on a unix host (the high byte of
    // "version made by"). Same rule as the sibling's `isSymbolicLink`, minus
    // JSZip's `unixPermissions` accessor.
    unixMode: buffer.readUInt16LE(offset + 4) >> 8 === 3 ? (buffer.readUInt32LE(offset + 38) >>> 16) & 0xffff : undefined,
    nameLength,
    extraLength: buffer.readUInt16LE(offset + 30),
    commentLength: buffer.readUInt16LE(offset + 32),
  };
}

function zipEntry(buffer: Buffer, record: ZipDirectoryEntry): ArchiveEntry | undefined {
  const isDirectory =
    record.name.endsWith("/") || (record.unixMode !== undefined && (record.unixMode & 0o040000) !== 0);
  // `isSymbolicLink` from the sibling: refuse the link rather than
  // materialise one, because a symlink written into a workspace is a write
  // primitive pointing wherever the attacker likes.
  const symbolicLink = record.unixMode !== undefined && (record.unixMode & 0o170000) === 0o120000;
  const verdict = symbolicLink
    ? ({ reason: "条目是符号链接" } satisfies NameVerdict)
    : nameVerdict(normalizeEntryName(record.name), isDirectory);
  if (verdict.drop) return undefined;
  return {
    rawName: record.name,
    ...(verdict.path ? { path: verdict.path } : {}),
    isDirectory,
    declaredSize: record.uncompressedSize,
    compressedSize: record.compressedSize,
    ...(verdict.reason ? { unsafeReason: verdict.reason } : {}),
    read: (budget) => readZipEntryData(buffer, record, isDirectory, budget),
  };
}

function readZipEntryData(
  buffer: Buffer,
  record: ZipDirectoryEntry,
  isDirectory: boolean,
  budget: ExpansionBudget,
): Buffer {
  if (isDirectory) return Buffer.alloc(0);
  const header = record.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error("ZIP 条目的本地头已损坏。");
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + record.compressedSize;
  if (end > buffer.length) throw new Error("ZIP 条目数据越界，文件可能已损坏。");
  // Sizes come from the central directory, never from the local header: with the
  // streaming flag set, a local header's size fields are zero and the real
  // values follow the data in a trailing descriptor.
  const raw = buffer.subarray(start, end);
  if (record.method === 0) return raw;
  if (record.method !== 8) throw new Error(`ZIP 条目使用了不支持的压缩方法（${record.method}）。`);
  return inflateEntry(raw, budget);
}

// ---------------------------------------------------------------------------
// TAR
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;
const TAR_TYPEFLAG_OFFSET = 156;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;
const TAR_TYPE_FILE = "0";
const TAR_TYPE_DIRECTORY = "5";
const TAR_TYPE_PAX = "x";
const TAR_TYPE_GLOBAL_PAX = "g";
const TAR_TYPE_GNU_LONG_NAME = "L";

function readTarEntries(buffer: Buffer): ArchiveContents {
  const entries: ArchiveEntry[] = [];
  let cursor = 0;
  // A GNU long-name (`L`) or pax (`x`) header carries the real name of the entry
  // that follows it, in the data block rather than the 100-byte name field.
  let overrideName: string | undefined;
  let walked = 0;

  while (cursor + TAR_BLOCK_SIZE <= buffer.length) {
    if (walked >= WORKSPACE_ARCHIVE_MAX_ENTRIES) break;
    const header = buffer.subarray(cursor, cursor + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) break;
    walked += 1;
    verifyTarChecksum(header);
    const typeflag = String.fromCharCode(header[TAR_TYPEFLAG_OFFSET] ?? 0);
    const size = readTarSize(header, TAR_SIZE_OFFSET);
    const dataStart = cursor + TAR_BLOCK_SIZE;
    const padded = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (size < 0 || dataStart + padded > buffer.length) {
      throw new Error("tar 条目越界，文件可能已截断。");
    }
    const data = buffer.subarray(dataStart, dataStart + size);
    const name = overrideName ?? readTarName(header);
    cursor = dataStart + padded;
    overrideName = undefined;

    if (typeflag === TAR_TYPE_GNU_LONG_NAME) {
      overrideName = readNulTerminated(data);
      continue;
    }
    if (typeflag === TAR_TYPE_PAX) {
      // bsdtar writes one of these per member, carrying extended attributes and
      // sometimes the real path. It describes the *next* entry, never content.
      overrideName = readPaxPath(data) ?? overrideName;
      continue;
    }
    if (typeflag === TAR_TYPE_GLOBAL_PAX) continue;

    const isDirectory = typeflag === TAR_TYPE_DIRECTORY || name.endsWith("/");
    if (!isDirectory && typeflag !== TAR_TYPE_FILE && typeflag !== "\0") {
      // The tar analogue of the zip symlink refusal, and it covers more: hard
      // links, devices and FIFOs are all refused, because none of them is
      // something this panel has any business creating in a workspace.
      entries.push({
        rawName: name,
        isDirectory: false,
        declaredSize: size,
        compressedSize: size,
        unsafeReason: tarTypeRefusal(typeflag),
        read: () => data,
      });
      continue;
    }
    const verdict = nameVerdict(normalizeEntryName(name), isDirectory);
    if (verdict.drop) continue;
    entries.push({
      rawName: name,
      ...(verdict.path ? { path: verdict.path } : {}),
      isDirectory,
      declaredSize: size,
      // A tar member is stored as-is, so its "compressed" size is its own
      // length; a `.tar.gz` is capped as a whole buffer at gunzip time instead.
      compressedSize: size,
      ...(verdict.reason ? { unsafeReason: verdict.reason } : {}),
      read: () => data,
    });
  }

  return { entries, totalEntries: entries.length, truncated: walked >= WORKSPACE_ARCHIVE_MAX_ENTRIES };
}

function tarTypeRefusal(typeflag: string): string {
  if (typeflag === "1") return "条目是硬链接";
  if (typeflag === "2") return "条目是符号链接";
  if (typeflag === "3" || typeflag === "4") return "条目是设备文件";
  if (typeflag === "6") return "条目是 FIFO";
  return `条目类型不受支持（${JSON.stringify(typeflag)}）`;
}

/**
 * The name field, then the ustar prefix field when there is one.
 *
 * Both halves are needed: `ustar` splits a long path between `prefix` (offset
 * 345) and `name`, and dropping the prefix silently renames every member under
 * a deep directory.
 */
function readTarName(header: Buffer): string {
  const name = readNulTerminated(header.subarray(TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_LENGTH));
  const prefix = readNulTerminated(header.subarray(TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_LENGTH));
  return prefix ? `${prefix}/${name}` : name;
}

function readNulTerminated(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

/**
 * A size field: octal bytes, or a base-256 number when the high bit of the
 * first byte is set — the spec's escape for values that do not fit in octal,
 * which archives with multi-gigabyte members use. The same reader covers the
 * 8-byte checksum field at offset 148.
 */
function readTarSize(header: Buffer, offset: number): number {
  const length = offset === TAR_SIZE_OFFSET ? 12 : TAR_CHECKSUM_LENGTH;
  const first = header[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = BigInt(first & 0x7f);
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = (value << 8n) | BigInt(header[index] ?? 0);
    }
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) throw new Error("tar 条目大小超出可表示范围。");
    return asNumber;
  }
  const text = header.subarray(offset, offset + length).toString("ascii").replace(/[\0 ]/gu, "");
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error("tar 条目大小字段已损坏。");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("tar 条目大小字段已损坏。");
  return value;
}

/**
 * The header checksum, verified before any other field is trusted.
 *
 * It is computed with its own field read as spaces, which is what catches
 * truncation and corruption at the block level instead of leaving a garbage size
 * field to be believed.
 */
function verifyTarChecksum(header: Buffer): void {
  const declared = readTarSize(header, TAR_CHECKSUM_OFFSET);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    const inChecksumField = index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH;
    const byte = inChecksumField ? 0x20 : header[index] ?? 0;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (declared !== unsigned && declared !== signed) {
    throw new Error("tar 头部校验和不匹配，文件可能已损坏。");
  }
}

function isZeroBlock(header: Buffer): boolean {
  for (let index = 0; index < header.length; index += 1) {
    if (header[index] !== 0) return false;
  }
  return true;
}

/** The `path=` record of a pax extended header, when it carries one. */
function readPaxPath(data: Buffer): string | undefined {
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space === -1) return undefined;
    const lengthText = data.subarray(cursor, space).toString("ascii");
    if (!/^[0-9]+$/u.test(lengthText)) return undefined;
    const length = Number.parseInt(lengthText, 10);
    if (length <= 0 || cursor + length > data.length) return undefined;
    // `%d %s=%s\n`: the length covers its own digits, so the payload ends one
    // byte before the record boundary.
    const record = data.subarray(space + 1, cursor + length - 1).toString("utf8").replace(/\n$/u, "");
    const separator = record.indexOf("=");
    if (separator !== -1 && record.slice(0, separator) === "path") return record.slice(separator + 1);
    cursor += length;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dispatch, listing and extraction
// ---------------------------------------------------------------------------

async function readArchive(archivePath: string): Promise<{ readonly format: ArchiveFormat; readonly buffer: Buffer }> {
  const selected = archiveFormatFor(archivePath);
  if (!("format" in selected)) throw new Error(selected.error);
  const raw = await readFile(archivePath);
  if (selected.format !== "tar.gz") return { format: selected.format, buffer: raw };
  try {
    return {
      format: selected.format,
      // `maxOutputLength` on the whole-buffer gunzip: a 200 MiB `.tgz` can
      // expand well past the budget, and it is decompressed before a single tar
      // header has been parsed, so this is the only ceiling standing there.
      buffer: gunzipSync(raw, { maxOutputLength: WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES }),
    };
  } catch (error) {
    if (isBufferTooLarge(error)) throw new Error("压缩包展开后的体积过大，已拒绝读取。");
    throw new Error("gzip 数据已损坏，无法解压。");
  }
}

function readContents(buffer: Buffer, format: ArchiveFormat): ArchiveContents {
  if (format === "zip") {
    if (buffer.length < ZIP_END_RECORD_SIZE) throw new Error("这个 ZIP 文件太短或已截断。");
    return readZipEntries(buffer);
  }
  if (buffer.length < TAR_BLOCK_SIZE * 2) throw new Error("这个 tar 文件太短或已截断。");
  return readTarEntries(buffer);
}

/**
 * The rows for one level, with directories synthesised from their children.
 *
 * A zip or tar routinely stores only file entries and leaves the directories
 * implied, so a listing that reported only what is literally present would show
 * an empty level for a directory full of files. A synthesised directory row
 * carries the same `path` an explicit entry would, with no trailing slash: the
 * name alone distinguishes a directory, and the view navigates by name.
 *
 * `shouldStripArchiveRoot` in `remote/archive.ts` is deliberately *not* ported
 * here. It strips a single top-level directory because a skill install needs
 * the path *inside* the repository, whereas a preview has to name what the
 * archive actually contains — silently dropping the root a user is looking at
 * would make this panel disagree with every other zip tool.
 */
function listOneLevel(
  contents: ArchiveContents,
  prefix: string,
): { readonly entries: readonly WebuiArchiveEntry[]; readonly truncated: boolean } {
  const scope = prefix ? `${prefix}/` : "";
  const directories = new Map<string, WebuiArchiveEntry>();
  const files: WebuiArchiveEntry[] = [];
  let refused = 0;

  for (const entry of contents.entries) {
    if (entry.unsafeReason || !entry.path) {
      // Not named: the view renders only what this call is willing to write, so
      // an entry that extraction would refuse is not advertised first.
      refused += 1;
      continue;
    }
    if (!entry.path.startsWith(scope) || entry.path.length === scope.length) continue;
    const remainder = entry.path.slice(scope.length);
    const slash = remainder.indexOf("/");
    if (slash !== -1) {
      const name = remainder.slice(0, slash);
      if (!directories.has(name)) {
        directories.set(name, { path: `${scope}${name}`, name, isDirectory: true });
      }
      continue;
    }
    if (entry.isDirectory) {
      if (!directories.has(remainder)) {
        directories.set(remainder, { path: remainder, name: remainder, isDirectory: true });
      }
      continue;
    }
    files.push({ path: remainder, name: remainder, isDirectory: false, size: entry.declaredSize });
  }

  const byName = (a: WebuiArchiveEntry, b: WebuiArchiveEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const ordered = [...[...directories.values()].sort(byName), ...files.sort(byName)];
  const entries = ordered.slice(0, WORKSPACE_ARCHIVE_MAX_LISTED_ENTRIES);
  return { entries, truncated: refused > 0 || ordered.length > entries.length };
}

/** The entries an extraction writes, scoped to the prefix. */
function selectForExtraction(contents: ArchiveContents, prefix: string): readonly ArchiveEntry[] {
  if (!prefix) return contents.entries;
  const scope = `${prefix}/`;
  return contents.entries.filter((entry) => entry.path === prefix || entry.path.startsWith(scope));
}

/**
 * An entry's path relative to the prefix being extracted, so extracting `src`
 * into `dest` writes `dest/index.ts` rather than `dest/src/index.ts`.
 */
function entryPathUnderPrefix(entry: ArchiveEntry, prefix: string): string {
  if (!entry.path) throw new Error(`压缩包中存在不安全的条目：${entry.unsafeReason ?? entry.rawName}`);
  if (!prefix) return entry.path;
  if (entry.path === prefix) return path.posix.basename(entry.path);
  return entry.path.slice(prefix.length + 1);
}

/**
 * Writes one entry, re-validating its parent directory against the extraction
 * root first.
 *
 * The parent is re-resolved with `realpath` because `mkdir -p` through a
 * symlink left behind by an earlier entry (or by the user) would otherwise be
 * written *through*: the name check passes, the filesystem resolves elsewhere.
 */
async function writeExtractedFile(
  root: string,
  target: string,
  entry: ArchiveEntry,
  budget: ExpansionBudget,
): Promise<void> {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const resolvedParent = await realpath(parent);
  if (resolvedParent !== root && !resolvedParent.startsWith(rootPrefix(root))) {
    throw new Error("压缩包条目试图通过符号链接写出解压目录。");
  }
  const data = readEntryBounded(entry, budget);
  // `wx`: refuse to clobber, as the sibling extractor does. An archive the user
  // did not write must never be able to overwrite a file already in their
  // workspace, and a conflict is far better surfaced than silently resolved in
  // the archive's favour.
  await writeFile(path.join(resolvedParent, path.basename(target)), data, { flag: "wx" });
}

/**
 * Reads an entry's bytes, charging both the shared total budget and the
 * per-entry expansion ratio.
 *
 * The ratio is measured against the bytes that actually arrived, not the
 * declared size, so the classic shape — a tiny member that inflates to
 * gigabytes — is caught even when the header is honest about the total.
 */
function readEntryBounded(entry: ArchiveEntry, budget: ExpansionBudget): Buffer {
  const data = entry.read(budget);
  if (data.length > budget.remaining) {
    throw new Error("压缩包展开后的体积过大，已拒绝解压。");
  }
  const compressed = Math.max(entry.compressedSize, 1);
  if (data.length / compressed > WORKSPACE_ARCHIVE_MAX_EXPANSION_RATIO) {
    throw new Error("压缩包中存在异常膨胀的条目，已拒绝解压。");
  }
  budget.remaining -= data.length;
  return data;
}

/**
 * Inflates one entry, capped at what is *left* of the shared budget rather than
 * at the entry's declared size.
 *
 * That distinction is the whole point: a header claiming 12 bytes and
 * delivering a gigabyte is stopped at the budget instead of being believed, and
 * it never gets to allocate the memory it asked for. zlib signals the cap with
 * `ERR_BUFFER_TOO_LARGE`, which is a refusal rather than an internal failure and
 * is translated into the same message the total cap produces.
 */
function inflateEntry(raw: Buffer, budget: ExpansionBudget): Buffer {
  if (budget.remaining <= 0) throw new Error("压缩包展开后的体积过大，已拒绝读取。");
  try {
    return inflateRawSync(raw, { maxOutputLength: budget.remaining });
  } catch (error) {
    if (isBufferTooLarge(error)) throw new Error("压缩包展开后的体积过大，已拒绝读取。");
    throw new Error("ZIP 条目已损坏，无法解压。");
  }
}

function isBufferTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE";
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
