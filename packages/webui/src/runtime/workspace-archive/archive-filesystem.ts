import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  WORKSPACE_ARCHIVE_MAX_ARCHIVE_BYTES,
  WORKSPACE_ARCHIVE_MAX_EXPANSION_RATIO,
  WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  readEntryBounded,
} from "./archive-policy.js";
import type {
  ArchiveEntry,
  ExpansionBudget,
  TarParserRecord,
} from "./archive-types.js";

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
export async function resolveArchiveFile(
  workspaceDir: string,
  relative: string,
): Promise<string> {
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
  if (stats.size > WORKSPACE_ARCHIVE_MAX_ARCHIVE_BYTES)
    throw new Error("压缩包过大，无法在面板中打开。");
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
export async function prepareExtractionRoot(
  workspaceDir: string,
  destination: string,
): Promise<string> {
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
function resolveInside(
  root: string,
  name: string,
  what: string,
): string {
  const destination = path.resolve(root, name);
  if (destination !== root && !destination.startsWith(rootPrefix(root))) {
    throw new Error(`${what}越界：${name}`);
  }
  return destination;
}

/** The same check, re-anchored on the extraction root for one entry name. */
export function resolveEntryPath(root: string, name: string): string {
  const destination = path.resolve(root, name);
  if (destination !== root && !destination.startsWith(rootPrefix(root))) {
    throw new Error(`压缩包条目越界：${name}`);
  }
  return destination;
}

export function rootPrefix(root: string): string {
  return root.endsWith(path.sep) ? root : `${root}${path.sep}`;
}

/**
 * Streams one member to its destination.
 *
 * The file is created with `wx` before a byte is written, so an archive can
 * never clobber a file already in the workspace, and it is unlinked again if the
 * stream fails — the invariant the buffered path keeps by writing once, kept
 * here by leaving nothing behind.
 */
export async function writeTarMember(
  record: TarParserRecord,
  root: string,
  target: string,
  budget: ExpansionBudget,
): Promise<void> {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const resolvedParent = await realpath(parent);
  if (resolvedParent !== root && !resolvedParent.startsWith(rootPrefix(root))) {
    throw new Error("压缩包条目试图通过符号链接写出解压目录。");
  }
  const file = path.join(resolvedParent, path.basename(target));
  const handle = await open(file, "wx");
  const declared = Math.max(record.size, 1);
  let total = 0;
  try {
    for await (const chunk of record) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      // Charged as the bytes arrive, against what is left of the shared budget,
      // so a header that lies about its size is stopped while it is still
      // arriving rather than after it has been held.
      if (total > budget.remaining)
        throw new Error("压缩包展开后的体积过大，已拒绝解压。");
      if (total / declared > WORKSPACE_ARCHIVE_MAX_EXPANSION_RATIO) {
        throw new Error("压缩包中存在异常膨胀的条目，已拒绝解压。");
      }
      await handle.write(bytes);
    }
    budget.remaining -= total;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/**
 * Writes one entry, re-validating its parent directory against the extraction
 * root first.
 *
 * The parent is re-resolved with `realpath` because `mkdir -p` through a
 * symlink left behind by an earlier entry (or by the user) would otherwise be
 * written *through*: the name check passes, the filesystem resolves elsewhere.
 */
export async function writeExtractedFile(
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
  const data = await readEntryBounded(entry, budget);
  // `wx`: refuse to clobber, as the sibling extractor does. An archive the user
  // did not write must never be able to overwrite a file already in their
  // workspace, and a conflict is far better surfaced than silently resolved in
  // the archive's favour.
  await writeFile(path.join(resolvedParent, path.basename(target)), data, {
    flag: "wx",
  });
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
