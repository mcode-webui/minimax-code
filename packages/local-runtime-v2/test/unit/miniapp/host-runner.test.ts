import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { MiniAppIpcMessage } from '../../../src/service/miniapp/contracts.js';
import { MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES } from '../../../src/service/miniapp/errors.js';
import type { HostConnectorClient } from '../../../src/service/miniapp/process/host-connector/host-connector.js';
import {
  isMiniAppRunnerInitMessage,
  MiniAppRunnerError,
  runMiniAppHostRunner,
  startMiniAppModule,
  type MiniAppRunnerChildMessage,
  type MiniAppRunnerInitMessage,
} from '../../../src/service/miniapp/process/node-runtime/host-runner.js';

class FakeRunnerProcess extends EventEmitter {
  connected = true;
  exitCode?: number;
  readonly messages: Array<MiniAppRunnerChildMessage | MiniAppIpcMessage> = [];
  readonly disconnect = vi.fn(() => {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  });
  private readonly flushCallbacks: Array<(error: Error | null) => void> = [];

  constructor(private readonly autoFlush = true) {
    super();
  }

  send(
    message: MiniAppRunnerChildMessage | MiniAppIpcMessage,
    callback?: (error: Error | null) => void,
  ): boolean {
    this.messages.push(message);
    if (callback) {
      if (this.autoFlush) queueMicrotask(() => callback(null));
      else this.flushCallbacks.push(callback);
    }
    return true;
  }

  flushNext(): void {
    this.flushCallbacks.shift()?.(null);
  }
}

const INIT: MiniAppRunnerInitMessage = {
  type: 'miniapp:init',
  protocolVersion: 1,
  pluginId: 'weather-board',
  processGeneration: 'process-1',
  packageRoot: '/real/weather-board',
  nodeEntry: 'dist/server.mjs',
  dataDir: '/data/weather-board',
  listen: { host: '127.0.0.1', port: 51_234 },
  readiness: { startupToken: 'startup-token', nodeDigest: 'node-digest' },
  loopbackToken: 'loopback-token',
  hostConnectorPolicy: { kind: 'deny-all' },
  agentPolicy: { kind: 'deny-all' },
};
const allowlist = (maxConcurrent: unknown, capabilities = ['session.run']) => ({
  kind: 'allowlist',
  capabilities,
  maxConcurrent,
});

describe('Mini App runner init validation', () => {
  it.each([
    { policy: null, valid: false },
    { policy: { kind: 'deny-all', providers: [] }, valid: false },
    { policy: { kind: 'deny-all' }, valid: true },
    { policy: { kind: 'allowlist', providers: 'weather' }, valid: false },
    { policy: { kind: 'allowlist', providers: [42] }, valid: false },
    { policy: { kind: 'allowlist', providers: ['weather'] }, valid: true },
  ])('accepts only an exact Host Connector policy envelope', ({ policy, valid }) => {
    expect(isMiniAppRunnerInitMessage({ ...INIT, hostConnectorPolicy: policy })).toBe(valid);
  });

  it('requires a non-empty string loopback token', () => {
    const withoutToken: Record<string, unknown> = { ...INIT };
    delete withoutToken.loopbackToken;
    expect(isMiniAppRunnerInitMessage(withoutToken)).toBe(false);
    expect(isMiniAppRunnerInitMessage({ ...INIT, loopbackToken: '' })).toBe(false);
    expect(isMiniAppRunnerInitMessage({ ...INIT, loopbackToken: 42 })).toBe(false);
    expect(isMiniAppRunnerInitMessage({ ...INIT, loopbackToken: ['token'] })).toBe(false);
    expect(isMiniAppRunnerInitMessage(INIT)).toBe(true);
  });

  it.each([
    { policy: undefined, valid: false },
    { policy: { kind: 'deny-all', capabilities: [] }, valid: false },
    { policy: { kind: 'deny-all' }, valid: true },
    { policy: allowlist(4, ['session.write']), valid: false },
    { policy: { kind: 'allowlist', capabilities: ['session.run'] }, valid: false },
    ...[0, 33, 2.5, '4', null].map((maxConcurrent) => ({
      policy: allowlist(maxConcurrent),
      valid: false,
    })),
    ...[1, 4, 32].map((maxConcurrent) => ({ policy: allowlist(maxConcurrent), valid: true })),
  ])('accepts only an exact Agent policy envelope', ({ policy, valid }) => {
    expect(isMiniAppRunnerInitMessage({ ...INIT, agentPolicy: policy })).toBe(valid);
  });

  it('rejects an init message without the agentPolicy key', () => {
    const legacy: Record<string, unknown> = { ...INIT };
    delete legacy.agentPolicy;
    expect(isMiniAppRunnerInitMessage(legacy)).toBe(false);
  });
});

