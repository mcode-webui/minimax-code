import { randomUUID } from 'node:crypto';
import { format } from 'node:util';

import {
  ConnectorGatewayError,
  type HostProcessConnectorGateway,
  type ConnectorToolHandle,
} from '../../../host-connector-system/index.js';
import type {
  MiniAppAgentGateway,
  MiniAppAgentRunEvent,
} from '../../agent/contracts.js';
import type {
  MiniAppHostConnectorSession,
  MiniAppHostConnectorSessionFactory,
  MiniAppIpcMessage,
  MiniAppIpcTransport,
} from '../../contracts.js';
import {
  bindMiniAppIpcChannel,
  encodeMiniAppIpcMessage,
  sendMiniAppIpcMessage,
} from '../node-runtime/ipc-transport.js';
import {
  agentClientError,
  createHostAgentSession,
  decodeAgentResult,
  decodeAgentRunEvent,
  decodeAgentWireError,
  encodeAgentAnswerParams,
  encodeAgentCreateParams,
  encodeAgentReplyParams,
  encodeAgentRunParams,
  encodeAgentSessionParams,
  type MiniAppAgentClient,
} from './host-connector-agent.js';
import {
  createHostConnectorGatewayRelease,
  HostConnectorSessionLifecycle,
} from './host-connector-quiesce.js';
import {
  HostConnectorCancelledError,
  type HostConnectorDiagnostic,
  type HostConnectorDiagnosticIssue,
  type HostConnectorDisposition,
  HostConnectorError,
  HostConnectorProtocolError,
  HostConnectorRequestTimeoutError,
  type HostConnectorWireError as WireError,
  isSafeHostConnectorDiagnosticConstraint,
  isSafeHostConnectorDiagnosticPath,
  normalizeGatewayError,
  providerWireError,
  serviceRestartedWireError,
  staleToolWireError,
  unavailableWireError,
} from './host-connector-errors.js';

type HostConnectorListedTool = Awaited<ReturnType<HostConnectorClient['list']>>['tools'][number];

import {
  type ChildRequestMethod,
  hasExactKeys,
  hasHostConnectorRequestCapacity,
  type HostConnectorJson,
  type HostConnectorJsonObject,
  type HostConnectorToolRef,
  isAgentMethod,
  isAgentShortMethod,
  isAgentTurnMethod,
  isBoundedIdentifier,
  isRecord,
  isRequestId,
  REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES,
} from './host-connector-wire.js';

export type { MiniAppAgentClient };
export { hasHostConnectorRequestCapacity, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES };

export interface HostConnectorClient {
  list(options?: { readonly signal?: AbortSignal }): Promise<{
    readonly tools: readonly {
      readonly toolRef: HostConnectorToolRef;
      readonly provider: string;
      readonly name: string;
      readonly description?: string;
      readonly inputSchema: HostConnectorJson;
      readonly outputSchema?: HostConnectorJson;
    }[];
    readonly partial: boolean;
  }>;
  call(
    toolRef: HostConnectorToolRef,
    arguments_: HostConnectorJsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly invocationId: string; readonly value: HostConnectorJson }>;
}

interface RequestFrame {
  readonly id: string;
  readonly method: ChildRequestMethod | 'connector.cancel' | 'agent.cancel';
  readonly params?: Record<string, unknown>;
}

interface PendingChildRequest {
  readonly method: ChildRequestMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
  written: boolean;
  invocationId?: string;
  abortCleanup?: () => void;
}

export interface MiniAppHostConnectorRuntimeClient {
  readonly client: HostConnectorClient;
  readonly agent: MiniAppAgentClient;
  close(): void;
}

