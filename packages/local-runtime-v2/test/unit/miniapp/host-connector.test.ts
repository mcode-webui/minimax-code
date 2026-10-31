import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { GlobalEvent } from '@mavis/shared/global-events';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';

import type {
  ConnectorToolHandle,
  HostProcessConnectorCloudClient,
  HostProcessConnectorGateway,
} from '../../../src/service/host-connector-system/index.js';
import { ConnectorGatewayError } from '../../../src/service/host-connector-system/index.js';
import { HostConnectorGateway } from '../../../src/service/host-connector-system/gateway.js';
import type { SessionFrame } from '../../../src/service/session-system/index.js';
import {
  LocalTurnPermissionGate,
  type LocalTurnPermissionApprovalOwner,
} from '../../../src/service/turn-system/agent-host/runner/policy/local-turn-permission-gate.js';
import {
  MiniAppAgentError,
  type MiniAppAgentGateway,
  type MiniAppAgentRunEvent,
  type MiniAppAgentRunOptions,
  type MiniAppAgentRunResult,
} from '../../../src/service/miniapp/agent/contracts.js';
import { createMiniAppAgentGateway } from '../../../src/service/miniapp/agent/gateway.js';
import {
  createMiniAppAgentSessionPorts,
  type MiniAppAgentSessionPortsOptions,
} from '../../../src/service/miniapp/agent/session-ports.js';
import type {
  MiniAppAgentPolicy,
  MiniAppIpcMessage,
} from '../../../src/service/miniapp/contracts.js';
import {
  createMiniAppHostConnectorRuntimeClient,
  createMiniAppHostConnectorSessionFactory,
  hasHostConnectorRequestCapacity,
  RESPONSE_MAX_BYTES,
} from '../../../src/service/miniapp/process/host-connector/host-connector.js';

const NODE_PENDING_LIMIT = 16;
const NODE_REPLY_PENDING_LIMIT = 16;

type HostGatewayFixture = Omit<HostProcessConnectorGateway, 'registerHostProcess'> &
  Partial<Pick<HostProcessConnectorGateway, 'registerHostProcess'>>;

class MemoryIpc extends EventEmitter {
  peer?: MemoryIpc;
  connected = true;

  send(message: MiniAppIpcMessage, callback: (error: Error | null) => void): boolean {
    const copy = structuredClone(message);
    queueMicrotask(() => {
      this.peer?.emit('message', copy);
      callback(null);
    });
    return true;
  }

  receive(payload: unknown): void {
    this.emit('message', { type: 'miniapp:connector', payload });
  }
}

function bridge(
  gateway: HostGatewayFixture,
  options: {
    readonly requestTimeoutMs?: number;
    readonly startHandshake?: boolean;
    readonly makeToolRef?: () => string;
    readonly makeInvocationId?: () => string;
    readonly graceTimeoutMs?: number;
    readonly settleTimeoutMs?: number;
    readonly agentGateway?: MiniAppAgentGateway;
    readonly providers?: readonly string[];
    readonly agentPolicy?: MiniAppAgentPolicy;
    readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  } = {},
) {
  const {
    startHandshake = true,
    providers = ['weather'],
    agentPolicy,
    ...factoryOptions
  } = options;
  const hostRequests = new MemoryIpc();
  const childResponses = new MemoryIpc();
  childResponses.peer = hostRequests;
  const hostResponses = hostRequests;
  hostResponses.peer = childResponses;
  const fatal = vi.fn();
  const registerHostProcess = gateway.registerHostProcess?.bind(gateway) ?? vi.fn();
  const registeredGateway: HostProcessConnectorGateway = gateway.registerHostProcess
    ? (gateway as HostProcessConnectorGateway)
    : { ...gateway, registerHostProcess };
  const session = createMiniAppHostConnectorSessionFactory({
    gateway: registeredGateway,
    makeToolRef: factoryOptions.makeToolRef ?? (() => 'tool-ref-1'),
    makeInvocationId: factoryOptions.makeInvocationId ?? (() => 'invocation-real-1'),
    graceTimeoutMs: factoryOptions.graceTimeoutMs ?? 5,
    settleTimeoutMs: factoryOptions.settleTimeoutMs ?? 5,
    ...factoryOptions,
  }).create({
    pluginId: 'weather-board',
    processGeneration: 'process-1',
    providers,
    ...(agentPolicy ? { agentPolicy } : {}),
    transport: hostRequests,
    onFatal: fatal,
  });
  const runtime = createMiniAppHostConnectorRuntimeClient({
    transport: childResponses,
  });
  if (startHandshake) session.startHandshake();
  return {
    childResponses,
    fatal,
    hostRequests,
    hostResponses,
    registerHostProcess,
    runtime,
    session,
  };
}

async function expectPendingAfterEventLoopTurn(operation: Promise<unknown>): Promise<void> {
  await expect(
    Promise.race([
      operation.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
    ]),
  ).resolves.toBe('pending');
}

async function expectSynchronousGatewayFailureBeforePromise(): Promise<void> {
  const handle = Object.freeze({}) as ConnectorToolHandle;
  const synchronous = bridge({
    list: vi.fn().mockResolvedValue({
      tools: [
        {
          handle,
          provider: 'weather',
          providerToolName: 'forecast',
          runtimeToolName: 'weather_forecast',
          inputSchemaJson: '{}',
        },
      ],
      providerFailures: [],
      partial: false,
    }),
    call: vi.fn(() => {
      throw new Error('gateway call failed before returning a Promise');
    }),
    releaseHostProcess: vi.fn(),
  });
  const tool = (await synchronous.runtime.client.list()).tools[0];
  if (!tool) throw new Error('Expected synchronous failure inventory tool');
  synchronous.session.activate();
  await expect(synchronous.runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
    code: 'CONNECTOR_UNAVAILABLE',
    disposition: 'not_dispatched',
    retryable: true,
    invocationId: 'invocation-real-1',
  });
  synchronous.runtime.close();
  await synchronous.session.close();
}

function invalidArgumentsResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    id: '1',
    ok: false,
    error: {
      code: 'INVALID_ARGUMENTS',
      message: 'Connector arguments are invalid',
      disposition: 'not_dispatched',
      retryable: false,
      ...overrides,
    },
  };
}

function malformedDiagnosticResponses(): readonly unknown[] {
  const response = (diagnostic: unknown, overrides: Record<string, unknown> = {}) =>
    invalidArgumentsResponse({ diagnostic, ...overrides });
  const issue = { path: '/page_size', constraint: 'maximum', limit: 100 };
  return [
    response({}),
    response({ issues: [], extra: true }),
    response({ issues: [] }),
    response({ issues: Array.from({ length: 5 }, () => issue) }),
    response({ issues: [{ ...issue, value: 'secret' }] }),
    response({ issues: [{ constraint: 'maximum' }] }),
    response({ issues: [{ ...issue, path: 'page_size' }] }),
    response({ issues: [{ ...issue, path: '/page\nsize' }] }),
    response({ issues: [{ ...issue, path: '/page~2size' }] }),
    response({ issues: [{ ...issue, path: `/${'界'.repeat(86)}` }] }),
    response({ issues: [{ path: '/page_size', constraint: '' }] }),
    response({ issues: [{ path: '/page_size', constraint: '最大值' }] }),
    response({ issues: [{ path: '/page_size', constraint: 'x'.repeat(65) }] }),
    response({ issues: [{ ...issue, limit: '100' }] }),
    response(
      { issues: [issue] },
      { code: 'CONNECTOR_PROVIDER_ERROR', disposition: 'provider_reported' },
    ),
  ];
}

function malformedInvalidArgumentsResponses(): readonly unknown[] {
  return [
    invalidArgumentsResponse({ arguments: { pageSize: 100 } }),
    invalidArgumentsResponse({ message: 'provider supplied message' }),
    invalidArgumentsResponse({ disposition: 'provider_reported' }),
    invalidArgumentsResponse({ retryable: true }),
  ];
}

describe('Mini App Host Connector bridge', () => {
  it('routes only connector responses and ignores lifecycle and log messages', async () => {
    const input = new MemoryIpc();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
    const pending = runtime.client.list();
    input.emit('message', { type: 'miniapp:started' });
    input.emit('message', { type: 'miniapp:log', message: 'ignored' });
    await expectPendingAfterEventLoopTurn(pending);
    input.receive({ v: 1, id: '1', ok: true, result: { tools: [], partial: false } });
    await expect(pending).resolves.toEqual({ tools: [], partial: false });
    runtime.close();
  });

  it('fails the generation when a connector IPC envelope is malformed', async () => {
    const gateway: HostGatewayFixture = {
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { fatal, hostRequests, registerHostProcess, runtime, session } = bridge(gateway);

    expect(registerHostProcess).toHaveBeenCalledOnce();
    expect(registerHostProcess).toHaveBeenCalledWith({
      pluginId: 'weather-board',
      processGeneration: 'process-1',
    });

    hostRequests.emit('message', { type: 'miniapp:connector', unexpected: true });

    expect(fatal).toHaveBeenCalledOnce();
    expect(gateway.releaseHostProcess).toHaveBeenCalledWith({
      pluginId: 'weather-board',
      processGeneration: 'process-1',
    });
    runtime.close();
    await session.close();
  });

  it('allows candidate inventory, gates calls until activation, and maps auth epoch revocation', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    let authChanged = false;
    const call = vi
      .fn()
      .mockImplementation(async (input: Parameters<HostProcessConnectorGateway['call']>[0]) => {
        if (authChanged) {
          throw new ConnectorGatewayError(
            'CONNECTOR_PRINCIPAL_CHANGED',
            'principal changed',
            'not_dispatched',
          );
        }
        expect(input.caller).toEqual({
          kind: 'host-process',
          pluginId: 'weather-board',
          processGeneration: 'process-1',
        });
        return { resultJson: '{"temperature":21}' };
      });
    const releaseHostProcess = vi.fn();
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{"type":"object"}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call,
      releaseHostProcess,
    };
    const { runtime, session } = bridge(gateway);

    const inventory = await runtime.client.list();
    expect(inventory).toMatchObject({
      partial: false,
      tools: [{ toolRef: 'tool-ref-1', provider: 'weather', name: 'forecast' }],
    });
    const tool = inventory.tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
      disposition: 'not_dispatched',
    });
    expect(call).not.toHaveBeenCalled();

    session.activate();
    await expect(runtime.client.call(tool.toolRef, {})).resolves.toEqual({
      invocationId: 'invocation-real-1',
      value: { temperature: 21 },
    });
    expect(gateway.list).toHaveBeenCalledWith({
      providerAllowlist: ['weather'],
      caller: {
        kind: 'host-process',
        pluginId: 'weather-board',
        processGeneration: 'process-1',
      },
      signal: expect.any(AbortSignal),
    });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        hostRequest: {
          clientRequestId: '3',
          invocationId: 'invocation-real-1',
        },
      }),
    );
    authChanged = true;
    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'TOOL_REF_STALE',
      disposition: 'not_dispatched',
    });

    runtime.close();
    await session.close();
    expect(releaseHostProcess).toHaveBeenCalledWith({
      pluginId: 'weather-board',
      processGeneration: 'process-1',
    });
  });

  it('reuses wire refs for surviving handles and isolates syntax-invalid tool schemas', async () => {
    const stable = Object.freeze({}) as ConnectorToolHandle;
    const broken = Object.freeze({}) as ConnectorToolHandle;
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle: broken,
            provider: 'weather',
            providerToolName: 'broken',
            runtimeToolName: 'weather_broken',
            inputSchemaJson: '{broken',
          },
          {
            handle: stable,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: 'true',
            outputSchemaJson: '["any-json"]',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);

    const first = await runtime.client.list();
    const second = await runtime.client.list();

    expect(first).toEqual({
      tools: [
        expect.objectContaining({
          toolRef: 'tool-ref-1',
          inputSchema: true,
          outputSchema: ['any-json'],
        }),
      ],
      partial: true,
    });
    expect(second.tools[0]?.toolRef).toBe(first.tools[0]?.toolRef);

    runtime.close();
    await session.close();
  });
});

describe('Mini App Host Connector stalled sends', () => {
  it.each([false, true])(
    'bounds a cancelled IPC send and preserves the admission identity (receipt=%s)',
    async (admitted) => {
      vi.useFakeTimers();
      const input = new MemoryIpc();
      let completeSend: (error: Error | null) => void = () => undefined;
      const write = vi.spyOn(input, 'send').mockImplementation((_message, callback) => {
        completeSend = callback;
        return false;
      });
      const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
      const controller = new AbortController();
      let outcome: unknown;
      const pending = runtime.client
        .call('opaque-tool' as never, {}, { signal: controller.signal })
        .catch((error: unknown) => {
          outcome = error;
        });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(write).toHaveBeenCalledOnce();
        if (admitted) {
          input.receive({ v: 1, id: '1', receipt: 'admitted', invocationId: 'real-invocation' });
        }
        controller.abort();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(outcome).toMatchObject({
          code: 'CONNECTOR_OUTCOME_UNKNOWN',
          disposition: 'unknown_after_dispatch',
          retryable: false,
          invocationId: admitted ? 'real-invocation' : '1',
        });
        expect(write).toHaveBeenCalledOnce();
        expect(input.eventNames()).toEqual([]);
        completeSend(null);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        runtime.close();
        await pending;
        vi.useRealTimers();
      }
    },
  );
});

