import { rm } from "node:fs/promises";

/** Remove an isolated host data directory after asynchronous host shutdown. */
export function removeRealHostDataDir(dataDir: string): Promise<void> {
  return rm(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
