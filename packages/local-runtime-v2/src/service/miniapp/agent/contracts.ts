/**
 * Mini App Agent API contracts.
 *
 * A Mini App (Node process or page) hands text to an agent session owned by the Host and
 * receives progress events plus the final assistant reply. Sessions are hidden
 * `conversation` records tagged with the originating plugin; they never appear in
 * user-facing lists. Permission prompts and questionnaires go to the run's listener.
 */
import type {
  AskQuestionnaireMode,
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';
import type { MiniAppAgentPolicy } from '../contracts.js';

/**
 * The two bounds are declared beside `MiniAppAgentPolicy` in `../contracts.ts`, which the manifest
 * reader already imports; re-exported here because the agent module's own consumers read them here.
 */
export {
  MINIAPP_AGENT_DEFAULT_CONCURRENCY,
  MINIAPP_AGENT_MAX_CONCURRENCY,
} from '../contracts.js';

/**
 * `run` / `answer` calls that may wait, in FIFO order, for one of the plugin's run slots:
 * this many times its concurrency.
 */
export const MINIAPP_AGENT_QUEUE_FACTOR = 4;

/** Session purpose label only; Mini App sessions resolve their prompt surface like any other. */
export { MINIAPP_AGENT_PURPOSE_PREFIX } from '../contracts.js';

/** Agent for new Mini App sessions without a host chat session (`PRIMARY_AGENT_NAME`). */
export const MINIAPP_AGENT_NAME = 'mavis';

export interface MiniAppAgentCaller {
  readonly pluginId: string;
  /** `processGeneration` for the Node path, tab `runId` (same value) for the page path. */
  readonly processGeneration: string;
  readonly source: 'process' | 'page';
  /**
   * The chat session whose side panel opened the Mini App; resolved by Main from the tab,
   * never from page content. Absent on the Node path.
   */
  readonly hostSessionId?: string;
}

export interface MiniAppAgentRunInput {
  readonly text: string;
  /** Continue an existing session owned by the same plugin; omit to create one. */
  readonly sessionId?: string;
  /**
   * Switch the session to this model before the turn, like picking one in the composer; the
   * session keeps it for later turns. Omit to run on the session's current model.
   */
  readonly model?: MiniAppAgentModelSelection;
  /** Only when creating a session (no `sessionId`); the session keeps its agent. */
  readonly agent?: string;
}

type MiniAppAgentRunStatus = 'finished' | 'error' | 'aborted';

/** What a Mini App sends and receives for a model; the composer's selection minus provider internals. */
export interface MiniAppAgentModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: { readonly effort: string };
}

/** One enabled model of the runtime catalog, as the composer's picker lists it. */
interface MiniAppAgentModelOption {
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
  /** Page callers only: the host chat's current model (its default when the chat has none). */
  readonly host?: MiniAppAgentModelSelection;
}

interface MiniAppAgentAgentOption {
  /** The agent's canonical name; what `agent` takes. */
  readonly name: string;
  readonly displayName: string;
  /** The default agent (`mavis`). */
  readonly primary: boolean;
}

export interface MiniAppAgentAgents {
  readonly agents: readonly MiniAppAgentAgentOption[];
}

/** Read-only, renderer-safe summary of the chat hosting a Mini App page. */
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
  readonly lastAssistantText?: string;
}

export interface MiniAppAgentSessions {
  readonly sessions: readonly MiniAppAgentSessionContext[];
}

export interface MiniAppAgentRunResult {
  readonly sessionId: string;
  /** Absent when no turn ran: an `answer` the runtime accepted without starting a continuation. */
  readonly turnId?: string;
  /** The model the turn was dispatched with; absent when no turn ran. */
  readonly model?: MiniAppAgentModelSelection;
  readonly status: MiniAppAgentRunStatus;
  /** Final assistant reply text; absent when the turn produced none or did not finish. */
  readonly text?: string;
  readonly error?: { readonly code: string; readonly message: string };
  /** Set when the turn ended waiting on a questionnaire; continue with `answer`. */
  readonly pendingQuestion?: {
    readonly requestId: string;
    readonly mode: AskQuestionnaireMode;
    readonly request: AskQuestionnaireRequest;
  };
}

export type MiniAppAgentPermissionDecision = 'allowOnce' | 'deny';

