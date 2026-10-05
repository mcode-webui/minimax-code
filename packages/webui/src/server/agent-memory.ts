// Agent main memory (K area) — the `agents/<name>/memory/MEMORY.md` file.
//
// Scope note for reviewers: PR-1 in this series wired the profile-wide
// `AGENTS.md`; this file is the per-agent main memory the roadmap's 长期记忆
// row asks for. It deliberately does NOT go through `LocalMemoryFacade`:
//
//   - the facade lives in `@mavis/local-runtime` (v1), which `packages/webui`
//     does not depend on, and v2 has no memory surface to call instead;
//   - every facade method takes `agentName` as a required first argument, and
//     the WebUI has no agent to attribute a settings-panel edit to — a user
//     editing "the memory" from a settings modal is not editing a session's
//     agent. The default agent name (`mavis`) is the same constant the TUI
//     uses, and it is the only agent the WebUI can honestly claim.
//
// So this mirrors the runtime's storage contract rather than reimplementing a
// second one: same path layout, same name guard, same temp-file-then-rename
// write. Topics, daily notes, summary and archive are out of scope — they have
// their own lifecycles (TTL cleanup, snapshots, a 4KB cap) and belong with the
// facade, not here.
//
// The 4KB summary cap is the trap this file avoids by construction: the
// desktop's 记忆概要 modal renders a 68KB document, which is main memory, not
// `writeMemorySummary`. Wiring a textarea to the summary would reject exactly
// the content that modal is built to show.
//
// The view type lives in `src/client/contracts.ts` rather than here, because
// this module imports `node:fs` and the client tsconfig compiles with
// `"types": []` — a browser-side program has no node globals. `port.ts`
// sidesteps this by being pure `import type` with no runtime import; anything
// that actually touches the filesystem cannot live on the client side of the
// seam.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { WebuiErrorCode } from "./envelope.js";
import type { WebuiAgentMemoryView } from "../client/contracts.js";

/**
 * Mirrors `MINIMAX_CODE_DEFAULT_AGENT_NAME` in
 * `packages/tui/src/product-context.ts`. Duplicated rather than imported
 * because the constant lives in the TUI product layer, which pulls UI concerns
 * into a server module; a test pins both to the same literal so the two cannot
 * drift silently.
 */
export const WEBUI_DEFAULT_AGENT_NAME = "mavis";

const MAIN_MEMORY_FILE = "MEMORY.md";

/**
 * Path-safety, copied from `assertSafeAgentName` in
 * `local-memory-store-utils.ts`: the agent name becomes a path segment under
 * `agents/`, so anything that could escape that directory or break the path is
 * rejected. Kept as a literal rather than a shared import for the same reason
 * `WEBUI_DEFAULT_AGENT_NAME` is.
 */
export function assertSafeAgentName(agentName: string | undefined): string {
  const normalized = agentName?.trim();
  if (!normalized) throw new WebuiAgentMemoryError();
  if (
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(normalized)
  ) {
    throw new WebuiAgentMemoryError();
  }
  return normalized;
}

export class WebuiAgentMemoryError extends Error {
  override readonly name = "WebuiAgentMemoryError";
}

export function agentMemoryPath(dataDir: string, agentName: string): string {
  return join(dataDir, "agents", agentName, "memory", MAIN_MEMORY_FILE);
}

export async function readAgentMemory(
  dataDir: string,
  agentName: string,
  options?: { readonly includeContent?: boolean },
): Promise<WebuiAgentMemoryView> {
  const filePath = agentMemoryPath(dataDir, agentName);
  try {
    const fileStat = await stat(filePath);
    if (!options?.includeContent) {
      return {
        agentName,
        path: filePath,
        exists: true,
        sizeBytes: fileStat.size,
        ...(fileStat.mtimeMs ? { updatedAt: new Date(fileStat.mtimeMs).toISOString() } : {}),
      };
    }
    return {
      agentName,
      path: filePath,
      exists: true,
      sizeBytes: fileStat.size,
      ...(fileStat.mtimeMs ? { updatedAt: new Date(fileStat.mtimeMs).toISOString() } : {}),
      content: await readFile(filePath, "utf8"),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { agentName, path: filePath, exists: false, sizeBytes: 0 };
    }
    throw new WebuiAgentMemoryError();
  }
}

/**
 * Same shape as `GlobalInstructions.write`: blank content removes the file, and
 * a non-blank write goes through a 0600 temp file in the same directory then a
 * rename, so a reader never observes a half-written MEMORY.md.
 */
export async function writeAgentMemory(
  dataDir: string,
  agentName: string,
  content: string,
): Promise<WebuiAgentMemoryView> {
  const filePath = agentMemoryPath(dataDir, agentName);
  if (!content.trim()) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new WebuiAgentMemoryError();
      }
    }
    return { agentName, path: filePath, exists: false, sizeBytes: 0 };
  }

  let tempPath: string | undefined;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    tempPath = join(
      dirname(filePath),
      `.memory-tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    tempPath = undefined;
  } catch {
    if (tempPath) await removeTempFileBestEffort(tempPath);
    throw new WebuiAgentMemoryError();
  }
  return readAgentMemory(dataDir, agentName);
}

async function removeTempFileBestEffort(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The stable write error remains authoritative after best-effort cleanup.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Guards against a path resolving outside the profile root. */
export function isInsideDataDir(dataDir: string, filePath: string): boolean {
  const root = resolve(dataDir);
  const target = resolve(filePath);
  return target === root || target.startsWith(`${root}/`);
}

// Re-exported so the envelope's error code stays the single source of truth
// for what the client sees on a rejected write.
export { WebuiErrorCode };
