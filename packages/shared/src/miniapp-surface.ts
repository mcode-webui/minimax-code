import type {
  AskQuestionnaireMode,
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireRequest,
} from './questionnaire.js';

/** Renderer-safe Mini App metadata. Runtime launch coordinates never cross this contract. */
export type MiniAppRuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface MiniAppSurfaceSummary {
  readonly pluginId: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly iconUrl?: string;
  /**
   * Where the package came from.
   *
   * A local package and an official one are not changed by the same path: the
   * official one through the marketplace account, the local one on disk. A
   * management surface needs the source to pick the path, and the runtime is
   * the only party that knows which one a package is.
   */
  readonly source?: 'official' | 'local';
  /**
   * Whether the runtime may start this package.
   *
   * Absent for a producer that lists only startable packages — which is what the
   * launch path and the desktop client's catalogue do — and `false` for a row a
   * management surface read through the installed listing, so that surface can
   * offer to enable it instead of a start the runtime would refuse.
   */
  readonly enabled?: boolean;
  readonly runtime: {
    readonly kind: 'process';
    readonly status: MiniAppRuntimeStatus;
    readonly errorCode?: string;
    /** The process guard proves this plugin is running in another client. */
    readonly ownership?: 'other-client';
    /** Label recorded by that live process owner; omitted when its record is unreadable. */
    readonly ownerClient?: string;
  };
}

export interface MiniAppSurfaceTabSummary {
  readonly tabId: number;
  readonly title: string;
  readonly surfaceKind: 'miniapp';
  readonly miniApp: MiniAppSurfaceSummary;
  /** True while the page is shown in its own window instead of the File Panel. */
  readonly detached: boolean;
  /**
   * Monotonic, bumped once per completed detach and once per completed attach.
   * A fast detach->attach round trip can complete between two state polls,
   * leaving `detached` unchanged on both reads; the renderer keys its
   * presentation on this counter too so it still forces a fresh `show()`.
   */
  readonly presentationRevision: number;
}

export type MiniAppSurfaceErrorCode =
  | 'invalid_request'
  | 'runtime_unavailable'
  | 'not_found'
  | 'busy'
  | 'refresh_failed'
  | 'stop_failed'
  | 'start_failed'
  | 'detach_failed'
  | 'attach_failed';

/** Bounded, renderer-safe explanation for a retryable Mini App busy failure. */
export type MiniAppSurfaceBusyReason = 'capacity_busy' | 'operation_busy';

export type MiniAppListResponse =
  | { readonly success: true; readonly miniApps: readonly MiniAppSurfaceSummary[] }
  | { readonly success: false; readonly code: MiniAppSurfaceErrorCode };

export type MiniAppOpenResponse =
  | { readonly success: true; readonly tab: MiniAppSurfaceTabSummary }
  | {
      readonly success: false;
      readonly code: 'busy';
      readonly busyReason?: MiniAppSurfaceBusyReason;
    }
  | {
      readonly success: false;
      readonly code: Exclude<MiniAppSurfaceErrorCode, 'busy'>;
      readonly busyReason?: never;
    };

export type MiniAppStartResponse =
  | { readonly success: true; readonly miniApp: MiniAppSurfaceSummary }
  | Extract<MiniAppOpenResponse, { success: false }>;

export interface MiniAppPageOpenInput {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly openPage?: true;
}

export interface MiniAppBackgroundOpenInput {
  readonly pluginId: string;
  readonly openPage: false;
}

/** Keeps existing page-open callers precise while sharing one renderer bridge. */
export interface MiniAppOpenApi {
  (params: MiniAppPageOpenInput): Promise<MiniAppOpenResponse>;
  (params: MiniAppBackgroundOpenInput): Promise<MiniAppStartResponse>;
}

export type MiniAppControlResponse =
  | { readonly success: true }
  | { readonly success: false; readonly code: MiniAppSurfaceErrorCode };

/**
 * Request header that carries the Host-issued loopback credential to a Mini App's own
 * port. Only the name is shared; the value stays in Electron main and local-runtime.
 */
export const MINIAPP_LOOPBACK_TOKEN_HEADER = 'x-mavis-miniapp-token';

/** Bounds one untrusted page request; input behavior remains owned by the chat input. */
export const MINIAPP_COMPOSER_MAX_TEXT_LENGTH = 100_000;

const MINIAPP_COMPOSER_FAILURE_CODES = [
  'user_cancelled',
  'invalid_request',
  'text_too_large',
  'not_allowed',
  'target_unavailable',
  'result_unknown',
] as const;