export interface MiniAppAgentReplyInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: MiniAppAgentPermissionDecision;
}

export interface MiniAppAgentAnswerInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly answers: readonly AskQuestionnaireReplyAnswer[];
  /** Same as `MiniAppAgentRunInput.model`, applied before the continuation turn. */
  readonly model?: MiniAppAgentModelSelection;
}

/**
 * Progress of one run, projected Host-side from the session stream; internal protocol
 * shapes and ids never cross this contract. Every event but `run.queued` names its session so
 * a listener can call `reply`/`answer` before the run that created the session has returned.
 * Consumers must ignore unknown `type` values so the vocabulary can grow additively.
 */
export type MiniAppAgentRunEvent =
  /**
   * All run slots of the plugin are taken; the call waits at 1-based `position` of the FIFO.
   * Sent once, before the call is admitted, so `sessionId` is present only when it continues
   * an existing session (a new session is created after admission).
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
  /** A tool call is waiting for approval; answer with `reply`. Only emitted while this run has a listener. */
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
  /** The turn paused on a questionnaire (`ask_user`, feature enable, Plan review); answer with `answer`. */
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
      readonly status: MiniAppAgentRunStatus;
      readonly text?: string;
      readonly error?: { readonly code: string; readonly message: string };
    };

export interface MiniAppAgentRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
}

export const MINIAPP_AGENT_ERROR_CODES = [
  'NOT_PERMITTED',
  'BUSY',
  'SESSION_NOT_FOUND',
  'INVALID_ARGUMENTS',
  'AGENT_UNAVAILABLE',
  'REQUEST_CANCELLED',
  'AGENT_OUTCOME_UNKNOWN',
  'REQUEST_NOT_FOUND',
] as const;

export type MiniAppAgentErrorCode = (typeof MINIAPP_AGENT_ERROR_CODES)[number];

/**
 * Why a `run` / `answer` is `BUSY`: its session is already running, or the plugin's wait
 * queue is full (`MINIAPP_AGENT_QUEUE_FACTOR` × its concurrency).
 */
export type MiniAppAgentBusyReason = 'session_busy' | 'queue_full';

export function isMiniAppAgentBusyReason(value: unknown): value is MiniAppAgentBusyReason {
  return value === 'session_busy' || value === 'queue_full';
}

export class MiniAppAgentError extends Error {
  override readonly name = 'MiniAppAgentError';
  readonly code: MiniAppAgentErrorCode;
  readonly retryable: boolean;
  /** Set on every `BUSY`; absent (not an own property) otherwise. */
  declare readonly reason?: MiniAppAgentBusyReason;

  constructor(
    code: MiniAppAgentErrorCode,
    message: string,
    retryable = false,
    reason?: MiniAppAgentBusyReason,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    if (reason !== undefined) this.reason = reason;
  }
}

/** Active Mini App process that may call the Agent; registered by the Host IPC session. */
export interface MiniAppAgentArena {
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly policy: MiniAppAgentPolicy;
}

/**
 * Host-side entry shared by the Node IPC path and the page bridge. Enforces
 * manifest policy, per-plugin concurrency, session ownership and audit.
 */
