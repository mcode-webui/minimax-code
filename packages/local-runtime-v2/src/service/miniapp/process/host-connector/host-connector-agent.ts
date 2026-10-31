import {
  isMiniAppAgentPermissionDecision,
  isMiniAppAgentQuestionMode,
  readMiniAppAgentAnswers,
} from '@mavis/shared/miniapp-surface';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';

import {
  isMiniAppAgentBusyReason,
  MINIAPP_AGENT_ERROR_CODES,
  MiniAppAgentError,
  type MiniAppAgentAgents,
  type MiniAppAgentAnswerInput,
  type MiniAppAgentBusyReason,
  type MiniAppAgentCaller,
  type MiniAppAgentErrorCode,
  type MiniAppAgentGateway,
  type MiniAppAgentModels,
  type MiniAppAgentModelSelection,
  type MiniAppAgentReplyInput,
  type MiniAppAgentRunEvent,
  type MiniAppAgentRunInput,
  type MiniAppAgentRunOptions,
  type MiniAppAgentRunResult,
  type MiniAppAgentSessionContext,
  type MiniAppAgentSessions,
} from '../../agent/contracts.js';
import { readMiniAppAgentModelSelection } from '../../agent/model-selection.js';
import type { MiniAppAgentPolicy } from '../../contracts.js';
import { HostConnectorProtocolError } from './host-connector-errors.js';
import {
  type AgentRequestMethod,
  hasExactKeys,
  isBoundedIdentifier,
  isRecord,
} from './host-connector-wire.js';

/** Child-side `context.agent`; mirrors `MiniAppAgentClient` in the authoring API. */
export interface MiniAppAgentClient {
  run(
    input: MiniAppAgentRunInput,
    options?: MiniAppAgentRunOptions,
  ): Promise<MiniAppAgentRunResult>;
  reply(input: MiniAppAgentReplyInput): Promise<void>;
  answer(
    input: MiniAppAgentAnswerInput,
    options?: MiniAppAgentRunOptions,
  ): Promise<MiniAppAgentRunResult>;
  models(): Promise<MiniAppAgentModels>;
  agents(): Promise<MiniAppAgentAgents>;
  sessions(): Promise<MiniAppAgentSessions>;
  session(sessionId: string): Promise<MiniAppAgentSessionContext | undefined>;
  create(input?: { readonly agent?: string }): Promise<{ readonly sessionId: string }>;
}

interface MiniAppAgentWireError {
  readonly code: MiniAppAgentErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Only on `BUSY`. */
  readonly reason?: MiniAppAgentBusyReason;
}

const AGENT_ERROR_MESSAGES: Readonly<Record<MiniAppAgentErrorCode, string>> = {
  NOT_PERMITTED: 'Mini App Agent access is not permitted',
  BUSY: 'Mini App Agent is busy',
  SESSION_NOT_FOUND: 'Mini App Agent session was not found',
  INVALID_ARGUMENTS: 'Mini App Agent arguments are invalid',
  AGENT_UNAVAILABLE: 'Mini App Agent is unavailable',
  REQUEST_CANCELLED: 'Mini App Agent run was cancelled',
  AGENT_OUTCOME_UNKNOWN: 'Mini App Agent outcome is unknown after dispatch',
  REQUEST_NOT_FOUND: 'Mini App Agent request was not found or already settled',
};

const AGENT_ERROR_CODES: ReadonlySet<string> = new Set(MINIAPP_AGENT_ERROR_CODES);

/** Event frames buffered per run before later ones are dropped; the terminal frame is never dropped. */
const MAX_QUEUED_AGENT_EVENTS = 256;

/** Events the child must act on; never dropped for the queue bound. */
const INTERACTION_EVENT_TYPES: ReadonlySet<MiniAppAgentRunEvent['type']> = new Set([
  'permission.requested',
  'question.requested',
]);

export function agentClientError(
  code: MiniAppAgentErrorCode,
  retryable = false,
): MiniAppAgentError {
  return new MiniAppAgentError(code, AGENT_ERROR_MESSAGES[code], retryable);
}

export function encodeAgentRunParams(input: unknown): Record<string, unknown> {
  if (
    !isRecord(input) ||
    typeof input.text !== 'string' ||
    (input.sessionId !== undefined && !isBoundedIdentifier(input.sessionId)) ||
    (input.agent !== undefined && !isBoundedIdentifier(input.agent))
  ) {
    throw agentClientError('INVALID_ARGUMENTS');
  }
  return {
    text: input.text,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...encodeAgentModel(input.model),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  };
}

function encodeAgentModel(model: unknown): { readonly model?: MiniAppAgentModelSelection } {
  if (model === undefined) return {};
  const selection = readMiniAppAgentModelSelection(model);
  if (!selection) throw agentClientError('INVALID_ARGUMENTS');
  return { model: selection };
}

