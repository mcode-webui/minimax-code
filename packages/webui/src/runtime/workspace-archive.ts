// Reads and extracts the workspace archives the panel previews.
//
// Both container formats are read by a mature parser, and only the policy is
// ours: `zip` through `yauzl`, `tar` / `.tar.gz` through `tar`. The gzip is
// decompressed here first, under the same uncompressed cap, so that cap is not
// handed to a library to enforce. Two hand-written walks were replaced — a
// central-directory walk with `inflateRawSync`, and a 512-byte header walk with
// its own checksum, base-256 and pax readers — because reimplementing a mature
// format is not something to keep for its own sake.
//
// The public entry stays here. Private modules own shared policy, filesystem
// checks, ZIP/TAR parser adapters and listing selection. This file coordinates
// the same two-phase workflow: validate all selected names and declared sizes
// before creating the destination, then preserve each parser's extraction pass
// and close resources in `finally`.
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
// `archive-listing.ts`'s `listOneLevel`.

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type {
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
} from "../shared/contracts/workspace.js";
import {
  archiveFormatFor,
  normalizeArchiveRelativePath,
  normalizePrefix,
  WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  isBufferTooLarge,
} from "./workspace-archive/archive-policy.js";
import {
  prepareExtractionRoot,
  resolveArchiveFile,
} from "./workspace-archive/archive-filesystem.js";
import {
  listOneLevel,
  selectForExtraction,
  entryPathUnderPrefix,
} from "./workspace-archive/archive-listing.js";
import {
  readZipEntries,
  writeZipSelection,
  ZIP_END_RECORD_SIZE,
} from "./workspace-archive/zip-adapter.js";
import {
  readTarEntries,
  writeTarSelection,
  TAR_BLOCK_SIZE,
} from "./workspace-archive/tar-adapter.js";
import type {
  ArchiveContents,
  ArchiveFormat,
  ExpansionBudget,
} from "./workspace-archive/archive-types.js";

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
  const archivePath = await resolveArchiveFile(
    request.workspaceDir,
    request.path,
  );
  const { format, buffer } = await readArchive(archivePath);
  const prefix = normalizePrefix(request.prefix);
  const contents = await readContents(buffer, format);
  const level = listOneLevel(contents, prefix);
  try {
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
  } finally {
    contents.close?.();
  }
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
  const archivePath = await resolveArchiveFile(
    request.workspaceDir,
    request.path,
  );
  const { format, buffer } = await readArchive(archivePath);
  const prefix = normalizePrefix(request.prefix);
  const contents = await readContents(buffer, format);
  try {
    const selected = selectForExtraction(contents, prefix);

    let declared = 0;
    for (const entry of selected) {
      if (entry.unsafeReason)
        throw new Error(`压缩包中存在不安全的条目：${entry.unsafeReason}`);
      declared += entry.declaredSize;
      if (declared > WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
        throw new Error("压缩包声明的展开后体积过大，已拒绝解压。");
      }
    }

    const root = await prepareExtractionRoot(
      request.workspaceDir,
      request.destination,
    );
    const budget: ExpansionBudget = {
      remaining: WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
    };
    // tar cannot re-open an entry after its walk, so its bytes are written by a
    // second streaming pass; a zip entry is read lazily instead, from the central
    // directory the parse left open.
    const writtenFiles =
      format === "tar"
        ? await writeTarSelection(buffer, selected, prefix, root, budget)
        : await writeZipSelection(root, selected, prefix, budget);

    return {
      archivePath: normalizeArchiveRelativePath(request.path),
      destination: normalizeArchiveRelativePath(request.destination),
      writtenFiles,
      // The port asks for this rather than a refusal: the destination now holds a
      // partial tree, and the view has to say so instead of implying the archive
      // was written out in full.
      ...(contents.truncated ? { truncated: true } : {}),
    };
  } finally {
    // The zip parser's handle has to outlive every entry read above, so it is
    // released here rather than inside the parse.
    contents.close?.();
  }
}

// ---------------------------------------------------------------------------
// Dispatch, listing and extraction
// ---------------------------------------------------------------------------

async function readArchive(
  archivePath: string,
): Promise<{ readonly format: ArchiveFormat; readonly buffer: Buffer }> {
  const selected = archiveFormatFor(archivePath);
  if (!("format" in selected)) throw new Error(selected.error);
  const raw = await readFile(archivePath);
  if (selected.format !== "tar.gz")
    return { format: selected.format, buffer: raw };
  try {
    return {
      format: selected.format,
      // `maxOutputLength` on the whole-buffer gunzip: a 200 MiB `.tgz` can
      // expand well past the budget, and it is decompressed before a single tar
      // header has been parsed, so this is the only ceiling standing there.
      buffer: gunzipSync(raw, {
        maxOutputLength: WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
      }),
    };
  } catch (error) {
    if (isBufferTooLarge(error))
      throw new Error("压缩包展开后的体积过大，已拒绝读取。");
    throw new Error("gzip 数据已损坏，无法解压。");
  }
}

async function readContents(
  buffer: Buffer,
  format: ArchiveFormat,
): Promise<ArchiveContents> {
  if (format === "zip") {
    if (buffer.length < ZIP_END_RECORD_SIZE)
      throw new Error("这个 ZIP 文件太短或已截断。");
    return readZipEntries(buffer);
  }
  if (buffer.length < TAR_BLOCK_SIZE * 2)
    throw new Error("这个 tar 文件太短或已截断。");
  return readTarEntries(buffer);
}
