// Personalization capability contracts.
//
// The profile-wide `AGENTS.md`, the per-agent main memory, the `关于你` region of
// `user.md` and the two long-term-memory switches. Declared as shared wire DTOs
// because the Node runtime (`runtime/profile-files.ts`) owns the files that
// carry them, while the browser settings panel and the capability ports read
// the same shapes; a Node program compiling with `"types": []` cannot host the
// declarations itself.
//
// Split out of `client/contracts/settings-port.ts` during the Node runtime
// extraction (plan section 7.1: profile-files' client-contract import is
// rewired to shared personalization DTOs). `settings-port.ts` re-exports these
// names for the harness host and the capability port, whose references move
// with their own split.

// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiGlobalInstructionsView` | Profile-wide `AGENTS.md` content/exists/path/maxBytes. | Runtime `getGlobalInstructions` (`runtime/harness/settings.ts`; `runtime/profile-files.ts` `readGlobalInstructions`). | `client/contracts/settings-port.ts`; `client/components/settings/PersonalizationSettings.tsx`. |
// | `WebuiAgentMemoryView` | Per-agent main memory summary/content. | Runtime `getAgentMemory` (`runtime/harness/settings.ts`; `runtime/profile-files.ts` `readAgentMemory`). | `client/contracts/settings-port.ts`; `client/components/settings/PersonalizationSettings.tsx`. |
// | `WebuiUserProfileFields` | The three 关于你 fields (nickname/occupation/moreAbout). | Runtime `runtime/profile-files.ts` `parseUserProfileRegion`/`writeUserProfile`; also the browser form. | `client/contracts/settings-port.ts` (via `WebuiUserProfileView`); `client/components/settings/PersonalizationSettings.tsx`. |
// | `WebuiUserProfileView` | The 关于你 region of `user.md` (three fields plus exists/malformed/path/caps). | Runtime `getUserProfile` (`runtime/harness/settings.ts`; `runtime/profile-files.ts` `readUserProfile`). | `client/contracts/settings-port.ts`; `client/components/settings/PersonalizationSettings.tsx`. |
// | `WebuiMemorySettingsView` | The two long-term-memory switches (enabled/proactive). | Runtime `getMemorySettings` (`runtime/harness/settings.ts`). | `client/contracts/settings-port.ts`; `client/components/settings/PersonalizationSettings.tsx`; `runtime/harness/requirements.ts`. |

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
 * Declared here rather than next to the server implementation:
 * `runtime/profile-files.ts` imports `node:fs`, and a browser-side program has
 * no node globals.
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

/**
 * The agent whose profile files a browser request addresses when it names none.
 *
 * It is a wire-level default — the server operation and the runtime adapter must
 * agree on it — so it lives with the shared contracts rather than with the
 * runtime implementation. The runtime re-exports it for its own consumers.
 */
export const WEBUI_DEFAULT_AGENT_NAME = "mavis";