/** A present `model` must decode; the child client already refuses malformed ones. */
function decodeAgentModel(params: Record<string, unknown>): {
  readonly model?: MiniAppAgentModelSelection;
} {
  if (!('model' in params)) return {};
  const selection = readMiniAppAgentModelSelection(params.model);
  if (!selection) throw new HostConnectorProtocolError('Host Connector request is invalid');
  return { model: selection };
}

export function encodeAgentCreateParams(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (!isRecord(input) || (input.agent !== undefined && !isBoundedIdentifier(input.agent))) {
    throw agentClientError('INVALID_ARGUMENTS');
  }
  return input.agent === undefined ? {} : { agent: input.agent };
}

export function encodeAgentSessionParams(sessionId: unknown): Record<string, unknown> {
  if (!isBoundedIdentifier(sessionId)) throw agentClientError('INVALID_ARGUMENTS');
  return { sessionId };
}

function decodeAgentCreateParams(params: Record<string, unknown> | undefined): {
  readonly agent?: string;
} {
  if (
    !params ||
    !hasOptionalKeys(params, [], ['agent']) ||
    !isOptional(params, 'agent', isBoundedIdentifier)
  ) {
    throw new HostConnectorProtocolError('Host Connector request is invalid');
  }
  return typeof params.agent === 'string' ? { agent: params.agent } : {};
}

function decodeAgentRunParams(params: Record<string, unknown> | undefined): {
  readonly params: MiniAppAgentRunInput;
  readonly observe: boolean;
} {
  if (
    !params ||
    !hasOptionalKeys(params, ['text'], ['sessionId', 'observe', 'model', 'agent']) ||
    typeof params.text !== 'string' ||
    !isOptional(params, 'sessionId', isBoundedIdentifier) ||
    !isOptional(params, 'agent', isBoundedIdentifier) ||
    !isOptional(params, 'observe', isBoolean)
  ) {
    throw new HostConnectorProtocolError('Host Connector request is invalid');
  }
  return {
    params: {
      text: params.text,
      ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
      ...decodeAgentModel(params),
      ...(typeof params.agent === 'string' ? { agent: params.agent } : {}),
    },
    observe: params.observe === true,
  };
}

export function encodeAgentReplyParams(input: unknown): Record<string, unknown> {
  if (
    !isRecord(input) ||
    !isBoundedIdentifier(input.sessionId) ||
    !isBoundedIdentifier(input.requestId) ||
    !isMiniAppAgentPermissionDecision(input.decision)
  ) {
    throw agentClientError('INVALID_ARGUMENTS');
  }
  return { sessionId: input.sessionId, requestId: input.requestId, decision: input.decision };
}

function decodeAgentReplyParams(
  params: Record<string, unknown> | undefined,
): MiniAppAgentReplyInput {
  if (
    !params ||
    !hasExactKeys(params, ['sessionId', 'requestId', 'decision']) ||
    !isBoundedIdentifier(params.sessionId) ||
    !isBoundedIdentifier(params.requestId) ||
    !isMiniAppAgentPermissionDecision(params.decision)
  ) {
    throw new HostConnectorProtocolError('Host Connector request is invalid');
  }
  return { sessionId: params.sessionId, requestId: params.requestId, decision: params.decision };
}

export function encodeAgentAnswerParams(input: unknown): Record<string, unknown> {
  const answers = isRecord(input) ? readMiniAppAgentAnswers(input.answers) : null;
  if (
    !isRecord(input) ||
    !answers ||
    !isBoundedIdentifier(input.sessionId) ||
    !isBoundedIdentifier(input.requestId)
  ) {
    throw agentClientError('INVALID_ARGUMENTS');
  }
  return {
    sessionId: input.sessionId,
    requestId: input.requestId,
    answers,
    ...encodeAgentModel(input.model),
  };
}

function decodeAgentAnswerParams(params: Record<string, unknown> | undefined): {
  readonly params: MiniAppAgentAnswerInput;
  readonly observe: boolean;
} {
  const answers = params ? readMiniAppAgentAnswers(params.answers) : null;
  if (
    !params ||
    !answers ||
    !hasOptionalKeys(params, ['sessionId', 'requestId', 'answers'], ['observe', 'model']) ||
    !isBoundedIdentifier(params.sessionId) ||
    !isBoundedIdentifier(params.requestId) ||
    !isOptional(params, 'observe', isBoolean)
  ) {
    throw new HostConnectorProtocolError('Host Connector request is invalid');
  }
  return {
    params: {
      sessionId: params.sessionId,
      requestId: params.requestId,
      answers,
      ...decodeAgentModel(params),
    },
    observe: params.observe === true,
  };
}

