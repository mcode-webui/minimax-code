import { createRequire } from "node:module";

import {
  WORKSPACE_ARCHIVE_MAX_ENTRIES,
  normalizeEntryName,
  nameVerdict,
  TAR_HEADER_CORRUPT,
  TAR_TRUNCATED,
} from "./archive-policy.js";
import { resolveEntryPath, writeTarMember } from "./archive-filesystem.js";
import { entryPathUnderPrefix } from "./archive-listing.js";
import type {
  ArchiveContents,
  ArchiveEntry,
  ExpansionBudget,
  TarParserModule,
  TarParserRecord,
  TarParserWarning,
} from "./archive-types.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// TAR
// ---------------------------------------------------------------------------

export const TAR_BLOCK_SIZE = 512;

/** The two zero blocks a tar writes after its last member, ahead of its padding. */
const TAR_END_MARKER_BYTES = TAR_BLOCK_SIZE * 2;

export async function readTarEntries(buffer: Buffer): Promise<ArchiveContents> {
  assertTarEndMarker(buffer);
  const entries: ArchiveEntry[] = [];
  let walked = 0;
  let truncated = false;
  let refusal: string | undefined;
  await new Promise<void>((resolve, reject) => {
    const parser = loadTarParser().t({
      // A warning is not noise here: `TAR_ENTRY_INVALID` is how the parser
      // reports a header it cannot trust, and skipping one silently would change
      // which members the archive is said to hold.
      onwarn: (warning) => {
        refusal ??= tarWarningRefusal(tarWarningCode(warning));
      },
      onentry: (record) => {
        if (walked >= WORKSPACE_ARCHIVE_MAX_ENTRIES) {
          truncated = true;
          // Drained, not buffered: the walk has to consume the member to reach
          // the next header, and skipping one costs no memory.
          record.resume();
          return;
        }
        walked += 1;
        const entry = tarEntry(record);
        if (entry) entries.push(entry);
        record.resume();
      },
    });
    parser.on("error", (error: Error) => reject(error));
    parser.on("end", () => resolve());
    parser.on("close", () => resolve());
    parser.end(buffer);
  });
  if (refusal) throw new Error(refusal);
  return { entries, totalEntries: entries.length, truncated };
}

/**
 * The end-of-archive marker, checked before the walk.
 *
 * `tar` reports a truncated archive by stopping rather than by raising, so this
 * is what turns a silent short read into the refusal the caller's contract
 * promises: a conforming archive is block-aligned and ends with two zero blocks.
 */
function assertTarEndMarker(buffer: Buffer): void {
  if (buffer.length % TAR_BLOCK_SIZE !== 0) throw new Error(TAR_TRUNCATED);
  const tail = buffer.subarray(buffer.length - TAR_END_MARKER_BYTES);
  if (tail.length !== TAR_END_MARKER_BYTES || tail.some((byte) => byte !== 0)) {
    throw new Error(TAR_TRUNCATED);
  }
}

/** The warning's own code, whichever field the parser put it in. */
function tarWarningCode(warning: TarParserWarning): string | undefined {
  const text =
    typeof warning === "string" ? warning : (warning.code ?? warning.message);
  return typeof text === "string" && text.startsWith("TAR_") ? text : undefined;
}

/** The parser warnings that mean the container cannot be trusted, by name. */
function tarWarningRefusal(
  code: string | undefined,
): string | undefined {
  if (code === "TAR_BAD_ARCHIVE") return "这不是可识别的 tar 归档。";
  if (code === "TAR_ENTRY_INVALID") return TAR_HEADER_CORRUPT;
  if (code === "TAR_ENTRY_ERROR") return "tar 条目数据不完整，文件可能已损坏。";
  if (code === "TAR_ENTRY_UNSUPPORTED")
    return "tar 归档使用了不支持的条目类型。";
  return undefined;
}

/** One parser entry as this module's entry; the policy is applied here. */
function tarEntry(record: TarParserRecord): ArchiveEntry | undefined {
  const isDirectory =
    record.type === "Directory" ||
    record.type === "GNUDumpDir" ||
    record.path.endsWith("/");
  const regular =
    record.type === "File" ||
    record.type === "OldFile" ||
    record.type === "ContiguousFile";
  if (!isDirectory && !regular) {
    // The tar analogue of the zip symlink refusal, and it covers more: hard
    // links, devices and FIFOs are all refused, because none of them is
    // something this panel has any business creating in a workspace.
    return {
      rawName: record.path,
      isDirectory: false,
      declaredSize: record.size,
      compressedSize: record.size,
      unsafeReason: tarTypeRefusal(record.type),
    };
  }
  const verdict = nameVerdict(normalizeEntryName(record.path), isDirectory);
  if (verdict.drop) return undefined;
  return {
    rawName: record.path,
    ...(verdict.path ? { path: verdict.path } : {}),
    isDirectory,
    declaredSize: record.size,
    // A tar member is stored as-is, so its "compressed" size is its own length;
    // a `.tar.gz` is capped as a whole buffer at gunzip time instead.
    compressedSize: record.size,
    ...(verdict.reason ? { unsafeReason: verdict.reason } : {}),
  };
}

function tarTypeRefusal(type: string): string {
  if (type === "Link") return "条目是硬链接";
  if (type === "SymbolicLink") return "条目是符号链接";
  if (type === "CharacterDevice" || type === "BlockDevice")
    return "条目是设备文件";
  if (type === "FIFO") return "条目是 FIFO";
  return `条目类型不受支持（${JSON.stringify(type)}）`;
}

function loadTarParser(): TarParserModule {
  return require("tar") as TarParserModule;
}

/**
 * The extraction pass for a tar.
 *
 * `tar` cannot re-open an entry after its walk, so the bytes are written here —
 * a second pass over the same in-memory buffer, under the validation the first
 * pass already made. A member is in flight only while it is being written, so
 * the peak is one member rather than the archive; buffering every member would
 * double what the module already holds, and the archive's own cap is one a
 * hostile input can reach.
 */
export async function writeTarSelection(
  buffer: Buffer,
  selected: readonly ArchiveEntry[],
  prefix: string,
  root: string,
  budget: ExpansionBudget,
): Promise<number> {
  const wanted = new Set<string>();
  for (const entry of selected) {
    if (entry.path && !entry.isDirectory) wanted.add(entry.path);
  }
  let written = 0;
  let failure: Error | undefined;
  await new Promise<void>((resolve, reject) => {
    const parser = loadTarParser().t({
      onwarn: (warning) => {
        const refusal = tarWarningRefusal(tarWarningCode(warning));
        if (refusal) failure ??= new Error(refusal);
      },
      onentry: (record) => {
        const entry = tarEntry(record);
        if (
          !entry ||
          entry.isDirectory ||
          !entry.path ||
          !wanted.has(entry.path)
        ) {
          record.resume();
          return;
        }
        const target = resolveEntryPath(
          root,
          entryPathUnderPrefix(entry, prefix),
        );
        // The parser waits for this member to be consumed before it emits the
        // next one, so the writes stay sequential without a queue of their own.
        void writeTarMember(record, root, target, budget).then(
          () => {
            written += 1;
          },
          (error: Error) => {
            failure ??= error;
            record.resume();
          },
        );
      },
    });
    parser.on("error", (error: Error) => reject(error));
    parser.on("end", () => resolve());
    parser.on("close", () => resolve());
    parser.end(buffer);
  });
  if (failure) throw failure;
  return written;
}