/** Success acknowledges a draft append, never an Agent submission or a durable disk commit. */
export type MiniAppComposerAppendResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly code: (typeof MINIAPP_COMPOSER_FAILURE_CODES)[number];
    };

/** Both IPC boundaries use the same allowlist and discard all non-contract fields. */
export function parseMiniAppComposerAppendResult(
  value: unknown,
): MiniAppComposerAppendResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.success === true) return { success: true };
  const code = MINIAPP_COMPOSER_FAILURE_CODES.find((candidate) => candidate === result.code);
  return result.success === false && code ? { success: false, code } : null;
}

/** Main-to-Host-renderer only. None of these identity fields are supplied by the MiniApp. */
export interface MiniAppComposerRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly text: string;
}

/** Host-to-Main result for one requested append. */
export interface MiniAppComposerReply {
  readonly requestId: string;
  readonly result: MiniAppComposerAppendResult;
}

/** Host-renderer-only confirmation channel; never exposed to an embedded page. */
export interface MiniAppComposerHostAPI {
  onAppendRequest(
    handler: (request: MiniAppComposerRequest) => Promise<MiniAppComposerAppendResult>,
  ): () => void;
}

/** Bounds one untrusted page Agent request before it crosses into Main. */
export const MINIAPP_AGENT_MAX_TEXT_LENGTH = 100_000;

export const MINIAPP_AGENT_FAILURE_CODES = [
  'invalid_request',
  'not_permitted',
  'busy',
  'session_not_found',
  'runtime_unavailable',
  'cancelled',
  'result_unknown',
  'request_not_found',
] as const;

export type MiniAppAgentFailureCode = (typeof MINIAPP_AGENT_FAILURE_CODES)[number];

/**
 * Why a `run` / `answer` failed as `busy`: its session is already running, or the Mini App's
 * queue of waiting calls is full.
 */
export type MiniAppAgentBusyReason = 'session_busy' | 'queue_full';

export function isMiniAppAgentBusyReason(value: unknown): value is MiniAppAgentBusyReason {
  return value === 'session_busy' || value === 'queue_full';
}

/** `reason` is set only with `busy`. */
export interface MiniAppAgentFailure {
  readonly ok: false;
  readonly code: MiniAppAgentFailureCode;
  readonly reason?: MiniAppAgentBusyReason;
}

/** Bounds a page-chosen request id; it is only a per-page correlation key. */
export const MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH = 128;

/** What a Mini App sends and receives for a model; the composer's selection minus provider internals. */
export interface MiniAppAgentModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: { readonly effort: string };
}

/** One enabled model of the runtime catalog. */
export interface MiniAppAgentModelOption {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly variants?: readonly string[];
  readonly thinking?: { readonly efforts: readonly string[]; readonly default?: string };
}

export interface MiniAppAgentModels {
  readonly models: readonly MiniAppAgentModelOption[];
  /** What a session without a host chat model is created with. */
  readonly default: MiniAppAgentModelSelection;
  /** The host chat's current model; absent for a tab without a host chat. */
  readonly host?: MiniAppAgentModelSelection;
}

export interface MiniAppAgentAgentOption {
  /** The agent's canonical name; what `agent` takes. */
  readonly name: string;
  readonly displayName: string;
  /** The default agent. */
  readonly primary: boolean;
}

export interface MiniAppAgentAgents {
  readonly agents: readonly MiniAppAgentAgentOption[];
}

/** Read-only, renderer-safe projection of the chat hosting a Mini App page. */
export interface MiniAppAgentSessionContext {
  readonly sessionId: string;
  readonly agent: string;
  readonly workspaceDir: string;
  readonly isDefaultWorkspace: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly title?: string;
  readonly status: 'idle' | 'running' | 'error' | 'aborted';
  readonly model?: MiniAppAgentModelSelection;
  readonly error?: { readonly message: string };
  /** Final text from the latest assistant message, present only on `agent.session(id)`. */
  readonly lastAssistantText?: string;
}

export interface MiniAppAgentSessions {
  readonly sessions: readonly MiniAppAgentSessionContext[];
}

/** Page payload. Plugin and run identity are resolved by Main from the sending tab. */
export interface MiniAppAgentRunRequest {
  readonly text: string;
  readonly sessionId?: string;
  /** Page-chosen id for `cancel(requestId)`; generated when absent. */
  readonly requestId?: string;
  /** Switches the session to this model before the turn. */
  readonly model?: MiniAppAgentModelSelection;
  /** Only with a new session (no `sessionId`): the agent it is created for. */
  readonly agent?: string;
}