function isAgentRunResult(value: unknown): value is MiniAppAgentRunResult {
  return (
    isRecord(value) &&
    hasOptionalKeys(
      value,
      ['sessionId', 'status'],
      ['turnId', 'model', 'text', 'error', 'pendingQuestion'],
    ) &&
    isBoundedIdentifier(value.sessionId) &&
    isOptional(value, 'turnId', isBoundedIdentifier) &&
    isOptional(value, 'model', isModelSelection) &&
    isRunStatus(value.status) &&
    isOptional(value, 'text', isString) &&
    isOptional(value, 'error', isResultError) &&
    isOptional(value, 'pendingQuestion', isPendingQuestion)
  );
}

/**
 * Child side: decodes the terminal result of any `agent.*` request. `agent.reply` settles with
 * `result: null`; anything else is a protocol error.
 */
export function decodeAgentResult(method: AgentRequestMethod, value: unknown): unknown {
  const decoded = AGENT_RESULT_DECODERS[method](value);
  if (decoded) return decoded.value;
  throw new HostConnectorProtocolError('Mini App Agent result is invalid');
}

type AgentResultDecoder = (value: unknown) => { readonly value: unknown } | undefined;

const AGENT_RESULT_DECODERS: Readonly<Record<AgentRequestMethod, AgentResultDecoder>> = {
  'agent.reply': (value) => (value === null ? { value: undefined } : undefined),
  'agent.models': (value) => (isAgentModels(value) ? { value } : undefined),
  'agent.agents': (value) => (isAgentAgents(value) ? { value } : undefined),
  'agent.sessions': (value) => (isAgentSessions(value) ? { value } : undefined),
  'agent.session': (value) =>
    value === null || value === undefined || isAgentSession(value)
      ? { value: value ?? undefined }
      : undefined,
  'agent.create': (value) =>
    isRecord(value) && hasExactKeys(value, ['sessionId']) && isBoundedIdentifier(value.sessionId)
      ? { value: { sessionId: value.sessionId } }
      : undefined,
  'agent.run': decodeAgentTurnResult,
  'agent.answer': decodeAgentTurnResult,
};

function decodeAgentTurnResult(value: unknown): { readonly value: unknown } | undefined {
  return isAgentRunResult(value) ? { value: projectAgentResult(value) } : undefined;
}

function isModelSelection(value: unknown): boolean {
  return readMiniAppAgentModelSelection(value) !== null;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function isModelOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOptionalKeys(value, ['providerId', 'modelId', 'displayName'], ['variants', 'thinking']) &&
    isString(value.providerId) &&
    isString(value.modelId) &&
    isString(value.displayName) &&
    isOptional(value, 'variants', isStringArray) &&
    isOptional(value, 'thinking', isThinkingOption)
  );
}

function isThinkingOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOptionalKeys(value, ['efforts'], ['default']) &&
    isStringArray(value.efforts) &&
    isOptional(value, 'default', isString)
  );
}

function isAgentModels(value: unknown): value is MiniAppAgentModels {
  return (
    isRecord(value) &&
    hasOptionalKeys(value, ['models', 'default'], ['host']) &&
    Array.isArray(value.models) &&
    value.models.every(isModelOption) &&
    isModelSelection(value.default) &&
    isOptional(value, 'host', isModelSelection)
  );
}

function isAgentAgents(value: unknown): value is MiniAppAgentAgents {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['agents']) &&
    Array.isArray(value.agents) &&
    value.agents.every(
      (agent) =>
        isRecord(agent) &&
        hasExactKeys(agent, ['name', 'displayName', 'primary']) &&
        isString(agent.name) &&
        isString(agent.displayName) &&
        isBoolean(agent.primary),
    )
  );
}

function isAgentSessions(value: unknown): value is MiniAppAgentSessions {
  return isRecord(value) && hasExactKeys(value, ['sessions']) && Array.isArray(value.sessions) &&
    value.sessions.every(isAgentSession);
}

function isAgentSession(value: unknown): value is MiniAppAgentSessionContext {
  return isRecord(value) && isBoundedIdentifier(value.sessionId) &&
    typeof value.agent === 'string' && typeof value.workspaceDir === 'string' &&
    typeof value.isDefaultWorkspace === 'boolean' && typeof value.createdAtMs === 'number' &&
    typeof value.updatedAtMs === 'number' &&
    (value.status === 'idle' || value.status === 'running' || value.status === 'error' || value.status === 'aborted');
}

/**
 * Child side: unknown `type`s (a newer Host) are ignored; a known type with a bad shape is a
 * protocol error.
 */
