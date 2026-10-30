import { describe, expect, it, vi } from 'vitest';

import type { MiniAppNodeRuntimeFactory, MiniAppRuntimeExit } from '../../../src/service/miniapp/contracts.js';
import { MiniAppError } from '../../../src/service/miniapp/errors.js';
import { DefaultMiniAppSupervisor } from '../../../src/service/miniapp/supervisor/supervisor.js';
import { MiniAppSupervisorDiagnostics } from '../../../src/service/miniapp/supervisor/supervisor-diagnostics.js';

const candidate = {
  pluginId: 'weather-board',
  packageRoot: '/private/secret-project',
  packageDigest: 'package-1',
  clientDigest: 'client-1',
  surfacePath: '/',
  lifecycle: 'on-demand' as const,
  nodeDigest: 'node-1',
  nodeEntry: 'node/server.mjs',
  mcpEndpoints: [],
  hostConnectorPolicy: { kind: 'deny-all' as const },
};

function deferredExit() {
  let resolve: (exit: MiniAppRuntimeExit) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<MiniAppRuntimeExit>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(logCapacity?: number) {
  const exits: ReturnType<typeof deferredExit>[] = [];
  const inputs: Parameters<MiniAppNodeRuntimeFactory['prepare']>[0][] = [];
  const prepare = vi.fn<MiniAppNodeRuntimeFactory['prepare']>(async (input) => {
    inputs.push(input);
    const exit = deferredExit();
    exits.push(exit);
    return {
      processGeneration: input.processGeneration,
      nodeDigest: candidate.nodeDigest,
      port: 42_000,
      origin: 'http://127.0.0.1:42000',
      loopbackToken: 'loopback-diagnostics',
      closed: exit.promise,
      stop: vi.fn(async () => ({ proven: true })),
    };
  });
  let nowMs = 100;
  const logger = { error: vi.fn() };
  const diagnostics = new MiniAppSupervisorDiagnostics({
    nodeRuntime: { prepare },
    logger,
    nowMs: () => {
      nowMs += 1;
      return nowMs;
    },
    ...(logCapacity !== undefined ? { logCapacity } : {}),
  });
  const start = (processGeneration = 'run-1') =>
    diagnostics.prepare(
      { candidate, processGeneration, signal: new AbortController().signal },
      'app-1',
    );
  return { diagnostics, prepare, inputs, exits, start, logger };
}

/**
 * The Host diagnostics block is the only thing an Agent can read about a Mini App that would not
 * start, so these checks pin that the block is built from recorded run state and never from a
 * constant: a real run id, a real failure code, and a bounded log list that says when it dropped
 * entries.
 */
describe('Mini App Supervisor diagnostics', () => {
  it('reads a never-started runtime without inventing a run', () => {
    const { diagnostics, prepare } = fixture();
    expect(diagnostics.inspect(candidate.pluginId, undefined)).toEqual({
      scope: 'host',
      retention: 'runtime-memory',
      logs: { entries: [], truncated: false, omittedCount: 0 },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('reports the current run id and the bounded host log entries', async () => {
    const { diagnostics, prepare, exits, start } = fixture();
    await start('run-1');

    const current = diagnostics.inspect(candidate.pluginId, 'run-1');
    expect(current.run).toMatchObject({
      runId: 'run-1',
      current: true,
      preparationStartedAtMs: 101,
      readyAtMs: expect.any(Number),
    });
    expect(current.logs.entries.map(({ code }) => code)).toEqual([
      'runtime.start_requested',
      'runtime.ready',
    ]);
    expect(current.logs.truncated).toBe(false);
    expect(current.logs.omittedCount).toBe(0);

    exits[0]?.resolve({ code: 1, signal: null, shutdownRequested: false });
    await vi.waitFor(() => {
      expect(diagnostics.inspect(candidate.pluginId, undefined).run).toMatchObject({
        runId: 'run-1',
        current: false,
        exit: { code: 1, signal: null, shutdownRequested: false },
        failure: { code: 'RUNTIME_EXITED', message: expect.any(String) },
      });
    });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('records a failure code when the runtime fails to start', async () => {
    const { diagnostics, prepare, start, logger } = fixture();
    const failure = new MiniAppError('RUNTIME_START_FAILED', 'authorization=secret', {
      reasonCode: 'START_EXPORT_MISSING',
      runtimeError: { errorText: 'private-stack', stderr: 'private-stderr' },
    });
    prepare.mockRejectedValueOnce(failure);

    await expect(start()).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'miniapp.runtime_start_failed',
        pluginId: candidate.pluginId,
        processGeneration: 'run-1',
        reasonCode: 'START_EXPORT_MISSING',
        errorText: 'private-stack',
        stderr: 'private-stderr',
      }),
      'Mini App runtime startup failed',
    );

    const result = diagnostics.inspect(candidate.pluginId, undefined);
    expect(result.run?.failure).toEqual({
      code: 'START_EXPORT_MISSING',
      message: 'Mini App entry does not export start().',
    });
    expect(result.run).not.toHaveProperty('exit');
    expect(result.run).not.toHaveProperty('readyAtMs');
    expect(JSON.stringify(result)).not.toMatch(/authorization|secret|private-/);
  });

  it('reports truncation and the omitted count for a bounded log list', async () => {
    const { diagnostics, inputs, exits, start } = fixture(2);
    await start();
    inputs[0]?.onLog({
      processGeneration: 'run-1',
      level: 'error',
      message: 'customer.alice',
      byteLength: 14,
      fieldKeys: ['customerBob', 'authorization'],
    });
    exits[0]?.resolve({ code: 0, signal: null, shutdownRequested: true });
    await vi.waitFor(() =>
      expect(diagnostics.inspect(candidate.pluginId, undefined).run?.exit).toBeDefined(),
    );

    const result = diagnostics.inspect(candidate.pluginId, undefined);
    expect(result.logs).toMatchObject({ truncated: true, omittedCount: 1 });
    expect(result.logs.entries.map(({ code }) => code)).toEqual(['runtime.ready', 'runtime.exited']);
    expect(result.run).not.toHaveProperty('failure');
    expect(JSON.stringify(result)).not.toMatch(/alice|customerBob|authorization|secret-project/);
  });

  it('normalizes an untrusted failure code to a host-owned one', async () => {
    const { diagnostics, prepare, start } = fixture();
    prepare.mockRejectedValueOnce({ code: 'customer.alice', message: 'private error' });

    await expect(start('failed-run')).rejects.toMatchObject({ code: 'customer.alice' });
    expect(diagnostics.inspect(candidate.pluginId, undefined).run?.failure).toEqual({
      code: 'RUNTIME_START_FAILED',
      message: 'Mini App runtime preparation failed.',
    });
  });
});

/**
 * The supervisor is the only place that turns a recorded run into a `MiniAppStatus`, so this check
 * pins that the projection carries the Host diagnostics block rather than only the summary.
 */
describe('Mini App supervisor status projection', () => {
  it('carries the host diagnostics of the recorded run into the projected status', async () => {
    const prepare = vi.fn<MiniAppNodeRuntimeFactory['prepare']>(async () => {
      throw new MiniAppError('RUNTIME_START_FAILED', 'boom');
    });
    const supervisor = new DefaultMiniAppSupervisor({
      stateStore: {
        read: () => undefined,
        list: () => [],
        write: () => undefined,
        remove: () => undefined,
      },
      nodeRuntime: { prepare },
      verifyCandidate: async () => true,
      nowMs: () => 100,
    });

    await expect(supervisor.prepare(candidate, { forceStart: true })).rejects.toBeInstanceOf(
      MiniAppError,
    );

    const status = supervisor.inspect(candidate.pluginId)[0];
    expect(status?.diagnostics?.run?.runId).toBeDefined();
    expect(status?.diagnostics?.run?.failure?.code).toBe('RUNTIME_START_FAILED');
    expect(status?.diagnostics?.logs.entries.map(({ code }) => code)).toEqual([
      'runtime.start_requested',
      'runtime.failed',
    ]);
    expect(status?.logs).toEqual([]);
  });
});
