import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import type { GlobalEvent } from '@mavis/shared/global-events';
import type {
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import type {
  DisplayMessageRecord,
  InternalSessionCreateInput,
  ResumeSessionInput,
  SessionFrame,
  SessionRecord,
} from '../../session-system/index.js';
import type {
  LocalConversationRuntimeConfig,
  ModelProviderModelEntry,
} from '../../model-system/index.js';
import type { AbortTurnResult, TurnService } from '../../turn-system/index.js';
import {
  MINIAPP_AGENT_NAME,
  MINIAPP_AGENT_PURPOSE_PREFIX,
  MiniAppAgentError,
  type MiniAppAgentBusyReason,
  type MiniAppAgentErrorCode,
  type MiniAppAgentModelSelection,
  type MiniAppAgentPermissionDecision,
  type MiniAppAgentRunEvent,
  type MiniAppAgentRunResult,
  type MiniAppAgentSessionContext,
  type MiniAppAgentSessions,
  type MiniAppAgentSessionPorts,
  type MiniAppPermissionAsk,
} from './contracts.js';
import { modelSelectionFromRecord, sessionModelFields } from './model-selection.js';
import {
  createAgentTurnSession,
  resolveAgentTurnModel,
  resolveDefaultAgentTurnModel,
} from '../../agent-turn/session-turn.js';
import type { AgentTurnSessionOptions } from '../../agent-turn/contracts.js';

export interface MiniAppAgentSessionPortsOptions {
  readonly records: {
    createInternalSession(input: InternalSessionCreateInput): Promise<SessionRecord>;
  };
  /** Writes through the lifecycle owner, so a model change reaches open views as `model-updated`. */
  readonly lifecycle: {
    mutateSession(sessionId: string, fields: SessionModelSwitchFields): Promise<unknown>;
  };
  readonly repository: {
    get(
      sessionId: string,
    ): Promise<
      | Pick<
          SessionRecord,
          | 'sessionId'
          | 'purpose'
          | 'sessionType'
          | 'sessionKind'
          | 'visibility'
          | 'archived'
          | 'status'
          | 'errorMessage'
          | 'title'
          | 'createdAtMs'
          | 'updatedAtMs'
          | 'agentName'
          | 'parentSessionId'
          | 'workspaceDir'
          | 'isDefaultWorkspace'
          | 'effectiveModel'
          | 'effectiveModelVariant'
          | 'effectiveModelThinking'
        >
      | undefined
    >;
    listPage(input: {
      readonly sessionType: 'root';
      readonly archived: false;
      readonly includeHidden: false;
      readonly excludeInternalDefaultRoots: true;
      readonly includeSessionKinds: readonly ['conversation'];
      readonly excludePurposePrefix: string;
      readonly limit: 50;
    }): Promise<{ readonly sessions: readonly Pick<SessionRecord,
      | 'sessionId' | 'purpose' | 'sessionType' | 'sessionKind' | 'visibility' | 'archived'
      | 'status' | 'errorMessage' | 'title' | 'createdAtMs' | 'updatedAtMs' | 'agentName'
      | 'parentSessionId' | 'workspaceDir' | 'isDefaultWorkspace' | 'effectiveModel'
      | 'effectiveModelVariant' | 'effectiveModelThinking'
    >[] }>;
  };
  readonly turns: Pick<TurnService, 'steer' | 'abort'>;
  readonly stream: {
    resume(input: ResumeSessionInput): AsyncIterableIterator<SessionFrame>;
  };
  readonly messages: {
    listTurn(sessionId: string, turnId: string): Promise<readonly DisplayMessageRecord[]>;
    listRecent(sessionId: string, options: { readonly limit: number; readonly role?: string }): Promise<readonly DisplayMessageRecord[]>;
  };
  /** Settling a questionnaire also starts its continuation turn. */
  readonly questionnaires: {
    getPending(input: {
      agentName: string;
      sessionId: string;
    }): Promise<AskQuestionnaireRequest | undefined>;
    reply(input: {
      agentName: string;
      requestId: string;
      answers: AskQuestionnaireReplyAnswer[];
      submittedAt: number;
    }): Promise<QuestionnaireReplyResult>;
  };
  readonly permissions: {
    listPending(): Promise<readonly { readonly requestId: string; readonly sessionId: string }[]>;
    reply(input: {
      requestIds: readonly string[];
      decision: MiniAppAgentPermissionDecision;
    }): Promise<{ readonly processed: readonly string[] }>;
  };
  readonly eventBus: {
    subscribe(subscriber: { next(event: GlobalEvent): void }): () => void;
  };
  readonly logger: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
  /** The runtime's current model configuration; read per call so default changes apply. */
  readonly modelConfig: () => LocalConversationRuntimeConfig;
  readonly models: { list(): Promise<readonly ModelProviderModelEntry[]> };
  /** `AgentApplication.list`, declared structurally to keep the agent module out of this seam. */
  readonly agents: {
    list(options: {
      readonly includeAliases: boolean;
    }): Promise<readonly { readonly canonicalViewName: string; readonly displayName?: string }[]>;
  };
  readonly nowMs: () => number;
}

/**
 * What a model switch writes: the selection, and the limits of the model it replaces cleared
 * (as the composer does), so they are not read as the new model's.
 */
type SessionModelSwitchFields = ReturnType<typeof sessionModelFields> & {
  readonly effectiveModelContextWindow: null;
  readonly effectiveModelMaxOutputTokens: null;
};

/** `injected: false` means the answer was saved but no continuation turn was started. */
interface QuestionnaireReplyResult {
  readonly ok: true;
  readonly injected?: boolean;
}

/** Upper bound on delegated-session hops walked to find a Mini App root. */
const MAX_MINIAPP_ROOT_HOPS = 16;

/** Binds the Mini App Agent gateway to SessionSystem records/stream and TurnSystem steering. */
export function createMiniAppAgentSessionPorts(
  options: MiniAppAgentSessionPortsOptions,
): MiniAppAgentSessionPorts {
  const turnSession = createAgentTurnSession(miniAppTurnSessionOptions(options));
  return {
    async createSession({
      pluginId,
      agentName,
      workspaceDir,
      createDir,
      model,
      contextWindow,
    }) {
      if (createDir) await mkdir(workspaceDir, { recursive: true });
      const session = await options.records.createInternalSession({
        agentName,
        sessionType: 'branch',
        sessionKind: 'conversation',
        visibility: 'hidden',
        // Ownership is this label: the record has no structured Mini App origin here, and the
        // prefix is what `getOwner` / `resolveMiniAppRoot` read back.
        purpose: `${MINIAPP_AGENT_PURPOSE_PREFIX}${pluginId}`,
        workspaceDir,
        isDefaultWorkspace: false,
        // Shown as the side-panel tab label; the gateway has no plugin display name.
        title: pluginId,
        ...sessionModelFields(model),
        ...(contextWindow === undefined ? {} : { effectiveModelContextWindow: contextWindow }),
      });
      return { sessionId: session.sessionId };
    },
    listModels: () => listModelOptions(options),
    listAgents: () => listAgentOptions(options),
    listUserSessions: async (): Promise<MiniAppAgentSessions> => {
      const page = await beforeDispatch(options, { stage: 'list-user-sessions', sessionId: 'user-sessions' }, () =>
        options.repository.listPage({
          sessionType: 'root',
          archived: false,
          includeHidden: false,
          excludeInternalDefaultRoots: true,
          includeSessionKinds: ['conversation'],
          excludePurposePrefix: MINIAPP_AGENT_PURPOSE_PREFIX,
          limit: 50,
        }),
      );
      return {
        sessions: page.sessions
          .filter((session) => session.sessionKind === 'conversation' && !session.purpose?.startsWith(MINIAPP_AGENT_PURPOSE_PREFIX))
          .map((session) => projectSessionContext(session)),
      };
    },
    readUserSession: async (sessionId) => {
      const session = await beforeDispatch(
        options,
        { stage: 'read-user-session', sessionId },
        () => options.repository.get(sessionId),
      );
      if (
        !session ||
        session.sessionType !== 'root' ||
        session.sessionKind !== 'conversation' ||
        session.visibility === 'hidden' ||
        session.archived ||
        session.purpose?.startsWith(MINIAPP_AGENT_PURPOSE_PREFIX)
      ) {
        return undefined;
      }
      const [latest] = await beforeDispatch(options, { stage: 'read-user-session-message', sessionId }, () =>
        options.messages.listRecent(sessionId, { limit: 1, role: 'assistant' }),
      );
      const lastAssistantText = latest ? assistantMessageText(latest) : undefined;
      return projectSessionContext(session, lastAssistantText);
    },
    readMiniAppSession: async (sessionId) => {
      const session = await beforeDispatch(
        options,
        { stage: 'read-miniapp-session', sessionId },
        () => options.repository.get(sessionId),
      );
      if (!session || !session.purpose?.startsWith(MINIAPP_AGENT_PURPOSE_PREFIX)) return undefined;
      const [latest] = await beforeDispatch(options, { stage: 'read-miniapp-session-message', sessionId }, () =>
        options.messages.listRecent(sessionId, { limit: 1, role: 'assistant' }),
      );
      return projectSessionContext(session, latest ? assistantMessageText(latest) : undefined);
    },
    defaultSessionModel: () => resolveDefaultSessionModel(options),
    resolveModel: async (requested) =>
      requested
        ? resolveRequestedModel(options, requested)
        : (await resolveDefaultSessionModel(options)).selection,
    readSessionModel: (sessionId) => readSessionModel(options, sessionId),
    setSessionModel: (sessionId, model) =>
      beforeDispatch(options, { stage: 'set-session-model', sessionId }, async () => {
        await options.lifecycle.mutateSession(sessionId, {
          ...sessionModelFields(model),
          effectiveModelContextWindow: null,
          effectiveModelMaxOutputTokens: null,
        });
      }),
    async getOwner(sessionId) {
      return pluginIdFromPurpose((await options.repository.get(sessionId))?.purpose);
    },
    resolveMiniAppRoot: (sessionId) => resolveMiniAppRoot(options, sessionId),
    resolveHostSession: (sessionId) =>
      beforeDispatch(options, { stage: 'resolve-host-session', sessionId }, async () => {
        const session = await options.repository.get(sessionId);
        if (!session) return undefined;
        const { agentName, workspaceDir, isDefaultWorkspace } = session;
        // Same reading as the session wire projection: only an explicit `true` is the default.
        const model = modelSelectionFromRecord(session);
        return {
          agentName,
          workspaceDir,
          isDefaultWorkspace: isDefaultWorkspace === true,
          model,
        };
      }),
    runTurn: (input) => turnSession.run(input),
    answerQuestion: (input) => turnSession.answer(input),
    replyPermission: (input) => replyMiniAppAgentPermission(options, input),
    subscribePermissionAsks: (listener) =>
      options.eventBus.subscribe({
        next(event) {
          if (event.type === 'permission.ask') listener(projectPermissionAsk(event.payload));
        },
      }),
  };
}

/** The Mini App adapter over the neutral turn seam: only its own error type is added. */
function miniAppTurnSessionOptions(
  options: MiniAppAgentSessionPortsOptions,
): AgentTurnSessionOptions {
  return {
    source: 'miniapp',
    repository: options.repository,
    turns: options.turns,
    stream: options.stream,
    messages: options.messages,
    questionnaires: options.questionnaires,
    logger: options.logger,
    modelConfig: options.modelConfig,
    nowMs: options.nowMs,
    createError: (code, message, retryable = false, reason) =>
      new MiniAppAgentError(code as MiniAppAgentErrorCode, message, retryable, reason as MiniAppAgentBusyReason),
    isError: (error) => error instanceof MiniAppAgentError,
  };
}

function projectSessionContext(
  session: Pick<SessionRecord,
    | 'sessionId' | 'status' | 'errorMessage' | 'title' | 'createdAtMs' | 'updatedAtMs'
    | 'agentName' | 'workspaceDir' | 'isDefaultWorkspace' | 'effectiveModel'
    | 'effectiveModelVariant' | 'effectiveModelThinking'
  >,
  lastAssistantText?: string,
): MiniAppAgentSessionContext {
  const model = modelSelectionFromRecord(session);
  return {
    sessionId: session.sessionId,
    agent: session.agentName,
    workspaceDir: session.workspaceDir,
    isDefaultWorkspace: session.isDefaultWorkspace === true,
    createdAtMs: session.createdAtMs,
    updatedAtMs: session.updatedAtMs,
    ...(session.title ? { title: session.title } : {}),
    status:
      session.status === 'started'
        ? 'running'
        : session.status === 'error'
          ? 'error'
          : session.status === 'aborted' || session.status === 'interrupted'
            ? 'aborted'
            : 'idle',
    ...(session.status === 'error' && session.errorMessage
      ? { error: { message: session.errorMessage } }
      : {}),
    ...(model ? { model } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
  };
}

function assistantMessageText(message: DisplayMessageRecord): string | undefined {
  const content = message.msg_content ?? message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const value = (part as Record<string, unknown>).text;
    return typeof value === 'string' ? [value] : [];
  }).join('');
  return text || undefined;
}