export function decodeAgentRunEvent(value: unknown): MiniAppAgentRunEvent | undefined {
  const event = copyAgentRunEvent(value);
  if (event) return event;
  if (isRecord(value) && typeof value.type === 'string' && !agentEventShape(value.type)) {
    return undefined;
  }
  throw new HostConnectorProtocolError('Mini App Agent event is invalid');
}

interface AgentEventShape {
  /** Keys besides `type`, `sessionId` and `turnId`. */
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  /** `turnId` is required unless set. */
  readonly turnId?: 'optional' | 'absent';
  /** `sessionId` is required unless set. */
  readonly sessionIdOptional?: true;
  readonly valid: (value: Record<string, unknown>) => boolean;
}

const isString = (field: unknown): field is string => typeof field === 'string';
const isBoolean = (field: unknown): field is boolean => typeof field === 'boolean';
const TEXT_EVENT: AgentEventShape = { required: ['text'], valid: (value) => isString(value.text) };

const AGENT_EVENT_SHAPES: Readonly<Record<MiniAppAgentRunEvent['type'], AgentEventShape>> = {
  'run.queued': {
    required: ['position'],
    turnId: 'absent',
    sessionIdOptional: true,
    valid: (value) =>
      typeof value.position === 'number' &&
      Number.isSafeInteger(value.position) &&
      value.position >= 1,
  },
  'turn.started': { required: ['model'], valid: (value) => isModelSelection(value.model) },
  'text.delta': TEXT_EVENT,
  'message.committed': TEXT_EVENT,
  'tool.started': { required: ['name'], valid: (value) => isString(value.name) },
  'tool.finished': {
    required: ['name', 'ok'],
    valid: (value) => isString(value.name) && typeof value.ok === 'boolean',
  },
  'permission.requested': {
    required: ['requestId', 'toolName', 'reason'],
    optional: ['toolInput'],
    turnId: 'optional',
    valid: (value) =>
      isBoundedIdentifier(value.requestId) &&
      isString(value.toolName) &&
      isString(value.reason) &&
      isOptional(value, 'toolInput', isString),
  },
  'question.requested': {
    required: ['requestId', 'mode', 'request'],
    turnId: 'optional',
    valid: (value) =>
      isBoundedIdentifier(value.requestId) &&
      isMiniAppAgentQuestionMode(value.mode) &&
      isQuestionnaireRequest(value.request),
  },
  'turn.finished': {
    required: ['status'],
    optional: ['text', 'error'],
    valid: (value) =>
      isRunStatus(value.status) &&
      isOptional(value, 'text', isString) &&
      isOptional(value, 'error', isResultError),
  },
};

function hasAgentEventEnvelope(value: Record<string, unknown>, shape: AgentEventShape): boolean {
  const sessionKey = shape.sessionIdOptional ? 'optional' : 'required';
  const turnKey = shape.turnId ?? 'required';
  const required = [
    'type',
    ...(sessionKey === 'required' ? ['sessionId'] : []),
    ...(turnKey === 'required' ? ['turnId'] : []),
    ...shape.required,
  ];
  const optional = [
    ...(sessionKey === 'optional' ? ['sessionId'] : []),
    ...(turnKey === 'optional' ? ['turnId'] : []),
    ...(shape.optional ?? []),
  ];
  return (
    isOptional(value, 'sessionId', isBoundedIdentifier) &&
    isOptional(value, 'turnId', isBoundedIdentifier) &&
    hasOptionalKeys(value, required, optional)
  );
}

function agentEventShape(type: string): AgentEventShape | undefined {
  return Object.prototype.hasOwnProperty.call(AGENT_EVENT_SHAPES, type)
    ? AGENT_EVENT_SHAPES[type as MiniAppAgentRunEvent['type']]
    : undefined;
}

/**
 * Exact-key copy of a known event; anything else is `undefined` so the Host never sends it.
 * An `undefined` field counts as absent, as it would after JSON encoding.
 */
function copyAgentRunEvent(raw: unknown): MiniAppAgentRunEvent | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined;
  const value = Object.fromEntries(Object.entries(raw).filter(([, field]) => field !== undefined));
  const shape = agentEventShape(raw.type);
  if (!shape || !hasAgentEventEnvelope(value, shape) || !shape.valid(value)) return undefined;
  // Every field is now a validated primitive except `error`, whose exact keys were checked,
  // and the questionnaire `request`, whose size the response frame bound limits.
  return {
    ...value,
    ...(isRecord(value.error) ? { error: { ...value.error } } : {}),
    ...(raw.type === 'turn.started' ? { model: readMiniAppAgentModelSelection(value.model) } : {}),
  } as MiniAppAgentRunEvent;
}