describe('Mini App Host Connector transport bounds', () => {
  it('waits for IPC backpressure and treats disconnect after send as an unknown outcome', async () => {
    const input = new MemoryIpc();
    const write = vi.spyOn(input, 'send').mockReturnValueOnce(false);
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });

    const pending = runtime.client.call('opaque-tool' as never, {});
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    input.emit('disconnect');

    await expect(pending).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
      invocationId: '1',
    });
    expect(input.listenerCount('disconnect')).toBe(0);
  });

  it('rejects over-budget child arguments without dispatching them', async () => {
    const gateway: HostGatewayFixture = {
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    session.activate();

    await expect(
      runtime.client.call('tool-ref-1' as never, { value: 'x'.repeat(300 * 1024) }),
    ).rejects.toMatchObject({
      name: 'HostConnectorError',
      code: 'INVALID_ARGUMENTS',
      disposition: 'not_dispatched',
    });
    expect(gateway.call).not.toHaveBeenCalled();

    runtime.close();
    await session.close();
  });

  it('propagates child cancellation and bounds retirement of an uncooperative call', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    let callSignal: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi
        .fn()
        .mockImplementation((input: Parameters<HostProcessConnectorGateway['call']>[0]) => {
          callSignal = input.signal;
          markStarted();
          return new Promise(() => undefined);
        }),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    const inventory = await runtime.client.list();
    session.activate();
    const tool = inventory.tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    const pending = runtime.client.call(tool.toolRef, {});
    await started;

    await session.retire();
    expect(callSignal?.aborted).toBe(true);
    runtime.close();
    await expect(pending).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
    });
  });

  it('uses Gateway Promise acquisition, not invocation identity, as the dispatch boundary', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi
        .fn()
        .mockImplementation((input: Parameters<HostProcessConnectorGateway['call']>[0]) =>
          rejectWithAbortReason(input.signal),
        ),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway, { requestTimeoutMs: 5 });
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
      retryable: false,
      invocationId: 'invocation-real-1',
    });

    runtime.close();
    await session.close();
  });

  it('reports an invalid provider result after admission as an unknown outcome', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi.fn().mockResolvedValue({ resultJson: '{invalid' }),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
      invocationId: 'invocation-real-1',
    });

    runtime.close();
    await session.close();
  });

  it('reports disconnect after admission as unknown with the real invocation identity', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const call = vi.fn().mockReturnValue(new Promise(() => undefined));
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call,
      releaseHostProcess: vi.fn(),
    };
    const { childResponses, runtime, session } = bridge(gateway);
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();
    const pending = runtime.client.call(tool.toolRef, {});
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    childResponses.emit('disconnect');

    await expect(pending).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
      invocationId: 'invocation-real-1',
    });

    await session.close();
  });
});

describe('Mini App Host Connector lifecycle guards', () => {
  it('bounds concurrent child requests and drains every pending caller on close', async () => {
    const input = new MemoryIpc();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
    const pending = Array.from({ length: 16 }, () => runtime.client.list());

    await expect(runtime.client.list()).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
      disposition: 'not_dispatched',
      retryable: true,
    });
    runtime.close();
    const settled = await Promise.allSettled(pending);
    expect(settled).toHaveLength(16);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
  });

  it('fails and releases a generation whose output precedes the Host handshake', async () => {
    const gateway: HostGatewayFixture = {
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { fatal, hostRequests, runtime, session } = bridge(gateway, {
      startHandshake: false,
    });

    hostRequests.receive({ v: 1, id: '1', method: 'connector.list', params: {} });

    expect(fatal).toHaveBeenCalledOnce();
    expect(gateway.releaseHostProcess).toHaveBeenCalledOnce();
    session.startHandshake();
    runtime.close();
    await session.close();
  });

  it('keeps activation single-use and retirement idempotent', async () => {
    const gateway: HostGatewayFixture = {
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    session.activate();

    expect(() => session.activate()).toThrow('Host Connector cannot activate');
    const retiring = session.retire();
    expect(session.retire()).toBe(retiring);
    await retiring;
    session.startHandshake();
    runtime.close();
    await session.close();
    expect(gateway.releaseHostProcess).toHaveBeenCalledOnce();
  });

  it('preserves a provider-reported call outcome with its real invocation identity', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi.fn().mockResolvedValue({ isError: true, resultJson: '{"ignored":true}' }),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'CONNECTOR_PROVIDER_ERROR',
      disposition: 'provider_reported',
      invocationId: 'invocation-real-1',
    });

    runtime.close();
    await session.close();
  });
});

describe('Mini App Host Connector error mapping', () => {
  it('maps an unavailable gateway inventory without admitting a call', async () => {
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockRejectedValue(new Error('gateway offline')),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);

    await expect(runtime.client.list()).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
      disposition: 'not_dispatched',
      retryable: false,
    });

    runtime.close();
    await session.close();
  });

  it('maps a gateway abort after admission to the real invocation identity', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi
        .fn()
        .mockRejectedValue(
          new ConnectorGatewayError('REQUEST_ABORTED', 'request aborted', 'not_dispatched'),
        ),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
      disposition: 'not_dispatched',
      invocationId: 'invocation-real-1',
    });

    runtime.close();
    await session.close();
  });

  it('projects a bounded canonical argument diagnostic', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const invalidArguments = new ConnectorGatewayError(
      'CONNECTOR_ARGUMENTS_INVALID',
      'provider validation failed',
      'not_dispatched',
      {
        diagnostic: {
          issues: [
            { path: '', constraint: 'type' },
            { path: '/分页/条目~1每页', constraint: 'maximum', limit: 100 },
            { path: '/filter~0raw', constraint: 'minLength', limit: 1 },
            { path: '/items/0/active', constraint: 'const' },
            { path: '/ignored', constraint: 'required' },
          ],
        },
      },
    );
    const gateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi.fn().mockRejectedValue(invalidArguments),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();

    try {
      await runtime.client.call(tool.toolRef, {});
      throw new Error('Expected invalid arguments');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_ARGUMENTS',
        message: 'Connector arguments are invalid',
        disposition: 'not_dispatched',
        retryable: false,
        invocationId: 'invocation-real-1',
        diagnostic: {
          issues: invalidArguments.diagnostic?.issues.slice(0, 4),
        },
      });
    }

    runtime.close();
    await session.close();
  });

  it('rejects an active call whose wire reference was never listed', async () => {
    const gateway: HostGatewayFixture = {
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const { runtime, session } = bridge(gateway);
    session.activate();

    await expect(runtime.client.call('unknown-ref' as never, {})).rejects.toMatchObject({
      code: 'TOOL_REF_STALE',
      disposition: 'not_dispatched',
    });
    expect(gateway.call).not.toHaveBeenCalled();

    runtime.close();
    await session.close();
  });

  it('fails the pending caller when a response result is malformed', async () => {
    const input = new MemoryIpc();
    const onFatal = vi.fn();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
    const pending = runtime.client.list();

    input.receive({ v: 1, id: '1', ok: true, result: { tools: [] } });

    await expect(pending).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
      disposition: 'not_dispatched',
    });
    expect(onFatal).toHaveBeenCalledOnce();
    runtime.close();
  });
});

