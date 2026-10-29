// The surface of the runtime `cliService` the WebUI forwards to, and the
// harness host handle the runtime assembly hands to the adapter.
//
// Host-facing request and result types come from the public CliService methods.
// The adapters own the conversion into the independent WebUI wire DTOs;
// runtime/assembly.ts assigns the host without a whole-host assertion.
//
// The six personalization members this interface used to declare
// (`getGlobalInstructions`, `setGlobalInstructions`, `getAgentMemory`,
// `setAgentMemory`, `getUserProfile`, `setUserProfile`) were called by no
// adapter and exist on no runtime host: the settings adapter reads and writes
// the profile files itself (`harness/settings.ts` -> `profile-files.ts`).

import type { CliService } from "@mavis/local-runtime-v2/cli-service";
/**
 * The request one host member takes, as the host itself declares it.
 *
 * Written as a parameter read rather than a transcribed interface: the runtime owns these
 * shapes, and a copy of them here is a copy that drifts. The four provider mutations all
 * use it, on the declaration the adapter forwards to.
 */
export type WebuiHostRequest<M extends keyof CliService> = Parameters<CliService[M]>[0];

import type {
  WebuiSessionListRequest,
  WebuiSessionPage,
  WebuiSessionTreeRequest,
  WebuiSessionTreePage,
  WebuiProjectRecord,
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
} from "../../shared/contracts/session.js";
import type {
  WebuiSendMessageRequest,
  WebuiSendMessageResult,
  WebuiResumeSessionRequest,
  WebuiStreamResult,
  WebuiRuntimeEvent,
} from "../../shared/contracts/stream.js";
import type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "../../shared/contracts/queue.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireAnswer,
  WebuiInteractionReplyResult,
  WebuiPermissionDecision,
} from "../../shared/contracts/interactions.js";
import type {
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceGitMutationRequest,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";
import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "../../shared/contracts/goal.js";
import type { WebuiMemorySettingsView } from "../../shared/contracts/personalization.js";

/**
 * The members the WebUI forwards to the runtime `cliService`. The runtime
 * harness satisfies this shape, and the WebUI's only job is to forward requests
 * here. Methods optional on the live cliService stay optional here too —
 * `createHarnessPortFromHost` projects them back with `requireCliService` so
 * every wire-error is a single, uniform `runtime host does not expose the CLI
 * service` message.
 *
 * Exported as the single source of truth so the assembly layer can type its
 * `cliService?: WebuiRuntimeCliService` slot without re-spelling it.
 */
/**
 * One attachment as the runtime declares it.
 *
 * Written out here rather than imported, for the same reason `selectModel` is:
 * `host-contract.ts` does not reach into the runtime package for types, so the
 * WebUI's contract stays independently owned and a rename on the runtime side
 * does not move this file. The two agree field for field — the adapter copies
 * them across in `result-conversion.ts` — and the difference is variance: the
 * wire contract says `readonly`, the runtime wants a list it keeps.
 */
export interface WebuiRuntimeAttachment {
  readonly meta?: {
    readonly attachmentType?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
  };
  readonly local?: {
    readonly assetId?: string;
    readonly filePath?: string;
    readonly dataUrl?: string;
    readonly desktopPath?: string;
  };
  readonly cloud?: { readonly url?: string; readonly dataUrl?: string };
}

/**
 * The result the runtime itself declares for one forwarded member.
 *
 * A forwarded member's result is *this* type, not `unknown`: the adapter calls the
 * runtime, receives the runtime's own view type and converts it explicitly
 * (`harness/result-conversion.ts`). Declaring `unknown` made the compile-time
 * drift check in `test/unit/webui-host-contract-derivation.test.ts` pass for every
 * possible runtime result, because everything extends `unknown` — the conversion
 * obligation was invisible exactly where it was largest. Derived from the runtime's
 * declaration, the member's type moves when the runtime's moves, which is what the
 * derivation test and the conversion functions are read against.
 */
type HostResult<K extends keyof CliService> = CliService[K] extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;

export interface WebuiRuntimeCliService {
  listVisibleProjects?(limit?: number): Promise<readonly WebuiProjectRecord[]>;
  /** Converted in `result-conversion.ts`: the runtime numbers `sessionType`
   * and reports each session as an interface, which an index-signature wire DTO
   * cannot be satisfied by. */
  listSessions(
    request: WebuiSessionListRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"listSessions">>;
  pluginManagement(
    request: import("../../shared/plugin-management.js").WebuiPluginManagementRequest,
  ): Promise<HostResult<"pluginManagement">>;
  /** Converted: see `listSessions`. */
  getSessionTree(
    request: WebuiSessionTreeRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"getSessionTree">>;
  archiveSession(
    request: { readonly id: string; readonly archived?: boolean },
    context?: Record<string, never>,
  ): Promise<{ readonly success?: boolean }>;
  deleteSession(
    request: { readonly id: string },
    context?: Record<string, never>,
  ): Promise<{ readonly success?: boolean }>;
  /** Converted: see `createSession`. */
  updateSession(
    request: import("../../shared/contracts/session.js").WebuiUpdateSessionRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"updateSession">>;
  getSessionForkOptions(
    request: WebuiGetSessionForkOptionsRequest,
    context?: Record<string, never>,
  ): Promise<WebuiGetSessionForkOptionsResult>;
  /** Converted: see `createSession`. */
  forkSession(
    request: WebuiForkSessionRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"forkSession">>;
  /** Converted: the runtime answers with an interface, the wire with a record. */
  createSession(
    request: WebuiCreateSessionRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"createSession">>;
  getSession(
    request: import("../../shared/contracts/session.js").WebuiSessionLookupRequest,
    context?: Record<string, never>,
  ): Promise<import("../../shared/contracts/session.js").WebuiSessionLookupResult>;
  /** Converted: see `listSessions`. The wire requires `msgId` on every message. */
  getMessages(
    request: import("../../shared/contracts/messages.js").WebuiMessagesRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"getMessages">>;
  exportSessionTransfer(
    sessionId: string,
  ): Promise<import("../../shared/contracts/session.js").WebuiSessionTransferFile>;
  importSessionTransfer(
    request: import("../../shared/contracts/session.js").WebuiImportSessionTransferRequest,
  ): Promise<import("../../shared/contracts/session.js").WebuiImportSessionTransferResult>;
  /** Converted: the four diff answers share one shape, and their `diffs` lists
   * carry the runtime's file-diff interface rather than the wire's record. */
  getSessionDiff(
    request: WebuiGetSessionDiffRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"getSessionDiff">>;
  getTurnDiff(
    request: WebuiGetTurnDiffRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"getTurnDiff">>;
  revertTurnDiff(
    request: WebuiRevertTurnDiffRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"revertTurnDiff">>;
  reapplyTurnDiff(
    request: WebuiReapplyTurnDiffRequest,
    context?: Record<string, never>,
  ): Promise<HostResult<"reapplyTurnDiff">>;
  getSessionRewindPreview(
    request: WebuiGetSessionRewindPreviewRequest,
    context?: Record<string, never>,
  ): Promise<WebuiGetSessionRewindPreviewResult>;
  rewindSession(
    request: WebuiRewindSessionRequest,
    context?: Record<string, never>,
  ): Promise<WebuiRewindSessionResult>;
  /**
   * Converted on both sides, for the same reason each.
   *
   * The result is a closed contract, so every field is named in the conversion
   * rather than copied — including `rewound`, which is the whole answer. The
   * request's `attachments` is loosened here because the wire contract declares
   * it `readonly` (rightly — a surface builds it and hands it over) while the
   * runtime wants a mutable list it keeps. They agree field for field; only the
   * variance differs, and the adapter copies to close it. Loosening the
   * *declaration* rather than the wire contract is the direction that matters:
   * a contract other code may write to after the fact is one nobody can rely on.
   */
  editSessionMessage(
    request: Omit<WebuiEditSessionMessageRequest, "attachments"> & {
      readonly attachments?: WebuiRuntimeAttachment[];
    },
    context?: Record<string, never>,
  ): Promise<HostResult<"editSessionMessage">>;
  getActiveTurn(
    sessionId: string,
  ): Promise<import("../../shared/contracts/session.js").WebuiActiveTurn | undefined>;
  isGoalEnabled(): boolean;
  getGoal(sessionId: string): Promise<WebuiGoal | undefined>;
  createGoal(request: WebuiGoalCreateRequest): Promise<WebuiGoal>;
  patchGoal(
    sessionId: string,
    patch: Omit<WebuiGoalPatchRequest, "sessionId">,
  ): Promise<WebuiGoal>;
  clearGoal(sessionId: string): Promise<boolean>;
  /** Converted: the runtime reports names and shape but no file facts, and the
   * adapter stats the files it keeps. See `runtime/harness/workspace.ts`. */
  listWorkspaceFileTree?(request: {
    readonly workspaceDir: string;
    readonly path?: string;
  }): Promise<HostResult<"listWorkspaceFileTree">>;
  readWorkspaceFile?(request: {
    readonly workspaceDir: string;
    readonly path: string;
  }): Promise<WebuiWorkspaceFileContent>;
  searchWorkspaceFiles?(input: {
    readonly workspaceDir: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly string[]>;
  /**
   * Archive listing and extraction are served by this package
   * (`./workspace-archive.ts`, Node built-ins only) rather than by the runtime,
   * so these two stay optional: a host that has a richer implementation of its
   * own still wins, and a host that has none gets the WebUI's reader instead of
   * an error the panel can only show.
   */
  readWorkspaceArchive?(request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly prefix?: string;
  }): Promise<WebuiWorkspaceArchiveListing>;
  extractWorkspaceArchive?(request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly destination: string;
    readonly prefix?: string;
  }): Promise<WebuiWorkspaceArchiveExtractResult>;
  getWorkspaceGitEnvironment?(
    workspaceDir: string,
  ): Promise<{
    readonly metadata: Record<string, unknown>;
    readonly changes: Record<string, unknown>;
  }>;
  mutateWorkspaceGit?(
    request: WebuiWorkspaceGitMutationRequest,
  ): Promise<Record<string, unknown>>;
  /**
   * The review and canvas members below answer with the runtime's own view
   * types, not with the WebUI's wire projections. That is deliberate: the
   * adapter owns the conversion (see `result-conversion.ts`), and declaring the
   * WebUI's shape here would have made the runtime's answer structurally
   * incompatible with the declaration it is checked against — which is what the
   * assembly's single whole-layer assertion used to paper over.
   *
   * They are therefore declared as records, which is the honest statement of
   * "the runtime decides the shape and the adapter reads it". A member whose
   * answer the adapter passes through unchanged keeps its precise type below.
   */
  getWorkspaceReviewSummary?(
    workspaceDir: string,
  ): Promise<HostResult<"getWorkspaceReviewSummary">>;
  listWorkspaceReviewFileDiffs?(input: {
    workspaceDir: string;
    reviewSnapshotId: string;
    fileIds?: string[];
  }): Promise<HostResult<"listWorkspaceReviewFileDiffs">>;
  getWorkspaceReviewFileContent?(input: {
    workspaceDir: string;
    reviewSnapshotId: string;
    fileId: string;
    side: "old" | "new";
  }): Promise<HostResult<"getWorkspaceReviewFileContent">>;
  searchWorkspaceReviewDiffs?(input: {
    workspaceDir: string;
    reviewSnapshotId: string;
    query: string;
    includeUntrackedFiles: boolean;
    pageIndex?: number;
    pageSize?: number;
  }): Promise<HostResult<"searchWorkspaceReviewDiffs">>;
  readCanvas?(request: {
    readonly sessionId: string;
  }): Promise<HostResult<"readCanvas">>;
  /**
   * The canvas operation the runtime expects.
   *
   * Derived from the public host method. The WebUI port keeps its own request
   * DTO; canvas-input.ts decodes its open mutation list into this inferred union.
   */
  applyCanvas?(
    request: WebuiHostRequest<"applyCanvas">,
  ): Promise<HostResult<"applyCanvas">>;
  /** Converted: the runtime's frame view declares its deltas as an interface
   * where the wire declares open records, and the source is wrapped rather than
   * drained so a session stream stays streaming. */
  sendMessage(
    request: Omit<WebuiSendMessageRequest, "attachments"> & {
      readonly attachments?: WebuiRuntimeAttachment[];
    },
    context?: { readonly signal?: AbortSignal },
  ): Promise<HostResult<"sendMessage">>;
  /** Converted: a closed contract; see `editSessionMessage`. */
  enqueueMessage(
    request: Omit<WebuiEnqueueMessageRequest, "attachments"> & {
      readonly attachments?: WebuiRuntimeAttachment[];
    },
    context?: { readonly signal?: AbortSignal },
  ): Promise<HostResult<"enqueueMessage">>;
  /** Converted: the same conversion as `sendMessage`; both share one envelope. */
  resumeSession(
    request: WebuiResumeSessionRequest,
    context?: { readonly signal?: AbortSignal },
  ): Promise<HostResult<"resumeSession">>;
  /** Converted: the runtime's event `payload` is a per-type union of interfaces
   * and the wire declares an open record. See `result-conversion.ts`. */
  watchEvents(signal?: AbortSignal): ReturnType<CliService["watchEvents"]>;
  /**
   * The runtime's result makes `requests` optional (`ListPendingPermissionsResult.requests?`)
   * and its own input type is an empty record, so the adapter passes `{}`-shaped
   * calls and normalises a missing list to `[]` — see the comment in
   * `harness/interactions.ts`. The declaration stays hand-written for now: its
   * element type (`PendingPermissionItem`, every field optional) does not satisfy
   * `WebuiPendingPermission` (every field required), which is a wire-shape
   * decision the derivation pass has to make member by member.
   */
  /** Converted: `ruleContents` is required by the wire and must not be
   * defaulted — an empty list would render a permission request that grants
   * nothing and explains nothing. */
  listPendingPermissions(
    request: Record<string, never>,
  ): Promise<HostResult<"listPendingPermissions">>;
  getPendingQuestionnaire(request: {
    readonly name: string;
    readonly sessionId: string;
  }): Promise<{ readonly request?: WebuiQuestionnaireRequest }>;
  replyPermission(
    request: WebuiHostRequest<"replyPermission">,
  ): Promise<WebuiInteractionReplyResult>;
  replyQuestionnaire(
    request: WebuiHostRequest<"replyQuestionnaire">,
  ): Promise<WebuiInteractionReplyResult>;
  dismissQuestionnaire(request: {
    readonly name: string;
    readonly requestId: string;
  }): Promise<WebuiInteractionReplyResult>;
  abortSession(request: {
    readonly id: string;
  }): Promise<{ readonly success?: boolean }>;
  listQueueMessages(request: { readonly id: string }): Promise<{
    readonly items?: readonly WebuiQueueItem[];
    readonly paused?: boolean;
    readonly pendingCount?: number;
  }>;
  deleteQueueItem(request: {
    readonly id: string;
    readonly itemId: string;
  }): Promise<{ readonly item?: WebuiQueueItem }>;
  /** Converted in `result-conversion.ts`: the runtime lists untyped entries. */
  listModels(request?: {
    readonly sessionId?: string;
  }): Promise<readonly unknown[]>;
  /**
   * The cliService returns the harness `SkillInfo[]`; the host then projects
   * it down to `WebuiSkillEntry[]` for the WebUI client. The structural type
   * spells out the wider shape (incl. `displayDescription` for i18n) so the
   * field-selection logic in `listSkills()` below type-checks.
   */
  listSkills(request: WebuiHostRequest<"listSkills">): Promise<{
    readonly skills: readonly {
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly displayDescription?: string;
    }[];
  }>;
  getPermissionMode(): Promise<HostResult<"getPermissionMode">>;
  setPermissionMode(request: {
    readonly mode: "default" | "auto" | "bypassPermissions";
  }): Promise<HostResult<"setPermissionMode">>;
  /**
   * Optional on purpose: a host without the configuration capability still has
   * to type-check. `requireMemorySettings` fails closed with one clear message
   * rather than crashing on `undefined` — a missing method is not the same
   * statement as `enabled: false`.
   */
  getMemorySettings?(): Promise<WebuiMemorySettingsView>;
  setMemorySettings?(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<WebuiMemorySettingsView>;
  /**
   * The four browser authorization switches.
   *
   * Optional on the same terms as the memory pair: a host that predates the
   * browser surface has to fail closed with one clear message rather than
   * crash on an absent method, and the browser adapter returns nothing at all
   * when these are missing — which leaves the browser operations unregistered
   * and the capability manifest reporting the family as absent.
   */
  getBrowserAuthorization?(): Promise<{
    isolatedChromium: boolean;
    edge: boolean;
    chrome: boolean;
    fullCdp: boolean;
  }>;
  setBrowserAuthorization?(request: {
    isolatedChromium?: boolean;
    edge?: boolean;
    chrome?: boolean;
    fullCdp?: boolean;
  }): Promise<{
    isolatedChromium: boolean;
    edge: boolean;
    chrome: boolean;
    fullCdp: boolean;
  }>;
  /**
   * The model selection the runtime answers with a verdict, not an object.
   *
   * Declared here rather than as `CliService["selectModel"]`: this file is the
   * WebUI's own statement of the runtime surface, and reaching into the runtime
   * package's types made the WebUI's boundary a function of a type it does not
   * own — a rename on the runtime side would then move the WebUI's result
   * contract, which is supposed to stay independently owned. The runtime's
   * signature is `{ providerId, modelId, variant?, contextLimit?, sessionId? }`
   * in, `Promise<boolean>` out; this is that, written down.
   *
   * The application contract is `models.select(input): Promise<boolean>`, so the
   * adapter maps that verdict to the wire's `{ success }` instead of forwarding
   * it. Declaring `Promise<{ success?: boolean }>` here (as this mirror once did)
   * is exactly what made the raw forward look correct while the client's refusal
   * check could not fire.
   */
  selectModel(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly variant?: string;
    readonly contextLimit?: number;
    readonly sessionId?: string;
  }): Promise<boolean>;
  /** Converted: see `listProviderPresets`. */
  getSessionUsage(request: {
    readonly id: string;
  }): Promise<HostResult<"getSessionUsage">>;
  getAccountStatus(request?: {
    readonly sessionId?: string;
  }): Promise<Record<string, unknown>>;
  listUserModelProviders(): Promise<readonly Record<string, unknown>[]>;
  createUserModelProvider(
    request: WebuiHostRequest<"createUserModelProvider">,
  ): Promise<HostResult<"createUserModelProvider">>;
  updateUserModelProvider(
    request: WebuiHostRequest<"updateUserModelProvider">,
  ): Promise<HostResult<"updateUserModelProvider">>;
  deleteUserModelProvider(request: {
    readonly providerId: string;
  }): Promise<HostResult<"deleteUserModelProvider">>;
  testUserModelProvider(request: {
    readonly providerId: string;
    readonly apiKey?: string;
  }): Promise<HostResult<"testUserModelProvider">>;
  testUserModel(request: {
    readonly providerId: string;
    readonly modelId: string;
  }): Promise<HostResult<"testUserModel">>;
  discoverUserModelsCandidate(
    request: WebuiHostRequest<"discoverUserModelsCandidate">,
  ): Promise<HostResult<"discoverUserModelsCandidate">>;
  saveUserModelProviderCandidate(
    request: WebuiHostRequest<"saveUserModelProviderCandidate">,
  ): Promise<HostResult<"saveUserModelProviderCandidate">>;
  /** Converted: the runtime answers with its own interface, not an open record. */
  listProviderPresets(): Promise<HostResult<"listProviderPresets">>;
  getMiniMaxApiKeyStatus(): Promise<Record<string, unknown>>;
  upsertMiniMaxApiKey(request: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<HostResult<"upsertMiniMaxApiKey">>;
  /** Converted: see `listProviderPresets`. */
  getCodexOAuthStatus(): Promise<HostResult<"getCodexOAuthStatus">>;
  getMiniMaxModelSource(): Promise<"token_plan" | "minimax_api_key">;
  setMiniMaxModelSource(request: {
    readonly source: "token_plan" | "minimax_api_key";
  }): Promise<"token_plan" | "minimax_api_key">;
  testUserModelCandidate(
    request: WebuiHostRequest<"testUserModelCandidate">,
  ): Promise<HostResult<"testUserModelCandidate">>;
  /**
   * Synchronous on the runtime.
   *
   * Declared to return the value directly rather than a promise: the runtime
   * resolves it from a store it already holds, and the mirror's `Promise` was a
   * shape it could not honour. The adapter wraps it, so a caller of the port
   * still awaits.
   */
  revealModelProviderApiKey(request: { readonly providerId: string }): string;
  startCodexOAuthLogin(
    request?: Record<string, unknown>,
  ): Promise<HostResult<"startCodexOAuthLogin">>;
  /** Takes the id itself, not a record: the runtime's own shape, unwrapped here
   * rather than widened to a record the adapter would then have to unwrap. */
  cancelCodexOAuthLogin(
    loginId: string,
  ): Promise<HostResult<"cancelCodexOAuthLogin">>;
  refreshModels(): Promise<HostResult<"refreshModels">>;
  /**
   * Compaction is opt-in on the live harness: the `CliService` exposes it
   * only when the host has a meaningful reducer, and the WebUI surface
   * surfaces `runtime host does not expose requestCompaction` for any host
   * that omits it. The runner's `/compact` path therefore can't assume the
   * method always exists, which is why the port's `requestCompaction` is
   * a required harness-port method: the assembly is responsible for
   * projecting an `optional` cliService hook into a `required` port entry,
   * and failing closed otherwise. See `createHarnessPortFromHost` for the
   * nested-guard pattern that turns that `?` into a clear error.
   */
  requestCompaction?(request: {
    readonly name: string;
    readonly id: string;
    readonly reason: "ui_request";
    readonly customInstructions?: string;
  }): Promise<HostResult<"requestCompaction">>;
  /**
   * The Mini App cell of the runtime's owner policy.
   *
   * Optional on the same terms as the memory pair: a host composed without the
   * Mini App capability still has to satisfy this shape, and the adapter's guard
   * turns the absent member into one `capability_unavailable` refusal instead of
   * an empty catalogue. Results are the runtime's own (`HostResult`), because the
   * publishable summary and the server-only launch are converted at the adapter —
   * a `WebuiMiniAppLaunch` is not a shape the runtime has, it is what the WebUI
   * makes of one.
   */
  listMiniApps?(): Promise<HostResult<"listMiniApps">>;
  /**
   * The installed set, including a Mini App the person disabled.
   *
   * Optional: a host whose runtime predates the installed read answers only
   * `listMiniApps`, and the adapter falls back to it. `enabled: false` on a row is
   * what tells the catalogue to offer "enable" rather than "open".
   */
  listInstalledMiniApps?(): Promise<HostResult<"listMiniApps">>;
  openMiniApp?(
    request: WebuiHostRequest<"openMiniApp">,
  ): Promise<HostResult<"openMiniApp">>;
  stopMiniApp?(
    request: WebuiHostRequest<"stopMiniApp">,
  ): Promise<HostResult<"stopMiniApp">>;
  /**
   * The Mini App Agent facade.
   *
   * Present together or absent together: the runtime composes all nine from one
   * application cell, so a host with two of them is broken rather than partial and
   * the adapter refuses all nine. The parameter shapes are the facade's own
   * (`CliService`), including the `caller` the service resolved for the page.
   */
  runMiniAppAgentTurn?: CliService["runMiniAppAgentTurn"];
  answerMiniAppAgentQuestion?: CliService["answerMiniAppAgentQuestion"];
  replyMiniAppAgentPermission?: CliService["replyMiniAppAgentPermission"];
  openMiniAppAgentSession?: CliService["openMiniAppAgentSession"];
  panelOpenedMiniAppAgentSession?: CliService["panelOpenedMiniAppAgentSession"];
  panelClosedMiniAppAgentSession?: CliService["panelClosedMiniAppAgentSession"];
  listMiniAppAgentModels?: CliService["listMiniAppAgentModels"];
  listMiniAppAgentAgents?: CliService["listMiniAppAgentAgents"];
  listMiniAppAgentSessions?: CliService["listMiniAppAgentSessions"];
  readMiniAppAgentSession?: CliService["readMiniAppAgentSession"];
  createMiniAppAgentSession?: CliService["createMiniAppAgentSession"];
}

export interface WebuiRuntimeHostHandle {
  readonly apiHost: { close(): Promise<void> };
  readonly appVersion?: string;
  readonly dataDir?: string;
  readonly invalidateAuth?: () => void;
  /**
   * Cloud quota for the usage panel. Backed by `usage-quota.ts`, not the
   * harness — the assembly supplies the client alongside the host.
   */
  readonly getUsageQuota?: (request?: {
    readonly forceRefresh?: boolean;
  }) => Promise<import("../../shared/contracts/usage-quota.js").WebuiUsageQuotaResult>;
  /**
   * The account-billing surface of the usage-and-model page: the credit
   * fallback switch and the reset cards. Backed by `usage-quota.ts`, not the
   * harness — the assembly supplies the client alongside the host.
   */
  readonly getCreditFallback?: () => Promise<
    import("../../shared/contracts/account-billing.js").WebuiCreditFallbackView
  >;
  readonly setCreditFallback?: (request: {
    readonly enabled: boolean;
  }) => Promise<import("../../shared/contracts/account-billing.js").WebuiCreditFallbackView>;
  readonly listResetCards?: (request?: {
    readonly page?: number;
    readonly size?: number;
  }) => Promise<
    import("../../shared/contracts/account-billing.js").WebuiResetCardListResult
  >;
  readonly useResetCard?: (request: {
    readonly sourceType?: string;
    readonly outBizNo?: string;
  }) => Promise<
    import("../../shared/contracts/account-billing.js").WebuiResetCardUseResult
  >;
  readonly queryResetCardFlows?: (request?: {
    readonly page?: number;
    readonly size?: number;
    readonly createTimeMs?: number;
  }) => Promise<
    import("../../shared/contracts/account-billing.js").WebuiResetCardFlowsResult
  >;
  /**
   * The account page's calendar and profile. Backed by `usage-quota.ts`
   * (cloud), supplied by the assembly alongside the host.
   */
  readonly getAccountUsageSummary?: () => Promise<
    import("../../shared/contracts/account-usage.js").WebuiUsageSummaryView
  >;
  readonly getAccountProfile?: () => Promise<
    import("../../shared/contracts/account-usage.js").WebuiAccountProfileView
  >;
  /**
   * Daily check-in status/claim. Backed by `check-in.ts` (cloud), supplied
   * by the assembly alongside the host.
   */
  readonly getSigninPanel?: () => Promise<import("../../shared/contracts/account.js").WebuiSigninPanelView>;
  readonly claimSignin?: () => Promise<import("../../shared/contracts/account.js").WebuiClaimSigninView>;
  /**
   * Account login (device authorization) and real sign-out. Supplied by the
   * assembly from its `MCodeOAuthCore` — the same credential store the quota
   * lease reads — so a login completed in the browser is the same credential
   * the terminal client uses, and a sign-out actually removes it.
   */
  readonly beginAccountLogin?: () => Promise<import("../../shared/contracts/account.js").WebuiAccountLoginView>;
  readonly getAccountLoginStatus?: () => Promise<import("../../shared/contracts/account.js").WebuiAccountLoginView>;
  readonly cancelAccountLogin?: () => Promise<void>;
  readonly signOutAccount?: () => Promise<{
    readonly status: string;
    readonly generation: number;
  }>;
  /**
   * Source of every harness command the WebUI maps to operations. Owned by
   * the runtime host; the WebUI only needs the structural shape to forward.
   */
  readonly cliService?: WebuiRuntimeCliService;
}