export function decodeAgentWireError(value: unknown): MiniAppAgentError {
  if (
    !isRecord(value) ||
    !hasOptionalKeys(value, ['code', 'message', 'retryable'], ['reason']) ||
    !AGENT_ERROR_CODES.has(String(value.code)) ||
    typeof value.message !== 'string' ||
    typeof value.retryable !== 'boolean' ||
    !isOptional(
      value,
      'reason',
      (reason) => value.code === 'BUSY' && isMiniAppAgentBusyReason(reason),
    )
  ) {
    throw new HostConnectorProtocolError('Mini App Agent error is invalid');
  }
  return new MiniAppAgentError(
    value.code as MiniAppAgentErrorCode,
    value.message,
    value.retryable,
    value.reason as MiniAppAgentBusyReason | undefined,
  );
}

interface HostAgentSessionInput {
  readonly gateway: MiniAppAgentGateway | undefined;
  readonly identity: {
    readonly pluginId: string;
    readonly processGeneration: string;
    readonly agentPolicy?: MiniAppAgentPolicy;
  };
  readonly lifecycle: {
    gate(): 'open' | 'unavailable' | 'service-restarted';
    isActive(): boolean;
  };
  readonly makeInvocationId: () => string;
  readonly maxFrameBytes: number;
  readonly enqueueResponse: (value: unknown) => Promise<void>;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

type AgentShortRequest =
  | { readonly method: 'agent.reply'; readonly params: MiniAppAgentReplyInput }
  | { readonly method: 'agent.models' | 'agent.agents' | 'agent.sessions' }
  | { readonly method: 'agent.session'; readonly params: { readonly sessionId: string } }
  | { readonly method: 'agent.create'; readonly params: { readonly agent?: string } };

type AgentRequest = AgentTurnRequest | AgentShortRequest;

/** Malformed params are a protocol error, raised before any response is written. */
function decodeAgentRequest(
  method: AgentRequestMethod,
  params: Record<string, unknown> | undefined,
): AgentRequest {
  if (method === 'agent.reply') return { method, params: decodeAgentReplyParams(params) };
  if (method === 'agent.create') return { method, params: decodeAgentCreateParams(params) };
  if (method === 'agent.models' || method === 'agent.agents' || method === 'agent.sessions') {
    if (!params || !hasExactKeys(params, [])) {
      throw new HostConnectorProtocolError('Host Connector request is invalid');
    }
    return { method };
  }
  if (method === 'agent.session') {
    if (!params || !hasExactKeys(params, ['sessionId']) || !isBoundedIdentifier(params.sessionId)) {
      throw new HostConnectorProtocolError('Host Connector request is invalid');
    }
    return { method, params: { sessionId: params.sessionId } };
  }
  if (method === 'agent.answer') return { method, ...decodeAgentAnswerParams(params) };
  return { method, ...decodeAgentRunParams(params) };
}

/** Host-side `agent.*` handling for one generation-bound connector session. */
export function createHostAgentSession(input: HostAgentSessionInput) {
  const { identity, lifecycle } = input;
  let releaseArena: (() => void) | undefined;
  let released = false;
  const admissionError = (): MiniAppAgentWireError | undefined => {
    const gate = lifecycle.gate();
    if (gate === 'service-restarted') return agentWireError('AGENT_UNAVAILABLE', true);
    return gate === 'open' && lifecycle.isActive()
      ? undefined
      : agentWireError('AGENT_UNAVAILABLE');
  };
  const respondError = (id: string, error: MiniAppAgentWireError) =>
    input.enqueueResponse({ v: 1, id, ok: false, error });
  /** Policy and lifecycle admission; answers the request itself when refused. */
  const admit = async (id: string): Promise<MiniAppAgentGateway | undefined> => {
    const gateway = input.gateway;
    const refusal =
      !gateway || identity.agentPolicy?.kind !== 'allowlist'
        ? agentWireError('NOT_PERMITTED')
        : admissionError();
    if (refusal) await respondError(id, refusal);
    return refusal ? undefined : gateway;
  };

  return {
    /** Registers the arena once; a released session never re-registers. */
    activate(): void {
      const policy = identity.agentPolicy;
      if (released || releaseArena || !input.gateway || policy?.kind !== 'allowlist') return;
      releaseArena = input.gateway.registerArena({
        pluginId: identity.pluginId,
        processGeneration: identity.processGeneration,
        policy,
      });
    },
    release(): void {
      released = true;
      const release = releaseArena;
      releaseArena = undefined;
      release?.();
    },
    /**
     * Runs one `agent.*` request. `agent.run` / `agent.answer` follow a turn (admitted receipt,
     * events, terminal); the others are short and mark dispatch so a quiesce drains them.
     */
    async handle(
      frame: {
        readonly id: string;
        readonly method: AgentRequestMethod;
        readonly params?: Record<string, unknown>;
      },
      signal: AbortSignal,
      markDispatched: () => void,
    ): Promise<void> {
      const request = decodeAgentRequest(frame.method, frame.params);
      const gateway = await admit(frame.id);
      if (!gateway) return;
      if (isShortAgentRequest(request)) {
        await settleShortHostAgent({
          id: frame.id,
          operation: () => startShortAgentOperation(gateway, processCaller(identity), request),
          signal,
          markDispatched,
          respond: input.enqueueResponse,
        });
        return;
      }
      const invocationId = input.makeInvocationId();
      await input.enqueueResponse({ v: 1, id: frame.id, receipt: 'admitted', invocationId });
      const after = admissionError();
      if (after) {
        await respondError(frame.id, after);
        return;
      }
      await followHostAgentTurn(input, { id: frame.id, gateway, request, signal });
    },
  };
}

function isShortAgentRequest(request: AgentRequest): request is AgentShortRequest {
  return request.method !== 'agent.run' && request.method !== 'agent.answer';
}

async function startShortAgentOperation(
  gateway: MiniAppAgentGateway,
  caller: MiniAppAgentCaller,
  request: AgentShortRequest,
): Promise<unknown> {
  switch (request.method) {
    case 'agent.reply':
      return gateway.reply(caller, request.params);
    case 'agent.models':
      return projectAgentModels(await gateway.models(caller));
    case 'agent.agents':
      return projectAgentAgents(await gateway.agents(caller));
    case 'agent.sessions':
      return gateway.sessions(caller);
    case 'agent.session':
      return gateway.session(caller, request.params);
    case 'agent.create':
      return projectAgentCreate(await gateway.create(caller, request.params));
  }
}

/**
 * Short `agent.*` requests: no receipt or events; the connector request timeout applies.
 * `agent.reply` settles with `null`.
 */
async function settleShortHostAgent(short: {
  readonly id: string;
  readonly operation: () => Promise<unknown>;
  readonly signal: AbortSignal;
  readonly markDispatched: () => void;
  readonly respond: (value: unknown) => Promise<void>;
}): Promise<void> {
  try {
    const operation = short.operation();
    short.markDispatched();
    const result = await raceAgentSignal(operation, short.signal);
    await short.respond({ v: 1, id: short.id, ok: true, result: result ?? null });
  } catch (error) {
    const wireError =
      error instanceof MiniAppAgentError
        ? projectAgentError(error)
        : agentWireError('AGENT_OUTCOME_UNKNOWN');
    await short.respond({ v: 1, id: short.id, ok: false, error: wireError });
  }
}

async function followHostAgentTurn(
  input: HostAgentSessionInput,
  turn: {
    readonly id: string;
    readonly gateway: MiniAppAgentGateway;
    readonly request: AgentTurnRequest;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const events = createAgentEventQueue({
    maxFrameBytes: input.maxFrameBytes,
    enqueueResponse: input.enqueueResponse,
    onRetainedDrop: (event, reason) => reportRetainedDrop(input, turn, event, reason),
  });
  const terminal = await runHostAgent({
    ...turn,
    identity: input.identity,
    notify: events.notify,
  });
  if (events.dropped() > 0) {
    input.logger?.warn(
      {
        pluginId: input.identity.pluginId,
        processGeneration: input.identity.processGeneration,
        droppedEvents: events.dropped(),
      },
      'Mini App Agent run dropped event frames',
    );
  }
  await input.enqueueResponse(terminal);
}

type RetainedDropReason = 'oversized' | 'serialize_failed';

interface AgentEventFrame {
  readonly v: 1;
  readonly id: string;
  readonly event: MiniAppAgentRunEvent;
}

/**
 * A dropped interaction frame leaves the turn waiting on an ask the child never saw, so it is
 * reported now rather than after the turn; a dropped approval is denied so the turn can go on.
 */
function reportRetainedDrop(
  input: HostAgentSessionInput,
  turn: { readonly id: string; readonly gateway: MiniAppAgentGateway },
  event: MiniAppAgentRunEvent,
  reason: RetainedDropReason,
): void {
  if (event.type !== 'permission.requested' && event.type !== 'question.requested') return;
  const fields = {
    pluginId: input.identity.pluginId,
    processGeneration: input.identity.processGeneration,
    sessionId: event.sessionId,
    requestId: event.requestId,
    type: event.type,
    reason,
  };
  input.logger?.warn(fields, 'Mini App Agent run dropped an interaction event frame');
  if (event.type === 'permission.requested')
    denyDroppedPermission(input, turn.gateway, event, fields);
}

/**
 * Detached on purpose: the terminal frame must not wait on a reply that takes no signal.
 * Runs after the Gateway's listener callback returns, since that callback is delivering
 * the very ask being denied.
 */
function denyDroppedPermission(
  input: HostAgentSessionInput,
  gateway: MiniAppAgentGateway,
  event: Extract<MiniAppAgentRunEvent, { type: 'permission.requested' }>,
  fields: Record<string, unknown>,
): void {
  detach(
    (async () => {
      // Leave the Gateway's listener callback before replying to the ask it is delivering.
      await Promise.resolve();
      try {
        await gateway.reply(processCaller(input.identity), {
          sessionId: event.sessionId,
          requestId: event.requestId,
          decision: 'deny',
        });
      } catch (error) {
        input.logger?.warn(
          { ...fields, errorName: error instanceof Error ? error.name : typeof error },
          'Mini App Agent could not deny a dropped permission request',
        );
      }
    })(),
  );
}

/**
 * Per-run event notifier. Oversized, non-JSON or over-budget event frames are dropped and
 * counted; the terminal frame still settles the run. `retained` frames (an approval or a
 * questionnaire the child must answer) skip the budget, since dropping one stalls the turn;
 * if one cannot be sent at all, `onRetainedDrop` hears about it immediately.
 */
function createAgentEventQueue(input: {
  readonly maxFrameBytes: number;
  readonly enqueueResponse: (value: unknown) => Promise<void>;
  readonly onRetainedDrop: (event: MiniAppAgentRunEvent, reason: RetainedDropReason) => void;
}): {
  notify(frame: AgentEventFrame, retained: boolean): Promise<void> | undefined;
  dropped(): number;
} {
  let queuedEvents = 0;
  let droppedEvents = 0;
  const drop = () => {
    droppedEvents += 1;
    return undefined;
  };
  return {
    notify(frame, retained) {
      if (!retained && queuedEvents >= MAX_QUEUED_AGENT_EVENTS) return drop();
      const unsendable = unsendableFrameReason(frame, input.maxFrameBytes);
      if (unsendable) {
        if (retained) input.onRetainedDrop(frame.event, unsendable);
        return drop();
      }
      queuedEvents += 1;
      return settleQueuedEvent(input.enqueueResponse(frame), () => {
        queuedEvents -= 1;
      });
    },
    dropped: () => droppedEvents,
  };
}

function unsendableFrameReason(
  frame: AgentEventFrame,
  maxFrameBytes: number,
): RetainedDropReason | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(frame);
  } catch {
    return 'serialize_failed';
  }
  if (json === undefined) return 'serialize_failed';
  return Buffer.byteLength(json) > maxFrameBytes ? 'oversized' : undefined;
}