type RunTurnInput = Parameters<MiniAppAgentSessionPorts['runTurn']>[0];
type AnswerQuestionInput = Parameters<MiniAppAgentSessionPorts['answerQuestion']>[0];
type RunTurnResult = Omit<MiniAppAgentRunResult, 'sessionId'>;
type PendingQuestion = NonNullable<MiniAppAgentRunResult['pendingQuestion']>;

async function listModelOptions(
  options: MiniAppAgentSessionPortsOptions,
): ReturnType<MiniAppAgentSessionPorts['listModels']> {
  return (await options.models.list())
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      providerId: entry.providerId,
      modelId: entry.modelId,
      displayName: entry.displayName,
      ...(entry.supportedVariants?.length ? { variants: [...entry.supportedVariants] } : {}),
      ...(entry.effortOptions?.length
        ? {
            thinking: {
              efforts: [...entry.effortOptions],
              ...(entry.defaultEffort ? { default: entry.defaultEffort } : {}),
            },
          }
        : {}),
    }));
}

async function listAgentOptions(
  options: MiniAppAgentSessionPortsOptions,
): ReturnType<MiniAppAgentSessionPorts['listAgents']> {
  const byName = new Map<string, { name: string; displayName: string; primary: boolean }>();
  for (const agent of await options.agents.list({ includeAliases: false })) {
    const name = agent.canonicalViewName;
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      displayName: agent.displayName || name,
      primary: name === MINIAPP_AGENT_NAME,
    });
  }
  return [...byName.values()];
}