/** Child-side implementation injected into `start(context)`. */
export function createMiniAppHostConnectorRuntimeClient(options: {
  readonly transport: MiniAppIpcTransport;
  readonly onFatal?: (error: Error) => void;
}): MiniAppHostConnectorRuntimeClient {
  const pending = new Map<string, PendingChildRequest>();
  let nextRequestId = 1n;
  let closed = false;
  let writeTail = Promise.resolve();

  const detach = bindMiniAppIpcChannel(options.transport, {
    type: 'miniapp:connector',
    maxBytes: RESPONSE_MAX_BYTES,
    onMessage: handleResponse,
    onFatal: fatal,
  });

  function fatal(error: unknown): void {
    if (closed) return;
    closed = true;
    const normalized =
      error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed');
    for (const [id, entry] of pending) {
      entry.abortCleanup?.();
      entry.reject(disconnectedError(id, entry));
    }
    pending.clear();
    detach();
    options.onFatal?.(normalized);
  }

  function handleResponse(value: unknown): void {
    if (!isRecord(value) || value.v !== 1 || !isRequestId(value.id)) {
      throw new HostConnectorProtocolError('Host Connector response envelope is invalid');
    }
    const entry = pending.get(value.id);
    if (!entry) throw new HostConnectorProtocolError('Host Connector response id is unknown');
    if (value.receipt === 'admitted') {
      recordAdmissionReceipt(value, entry);
      return;
    }
    if ('event' in value) {
      deliverAgentEvent(value, entry);
      return;
    }
    const outcome = decodeChildOutcome(entry, value);
    settle(value.id, entry, outcome.error, outcome.result);
  }

  function settle(id: string, entry: PendingChildRequest, error?: Error, result?: unknown): void {
    pending.delete(id);
    entry.abortCleanup?.();
    if (error) entry.reject(error);
    else entry.resolve(result);
  }

  function send(
    method: ChildRequestMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onEvent?: (event: MiniAppAgentRunEvent) => void,
  ): Promise<unknown> {
    if (closed) return Promise.reject(childUnavailableError(method));
    if (signal?.aborted) return Promise.reject(childCancelledError(method));
    if (!hasHostConnectorRequestCapacity(method, pending.values())) {
      return Promise.reject(childUnavailableError(method, true));
    }
    const id = allocateRequestId();
    let frame: MiniAppIpcMessage;
    try {
      frame = encodeMiniAppIpcMessage(
        'miniapp:connector',
        { v: 1, id, method, params },
        REQUEST_MAX_BYTES,
      );
    } catch {
      return Promise.reject(childEncodeError(method));
    }
    return new Promise((resolve, reject) => {
      const entry: PendingChildRequest = {
        method,
        resolve,
        reject,
        written: false,
        ...(onEvent ? { onEvent } : {}),
      };
      pending.set(id, entry);
      const onAbort = () => {
        if (!entry.written) {
          settle(id, entry, childCancelledError(method));
          return;
        }
        enqueueWrite(async () => {
          if (pending.has(id)) {
            await sendMiniAppIpcMessage(
              options.transport,
              encodeMiniAppIpcMessage(
                'miniapp:connector',
                { v: 1, id, method: isAgentMethod(method) ? 'agent.cancel' : 'connector.cancel' },
                REQUEST_MAX_BYTES,
              ),
            );
          }
        });
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }
      enqueueWrite(async () => {
        if (!pending.has(id)) return;
        await sendMiniAppIpcMessage(options.transport, frame, () => {
          entry.written = true;
        });
        if (signal?.aborted) onAbort();
      });
    });
  }

  function enqueueWrite(operation: () => Promise<void>): void {
    writeTail = runChildWrite(writeTail, operation, fatal);
  }

  function allocateRequestId(): string {
    if (nextRequestId > 18_446_744_073_709_551_615n) {
      throw new HostConnectorProtocolError('Host Connector request ids exhausted');
    }
    const value = nextRequestId.toString();
    nextRequestId += 1n;
    return value;
  }

  const client: HostConnectorClient = Object.freeze({
    async list(callOptions?: Parameters<HostConnectorClient['list']>[0]) {
      return (await send('connector.list', {}, callOptions?.signal)) as Awaited<
        ReturnType<HostConnectorClient['list']>
      >;
    },
    async call(
      toolRef: HostConnectorToolRef,
      arguments_: HostConnectorJsonObject,
      callOptions?: Parameters<HostConnectorClient['call']>[2],
    ) {
      if (!isBoundedIdentifier(toolRef) || !isRecord(arguments_)) {
        throw invalidArgumentsError();
      }
      return (await send(
        'connector.call',
        { toolRef, arguments: arguments_ },
        callOptions?.signal,
      )) as Awaited<ReturnType<HostConnectorClient['call']>>;
    },
  });

  type AgentTurnOptions = Parameters<MiniAppAgentClient['run']>[1];
  type AgentTurnResult = Awaited<ReturnType<MiniAppAgentClient['run']>>;
  async function sendAgentTurn(
    method: 'agent.run' | 'agent.answer',
    params: Record<string, unknown>,
    turnOptions: AgentTurnOptions,
  ): Promise<AgentTurnResult> {
    const onEvent = typeof turnOptions?.onEvent === 'function' ? turnOptions.onEvent : undefined;
    // Without `observe` the Host runs the turn with no listener, so its approvals are denied.
    const wireParams = onEvent ? { ...params, observe: true } : params;
    return (await send(method, wireParams, turnOptions?.signal, onEvent)) as AgentTurnResult;
  }

  const agent: MiniAppAgentClient = Object.freeze({
    async run(input: Parameters<MiniAppAgentClient['run']>[0], runOptions?: AgentTurnOptions) {
      return sendAgentTurn('agent.run', encodeAgentRunParams(input), runOptions);
    },
    async reply(input: Parameters<MiniAppAgentClient['reply']>[0]) {
      await send('agent.reply', encodeAgentReplyParams(input));
    },
    async answer(
      input: Parameters<MiniAppAgentClient['answer']>[0],
      answerOptions?: AgentTurnOptions,
    ) {
      return sendAgentTurn('agent.answer', encodeAgentAnswerParams(input), answerOptions);
    },
    async models() {
      return (await send('agent.models', {})) as Awaited<ReturnType<MiniAppAgentClient['models']>>;
    },
    async agents() {
      return (await send('agent.agents', {})) as Awaited<ReturnType<MiniAppAgentClient['agents']>>;
    },
    async sessions() {
      return (await send('agent.sessions', {})) as Awaited<ReturnType<MiniAppAgentClient['sessions']>>;
    },
    async session(sessionId: string) {
      return (await send('agent.session', encodeAgentSessionParams(sessionId))) as Awaited<ReturnType<MiniAppAgentClient['session']>>;
    },
    async create(input?: Parameters<MiniAppAgentClient['create']>[0]) {
      return (await send('agent.create', encodeAgentCreateParams(input))) as Awaited<
        ReturnType<MiniAppAgentClient['create']>
      >;
    },
  });

  return {
    client,
    agent,
    close() {
      fatal(new HostConnectorProtocolError('Host Connector client closed'));
    },
  };
}