/** `observe` is set when the child passed `onEvent`; without it the turn runs unobserved. */
type AgentTurnRequest =
  | {
      readonly method: 'agent.run';
      readonly params: MiniAppAgentRunInput;
      readonly observe: boolean;
    }
  | {
      readonly method: 'agent.answer';
      readonly params: MiniAppAgentAnswerInput;
      readonly observe: boolean;
    };

function processCaller(identity: {
  readonly pluginId: string;
  readonly processGeneration: string;
}): MiniAppAgentCaller {
  return {
    pluginId: identity.pluginId,
    processGeneration: identity.processGeneration,
    source: 'process',
  };
}

async function runHostAgent(run: {
  readonly id: string;
  readonly gateway: MiniAppAgentGateway;
  readonly identity: { readonly pluginId: string; readonly processGeneration: string };
  readonly request: AgentTurnRequest;
  readonly signal: AbortSignal;
  readonly notify: (frame: AgentEventFrame, retained: boolean) => Promise<void> | undefined;
}): Promise<unknown> {
  let terminal = false;
  let notifications: Promise<void> | undefined;
  // The Gateway denies approvals of a run nobody listens to, so only an observing child gets one.
  const onEvent = (event: MiniAppAgentRunEvent) => {
    if (terminal) return;
    const projected = copyAgentRunEvent(event);
    if (!projected) return;
    notifications =
      run.notify(
        { v: 1, id: run.id, event: projected },
        INTERACTION_EVENT_TYPES.has(projected.type),
      ) ?? notifications;
  };
  const options: MiniAppAgentRunOptions = {
    signal: run.signal,
    ...(run.request.observe ? { onEvent } : {}),
  };
  const caller = processCaller(run.identity);
  try {
    const result =
      run.request.method === 'agent.run'
        ? await run.gateway.run(caller, run.request.params, options)
        : await run.gateway.answer(caller, run.request.params, options);
    return { v: 1, id: run.id, ok: true, result: projectAgentResult(result) };
  } catch (error) {
    return { v: 1, id: run.id, ok: false, error: hostAgentWireError(error, run.signal) };
  } finally {
    terminal = true;
    // The shared write queue already orders notifications before the terminal frame.
    await notifications;
  }
}

