// The on-disk shape of the SSH runtime's own records.
//
// Two files live under the runtime's data directory, the way Desktop keeps one store per concern:
//
//   * `connections.json` — the saved hosts.
//   * `projects.json` — the projects rooted on them.
//
// Every write is atomic: the new content goes to a sibling file first and is then renamed over the
// old one, so a crash mid-write cannot leave a half-written store behind. Nothing here is a
// secret — the password is never written (see `credentials.ts`).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const SSH_STORE_VERSION = 1;

export async function readJsonStore<T>(filePath: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A store that cannot be parsed is treated as absent: the runtime rebuilds it rather than
    // refusing every operation until somebody deletes the file by hand.
    return undefined;
  }
}

export async function writeJsonStore(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