async function runChildWrite(
  previous: Promise<void>,
  operation: () => Promise<void>,
  fatal: (error: unknown) => void,
): Promise<void> {
  try {
    await previous;
    await operation();
  } catch (error) {
    fatal(error);
  }
}

interface ActiveHostRequest {
  readonly method: ChildRequestMethod;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly agent: boolean;
  execution?: Promise<void>;
  dispatched: boolean;
}

interface RegisteredActiveHostRequest extends ActiveHostRequest {
  readonly complete: () => void;
}

function requireHostRequestAdmission(
  id: string,
  method: ChildRequestMethod,
  highestRequestId: bigint,
  requests: ReadonlyMap<string, ActiveHostRequest>,
): bigint {
  const numericId = BigInt(id);
  if (
    numericId <= highestRequestId ||
    !hasHostConnectorRequestCapacity(method, requests.values())
  ) {
    throw new HostConnectorProtocolError('Host Connector request ordering is invalid');
  }
  return numericId;
}

/** Agent turns never hold a cutover open; they settle through their own terminal frame. */
function abortAgentRequests(requests: ReadonlyMap<string, ActiveHostRequest>): void {
  for (const request of requests.values()) {
    if (request.agent) {
      request.controller.abort(new HostConnectorCancelledError('Mini App Agent run cancelled'));
    }
  }
}

function markHostRequestDispatched(requests: Map<string, ActiveHostRequest>, id: string): void {
  const request = requests.get(id);
  if (request) request.dispatched = true;
}

function dispatchedRequestCompletions(
  requests: ReadonlyMap<string, ActiveHostRequest>,
): readonly Promise<void>[] {
  return [...requests.values()]
    .filter((request) => request.dispatched)
    .map((request) => request.completion);
}

function requestCompletions(
  requests: ReadonlyMap<string, ActiveHostRequest>,
): readonly Promise<void>[] {
  return [...requests.values()].map((request) => request.completion);
}

function registerActiveHostRequest(
  requests: Map<string, ActiveHostRequest>,
  id: string,
  controller: AbortController,
  method: ChildRequestMethod,
): RegisteredActiveHostRequest {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const request: RegisteredActiveHostRequest = {
    method,
    controller,
    completion,
    agent: isAgentTurnMethod(method),
    dispatched: false,
    complete: () => {
      requests.delete(id);
      resolveCompletion();
    },
  };
  requests.set(id, request);
  return request;
}