describe('Mini App Host Connector public protocol matrices', () => {
  it('fails closed for malformed child responses and preserves cancellation disposition', async () => {
    const malformedResponses = [
      null,
      { v: 2, id: '1', ok: true, result: { tools: [], partial: false } },
      { v: 1, id: '', ok: true, result: { tools: [], partial: false } },
      { v: 1, id: '18446744073709551616', ok: true, result: { tools: [], partial: false } },
      { v: 1, id: '2', ok: true, result: { tools: [], partial: false } },
      { v: 1, id: '1', ok: true, result: { tools: [], partial: false }, extra: true },
      { v: 1, id: '1', ok: true, result: null },
      { v: 1, id: '1', ok: true, result: { tools: 'invalid', partial: false } },
      { v: 1, id: '1', ok: true, result: { tools: [], partial: 'false' } },
      { v: 1, id: '1', ok: false, error: null },
      {
        v: 1,
        id: '1',
        ok: false,
        error: { code: 1, message: 'bad', disposition: 'not_dispatched', retryable: false },
      },
      {
        v: 1,
        id: '1',
        ok: false,
        error: { code: 'BAD', message: 1, disposition: 'not_dispatched', retryable: false },
      },
      {
        v: 1,
        id: '1',
        ok: false,
        error: { code: 'BAD', message: 'bad', disposition: 'invalid', retryable: false },
      },
      {
        v: 1,
        id: '1',
        ok: false,
        error: { code: 'BAD', message: 'bad', disposition: 'not_dispatched', retryable: 'no' },
      },
      ...malformedInvalidArgumentsResponses(),
      ...malformedDiagnosticResponses(),
    ];
    for (const response of malformedResponses) {
      const input = new MemoryIpc();
      const onFatal = vi.fn();
      const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
      const pending = runtime.client.list();
      input.receive(response);
      await expect(pending).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
      expect(onFatal).toHaveBeenCalledOnce();
      runtime.close();
    }

    for (const invalidReceipt of [
      { v: 1, id: '1', receipt: 'admitted', invocationId: '' },
      { v: 1, id: '1', receipt: 'admitted', invocationId: 'inv-1', extra: true },
    ]) {
      const input = new MemoryIpc();
      const onFatal = vi.fn();
      const write = vi.spyOn(input, 'send');
      const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
      const pending = runtime.client.call('tool-ref' as never, {});
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      input.receive(invalidReceipt);
      await expect(pending).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
      expect(onFatal).toHaveBeenCalledOnce();
    }

    const mismatchedInput = new MemoryIpc();
    const mismatchedWrite = vi.spyOn(mismatchedInput, 'send');
    const mismatched = createMiniAppHostConnectorRuntimeClient({
      transport: mismatchedInput,
    });
    const mismatchedCall = mismatched.client.call('tool-ref' as never, {});
    await vi.waitFor(() => expect(mismatchedWrite).toHaveBeenCalledOnce());
    mismatchedInput.receive({ v: 1, id: '1', receipt: 'admitted', invocationId: 'inv-1' });
    mismatchedInput.receive({
      v: 1,
      id: '1',
      ok: true,
      result: { invocationId: 'inv-2', value: null },
    });
    await expect(mismatchedCall).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      invocationId: 'inv-1',
    });

    const preAborted = new AbortController();
    preAborted.abort(new Error('cancelled before call'));
    const abortRuntime = createMiniAppHostConnectorRuntimeClient({
      transport: new MemoryIpc(),
    });
    await expect(abortRuntime.client.list({ signal: preAborted.signal })).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
      disposition: 'not_dispatched',
    });
    await expect(abortRuntime.client.call('' as never, {})).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    await expect(abortRuntime.client.call('tool-ref' as never, [] as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });

    const beforeWriteController = new AbortController();
    const beforeWrite = abortRuntime.client.list({ signal: beforeWriteController.signal });
    beforeWriteController.abort(new Error('cancelled before write'));
    await expect(beforeWrite).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    const afterWriteInput = new MemoryIpc();
    const write = vi.spyOn(afterWriteInput, 'send');
    const afterWriteRuntime = createMiniAppHostConnectorRuntimeClient({
      transport: afterWriteInput,
    });
    const afterWriteController = new AbortController();
    const afterWrite = afterWriteRuntime.client.call(
      'tool-ref' as never,
      {},
      {
        signal: afterWriteController.signal,
      },
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    afterWriteController.abort(new Error('cancelled after write'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    afterWriteInput.emit('error', new Error('transport ended'));
    await expect(afterWrite).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });

    const disconnectedInput = new MemoryIpc();
    const disconnectedRuntime = createMiniAppHostConnectorRuntimeClient({
      transport: disconnectedInput,
    });
    const disconnected = disconnectedRuntime.client.list();
    disconnectedInput.emit('disconnect');
    await expect(disconnected).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });

    abortRuntime.close();
    abortRuntime.close();
    await expect(abortRuntime.client.list()).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
    });
  });

  it('rejects a non-finite diagnostic limit', async () => {
    const input = new MemoryIpc();
    const onFatal = vi.fn();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
    const pending = runtime.client.list();
    input.receive(
      invalidArgumentsResponse({
        diagnostic: { issues: [{ path: '/page_size', constraint: 'maximum', limit: Infinity }] },
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
    expect(onFatal).toHaveBeenCalledOnce();
    runtime.close();
  });
});

describe('Mini App Host Connector Host protocol matrices', () => {
  it('enforces Host request envelopes, ordering, cancellation ids, and IPC disconnection', async () => {
    const invalidRequests = [
      null,
      { v: 2, id: '1', method: 'connector.list', params: {} },
      { v: 1, id: '0', method: 'connector.list', params: {} },
      { v: 1, id: '18446744073709551616', method: 'connector.list', params: {} },
      { v: 1, id: '1', method: 'connector.cancel', extra: true },
      { v: 1, id: '1', method: 'unknown', params: {} },
      { v: 1, id: '1', method: 'connector.list' },
      { v: 1, id: '1', method: 'connector.list', params: [] },
      { v: 1, id: '1', method: 'connector.list', params: { extra: true } },
      { v: 1, id: '1', method: 'connector.call', params: {} },
      { v: 1, id: '1', method: 'connector.call', params: { toolRef: '', arguments: {} } },
      { v: 1, id: '1', method: 'connector.call', params: { toolRef: 'ref', arguments: [] } },
    ];
    for (const request of invalidRequests) {
      const gateway: HostGatewayFixture = {
        list: vi.fn(),
        call: vi.fn(),
        releaseHostProcess: vi.fn(),
      };
      const { fatal, hostRequests, runtime, session } = bridge(gateway);
      hostRequests.receive(request);
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
      expect(gateway.releaseHostProcess).toHaveBeenCalledOnce();
      runtime.close();
      await session.close();
    }

    const pendingGateway: HostGatewayFixture = {
      list: vi.fn().mockReturnValue(new Promise(() => undefined)),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const ordered = bridge(pendingGateway, { requestTimeoutMs: 1_000 });
    ordered.hostRequests.receive({ v: 1, id: '2', method: 'connector.list', params: {} });
    ordered.hostRequests.receive({ v: 1, id: '1', method: 'connector.list', params: {} });
    await vi.waitFor(() => expect(ordered.fatal).toHaveBeenCalledOnce());
    ordered.runtime.close();
    await ordered.session.close();

    const future = bridge({
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    });
    future.hostRequests.receive({ v: 1, id: '1', method: 'connector.cancel' });
    await vi.waitFor(() => expect(future.fatal).toHaveBeenCalledOnce());
    future.runtime.close();
    await future.session.close();

    for (const terminal of ['disconnect', 'error'] as const) {
      const current = bridge({
        list: vi.fn(),
        call: vi.fn(),
        releaseHostProcess: vi.fn(),
      });
      if (terminal === 'error') current.hostRequests.emit('error', new Error('child failed'));
      else current.hostRequests.emit('disconnect');
      await vi.waitFor(() => expect(current.fatal).toHaveBeenCalledOnce());
      current.runtime.close();
      await current.session.close();
    }
  });
});

describe('Mini App Host Connector inventory matrices', () => {
  it('isolates inventory failures while preserving stable, collision-free opaque references', async () => {
    const stable = Object.freeze({}) as ConnectorToolHandle;
    const second = Object.freeze({}) as ConnectorToolHandle;
    const third = Object.freeze({}) as ConnectorToolHandle;
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [
          {
            handle: stable,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            description: 'Weather forecast',
            inputSchemaJson: '{}',
            outputSchemaJson: 'null',
          },
          {
            handle: second,
            provider: 'weather',
            providerToolName: 'oversized',
            runtimeToolName: 'weather_oversized',
            inputSchemaJson: `"${'x'.repeat(8 * 1024 * 1024)}"`,
          },
        ],
        providerFailures: [],
        partial: true,
      })
      .mockResolvedValueOnce({
        tools: [
          {
            handle: stable,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
          {
            handle: stable,
            provider: 'weather',
            providerToolName: 'duplicate',
            runtimeToolName: 'weather_duplicate',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      })
      .mockResolvedValueOnce({
        tools: [
          {
            handle: second,
            provider: 'weather',
            providerToolName: 'second',
            runtimeToolName: 'weather_second',
            inputSchemaJson: '{}',
          },
          {
            handle: third,
            provider: 'weather',
            providerToolName: 'third',
            runtimeToolName: 'weather_third',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      });
    const gateway: HostGatewayFixture = {
      list,
      call: vi.fn().mockResolvedValue({}),
      releaseHostProcess: vi.fn(),
    };
    const refs = ['', 'x'.repeat(257), 'stable-ref'];
    const { runtime, session } = bridge(gateway, {
      makeToolRef: () => refs.shift() ?? 'stable-ref',
    });
    const first = await runtime.client.list();
    expect(first).toEqual({
      tools: [
        expect.objectContaining({
          toolRef: 'stable-ref',
          description: 'Weather forecast',
          outputSchema: null,
        }),
      ],
      partial: true,
    });
    const duplicate = await runtime.client.list();
    expect(duplicate.tools).toHaveLength(1);
    expect(duplicate.partial).toBe(true);
    const exhausted = await runtime.client.list();
    expect(exhausted.tools).toHaveLength(1);
    expect(exhausted.partial).toBe(true);

    session.activate();
    const exhaustedTool = exhausted.tools[0];
    if (!exhaustedTool) throw new Error('Expected one surviving inventory tool');
    await expect(runtime.client.call(exhaustedTool.toolRef, {})).resolves.toEqual({
      invocationId: 'invocation-real-1',
      value: null,
    });
    runtime.close();
    await session.close();

    const unexpected: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle: stable,
            provider: 'weather',
            providerToolName: 'broken',
            runtimeToolName: 'weather_broken',
            get inputSchemaJson(): string {
              throw new Error('schema getter failed');
            },
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const failed = bridge(unexpected);
    await expect(failed.runtime.client.list()).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
    });
    failed.runtime.close();
    await failed.session.close();
  });
});

describe('Mini App Host Connector request outcome matrices', () => {
  it('maps timeouts, cancellation, typed gateway outcomes, draining, and response loss', async () => {
    vi.useFakeTimers();
    try {
      const timeout = bridge(
        {
          list: vi.fn().mockReturnValue(new Promise(() => undefined)),
          call: vi.fn(),
          releaseHostProcess: vi.fn(),
        },
        { requestTimeoutMs: 20 },
      );
      const timedOut = timeout.runtime.client.list();
      const timeoutRejected = expect(timedOut).rejects.toMatchObject({
        code: 'CONNECTOR_TIMEOUT',
        disposition: 'not_dispatched',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(20);
      await timeoutRejected;
      timeout.runtime.close();
      await timeout.session.close();
    } finally {
      vi.useRealTimers();
    }

    const outcomes = [
      {
        error: new ConnectorGatewayError(
          'PROVIDER_TIMEOUT',
          'unknown',
          'unknown_after_dispatch',
          'invocation-real-1',
        ),
        code: 'CONNECTOR_OUTCOME_UNKNOWN',
        disposition: 'unknown_after_dispatch',
      },
      {
        error: new ConnectorGatewayError('PROVIDER_ERROR', 'reported', 'provider_reported', {
          invocationId: 'invocation-real-1',
          diagnostic: {
            issues: [{ path: '/page_size', constraint: 'maximum', limit: 100 }],
          },
        }),
        code: 'CONNECTOR_PROVIDER_ERROR',
        disposition: 'provider_reported',
      },
      {
        error: new ConnectorGatewayError('OTHER', 'unavailable', 'not_dispatched'),
        code: 'CONNECTOR_UNAVAILABLE',
        disposition: 'not_dispatched',
      },
      {
        error: new Error('unexpected provider failure'),
        code: 'CONNECTOR_OUTCOME_UNKNOWN',
        disposition: 'unknown_after_dispatch',
      },
    ] as const;
    for (const outcome of outcomes) {
      const handle = Object.freeze({}) as ConnectorToolHandle;
      const current = bridge({
        list: vi.fn().mockResolvedValue({
          tools: [
            {
              handle,
              provider: 'weather',
              providerToolName: 'forecast',
              runtimeToolName: 'weather_forecast',
              inputSchemaJson: '{}',
            },
          ],
          providerFailures: [],
          partial: false,
        }),
        call: vi.fn().mockRejectedValue(outcome.error),
        releaseHostProcess: vi.fn(),
      });
      const tool = (await current.runtime.client.list()).tools[0];
      if (!tool) throw new Error('Expected outcome matrix inventory tool');
      current.session.activate();
      const pendingCall = current.runtime.client.call(tool.toolRef, {});
      await expect(pendingCall).rejects.toMatchObject({
        code: outcome.code,
        disposition: outcome.disposition,
        invocationId: 'invocation-real-1',
      });
      if (outcome.disposition === 'provider_reported') {
        await expect(pendingCall).rejects.not.toHaveProperty('diagnostic');
      }
      current.runtime.close();
      await current.session.close();
    }

    await expectSynchronousGatewayFailureBeforePromise();

    let callSignal: AbortSignal | undefined;
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const cancelled = bridge({
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: vi.fn().mockImplementation(({ signal }) => {
        callSignal = signal;
        return rejectWithGatewayOutcomeOnAbort(signal, 'invocation-real-1');
      }),
      releaseHostProcess: vi.fn(),
    });
    const tool = (await cancelled.runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected cancellation matrix inventory tool');
    cancelled.session.activate();
    const controller = new AbortController();
    const pending = cancelled.runtime.client.call(tool.toolRef, {}, { signal: controller.signal });
    await vi.waitFor(() => expect(callSignal).toBeDefined());
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
      invocationId: 'invocation-real-1',
    });
    expect(callSignal?.aborted).toBe(true);
    cancelled.runtime.close();
    await cancelled.session.close();

    vi.useFakeTimers();
    try {
      const list = vi.fn().mockReturnValue(new Promise(() => undefined));
      const draining = bridge(
        {
          list,
          call: vi.fn(),
          releaseHostProcess: vi.fn(),
        },
        { graceTimeoutMs: 20 },
      );
      const first = draining.runtime.client.list();
      const firstRejected = expect(first).rejects.toMatchObject({
        code: 'CONNECTOR_UNAVAILABLE',
      });
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      const retiring = draining.session.retire();
      const second = draining.runtime.client.list();
      await expect(second).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
      await vi.advanceTimersByTimeAsync(20);
      await retiring;
      draining.runtime.close();
      await firstRejected;
    } finally {
      vi.useRealTimers();
    }

    const responseLostGateway: HostGatewayFixture = {
      list: vi.fn().mockResolvedValue({ tools: [], providerFailures: [], partial: false }),
      call: vi.fn(),
      releaseHostProcess: vi.fn(),
    };
    const lost = bridge(responseLostGateway);
    vi.spyOn(lost.hostResponses, 'send').mockImplementation(() => {
      throw new Error('response stream closed');
    });
    const lostPending = lost.runtime.client.list();
    await vi.waitFor(() => expect(lost.fatal).toHaveBeenCalledOnce());
    lost.runtime.close();
    await expect(lostPending).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
    await lost.session.close();

    const destroyed = bridge(responseLostGateway);
    destroyed.hostResponses.connected = false;
    const destroyedPending = destroyed.runtime.client.list();
    await vi.waitFor(() => expect(responseLostGateway.list).toHaveBeenCalledTimes(2));
    destroyed.runtime.close();
    await expect(destroyedPending).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
    await destroyed.session.close();
  });
});

describe('Mini App Host Connector inventory quiesce', () => {
  it('waits for inventory already entered into Gateway list before draining', async () => {
    let finishInventory: (() => void) | undefined;
    const releaseHostProcess = vi.fn();
    const list = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<HostProcessConnectorGateway['list']>>>((resolve) => {
          finishInventory = () => resolve({ tools: [], providerFailures: [], partial: false });
        }),
    );
    const { runtime, session } = bridge({
      list,
      call: vi.fn(),
      releaseHostProcess,
    });
    session.activate();
    const pendingInventory = runtime.client.list();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());

    const quiesce = session.beginQuiesce({ deadlineMs: Date.now() + 10_000 });
    await expectPendingAfterEventLoopTurn(quiesce.result);
    await expect(runtime.client.list()).rejects.toMatchObject({
      code: 'SERVICE_RESTARTED',
      disposition: 'not_dispatched',
    });
    expect(list).toHaveBeenCalledOnce();

    finishInventory?.();
    await expect(pendingInventory).resolves.toEqual({ tools: [], partial: false });
    await expect(quiesce.result).resolves.toBe('drained');
    await quiesce.commit();
    expect(releaseHostProcess).toHaveBeenCalledOnce();
    await expect(runtime.client.list()).rejects.toMatchObject({
      code: 'SERVICE_RESTARTED',
      disposition: 'not_dispatched',
    });

    runtime.close();
    await session.close();
    expect(releaseHostProcess).toHaveBeenCalledOnce();
  });
});

describe('Mini App Host Connector reversible quiesce', () => {
  it('gates new calls without aborting dispatched work and reopens on resume', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    let finishFirst: (() => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const releaseHostProcess = vi.fn();
    const call = vi
      .fn()
      .mockImplementationOnce(({ signal }) => {
        firstSignal = signal;
        return new Promise<{ readonly resultJson: string }>((resolve) => {
          finishFirst = () => resolve({ resultJson: '{"temperature":21}' });
        });
      })
      .mockResolvedValue({ resultJson: '{"temperature":22}' });
    const { runtime, session } = bridge({
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call,
      releaseHostProcess,
    });
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();
    const first = runtime.client.call(tool.toolRef, {});
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());

    const controller = new AbortController();
    const quiesce = session.beginQuiesce({
      deadlineMs: Date.now() + 10_000,
      signal: controller.signal,
    });
    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'SERVICE_RESTARTED',
      disposition: 'not_dispatched',
      retryable: true,
    });
    expect(call).toHaveBeenCalledOnce();

    controller.abort(new Error('cutover cancelled'));
    await expect(quiesce.result).resolves.toBe('busy');
    expect(firstSignal?.aborted).toBe(false);
    expect(releaseHostProcess).not.toHaveBeenCalled();
    expect(quiesce.resume()).toBe(true);

    finishFirst?.();
    await expect(first).resolves.toMatchObject({ value: { temperature: 21 } });
    await expect(runtime.client.call(tool.toolRef, {})).resolves.toMatchObject({
      value: { temperature: 22 },
    });
    expect(call).toHaveBeenCalledTimes(2);

    const expired = session.beginQuiesce({ deadlineMs: Date.now() });
    await expect(expired.result).resolves.toBe('busy');
    await expect(expired.commit()).rejects.toThrow('Host Connector quiesce is not drained');
    expect(expired.resume()).toBe(true);
    expect(releaseHostProcess).not.toHaveBeenCalled();

    runtime.close();
    await session.close();
  });

  it('does not wait for a call still queued behind the admission receipt write', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    const releaseHostProcess = vi.fn();
    const gatewayCall = vi.fn().mockResolvedValue({ resultJson: '{"temperature":21}' });
    const { hostResponses, runtime, session } = bridge({
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: gatewayCall,
      releaseHostProcess,
    });
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();
    let completeReceipt: (error: Error | null) => void = () => undefined;
    const responseWrite = vi
      .spyOn(hostResponses, 'send')
      .mockImplementationOnce((message, callback) => {
        hostResponses.peer?.emit('message', message);
        completeReceipt = callback;
        return false;
      });

    const pending = runtime.client.call(tool.toolRef, {});
    await vi.waitFor(() => expect(responseWrite).toHaveBeenCalledOnce());
    const quiesce = session.beginQuiesce({ deadlineMs: Date.now() + 10_000 });
    await expect(quiesce.result).resolves.toBe('drained');
    await quiesce.commit();
    expect(releaseHostProcess).toHaveBeenCalledOnce();

    completeReceipt(null);
    await expect(pending).rejects.toMatchObject({
      code: 'SERVICE_RESTARTED',
      disposition: 'not_dispatched',
    });
    expect(gatewayCall).not.toHaveBeenCalled();

    runtime.close();
    await session.close();
    expect(releaseHostProcess).toHaveBeenCalledOnce();
  });

  it('waits for dispatched Gateway work and commits a terminal stale gate once', async () => {
    const handle = Object.freeze({}) as ConnectorToolHandle;
    let finishCall: (() => void) | undefined;
    const releaseHostProcess = vi.fn();
    const gatewayCall = vi.fn().mockImplementation(
      () =>
        new Promise<{ readonly resultJson: string }>((resolve) => {
          finishCall = () => resolve({ resultJson: '{"temperature":21}' });
        }),
    );
    const { runtime, session } = bridge({
      list: vi.fn().mockResolvedValue({
        tools: [
          {
            handle,
            provider: 'weather',
            providerToolName: 'forecast',
            runtimeToolName: 'weather_forecast',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      }),
      call: gatewayCall,
      releaseHostProcess,
    });
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected Host Connector inventory tool');
    session.activate();
    const pending = runtime.client.call(tool.toolRef, {});
    await vi.waitFor(() => expect(gatewayCall).toHaveBeenCalledOnce());

    const quiesce = session.beginQuiesce({ deadlineMs: Date.now() + 10_000 });
    await expectPendingAfterEventLoopTurn(quiesce.result);
    finishCall?.();
    await expect(pending).resolves.toMatchObject({ value: { temperature: 21 } });
    await expect(quiesce.result).resolves.toBe('drained');
    await quiesce.commit();
    expect(releaseHostProcess).toHaveBeenCalledOnce();
    expect(quiesce.resume()).toBe(false);

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'SERVICE_RESTARTED',
      disposition: 'not_dispatched',
    });
    expect(gatewayCall).toHaveBeenCalledOnce();
    await session.retire();
    await session.close();
    expect(releaseHostProcess).toHaveBeenCalledOnce();
    runtime.close();
  });

  it('invalidates a pending quiesce when retirement starts', async () => {
    const releaseHostProcess = vi.fn();
    const { runtime, session } = bridge({
      list: vi.fn(),
      call: vi.fn(),
      releaseHostProcess,
    });
    session.activate();

    const quiesce = session.beginQuiesce({ deadlineMs: Date.now() + 10_000 });
    const retiring = session.retire();
    expect(quiesce.resume()).toBe(false);
    await expect(quiesce.result).resolves.toBe('busy');
    await retiring;
    expect(releaseHostProcess).toHaveBeenCalledOnce();
    runtime.close();
    await session.close();
  });
});