export interface MiniAppAgentGateway {
  /**
   * Register on activate, call the returned release on retire/exit. Release aborts
   * every in-flight run of that arena and cancels (`REQUEST_CANCELLED`) every queued one.
   * Re-registering the same pluginId replaces the previous generation (cutover) and
   * releases it.
   */
  registerArena(arena: MiniAppAgentArena): () => void;
  /**
   * Rejects with NOT_PERMITTED when no arena is registered for the plugin or its policy lacks
   * `session.run`, and with retryable AGENT_UNAVAILABLE when `caller` is of an older generation.
   * With every run slot taken the call waits in the plugin's FIFO (`run.queued`) until one
   * frees; it rejects with retryable BUSY when its session is already running (`session_busy`)
   * or the queue is full (`queue_full`), and with REQUEST_CANCELLED when aborted while waiting.
   */
  run(
    caller: MiniAppAgentCaller,
    input: MiniAppAgentRunInput,
    options?: MiniAppAgentRunOptions,
  ): Promise<MiniAppAgentRunResult>;
  /** The enabled models a run may switch to, the default one and, for a page, the host chat's. */
  models(caller: MiniAppAgentCaller): Promise<MiniAppAgentModels>;
  /** The agents a new session may be created for. */
  agents(caller: MiniAppAgentCaller): Promise<MiniAppAgentAgents>;
  /** List the most recently updated visible user conversations. */
  sessions(caller: MiniAppAgentCaller): Promise<MiniAppAgentSessions>;
  /** Read a session; an omitted id reads the host chat for a page caller. */
  session(
    caller: MiniAppAgentCaller,
    input?: { readonly sessionId?: string },
  ): Promise<MiniAppAgentSessionContext | undefined>;
  /**
   * Creates a session bound like a first `run` would (agent, directory, model snapshot) without
   * running a turn. Takes no run slot. INVALID_ARGUMENTS when `agent` is not one of `agents()`.
   */
  create(
    caller: MiniAppAgentCaller,
    input?: { readonly agent?: string },
  ): Promise<{ readonly sessionId: string }>;
  /**
   * Decide a pending permission request of a session this plugin owns. Only
   * `allowOnce` / `deny`: a Mini App never writes the user's global permission rules.
   * Rejects with REQUEST_NOT_FOUND when the request is unknown or already settled.
   */
  reply(caller: MiniAppAgentCaller, input: MiniAppAgentReplyInput): Promise<void>;
  /**
   * Answer the questionnaire a turn paused on. The answer starts the continuation
   * turn, which is observed exactly like `run` (same options, same result shape).
   * Rejects with AGENT_OUTCOME_UNKNOWN when the answer was recorded but the
   * continuation turn was not observed in time.
   */
  answer(
    caller: MiniAppAgentCaller,
    input: MiniAppAgentAnswerInput,
    options?: MiniAppAgentRunOptions,
  ): Promise<MiniAppAgentRunResult>;
  /**
   * Confirms that `sessionId` may be shown in the side panel of the chat the Mini App
   * is open in now: the session belongs to the caller's plugin (whichever chat created
   * it). Only page callers (those with `hostSessionId`) can open a panel.
   * Rejects with SESSION_NOT_FOUND otherwise. Showing the tab is the Host UI's job.
   */
  open(
    caller: MiniAppAgentCaller,
    input: { readonly sessionId: string },
  ): Promise<{ readonly sessionId: string; readonly hostSessionId: string }>;
  /**
   * Host-only, in memory: the host chat's side panel now shows this session, so a
   * user can answer its asks there. Called by the Host after its UI accepted the
   * open request (not on `open`, which only checks ownership). Idempotent.
   */
  panelOpened(input: { readonly sessionId: string; readonly hostSessionId: string }): void;
  /**
   * Host-only, in memory: the tab in `hostSessionId`'s side panel was closed. The session
   * stops counting as answerable only when no chat shows it any more. Idempotent.
   */
  panelClosed(input: { readonly sessionId: string; readonly hostSessionId: string }): void;
}

/**
 * What the permission gate already knows about the asking session from the turn's
 * trusted `SessionRecord`. Lets the router skip the storage walk for an ordinary
 * root session or a SideChat (neither flag) and for a Mini App root (`miniApp`);
 * only a delegated child (`parentSessionId` set) or a caller that passes no
 * lineage still needs its root resolved.
 */
export interface MiniAppSessionLineage {
  /** The session itself carries `miniAppOrigin`, i.e. it is a Mini App root. */
  readonly miniApp: boolean;
  readonly parentSessionId?: string | null;
}

/**
 * Consulted by the permission gate before it waits on an approval. The ask is
 * denied (with a reason the model can act on) only when nobody can answer it:
 * the Mini App run that owns the root session registered no event listener and
 * the Host has not reported the session open in a chat side panel. Where the
 * session was created (`hostSessionId`) is not evidence that anyone is watching.
 */
export interface MiniAppApprovalRouter {
  shouldDenyApproval(sessionId: string, lineage?: MiniAppSessionLineage): Promise<boolean>;
}

export interface MiniAppPermissionAsk {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput?: string;
  readonly reason: string;
}

