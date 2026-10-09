// Settings capability port.
//
// Models, providers, skills, permission mode, instructions, memory and the
// user profile. Split from the monolithic `WebuiTransport` in the former
// `client/contracts.ts`; `transport.ts` composes it. Every method stays
// optional — `undefined` means "the operation is not wired".

import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import type { WebuiModelSelectionRequest } from "./model-view.js";
import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
  WebuiUserProfileView,
} from "../../shared/contracts/personalization.js";

// The personalization view DTOs now live in `shared/contracts/personalization.ts`
// (the Node runtime owns the files that carry them). Re-exported here so the
// harness host and the capability port, whose references move with their own
// split, keep resolving them through this module.
export type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
  WebuiUserProfileFields,
  WebuiUserProfileView,
} from "../../shared/contracts/personalization.js";

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
