// Profile-owned files the WebUI can read and write (K area).
//
// Two files live here, and neither goes through the runtime's own classes:
//
//   * `<dataDir>/AGENTS.md` — the profile-wide custom instructions.
//   * `<dataDir>/agents/<name>/memory/MEMORY.md` — the per-agent main memory.
//
// Both dropped a runtime import for related reasons.
//
// `AGENTS.md` originally imported `GlobalInstructions` from
// `@mavis/local-runtime-v2/turn-system`. That broke `check:webui-boundary`,
// which requires every build input to be a WebUI fixture, a published package
// export entry, or a third-party dependency — and `turn-system` is a barrel
// (`export * from './persistence/global-instructions.js'`), so importing one
// class from it drags the whole turn-system dependency tree into the WebUI
// build graph. Eight internal files surfaced as "not an allowed WebUI build
// entry". Reaching a single class through a barrel is not a cheap import.
//
// `MEMORY.md` had already ruled out `LocalMemoryFacade`: it lives in
// `@mavis/local-runtime` (v1), which `packages/webui` does not depend on, and
// every facade method takes `agentName` as a required first argument — a user
// editing "the memory" from a settings modal is not editing a session's agent.
// The default agent name (`mavis`) is the same constant the TUI uses, and it is
// the only agent the WebUI can honestly claim.
//
// So this module mirrors the runtime's storage contract rather than
// reimplementing a second one: same paths, same name guard, same 32KiB cap on
// AGENTS.md, same temp-file-then-rename write. The two literals copied out of
// the runtime are pinned by tests in `profile-files.test.ts` so they cannot
// drift silently.
//
// Topics, daily notes, summary and archive are out of scope. They have their
// own lifecycles (TTL cleanup, snapshots, a 4KB cap) and belong with the
// facade. That 4KB cap is also the trap this design avoids: the desktop's
// 记忆概要 modal renders a 68KB document, so that panel reads main memory, not
// `writeMemorySummary` — a textarea wired to the summary would reject exactly
// the content the modal exists to show.
//
// The view types live in `src/client/contracts.ts`: this module imports
// `node:fs` and the client tsconfig compiles with `"types": []`, so a
// browser-side program has no node globals. `port.ts` sidesteps this by being
// pure `import type` with no runtime import; anything that actually touches the
// filesystem cannot live on the client side of the seam.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
} from "../client/contracts.js";

/**
 * Mirrors `MINIMAX_CODE_DEFAULT_AGENT_NAME` in
 * `packages/tui/src/product-context.ts`. Duplicated rather than imported
 * because the constant lives in the TUI product layer, which pulls UI concerns
 * into a server module; a test pins both to the same literal so the two cannot
 * drift silently.
 */
export const WEBUI_DEFAULT_AGENT_NAME = "mavis";

/**
 * Mirrors `GLOBAL_INSTRUCTIONS_MAX_BYTES` in
 * `local-runtime-v2/.../persistence/global-instructions.ts`. The UI mirrors it
 * too, so the read reports it rather than the client hardcoding 32KiB and
 * disagreeing with the server after a runtime-side change.
 */
export const GLOBAL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const MAIN_MEMORY_FILE = "MEMORY.md";
const GLOBAL_INSTRUCTIONS_FILE = "AGENTS.md";

export type WebuiProfileFileErrorCode =
  | "AGENT_MEMORY_UNAVAILABLE"
  | "GLOBAL_INSTRUCTIONS_UNAVAILABLE"
  | "GLOBAL_INSTRUCTIONS_TOO_LARGE";

/**
 * `operation-dispatch.ts` only forwards a thrown `code` verbatim when it is a
 * member of `WebuiErrorCode`; every other code reaches the client collapsed to
 * `harness_error`. So these codes are for tests and logs, not for the client to
 * branch on — the AGENTS.md panel does its own byte-count check against
 * `maxBytes` and renders its own message.
 */
export class WebuiProfileFileError extends Error {
  override readonly name = "WebuiProfileFileError";

  constructor(readonly code: WebuiProfileFileErrorCode) {
    super(code);
  }
}

/* -------------------------------------------------------------------------- */
/* AGENTS.md                                                                  */
/* -------------------------------------------------------------------------- */

export function globalInstructionsPath(dataDir: string): string {
  return join(dataDir, GLOBAL_INSTRUCTIONS_FILE);
}

/** Missing is not an error: it reports as empty and does not create the file. */
export async function readGlobalInstructions(
  dataDir: string,
): Promise<WebuiGlobalInstructionsView> {
  const filePath = globalInstructionsPath(dataDir);
  try {
    return {
      content: await readFile(filePath, "utf8"),
      exists: true,
      path: filePath,
      maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        content: "",
        exists: false,
        path: filePath,
        maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES,
      };
    }
    throw new WebuiProfileFileError("GLOBAL_INSTRUCTIONS_UNAVAILABLE");
  }
}