interface HostSessionFactoryOptions {
  readonly gateway: HostProcessConnectorGateway;
  readonly agentGateway?: MiniAppAgentGateway;
  readonly makeToolRef?: () => string;
  readonly makeInvocationId?: () => string;
  readonly graceTimeoutMs?: number;
  readonly settleTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

/** Host-side generation-bound session backed only by the ConnectorGateway seam. */
export function createMiniAppHostConnectorSessionFactory(
  options: HostSessionFactoryOptions,
): MiniAppHostConnectorSessionFactory {
  return {
    create(input) {
      options.gateway.registerHostProcess({
        pluginId: input.pluginId,
        processGeneration: input.processGeneration,
      });
      return createHostConnectorSession(options, input);
    },
  };
}

function createHostConnectorSession(
  options: HostSessionFactoryOptions,
  input: Parameters<MiniAppHostConnectorSessionFactory['create']>[0],
): MiniAppHostConnectorSession {
  const requests = new Map<string, ActiveHostRequest>();
  let highestRequestId = 0n;
  let refs = new Map<string, ConnectorToolHandle>();
  let refsByHandle = new Map<ConnectorToolHandle, string>();
  const lifecycle = new HostConnectorSessionLifecycle();
  let handshakeStarted = false;
  let fatalReported = false;
  let publishResponses = true;
  let writeTail = Promise.resolve();
  let retirePromise: Promise<void> | undefined;
  const releaseGateway = createHostConnectorGatewayRelease(options.gateway, input);
  const agent = createHostAgentSession({
    gateway: options.agentGateway,
    identity: input,
    lifecycle,
    makeInvocationId: () => requireInvocationId(makeInvocationId()),
    maxFrameBytes: RESPONSE_MAX_BYTES,
    enqueueResponse: (value: unknown) => enqueueResponse(value),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const releaseBindings = () => {
    releaseGateway();
    agent.release();
  };
  const makeToolRef = options.makeToolRef ?? randomUUID;
  const makeInvocationId = options.makeInvocationId ?? randomUUID;
  const timeouts = hostSessionTimeouts(options);
  const detach = bindMiniAppIpcChannel(input.transport, {
    type: 'miniapp:connector',
    maxBytes: REQUEST_MAX_BYTES,
    onMessage(value) {
      if (!handshakeStarted) {
        throw new HostConnectorProtocolError('Host Connector request preceded handshake');
      }
      handleFrame(value);
    },
    onFatal: fail,
  });
  function handleFrame(value: unknown): void {
    const frame = decodeRequest(value);
    if (frame.method === 'connector.cancel' || frame.method === 'agent.cancel') {
      const request = requests.get(frame.id);
      if (request) {
        request.controller.abort(new HostConnectorCancelledError('Request cancelled'));
      } else if (BigInt(frame.id) > highestRequestId) {
        throw new HostConnectorProtocolError('Host Connector cancel id is unknown');
      }
      return;
    }
    highestRequestId = requireHostRequestAdmission(
      frame.id,
      frame.method,
      highestRequestId,
      requests,
    );
    const controller = new AbortController();
    const request = registerActiveHostRequest(requests, frame.id, controller, frame.method);
    request.execution = runTimedHostRequest({
      frame,
      controller,
      timeoutMs: isAgentTurnMethod(frame.method) ? undefined : timeouts.requestMs,
      dispatch,
      fail,
      complete: request.complete,
    });
  }

  async function dispatch(frame: RequestFrame, signal: AbortSignal): Promise<void> {
    if (isAgentMethod(frame.method)) {
      const markDispatched = () => markHostRequestDispatched(requests, frame.id);
      return agent.handle({ ...frame, method: frame.method }, signal, markDispatched);
    }
    const gate = lifecycle.gate();
    if (gate !== 'open') {
      await respondError(
        frame.id,
        gate === 'service-restarted' ? serviceRestartedWireError() : unavailableWireError(),
      );
      return;
    }
    if (frame.method === 'connector.list') {
      if (!frame.params || !hasExactKeys(frame.params, [])) throw protocolParamsError();
      await list(frame.id, signal);
      return;
    }
    const callParams = decodeCallParams(frame.params);
    if (!lifecycle.isActive()) {
      await respondError(frame.id, unavailableWireError());
      return;
    }
    await call(frame.id, callParams.toolRef, callParams.arguments, signal);
  }

  async function list(id: string, signal: AbortSignal): Promise<void> {
    try {
      const inventory = await listHostConnectorTools({
        gateway: options.gateway,
        pluginId: input.pluginId,
        processGeneration: input.processGeneration,
        providers: input.providers,
        signal,
        makeToolRef,
        previousRefs: refsByHandle,
        markDispatched: () => markHostRequestDispatched(requests, id),
      });
      refs = inventory.refs;
      refsByHandle = inventory.refsByHandle;
      await respond(id, { tools: inventory.tools, partial: inventory.partial });
    } catch (error) {
      await respondError(id, normalizeGatewayError(error));
    }
  }

  async function call(
    id: string,
    toolRef: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await dispatchHostConnectorCall({
      id,
      toolRef,
      arguments: arguments_,
      signal,
      refs,
      gateway: options.gateway,
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
      makeInvocationId,
      admissionGate: () => lifecycle.gate(),
      markDispatched: () => markHostRequestDispatched(requests, id),
      enqueueResponse,
      respond,
      respondError,
    });
  }

  const respond = (id: string, result: unknown) => enqueueResponse({ v: 1, id, ok: true, result });
  const respondError = (id: string, error: WireError) =>
    enqueueResponse({ v: 1, id, ok: false, error });

  function enqueueResponse(value: unknown): Promise<void> {
    const operation = writeHostResponse(
      writeTail,
      () => publishResponses && !lifecycle.isRetired() && input.transport.connected !== false,
      input.transport,
      value,
    );
    writeTail = ignoreFailure(operation);
    return operation;
  }

  async function retire(): Promise<void> {
    if (!lifecycle.beginRetirement()) return;
    abortAgentRequests(requests);
    const pending = requestCompletions(requests);
    if (!(await settleWithin(Promise.allSettled(pending), timeouts.graceMs))) {
      publishResponses = false;
      for (const request of requests.values()) request.controller.abort();
    }
    await settleWithin(
      Promise.allSettled([...requestCompletions(requests), writeTail]),
      timeouts.settleMs,
    );
    lifecycle.markRetired();
    refs.clear();
    refsByHandle.clear();
    detach();
    releaseBindings();
  }

  function fail(error: unknown): void {
    if (fatalReported || lifecycle.isRetired()) return;
    fatalReported = true;
    lifecycle.beginRetirement();
    publishResponses = false;
    refs.clear();
    refsByHandle.clear();
    for (const request of requests.values()) request.controller.abort();
    detach();
    releaseBindings();
    retirePromise ??= retire();
    input.onFatal(
      error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed'),
    );
  }

  return {
    startHandshake() {
      if (!lifecycle.isRetired()) handshakeStarted = true;
    },
    activate() {
      lifecycle.activate();
      agent.activate();
    },
    beginQuiesce(quiesceInput) {
      return lifecycle.beginQuiesce({
        pending: dispatchedRequestCompletions(requests),
        deadlineMs: quiesceInput.deadlineMs,
        signal: quiesceInput.signal,
        // Agent turns are aborted only once the switch is final: a `busy` or resumed quiesce
        // leaves the old generation running, and its in-flight turns must survive that.
        commit: () => {
          abortAgentRequests(requests);
          refs.clear();
          refsByHandle.clear();
          releaseBindings();
        },
      });
    },
    retire() {
      retirePromise ??= retire();
      return retirePromise;
    },
    close() {
      publishResponses = false;
      for (const request of requests.values()) request.controller.abort();
      refs.clear();
      refsByHandle.clear();
      detach();
      releaseBindings();
      retirePromise ??= retire();
      return retirePromise;
    },
  };
}

async function dispatchHostConnectorCall(input: {
  readonly id: string;
  readonly toolRef: string;
  readonly arguments: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly refs: ReadonlyMap<string, ConnectorToolHandle>;
  readonly gateway: HostProcessConnectorGateway;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly makeInvocationId: () => string;
  readonly admissionGate: () => 'open' | 'unavailable' | 'service-restarted';
  readonly markDispatched: () => void;
  readonly enqueueResponse: (value: unknown) => Promise<void>;
  readonly respond: (id: string, result: unknown) => Promise<void>;
  readonly respondError: (id: string, error: WireError) => Promise<void>;
}): Promise<void> {
  const handle = input.refs.get(input.toolRef);
  if (!handle) {
    await input.respondError(input.id, staleToolWireError());
    return;
  }
  let invocationId: string | undefined;
  let gatewayPromiseObtained = false;
  try {
    invocationId = requireInvocationId(input.makeInvocationId());
    await input.enqueueResponse({ v: 1, id: input.id, receipt: 'admitted', invocationId });
    const gate = input.admissionGate();
    if (gate !== 'open') {
      await input.respondError(
        input.id,
        gate === 'service-restarted'
          ? serviceRestartedWireError(invocationId)
          : { ...unavailableWireError(), invocationId },
      );
      return;
    }
    const call = beginHostConnectorToolCall({
      gateway: input.gateway,
      handle,
      arguments: input.arguments,
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
      clientRequestId: input.id,
      invocationId,
      signal: input.signal,
    });
    gatewayPromiseObtained = true;
    input.markDispatched();
    const result = await completeHostConnectorToolCall(call, input.signal, invocationId);
    if (result.isError) {
      await input.respondError(input.id, providerWireError(invocationId));
      return;
    }
    await input.respond(input.id, { invocationId, value: result.value });
  } catch (error) {
    await input.respondError(
      input.id,
      normalizeGatewayError(error, invocationId, gatewayPromiseObtained),
    );
  }
}

function hostSessionTimeouts(options: HostSessionFactoryOptions) {
  return {
    graceMs: Math.max(1, options.graceTimeoutMs ?? 4_000),
    settleMs: Math.max(1, options.settleTimeoutMs ?? 1_000),
    requestMs: Math.max(1, options.requestTimeoutMs ?? 30_000),
  };
}


async function runTimedHostRequest(input: {
  readonly frame: RequestFrame;
  readonly controller: AbortController;
  /** Absent for `agent.run` / `agent.answer`: the Agent turn, not the IPC session, owns completion. */
  readonly timeoutMs: number | undefined;
  readonly dispatch: (frame: RequestFrame, signal: AbortSignal) => Promise<void>;
  readonly fail: (error: unknown) => void;
  readonly complete: () => void;
}): Promise<void> {
  const timer =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            input.controller.abort(
              new HostConnectorRequestTimeoutError('Host Connector request timed out'),
            ),
          input.timeoutMs,
        );
  timer?.unref();
  try {
    await input.dispatch(input.frame, input.controller.signal);
  } catch (error) {
    input.fail(error);
  } finally {
    clearTimeout(timer);
    input.complete();
  }
}


async function listHostConnectorTools(input: {
  readonly gateway: HostProcessConnectorGateway;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly providers: readonly string[];
  readonly signal: AbortSignal;
  readonly makeToolRef: () => string;
  readonly previousRefs: ReadonlyMap<ConnectorToolHandle, string>;
  readonly markDispatched: () => void;
}) {
  const operation = input.gateway.list({
    providerAllowlist: input.providers,
    caller: {
      kind: 'host-process',
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
    },
    signal: input.signal,
  });
  input.markDispatched();
  const inventory = await raceWithSignal(operation, input.signal);
  const refs = new Map<string, ConnectorToolHandle>();
  const refsByHandle = new Map<ConnectorToolHandle, string>();
  const tools: HostConnectorListedTool[] = [];
  let partial = inventory.partial;
  for (const tool of inventory.tools) {
    try {
      tools.push(
        decodeInventoryTool({
          tool,
          refs,
          refsByHandle,
          previousRefs: input.previousRefs,
          makeToolRef: input.makeToolRef,
        }),
      );
    } catch (error) {
      if (!(error instanceof HostConnectorProtocolError)) throw error;
      partial = true;
    }
  }
  return { tools, refs, refsByHandle, partial };
}

function decodeInventoryTool(input: {
  readonly tool: Awaited<ReturnType<HostProcessConnectorGateway['list']>>['tools'][number];
  readonly refs: Map<string, ConnectorToolHandle>;
  readonly refsByHandle: Map<ConnectorToolHandle, string>;
  readonly previousRefs: ReadonlyMap<ConnectorToolHandle, string>;
  readonly makeToolRef: () => string;
}): HostConnectorListedTool {
  const { tool } = input;
  const inputSchema = parseJson(tool.inputSchemaJson, RESPONSE_MAX_BYTES);
  const outputSchema = tool.outputSchemaJson
    ? parseJson(tool.outputSchemaJson, RESPONSE_MAX_BYTES)
    : undefined;
  const previousRef = input.previousRefs.get(tool.handle);
  const toolRef = previousRef ?? mintToolRef(tool.handle, input.refs, input.makeToolRef);
  if (previousRef && input.refs.has(toolRef)) {
    throw new HostConnectorProtocolError('Host Connector tool reference collided');
  }
  if (previousRef) input.refs.set(toolRef, tool.handle);
  input.refsByHandle.set(tool.handle, toolRef);
  return {
    toolRef: toolRef as HostConnectorToolRef,
    provider: tool.provider,
    name: tool.providerToolName,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function beginHostConnectorToolCall(input: {
  readonly gateway: HostProcessConnectorGateway;
  readonly handle: ConnectorToolHandle;
  readonly arguments: Record<string, unknown>;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly clientRequestId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}): ReturnType<HostProcessConnectorGateway['call']> {
  return input.gateway.call({
    handle: input.handle,
    arguments: input.arguments,
    caller: {
      kind: 'host-process',
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
    },
    hostRequest: {
      clientRequestId: input.clientRequestId,
      invocationId: input.invocationId,
    },
    signal: input.signal,
  });
}

async function completeHostConnectorToolCall(
  operation: ReturnType<HostProcessConnectorGateway['call']>,
  signal: AbortSignal,
  invocationId: string,
) {
  const result = await raceWithSignal(operation, signal);
  let value: HostConnectorJson;
  try {
    value = result.isError ? null : parseJson(result.resultJson ?? 'null', RESPONSE_MAX_BYTES);
  } catch {
    throw new ConnectorGatewayError(
      'CONNECTOR_RESULT_INVALID',
      'Connector result was invalid after dispatch',
      'unknown_after_dispatch',
      invocationId,
    );
  }
  return {
    isError: result.isError,
    value,
  };
}

function mintToolRef(
  handle: ConnectorToolHandle,
  target: Map<string, ConnectorToolHandle>,
  makeToolRef: () => string,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const ref = makeToolRef();
    if (isBoundedIdentifier(ref) && !target.has(ref)) {
      target.set(ref, handle);
      return ref;
    }
  }
  throw new HostConnectorProtocolError('Host Connector could not mint a tool ref');
}

async function writeHostResponse(
  previous: Promise<void>,
  shouldPublish: () => boolean,
  transport: MiniAppIpcTransport,
  value: unknown,
): Promise<void> {
  await previous;
  if (!shouldPublish()) return;
  await sendMiniAppIpcMessage(
    transport,
    encodeMiniAppIpcMessage('miniapp:connector', value, RESPONSE_MAX_BYTES),
  );
}

async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let rejectOnAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort(signal.reason);
  try {
    signal.addEventListener('abort', onAbort, { once: true });
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The owning state machine reports or intentionally suppresses transport failure.
  }
}

function decodeCallParams(params: Record<string, unknown> | undefined): {
  readonly toolRef: string;
  readonly arguments: Record<string, unknown>;
} {
  if (
    !params ||
    !hasExactKeys(params, ['toolRef', 'arguments']) ||
    !isBoundedIdentifier(params.toolRef) ||
    !isRecord(params.arguments)
  ) {
    throw protocolParamsError();
  }
  return { toolRef: params.toolRef, arguments: params.arguments };
}

function decodeRequest(value: unknown): RequestFrame {
  if (!isRecord(value) || value.v !== 1 || !isRequestId(value.id)) throw protocolParamsError();
  if (
    (value.method === 'connector.cancel' || value.method === 'agent.cancel') &&
    hasExactKeys(value, ['v', 'id', 'method'])
  ) {
    return { id: value.id, method: value.method };
  }
  if (
    !isParamsMethod(value.method) ||
    !hasExactKeys(value, ['v', 'id', 'method', 'params']) ||
    !isRecord(value.params)
  ) {
    throw protocolParamsError();
  }
  return { id: value.id, method: value.method, params: value.params };
}

function isParamsMethod(value: unknown): value is ChildRequestMethod {
  return (
    value === 'connector.list' ||
    value === 'connector.call' ||
    (typeof value === 'string' && isAgentMethod(value))
  );
}

function decodeChildOutcome(
  entry: PendingChildRequest,
  value: Record<string, unknown>,
): { readonly error?: Error; readonly result?: unknown } {
  const success = value.ok === true;
  const keys = success ? ['v', 'id', 'ok', 'result'] : ['v', 'id', 'ok', 'error'];
  if (!hasExactKeys(value, keys)) {
    throw new HostConnectorProtocolError('Host Connector response shape is invalid');
  }
  if (success) {
    const result = decodeChildResult(entry.method, value.result);
    assertInvocationIdentity(entry, result);
    return { result };
  }
  if (isAgentMethod(entry.method)) return { error: decodeAgentWireError(value.error) };
  const error = decodeWireError(value.error);
  assertInvocationIdentity(entry, error);
  return { error };
}

function deliverAgentEvent(value: Record<string, unknown>, entry: PendingChildRequest): void {
  if (!hasExactKeys(value, ['v', 'id', 'event'])) {
    throw new HostConnectorProtocolError('Host Connector notification shape is invalid');
  }
  if (!isAgentTurnMethod(entry.method)) return;
  const event = decodeAgentRunEvent(value.event);
  if (!event) return;
  try {
    entry.onEvent?.(event);
  } catch (error) {
    // A Mini App callback failure must not tear down the shared connector channel or end the
    // run, but the author still needs to see it; child stderr is collected into runtime logs.
    reportAgentEventHandlerError(error);
  }
}

function reportAgentEventHandlerError(error: unknown): void {
  try {
    process.stderr.write(`${format('[miniapp] agent onEvent handler threw', error)}\n`);
  } catch {
    // Diagnostics are best-effort; a broken stderr must not fail the run either.
  }
}

function decodeChildResult(method: ChildRequestMethod, value: unknown): unknown {
  if (isAgentMethod(method)) return decodeAgentResult(method, value);
  if (!isRecord(value)) throw new HostConnectorProtocolError('Host Connector result is invalid');
  if (method === 'connector.list') {
    if (
      !hasExactKeys(value, ['tools', 'partial']) ||
      !Array.isArray(value.tools) ||
      typeof value.partial !== 'boolean'
    ) {
      throw new HostConnectorProtocolError('Host Connector inventory is invalid');
    }
    return value;
  }
  if (!hasExactKeys(value, ['invocationId', 'value']) || !isBoundedIdentifier(value.invocationId)) {
    throw new HostConnectorProtocolError('Host Connector call result is invalid');
  }
  return value;
}

function decodeWireError(value: unknown): HostConnectorError {
  if (!isWireErrorEnvelope(value)) {
    throw new HostConnectorProtocolError('Host Connector error is invalid');
  }
  const diagnostic = 'diagnostic' in value ? decodeWireDiagnostic(value.diagnostic) : undefined;
  if ((value.code === 'INVALID_ARGUMENTS' || diagnostic) && !isInvalidArgumentsWireError(value)) {
    throw new HostConnectorProtocolError('Host Connector error is invalid');
  }
  return new HostConnectorError(
    value.code,
    value.message,
    value.disposition as HostConnectorDisposition,
    {
      retryable: value.retryable,
      ...(typeof value.invocationId === 'string' ? { invocationId: value.invocationId } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    },
  );
}

function isWireErrorEnvelope(value: unknown): value is Record<string, unknown> & WireError {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'code',
      'message',
      'disposition',
      'retryable',
      ...('invocationId' in value ? ['invocationId'] : []),
      ...('diagnostic' in value ? ['diagnostic'] : []),
    ]) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    isHostConnectorDisposition(value.disposition) &&
    typeof value.retryable === 'boolean' &&
    (!('invocationId' in value) || isBoundedIdentifier(value.invocationId))
  );
}

