import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageSize } from "./image-size.mjs";

export const isDesignPosterName = (name: string): boolean => /^thumb_[a-f0-9]{64}\.jpg$/.test(name) || name.startsWith(".thumb-");
export function designPosterContent(base64: string): { name: string; bytes: Buffer } {
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: "INVALID_ARGUMENTS" }); };
  if (base64.length > 175_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid("Design poster must be bounded JPEG base64");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > 128 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) invalid("Design poster must be a JPEG no larger than 128 KiB");
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > 256 || size.height > 256) invalid("Design poster dimensions must fit within 256 pixels");
  return { name: `thumb_${createHash("sha256").update(bytes).digest("hex")}.jpg`, bytes };
}
/** Caller holds this asset's lock; the library lock spans publication and attachment. */
export async function publishDesignPoster(root: string, content: ReturnType<typeof designPosterContent>): Promise<string> {
  const target = path.join(root, "assets", content.name);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || !(await readFile(target)).equals(content.bytes)) throw Object.assign(new Error("Stored Design thumbnail does not match its content identity"), { code: "MEDIA_MISSING" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = path.join(root, "assets", `.thumb-${randomUUID()}.tmp`);
    try { await writeFile(temporary, content.bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  return `/design-assets/assets/${content.name}`;
}
