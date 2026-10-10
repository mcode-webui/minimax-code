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
  WebuiUserProfileFields,
  WebuiUserProfileView,
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
const USER_MEMORY_FILE = "user.md";

/**
 * Mirrors `MEMORY_TAIL_INJECTION_CAP_CHARS` in `packages/shared/src/memory-limits.ts`.
 *
 * This is a soft ceiling, not a rejection: the composer truncates the profile
 * to its tail once it passes this mark, so anything the user writes above it is
 * accepted on disk and then never reaches the model. The panel reports the
 * number so the user learns that from the editor instead of from silence.
 */
export const USER_PROFILE_MAX_CHARS = 10 * 1024;

/**
 * The `关于你` region of `user.md`.
 *
 * `user.md` is shared, and only part of it is the user's answer to "关于你".
 * The runtime appends `<!-- mem-append-reason: ... -->` entries to the same
 * file, and the `<user_profile>` prompt block is built from the text between
 * these two markers — not from the whole file. Editing the whole file would
 * therefore show the user machine-written entries they never wrote, and let
 * them change text the model never reads.
 *
 * Nothing in this repository writes these markers: the format is owned by the
 * desktop surface, and `LocalPromptMemoryReader` — the interface that feeds
 * the composer — has no implementation here. So the literals below are a
 * copied contract, pinned by `profile-files.test.ts` against the same strings,
 * and a write that finds them absent or half-present fails loudly instead of
 * guessing.
 */
const USER_PROFILE_START = "<!-- mavis-personalization:start -->";
const USER_PROFILE_END = "<!-- mavis-personalization:end -->";

/**
 * The three field labels and the free-text heading inside the region.
 *
 * These are the desktop's own literals, recovered from its settings bundle: it
 * declares `Nickname: `, `Occupation: ` and `## More about you` alongside the
 * two markers, reads the region by splitting on newlines and pulling the value
 * off whichever line starts with a label, and treats everything after the
 * heading as free text. The region is therefore a *structured* record, not one
 * blob of prose — reading it as a single string is what made the panel show a
 * filled document where the desktop shows an empty profile, because
 * `Nickname: ` and `Occupation: ` are prefixes, and with nothing after either
 * colon every field parses to the empty string.
 */
const USER_PROFILE_NICKNAME_LABEL = "Nickname: ";
const USER_PROFILE_OCCUPATION_LABEL = "Occupation: ";
const USER_PROFILE_MORE_ABOUT_HEADING = "## More about you";

/** The desktop's own field normaliser: collapse every whitespace run, trim. */
function normalizeProfileField(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** The value of the first line starting with `label`, or "" when there is none. */
function readProfileField(lines: readonly string[], label: string): string {
  const line = lines.find((candidate) => candidate.startsWith(label));
  return line?.slice(label.length).trim() ?? "";
}

/** The desktop's parse: split the region, then cut at the free-text heading. */
export function parseUserProfileRegion(body: string): WebuiUserProfileFields {
  const lines = body.trim().split("\n");
  const headingIndex = lines.findIndex(
    (line) => line.trim() === USER_PROFILE_MORE_ABOUT_HEADING,
  );
  return {
    nickname: readProfileField(lines, USER_PROFILE_NICKNAME_LABEL),
    occupation: readProfileField(lines, USER_PROFILE_OCCUPATION_LABEL),
    moreAbout:
      headingIndex < 0
        ? ""
        : lines.slice(headingIndex + 1).join("\n").trim(),
  };
}

/**
 * The desktop's write, transcribed.
 *
 * The skeleton is fixed and the empty string in the middle is a real blank line
 * produced by the join, so `## More about you` is always present on disk even
 * when there is no free text under it — that is the desktop's own output, not a
 * damaged file, and reproducing it is what keeps a file this WebUI writes
 * byte-identical to one the desktop wrote.
 *
 * `filter(Boolean)` is applied to the *outer* three parts only, so an absent
 * `before` or `after` collapses the separator instead of leaving a hole. Note
 * the two blank lines that survive when both neighbours are present: the
 * runtime-appended entries sit one blank line away from the closing marker.
 */
function composeUserProfileFile(
  before: string,
  fields: WebuiUserProfileFields,
  after: string,
): string {
  const block = [
    USER_PROFILE_START,
    "# User profile",
    `${USER_PROFILE_NICKNAME_LABEL}${normalizeProfileField(fields.nickname)}`,
    `${USER_PROFILE_OCCUPATION_LABEL}${normalizeProfileField(fields.occupation)}`,
    "",
    USER_PROFILE_MORE_ABOUT_HEADING,
    fields.moreAbout.trim(),
    USER_PROFILE_END,
  ].join("\n");
  return [before.trimEnd(), block, after.trimStart()]
    .filter(Boolean)
    .join("\n\n");
}

export type WebuiProfileFileErrorCode =
  | "AGENT_MEMORY_UNAVAILABLE"
  | "GLOBAL_INSTRUCTIONS_UNAVAILABLE"
  | "GLOBAL_INSTRUCTIONS_TOO_LARGE"
  | "USER_PROFILE_UNAVAILABLE"
  | "USER_PROFILE_MALFORMED"
  | "USER_PROFILE_TOO_LARGE";

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
/* User profile — the marked region of user.md                                */
/* -------------------------------------------------------------------------- */

export function userMemoryPath(dataDir: string): string {
  return join(dataDir, "memory", USER_MEMORY_FILE);
}

type UserProfileRegion =
  | { readonly kind: "absent" }
  | { readonly kind: "region"; readonly before: string; readonly after: string }
  | { readonly kind: "malformed" };

/**
 * Splits the file around the markers without interpreting anything else in it.
 *
 * "Absent" and "malformed" are different answers on purpose. A file with no
 * markers has nothing to overwrite, so a write appends a fresh region. A file
 * with exactly one marker — or with the end marker ahead of the start — is
 * damaged, and rewriting it would either delete runtime-appended entries or
 * duplicate the region, so it is refused.
 */
function locateUserProfileRegion(source: string): UserProfileRegion {
  const startIndex = source.indexOf(USER_PROFILE_START);
  const endIndex = source.indexOf(USER_PROFILE_END);

  if (startIndex === -1 && endIndex === -1) return { kind: "absent" };
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return { kind: "malformed" };
  }

  // Both halves exclude their marker, because the composed block re-emits the
  // start marker and the end marker itself. Slicing `before` up to the
  // marker would print it twice on every save; leaving the end marker in
  // `after` would append another one.
  return {
    kind: "region",
    before: source.slice(0, startIndex),
    after: source.slice(endIndex + USER_PROFILE_END.length),
  };
}