/** Same validation as the composer. */
async function resolveRequestedModel(
  options: MiniAppAgentSessionPortsOptions,
  requested: MiniAppAgentModelSelection,
): Promise<MiniAppAgentModelSelection> {
  return (await resolveSelection(options, requested)).selection;
}

/**
 * The runtime default as the turn system would run it with no session model: the global
 * variant, thinking and context window apply (`variant: ''` is thinking off and is kept).
 */
async function resolveDefaultSessionModel(
  options: MiniAppAgentSessionPortsOptions,
): ReturnType<MiniAppAgentSessionPorts['defaultSessionModel']> {
  return resolveDefaultAgentTurnModel(miniAppTurnSessionOptions(options));
}

async function resolveSelection(
  options: MiniAppAgentSessionPortsOptions,
  requested: Parameters<typeof resolveAgentTurnModel>[1],
): Promise<{ readonly selection: MiniAppAgentModelSelection; readonly contextWindow?: number }> {
  return resolveAgentTurnModel(miniAppTurnSessionOptions(options), requested);
}

function readSessionModel(
  options: MiniAppAgentSessionPortsOptions,
  sessionId: string,
): Promise<MiniAppAgentModelSelection | undefined> {
  return beforeDispatch(options, { stage: 'read-session-model', sessionId }, async () => {
    const record = await options.repository.get(sessionId);
    return record ? modelSelectionFromRecord(record) : undefined;
  });
}