/** Page payload for `create`: a session without a turn. */
export interface MiniAppAgentCreateRequest {
  readonly agent?: string;
}

export interface MiniAppAgentCreateResult {
  readonly sessionId: string;
}

/** Non-empty, bounded and free of control characters; checked on both sides of the IPC. */
export function isMiniAppAgentRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MINIAPP_AGENT_MAX_REQUEST_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export type MiniAppAgentPermissionDecision = 'allowOnce' | 'deny';

/** Page payload for a pending permission; `requestId` is the Host permission request id. */
export interface MiniAppAgentReplyRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: MiniAppAgentPermissionDecision;
}

/**
 * Page payload answering a questionnaire: `questionId` is the questionnaire request id and
 * `requestId` is the page-chosen id for `cancel(requestId)`, as in `MiniAppAgentRunRequest`.
 */
export interface MiniAppAgentAnswerRequest {
  readonly sessionId: string;
  readonly questionId: string;
  readonly answers: readonly AskQuestionnaireReplyAnswer[];
  readonly requestId?: string;
  /** Switches the session to this model before the continuation turn. */
  readonly model?: MiniAppAgentModelSelection;
}

/** Bounds one untrusted questionnaire answer list before it crosses into Main. */
export const MINIAPP_AGENT_MAX_ANSWERS = 64;
export const MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH = 4_096;

export function isMiniAppAgentPermissionDecision(
  value: unknown,
): value is MiniAppAgentPermissionDecision {
  return value === 'allowOnce' || value === 'deny';
}

function isBoundedAnswerText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MINIAPP_AGENT_MAX_ANSWER_TEXT_LENGTH;
}

const ANSWER_KEYS: ReadonlySet<string> = new Set([
  'stepId',
  'selectedOptionIds',
  'selectedOther',
  'otherText',
  'skipped',
]);

function readMiniAppAgentAnswer(value: unknown): AskQuestionnaireReplyAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => ANSWER_KEYS.has(key))) return null;
  const { stepId, selectedOptionIds, selectedOther, otherText, skipped } = input;
  if (!isNonEmptyString(stepId) || !isBoundedAnswerText(stepId)) return null;
  if (
    !Array.isArray(selectedOptionIds) ||
    selectedOptionIds.length > MINIAPP_AGENT_MAX_ANSWERS ||
    !selectedOptionIds.every(isBoundedAnswerText)
  ) {
    return null;
  }
  if (typeof selectedOther !== 'boolean') return null;
  if (otherText !== undefined && !isBoundedAnswerText(otherText)) return null;
  if (skipped !== undefined && typeof skipped !== 'boolean') return null;
  return {
    stepId,
    selectedOptionIds: [...selectedOptionIds],
    selectedOther,
    ...(otherText !== undefined ? { otherText } : {}),
    ...(skipped !== undefined ? { skipped } : {}),
  };
}

/** Closed-key, bounded copy of questionnaire answers; null when any entry is malformed. */
export function readMiniAppAgentAnswers(value: unknown): AskQuestionnaireReplyAnswer[] | null {
  if (!Array.isArray(value) || value.length > MINIAPP_AGENT_MAX_ANSWERS) return null;
  const answers: AskQuestionnaireReplyAnswer[] = [];
  for (const entry of value) {
    const answer = readMiniAppAgentAnswer(entry);
    if (!answer) return null;
    answers.push(answer);
  }
  return answers;
}

/** Page `reply` payload, checked in the preload and again in Main; null when malformed. */
export function readMiniAppAgentReplyRequest(value: unknown): MiniAppAgentReplyRequest | null {
  if (!value || typeof value !== 'object') return null;
  const { sessionId, requestId, decision } = value as Record<string, unknown>;
  return isNonEmptyString(sessionId) &&
    isNonEmptyString(requestId) &&
    isMiniAppAgentPermissionDecision(decision)
    ? { sessionId, requestId, decision }
    : null;
}

/**
 * Wire-only `observe` flag of a turn-following request (`run`, `answer`): the preload sets it
 * when the page passed `onEvent`, and only then does Main subscribe the run to events (which
 * the runtime also counts as "someone can answer this run's asks"). Absent means `false`;
 * null when present but not a boolean.
 */
export function readMiniAppAgentObserveFlag(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : null;
}

/**
 * Page `answer` payload with its (page-chosen or preload-generated) `requestId` and the
 * wire-only `observe` flag, checked in the preload and again in Main; null when malformed.
 */