describe('Mini App Host Connector Gateway dispatch integration', () => {
  it.each([
    {
      label: 'provider preflight',
      audit: undefined,
      callTool: (() => {
        throw new Error('provider preflight failed synchronously');
      }) as HostProcessConnectorCloudClient['callTool'],
    },
    {
      label: 'admission audit',
      audit: {
        record: () => {
          throw new Error('audit failed synchronously');
        },
      },
      callTool: vi.fn<HostProcessConnectorCloudClient['callTool']>(),
    },
  ])('keeps a synchronous $label failure retryable and not dispatched', async (fixture) => {
    const gateway = new HostConnectorGateway({
      client: {
        listConnectedTools: vi.fn(async () => ({
          tools: [
            {
              provider: 'weather',
              providerToolName: 'forecast',
              runtimeToolName: 'weather_forecast',
              inputSchemaJson: '{}',
            },
          ],
          providerFailures: [],
          partial: false,
        })),
        callTool: fixture.callTool,
      },
      credentialGetter: () => ({ accessToken: 'token', realUserID: 'user' }),
      ...(fixture.audit ? { audit: fixture.audit } : {}),
    });
    const { runtime, session } = bridge(gateway);
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected a Host Connector tool');
    session.activate();

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'CONNECTOR_UNAVAILABLE',
      disposition: 'not_dispatched',
      retryable: true,
      invocationId: 'invocation-real-1',
    });

    runtime.close();
    await session.close();
    await gateway.close();
  });

  it('preserves the Gateway unknown outcome when timeout follows provider dispatch', async () => {
    const gateway = new HostConnectorGateway({
      client: {
        listConnectedTools: vi.fn(async () => ({
          tools: [
            {
              provider: 'weather',
              providerToolName: 'forecast',
              runtimeToolName: 'weather_forecast',
              inputSchemaJson: '{}',
            },
          ],
          providerFailures: [],
          partial: false,
        })),
        callTool: vi.fn<HostProcessConnectorCloudClient['callTool']>((input) => {
          input.onDispatch();
          return rejectWithAbortReason(input.signal);
        }),
      },
      credentialGetter: () => ({ accessToken: 'token', realUserID: 'user' }),
    });
    const { runtime, session } = bridge(gateway, { requestTimeoutMs: 5 });
    const tool = (await runtime.client.list()).tools[0];
    if (!tool) throw new Error('Expected a Host Connector tool');
    session.activate();

    await expect(runtime.client.call(tool.toolRef, {})).rejects.toMatchObject({
      code: 'CONNECTOR_OUTCOME_UNKNOWN',
      disposition: 'unknown_after_dispatch',
      retryable: false,
      invocationId: 'invocation-real-1',
    });

    runtime.close();
    await session.close();
    await gateway.close();
  });
});
function rejectWithAbortReason(signal?: AbortSignal): Promise<never> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function rejectWithGatewayOutcomeOnAbort(
  signal: AbortSignal | undefined,
  invocationId: string,
): Promise<never> {
  if (signal?.aborted) {
    return Promise.reject(
      new ConnectorGatewayError(
        'CONNECTOR_CALL_FAILED',
        'provider outcome unknown',
        'unknown_after_dispatch',
        invocationId,
      ),
    );
  }
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () =>
        reject(
          new ConnectorGatewayError(
            'CONNECTOR_CALL_FAILED',
            'provider outcome unknown',
            'unknown_after_dispatch',
            invocationId,
          ),
        ),
      { once: true },
    );
  });
}


const AGENT_ALLOWLIST: MiniAppAgentPolicy = {
  kind: 'allowlist',
  capabilities: ['session.run'],
  maxConcurrent: 6,
};

const AGENT_EVENT = {
  type: 'text.delta',
  sessionId: 'session-1',
  turnId: 'turn-1',
  text: 'hel',
} as const satisfies MiniAppAgentRunEvent;

const TOOL_FINISHED = {
  type: 'tool.finished',
  sessionId: 'session-1',
  turnId: 'turn-1',
  name: 'read',
  ok: true,
} as const satisfies MiniAppAgentRunEvent;

const TURN_FINISHED = {
  type: 'turn.finished',
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'finished',
  text: 'hello',
} as const satisfies MiniAppAgentRunEvent;

const AGENT_RESULT: MiniAppAgentRunResult = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'finished',
  text: 'hello',
};

const PERMISSION_REQUESTED = {
  type: 'permission.requested',
  sessionId: 'session-1',
  turnId: 'turn-2',
  requestId: 'permission-1',
  toolName: 'bash',
  toolInput: '{"command":"ls"}',
  reason: 'Run a shell command',
} as const satisfies MiniAppAgentRunEvent;

const QUESTIONNAIRE = {
  schemaVersion: 2,
  id: 'question-2',
  presentation: { replaceComposer: true, showProgress: true, allowBackNavigation: true },
  steps: [
    {
      id: 'step-1',
      question: 'Which city?',
      selectionMode: 'single',
      options: [{ id: 'sh', label: 'Shanghai' }],
      allowOther: true,
      otherPlaceholder: 'Others...',
      required: true,
    },
  ],
} as const;

const QUESTION_REQUESTED = {
  type: 'question.requested',
  sessionId: 'session-1',
  turnId: 'turn-2',
  requestId: 'question-2',
  mode: 'questionnaire',
  request: QUESTIONNAIRE,
} as unknown as MiniAppAgentRunEvent;

const ANSWER_RESULT: MiniAppAgentRunResult = {
  sessionId: 'session-1',
  turnId: 'turn-2',
  status: 'finished',
  pendingQuestion: {
    requestId: 'question-2',
    mode: 'questionnaire',
    request: QUESTIONNAIRE as unknown as AskQuestionnaireRequest,
  },
};

const ANSWERS = [
  { stepId: 'step-0', selectedOptionIds: ['yes'], selectedOther: false },
  { stepId: 'step-1', selectedOptionIds: [], selectedOther: true, otherText: 'Hangzhou' },
  { stepId: 'step-2', selectedOptionIds: [], selectedOther: false, skipped: true },
];

type AgentRunImplementation = (
  options: MiniAppAgentRunOptions | undefined,
) => Promise<MiniAppAgentRunResult>;

function agentBridge(
  options: {
    readonly run?: AgentRunImplementation;
    readonly answer?: AgentRunImplementation;
    readonly policy?: MiniAppAgentPolicy;
    readonly withoutGateway?: boolean;
    readonly requestTimeoutMs?: number;
    readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  } = {},
) {
  const releaseArena = vi.fn();
  const agentGateway = {
    registerArena: vi.fn(() => releaseArena),
    run: vi.fn(
      (
        _caller: Parameters<MiniAppAgentGateway['run']>[0],
        _input: Parameters<MiniAppAgentGateway['run']>[1],
        runOptions?: MiniAppAgentRunOptions,
      ) => (options.run ?? (async () => AGENT_RESULT))(runOptions),
    ),
    reply: vi.fn(
      async (
        _caller: Parameters<MiniAppAgentGateway['reply']>[0],
        _input: Parameters<MiniAppAgentGateway['reply']>[1],
      ): Promise<void> => undefined,
    ),
    answer: vi.fn(
      (
        _caller: Parameters<MiniAppAgentGateway['answer']>[0],
        _input: Parameters<MiniAppAgentGateway['answer']>[1],
        runOptions?: MiniAppAgentRunOptions,
      ) => (options.answer ?? (async () => ANSWER_RESULT))(runOptions),
    ),
    models: vi.fn(),
    agents: vi.fn(),
    create: vi.fn(),
    open: vi.fn(),
    panelOpened: vi.fn(),
    panelClosed: vi.fn(),
  } satisfies MiniAppAgentGateway;
  const connection = bridge(
    { list: vi.fn(), call: vi.fn(), releaseHostProcess: vi.fn() },
    {
      ...(options.withoutGateway ? {} : { agentGateway }),
      makeInvocationId: () => 'invocation-agent-1',
      providers: [],
      agentPolicy: options.policy ?? AGENT_ALLOWLIST,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    },
  );
  return { ...connection, agentGateway, releaseArena };
}

function resolveAbortedOnSignal(options: MiniAppAgentRunOptions | undefined) {
  return new Promise<MiniAppAgentRunResult>((resolve) => {
    options?.signal?.addEventListener(
      'abort',
      () => resolve({ sessionId: 'session-1', turnId: 'turn-1', status: 'aborted' }),
      { once: true },
    );
  });
}

function sentPayloads(transport: MemoryIpc) {
  const payloads: Record<string, unknown>[] = [];
  const send = transport.send.bind(transport);
  vi.spyOn(transport, 'send').mockImplementation((message, callback) => {
    payloads.push(message.payload as Record<string, unknown>);
    return send(message, callback);
  });
  return payloads;
}

/** Controlled session frames buffer before/after admission and release a pending reader on close. */
function controlledSessionFrames() {
  const frames: SessionFrame[] = [];
  let waiting: ((result: IteratorResult<SessionFrame>) => void) | undefined;
  let closed = false;
  const iterator: AsyncIterableIterator<SessionFrame> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    next() {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      const frame = frames.shift();
      return frame
        ? Promise.resolve({ done: false, value: frame })
        : new Promise((resolve) => {
            waiting = resolve;
          });
    },
    return() {
      closed = true;
      waiting?.({ done: true, value: undefined });
      waiting = undefined;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    iterator,
    push(frame: SessionFrame) {
      if (waiting) {
        const next = waiting;
        waiting = undefined;
        next({ done: false, value: frame });
      } else frames.push(frame);
    },
  };
}