/**
 * The model a turn is about to be dispatched with. A record predating the model snapshot has
 * none stored, so the turn runs on the runtime default, which is what it is reported as.
 */
async function modelBeforeDispatch(
  options: MiniAppAgentSessionPortsOptions,
  sessionId: string,
): Promise<MiniAppAgentModelSelection> {
  const recorded = await readSessionModel(options, sessionId);
  return (
    recorded ??
    beforeDispatch(options, { stage: 'resolve-default-model', sessionId }, async () => {
      return (await resolveDefaultSessionModel(options)).selection;
    })
  );
}

/** A failure before anything was dispatched: nothing ran, so the caller may retry. */
async function beforeDispatch<T>(
  options: MiniAppAgentSessionPortsOptions,
  context: { readonly stage: string; readonly sessionId: string; readonly requestId?: string },
  lookup: () => Promise<T>,
): Promise<T> {
  try {
    return await lookup();
  } catch (error) {
    if (error instanceof MiniAppAgentError) throw error;
    options.logger.warn(
      { ...context, ...errorFields(error) },
      'Mini App Agent lookup failed before dispatch',
    );
    throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent session is unavailable', true);
  }
}

/** Unknown outcome: something may have run or been recorded, so a blind retry is not safe. */
function outcomeUnknown(message: string): MiniAppAgentError {
  return new MiniAppAgentError('AGENT_OUTCOME_UNKNOWN', message);
}