export function readMiniAppAgentAnswerRequest(value: unknown): MiniAppAgentAnswerPayload | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const answers = readMiniAppAgentAnswers(input.answers);
  const observe = readMiniAppAgentObserveFlag(input.observe);
  const model = readOptionalModel(input.model);
  const { sessionId, questionId, requestId } = input;
  return isNonEmptyString(sessionId) &&
    isNonEmptyString(questionId) &&
    answers !== null &&
    observe !== null &&
    model !== null &&
    isMiniAppAgentRequestId(requestId)
    ? { sessionId, questionId, answers, requestId, observe, ...(model ? { model } : {}) }
    : null;
}

type MiniAppAgentAnswerPayload = Required<Omit<MiniAppAgentAnswerRequest, 'model'>> & {
  readonly model?: MiniAppAgentModelSelection;
  readonly observe: boolean;
};

type MiniAppAgentRunPayload = Required<Pick<MiniAppAgentRunRequest, 'text' | 'requestId'>> &
  Pick<MiniAppAgentRunRequest, 'sessionId' | 'model' | 'agent'> & { readonly observe: boolean };

/** Page `run` payload with its (page-chosen or preload-generated) `requestId`; null when malformed. */
export function readMiniAppAgentRunRequest(value: unknown): MiniAppAgentRunPayload | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const { text, sessionId, requestId, agent } = input;
  const observe = readMiniAppAgentObserveFlag(input.observe);
  const model = readOptionalModel(input.model);
  if (typeof text !== 'string' || text.length > MINIAPP_AGENT_MAX_TEXT_LENGTH) return null;
  if (!isMiniAppAgentRequestId(requestId) || observe === null || model === null) return null;
  if (!isOptionalNonEmptyString(sessionId) || !isOptionalNonEmptyString(agent)) return null;
  return {
    requestId,
    text,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(model ? { model } : {}),
    ...(agent !== undefined ? { agent } : {}),
    observe,
  };
}

/** `undefined` when absent, `null` when present but malformed. */
function readOptionalModel(value: unknown): MiniAppAgentModelSelection | null | undefined {
  return value === undefined ? undefined : readMiniAppAgentModelSelection(value);
}

/**
 * Copies a model selection from untrusted input, dropping extra keys. Mirrors the runtime's
 * reader: `providerId` / `modelId` are non-empty strings, an empty `variant` is kept (thinking explicitly off).
 */
export function readMiniAppAgentModelSelection(value: unknown): MiniAppAgentModelSelection | null {
  if (!isPlainRecord(value)) return null;
  const { providerId, modelId, variant } = value;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId)) return null;
  if (variant !== undefined && typeof variant !== 'string') return null;
  const thinking = readSelectionThinking(value.thinking);
  if (thinking === null) return null;
  return {
    providerId,
    modelId,
    ...(variant === undefined ? {} : { variant }),
    ...(thinking ? { thinking } : {}),
  };
}

/** `undefined` when absent, `null` when present but malformed. */
function readSelectionThinking(value: unknown): MiniAppAgentModelSelection['thinking'] | null {
  if (value === undefined) return undefined;
  return isPlainRecord(value) && typeof value.effort === 'string' ? { effort: value.effort } : null;
}

function readStringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...(value as string[])]
    : null;
}

/** `undefined` when absent, `null` when present but malformed. */
function readOptionThinking(value: unknown): MiniAppAgentModelOption['thinking'] | null {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return null;
  const efforts = readStringList(value.efforts);
  const defaultEffort = value.default;
  if (!efforts || (defaultEffort !== undefined && typeof defaultEffort !== 'string')) return null;
  return { efforts, ...(defaultEffort !== undefined ? { default: defaultEffort } : {}) };
}

