import { lstat } from "node:fs/promises";
import { loadBetterSqlite3 } from "@mavis/shared";

/** OS-owned SQLite write lock, with no age-based expiry for a paused writer. */
export async function acquireWebuiStorageLock(lockPath: string, timeoutMs = 10_000): Promise<() => void> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("WebUI transaction lock must be a regular file");
  } catch (error) { if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error; }
  const Database = loadBetterSqlite3();
  const database = new Database(lockPath, { timeout: 0 });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "SQLITE_BUSY") throw error;
        if (Date.now() >= deadline) throw Object.assign(new Error("Another process is updating native Design; retry when it finishes"), { code: "DESIGN_BUSY" });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    return () => { try { database.exec("ROLLBACK"); } finally { database.close(); } };
  } catch (error) { database.close(); throw error; }
}

export async function withWebuiStorageTransaction<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const release = await acquireWebuiStorageLock(lockPath);
  try { return await work(); } finally { release(); }
}