describe('Mini App child runner Agent context', () => {
  it.each([
    {
      name: 'agent-only access',
      hostConnectorPolicy: { kind: 'deny-all' },
      agentPolicy: { kind: 'allowlist', capabilities: ['session.run'], maxConcurrent: 4 },
      expected: { agent: true, hostConnector: false, channel: true },
    },
    {
      name: 'no access',
      hostConnectorPolicy: { kind: 'deny-all' },
      agentPolicy: { kind: 'deny-all' },
      expected: { agent: false, hostConnector: false, channel: false },
    },
  ] as const)(
    'injects only the allowed clients for $name',
    async ({ hostConnectorPolicy, agentPolicy, expected }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'miniapp-runner-agent-'));
      const contextKey = `__miniappRunnerAgent_${path.basename(root)}`;
      await writeFile(
        path.join(root, 'server.mjs'),
        `export async function start(context) { globalThis[${JSON.stringify(contextKey)}] = context; }\n`,
      );
      const processPort = new FakeRunnerProcess();
      try {
        runMiniAppHostRunner({ process: processPort });
        processPort.emit('message', {
          ...INIT,
          packageRoot: root,
          nodeEntry: 'server.mjs',
          hostConnectorPolicy,
          agentPolicy,
        });
        await vi.waitFor(() =>
          expect(processPort.messages).toContainEqual(
            expect.objectContaining({ type: 'miniapp:started' }),
          ),
        );
        const context = (globalThis as Record<string, unknown>)[contextKey] as {
          readonly agent?: { run(input: { readonly text: string }): Promise<unknown> };
        };
        expect('agent' in context).toBe(expected.agent);
        expect('hostConnector' in context).toBe(expected.hostConnector);
        expect(processPort.listenerCount('error')).toBe(expected.channel ? 1 : 0);
        const pending = context.agent?.run({ text: 'hi' });
        const settled = pending?.catch((error: unknown) => error);
        if (pending) {
          await vi.waitFor(() =>
            expect(processPort.messages).toContainEqual({
              type: 'miniapp:connector',
              payload: { v: 1, id: '1', method: 'agent.run', params: { text: 'hi' } },
            }),
          );
        }
        processPort.emit('message', { type: 'miniapp:stop' });
        await vi.waitFor(() => expect(processPort.disconnect).toHaveBeenCalledOnce());
        if (settled) {
          await expect(settled).resolves.toMatchObject({ code: 'AGENT_OUTCOME_UNKNOWN' });
        }
      } finally {
        delete (globalThis as Record<string, unknown>)[contextKey];
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('fails closed when Agent access has no Host-owned client', async () => {
    await expect(
      startMiniAppModule(
        {
          ...INIT,
          agentPolicy: { kind: 'allowlist', capabilities: ['session.run'], maxConcurrent: 4 },
        },
        {
          resolveRealPath: async (target) => target,
          loadModule: vi.fn().mockResolvedValue({ start: vi.fn() }),
          createHostConnector: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ code: 'HOST_CONNECTOR_UNAVAILABLE' });
  });
});

describe('Mini App child host runner', () => {
  it('disconnects only after module cleanup and the stopped frame flush', async () => {
    const processPort = new FakeRunnerProcess(false);
    const stop = vi.fn().mockResolvedValue(undefined);
    runMiniAppHostRunner({ process: processPort, start: async () => ({ stop }) });
    processPort.emit('message', INIT);
    await vi.waitFor(() => {
      expect(processPort.messages).toContainEqual(
        expect.objectContaining({ type: 'miniapp:started' }),
      );
    });

    processPort.emit('message', { type: 'miniapp:stop' });
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
      expect(processPort.messages).toContainEqual({ type: 'miniapp:stopped' });
    });
    expect(processPort.exitCode).toBeUndefined();
    expect(processPort.disconnect).not.toHaveBeenCalled();

    processPort.flushNext();
    await vi.waitFor(() => expect(processPort.disconnect).toHaveBeenCalledOnce());
    expect(processPort.exitCode).toBe(0);
  });

  it('starts the named Node entry with a frozen Host context and disposes it once', async () => {
    const messages: MiniAppRunnerChildMessage[] = [];
    const dispose = vi.fn().mockResolvedValue(undefined);
    const connector = { list: vi.fn(), call: vi.fn() } satisfies HostConnectorClient;
    let observedSignal: AbortSignal | undefined;
    const start = vi
      .fn()
      .mockImplementation(
        (context: {
          readonly signal: AbortSignal;
          readonly logger: { info(message: string, fields?: Record<string, unknown>): void };
        }) => {
          expect(Object.isFrozen(context)).toBe(true);
          observedSignal = context.signal;
          context.logger.info('board.ready', { toolCount: 2 });
          return { dispose, metadata: { framework: 'custom' } };
        },
      );

    const running = await startMiniAppModule(INIT, {
      resolveRealPath: vi
        .fn()
        .mockImplementation(async (target: string) =>
          target.endsWith('server.mjs')
            ? '/real/weather-board/dist/server.mjs'
            : '/real/weather-board',
        ),
      loadModule: vi.fn().mockResolvedValue({ start }),
      createHostConnector: vi.fn().mockReturnValue(connector),
      emit: (message) => messages.push(message),
    });

    const context = start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(context).toEqual(
      expect.objectContaining({
        pluginId: 'weather-board',
        pluginRoot: '/real/weather-board',
        dataDir: '/data/weather-board',
        generationId: 'process-1',
        listen: { host: '127.0.0.1', port: 51_234 },
        hostConnector: connector,
      }),
    );
    expect(context).not.toHaveProperty('startupToken');
    expect(context).not.toHaveProperty('nodeDigest');
    expect(context).not.toHaveProperty('loopbackToken');
    expect(JSON.stringify(context)).not.toContain(INIT.loopbackToken);
    expect(messages).toContainEqual({
      type: 'miniapp:log',
      level: 'info',
      message: 'board.ready',
      fieldKeys: ['toolCount'],
    });
    expect(observedSignal?.aborted).toBe(false);

    await running.stop();
    await running.stop();
    expect(observedSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('fails closed when the resolved Node entry escapes the package artifact', async () => {
    await expect(
      startMiniAppModule(INIT, {
        resolveRealPath: vi
          .fn()
          .mockResolvedValueOnce('/real/weather-board')
          .mockResolvedValueOnce('/real/outside/server.mjs'),
        loadModule: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'ENTRY_OUTSIDE_ARTIFACT' });
  });

  it.each<{
    readonly name: string;
    readonly error: () => Error;
    readonly expectedCode: string;
  }>([
    {
      name: 'an arbitrary plugin code',
      error: () => Object.assign(new Error('plugin start failed'), { code: 'PLUGIN_PRIVATE_CODE' }),
      expectedCode: 'RUNNER_START_FAILED',
    },
    {
      name: 'an address collision used by Host port retry',
      error: () => Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }),
      expectedCode: 'EADDRINUSE',
    },
    {
      name: 'a Host-owned runner code',
      error: () =>
        new MiniAppRunnerError('START_EXPORT_MISSING', 'Mini App Node entry must export start'),
      expectedCode: 'START_EXPORT_MISSING',
    },
  ])('reports $name as $expectedCode', async ({ error, expectedCode }) => {
    const processPort = new FakeRunnerProcess();
    runMiniAppHostRunner({
      process: processPort,
      start: async () => {
        throw error();
      },
    });

    processPort.emit('message', INIT);

    await vi.waitFor(() => {
      expect(processPort.messages).toContainEqual(
        expect.objectContaining({ type: 'miniapp:error', code: expectedCode }),
      );
    });
  });
});

/** The child harness is TypeScript here, so the real child runs it through the repo's tsx. */
function tsxCli(): string {
  return fileURLToPath(new URL('../../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
}

/** Workspace `@mavis/*` imports resolve through the standalone path map, not built `dist`. */
function standaloneTsconfig(): string {
  return fileURLToPath(new URL('../../../../../tsconfig.standalone.json', import.meta.url));
}

function runnerHarness(): string {
  return fileURLToPath(
    new URL('../../helpers/miniapp-host-runner-child.ts', import.meta.url),
  );
}

describe('Mini App child host runner process exit', () => {
  // A real child under tsx compiles the runtime graph before it can answer, so this case needs a
  // budget larger than the default one; the assertions themselves stay the shipped ones.
  it('naturally exits a Connector-enabled real child after stopped is flushed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'miniapp-runner-connector-exit-'));
    const packageRoot = path.join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, 'server.mjs'),
      'export async function start() { return { async dispose() {} }; }\n',
    );
    const child = spawn(process.execPath, [tsxCli(), '--tsconfig', standaloneTsconfig(), runnerHarness()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[child] ${chunk}`));
    const originalKill = child.kill.bind(child);
    const hostTermination = vi.spyOn(child, 'kill');

    try {
      child.send({ ...INIT, packageRoot, nodeEntry: 'server.mjs' });
      await waitForChildMessage(child, (message) => message.type === 'miniapp:started');
      child.send({ type: 'miniapp:stop' });
      await waitForChildMessage(child, (message) => message.type === 'miniapp:stopped');

      await expect(waitForChildExit(child, 750)).resolves.toMatchObject({ code: 0, signal: null });
      expect(hostTermination).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null) originalKill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('naturally exits a real child after stopped is flushed without Host termination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'miniapp-runner-exit-'));
    const packageRoot = path.join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, 'server.mjs'),
      'export async function start() { return { async dispose() {} }; }\n',
    );
    const child = spawn(process.execPath, [tsxCli(), '--tsconfig', standaloneTsconfig(), runnerHarness()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[child] ${chunk}`));
    const originalKill = child.kill.bind(child);
    const hostTermination = vi.spyOn(child, 'kill');

    try {
      child.send({
        ...INIT,
        packageRoot,
        nodeEntry: 'server.mjs',
        hostConnectorPolicy: { kind: 'deny-all' },
      });
      await waitForChildMessage(child, (message) => message.type === 'miniapp:started');
      child.send({ type: 'miniapp:stop' });
      await waitForChildMessage(child, (message) => message.type === 'miniapp:stopped');

      await expect(waitForChildExit(child, 750)).resolves.toMatchObject({ code: 0, signal: null });
      expect(hostTermination).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null) originalKill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('Mini App child host runner diagnostics', () => {
  it('reports a complete stack larger than 4 KiB without truncation', async () => {
    const processPort = new FakeRunnerProcess();
    const error = new Error('plugin start failed');
    const stack = `Error: plugin start failed\n${'    at plugin (server.mjs:1:1)\n'.repeat(256)}`;
    error.stack = stack;
    runMiniAppHostRunner({
      process: processPort,
      start: async () => {
        throw error;
      },
    });

    processPort.emit('message', INIT);

    await vi.waitFor(() => {
      expect(processPort.messages).toContainEqual({
        type: 'miniapp:error',
        code: 'RUNNER_START_FAILED',
        errorText: stack,
      });
    });
    expect(stack.length).toBeGreaterThan(4 * 1024);
  });

  it('bounds an oversized stack before sending it over child IPC', async () => {
    const processPort = new FakeRunnerProcess();
    const error = new Error('plugin start failed');
    const stack = `Error: plugin start failed\n${'    at plugin (server.mjs:1:1)\n'.repeat(4_096)}deepest-frame`;
    error.stack = stack;
    runMiniAppHostRunner({
      process: processPort,
      start: async () => {
        throw error;
      },
    });

    processPort.emit('message', INIT);

    await vi.waitFor(() => {
      const failure = processPort.messages.find((message) => message.type === 'miniapp:error');
      expect(failure).toBeDefined();
      if (!failure || failure.type !== 'miniapp:error') return;
      expect(Buffer.byteLength(failure.errorText, 'utf8')).toBeLessThanOrEqual(
        MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES,
      );
      expect(failure.errorText.startsWith('Error: plugin start failed\n')).toBe(true);
      expect(failure.errorText).toContain(
        `[... runner error text truncated from ${Buffer.byteLength(stack, 'utf8')} bytes ...]`,
      );
      expect(failure.errorText.endsWith('deepest-frame')).toBe(true);
    });
  });

  it('safely stringifies a non-string Error stack before sending it over child IPC', async () => {
    const processPort = new FakeRunnerProcess();
    const error = new Error('plugin start failed');
    Object.defineProperty(error, 'stack', {
      configurable: true,
      value: { toString: () => 'structured plugin stack' },
    });
    runMiniAppHostRunner({
      process: processPort,
      start: async () => {
        throw error;
      },
    });

    processPort.emit('message', INIT);

    await vi.waitFor(() => {
      expect(processPort.messages).toContainEqual({
        type: 'miniapp:error',
        code: 'RUNNER_START_FAILED',
        errorText: 'structured plugin stack',
      });
    });
  });

  it.each([
    { thrown: 'plain plugin failure', expected: 'plain plugin failure' },
    {
      thrown: {
        [Symbol.toPrimitive]() {
          throw new Error('conversion failed');
        },
      },
      expected: 'Runner error could not be converted to text',
    },
  ])('safely reports a non-Error throw as text', async ({ thrown, expected }) => {
    const processPort = new FakeRunnerProcess();
    runMiniAppHostRunner({
      process: processPort,
      start: async () => {
        throw thrown;
      },
    });

    processPort.emit('message', INIT);

    await vi.waitFor(() => {
      expect(processPort.messages).toContainEqual({
        type: 'miniapp:error',
        code: 'RUNNER_START_FAILED',
        errorText: expected,
      });
    });
  });
});

function waitForChildMessage(
  child: ChildProcess,
  predicate: (message: MiniAppRunnerChildMessage) => boolean,
  timeoutMs = 5_000,
): Promise<MiniAppRunnerChildMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, message?: MiniAppRunnerChildMessage) => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    const onMessage = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const candidate = message as MiniAppRunnerChildMessage;
      if (predicate(candidate)) finish(undefined, candidate);
    };
    const onExit = () => finish(new Error('Runner exited before the expected IPC message'));
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for the expected runner IPC message')),
      timeoutMs,
    );
    timer.unref();
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`Runner did not naturally exit within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}