function readModelOption(value: unknown): MiniAppAgentModelOption | null {
  if (!isPlainRecord(value)) return null;
  const { providerId, modelId, displayName } = value;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId)) return null;
  if (typeof displayName !== 'string') return null;
  const variants = value.variants === undefined ? undefined : readStringList(value.variants);
  const thinking = readOptionThinking(value.thinking);
  if (variants === null || thinking === null) return null;
  return {
    providerId,
    modelId,
    displayName,
    ...(variants ? { variants } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** Allowlist copy of the model catalog; null when any part is malformed. */
export function readMiniAppAgentModels(value: unknown): MiniAppAgentModels | null {
  if (!isPlainRecord(value) || !Array.isArray(value.models)) return null;
  const models: MiniAppAgentModelOption[] = [];
  for (const entry of value.models) {
    const option = readModelOption(entry);
    if (!option) return null;
    models.push(option);
  }
  const fallback = readMiniAppAgentModelSelection(value.default);
  const host = readOptionalModel(value.host);
  if (!fallback || host === null) return null;
  return { models, default: fallback, ...(host ? { host } : {}) };
}

function readAgentOption(value: unknown): MiniAppAgentAgentOption | null {
  if (!isPlainRecord(value)) return null;
  const { name, displayName, primary } = value;
  return isNonEmptyString(name) && typeof displayName === 'string' && typeof primary === 'boolean'
    ? { name, displayName, primary }
    : null;
}

/** Allowlist copy of the agent list; null when any entry is malformed. */
export function readMiniAppAgentAgents(value: unknown): MiniAppAgentAgents | null {
  if (!isPlainRecord(value) || !Array.isArray(value.agents)) return null;
  const agents: MiniAppAgentAgentOption[] = [];
  for (const entry of value.agents) {
    const option = readAgentOption(entry);
    if (!option) return null;
    agents.push(option);
  }
  return { agents };
}

/** Page `create` payload (`{ agent? }`), checked in the preload and again in Main. */
export function readMiniAppAgentCreateRequest(value: unknown): MiniAppAgentCreateRequest | null {
  if (!isPlainRecord(value) || !isOptionalNonEmptyString(value.agent)) return null;
  return value.agent !== undefined ? { agent: value.agent } : {};
}

export function readMiniAppAgentCreateResponse(value: unknown): MiniAppAgentCreateResult | null {
  return isPlainRecord(value) && isNonEmptyString(value.sessionId)
    ? { sessionId: value.sessionId }
    : null;
}

/** Page payload for showing one of the plugin's own sessions in the host chat's side panel. */
export interface MiniAppAgentOpenRequest {
  readonly sessionId: string;
}

/** Page `open` payload, checked in the preload and again in Main; null when malformed. */
export function readMiniAppAgentOpenRequest(value: unknown): MiniAppAgentOpenRequest | null {
  if (!value || typeof value !== 'object') return null;
  const { sessionId } = value as Record<string, unknown>;
  return isNonEmptyString(sessionId) ? { sessionId } : null;
}

/** What the Host UI is asked to show: a Mini App session as a tab in `hostSessionId`'s side panel. */
export interface MiniAppAgentOpenSessionRequest {
  readonly hostSessionId: string;
  readonly sessionId: string;
}

/** Copies a Main `open` request for the Host renderer; null when malformed. */
export function readMiniAppAgentOpenSessionRequest(
  value: unknown,
): MiniAppAgentOpenSessionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const { hostSessionId, sessionId } = value as Record<string, unknown>;
  return isNonEmptyString(hostSessionId) && isNonEmptyString(sessionId)
    ? { hostSessionId, sessionId }
    : null;
}

/**
 * Main-to-Host-renderer request, sent after the runtime confirmed ownership. The Host
 * preload answers every message with a `MiniAppAgentOpenSessionReply` carrying the same
 * `requestId`, so Main learns whether the tab was actually shown (mirrors the composer
 * request/reply channel).
 */
export interface MiniAppAgentOpenSessionMessage extends MiniAppAgentOpenSessionRequest {
  readonly requestId: string;
}

/**
 * Host renderer's answer to an open request. `target_unavailable`: no Host UI handler is
 * installed yet (startup, reload); `result_unknown`: the handler threw.
 */
export type MiniAppAgentOpenSessionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'target_unavailable' | 'result_unknown' };

export interface MiniAppAgentOpenSessionReply {
  readonly requestId: string;
  readonly result: MiniAppAgentOpenSessionResult;
}

export function readMiniAppAgentOpenSessionReply(
  value: unknown,
): MiniAppAgentOpenSessionReply | null {
  if (!value || typeof value !== 'object') return null;
  const { requestId, result } = value as Record<string, unknown>;
  if (!isNonEmptyString(requestId) || !result || typeof result !== 'object') return null;
  const { ok, code } = result as Record<string, unknown>;
  if (ok === true) return { requestId, result: { ok: true } };
  if (ok === false && (code === 'target_unavailable' || code === 'result_unknown')) {
    return { requestId, result: { ok: false, code } };
  }
  return null;
}