async function settleQueuedEvent(write: Promise<void>, settled: () => void): Promise<void> {
  try {
    await ignoreRejection(write);
  } finally {
    settled();
  }
}

async function ignoreRejection(operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch {
    // Transport loss is reported by the owning session's channel binding.
  }
}

function hostAgentWireError(error: unknown, signal: AbortSignal): MiniAppAgentWireError {
  if (error instanceof MiniAppAgentError) return projectAgentError(error);
  return signal.aborted
    ? agentWireError('REQUEST_CANCELLED')
    : agentWireError('AGENT_OUTCOME_UNKNOWN');
}

/**
 * `gateway.reply` takes no signal; a timeout or teardown stops waiting for it, but the
 * decision may still apply, so the caller reports an unknown outcome.
 */
async function raceAgentSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function agentWireError(
  code: MiniAppAgentErrorCode,
  retryable = false,
  reason?: MiniAppAgentBusyReason,
): MiniAppAgentWireError {
  return { code, message: AGENT_ERROR_MESSAGES[code], retryable, ...(reason ? { reason } : {}) };
}

/** Host-side messages may carry internal detail; the child only gets the fixed text. */
function projectAgentError(error: MiniAppAgentError): MiniAppAgentWireError {
  const reason =
    error.code === 'BUSY' && isMiniAppAgentBusyReason(error.reason) ? error.reason : undefined;
  return agentWireError(error.code, error.retryable, reason);
}