function isHostConnectorDisposition(value: unknown): value is HostConnectorDisposition {
  return ['not_dispatched', 'provider_reported', 'unknown_after_dispatch'].includes(String(value));
}

function isInvalidArgumentsWireError(value: WireError): boolean {
  return (
    value.code === 'INVALID_ARGUMENTS' &&
    value.message === 'Connector arguments are invalid' &&
    value.disposition === 'not_dispatched' &&
    !value.retryable
  );
}

function decodeWireDiagnostic(value: unknown): HostConnectorDiagnostic {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['issues']) ||
    !Array.isArray(value.issues) ||
    value.issues.length === 0 ||
    value.issues.length > 4
  ) {
    throw new HostConnectorProtocolError('Host Connector error diagnostic is invalid');
  }
  return { issues: value.issues.map(decodeWireDiagnosticIssue) };
}

function decodeWireDiagnosticIssue(value: unknown): HostConnectorDiagnosticIssue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'constraint', ...('limit' in value ? ['limit'] : [])]) ||
    !isSafeHostConnectorDiagnosticPath(value.path) ||
    !isSafeHostConnectorDiagnosticConstraint(value.constraint) ||
    ('limit' in value && (typeof value.limit !== 'number' || !Number.isFinite(value.limit)))
  ) {
    throw new HostConnectorProtocolError('Host Connector error diagnostic is invalid');
  }
  return {
    path: value.path,
    constraint: value.constraint,
    ...('limit' in value ? { limit: value.limit as number } : {}),
  };
}