/** Host-renderer-only side-panel channel; never exposed to an embedded page. */
export interface MiniAppAgentSessionsHostAPI {
  /**
   * The handler returns whether the tab is now shown; its result (or a throw) is reported
   * back to Main, which reports it to the page's `agent.open` and, on success, to the
   * runtime as "a panel can answer this session's asks".
   */
  onOpenRequest(
    handler: (request: MiniAppAgentOpenSessionRequest) => boolean | Promise<boolean>,
  ): () => void;
  /** The user closed the tab; the runtime stops waiting on the panel for this session's asks. */
  notifyClosed(request: MiniAppAgentOpenSessionRequest): void;
}

export interface MiniAppAgentRunResult {
  readonly sessionId: string;
  /** Absent when no turn ran (an accepted `answer` without a continuation, or an early cancel). */
  readonly turnId?: string;
  /** The model the turn was dispatched with; absent when no turn ran. */
  readonly model?: MiniAppAgentModelSelection;
  readonly status: 'finished' | 'error' | 'aborted';
  readonly text?: string;
  readonly error?: { readonly code: string; readonly message: string };
  /** Set when the turn ended waiting on a questionnaire; continue with `answer`. */
  readonly pendingQuestion?: {
    readonly requestId: string;
    readonly mode: AskQuestionnaireMode;
    readonly request: AskQuestionnaireRequest;
  };
}

/**
 * Progress of one run, projected by the Host from its own session stream. Every event but
 * `run.queued` names its session so `reply` / `answer` work before the run that created the
 * session returns. Consumers must ignore unknown `type` values so the vocabulary can grow
 * additively.
 */
export type MiniAppAgentRunEvent =
  /**
   * The call waits for a run slot at 1-based `position`; sent once, before admission, so
   * `sessionId` is present only when the call continues an existing session.
   */
  | { readonly type: 'run.queued'; readonly sessionId?: string; readonly position: number }
  | {
      readonly type: 'turn.started';
      readonly sessionId: string;
      readonly turnId: string;
      readonly model: MiniAppAgentModelSelection;
    }
  | {
      readonly type: 'text.delta';
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: 'message.committed';
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: 'tool.started';
      readonly sessionId: string;
      readonly turnId: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool.finished';
      readonly sessionId: string;
      readonly turnId: string;
      readonly name: string;
      readonly ok: boolean;
    }
  | {
      readonly type: 'permission.requested';
      readonly sessionId: string;
      /** Absent when the runtime did not attribute the ask to a turn. */
      readonly turnId?: string;
      readonly requestId: string;
      readonly toolName: string;
      readonly toolInput?: string;
      readonly reason: string;
    }
  | {
      readonly type: 'question.requested';
      readonly sessionId: string;
      readonly turnId?: string;
      readonly requestId: string;
      readonly mode: AskQuestionnaireMode;
      readonly request: AskQuestionnaireRequest;
    }
  | {
      readonly type: 'turn.finished';
      readonly sessionId: string;
      readonly turnId: string;
      readonly status: MiniAppAgentRunResult['status'];
      readonly text?: string;
      readonly error?: { readonly code: string; readonly message: string };
    };

export type MiniAppAgentRunResponse =
  | { readonly ok: true; readonly result: MiniAppAgentRunResult }
  | MiniAppAgentFailure;

export type MiniAppAgentReplyResponse = { readonly ok: true } | MiniAppAgentFailure;

export type MiniAppAgentOpenResponse = MiniAppAgentReplyResponse;

const MINIAPP_AGENT_RUNTIME_ERROR_CODES: Readonly<Record<string, MiniAppAgentFailureCode>> = {
  NOT_PERMITTED: 'not_permitted',
  BUSY: 'busy',
  SESSION_NOT_FOUND: 'session_not_found',
  INVALID_ARGUMENTS: 'invalid_request',
  AGENT_UNAVAILABLE: 'runtime_unavailable',
  REQUEST_CANCELLED: 'cancelled',
  AGENT_OUTCOME_UNKNOWN: 'result_unknown',
  REQUEST_NOT_FOUND: 'request_not_found',
};

/** Maps a runtime `MiniAppAgentErrorCode`; unknown codes return undefined. */
export function toMiniAppAgentFailureCode(
  runtimeCode: unknown,
): MiniAppAgentFailureCode | undefined {
  return typeof runtimeCode === 'string' &&
    Object.prototype.hasOwnProperty.call(MINIAPP_AGENT_RUNTIME_ERROR_CODES, runtimeCode)
    ? MINIAPP_AGENT_RUNTIME_ERROR_CODES[runtimeCode]
    : undefined;
}

