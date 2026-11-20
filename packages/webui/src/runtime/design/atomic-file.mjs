// The Design runtime keeps its state in files: the canvas documents, the
// drafts, the run journal and the pending book. Every one of them is
// written atomically, so a crash mid-write cannot leave a half-written file
// behind: the new bytes go to a sibling temporary file and are renamed over
// the old one.
//
// Windows refuses that rename while another process holds the file open for
// a moment — an indexer, a scanner, a concurrent reader — and the refusal
// is transient. The refusal used to fail the whole operation: the canvas
// document was not written, the run that belonged to it never started, and
// the node it belonged to stayed idle for ever. The rename is retried the
// way the SSH store retries the same rename.
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import { retryWindowsFileSystemOperationAsync } from "@mavis/shared";

/**
 * Replace one file with another.
 *
 * The rename is retried when Windows refuses it: that refusal means the
 * target is held open for a moment, not that the replacement is refused.
 *
 * @param {string} from the file that is moved
 * @param {string} to the file it replaces
 * @param {{ platform?: NodeJS.Platform, wait?: (delayMs: number) => Promise<void>, move?: (from: string, to: string) => Promise<void> }} [options]
 */
export async function replaceFile(from, to, options = {}) {
  // The rename itself and the platform are given so the retry can be
  // exercised on a machine that does not hand out the refusal itself.
  const move = options.move ?? rename;
  await retryWindowsFileSystemOperationAsync(() => move(from, to), {
    platform: options.platform ?? process.platform,
    wait: options.wait,
  });
}

/**
 * Write a file atomically.
 *
 * The bytes go to a sibling temporary file first and are renamed over the
 * target, so a reader never sees a half-written file.
 *
 * @param {string} file the file that is written
 * @param {string | Uint8Array} text the bytes it is given
 * @param {{ platform?: NodeJS.Platform, wait?: (delayMs: number) => Promise<void>, move?: (from: string, to: string) => Promise<void> }} [options]
 */
export async function writeFileAtomically(file, text, options = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await replaceFile(temporary, file, options);
  } finally {
    await rm(temporary, { force: true });
  }
}