function recordAdmissionReceipt(value: Record<string, unknown>, entry: PendingChildRequest): void {
  if (
    entry.method === 'connector.list' ||
    isAgentShortMethod(entry.method) ||
    entry.invocationId ||
    !hasExactKeys(value, ['v', 'id', 'receipt', 'invocationId']) ||
    !isBoundedIdentifier(value.invocationId)
  ) {
    throw new HostConnectorProtocolError('Host Connector admission receipt is invalid');
  }
  entry.invocationId = value.invocationId;
}

function assertInvocationIdentity(entry: PendingChildRequest, value: unknown): void {
  if (entry.method !== 'connector.call') return;
  let actual: string | undefined;
  if (value instanceof HostConnectorError) actual = value.invocationId;
  else if (isRecord(value) && typeof value.invocationId === 'string') {
    actual = value.invocationId;
  }
  if (entry.invocationId === actual) return;
  throw new HostConnectorProtocolError('Host Connector invocation identity is invalid');
}

function parseJson(json: string, maxBytes: number): HostConnectorJson {
  if (Buffer.byteLength(json) > maxBytes) {
    throw new HostConnectorProtocolError('Host Connector payload exceeds its frame limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new HostConnectorProtocolError('Host Connector payload is not valid JSON');
  }
  return value as HostConnectorJson;
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    resolvesTrue(operation),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function resolvesTrue(operation: Promise<unknown>): Promise<true> {
  await operation;
  return true;
}

function disconnectedError(id: string, request: PendingChildRequest): Error {
  if (isAgentMethod(request.method)) {
    return request.written
      ? agentClientError('AGENT_OUTCOME_UNKNOWN')
      : agentClientError('AGENT_UNAVAILABLE', true);
  }
  return request.method === 'connector.call' && request.written
    ? new HostConnectorError(
        'CONNECTOR_OUTCOME_UNKNOWN',
        'Host Connector transport ended after dispatch became possible',
        'unknown_after_dispatch',
        { retryable: false, invocationId: request.invocationId ?? id },
      )
    : unavailableError(true);
}

function childUnavailableError(method: ChildRequestMethod, retryable = false): Error {
  return isAgentMethod(method)
    ? agentClientError('AGENT_UNAVAILABLE', retryable)
    : unavailableError(retryable);
}

function childCancelledError(method: ChildRequestMethod): Error {
  return isAgentMethod(method) ? agentClientError('REQUEST_CANCELLED') : cancelledError();
}

function childEncodeError(method: ChildRequestMethod): Error {
  if (isAgentMethod(method)) return agentClientError('INVALID_ARGUMENTS');
  return method === 'connector.call'
    ? invalidArgumentsError()
    : new HostConnectorProtocolError('Host Connector list request is invalid');
}

function unavailableError(retryable = false): HostConnectorError {
  return new HostConnectorError(
    'CONNECTOR_UNAVAILABLE',
    'Host Connector is unavailable',
    'not_dispatched',
    { retryable },
  );
}

function cancelledError(): HostConnectorError {
  return new HostConnectorError(
    'REQUEST_CANCELLED',
    'Host Connector request was cancelled',
    'not_dispatched',
    { retryable: false },
  );
}

function invalidArgumentsError(): HostConnectorError {
  return new HostConnectorError(
    'INVALID_ARGUMENTS',
    'Host Connector arguments must fit one JSON frame',
    'not_dispatched',
    { retryable: false },
  );
}

function protocolParamsError(): HostConnectorProtocolError {
  return new HostConnectorProtocolError('Host Connector request is invalid');
}

function requireInvocationId(value: unknown): string {
  if (!isBoundedIdentifier(value)) {
    throw new HostConnectorProtocolError('Host Connector invocation id is invalid');
  }
  return value;
}