export function isMiniAppAgentFailureCode(value: unknown): value is MiniAppAgentFailureCode {
  return MINIAPP_AGENT_FAILURE_CODES.some((code) => code === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

/** Allowlist copy of a run result; returns null when a required field is malformed. */
export function readMiniAppAgentRunResult(value: unknown): MiniAppAgentRunResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const { sessionId, turnId } = input;
  if (!isNonEmptyString(sessionId) || !isOptionalNonEmptyString(turnId)) return null;
  const outcome = readRunOutcome(input);
  if (!outcome) return null;
  // A malformed model is dropped rather than failing a turn that already ran.
  const model = readOptionalModel(input.model);
  const pending = input.pendingQuestion;
  const pendingQuestion =
    pending && typeof pending === 'object'
      ? readPendingQuestion(pending as Record<string, unknown>)
      : null;
  if (pending !== undefined && !pendingQuestion) return null;
  return {
    sessionId,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(model ? { model } : {}),
    ...outcome,
    ...(pendingQuestion ? { pendingQuestion } : {}),
  };
}

type MiniAppAgentPendingQuestion = NonNullable<MiniAppAgentRunResult['pendingQuestion']>;

/** Reads `requestId` / `mode` / `request` of a run result's or event's questionnaire. */
function readPendingQuestion(input: Record<string, unknown>): MiniAppAgentPendingQuestion | null {
  const { requestId, mode, request } = input;
  return isNonEmptyString(requestId) &&
    isMiniAppAgentQuestionMode(mode) &&
    isQuestionnaireRequest(request)
    ? { requestId, mode, request }
    : null;
}

export function isMiniAppAgentQuestionMode(value: unknown): value is AskQuestionnaireMode {
  return value === 'questionnaire' || value === 'feature-enable' || value === 'plan';
}

/** Envelope check only; the steps are passed through as the Host chat renders them. */
function isQuestionnaireRequest(value: unknown): value is AskQuestionnaireRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    request.schemaVersion === 2 && isNonEmptyString(request.id) && Array.isArray(request.steps)
  );
}

function readRunOutcome(
  input: Record<string, unknown>,
): Pick<MiniAppAgentRunResult, 'status' | 'text' | 'error'> | null {
  if (input.status !== 'finished' && input.status !== 'error' && input.status !== 'aborted') {
    return null;
  }
  if (input.text !== undefined && typeof input.text !== 'string') return null;
  let error: MiniAppAgentRunResult['error'];
  if (input.error !== undefined) {
    if (!input.error || typeof input.error !== 'object') return null;
    const { code, message } = input.error as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') return null;
    error = { code, message };
  }
  return {
    status: input.status,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(error ? { error } : {}),
  };
}

/** Allowlist copy of one run event; unknown `type`s and malformed events return null. */
export function readMiniAppAgentRunEvent(value: unknown): MiniAppAgentRunEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type === 'run.queued') return readRunQueuedEvent(input);
  const { sessionId } = input;
  if (!isNonEmptyString(sessionId)) return null;
  if (input.type === 'question.requested') return readQuestionRequestedEvent(sessionId, input);
  if (input.type === 'permission.requested') {
    return readPermissionRequestedEvent(sessionId, input);
  }
  const { turnId } = input;
  if (!isNonEmptyString(turnId)) return null;
  switch (input.type) {
    case 'turn.started': {
      const model = readMiniAppAgentModelSelection(input.model);
      return model ? { type: 'turn.started', sessionId, turnId, model } : null;
    }
    case 'text.delta':
    case 'message.committed':
      return typeof input.text === 'string'
        ? { type: input.type, sessionId, turnId, text: input.text }
        : null;
    case 'tool.started':
      return typeof input.name === 'string'
        ? { type: 'tool.started', sessionId, turnId, name: input.name }
        : null;
    case 'tool.finished':
      return typeof input.name === 'string' && typeof input.ok === 'boolean'
        ? { type: 'tool.finished', sessionId, turnId, name: input.name, ok: input.ok }
        : null;
    case 'turn.finished': {
      const outcome = readRunOutcome(input);
      return outcome ? { type: 'turn.finished', sessionId, turnId, ...outcome } : null;
    }
    default:
      return null;
  }
}

function readRunQueuedEvent(input: Record<string, unknown>): MiniAppAgentRunEvent | null {
  const { sessionId, position } = input;
  if (!isOptionalNonEmptyString(sessionId)) return null;
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) return null;
  return { type: 'run.queued', ...(sessionId !== undefined ? { sessionId } : {}), position };
}