export async function readUserProfile(
  dataDir: string,
): Promise<WebuiUserProfileView> {
  const filePath = userMemoryPath(dataDir);
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        nickname: "",
        occupation: "",
        moreAbout: "",
        exists: false,
        malformed: false,
        path: filePath,
        sizeBytes: 0,
        maxChars: USER_PROFILE_MAX_CHARS,
      };
    }
    throw new WebuiProfileFileError("USER_PROFILE_UNAVAILABLE");
  }

  const region = locateUserProfileRegion(source);
  if (region.kind === "malformed") {
    return {
      nickname: "",
      occupation: "",
      moreAbout: "",
      exists: false,
      malformed: true,
      path: filePath,
      sizeBytes: Buffer.byteLength(source, "utf8"),
      maxChars: USER_PROFILE_MAX_CHARS,
    };
  }
  if (region.kind === "absent") {
    return {
      nickname: "",
      occupation: "",
      moreAbout: "",
      exists: false,
      malformed: false,
      path: filePath,
      sizeBytes: Buffer.byteLength(source, "utf8"),
      maxChars: USER_PROFILE_MAX_CHARS,
    };
  }

  // Sliced from the two marker boundaries rather than by subtracting
  // `after.length`: `after` no longer contains the end marker, so the
  // subtraction would leave it inside the body and the free-text field would
  // read back the closing marker.
  const body = source.slice(
    region.before.length + USER_PROFILE_START.length,
    source.length - region.after.length - USER_PROFILE_END.length,
  );
  return {
    ...parseUserProfileRegion(body),
    exists: true,
    malformed: false,
    path: filePath,
    sizeBytes: Buffer.byteLength(source, "utf8"),
    maxChars: USER_PROFILE_MAX_CHARS,
  };
}

/**
 * Rewrites only the region.
 *
 * Unlike AGENTS.md and main memory, a blank write never deletes the file:
 * `user.md` holds runtime-appended entries the WebUI does not own, and
 * dropping them would delete memory the runtime collected. Writing three empty
 * fields still emits the desktop's skeleton, which reads as "no profile" to the
 * composer without touching anything else.
 */
export async function writeUserProfile(
  dataDir: string,
  fields: WebuiUserProfileFields,
): Promise<WebuiUserProfileView> {
  const filePath = userMemoryPath(dataDir);
  let source = "";
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new WebuiProfileFileError("USER_PROFILE_UNAVAILABLE");
    }
  }

  const region = locateUserProfileRegion(source);
  if (region.kind === "malformed") {
    throw new WebuiProfileFileError("USER_PROFILE_MALFORMED");
  }

  // The budget is checked on what will actually be written, not on one of the
  // three fields: a long `moreAbout` alone can cross it. Byte length, not
  // `.length`, because a half-cap document in Chinese characters is three times
  // that in UTF-8.
  const next = composeUserProfileFile(
    region.kind === "region" ? region.before : "",
    fields,
    region.kind === "region" ? region.after : source,
  );
  if (next.length > USER_PROFILE_MAX_CHARS) {
    throw new WebuiProfileFileError("USER_PROFILE_TOO_LARGE");
  }

  await writeFileAtomic(
    filePath,
    next,
    ".user-profile-tmp",
    "USER_PROFILE_UNAVAILABLE",
  );
  return readUserProfile(dataDir);
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
