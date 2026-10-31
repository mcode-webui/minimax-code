// Settings capability port.
//
// Instructions, agent memory, the user profile, the memory switches, permission
// mode, the api-key *status*, the Codex OAuth status, the model source and the
// runtime version. `version` is read by this business's own workflow.
//
// The provider half of the former `settings-port.ts` — the model list and selection
// and the whole provider CRUD, `upsertMiniMaxApiKey` included — is
// `models/provider-port.ts`: the provider CRUD is that business's duty, not
// `settings`'.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type { WebuiVersionInfo } from "../../../../shared/contracts/version.js";
import type { WebuiAgentMemoryView, WebuiGlobalInstructionsView, WebuiMemorySettingsView, WebuiUserProfileView } from "../../../../shared/contracts/personalization.js";

/**
 * The permission preference's closed set — what the runtime asks the user for
 * before it acts. It is published here, with the port, because both sides need
 * it: this business's owner reads and writes the preference, and the composer's
 * control renders it. Naming it once is what stops the two from drifting.
 */
export type WebuiPermissionMode = "default" | "auto" | "bypassPermissions";

export interface SettingsPort {
  readonly version?: () => Promise<WebuiVersionInfo>;
  readonly getPermissionMode?: () => Promise<unknown>;
  readonly setPermissionMode?: (request: { readonly mode: WebuiPermissionMode }) => Promise<unknown>;
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
  readonly getMiniMaxApiKeyStatus?: () => Promise<Record<string, unknown>>;
  readonly getCodexOAuthStatus?: () => Promise<Record<string, unknown>>;
  readonly getMiniMaxModelSource?: () => Promise<"token_plan" | "minimax_api_key">;
  readonly setMiniMaxModelSource?: (source: "token_plan" | "minimax_api_key") => Promise<"token_plan" | "minimax_api_key">;
  readonly startCodexOAuthLogin?: (request?: Record<string, unknown>) => Promise<unknown>;
  readonly cancelCodexOAuthLogin?: (request: { readonly loginId: string }) => Promise<unknown>;
}