function errorFields(error: unknown): { readonly errorName: string; readonly error: string } {
  return error instanceof Error
    ? { errorName: error.name, error: error.message }
    : { errorName: typeof error, error: String(error) };
}

/** Walks delegated child sessions up to the Mini App session that owns them (bounded, cycle-safe). */
async function resolveMiniAppRoot(
  options: MiniAppAgentSessionPortsOptions,
  sessionId: string,
): ReturnType<MiniAppAgentSessionPorts['resolveMiniAppRoot']> {
  const seen = new Set<string>();
  let current: string | null | undefined = sessionId;
  while (current) {
    if (seen.has(current) || seen.size > MAX_MINIAPP_ROOT_HOPS) {
      options.logger.warn(
        { sessionId, hops: seen.size, cycle: seen.has(current) },
        'Mini App root lookup stopped at the hop limit or a cycle',
      );
      return undefined;
    }
    seen.add(current);
    const record = await options.repository.get(current);
    const pluginId = pluginIdFromPurpose(record?.purpose);
    if (pluginId) return { rootSessionId: current, pluginId };
    current = record?.parentSessionId;
  }
  return undefined;
}

/**
 * The owning plugin of a Mini App session, read from the `purpose` label this module writes.
 *
 * The shipped generation stored a structured `miniAppOrigin` on the session record; this build's
 * record has no such field, and `purpose` is the persisted label it already carries.
 */
function pluginIdFromPurpose(purpose: string | undefined): string | undefined {
  if (!purpose || !purpose.startsWith(MINIAPP_AGENT_PURPOSE_PREFIX)) return undefined;
  const pluginId = purpose.slice(MINIAPP_AGENT_PURPOSE_PREFIX.length);
  return pluginId.length > 0 ? pluginId : undefined;
}

async function replyMiniAppAgentPermission(
  options: MiniAppAgentSessionPortsOptions,
  input: Parameters<MiniAppAgentSessionPorts['replyPermission']>[0],
): Promise<'processed' | 'skipped'> {
  // Nothing is decided until `permissions.reply`; a failed lookup before it may be retried.
  const decidable = await beforeDispatch(
    options,
    { stage: 'reply-lookup', sessionId: input.sessionId, requestId: input.requestId },
    () => isRaisedUnderSameRoot(options, input),
  );
  if (!decidable) return 'skipped';
  const result = await options.permissions.reply({
    requestIds: [input.requestId],
    decision: input.decision,
  });
  return result.processed.includes(input.requestId) ? 'processed' : 'skipped';
}

/** Approval request ids are global; only a request raised under the same root may be decided. */
async function isRaisedUnderSameRoot(
  options: MiniAppAgentSessionPortsOptions,
  input: { readonly sessionId: string; readonly requestId: string },
): Promise<boolean> {
  const root = await resolveMiniAppRoot(options, input.sessionId);
  if (!root) return false;
  const pending = await options.permissions.listPending();
  const request = pending.find((entry) => entry.requestId === input.requestId);
  if (!request) return false;
  // Raised by the named session or the root itself: its root is already known.
  if (request.sessionId === input.sessionId || request.sessionId === root.rootSessionId) {
    return true;
  }
  const owner = await resolveMiniAppRoot(options, request.sessionId);
  return owner?.rootSessionId === root.rootSessionId;
}

function projectPermissionAsk(
  payload: Extract<GlobalEvent, { type: 'permission.ask' }>['payload'],
): MiniAppPermissionAsk {
  return {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    toolName: payload.toolName,
    reason: payload.reason,
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    ...(payload.toolInput === undefined ? {} : { toolInput: payload.toolInput }),
  };
}