/** Real admission, streaming and permission gate with controlled Turn/storage/approval ports. */
function controlledApprovalBridge() {
  const subscribers = new Set<{ next(event: GlobalEvent): void }>();
  const streams = new Map<string, ReturnType<typeof controlledSessionFrames>>();
  const terminated = new Set<string>();
  const approvalRuns: Promise<unknown>[] = [];
  let automaticApprovals = false;
  const gateway = createMiniAppAgentGateway({
    dataDir: '/unused-test-data',
    nowMs: Date.now,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  const pending = new Map<
    string,
    { sessionId: string; resolve(decision: 'allowOnce' | 'deny'): void }
  >();
  const approval = {
    listPending: () => [...pending].map(([requestId, { sessionId }]) => ({ requestId, sessionId })),
    request(input: Parameters<LocalTurnPermissionApprovalOwner['request']>[0]) {
      const requestId = `permission-${input.sessionId}`;
      return new Promise<'allowOnce' | 'deny'>((resolve) => {
        pending.set(requestId, { sessionId: input.sessionId, resolve });
        const event = {
          type: 'permission.ask',
          payload: {
            ...input,
            requestId,
            toolInput: JSON.stringify(input.toolInput),
            createdAt: Date.now(),
          },
        } as unknown as GlobalEvent;
        for (const subscriber of subscribers) subscriber.next(event);
      });
    },
    async reply(requestIds: readonly string[], decision: 'allowOnce' | 'deny') {
      const processed: string[] = [];
      for (const requestId of requestIds) {
        const request = pending.get(requestId);
        if (!request) continue;
        pending.delete(requestId);
        request.resolve(decision);
        processed.push(requestId);
      }
      return { processed };
    },
    abortSession(sessionId: string) {
      for (const [requestId, request] of pending) {
        if (request.sessionId !== sessionId) continue;
        pending.delete(requestId);
        request.resolve('deny');
      }
    },
  };
  const gate = new LocalTurnPermissionGate({
    decisions: {
      check: async () => ({
        behavior: 'ask',
        reason: 'Approve controlled work',
        ruleContents: ['review-command'],
      }),
    },
    approval,
    miniAppApprovals: gateway,
  });
  const terminal = (sessionId: string, status: 'completed' | 'aborted') => {
    if (terminated.has(sessionId)) return;
    terminated.add(sessionId);
    const turnId = `turn-${sessionId}`;
    streams.get(sessionId)?.push({
      identity: `terminal-${turnId}`,
      sessionId,
      turnId,
      kind: 'turn-terminal',
      data: { status },
      cursor: `cursor-${turnId}`,
      createdAtMs: Date.now(),
    });
  };
  const ask = (sessionId: string) => {
    const run = gate
      .beforeToolCall({
        sessionId,
        turnId: `turn-${sessionId}`,
        agentName: 'mavis',
        model: 'test/model',
        sessionLineage: { miniApp: true, parentSessionId: null },
        toolContext: {
          assistantMessage: {},
          toolCall: { id: `tool-${sessionId}`, name: 'bash', source: 'configured' },
          args: { command: 'review-command' },
          context: {},
        } as unknown as Parameters<LocalTurnPermissionGate['beforeToolCall']>[0]['toolContext'],
      })
      .then((result) => {
        terminal(sessionId, 'completed');
        return result;
      });
    approvalRuns.push(run);
  };
  const steer = vi.fn<MiniAppAgentSessionPortsOptions['turns']['steer']>(async ({ sessionId }) => {
    if (automaticApprovals) queueMicrotask(() => ask(sessionId));
    return {
      delivered: true,
      mode: 'activated',
      turnId: `turn-${sessionId}`,
      completion: new Promise(() => undefined),
    };
  });
  gateway.bind(
    createMiniAppAgentSessionPorts({
      records: {
        createInternalSession: async () => {
          throw new Error('Tests continue existing sessions');
        },
      },
      lifecycle: { mutateSession: async () => ({}) },
      repository: {
        get: async () => ({
          agentName: 'mavis',
          workspaceDir: '/unused-test-data',
          isDefaultWorkspace: false,
          parentSessionId: null,
          // This build persists Mini App ownership as the `purpose` label, not `miniAppOrigin`.
          purpose: 'miniapp:weather-board',
          effectiveModel: 'minimax/M3',
        }),
      },
      turns: {
        steer,
        abort: async ({ sessionId, turnId }) => {
          approval.abortSession(sessionId);
          terminal(sessionId, 'aborted');
          return { status: 'aborted', turnId: turnId ?? `turn-${sessionId}` };
        },
      },
      stream: {
        resume({ sessionId }) {
          const frames = controlledSessionFrames();
          streams.set(sessionId, frames);
          return frames.iterator;
        },
      },
      messages: { listTurn: async () => [] },
      questionnaires: { getPending: async () => undefined, reply: async () => ({ ok: true }) },
      permissions: {
        listPending: async () => approval.listPending(),
        reply: ({ requestIds, decision }) => approval.reply(requestIds, decision),
      },
      eventBus: {
        subscribe(subscriber) {
          subscribers.add(subscriber);
          return () => subscribers.delete(subscriber);
        },
      },
      logger: { warn: vi.fn() },
      models: { list: async () => [] },
      agents: { list: async () => [] },
      modelConfig: () => ({ dataDir: '/unused-test-data', provider: {} }),
      nowMs: Date.now,
    }),
  );
  const current = bridge(
    { list: vi.fn(), call: vi.fn(), releaseHostProcess: vi.fn() },
    {
      agentGateway: gateway,
      agentPolicy: { kind: 'allowlist', capabilities: ['session.run'], maxConcurrent: 4 },
      providers: [],
    },
  );
  current.session.activate();
  const started = () => steer.mock.calls.map(([input]) => input.sessionId);
  return {
    ...current,
    approval,
    approvalRuns,
    steer,
    started,
    startApprovals() {
      automaticApprovals = true;
      for (const sessionId of started()) ask(sessionId);
    },
  };
}

describe('Mini App Agent over the Host Connector channel', () => {
  it('streams admitted, event, and terminal frames and registers the arena on activate', async () => {
    const { agentGateway, hostRequests, releaseArena, runtime, session } = agentBridge({
      run: async (options) => {
        options?.onEvent?.(AGENT_EVENT);
        // Unrecognised or malformed events never leave the Host.
        options?.onEvent?.({ type: 'future.event', turnId: 'turn-1' } as never);
        options?.onEvent?.({ type: 'tool.finished', turnId: 'turn-1', name: 'read' } as never);
        options?.onEvent?.({ ...TOOL_FINISHED, extra: true } as never);
        options?.onEvent?.(TOOL_FINISHED);
        options?.onEvent?.(TURN_FINISHED);
        return AGENT_RESULT;
      },
    });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    expect(agentGateway.registerArena).toHaveBeenCalledWith({
      pluginId: 'weather-board',
      processGeneration: 'process-1',
      policy: AGENT_ALLOWLIST,
    });
    const events: MiniAppAgentRunEvent[] = [];

    await expect(
      runtime.agent.run(
        { text: 'hi', sessionId: 'session-1' },
        { onEvent: (event) => events.push(event) },
      ),
    ).resolves.toEqual(AGENT_RESULT);

    expect(agentGateway.run).toHaveBeenCalledWith(
      { pluginId: 'weather-board', processGeneration: 'process-1', source: 'process' },
      { text: 'hi', sessionId: 'session-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal), onEvent: expect.any(Function) }),
    );
    expect(events).toEqual([AGENT_EVENT, TOOL_FINISHED, TURN_FINISHED]);
    expect(hostFrames).toEqual([
      { v: 1, id: '1', receipt: 'admitted', invocationId: 'invocation-agent-1' },
      { v: 1, id: '1', event: AGENT_EVENT },
      { v: 1, id: '1', event: TOOL_FINISHED },
      { v: 1, id: '1', event: TURN_FINISHED },
      { v: 1, id: '1', ok: true, result: AGENT_RESULT },
    ]);

    await session.retire();
    expect(releaseArena).toHaveBeenCalledOnce();
    await session.close();
    expect(releaseArena).toHaveBeenCalledOnce();
    runtime.close();
  });

  it('sends agent.cancel after the request was written and aborts the Gateway signal', async () => {
    let signal: AbortSignal | undefined;
    const { agentGateway, childResponses, runtime, session } = agentBridge({
      run: (options) => {
        signal = options?.signal;
        return resolveAbortedOnSignal(options);
      },
    });
    const childFrames = sentPayloads(childResponses);
    session.activate();
    const controller = new AbortController();

    const pending = runtime.agent.run({ text: 'hi' }, { signal: controller.signal });
    await vi.waitFor(() => expect(agentGateway.run).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).resolves.toMatchObject({ status: 'aborted' });
    expect(signal?.aborted).toBe(true);
    expect(childFrames).toEqual([
      { v: 1, id: '1', method: 'agent.run', params: { text: 'hi' } },
      { v: 1, id: '1', method: 'agent.cancel' },
    ]);
    runtime.close();
    await session.close();
  });

  it('denies runs without an allowlist or Gateway and gates runs before activation', async () => {
    const denied = agentBridge({ policy: { kind: 'deny-all' } });
    denied.session.activate();
    await expect(denied.runtime.agent.run({ text: 'hi' })).rejects.toMatchObject({
      name: 'MiniAppAgentError',
      code: 'NOT_PERMITTED',
      retryable: false,
    });
    expect(denied.agentGateway.registerArena).not.toHaveBeenCalled();
    expect(denied.agentGateway.run).not.toHaveBeenCalled();
    denied.runtime.close();
    await denied.session.close();

    const unwired = agentBridge({ withoutGateway: true });
    unwired.session.activate();
    await expect(unwired.runtime.agent.run({ text: 'hi' })).rejects.toMatchObject({
      code: 'NOT_PERMITTED',
    });
    unwired.runtime.close();
    await unwired.session.close();

    const candidate = agentBridge();
    await expect(candidate.runtime.agent.run({ text: 'hi' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
    await expect(candidate.runtime.agent.run({ text: 1 } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    expect(candidate.agentGateway.run).not.toHaveBeenCalled();
    candidate.runtime.close();
    await candidate.session.close();
  });

  it('forwards typed Gateway errors and exempts agent runs from the connector request timeout', async () => {
    const { agentGateway, runtime, session } = agentBridge({ requestTimeoutMs: 5 });
    session.activate();
    agentGateway.run.mockImplementationOnce(async () => {
      throw new MiniAppAgentError('BUSY', 'internal detail xyz', true);
    });
    await expect(runtime.agent.run({ text: 'hi' })).rejects.toMatchObject({
      code: 'BUSY',
      message: 'Mini App Agent is busy',
      retryable: true,
    });

    agentGateway.run.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(AGENT_RESULT), 30)),
    );
    await expect(runtime.agent.run({ text: 'slow' })).resolves.toEqual(AGENT_RESULT);
    runtime.close();
    await session.close();
  });

  it('releases the arena on Host failure and reports a written run as outcome unknown', async () => {
    let signal: AbortSignal | undefined;
    const { agentGateway, childResponses, fatal, hostRequests, releaseArena, runtime, session } =
      agentBridge({
        run: (options) => {
          signal = options?.signal;
          return new Promise(() => undefined);
        },
      });
    session.activate();
    const pending = runtime.agent.run({ text: 'hi' });
    await vi.waitFor(() => expect(agentGateway.run).toHaveBeenCalledOnce());

    hostRequests.emit('message', { type: 'miniapp:connector', unexpected: true });
    expect(fatal).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(releaseArena).toHaveBeenCalledOnce();
    childResponses.emit('disconnect');

    await expect(pending).rejects.toMatchObject({
      name: 'MiniAppAgentError',
      code: 'AGENT_OUTCOME_UNKNOWN',
      retryable: false,
    });
    await session.close();
    expect(releaseArena).toHaveBeenCalledOnce();
  });

  it('ignores agent events of an unknown type from a newer Host', async () => {
    const input = new MemoryIpc();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
    const events: MiniAppAgentRunEvent[] = [];
    const pending = runtime.agent.run({ text: 'hi' }, { onEvent: (event) => events.push(event) });
    input.receive({ v: 1, id: '1', receipt: 'admitted', invocationId: 'invocation-agent-1' });
    input.receive({ v: 1, id: '1', event: { type: 'future.event', turnId: 'turn-1', x: 1 } });
    input.receive({ v: 1, id: '1', event: AGENT_EVENT });
    input.receive({ v: 1, id: '1', ok: true, result: AGENT_RESULT });

    await expect(pending).resolves.toEqual(AGENT_RESULT);
    expect(events).toEqual([AGENT_EVENT]);
    runtime.close();
  });

  it('ignores notifications addressed to connector requests', async () => {
    const input = new MemoryIpc();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
    const pending = runtime.client.list();
    input.receive({ v: 1, id: '1', event: AGENT_EVENT });
    input.receive({ v: 1, id: '1', ok: true, result: { tools: [], partial: false } });
    await expect(pending).resolves.toEqual({ tools: [], partial: false });
    runtime.close();
  });
});

describe('Mini App Agent approval capacity over the Host Connector channel', () => {
  it('answers approvals through real admission with a full run queue and completes the batch in FIFO order', async () => {
    const current = controlledApprovalBridge();
    const events: MiniAppAgentRunEvent[] = [];
    const replies: Promise<unknown>[] = [];
    const calls = Array.from({ length: NODE_PENDING_LIMIT }, (_, index) =>
      current.runtime.agent.run(
        { sessionId: `session-${index + 1}`, text: 'Run controlled work' },
        {
          onEvent(event) {
            events.push(event);
            if (event.type === 'permission.requested') {
              replies.push(
                current.runtime.agent
                  .reply({
                    sessionId: event.sessionId,
                    requestId: event.requestId,
                    decision: 'allowOnce',
                  })
                  .catch((error: unknown) => error),
              );
            }
          },
        },
      ),
    );
    const settled = Promise.allSettled(calls);
    const outcomes: unknown[] = [];
    calls.forEach(
      (call) =>
        void call.then(
          (result) => outcomes.push(result),
          (error: unknown) => outcomes.push(error),
        ),
    );
    try {
      await vi.waitFor(() => {
        expect(current.started()).toEqual(['session-1', 'session-2', 'session-3', 'session-4']);
        expect(events.filter((event) => event.type === 'run.queued')).toHaveLength(12);
      });
      current.startApprovals();
      await vi.waitFor(() => expect(outcomes).toHaveLength(NODE_PENDING_LIMIT));
      await expect(Promise.all(replies)).resolves.toEqual(
        Array.from({ length: NODE_PENDING_LIMIT }, () => undefined),
      );
      expect(current.started()).toEqual(
        Array.from({ length: NODE_PENDING_LIMIT }, (_, index) => `session-${index + 1}`),
      );
      await expect(Promise.all(calls)).resolves.toEqual(
        Array.from({ length: NODE_PENDING_LIMIT }, () =>
          expect.objectContaining({ status: 'finished' }),
        ),
      );
      expect(current.approval.listPending()).toEqual([]);
      expect(current.fatal).not.toHaveBeenCalled();
    } finally {
      current.runtime.close();
      await current.session.close();
      await settled;
      await Promise.allSettled(current.approvalRuns);
    }
    expect(current.approval.listPending()).toEqual([]);
  });

  it('cancels a Node call in the full queue and closes the remaining calls', async () => {
    const current = controlledApprovalBridge();
    const controller = new AbortController();
    const calls = Array.from({ length: NODE_PENDING_LIMIT }, (_, index) =>
      current.runtime.agent.run(
        { sessionId: `session-${index + 1}`, text: 'Work' },
        index === NODE_PENDING_LIMIT - 1 ? { signal: controller.signal } : undefined,
      ),
    );
    const settled = Promise.allSettled(calls);
    try {
      await vi.waitFor(() => expect(current.started()).toHaveLength(4));
      controller.abort();
      await expect(calls[NODE_PENDING_LIMIT - 1]).rejects.toMatchObject({
        code: 'REQUEST_CANCELLED',
      });
      expect(current.started()).not.toContain(`session-${NODE_PENDING_LIMIT}`);
      expect(current.fatal).not.toHaveBeenCalled();
    } finally {
      current.runtime.close();
      await current.session.close();
    }
    expect((await settled).every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(current.approval.listPending()).toEqual([]);
  });

  it('carries session_busy from the real session ports when the Host already runs the session', async () => {
    const current = controlledApprovalBridge();
    current.steer.mockResolvedValueOnce({
      delivered: true,
      mode: 'steered',
      turnId: 'host-turn',
    });
    try {
      await expect(
        current.runtime.agent.run({ sessionId: 'session-1', text: 'Continue' }),
      ).rejects.toMatchObject({ code: 'BUSY', reason: 'session_busy', retryable: true });
      expect(current.fatal).not.toHaveBeenCalled();
    } finally {
      current.runtime.close();
      await current.session.close();
    }
  });

  it('bounds replies separately without taking run or Connector capacity, and releases both on close', async () => {
    const input = new MemoryIpc();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
    const replies = Array.from({ length: NODE_REPLY_PENDING_LIMIT }, () =>
      runtime.agent.reply({ sessionId: 'session-1', requestId: 'permission-1', decision: 'deny' }),
    );
    const normal = [
      ...Array.from({ length: 8 }, () => runtime.client.list()),
      ...Array.from({ length: 4 }, () => runtime.agent.run({ text: 'Work' })),
      ...Array.from({ length: 4 }, () =>
        runtime.agent.answer({ sessionId: 'session-1', requestId: 'question-1', answers: [] }),
      ),
    ];
    const settled = Promise.allSettled([...replies, ...normal]);
    await expect(
      runtime.agent.reply({ sessionId: 's', requestId: 'p', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    await expect(runtime.client.list()).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
    await expect(runtime.agent.run({ text: 'Overflow' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
    input.receive({ v: 1, id: '1', ok: true, result: null });
    input.receive({
      v: 1,
      id: String(NODE_REPLY_PENDING_LIMIT + 1),
      ok: true,
      result: { tools: [], partial: false },
    });
    await expect(replies[0]).resolves.toBeUndefined();
    await expect(normal[0]).resolves.toEqual({ tools: [], partial: false });
    const replacement = Promise.allSettled([
      runtime.agent.reply({ sessionId: 's', requestId: 'p', decision: 'deny' }),
      runtime.client.list(),
    ]);
    runtime.close();
    expect((await settled).filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
    expect((await replacement).every((outcome) => outcome.status === 'rejected')).toBe(true);
  });

  it.each(['agent.reply', 'agent.run'] as const)(
    'fails a raw Host request beyond the independent %s budget',
    async (overflowMethod) => {
      const current = agentBridge({ run: resolveAbortedOnSignal });
      current.agentGateway.reply.mockImplementation(() => new Promise(() => undefined));
      current.session.activate();
      current.runtime.close();
      const request = (id: number, method: 'agent.reply' | 'agent.run') => ({
        v: 1,
        id: String(id),
        method,
        params:
          method === 'agent.reply'
            ? { sessionId: 'session-1', requestId: `permission-${id}`, decision: 'deny' }
            : { text: 'Work' },
      });
      for (let index = 1; index <= NODE_PENDING_LIMIT; index += 1) {
        current.hostRequests.receive(request(index, 'agent.run'));
      }
      for (let index = 1; index <= NODE_REPLY_PENDING_LIMIT; index += 1) {
        current.hostRequests.receive(request(NODE_PENDING_LIMIT + index, 'agent.reply'));
      }
      await vi.waitFor(() => {
        expect(current.agentGateway.run).toHaveBeenCalledTimes(NODE_PENDING_LIMIT);
        expect(current.agentGateway.reply).toHaveBeenCalledTimes(NODE_REPLY_PENDING_LIMIT);
      });
      expect(current.fatal).not.toHaveBeenCalled();
      current.hostRequests.receive(
        request(NODE_PENDING_LIMIT + NODE_REPLY_PENDING_LIMIT + 1, overflowMethod),
      );
      expect(current.fatal).toHaveBeenCalledOnce();
      await current.session.close();
      expect(current.releaseArena).toHaveBeenCalledOnce();
    },
  );
});

describe('Mini App Agent run queue over the Host Connector channel', () => {
  it('carries the BUSY reason to the child and never a reason on another code', async () => {
    const { agentGateway, hostRequests, runtime, session } = agentBridge();
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    agentGateway.run.mockRejectedValueOnce(
      new MiniAppAgentError('BUSY', 'internal detail', true, 'queue_full'),
    );
    agentGateway.answer.mockRejectedValueOnce(
      new MiniAppAgentError('REQUEST_CANCELLED', 'internal detail', false, 'session_busy'),
    );

    await expect(runtime.agent.run({ text: 'hi' })).rejects.toMatchObject({
      name: 'MiniAppAgentError',
      code: 'BUSY',
      message: 'Mini App Agent is busy',
      retryable: true,
      reason: 'queue_full',
    });
    const cancelled = runtime.agent.answer({ sessionId: 's', requestId: 'q', answers: [] });
    await expect(cancelled).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await expect(cancelled).rejects.not.toHaveProperty('reason');
    expect(hostFrames.filter((frame) => frame.ok === false).map((frame) => frame.error)).toEqual([
      { code: 'BUSY', message: 'Mini App Agent is busy', retryable: true, reason: 'queue_full' },
      { code: 'REQUEST_CANCELLED', message: 'Mini App Agent run was cancelled', retryable: false },
    ]);
    runtime.close();
    await session.close();
  });

  it('fails the generation on a reason the child cannot read', async () => {
    const busy = { code: 'BUSY', message: 'Mini App Agent is busy', retryable: true };
    for (const error of [
      { ...busy, reason: 'later' },
      { ...busy, code: 'AGENT_UNAVAILABLE', reason: 'queue_full' },
    ]) {
      const input = new MemoryIpc();
      const onFatal = vi.fn();
      const client = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
      const run = client.agent.run({ text: 'hi' });
      input.receive({ v: 1, id: '1', ok: false, error });
      await expect(run).rejects.toMatchObject({ name: 'MiniAppAgentError' });
      expect(onFatal).toHaveBeenCalledOnce();
      client.close();
    }
  });

  it('delivers run.queued to the child with and without a sessionId', async () => {
    const queued = { type: 'run.queued', position: 2 } as const;
    const continued = { type: 'run.queued', sessionId: 'session-1', position: 1 } as const;
    const { hostRequests, runtime, session } = agentBridge({
      run: async (options) => {
        options?.onEvent?.(queued);
        options?.onEvent?.(continued);
        // Malformed ones never leave the Host.
        options?.onEvent?.({ ...queued, position: 0 });
        options?.onEvent?.({ ...continued, turnId: 'turn-1' } as never);
        options?.onEvent?.(AGENT_EVENT);
        return AGENT_RESULT;
      },
    });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    await runtime.agent.run({ text: 'hi' }, { onEvent: (event) => events.push(event) });

    expect(events).toEqual([queued, continued, AGENT_EVENT]);
    expect(hostFrames.filter((frame) => 'event' in frame)).toHaveLength(3);
    runtime.close();
    await session.close();

    const input = new MemoryIpc();
    const onFatal = vi.fn();
    const client = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
    const run = client.agent.run({ text: 'hi' }, { onEvent: vi.fn() });
    input.receive({ v: 1, id: '1', event: { ...queued, position: 1.5 } });
    await expect(run).rejects.toMatchObject({ name: 'MiniAppAgentError' });
    expect(onFatal).toHaveBeenCalledOnce();
    client.close();
  });
});

describe('Mini App Agent runs across a cutover', () => {
  it('keeps in-flight runs through a quiesce and aborts them only when the cutover commits', async () => {
    let signal: AbortSignal | undefined;
    const { agentGateway, releaseArena, runtime, session } = agentBridge({
      run: (options) => {
        signal = options?.signal;
        return resolveAbortedOnSignal(options);
      },
    });
    session.activate();
    const pending = runtime.agent.run({ text: 'hi' });
    await vi.waitFor(() => expect(agentGateway.run).toHaveBeenCalledOnce());

    const quiesce = session.beginQuiesce({ deadlineMs: Date.now() + 10_000 });
    await expect(quiesce.result).resolves.toBe('drained');
    expect(signal?.aborted).toBe(false);
    expect(releaseArena).not.toHaveBeenCalled();
    await quiesce.commit();
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'aborted' });
    expect(releaseArena).toHaveBeenCalledOnce();
    await expect(runtime.agent.run({ text: 'again' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
      retryable: true,
    });
    runtime.close();
    await session.close();
  });

  it('lets an in-flight run finish normally when a quiesce is busy or its cutover is cancelled', async () => {
    let signal: AbortSignal | undefined;
    let finishRun: (() => void) | undefined;
    const { agentGateway, releaseArena, runtime, session } = agentBridge({
      run: (options) => {
        signal = options?.signal;
        return new Promise((resolve) => {
          finishRun = () => resolve(AGENT_RESULT);
        });
      },
    });
    session.activate();
    const pending = runtime.agent.run({ text: 'hi' });
    await vi.waitFor(() => expect(agentGateway.run).toHaveBeenCalledOnce());

    const expired = session.beginQuiesce({ deadlineMs: Date.now() });
    await expect(expired.result).resolves.toBe('busy');
    expect(expired.resume()).toBe(true);
    const cancelled = session.beginQuiesce({ deadlineMs: Date.now() + 10_000 });
    await expect(cancelled.result).resolves.toBe('drained');
    expect(cancelled.resume()).toBe(true);

    expect(signal?.aborted).toBe(false);
    finishRun?.();
    await expect(pending).resolves.toEqual(AGENT_RESULT);
    expect(releaseArena).not.toHaveBeenCalled();
    runtime.close();
    await session.close();
  });
});

describe('Mini App Agent child-side event delivery', () => {
  it('reports a throwing onEvent handler on stderr and keeps the run going', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const input = new MemoryIpc();
    const onFatal = vi.fn();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
    const events: MiniAppAgentRunEvent[] = [];
    const pending = runtime.agent.run(
      { text: 'hi' },
      {
        onEvent: (event) => {
          events.push(event);
          if (events.length === 1) throw new Error('author handler bug');
        },
      },
    );
    input.receive({ v: 1, id: '1', receipt: 'admitted', invocationId: 'invocation-agent-1' });
    input.receive({ v: 1, id: '1', event: AGENT_EVENT });
    input.receive({ v: 1, id: '1', event: TOOL_FINISHED });
    input.receive({ v: 1, id: '1', ok: true, result: AGENT_RESULT });

    try {
      await expect(pending).resolves.toEqual(AGENT_RESULT);
      expect(events).toEqual([AGENT_EVENT, TOOL_FINISHED]);
      expect(onFatal).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledOnce();
      expect(String(stderr.mock.calls[0]?.[0])).toMatch(
        /^\[miniapp\] agent onEvent handler threw Error: author handler bug/u,
      );
    } finally {
      stderr.mockRestore();
      runtime.close();
    }
  });
});

describe('Mini App Agent observation and turn identity over the Host Connector channel', () => {
  it('hands the Gateway a listener only when the child observes the run', async () => {
    const { agentGateway, childResponses, hostRequests, runtime, session } = agentBridge({
      run: async (options) => {
        options?.onEvent?.(AGENT_EVENT);
        return AGENT_RESULT;
      },
    });
    const childFrames = sentPayloads(childResponses);
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    const answer = { sessionId: 'session-1', requestId: 'question-1', answers: [] };

    await runtime.agent.run({ text: 'unobserved' });
    await runtime.agent.answer(answer);
    expect(agentGateway.run.mock.calls[0]?.[2]).not.toHaveProperty('onEvent');
    expect(agentGateway.answer.mock.calls[0]?.[2]).not.toHaveProperty('onEvent');
    expect(hostFrames.filter((frame) => 'event' in frame)).toEqual([]);

    const events: MiniAppAgentRunEvent[] = [];
    const onEvent = (event: MiniAppAgentRunEvent) => events.push(event);
    await runtime.agent.run({ text: 'observed' }, { onEvent });
    await runtime.agent.answer(answer, { onEvent });
    expect(agentGateway.run.mock.calls[1]?.[2]?.onEvent).toEqual(expect.any(Function));
    expect(agentGateway.answer.mock.calls[1]?.[2]?.onEvent).toEqual(expect.any(Function));
    expect(events).toEqual([AGENT_EVENT]);

    expect(
      childFrames.filter((frame) => frame.method !== 'agent.cancel').map((frame) => frame.params),
    ).toEqual([
      { text: 'unobserved' },
      answer,
      { text: 'observed', observe: true },
      { ...answer, observe: true },
    ]);
    runtime.close();
    await session.close();
  });

  it('fails the generation when a child sends a non-boolean observe flag', async () => {
    for (const request of [
      { method: 'agent.run', params: { text: 'hi', observe: 'yes' } },
      {
        method: 'agent.answer',
        params: { sessionId: 'session-1', requestId: 'question-1', answers: [], observe: 1 },
      },
    ]) {
      const { agentGateway, fatal, hostRequests, runtime, session } = agentBridge();
      session.activate();
      hostRequests.receive({ v: 1, id: '1', ...request });
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
      expect(agentGateway.run).not.toHaveBeenCalled();
      expect(agentGateway.answer).not.toHaveBeenCalled();
      runtime.close();
      await session.close();
    }
  });

  it('accepts a missing turnId on a permission request and a result, but never an empty one', async () => {
    const input = new MemoryIpc();
    const runtime = createMiniAppHostConnectorRuntimeClient({ transport: input });
    const events: MiniAppAgentRunEvent[] = [];
    const permission: Record<string, unknown> = { ...PERMISSION_REQUESTED };
    delete permission.turnId;
    const result = { sessionId: 'session-1', status: 'aborted' };
    const pending = runtime.agent.run({ text: 'hi' }, { onEvent: (event) => events.push(event) });
    input.receive({ v: 1, id: '1', receipt: 'admitted', invocationId: 'invocation-agent-1' });
    input.receive({ v: 1, id: '1', event: permission });
    input.receive({ v: 1, id: '1', ok: true, result });
    await expect(pending).resolves.toEqual(result);
    expect(events).toEqual([permission]);
    runtime.close();

    for (const frame of [
      { event: { ...PERMISSION_REQUESTED, turnId: '' } },
      { ok: true, result: { ...result, turnId: '' } },
    ]) {
      const current = new MemoryIpc();
      const onFatal = vi.fn();
      const client = createMiniAppHostConnectorRuntimeClient({ transport: current, onFatal });
      const run = client.agent.run({ text: 'hi' }, { onEvent: vi.fn() });
      current.receive({ v: 1, id: '1', ...frame });
      await expect(run).rejects.toMatchObject({ name: 'MiniAppAgentError' });
      expect(onFatal).toHaveBeenCalledOnce();
      client.close();
    }
  });

  it('never forwards an empty Gateway turnId in the result frame', async () => {
    const { hostRequests, runtime, session } = agentBridge({
      run: async () => ({ sessionId: 'session-1', turnId: '', status: 'aborted' }),
    });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    await expect(runtime.agent.run({ text: 'hi' })).resolves.toEqual({
      sessionId: 'session-1',
      status: 'aborted',
    });
    expect(hostFrames.at(-1)).toEqual({
      v: 1,
      id: '1',
      ok: true,
      result: { sessionId: 'session-1', status: 'aborted' },
    });
    runtime.close();
    await session.close();
  });
});

describe('Mini App Agent interaction over the Host Connector channel', () => {
  it('replies to a permission request with a short request settled by a null result', async () => {
    const { agentGateway, childResponses, hostRequests, runtime, session } = agentBridge();
    const childFrames = sentPayloads(childResponses);
    const hostFrames = sentPayloads(hostRequests);
    session.activate();

    await expect(
      runtime.agent.reply({ sessionId: 'session-1', requestId: 'permission-1', decision: 'deny' }),
    ).resolves.toBeUndefined();

    expect(agentGateway.reply).toHaveBeenCalledWith(
      { pluginId: 'weather-board', processGeneration: 'process-1', source: 'process' },
      { sessionId: 'session-1', requestId: 'permission-1', decision: 'deny' },
    );
    expect(childFrames).toEqual([
      {
        v: 1,
        id: '1',
        method: 'agent.reply',
        params: { sessionId: 'session-1', requestId: 'permission-1', decision: 'deny' },
      },
    ]);
    expect(hostFrames).toEqual([{ v: 1, id: '1', ok: true, result: null }]);

    agentGateway.reply.mockRejectedValueOnce(
      new MiniAppAgentError('REQUEST_NOT_FOUND', 'internal permission-1 detail'),
    );
    await expect(
      runtime.agent.reply({ sessionId: 'session-1', requestId: 'gone', decision: 'allowOnce' }),
    ).rejects.toMatchObject({
      name: 'MiniAppAgentError',
      code: 'REQUEST_NOT_FOUND',
      message: 'Mini App Agent request was not found or already settled',
      retryable: false,
    });
    runtime.close();
    await session.close();
  });

  it('reports a reply the Gateway did not settle within the request timeout as outcome unknown', async () => {
    const { agentGateway, runtime, session } = agentBridge({ requestTimeoutMs: 5 });
    session.activate();
    agentGateway.reply.mockImplementationOnce(() => new Promise<void>(() => undefined));

    await expect(
      runtime.agent.reply({ sessionId: 'session-1', requestId: 'permission-1', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'AGENT_OUTCOME_UNKNOWN' });
    runtime.close();
    await session.close();
  });

  it('rejects malformed reply and answer arguments without dispatching them', async () => {
    const { agentGateway, childResponses, runtime, session } = agentBridge();
    const childFrames = sentPayloads(childResponses);
    session.activate();
    const reply = { sessionId: 'session-1', requestId: 'permission-1', decision: 'allowOnce' };
    const answer = { sessionId: 'session-1', requestId: 'question-1', answers: ANSWERS };
    const step = { stepId: 'step-1', selectedOptionIds: [], selectedOther: false };

    for (const input of [
      { ...reply, decision: 'allowAlways' },
      { ...reply, decision: undefined },
      { ...reply, requestId: '' },
    ]) {
      await expect(runtime.agent.reply(input as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENTS',
      });
    }
    for (const answers of [
      'step-1',
      [{ ...step, extra: true }],
      [{ ...step, selectedOptionIds: [1] }],
      [{ ...step, selectedOther: 'no' }],
      [{ ...step, otherText: 3 }],
      [{ stepId: 'step-1', selectedOptionIds: [] }],
      [{ ...step, stepId: '' }],
      [{ ...step, otherText: 'x'.repeat(4_097) }],
      Array.from({ length: 65 }, () => step),
    ]) {
      await expect(runtime.agent.answer({ ...answer, answers } as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENTS',
      });
    }
    await expect(
      runtime.agent.answer({ ...answer, sessionId: undefined } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });

    expect(childFrames).toEqual([]);
    expect(agentGateway.reply).not.toHaveBeenCalled();
    expect(agentGateway.answer).not.toHaveBeenCalled();
    runtime.close();
    await session.close();
  });

  it('streams an answer continuation like a run, including interaction events', async () => {
    const { agentGateway, hostRequests, runtime, session } = agentBridge({
      answer: async (options) => {
        options?.onEvent?.(PERMISSION_REQUESTED);
        options?.onEvent?.(QUESTION_REQUESTED);
        return ANSWER_RESULT;
      },
    });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    await expect(
      runtime.agent.answer(
        { sessionId: 'session-1', requestId: 'question-1', answers: ANSWERS },
        { onEvent: (event) => events.push(event) },
      ),
    ).resolves.toEqual(ANSWER_RESULT);

    expect(agentGateway.answer).toHaveBeenCalledWith(
      { pluginId: 'weather-board', processGeneration: 'process-1', source: 'process' },
      { sessionId: 'session-1', requestId: 'question-1', answers: ANSWERS },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(events).toEqual([PERMISSION_REQUESTED, QUESTION_REQUESTED]);
    expect(hostFrames).toEqual([
      { v: 1, id: '1', receipt: 'admitted', invocationId: 'invocation-agent-1' },
      { v: 1, id: '1', event: PERMISSION_REQUESTED },
      { v: 1, id: '1', event: QUESTION_REQUESTED },
      { v: 1, id: '1', ok: true, result: ANSWER_RESULT },
    ]);
    runtime.close();
    await session.close();
  });

  it('cancels an answer continuation with agent.cancel and exempts it from the request timeout', async () => {
    let signal: AbortSignal | undefined;
    const { agentGateway, childResponses, runtime, session } = agentBridge({
      requestTimeoutMs: 5,
      answer: (options) => {
        signal = options?.signal;
        return resolveAbortedOnSignal(options);
      },
    });
    const childFrames = sentPayloads(childResponses);
    session.activate();
    const controller = new AbortController();

    const pending = runtime.agent.answer(
      { sessionId: 'session-1', requestId: 'question-1', answers: [] },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(agentGateway.answer).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(false);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ status: 'aborted' });
    expect(signal?.aborted).toBe(true);
    expect(childFrames.map((frame) => frame.method)).toEqual(['agent.answer', 'agent.cancel']);
    runtime.close();
    await session.close();
  });

  it('never sends a malformed interaction event', async () => {
    const malformed = [
      { ...QUESTION_REQUESTED, request: { ...QUESTIONNAIRE, schemaVersion: 1 } },
      { ...QUESTION_REQUESTED, request: { ...QUESTIONNAIRE, steps: undefined } },
      { ...QUESTION_REQUESTED, request: { ...QUESTIONNAIRE, id: '' } },
      { ...QUESTION_REQUESTED, request: 'question-2' },
      { ...QUESTION_REQUESTED, mode: 'goal' },
      { ...QUESTION_REQUESTED, extra: true },
      { ...QUESTION_REQUESTED, turnId: '' },
      { ...PERMISSION_REQUESTED, reason: undefined },
      { ...PERMISSION_REQUESTED, turnId: '' },
      { ...PERMISSION_REQUESTED, sessionId: '' },
      { ...TOOL_FINISHED, sessionId: undefined },
      { ...TOOL_FINISHED, turnId: '' },
    ];
    const withoutTurnId: Record<string, unknown> = { ...QUESTION_REQUESTED };
    delete withoutTurnId.turnId;
    const permissionWithoutTurnId: Record<string, unknown> = { ...PERMISSION_REQUESTED };
    delete permissionWithoutTurnId.turnId;
    const { hostRequests, runtime, session } = agentBridge({
      run: async (options) => {
        for (const event of malformed) options?.onEvent?.(event as never);
        options?.onEvent?.(withoutTurnId as never);
        options?.onEvent?.({ ...PERMISSION_REQUESTED, turnId: undefined } as never);
        return AGENT_RESULT;
      },
    });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    await runtime.agent.run({ text: 'hi' }, { onEvent: (event) => events.push(event) });

    expect(events).toEqual([withoutTurnId, permissionWithoutTurnId]);
    expect(hostFrames.filter((frame) => 'event' in frame)).toEqual([
      { v: 1, id: '1', event: withoutTurnId },
      { v: 1, id: '1', event: permissionWithoutTurnId },
    ]);
    runtime.close();
    await session.close();
  });
});

describe('Mini App Agent event backpressure', () => {
  it('drops progress frames beyond the queue bound but still delivers interaction and terminal frames', async () => {
    const logger = { warn: vi.fn() };
    let gatewayReturned = false;
    const { hostRequests, runtime, session } = agentBridge({
      logger,
      run: async (options) => {
        for (let index = 0; index < 300; index += 1) {
          options?.onEvent?.({ ...AGENT_EVENT, text: String(index) });
        }
        options?.onEvent?.(PERMISSION_REQUESTED);
        options?.onEvent?.(QUESTION_REQUESTED);
        gatewayReturned = true;
        return AGENT_RESULT;
      },
    });
    const held: Array<() => void> = [];
    let stalled = true;
    const send = hostRequests.send.bind(hostRequests);
    vi.spyOn(hostRequests, 'send').mockImplementation((message, callback) => {
      const payload = message.payload as Record<string, unknown>;
      if (stalled && 'event' in payload) {
        held.push(() => send(message, callback));
        return true;
      }
      return send(message, callback);
    });
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    const pending = runtime.agent.run({ text: 'hi' }, { onEvent: (event) => events.push(event) });
    await vi.waitFor(() => expect(gatewayReturned).toBe(true));
    expect(held).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
    stalled = false;
    for (const release of held.splice(0)) release();

    await expect(pending).resolves.toEqual(AGENT_RESULT);
    expect(logger.warn).toHaveBeenCalledWith(
      { pluginId: 'weather-board', processGeneration: 'process-1', droppedEvents: 44 },
      'Mini App Agent run dropped event frames',
    );
    expect(events).toHaveLength(258);
    expect(events.slice(-2)).toEqual([PERMISSION_REQUESTED, QUESTION_REQUESTED]);
    runtime.close();
    await session.close();
  });
});

describe('Mini App Agent interaction frames the Host cannot send', () => {
  it('warns at once and denies an approval whose frame is dropped, so the turn does not hang', async () => {
    const logger = { warn: vi.fn() };
    let warnedBeforeReturn: unknown[][] = [];
    const permission = {
      ...PERMISSION_REQUESTED,
      toolInput: 'x'.repeat(RESPONSE_MAX_BYTES + 1),
    } satisfies MiniAppAgentRunEvent;
    const question = {
      ...QUESTION_REQUESTED,
      request: { ...QUESTIONNAIRE, steps: [{ ...QUESTIONNAIRE.steps[0], weight: 1n }] },
    } as unknown as MiniAppAgentRunEvent;
    let denied: (() => void) | undefined;
    const deniedOnce = new Promise<void>((resolve) => {
      denied = resolve;
    });
    const { agentGateway, hostRequests, runtime, session } = agentBridge({
      logger,
      run: async (options) => {
        options?.onEvent?.(question);
        options?.onEvent?.(permission);
        // The turn only continues once the dropped approval is settled.
        await deniedOnce;
        warnedBeforeReturn = [...logger.warn.mock.calls];
        return AGENT_RESULT;
      },
    });
    agentGateway.reply.mockImplementationOnce(async () => {
      denied?.();
    });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    await expect(
      runtime.agent.run({ text: 'hi' }, { onEvent: (event) => events.push(event) }),
    ).resolves.toEqual(AGENT_RESULT);

    const identity = { pluginId: 'weather-board', processGeneration: 'process-1' };
    const message = 'Mini App Agent run dropped an interaction event frame';
    expect(warnedBeforeReturn).toEqual([
      [
        {
          ...identity,
          sessionId: 'session-1',
          requestId: 'question-2',
          type: 'question.requested',
          reason: 'serialize_failed',
        },
        message,
      ],
      [
        {
          ...identity,
          sessionId: 'session-1',
          requestId: 'permission-1',
          type: 'permission.requested',
          reason: 'oversized',
        },
        message,
      ],
    ]);
    expect(agentGateway.reply).toHaveBeenCalledOnce();
    expect(agentGateway.reply).toHaveBeenCalledWith(
      { ...identity, source: 'process' },
      { sessionId: 'session-1', requestId: 'permission-1', decision: 'deny' },
    );
    expect(events).toEqual([]);
    expect(hostFrames.filter((frame) => 'event' in frame)).toEqual([]);
    expect(logger.warn).toHaveBeenLastCalledWith(
      { ...identity, droppedEvents: 2 },
      'Mini App Agent run dropped event frames',
    );
    runtime.close();
    await session.close();
  });

  it('warns when the Host cannot deny a dropped approval', async () => {
    const logger = { warn: vi.fn() };
    const { agentGateway, runtime, session } = agentBridge({
      logger,
      run: async (options) => {
        options?.onEvent?.({ ...PERMISSION_REQUESTED, toolInput: 'x'.repeat(RESPONSE_MAX_BYTES) });
        return AGENT_RESULT;
      },
    });
    agentGateway.reply.mockRejectedValueOnce(new MiniAppAgentError('REQUEST_NOT_FOUND', 'gone'));
    session.activate();

    await runtime.agent.run({ text: 'hi' }, { onEvent: vi.fn() });

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'permission-1',
          reason: 'oversized',
          errorName: 'MiniAppAgentError',
        }),
        'Mini App Agent could not deny a dropped permission request',
      ),
    );
    runtime.close();
    await session.close();
  });
});

describe('Mini App Agent thinking-off model over the Host Connector channel', () => {
  const TURN_STARTED = { type: 'turn.started', sessionId: 'session-1', turnId: 'turn-1' } as const;

  it('round-trips variant "" (thinking off) in turn.started, results, run input and models', async () => {
    const off = { providerId: 'p', modelId: 'm', variant: '' };
    const { agentGateway, runtime, session } = agentBridge({
      run: async (options) => {
        options?.onEvent?.({ ...TURN_STARTED, model: off } as never);
        return { ...AGENT_RESULT, model: off };
      },
    });
    agentGateway.models.mockResolvedValue({
      models: [{ providerId: 'p', modelId: 'm', displayName: 'M' }],
      default: off,
      host: off,
    });
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    const result = await runtime.agent.run(
      { text: 'hi', model: off },
      { onEvent: (event) => events.push(event) },
    );

    expect(agentGateway.run.mock.calls[0]?.[1]).toMatchObject({ model: off });
    expect(events).toEqual([{ ...TURN_STARTED, model: off }]);
    expect(result.model).toEqual(off);
    await expect(runtime.agent.models()).resolves.toMatchObject({ default: off, host: off });
    runtime.close();
    await session.close();
  });
});

describe('Mini App Agent model, agents and create over the Host Connector channel', () => {
  const MODEL = { providerId: 'p', modelId: 'm', variant: 'fast', thinking: { effort: 'high' } };
  const MODELS = {
    models: [{ providerId: 'p', modelId: 'm', displayName: 'M', variants: ['fast'] }],
    default: { providerId: 'p', modelId: 'm' },
  };
  const AGENTS = { agents: [{ name: 'mavis', displayName: 'Mavis', primary: true }] };
  const TURN_STARTED = { type: 'turn.started', sessionId: 'session-1', turnId: 'turn-1' } as const;
  const CALLER = { pluginId: 'weather-board', processGeneration: 'process-1', source: 'process' };

  it('hands run and answer model and agent to the Gateway and returns the dispatched model', async () => {
    const result = { ...AGENT_RESULT, model: MODEL };
    const { agentGateway, runtime, session } = agentBridge({ run: async () => result });
    session.activate();
    const answer = { sessionId: 'session-1', requestId: 'question-1', answers: [] };

    await expect(runtime.agent.run({ text: 'hi', model: MODEL, agent: 'writer' })).resolves.toEqual(
      result,
    );
    await runtime.agent.answer({ ...answer, model: MODEL });

    expect(agentGateway.run.mock.calls[0]?.[1]).toEqual({
      text: 'hi',
      model: MODEL,
      agent: 'writer',
    });
    expect(agentGateway.answer.mock.calls[0]?.[1]).toEqual({ ...answer, model: MODEL });
    runtime.close();
    await session.close();
  });

  it('rejects a malformed model or agent before sending and fails the generation on a raw one', async () => {
    const { agentGateway, childResponses, runtime, session } = agentBridge();
    const childFrames = sentPayloads(childResponses);
    session.activate();
    for (const input of [
      { text: 'hi', model: { providerId: 'p' } },
      { text: 'hi', model: 'p/m' },
      { text: 'hi', agent: '' },
      { text: 'hi', agent: 3 },
    ]) {
      await expect(runtime.agent.run(input as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENTS',
      });
    }
    await expect(
      runtime.agent.answer({ sessionId: 's', requestId: 'q', answers: [], model: {} } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(runtime.agent.create({ agent: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    expect(childFrames).toEqual([]);
    runtime.close();
    await session.close();

    for (const request of [
      { method: 'agent.run', params: { text: 'hi', model: { providerId: 'p' } } },
      { method: 'agent.run', params: { text: 'hi', agent: 1 } },
      { method: 'agent.create', params: { agent: '' } },
      { method: 'agent.models', params: { extra: true } },
    ]) {
      const raw = agentBridge();
      raw.session.activate();
      raw.hostRequests.receive({ v: 1, id: '1', ...request });
      await vi.waitFor(() => expect(raw.fatal).toHaveBeenCalledOnce());
      expect(raw.agentGateway.run).not.toHaveBeenCalled();
      raw.runtime.close();
      await raw.session.close();
    }
    expect(agentGateway.run).not.toHaveBeenCalled();
  });

  it('serves models, agents and create as short requests without a receipt', async () => {
    const { agentGateway, hostRequests, runtime, session } = agentBridge();
    agentGateway.models.mockResolvedValue(MODELS);
    agentGateway.agents.mockResolvedValue(AGENTS);
    agentGateway.create.mockResolvedValue({ sessionId: 'session-9' });
    const hostFrames = sentPayloads(hostRequests);
    session.activate();

    await expect(runtime.agent.models()).resolves.toEqual(MODELS);
    await expect(runtime.agent.agents()).resolves.toEqual(AGENTS);
    await expect(runtime.agent.create()).resolves.toEqual({ sessionId: 'session-9' });
    await expect(runtime.agent.create({ agent: 'writer' })).resolves.toEqual({
      sessionId: 'session-9',
    });

    expect(agentGateway.models).toHaveBeenCalledWith(CALLER);
    expect(agentGateway.agents).toHaveBeenCalledWith(CALLER);
    expect(agentGateway.create.mock.calls.map((call) => call[1])).toEqual([
      {},
      { agent: 'writer' },
    ]);
    expect(hostFrames.every((frame) => frame.receipt === undefined && !('event' in frame))).toBe(
      true,
    );
    runtime.close();
    await session.close();
  });

  it('projects models, agents and create results to the contract before they reach the child', async () => {
    const { agentGateway, runtime, session } = agentBridge();
    const extra = { internal: 'secret' };
    agentGateway.models.mockResolvedValue({
      models: [
        {
          providerId: 'p',
          modelId: 'm',
          displayName: 'M',
          variants: ['fast'],
          thinking: { efforts: ['low', 'high'], default: 'low', ...extra },
          ...extra,
        },
      ],
      default: { providerId: 'p', modelId: 'm', ...extra },
      host: { providerId: 'p', modelId: 'm', variant: 'fast', ...extra },
      ...extra,
    } as never);
    agentGateway.agents.mockResolvedValue({
      agents: [{ name: 'mavis', displayName: 'Mavis', primary: true, ...extra }],
      ...extra,
    } as never);
    agentGateway.create.mockResolvedValue({ sessionId: 'session-9', ...extra } as never);
    session.activate();

    await expect(runtime.agent.models()).resolves.toEqual({
      models: [
        {
          providerId: 'p',
          modelId: 'm',
          displayName: 'M',
          variants: ['fast'],
          thinking: { efforts: ['low', 'high'], default: 'low' },
        },
      ],
      default: { providerId: 'p', modelId: 'm' },
      host: { providerId: 'p', modelId: 'm', variant: 'fast' },
    });
    await expect(runtime.agent.agents()).resolves.toEqual(AGENTS);
    await expect(runtime.agent.create()).resolves.toEqual({ sessionId: 'session-9' });
    runtime.close();
    await session.close();
  });

  it('keeps the model on turn.started events and drops one without a valid model', async () => {
    const { runtime, session } = agentBridge({
      run: async (options) => {
        options?.onEvent?.(TURN_STARTED as never);
        options?.onEvent?.({ ...TURN_STARTED, model: { providerId: 'p' } } as never);
        options?.onEvent?.({ ...TURN_STARTED, model: { ...MODEL, extra: 1 } } as never);
        return { ...AGENT_RESULT, model: MODEL };
      },
    });
    session.activate();
    const events: MiniAppAgentRunEvent[] = [];

    const result = await runtime.agent.run(
      { text: 'hi' },
      { onEvent: (event) => events.push(event) },
    );

    expect(events).toEqual([{ ...TURN_STARTED, model: MODEL }]);
    expect(result.model).toEqual(MODEL);
    runtime.close();
    await session.close();
  });

  it('rejects a turn.started or result the Host sends with a malformed model', async () => {
    for (const frame of [
      { event: { ...TURN_STARTED, model: { modelId: 'm' } } },
      { event: TURN_STARTED },
      { ok: true, result: { ...AGENT_RESULT, model: { providerId: 'p' } } },
    ]) {
      const input = new MemoryIpc();
      const onFatal = vi.fn();
      const client = createMiniAppHostConnectorRuntimeClient({ transport: input, onFatal });
      const pending = client.agent.run({ text: 'hi' }, { onEvent: vi.fn() });
      pending.catch(() => undefined);
      input.receive({ v: 1, id: '1', receipt: 'admitted', invocationId: 'invocation-agent-1' });
      input.receive({ v: 1, id: '1', ...frame });
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalledOnce());
    }
  });

  it('refuses models, agents and create without an allowlist policy', async () => {
    const { agentGateway, runtime, session } = agentBridge({ policy: { kind: 'deny-all' } });
    session.activate();

    for (const call of [
      () => runtime.agent.models(),
      () => runtime.agent.agents(),
      () => runtime.agent.create({ agent: 'writer' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'NOT_PERMITTED', retryable: false });
    }
    expect(agentGateway.models).not.toHaveBeenCalled();
    expect(agentGateway.create).not.toHaveBeenCalled();
    runtime.close();
    await session.close();
  });
});

describe('Mini App Host Connector admission budget', () => {
  it('reserves the permission-reply budget so ordinary connector traffic cannot consume it', () => {
    const connectorPending = Array.from({ length: 16 }, () => ({
      method: 'connector.call' as const,
    }));
    expect(hasHostConnectorRequestCapacity('connector.call', connectorPending)).toBe(false);
    expect(hasHostConnectorRequestCapacity('connector.list', connectorPending)).toBe(false);
    // Ordinary requests fill only their own bucket; the reserved reply slot stays open.
    expect(hasHostConnectorRequestCapacity('agent.reply', connectorPending)).toBe(true);

    const replyPending = Array.from({ length: 16 }, () => ({ method: 'agent.reply' as const }));
    expect(hasHostConnectorRequestCapacity('agent.reply', replyPending)).toBe(false);
    expect(hasHostConnectorRequestCapacity('connector.call', replyPending)).toBe(true);
  });
});
