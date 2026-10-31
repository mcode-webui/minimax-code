import path from "node:path";

import type {
  ArchiveEntry,
  ArchiveFormat,
  ExpansionBudget,
  NameVerdict,
  NormalizedName,
} from "./archive-types.js";

export const WORKSPACE_ARCHIVE_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

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
export const WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

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
export const WORKSPACE_ARCHIVE_MAX_EXPANSION_RATIO = 2000;

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
export const WORKSPACE_ARCHIVE_MAX_ENTRIES = 10_000;

/**
 * Most rows one listing level reports before it declares itself truncated.
 *
 * 500, the same page size the workspace directory picker uses
 * (`WORKSPACE_DIRECTORY_LIMIT` in `src/server/operation/workspace.ts`): enough
 * for a directory to stay browsable, few enough that the response does not.
 * The entry ceiling above sits well past this, so `totalEntries` can honestly
 * report how much of the archive the page left out.
 */
export const WORKSPACE_ARCHIVE_MAX_LISTED_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Format set
// ---------------------------------------------------------------------------

/**
 * The extensions the client routes to the archive preview, mirrored from
 * `WORKSPACE_ARCHIVE_EXTENSIONS` in `src/client/features/workspace/ui/WorkspacePanels.tsx`.
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
export function archiveFormatFor(
  archivePath: string,
): { readonly format: ArchiveFormat } | { readonly error: string } {
  const lower = archivePath.toLowerCase();
  if (
    !WORKSPACE_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))
  ) {
    return {
      error: "只有 .zip、.tar、.tgz 和 .tar.gz 可以在工作区面板中打开。",
    };
  }
  if (lower.endsWith(".zip")) return { format: "zip" };
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz"))
    return { format: "tar.gz" };
  if (lower.endsWith(".tar")) return { format: "tar" };
  if (lower.endsWith(".gz"))
    return {
      error: ".gz 是单个压缩流、没有目录结构；请改用 .tar.gz 或 .tgz。",
    };
  if (lower.endsWith(".bz2") || lower.endsWith(".xz")) {
    return {
      error:
        "Node 内置压缩库不支持 bzip2 或 xz；请改用 .zip、.tar 或 .tar.gz。",
    };
  }
  return {
    error: "不支持的压缩包格式（.7z / .rar）；请改用 .zip、.tar 或 .tar.gz。",
  };
}

export function normalizeEntryName(rawName: string): NormalizedName {
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
  const parts = unified
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === ".."))
    return { reason: "条目名包含 .. 路径段" };
  if (parts.length === 0) return { root: true };
  if (/^[A-Za-z]:/u.test(parts[0]!))
    return { reason: "条目名包含 Windows 盘符" };
  return { path: parts.join("/") };
}

export function nameVerdict(
  normalized: NormalizedName,
  isDirectory: boolean,
): NameVerdict {
  if ("root" in normalized)
    return isDirectory ? { drop: true } : { reason: "条目名为空" };
  if ("reason" in normalized) return { reason: normalized.reason };
  return { path: normalized.path };
}

/** The workspace-relative form echoed back to the client for display. */
export function normalizeArchiveRelativePath(value: string): string {
  const normalized = normalizeEntryName(value);
  return "path" in normalized
    ? normalized.path
    : "root" in normalized
      ? ""
      : value;
}

/**
 * The prefix a listing is scoped to, validated with the same rules as an entry
 * name. It round-trips through the client, so it is attacker-influenced even
 * though this module is what produced it.
 */
export function normalizePrefix(raw: string | undefined): string {
  if (!raw) return "";
  const normalized = normalizeEntryName(raw);
  if ("path" in normalized) return normalized.path;
  if ("root" in normalized) return "";
  throw new Error(`无法识别的压缩包内路径：${normalized.reason}`);
}

/** The three failures this module names for a zip, so a wrapper cannot invent others. */
export const ZIP_UNREADABLE =
  "这不是可识别的 ZIP 压缩包（缺少中央目录结束记录，文件可能已截断）。";

/**
 * The names yauzl itself refuses while walking the directory.
 *
 * A hostile entry name (an absolute path, a `..` component, a backslash, a drive
 * letter) makes the parser raise instead of handing the entry over, so the
 * policy layer never sees it. The refusal still has to be *this* module's — the
 * archive is refused because the entry is unsafe, not because the container is
 * unreadable — so those two errors are told apart by the shape yauzl gives them.
 */
export const ZIP_UNSAFE_NAME_PATTERN =
  /(?:invalid relative path|absolute path|invalid characters in (?:file)?[Nn]ame)[^:]*:\s*(.+)$/u;

export const ZIP_DIRECTORY_CORRUPT = "ZIP 中央目录已损坏，条目记录不完整。";

export const ZIP_ENTRY_CORRUPT = "ZIP 条目已损坏，无法解压。";

/** The failures this module names for a tar, so a wrapper cannot invent others. */
export const TAR_TRUNCATED = "tar 归档没有结束标记，文件可能已截断。";

export const TAR_HEADER_CORRUPT = "tar 头部校验和不匹配，文件可能已损坏。";

/**
 * Reads an entry's bytes, charging both the shared total budget and the
 * per-entry expansion ratio.
 *
 * The ratio is measured against the bytes that actually arrived, not the
 * declared size, so the classic shape — a tiny member that inflates to
 * gigabytes — is caught even when the header is honest about the total.
 */
export function isBufferTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

export async function readEntryBounded(
  entry: ArchiveEntry,
  budget: ExpansionBudget,
): Promise<Buffer> {
  const read = entry.read;
  if (!read) throw new Error(`压缩包条目无法读取（${entry.rawName}）。`);
  const data = await read.call(entry, budget);
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