/** Session-system glue bound after turn/session owners exist (cron `runtime-session-ports` precedent). */
export interface MiniAppAgentSessionPorts {
  createSession(input: {
    readonly pluginId: string;
    readonly agentName: string;
    readonly workspaceDir: string;
    /** The plugin directory when `createDir` is set; a host chat's project directory is used as it is. */
    readonly createDir: boolean;
    /** Resolved at creation; the session record keeps it as its model. */
    readonly model: MiniAppAgentModelSelection;
    /** Only with the runtime default model (see `defaultSessionModel`); written as the record's limit. */
    readonly contextWindow?: number;
  }): Promise<{ readonly sessionId: string }>;
  /**
   * The runtime default model as a new session snapshots it: the selection (the global variant /
   * thinking applied, `variant: ''` meaning thinking off) plus the global context window, which
   * is not part of the public selection.
   */
  defaultSessionModel(): Promise<{
    readonly selection: MiniAppAgentModelSelection;
    readonly contextWindow?: number;
  }>;
  /**
   * Validates like the composer does (`resolveRequestedSessionModel`); `undefined` resolves the
   * runtime default. INVALID_ARGUMENTS when the user cannot use it.
   */
  resolveModel(requested?: MiniAppAgentModelSelection): Promise<MiniAppAgentModelSelection>;
  /** Enabled models of the runtime catalog. */
  listModels(): Promise<readonly MiniAppAgentModelOption[]>;
  /** `AgentApplication.list({ includeAliases: false })` projected; aliases collapsed on canonicalViewName. */
  listAgents(): Promise<readonly MiniAppAgentAgentOption[]>;
  /** Read a normal user conversation; hidden, Mini App, task, cron and child sessions are omitted. */
  listUserSessions(): Promise<MiniAppAgentSessions>;
  readUserSession(sessionId: string): Promise<MiniAppAgentSessionContext | undefined>;
  /** Read a Mini App session owned by the caller, including its latest assistant reply. */
  readMiniAppSession(sessionId: string): Promise<MiniAppAgentSessionContext | undefined>;
  /** The session record's current model; undefined only for records predating this feature. */
  readSessionModel(sessionId: string): Promise<MiniAppAgentModelSelection | undefined>;
  /**
   * Persists an already resolved selection on the session, like picking a model for it in the
   * composer; later turns use it. Fails as retryable AGENT_UNAVAILABLE (nothing dispatched).
   */
  setSessionModel(sessionId: string, model: MiniAppAgentModelSelection): Promise<void>;
  /** Returns the owning pluginId, or undefined when the session is missing or not a Mini App session. */
  getOwner(sessionId: string): Promise<string | undefined>;
  /**
   * The Mini App session the given session is or descends from (via delegated child sessions),
   * or undefined when there is none within a bounded number of hops.
   */
  resolveMiniAppRoot(sessionId: string): Promise<
    | {
        readonly rootSessionId: string;
        readonly pluginId: string;
      }
    | undefined
  >;
  /** What a new Mini App session takes from its host chat session; undefined when it is missing. */
  resolveHostSession(sessionId: string): Promise<
    | {
        readonly agentName: string;
        readonly workspaceDir: string;
        readonly isDefaultWorkspace: boolean;
        /** The host chat's model; undefined when its record has none. */
        readonly model?: MiniAppAgentModelSelection;
      }
    | undefined
  >;
  runTurn(input: {
    readonly sessionId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
  }): Promise<Omit<MiniAppAgentRunResult, 'sessionId'>>;
  /** Settles the questionnaire; the continuation turn it starts is followed like `runTurn`. */
  answerQuestion(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly answers: readonly AskQuestionnaireReplyAnswer[];
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
  }): Promise<Omit<MiniAppAgentRunResult, 'sessionId'>>;
  /**
   * Decides one pending permission request raised by the session's Mini App root or one of its
   * descendants; 'skipped' when it is unknown, already settled or raised under another root.
   */
  replyPermission(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly decision: MiniAppAgentPermissionDecision;
  }): Promise<'processed' | 'skipped'>;
  /** Pushes every permission ask the runtime raises; the gateway routes by sessionId. */
  subscribePermissionAsks(listener: (ask: MiniAppPermissionAsk) => void): () => void;
}

/** Gateway that fails closed (`AGENT_UNAVAILABLE`) until `bind` supplies ports. */
export interface BindableMiniAppAgentGateway extends MiniAppAgentGateway, MiniAppApprovalRouter {
  bind(ports: MiniAppAgentSessionPorts): void;
}
