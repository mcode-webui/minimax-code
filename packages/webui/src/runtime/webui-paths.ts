import { mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Runtime-owned paths, always derived from the configured data directory. */
export function resolveWebuiPaths(dataDir: string) {
  if (!path.isAbsolute(dataDir)) throw new Error("WebUI data directory must be absolute");
  const root = path.join(dataDir, "webui");
  return { root, design: path.join(root, "design") } as const;
}

export async function prepareWebuiDesignPaths(dataDir: string): Promise<ReturnType<typeof resolveWebuiPaths>> {
  const paths = resolveWebuiPaths(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const canonicalDataDir = await realpath(dataDir);
  for (const directory of [paths.root, paths.design, ...["canvases", "templates", "assets", "uploads", "work", "drafts"].map((name) => path.join(paths.design, name))]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`WebUI storage path must be a real directory: ${directory}`);
    const canonical = await realpath(directory);
    const relative = path.relative(canonicalDataDir, canonical);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("WebUI storage path escapes the configured data directory");
  }
  return paths;
}
