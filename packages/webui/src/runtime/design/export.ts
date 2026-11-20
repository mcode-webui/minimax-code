import { lstat, realpath, open, link, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { replaceFile } from "./atomic-file.mjs";
import type { DesignExportPlaces } from "../../shared/contracts/design.js";

/** Host paths are resolved by the runtime; browser paths are never treated as source filenames. */
export function designExportPlaces(): DesignExportPlaces { const home = homedir(); return { home, downloads: path.join(home, "Downloads"), desktop: path.join(home, "Desktop"), documents: path.join(home, "Documents"), sep: path.sep }; }
function invalid(message: string): never { throw Object.assign(new Error(message), { code: "INVALID_ARGUMENTS" }); }
/** User-selected export is separate from managed persistence and only accepts authority-produced bytes. */
export async function exportDesignBytes(target: string, bytes: Uint8Array, overwrite = false) {
  if (!path.isAbsolute(target) || target.includes("\0")) invalid("Design export requires an absolute destination path");
  const name = path.basename(target);
  if (!name || [".", ".."].includes(name)) invalid("Design export requires a regular filename");
  const folder = await realpath(path.dirname(target));
  const folderInfo = await lstat(folder);
  if (!folderInfo.isDirectory()) invalid("Design export parent must be an existing directory");
  const destination = path.join(folder, name);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) invalid("Design export refuses a symbolic link or non-regular destination");
    if (!overwrite) throw Object.assign(new Error("Design export destination already exists; explicitly confirm replacement"), { code: "EXISTS" });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = path.join(folder, `.design-export-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (overwrite) await replaceFile(temporary, destination);
    else { try { await link(temporary, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("Design export destination already exists; explicitly confirm replacement"), { code: "EXISTS" }); throw error; } }
    return { path: destination, name, bytes: bytes.byteLength };
  } finally { await rm(temporary, { force: true }); }
}