function projectAgentResult(result: MiniAppAgentRunResult): MiniAppAgentRunResult {
  const model = readMiniAppAgentModelSelection(result.model);
  return {
    sessionId: result.sessionId,
    ...(result.turnId ? { turnId: result.turnId } : {}),
    ...(model ? { model } : {}),
    status: result.status,
    ...(result.text === undefined ? {} : { text: result.text }),
    ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
    ...(result.pendingQuestion
      ? {
          pendingQuestion: {
            requestId: result.pendingQuestion.requestId,
            mode: result.pendingQuestion.mode,
            request: result.pendingQuestion.request,
          },
        }
      : {}),
  };
}

/** Whitelist copies: a field the runtime adds later must not break the child's strict decoder. */
function projectAgentModels(result: MiniAppAgentModels): MiniAppAgentModels {
  const defaultModel = readMiniAppAgentModelSelection(result.default);
  const host = readMiniAppAgentModelSelection(result.host);
  if (!defaultModel) throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Default model is invalid');
  return {
    models: result.models.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      ...(model.variants ? { variants: [...model.variants] } : {}),
      ...(model.thinking
        ? {
            thinking: {
              efforts: [...model.thinking.efforts],
              ...(model.thinking.default === undefined ? {} : { default: model.thinking.default }),
            },
          }
        : {}),
    })),
    default: defaultModel,
    ...(host ? { host } : {}),
  };
}

function projectAgentAgents(result: MiniAppAgentAgents): MiniAppAgentAgents {
  return {
    agents: result.agents.map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      primary: agent.primary,
    })),
  };
}

function projectAgentCreate(result: { readonly sessionId: string }): {
  readonly sessionId: string;
} {
  return { sessionId: result.sessionId };
}

function isRunStatus(value: unknown): value is MiniAppAgentRunResult['status'] {
  return value === 'finished' || value === 'error' || value === 'aborted';
}

function isPendingQuestion(
  value: unknown,
): value is NonNullable<MiniAppAgentRunResult['pendingQuestion']> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['requestId', 'mode', 'request']) &&
    isBoundedIdentifier(value.requestId) &&
    isMiniAppAgentQuestionMode(value.mode) &&
    isQuestionnaireRequest(value.request)
  );
}

/** Envelope check only; the step list is passed through as the Host chat renders it. */
function isQuestionnaireRequest(value: unknown): value is AskQuestionnaireRequest {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    isBoundedIdentifier(value.id) &&
    Array.isArray(value.steps)
  );
}

function isOptional(
  value: Record<string, unknown>,
  key: string,
  check: (field: unknown) => boolean,
): boolean {
  return !(key in value) || check(value[key]);
}

function isResultError(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'message']) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function hasOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return hasExactKeys(value, [...required, ...optional.filter((key) => key in value)]);
}

/** Transient strong refs so `detach` visibly consumes its argument. */
const detached = new Set<Promise<void>>();

/**
 * Explicitly consume a fire-and-forget promise whose errors it already owns.
 *
 * Local copy: this build has no `service/channel-system/settle.ts`, and the same helper is already
 * hoisted this way in `service/miniapp/agent/gateway.ts`.
 */
function detach(promise: Promise<void>): void {
  detached.add(promise);
  queueMicrotask(() => detached.delete(promise));
}