function readPermissionRequestedEvent(
  sessionId: string,
  input: Record<string, unknown>,
): MiniAppAgentRunEvent | null {
  const { turnId, requestId, toolName, toolInput, reason } = input;
  if (
    !isOptionalNonEmptyString(turnId) ||
    !isNonEmptyString(requestId) ||
    typeof toolName !== 'string' ||
    typeof reason !== 'string' ||
    (toolInput !== undefined && typeof toolInput !== 'string')
  ) {
    return null;
  }
  return {
    type: 'permission.requested',
    sessionId,
    ...(turnId !== undefined ? { turnId } : {}),
    requestId,
    toolName,
    ...(toolInput !== undefined ? { toolInput } : {}),
    reason,
  };
}

function readQuestionRequestedEvent(
  sessionId: string,
  input: Record<string, unknown>,
): MiniAppAgentRunEvent | null {
  const { turnId } = input;
  if (!isOptionalNonEmptyString(turnId)) return null;
  const question = readPendingQuestion(input);
  if (!question) return null;
  return {
    type: 'question.requested',
    sessionId,
    ...(turnId !== undefined ? { turnId } : {}),
    ...question,
  };
}

/**
 * Both IPC boundaries parse the same envelope. Anything unrecognised is `result_unknown`: the
 * turn may already have run, so callers must not retry it automatically.
 */
export function parseMiniAppAgentRunResult(value: unknown): MiniAppAgentRunResponse {
  if (value && typeof value === 'object') {
    const response = value as Record<string, unknown>;
    if (response.ok === true) {
      const result = readMiniAppAgentRunResult(response.result);
      if (result) return { ok: true, result };
    } else if (response.ok === false) {
      return readMiniAppAgentFailure(response);
    }
  }
  return { ok: false, code: 'result_unknown' };
}

/** Same envelope rules as `parseMiniAppAgentRunResult`; a reply has no result payload. */
export function parseMiniAppAgentReplyResult(value: unknown): MiniAppAgentReplyResponse {
  if (value && typeof value === 'object') {
    const response = value as Record<string, unknown>;
    if (response.ok === true) return { ok: true };
    if (response.ok === false) return readMiniAppAgentFailure(response);
  }
  return { ok: false, code: 'result_unknown' };
}

/** An unknown code is `result_unknown`; a malformed or non-`busy` `reason` is dropped. */
function readMiniAppAgentFailure(response: Record<string, unknown>): MiniAppAgentFailure {
  const { code, reason } = response;
  if (!isMiniAppAgentFailureCode(code)) return { ok: false, code: 'result_unknown' };
  return code === 'busy' && isMiniAppAgentBusyReason(reason)
    ? { ok: false, code, reason }
    : { ok: false, code };
}

export type MiniAppAgentModelsResponse =
  | { readonly ok: true; readonly result: MiniAppAgentModels }
  | MiniAppAgentFailure;
export type MiniAppAgentAgentsResponse =
  | { readonly ok: true; readonly result: MiniAppAgentAgents }
  | MiniAppAgentFailure;
export type MiniAppAgentCreateResponse =
  | { readonly ok: true; readonly result: MiniAppAgentCreateResult }
  | MiniAppAgentFailure;

function parseMiniAppAgentResultEnvelope<T>(
  value: unknown,
  read: (result: unknown) => T | null,
): { readonly ok: true; readonly result: T } | MiniAppAgentFailure {
  if (value && typeof value === 'object') {
    const response = value as Record<string, unknown>;
    if (response.ok === true) {
      const result = read(response.result);
      if (result) return { ok: true, result };
    } else if (response.ok === false) {
      return readMiniAppAgentFailure(response);
    }
  }
  return { ok: false, code: 'result_unknown' };
}

/** Envelope of the `models` / `agents` / `create` invokes; malformed is `result_unknown`. */
export function parseMiniAppAgentModelsResult(value: unknown): MiniAppAgentModelsResponse {
  return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentModels);
}

export function parseMiniAppAgentAgentsResult(value: unknown): MiniAppAgentAgentsResponse {
  return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentAgents);
}

export function parseMiniAppAgentCreateResult(value: unknown): MiniAppAgentCreateResponse {
  return parseMiniAppAgentResultEnvelope(value, readMiniAppAgentCreateResponse);
}

/** Same envelope as a reply acknowledgement. */
export function parseMiniAppAgentOpenResult(value: unknown): MiniAppAgentOpenResponse {
  return parseMiniAppAgentReplyResult(value);
}

/**
 * Hoisted out of the omitted window block, which declares this guard between its
 * own rules; the agent parsers above need it. Nothing else from that block is here.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
