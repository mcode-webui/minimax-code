// Settings capability port.
//
// Models, providers, skills, permission mode, instructions, memory and the
// user profile. Split from the monolithic `WebuiTransport` in the former
// `client/contracts.ts`; `transport.ts` composes it. Every method stays
// optional — `undefined` means "the operation is not wired".

import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import type { WebuiModelSelectionRequest } from "./model-view.js";

/**
 * Profile-wide `AGENTS.md`.
 *
 * `maxBytes` is reported by the server rather than declared by the client: the
 * server owns the 32KiB cap, and a panel that hardcoded it would keep accepting
 * text the server then rejects.
 */
export interface WebuiGlobalInstructionsView {
  readonly content: string;
  readonly exists: boolean;
  readonly path: string;
  readonly maxBytes: number;
}

/**
 * Per-agent main memory (`agents/<name>/memory/MEMORY.md`).
 *
 * Declared in the client type layer rather than next to the server
 * implementation: `src/server/profile-files.ts` imports `node:fs`, and the
 * client tsconfig compiles with `"types": []` — a browser-side program has no
 * node globals. `server/port.ts` avoids this by being pure `import type` with
 * no runtime import, so anything that actually touches the filesystem has to
 * keep its types on this side of the seam.
 *
 * `content` is absent from a summary read. A live main file runs past the
 * runtime's 64KB cleanup threshold, so the panel asks for the body explicitly
 * rather than pulling a large payload on every open.
 */
export interface WebuiAgentMemoryView {
  readonly agentName: string;
  readonly path: string;
  readonly exists: boolean;
  readonly sizeBytes: number;
  readonly updatedAt?: string;
  readonly content?: string;
}

/**
 * The three fields the `关于你` region holds.
 *
 * The region is a structured record, not one blob of prose: the desktop writes
 * a fixed skeleton of `Nickname: `, `Occupation: ` and a `## More about you`
 * heading, and reads each label back off whichever line carries it. Exposing
 * the three fields separately is what lets an all-empty region render as an
 * empty form — reading the region as one string shows the skeleton itself, so a
 * user who never filled anything in is looking at a full page of text.
 */
export interface WebuiUserProfileFields {
  readonly nickname: string;
  readonly occupation: string;
  readonly moreAbout: string;
}

/**
 * The `关于你` region of `user.md` — the three fields between the personalization
 * markers, not the whole file.
 *
 * `exists` means "the file holds a profile region", not "the file is on disk":
 * a `user.md` that only carries runtime-appended entries is a real file with
 * no region, and the panel must show an empty editor rather than the memory
 * collector's output.
 *
 * `malformed` is a third state, separate from both. Exactly one marker present
 * means the file was damaged by something outside this module; reads report it
 * so the panel can refuse to offer a save that would drop the runtime's
 * entries, and writes throw `USER_PROFILE_MALFORMED`.
 */
export interface WebuiUserProfileView extends WebuiUserProfileFields {
  readonly exists: boolean;
  readonly malformed: boolean;
  readonly path: string;
  readonly sizeBytes: number;
  readonly maxChars: number;
}

/**
 * The two long-term-memory switches, as a closed shape.
 *
 * Deliberately not a config patch. The shared config file holds plaintext API
 * keys under other roots, and the runtime masks them on read — writing a
 * general config payload back would clobber the real values with the masks.
 * Exposing exactly two booleans makes that hazard unrepresentable.
 */
export interface WebuiMemorySettingsView {
  readonly enabled: boolean;
  readonly proactive: boolean;
}

export interface SettingsPort {
  readonly version?: () => Promise<WebuiVersionInfo>;
  readonly getPermissionMode?: () => Promise<unknown>;
  readonly setPermissionMode?: (request: { readonly mode: "default" | "auto" | "bypassPermissions" }) => Promise<unknown>;
  /**
   * Profile-wide `AGENTS.md`. The server owns the file, the 32KiB cap and the
   * atomic write, so the panel only echoes `maxBytes` instead of re-declaring
   * the limit; a mismatch would let the UI accept text the runtime then rejects.
   */
  readonly getGlobalInstructions?: () => Promise<WebuiGlobalInstructionsView>;
  readonly setGlobalInstructions?: (request: { readonly content: string }) => Promise<WebuiGlobalInstructionsView>;
  /**
   * Per-agent main memory. The summary read carries no `content`: a live main
   * file runs past the runtime's 64KB cleanup threshold, so the panel asks for
   * the body explicitly instead of pulling it on every open.
   */
  readonly getAgentMemory?: (request?: { readonly includeContent?: boolean }) => Promise<WebuiAgentMemoryView>;
  readonly setAgentMemory?: (request: { readonly content: string }) => Promise<WebuiAgentMemoryView>;
  /** The `关于你` region of `user.md`; the server owns the markers. */
  readonly getUserProfile?: () => Promise<WebuiUserProfileView>;
  // The three fields, not one blob: the region is a structured record, and the
  // server-side port has taken `WebuiUserProfileFields` since the profile split
  // out of a single `content` string. Declaring `content` here left this call
  // site passing a shape the server never accepted, and the mismatch was
  // invisible to `test:webui` because the tests transpile without typechecking.
  readonly setUserProfile?: (request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }) => Promise<WebuiUserProfileView>;
  /** The two memory switches. Absent on a host that predates the surface. */
  readonly getMemorySettings?: () => Promise<WebuiMemorySettingsView>;
  readonly setMemorySettings?: (request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }) => Promise<WebuiMemorySettingsView>;
  readonly listModels?: (request?: {
    readonly sessionId?: string;
  }) => Promise<readonly WebuiModelEntry[]>;
  readonly listSkills?: (request?: {
    readonly agentName?: string;
  }) => Promise<{
    readonly skills: readonly {
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
    }[];
  }>;
  readonly selectModel?: (
    request: WebuiModelSelectionRequest,
  ) => Promise<{ readonly success?: boolean }>;
  readonly listUserModelProviders?: () => Promise<readonly Record<string, unknown>[]>;
  readonly createUserModelProvider?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly updateUserModelProvider?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly deleteUserModelProvider?: (providerId: string) => Promise<unknown>;
  readonly testUserModelProvider?: (request: { readonly providerId: string; readonly apiKey?: string }) => Promise<unknown>;
  readonly testUserModel?: (request: {
    readonly providerId: string;
    readonly modelId: string;
  }) => Promise<unknown>;
  readonly discoverUserModelsCandidate?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly saveUserModelProviderCandidate?: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly listProviderPresets?: () => Promise<readonly Record<string, unknown>[]>;
  readonly getMiniMaxApiKeyStatus?: () => Promise<Record<string, unknown>>;
  readonly upsertMiniMaxApiKey?: (request: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }) => Promise<unknown>;
  readonly getCodexOAuthStatus?: () => Promise<Record<string, unknown>>;
  readonly getMiniMaxModelSource?: () => Promise<"token_plan" | "minimax_api_key">;
  readonly setMiniMaxModelSource?: (source: "token_plan" | "minimax_api_key") => Promise<"token_plan" | "minimax_api_key">;
  readonly testUserModelCandidate?: (request: { readonly candidate: Record<string, unknown>; readonly modelId: string }) => Promise<unknown>;
  readonly revealModelProviderApiKey?: (request: { readonly providerId: string }) => Promise<string>;
  readonly startCodexOAuthLogin?: (request?: Record<string, unknown>) => Promise<unknown>;
  readonly cancelCodexOAuthLogin?: (request: { readonly loginId: string }) => Promise<unknown>;
  readonly refreshModels?: () => Promise<unknown>;
}