export async function writeGlobalInstructions(
  dataDir: string,
  content: string,
): Promise<WebuiGlobalInstructionsView> {
  // Byte length, not `.length`: a document of half the cap in Chinese
  // characters is three times that in UTF-8, and the runtime would reject it.
  // Checking this before the blank case mirrors the runtime, though blank
  // content is 0 bytes and cannot trip the cap either way.
  if (Buffer.byteLength(content, "utf8") > GLOBAL_INSTRUCTIONS_MAX_BYTES) {
    throw new WebuiProfileFileError("GLOBAL_INSTRUCTIONS_TOO_LARGE");
  }

  const filePath = globalInstructionsPath(dataDir);
  if (!content.trim()) {
    await removeProfileFile(filePath, "GLOBAL_INSTRUCTIONS_UNAVAILABLE");
    return readGlobalInstructions(dataDir);
  }

  await writeFileAtomic(filePath, content, ".global-instructions-tmp", "GLOBAL_INSTRUCTIONS_UNAVAILABLE");
  return readGlobalInstructions(dataDir);
}

/* -------------------------------------------------------------------------- */
/* Per-agent main memory                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Path-safety, copied from `assertSafeAgentName` in
 * `local-memory-store-utils.ts`: the agent name becomes a path segment under
 * `agents/`, so anything that could escape that directory or break the path is
 * rejected. Kept as a literal rather than a shared import for the same reason
 * `WEBUI_DEFAULT_AGENT_NAME` is.
 */
export function assertSafeAgentName(agentName: string | undefined): string {
  const normalized = agentName?.trim();
  if (!normalized) throw new WebuiProfileFileError("AGENT_MEMORY_UNAVAILABLE");
  if (
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(normalized)
  ) {
    throw new WebuiProfileFileError("AGENT_MEMORY_UNAVAILABLE");
  }
  return normalized;
}

export function agentMemoryPath(dataDir: string, agentName: string): string {
  return join(dataDir, "agents", agentName, "memory", MAIN_MEMORY_FILE);
}

/**
 * Content is opt-in. A live main file runs past the runtime's 64KB cleanup
 * threshold, so a settings panel that pulls the body on every open pays for a
 * payload it only needs when the user asks to edit it.
 */
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
    throw new WebuiProfileFileError("AGENT_MEMORY_UNAVAILABLE");
  }
}

/** Blank content removes the file, matching the runtime's write contract. */
export async function writeAgentMemory(
  dataDir: string,
  agentName: string,
  content: string,
): Promise<WebuiAgentMemoryView> {
  const filePath = agentMemoryPath(dataDir, agentName);
  if (!content.trim()) {
    await removeProfileFile(filePath, "AGENT_MEMORY_UNAVAILABLE");
    return { agentName, path: filePath, exists: false, sizeBytes: 0 };
  }

  await writeFileAtomic(filePath, content, ".memory-tmp", "AGENT_MEMORY_UNAVAILABLE");
  return readAgentMemory(dataDir, agentName);
}

/* -------------------------------------------------------------------------- */
/* Shared write mechanics                                                     */
/* -------------------------------------------------------------------------- */

/** Guards against a path resolving outside the profile root. */
export function isInsideDataDir(dataDir: string, filePath: string): boolean {
  const root = resolve(dataDir);
  const target = resolve(filePath);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Temp file then rename, the scheme both runtime classes use: a reader never
 * observes a half-written file. 0600 because both targets hold user-authored
 * instructions rather than scratch data.
 *
 * The error code is a parameter so each surface keeps its own identity; a
 * failure is always surfaced as a stable `WebuiProfileFileError` rather than
 * whatever the filesystem happened to throw, and never as a truncated file.
 */
async function writeFileAtomic(
  targetPath: string,
  content: string,
  tempPrefix: string,
  errorCode: WebuiProfileFileErrorCode,
): Promise<void> {
  let tempPath: string | undefined;
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    tempPath = join(
      dirname(targetPath),
      `${tempPrefix}-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetPath);
    tempPath = undefined;
  } catch {
    if (tempPath) await removeTempFileBestEffort(tempPath);
    throw new WebuiProfileFileError(errorCode);
  }
}

/** A blank write to an already-absent file is a no-op, not a failure. */
async function removeProfileFile(
  filePath: string,
  errorCode: WebuiProfileFileErrorCode,
): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new WebuiProfileFileError(errorCode);
    }
  }
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
