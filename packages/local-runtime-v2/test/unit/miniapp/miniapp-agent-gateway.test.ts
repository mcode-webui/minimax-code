import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MINIAPP_AGENT_MAX_TEXT_LENGTH } from '@mavis/shared/miniapp-surface';
import { describe, expect, it, vi } from 'vitest';

import {
  MINIAPP_AGENT_DEFAULT_CONCURRENCY,
  MINIAPP_AGENT_QUEUE_FACTOR,
  MiniAppAgentError,
  type MiniAppAgentArena,
  type MiniAppAgentCaller,
  type MiniAppAgentRunEvent,
  type MiniAppAgentSessionPorts,
  type MiniAppPermissionAsk,
} from '../../../src/service/miniapp/agent/contracts.js';
import { createMiniAppAgentGateway } from '../../../src/service/miniapp/agent/gateway.js';

const ARENA: MiniAppAgentArena = {
  pluginId: 'demo board',
  processGeneration: 'gen-1',
  policy: {
    kind: 'allowlist',
    capabilities: ['session.run'],
    maxConcurrent: MINIAPP_AGENT_DEFAULT_CONCURRENCY,
  },
};
const DEFAULT_MODEL = { providerId: 'minimax', modelId: 'M3' };
const MODEL_OPTIONS = [{ providerId: 'minimax', modelId: 'M3', displayName: 'MiniMax M3' }];
const AGENT_OPTIONS = [
  { name: 'mavis', displayName: 'Mavis', primary: true },
  { name: 'writer', displayName: 'Writer', primary: false },
];
const DEFAULT_QUEUE_BOUND = MINIAPP_AGENT_DEFAULT_CONCURRENCY * MINIAPP_AGENT_QUEUE_FACTOR;
const CALLER: MiniAppAgentCaller = {
  pluginId: 'demo board',
  processGeneration: 'gen-1',
  source: 'process',
};

describe('createMiniAppAgentGateway', () => {
  it('fails closed as unavailable until ports are bound', async () => {
    const { gateway } = setup({ bind: false });
    gateway.registerArena(ARENA);

    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
  });

  it.each([
    ['no arena', undefined, 'no-arena'],
    ['a deny-all policy', { ...ARENA, policy: { kind: 'deny-all' } }, 'policy'],
    [
      'a policy without session.run',
      { ...ARENA, policy: { kind: 'allowlist', capabilities: [] } },
      'policy',
    ],
  ] as const)('rejects %s as NOT_PERMITTED', async (_label, arena, reason) => {
    const { gateway, ports, logger } = setup();
    if (arena) gateway.registerArena(arena as MiniAppAgentArena);

    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'NOT_PERMITTED',
    });
    expect(ports.createSession).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'rejected', errorCode: 'NOT_PERMITTED', reason }),
      'Mini App Agent run',
    );
  });

  it('rejects a caller of an older generation as retryable unavailable', async () => {
    const { gateway, ports, logger } = setup();
    gateway.registerArena(ARENA);

    await expect(
      gateway.run({ ...CALLER, processGeneration: 'gen-0' }, { text: 'hi' }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(ports.createSession).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        processGeneration: 'gen-0',
        errorCode: 'AGENT_UNAVAILABLE',
        reason: 'generation-mismatch',
      }),
      'Mini App Agent run',
    );
  });

  it.each(['', '   ', 42, 'x'.repeat(MINIAPP_AGENT_MAX_TEXT_LENGTH + 1)])(
    'rejects invalid text as INVALID_ARGUMENTS (%#)',
    async (text) => {
      const { gateway, logger } = setup();
      gateway.registerArena(ARENA);

      await expect(gateway.run(CALLER, { text: text as string })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENTS',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        {
          pluginId: 'demo board',
          processGeneration: 'gen-1',
          source: 'process',
          phase: 'rejected',
          errorCode: 'INVALID_ARGUMENTS',
        },
        'Mini App Agent run',
      );
    },
  );

  it('creates a session in the plugin agent workspace and audits admission and terminal', async () => {
    const { gateway, ports, logger } = setup();
    gateway.registerArena(ARENA);

    await expect(gateway.run(CALLER, { text: 'hi' })).resolves.toEqual({
      sessionId: 'session-new',
      turnId: 'turn-1',
      status: 'finished',
      text: 'reply',
    });
    expect(ports.createSession).toHaveBeenCalledWith({
      pluginId: 'demo board',
      agentName: 'mavis',
      workspaceDir: join('/data', 'agents', 'mavis', 'miniapps', 'demo%20board'),
      createDir: true,
      model: DEFAULT_MODEL,
    });
    expect(ports.resolveHostSession).not.toHaveBeenCalled();
    expect(logger.info.mock.calls).toEqual([
      [
        expect.objectContaining({
          pluginId: 'demo board',
          sessionId: 'session-new',
          agentName: 'mavis',
          model: 'minimax/M3',
          phase: 'admission',
        }),
        'Mini App Agent run',
      ],
      [
        expect.objectContaining({ phase: 'terminal', status: 'finished', durationMs: 0 }),
        'Mini App Agent run',
      ],
    ]);
  });

  it('continues an owned session and hides sessions owned by others', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockImplementation(async (sessionId) =>
      sessionId === 'mine' ? 'demo board' : sessionId === 'theirs' ? 'other' : undefined,
    );
    gateway.registerArena(ARENA);

    await expect(gateway.run(CALLER, { text: 'hi', sessionId: 'mine' })).resolves.toMatchObject({
      sessionId: 'mine',
    });
    for (const sessionId of ['theirs', 'missing']) {
      await expect(gateway.run(CALLER, { text: 'hi', sessionId })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    }
    expect(ports.createSession).not.toHaveBeenCalled();
    expect(ports.runTurn).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight runs on release and rejects later calls', async () => {
    const { gateway, ports } = setup();
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena(ARENA);

    const run = gateway.run(CALLER, { text: 'hi' });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalled());
    release();

    await expect(run).resolves.toMatchObject({ status: 'aborted' });
    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'NOT_PERMITTED',
    });
  });

  it('replaces the previous generation on re-register and ignores its late release', async () => {
    const { gateway, ports } = setup();
    ports.runTurn.mockImplementationOnce(({ signal }) => untilAborted(signal));
    const releaseOld = gateway.registerArena(ARENA);
    const oldRun = gateway.run(CALLER, { text: 'hi' });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalled());

    gateway.registerArena({ ...ARENA, processGeneration: 'gen-2' });

    await expect(oldRun).resolves.toMatchObject({ status: 'aborted' });
    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
      retryable: true,
    });
    releaseOld();
    await expect(
      gateway.run({ ...CALLER, processGeneration: 'gen-2' }, { text: 'hi' }),
    ).resolves.toMatchObject({ status: 'finished' });
  });

  it('forwards the caller signal to the run', async () => {
    const { gateway, ports } = setup();
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    gateway.registerArena(ARENA);
    const controller = new AbortController();

    const run = gateway.run(CALLER, { text: 'hi' }, { signal: controller.signal });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalled());
    controller.abort();

    await expect(run).resolves.toMatchObject({ status: 'aborted' });
  });
});

describe('createMiniAppAgentGateway failure audit', () => {
  it('reports session creation failures as unavailable and turn failures as unknown outcome', async () => {
    const { gateway, ports, logger } = setup();
    const release = gateway.registerArena(ARENA);
    ports.createSession.mockRejectedValueOnce(new Error('db locked'));
    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
    expect(ports.runTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'rejected',
        errorCode: 'AGENT_UNAVAILABLE',
        stage: 'create-session',
        errorName: 'Error',
      }),
      'Mini App Agent run',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('db locked');

    ports.runTurn.mockRejectedValueOnce(new Error('stream closed'));
    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'AGENT_OUTCOME_UNKNOWN',
    });
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'terminal',
        stage: 'turn',
        errorCode: 'AGENT_OUTCOME_UNKNOWN',
        errorName: 'Error',
      }),
      'Mini App Agent run',
    );

    // Both failures released their slot on the same arena: a full batch is still admitted.
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const runs = Array.from({ length: MINIAPP_AGENT_DEFAULT_CONCURRENCY }, () =>
      gateway.run(CALLER, { text: 'hi' }),
    );
    await vi.waitFor(() =>
      expect(ports.runTurn).toHaveBeenCalledTimes(MINIAPP_AGENT_DEFAULT_CONCURRENCY + 1),
    );
    release();
    await expect(Promise.all(runs)).resolves.toEqual(
      runs.map(() => expect.objectContaining({ status: 'aborted' })),
    );
  });

  it('audits a run cancelled after its session was created', async () => {
    const { gateway, ports, logger } = setup();
    gateway.registerArena(ARENA);
    const controller = new AbortController();
    ports.createSession.mockImplementationOnce(async () => {
      controller.abort();
      return { sessionId: 'session-new' };
    });

    await expect(
      gateway.run(CALLER, { text: 'hi' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(ports.runTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'rejected',
        errorCode: 'REQUEST_CANCELLED',
        operation: 'run',
        sessionId: 'session-new',
        cancelledAfterCreate: true,
      }),
      'Mini App Agent run',
    );
  });

  it('logs a failed reply and reports a failure after dispatch as unknown', async () => {
    const { gateway, ports, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);
    const input = { sessionId: 'mine', requestId: 'perm-1', decision: 'deny' } as const;

    ports.replyPermission.mockRejectedValueOnce(new Error('ipc closed'));
    await expect(gateway.reply(CALLER, input)).rejects.toMatchObject({
      code: 'AGENT_OUTCOME_UNKNOWN',
    });
    const unavailable = new MiniAppAgentError('AGENT_UNAVAILABLE', 'lookup failed', true);
    ports.replyPermission.mockRejectedValueOnce(unavailable);
    await expect(gateway.reply(CALLER, input)).rejects.toBe(unavailable);

    const audit = { phase: 'rejected', stage: 'reply', sessionId: 'mine', requestId: 'perm-1' };
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({
          ...audit,
          errorCode: 'AGENT_OUTCOME_UNKNOWN',
          errorName: 'Error',
        }),
        'Mini App Agent run',
      ],
      [
        expect.objectContaining({
          ...audit,
          errorCode: 'AGENT_UNAVAILABLE',
          errorName: 'MiniAppAgentError',
        }),
        'Mini App Agent run',
      ],
    ]);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('createMiniAppAgentGateway session context', () => {
  const PAGE: MiniAppAgentCaller = { ...CALLER, source: 'page', hostSessionId: 'chat-1' };
  const HOST_MODEL = { providerId: 'byok', modelId: 'orion', variant: 'thinking' };
  const pluginDir = (agentName: string) =>
    join('/data', 'agents', agentName, 'miniapps', 'demo%20board');

  it('works in the project directory of a host chat that has one, with its agent', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'miniapp-host-project-'));
    try {
      const { gateway, ports, logger } = setup();
      ports.resolveHostSession.mockResolvedValue({
        agentName: 'custom-x',
        workspaceDir: projectDir,
        isDefaultWorkspace: false,
        model: HOST_MODEL,
      });
      gateway.registerArena(ARENA);

      await gateway.run(PAGE, { text: 'hi' });

      expect(ports.resolveHostSession.mock.calls).toEqual([['chat-1']]);
      expect(ports.createSession).toHaveBeenCalledWith({
        pluginId: 'demo board',
        agentName: 'custom-x',
        workspaceDir: projectDir,
        createDir: false,
        model: HOST_MODEL,
      });
      expect(ports.defaultSessionModel).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ hostSessionId: 'chat-1' }),
        expect.anything(),
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('uses the plugin directory of the host agent when the host chat has no project', async () => {
    const { gateway, ports } = setup();
    ports.resolveHostSession.mockResolvedValue({
      agentName: 'custom-x',
      workspaceDir: '/home/user/.mavis/default-workspace',
      isDefaultWorkspace: true,
    });
    gateway.registerArena(ARENA);

    await gateway.run(PAGE, { text: 'hi' });

    // The permission module only lets an agent read dataDir paths under its own agent assets.
    expect(ports.createSession).toHaveBeenCalledWith({
      pluginId: 'demo board',
      agentName: 'custom-x',
      workspaceDir: pluginDir('custom-x'),
      createDir: true,
      // The host chat record carries no model, so the runtime default is frozen instead.
      model: DEFAULT_MODEL,
    });
    expect(ports.defaultSessionModel).toHaveBeenCalledTimes(1);
  });

  it('falls back to the plugin directory, traceably, when the project directory is gone', async () => {
    const { gateway, ports, logger } = setup();
    const projectDir = await mkdtemp(join(tmpdir(), 'miniapp-host-project-'));
    await rm(projectDir, { recursive: true });
    ports.resolveHostSession.mockResolvedValue({
      agentName: 'custom-x',
      workspaceDir: projectDir,
      isDefaultWorkspace: false,
    });
    gateway.registerArena(ARENA);

    await gateway.run(PAGE, { text: 'hi' });

    expect(ports.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'custom-x',
        workspaceDir: pluginDir('custom-x'),
        createDir: true,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      {
        pluginId: 'demo board',
        hostSessionId: 'chat-1',
        agentName: 'custom-x',
        workspaceSource: 'plugin',
      },
      'Mini App Agent host chat project directory is gone; using the plugin directory',
    );
  });

  it('falls back to the default agent and its plugin directory when the host chat is gone', async () => {
    const { gateway, ports, logger } = setup();
    gateway.registerArena(ARENA);

    await gateway.run({ ...PAGE, hostSessionId: 'gone' }, { text: 'hi' });

    expect(ports.resolveHostSession.mock.calls).toEqual([['gone']]);
    expect(ports.createSession).toHaveBeenCalledWith({
      pluginId: 'demo board',
      agentName: 'mavis',
      workspaceDir: pluginDir('mavis'),
      createDir: true,
      model: DEFAULT_MODEL,
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        pluginId: 'demo board',
        hostSessionId: 'gone',
        agentName: 'mavis',
        workspaceSource: 'plugin',
      },
      'Mini App Agent host chat session not found; using the default agent',
    );
  });

  it('passes the ports result and turn.started model through unchanged', async () => {
    const { gateway, ports } = setup();
    // The record holds the runtime-normalized selection; nothing in the request carries a variant.
    const recorded = { providerId: 'byok', modelId: 'orion', variant: 'thinking' };
    ports.runTurn.mockImplementation(async ({ sessionId, onEvent }) => {
      onEvent?.({ type: 'turn.started', sessionId, turnId: 'turn-1', model: recorded });
      return { turnId: 'turn-1', status: 'finished', model: recorded };
    });
    gateway.registerArena(ARENA);
    const events: MiniAppAgentRunEvent[] = [];

    const result = await gateway.run(PAGE, { text: 'hi' }, { onEvent: (e) => events.push(e) });

    expect(result.model).toEqual(recorded);
    expect(events).toContainEqual({
      type: 'turn.started',
      sessionId: 'session-new',
      turnId: 'turn-1',
      model: recorded,
    });
  });

  it('keeps the agent and directory of a continued session and ignores hostSessionId', async () => {
    const { gateway, ports, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);

    await gateway.run(PAGE, { text: 'hi', sessionId: 'mine' });

    expect(ports.resolveHostSession).not.toHaveBeenCalled();
    expect(ports.createSession).not.toHaveBeenCalled();
    expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty('agentName');
  });

  it.each([false, true])(
    'binds a queued Page session to its host context at creation (project removed while waiting: %s)',
    async (removeProject) => {
      const projectDir = await mkdtemp(join(tmpdir(), 'miniapp-queued-host-project-'));
      const { gateway, ports, turns, release, running } = await fullArena(1);
      ports.resolveHostSession.mockResolvedValue({
        agentName: 'custom-x',
        workspaceDir: projectDir,
        isDefaultWorkspace: false,
      });
      const onEvent = vi.fn();
      const queued = gateway.run(PAGE, { text: 'queued page' }, { onEvent });
      const settled = Promise.allSettled([...running, queued]);
      try {
        expect(onEvent).toHaveBeenCalledWith({ type: 'run.queued', position: 1 });
        expect(ports.createSession).toHaveBeenCalledTimes(1);
        expect(ports.resolveHostSession).not.toHaveBeenCalled();
        if (removeProject) await rm(projectDir, { recursive: true });

        turns.finish(0);
        await vi.waitFor(() => expect(turns.texts()).toEqual(['r1', 'queued page']));

        // The host has no stored model, so the new session snapshots the runtime default.
        expect(ports.createSession).toHaveBeenLastCalledWith({
          pluginId: 'demo board',
          agentName: 'custom-x',
          workspaceDir: removeProject ? pluginDir('custom-x') : projectDir,
          createDir: removeProject,
          model: DEFAULT_MODEL,
        });
        turns.finish(1);
        await expect(queued).resolves.toMatchObject({ status: 'finished' });
      } finally {
        release();
        await settled;
        await rm(projectDir, { recursive: true, force: true });
      }
    },
  );
});

describe('createMiniAppAgentGateway session exclusivity', () => {
  it('rejects a second run on a session that is already running as retryable BUSY', async () => {
    const { gateway, ports, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena(ARENA);

    const first = gateway.run(CALLER, { text: 'hi', sessionId: 'mine' });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalledTimes(1));
    await expect(gateway.run(CALLER, { text: 'hi', sessionId: 'mine' })).rejects.toMatchObject({
      code: 'BUSY',
      retryable: true,
      reason: 'session_busy',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'rejected', errorCode: 'BUSY', reason: 'session_busy' }),
      'Mini App Agent run',
    );

    release();
    await expect(first).resolves.toMatchObject({ status: 'aborted' });
    const next = gateway.registerArena(ARENA);
    ports.runTurn.mockResolvedValueOnce({ turnId: 'turn-2', status: 'finished' });
    await expect(gateway.run(CALLER, { text: 'hi', sessionId: 'mine' })).resolves.toMatchObject({
      status: 'finished',
    });
    next();
  });
});

describe('createMiniAppAgentGateway run queue', () => {
  it('starts waiting runs in FIFO order as slots free and audits where each waited', async () => {
    const { gateway, logger, turns, release, running } = await fullArena();
    const events: MiniAppAgentRunEvent[] = [];
    const queued = ['q1', 'q2', 'q3'].map((text) =>
      gateway.run(CALLER, { text }, { onEvent: (event) => events.push(event) }),
    );
    expect(events).toEqual([1, 2, 3].map((position) => ({ type: 'run.queued', position })));

    for (const [index, slot] of [1, 0, 2].entries()) {
      turns.finish(slot);
      await vi.waitFor(() => expect(turns.texts()).toHaveLength(5 + index));
    }
    expect(turns.texts()).toEqual(['r1', 'r2', 'r3', 'r4', 'q1', 'q2', 'q3']);
    const admissions = logger.info.mock.calls
      .map(([fields]) => fields)
      .filter((fields) => fields.phase === 'admission');
    expect(admissions.map((fields) => (fields.queued ? fields.position : 0))).toEqual([
      0, 0, 0, 0, 1, 2, 3,
    ]);

    release();
    await Promise.all([...running, ...queued]);
  });

  it('refuses a call for a running session at once instead of queueing it', async () => {
    const { gateway, release, running } = await fullArena();
    const onEvent = vi.fn();

    await expect(
      gateway.run(CALLER, { text: 'again', sessionId: 'session-1' }, { onEvent }),
    ).rejects.toMatchObject({ code: 'BUSY', retryable: true, reason: 'session_busy' });
    await expect(
      gateway.answer(CALLER, { sessionId: 'session-2', requestId: 'q', answers: [] }, { onEvent }),
    ).rejects.toMatchObject({ code: 'BUSY', reason: 'session_busy' });
    expect(onEvent).not.toHaveBeenCalled();

    release();
    await Promise.all(running);
  });

  it('refuses a call beyond the wait bound as queue_full', async () => {
    const { gateway, logger, release, running } = await fullArena();
    const queued = Promise.allSettled(
      Array.from({ length: DEFAULT_QUEUE_BOUND }, () => gateway.run(CALLER, { text: 'q' })),
    );
    const onEvent = vi.fn();

    await expect(gateway.run(CALLER, { text: 'q' }, { onEvent })).rejects.toMatchObject({
      code: 'BUSY',
      retryable: true,
      reason: 'queue_full',
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'rejected', errorCode: 'BUSY', reason: 'queue_full' }),
      'Mini App Agent run',
    );

    release();
    await Promise.all(running);
    expect((await queued).map(({ status }) => status)).toEqual(
      Array.from({ length: DEFAULT_QUEUE_BOUND }, () => 'rejected'),
    );
  });

  it('cancels a waiting call on abort and keeps the order of the rest', async () => {
    const { gateway, logger, turns, release, running } = await fullArena();
    const controller = new AbortController();
    const first = gateway.run(CALLER, { text: 'q1' });
    const cancelled = gateway.run(CALLER, { text: 'q2' }, { signal: controller.signal });
    const third = gateway.run(CALLER, { text: 'q3' });

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'REQUEST_CANCELLED', stage: 'queue', operation: 'run' }),
      'Mini App Agent run',
    );
    const onEvent = vi.fn();
    const fourth = gateway.run(CALLER, { text: 'q4' }, { onEvent });
    expect(onEvent).toHaveBeenCalledWith({ type: 'run.queued', position: 3 });
    for (const [index, slot] of [0, 1, 2].entries()) {
      turns.finish(slot);
      await vi.waitFor(() => expect(turns.texts()).toHaveLength(5 + index));
    }
    expect(turns.texts().slice(4)).toEqual(['q1', 'q3', 'q4']);

    release();
    await Promise.all([...running, first, third, fourth]);
  });

  it('cancels every waiting call when the arena is released', async () => {
    const { gateway, ports, release, running } = await fullArena();
    const queued = Promise.allSettled([
      gateway.run(CALLER, { text: 'q1' }),
      gateway.answer(CALLER, { sessionId: 'mine', requestId: 'q', answers: [] }),
    ]);

    release();

    const cancelled = {
      status: 'rejected',
      reason: expect.objectContaining({ code: 'REQUEST_CANCELLED' }),
    };
    await expect(queued).resolves.toEqual([cancelled, cancelled]);
    await expect(Promise.all(running)).resolves.toEqual(
      running.map(() => expect.objectContaining({ status: 'aborted' })),
    );
    expect(ports.runTurn).toHaveBeenCalledTimes(MINIAPP_AGENT_DEFAULT_CONCURRENCY);
    expect(ports.answerQuestion).not.toHaveBeenCalled();
  });

  it('refuses a waiting call whose session started while it waited, and frees its slot', async () => {
    const { gateway, turns, release, running } = await fullArena();
    const MINIAPP_ROOT = { miniApp: true, parentSessionId: null };
    const events: MiniAppAgentRunEvent[] = [];
    const onEvent = (event: MiniAppAgentRunEvent) => events.push(event);
    const first = gateway.run(CALLER, { text: 'a', sessionId: 'mine' }, { onEvent });
    const second = gateway.run(CALLER, { text: 'b', sessionId: 'mine' }, { onEvent });
    expect(events).toEqual([
      { type: 'run.queued', sessionId: 'mine', position: 1 },
      { type: 'run.queued', sessionId: 'mine', position: 2 },
    ]);
    // A waiting call is no one who can answer an ask yet.
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(true);

    turns.finish(0);
    await vi.waitFor(() => expect(turns.texts()).toHaveLength(5));
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(false);
    turns.finish(1);
    await expect(second).rejects.toMatchObject({ code: 'BUSY', reason: 'session_busy' });
    const next = gateway.run(CALLER, { text: 'c' });
    await vi.waitFor(() => expect(turns.texts()).toEqual(['r1', 'r2', 'r3', 'r4', 'a', 'c']));

    release();
    await Promise.all([...running, first, next]);
  });
});

describe('createMiniAppAgentGateway declared concurrency', () => {
  it('runs as many calls at once as the policy allows and queues the next', async () => {
    const { gateway, turns, release, running } = await fullArena(2);
    const onEvent = vi.fn();

    const third = gateway.run(CALLER, { text: 'q1' }, { onEvent });

    expect(turns.texts()).toEqual(['r1', 'r2']);
    expect(onEvent).toHaveBeenCalledWith({ type: 'run.queued', position: 1 });
    turns.finish(0);
    await vi.waitFor(() => expect(turns.texts()).toEqual(['r1', 'r2', 'q1']));

    release();
    await Promise.all([...running, third]);
  });

  it('scales the wait bound with the declared concurrency', async () => {
    const { gateway, release, running } = await fullArena(1);
    const queued = Promise.allSettled(
      Array.from({ length: MINIAPP_AGENT_QUEUE_FACTOR }, () => gateway.run(CALLER, { text: 'q' })),
    );

    await expect(gateway.run(CALLER, { text: 'q' })).rejects.toMatchObject({
      code: 'BUSY',
      reason: 'queue_full',
    });

    release();
    await Promise.all(running);
    await queued;
  });
});

describe('createMiniAppAgentGateway approval routing', () => {
  it('never denies before bind, then only for Mini App sessions nobody listens to', async () => {
    const unbound = setup({ bind: false });
    await expect(unbound.gateway.shouldDenyApproval('chat')).resolves.toBe(false);

    const { gateway, ports } = setup();
    ports.getOwner.mockImplementation(async (sessionId) =>
      sessionId.startsWith('mine') ? 'demo board' : undefined,
    );
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena(ARENA);

    await expect(gateway.shouldDenyApproval('chat')).resolves.toBe(false);
    await expect(gateway.shouldDenyApproval('mine')).resolves.toBe(true);
    const listened = gateway.run(CALLER, { text: 'hi', sessionId: 'mine' }, { onEvent: vi.fn() });
    const silent = gateway.run(CALLER, { text: 'hi', sessionId: 'mine-silent' });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalledTimes(2));

    await expect(gateway.shouldDenyApproval('mine')).resolves.toBe(false);
    await expect(gateway.shouldDenyApproval('mine-silent')).resolves.toBe(true);
    release();
    await Promise.all([listened, silent]);
    await expect(gateway.shouldDenyApproval('mine')).resolves.toBe(true);
  });

  it('denies a session started from a chat unless its panel is open', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockImplementation(async (sessionId) =>
      sessionId === 'page-made' ? 'demo board' : undefined,
    );

    // Creating the session from a chat is not evidence that anyone is watching it.
    await expect(gateway.shouldDenyApproval('page-made')).resolves.toBe(true);
    gateway.panelOpened({ sessionId: 'page-made', hostSessionId: 'chat-1' });
    await expect(gateway.shouldDenyApproval('page-made')).resolves.toBe(false);
    gateway.panelClosed({ sessionId: 'page-made', hostSessionId: 'chat-1' });
    await expect(gateway.shouldDenyApproval('page-made')).resolves.toBe(true);
  });

  it('fails the lookup instead of guessing when ownership cannot be read', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockRejectedValue(new Error('db locked'));

    await expect(gateway.shouldDenyApproval('mine')).rejects.toThrow('db locked');
  });

  it('forwards a permission ask only to the run of its session', async () => {
    const { gateway, ports, ask } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.runTurn.mockImplementation(({ sessionId, signal, onEvent }) => {
      onEvent?.({
        type: 'turn.started',
        sessionId,
        turnId: `turn-${sessionId}`,
        model: DEFAULT_MODEL,
      });
      return untilAborted(signal);
    });
    const release = gateway.registerArena(ARENA);
    const first: MiniAppAgentRunEvent[] = [];
    const second: MiniAppAgentRunEvent[] = [];
    const runs = [
      gateway.run(CALLER, { text: 'hi', sessionId: 'a' }, { onEvent: (e) => first.push(e) }),
      gateway.run(CALLER, { text: 'hi', sessionId: 'b' }, { onEvent: (e) => second.push(e) }),
    ];
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalledTimes(2));

    ask({ sessionId: 'a', requestId: 'perm-1', toolName: 'bash', toolInput: 'ls', reason: 'r' });
    ask({ sessionId: 'nobody', requestId: 'perm-2', toolName: 'bash', reason: 'r' });
    ask({ sessionId: 'b', turnId: 'turn-x', requestId: 'perm-3', toolName: 'write', reason: 'r' });

    expect(first.slice(1)).toEqual([
      {
        type: 'permission.requested',
        sessionId: 'a',
        turnId: 'turn-a',
        requestId: 'perm-1',
        toolName: 'bash',
        toolInput: 'ls',
        reason: 'r',
      },
    ]);
    expect(second.slice(1)).toEqual([
      {
        type: 'permission.requested',
        sessionId: 'b',
        turnId: 'turn-x',
        requestId: 'perm-3',
        toolName: 'write',
        reason: 'r',
      },
    ]);
    release();
    await Promise.all(runs);
  });

  it('routes asks of delegated child sessions through their Mini App root', async () => {
    const { gateway, ports, ask } = setup();
    ports.getOwner.mockImplementation(async (sessionId) =>
      sessionId.startsWith('mine') ? 'demo board' : undefined,
    );
    ports.resolveMiniAppRoot.mockImplementation(async (sessionId) => {
      if (sessionId.startsWith('mine')) return { rootSessionId: sessionId, pluginId: 'demo board' };
      if (sessionId === 'child') return { rootSessionId: 'mine', pluginId: 'demo board' };
      if (sessionId === 'silent-child') {
        return { rootSessionId: 'mine-silent', pluginId: 'demo board' };
      }
      return undefined;
    });
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena(ARENA);
    const events: MiniAppAgentRunEvent[] = [];
    const run = gateway.run(
      CALLER,
      { text: 'hi', sessionId: 'mine' },
      { onEvent: (event) => events.push(event) },
    );
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalled());

    await expect(gateway.shouldDenyApproval('child')).resolves.toBe(false);
    await expect(gateway.shouldDenyApproval('silent-child')).resolves.toBe(true);
    ask({ sessionId: 'child', requestId: 'perm-c', toolName: 'bash', reason: 'r' });
    ask({ sessionId: 'silent-child', requestId: 'perm-s', toolName: 'bash', reason: 'r' });

    // The child keeps its own sessionId, which is what the author replies with; no turn is known.
    await vi.waitFor(() =>
      expect(events).toEqual([
        {
          type: 'permission.requested',
          sessionId: 'child',
          requestId: 'perm-c',
          toolName: 'bash',
          reason: 'r',
        },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    release();
    await run;
  });
});

describe('createMiniAppAgentGateway approval lineage', () => {
  const ORDINARY = { miniApp: false, parentSessionId: null };
  const MINIAPP_ROOT = { miniApp: true, parentSessionId: null };

  it('answers an ordinary root session or SideChat without touching the ports', async () => {
    const { gateway, ports } = setup();

    await expect(gateway.shouldDenyApproval('chat', ORDINARY)).resolves.toBe(false);
    await expect(gateway.shouldDenyApproval('chat', { miniApp: false })).resolves.toBe(false);
    expect(ports.resolveMiniAppRoot).not.toHaveBeenCalled();
    expect(ports.getOwner).not.toHaveBeenCalled();
  });

  it('decides a Mini App root from its listener and panel without touching the ports', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena(ARENA);

    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(true);
    const run = gateway.run(CALLER, { text: 'hi', sessionId: 'mine' }, { onEvent: vi.fn() });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalled());
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(false);
    release();
    await run;
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(true);

    gateway.panelOpened({ sessionId: 'mine', hostSessionId: 'chat-1' });
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(false);
    gateway.panelClosed({ sessionId: 'mine', hostSessionId: 'chat-1' });
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(true);
    expect(ports.resolveMiniAppRoot).not.toHaveBeenCalled();
  });

  it('keeps a session answerable while any chat still shows it', async () => {
    const { gateway } = setup();
    gateway.panelOpened({ sessionId: 'mine', hostSessionId: 'chat-1' });
    gateway.panelOpened({ sessionId: 'mine', hostSessionId: 'chat-2' });

    gateway.panelClosed({ sessionId: 'mine', hostSessionId: 'chat-1' });
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(false);
    gateway.panelClosed({ sessionId: 'mine', hostSessionId: 'chat-2' });
    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(true);
    // Closing a tab that was never reported open is a no-op.
    gateway.panelClosed({ sessionId: 'other', hostSessionId: 'chat-1' });
  });

  it.each([
    ['a delegated child', { miniApp: false, parentSessionId: 'mine' }],
    ['a caller without lineage', undefined],
  ])('walks to the Mini App root for %s', async (_name, lineage) => {
    const { gateway, ports } = setup();
    ports.resolveMiniAppRoot.mockResolvedValue({ rootSessionId: 'mine', pluginId: 'demo board' });

    await expect(gateway.shouldDenyApproval('child', lineage)).resolves.toBe(true);
    gateway.panelOpened({ sessionId: 'mine', hostSessionId: 'chat-1' });
    await expect(gateway.shouldDenyApproval('child', lineage)).resolves.toBe(false);
    expect(ports.resolveMiniAppRoot).toHaveBeenCalledWith('child');
    ports.resolveMiniAppRoot.mockRejectedValue(new Error('db locked'));
    await expect(gateway.shouldDenyApproval('child', lineage)).rejects.toThrow('db locked');
  });

  it('never denies before bind, whatever the lineage says', async () => {
    const { gateway } = setup({ bind: false });

    await expect(gateway.shouldDenyApproval('mine', MINIAPP_ROOT)).resolves.toBe(false);
  });

  it('logs a listener that throws on an ask and keeps delivering', async () => {
    const { gateway, ports, ask, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena(ARENA);
    const onEvent = vi.fn(() => {
      throw new TypeError('author bug');
    });
    const run = gateway.run(CALLER, { text: 'hi', sessionId: 'mine' }, { onEvent });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalled());

    ask({ sessionId: 'mine', requestId: 'perm-1', toolName: 'bash', reason: 'r' });
    ask({ sessionId: 'mine', requestId: 'perm-2', toolName: 'bash', reason: 'r' });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: 'mine', requestId: 'perm-1', errorName: 'TypeError' },
      'Mini App Agent listener threw on ask',
    );
    release();
    await run;
  });
});

describe('createMiniAppAgentGateway reply', () => {
  it('decides a pending request of an owned session and audits it', async () => {
    const { gateway, ports, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);

    await gateway.reply(CALLER, { sessionId: 'mine', requestId: 'perm-1', decision: 'allowOnce' });

    expect(ports.replyPermission).toHaveBeenCalledWith({
      sessionId: 'mine',
      requestId: 'perm-1',
      decision: 'allowOnce',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'demo board',
        sessionId: 'mine',
        operation: 'reply',
        decision: 'allowOnce',
        outcome: 'processed',
      }),
      'Mini App Agent run',
    );
  });

  it('rejects unknown requests, foreign sessions, bad decisions and missing permission', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockImplementation(async (sessionId) =>
      sessionId === 'mine' ? 'demo board' : 'other',
    );
    const input = { sessionId: 'mine', requestId: 'perm-1', decision: 'deny' } as const;

    await expect(gateway.reply(CALLER, input)).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
    gateway.registerArena(ARENA);
    ports.replyPermission.mockResolvedValueOnce('skipped');
    await expect(gateway.reply(CALLER, input)).rejects.toMatchObject({
      code: 'REQUEST_NOT_FOUND',
    });
    await expect(gateway.reply(CALLER, { ...input, sessionId: 'theirs' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(
      gateway.reply(CALLER, { ...input, decision: 'allowAlways' as never }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.replyPermission).toHaveBeenCalledTimes(1);
  });

  it('decides a request of a delegated child but never one under another plugin', async () => {
    const { gateway, ports } = setup();
    ports.resolveMiniAppRoot.mockImplementation(async (sessionId) =>
      sessionId === 'child'
        ? { rootSessionId: 'mine', pluginId: 'demo board' }
        : sessionId === 'their-child'
          ? { rootSessionId: 'theirs', pluginId: 'other' }
          : undefined,
    );
    gateway.registerArena(ARENA);

    await gateway.reply(CALLER, { sessionId: 'child', requestId: 'perm-c', decision: 'deny' });
    await expect(
      gateway.reply(CALLER, { sessionId: 'their-child', requestId: 'perm-t', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(ports.replyPermission.mock.calls).toEqual([
      [{ sessionId: 'child', requestId: 'perm-c', decision: 'deny' }],
    ]);
  });

  it('rejects a non-Mini-App session and a stale caller generation', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);
    const input = { sessionId: 'mine', requestId: 'perm-1', decision: 'deny' } as const;

    ports.resolveMiniAppRoot.mockResolvedValueOnce(undefined);
    await expect(gateway.reply(CALLER, { ...input, sessionId: 'chat' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(
      gateway.reply({ ...CALLER, processGeneration: 'gen-0' }, input),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(ports.replyPermission).not.toHaveBeenCalled();
  });

  it('reports a request raised under another session of the same plugin as not found', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    // The ports only settle a request raised under the given session's root.
    ports.replyPermission.mockResolvedValueOnce('skipped');
    gateway.registerArena(ARENA);

    await expect(
      gateway.reply(CALLER, { sessionId: 'mine', requestId: 'perm-of-mine-2', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    expect(ports.replyPermission).toHaveBeenCalledWith({
      sessionId: 'mine',
      requestId: 'perm-of-mine-2',
      decision: 'deny',
    });
  });
});

describe('createMiniAppAgentGateway open', () => {
  const PAGE: MiniAppAgentCaller = { ...CALLER, source: 'page', hostSessionId: 'chat-1' };

  function withSessions() {
    const harness = setup();
    harness.ports.resolveMiniAppRoot.mockImplementation(async (sessionId) => {
      switch (sessionId) {
        case 'mine':
        case 'child':
          return { rootSessionId: 'mine', pluginId: 'demo board' };
        case 'other-chat':
          return { rootSessionId: 'other-chat', pluginId: 'demo board' };
        case 'node-made':
          return { rootSessionId: 'node-made', pluginId: 'demo board' };
        case 'theirs':
          return { rootSessionId: 'theirs', pluginId: 'other' };
        default:
          return undefined;
      }
    });
    return harness;
  }

  it('confirms a session this plugin started from the caller chat and audits it', async () => {
    const { gateway, logger } = withSessions();
    gateway.registerArena(ARENA);

    await expect(gateway.open(PAGE, { sessionId: 'mine' })).resolves.toEqual({
      sessionId: 'mine',
      hostSessionId: 'chat-1',
    });
    expect(logger.info.mock.calls).toEqual([
      [
        {
          pluginId: 'demo board',
          processGeneration: 'gen-1',
          source: 'page',
          sessionId: 'mine',
          operation: 'open',
        },
        'Mini App Agent run',
      ],
    ]);
  });

  it.each(['other-chat', 'node-made'])(
    'opens %s in the chat the Mini App is open in now, whichever chat created it',
    async (sessionId) => {
      const { gateway } = withSessions();
      gateway.registerArena(ARENA);

      await expect(gateway.open(PAGE, { sessionId })).resolves.toEqual({
        sessionId,
        hostSessionId: 'chat-1',
      });
    },
  );

  it.each(['child', 'theirs', 'chat'])('hides %s as SESSION_NOT_FOUND', async (sessionId) => {
    const { gateway, logger } = withSessions();
    gateway.registerArena(ARENA);

    await expect(gateway.open(PAGE, { sessionId })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('refuses a caller without a host chat or an arena, and a stale caller is unavailable', async () => {
    const { gateway, ports } = withSessions();

    await expect(gateway.open(PAGE, { sessionId: 'mine' })).rejects.toMatchObject({
      code: 'NOT_PERMITTED',
    });
    gateway.registerArena(ARENA);
    await expect(gateway.open(CALLER, { sessionId: 'mine' })).rejects.toMatchObject({
      code: 'NOT_PERMITTED',
    });
    await expect(
      gateway.open({ ...PAGE, processGeneration: 'gen-0' }, { sessionId: 'mine' }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(ports.resolveMiniAppRoot).not.toHaveBeenCalled();
  });

  it('reports an unreadable session as unavailable', async () => {
    const { gateway, ports } = withSessions();
    gateway.registerArena(ARENA);
    ports.resolveMiniAppRoot.mockRejectedValueOnce(new Error('db locked'));

    await expect(gateway.open(PAGE, { sessionId: 'mine' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
  });
});

describe('createMiniAppAgentGateway answer', () => {
  const ANSWER = {
    sessionId: 'mine',
    requestId: 'question-1',
    answers: [{ stepId: 's1', selectedOptionIds: ['a'], selectedOther: false }],
  };

  it('follows the continuation turn of an owned session and audits it', async () => {
    const { gateway, ports, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);
    const onEvent = vi.fn();

    await expect(gateway.answer(CALLER, ANSWER, { onEvent })).resolves.toEqual({
      sessionId: 'mine',
      turnId: 'turn-2',
      status: 'finished',
      text: 'continued',
    });
    expect(ports.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'mine',
        requestId: 'question-1',
        answers: ANSWER.answers,
        onEvent: expect.any(Function),
      }),
    );
    expect(logger.info.mock.calls.map(([fields]) => [fields.phase, fields.operation])).toEqual([
      ['admission', 'answer'],
      ['terminal', 'answer'],
    ]);
  });

  it('shares the run slots and their queue, and the one-run-per-session rule', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    const turns = holdTurns(ports);
    const release = gateway.registerArena(ARENA);

    const running = gateway.run(CALLER, { text: 'hi', sessionId: 'mine' });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalledTimes(1));
    await expect(gateway.answer(CALLER, ANSWER)).rejects.toMatchObject({
      code: 'BUSY',
      retryable: true,
      reason: 'session_busy',
    });
    const others = Array.from({ length: MINIAPP_AGENT_DEFAULT_CONCURRENCY - 1 }, () =>
      gateway.run(CALLER, { text: 'hi' }),
    );
    await vi.waitFor(() =>
      expect(ports.runTurn).toHaveBeenCalledTimes(MINIAPP_AGENT_DEFAULT_CONCURRENCY),
    );
    const events: MiniAppAgentRunEvent[] = [];
    const waiting = gateway.answer(
      CALLER,
      { ...ANSWER, sessionId: 'mine-2' },
      { onEvent: (event) => events.push(event) },
    );
    expect(events).toEqual([{ type: 'run.queued', sessionId: 'mine-2', position: 1 }]);
    await Promise.resolve();
    expect(ports.answerQuestion).not.toHaveBeenCalled();

    // Any slot that frees goes to the waiting answer, whichever run held it.
    turns.finish(1);
    await expect(others[0]).resolves.toMatchObject({ status: 'finished' });
    await expect(waiting).resolves.toMatchObject({ sessionId: 'mine-2', status: 'finished' });

    release();
    await Promise.all([running, ...others]);
  });

  it('rejects a foreign session and a missing session id', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('other');
    gateway.registerArena(ARENA);

    await expect(gateway.answer(CALLER, ANSWER)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(
      gateway.answer(CALLER, { ...ANSWER, sessionId: undefined as never }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.answerQuestion).not.toHaveBeenCalled();
  });

  it('rejects a non-Mini-App session, a delegated child and a stale caller generation', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockImplementation(async (sessionId) =>
      sessionId === 'mine' ? 'demo board' : undefined,
    );
    // A child resolves to the caller's root, but answers continue the Mini App session itself.
    ports.resolveMiniAppRoot.mockResolvedValue({ rootSessionId: 'mine', pluginId: 'demo board' });
    gateway.registerArena(ARENA);

    for (const sessionId of ['chat', 'child']) {
      await expect(gateway.answer(CALLER, { ...ANSWER, sessionId })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    }
    await expect(
      gateway.answer({ ...CALLER, processGeneration: 'gen-0' }, ANSWER),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(ports.answerQuestion).not.toHaveBeenCalled();
  });
});

describe('createMiniAppAgentGateway model override', () => {
  const REQUESTED = { providerId: 'minimax', modelId: 'M3' };
  const RESOLVED = { providerId: 'minimax', modelId: 'M3', variant: 'fast' };

  it('validates then persists the requested model before dispatching', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.resolveModel.mockResolvedValue(RESOLVED);
    ports.readSessionModel.mockResolvedValue(RESOLVED);
    gateway.registerArena(ARENA);

    await gateway.run(CALLER, { text: 'x', sessionId: 'mine', model: REQUESTED });

    expect(ports.resolveModel).toHaveBeenCalledWith(REQUESTED);
    expect(ports.setSessionModel).toHaveBeenCalledWith('mine', RESOLVED);
    expect(ports.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      ports.runTurn.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('leaves the session model alone when no model is requested', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);

    await gateway.run(CALLER, { text: 'x', sessionId: 'mine' });

    expect(ports.setSessionModel).not.toHaveBeenCalled();
  });

  it('creates a new session with the requested model, without a second write', async () => {
    const { gateway, ports } = setup();
    ports.resolveModel.mockImplementation(async (requested) => requested ?? DEFAULT_MODEL);
    const other = { providerId: 'minimax', modelId: 'M2' };
    gateway.registerArena(ARENA);

    await gateway.run(CALLER, { text: 'x', model: other });

    expect(ports.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: other }));
    expect(ports.setSessionModel).not.toHaveBeenCalled();
    expect(ports.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      ports.runTurn.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rejects an unavailable model unchanged, without touching the session', async () => {
    const { gateway, ports, logger } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.resolveModel.mockRejectedValue(
      new MiniAppAgentError('INVALID_ARGUMENTS', 'Model is not available'),
    );
    gateway.registerArena(ARENA);

    await expect(
      gateway.run(CALLER, {
        text: 'x',
        sessionId: 'mine',
        model: { providerId: 'nope', modelId: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS', retryable: false });
    expect(ports.setSessionModel).not.toHaveBeenCalled();
    expect(ports.runTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'rejected',
        errorCode: 'INVALID_ARGUMENTS',
        stage: 'resolve-model',
        operation: 'run',
        sessionId: 'mine',
      }),
      'Mini App Agent run',
    );
  });

  it('creates no session for an unusable model, and frees its slot for the next queued call', async () => {
    const { gateway, ports, turns, release, running } = await fullArena(1);
    ports.resolveModel.mockImplementation(async (requested) => {
      if (requested?.modelId === 'nope') {
        throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Model is not available');
      }
      return requested ?? DEFAULT_MODEL;
    });
    const created = ports.createSession.mock.calls.length;

    const refused = gateway.run(CALLER, {
      text: 'bad',
      model: { providerId: 'minimax', modelId: 'nope' },
    });
    const refusedResult = expect(refused).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
      retryable: false,
    });
    const next = gateway.run(CALLER, { text: 'next' });
    turns.finish(0);

    await refusedResult;
    // The queue drained past the refused call: the next call got the slot and ran.
    await vi.waitFor(() => expect(turns.texts()).toEqual(['r1', 'next']));
    expect(ports.createSession).toHaveBeenCalledTimes(created + 1);
    expect(ports.setSessionModel).not.toHaveBeenCalled();

    turns.finish(1);
    await next;
    release();
    await Promise.all(running);
  });

  it('frees the slot of a call refused for an unusable model', async () => {
    const { gateway, ports } = setup();
    ports.resolveModel.mockImplementation(async (requested) => {
      if (requested) throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Model is not available');
      return DEFAULT_MODEL;
    });
    gateway.registerArena({
      ...ARENA,
      policy: { kind: 'allowlist', capabilities: ['session.run'], maxConcurrent: 1 },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        gateway.run(CALLER, { text: 'x', model: { providerId: 'nope', modelId: 'x' } }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    }
    expect(ports.createSession).not.toHaveBeenCalled();
    // Were the slot still taken, this would wait in the queue instead of running.
    await expect(gateway.run(CALLER, { text: 'ok' })).resolves.toMatchObject({
      status: 'finished',
    });
  });

  it('fails retryably, with nothing dispatched, when the model cannot be saved', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.setSessionModel.mockRejectedValue(new Error('db locked'));
    gateway.registerArena(ARENA);

    await expect(
      gateway.run(CALLER, { text: 'x', sessionId: 'mine', model: REQUESTED }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(ports.runTurn).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-object', 'minimax/M3'],
    ['a missing modelId', { providerId: 'minimax' }],
    ['a non-string thinking.effort', { ...REQUESTED, thinking: { effort: 1 } }],
  ])('rejects %s as INVALID_ARGUMENTS before any port call or slot', async (_label, model) => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);

    await expect(
      gateway.run(CALLER, { text: 'x', sessionId: 'mine', model: model as never }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.getOwner).not.toHaveBeenCalled();
    expect(ports.resolveModel).not.toHaveBeenCalled();
    expect(ports.setSessionModel).not.toHaveBeenCalled();
    expect(ports.runTurn).not.toHaveBeenCalled();
    // The failed call held no slot: the session can run at once.
    await expect(gateway.run(CALLER, { text: 'x', sessionId: 'mine' })).resolves.toMatchObject({
      status: 'finished',
    });
  });

  it('writes the model only after a queued run obtains its slot', async () => {
    const { gateway, ports, turns, release, running } = await fullArena(1);
    const other = { providerId: 'minimax', modelId: 'M2' };
    ports.resolveModel.mockImplementation(async (requested) => requested ?? DEFAULT_MODEL);

    const queued = gateway.run(CALLER, { text: 'q', sessionId: 'b', model: other });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ports.resolveModel).not.toHaveBeenCalledWith(other);
    expect(ports.setSessionModel).not.toHaveBeenCalled();

    turns.finish(0);
    await vi.waitFor(() => expect(turns.texts()).toEqual(['r1', 'q']));
    turns.finish(1);
    await queued;

    expect(ports.setSessionModel).toHaveBeenCalledWith('b', other);
    const [first, second] = ports.runTurn.mock.invocationCallOrder;
    const written = ports.setSessionModel.mock.invocationCallOrder[0] ?? 0;
    expect(written).toBeGreaterThan(first ?? Infinity);
    expect(written).toBeLessThan(second ?? 0);

    release();
    await Promise.all(running);
  });

  it('applies the model of an answer before the continuation, and updates a session whose answer starts no turn', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    ports.resolveModel.mockResolvedValue(RESOLVED);
    ports.answerQuestion.mockResolvedValue({ status: 'finished' });
    gateway.registerArena(ARENA);

    await expect(
      gateway.answer(CALLER, {
        sessionId: 'mine',
        requestId: 'question-1',
        answers: [],
        model: REQUESTED,
      }),
    ).resolves.toEqual({ sessionId: 'mine', status: 'finished' });

    expect(ports.setSessionModel).toHaveBeenCalledWith('mine', RESOLVED);
    expect(ports.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      ports.answerQuestion.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rejects a malformed model on answer before any port call', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);

    await expect(
      gateway.answer(CALLER, {
        sessionId: 'mine',
        requestId: 'question-1',
        answers: [],
        model: { providerId: 'minimax' } as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.answerQuestion).not.toHaveBeenCalled();
    expect(ports.setSessionModel).not.toHaveBeenCalled();
  });
});

/**
 * Fills every run slot of an arena allowing `maxConcurrent` runs with held runs `r1`, `r2`, ...,
 * each on a new session `session-<n>`.
 */
async function fullArena(maxConcurrent = MINIAPP_AGENT_DEFAULT_CONCURRENCY) {
  const harness = setup();
  let created = 0;
  harness.ports.createSession.mockImplementation(async () => ({
    sessionId: `session-${++created}`,
  }));
  harness.ports.getOwner.mockResolvedValue('demo board');
  const turns = holdTurns(harness.ports);
  const release = harness.gateway.registerArena({
    ...ARENA,
    policy: { kind: 'allowlist', capabilities: ['session.run'], maxConcurrent },
  });
  const running = Array.from({ length: maxConcurrent }, (_, index) =>
    harness.gateway.run(CALLER, { text: `r${index + 1}` }),
  );
  await vi.waitFor(() => expect(turns.texts()).toHaveLength(running.length));
  return { ...harness, turns, release, running };
}

describe('createMiniAppAgentGateway default model snapshot', () => {
  it('hands the default model context window to a session created on the default only', async () => {
    const { gateway, ports } = setup();
    ports.defaultSessionModel.mockResolvedValue({
      selection: DEFAULT_MODEL,
      contextWindow: 128000,
    });
    gateway.registerArena(ARENA);

    await gateway.run(CALLER, { text: 'x' });
    await gateway.run(CALLER, { text: 'y', model: { providerId: 'minimax', modelId: 'M2' } });

    expect(ports.createSession.mock.calls[0]?.[0]).toMatchObject({
      model: DEFAULT_MODEL,
      contextWindow: 128000,
    });
    expect(ports.createSession.mock.calls[1]?.[0]).not.toHaveProperty('contextWindow');
  });
});

describe('createMiniAppAgentGateway models / agents / create', () => {
  const PAGE: MiniAppAgentCaller = { ...CALLER, source: 'page', hostSessionId: 'chat-1' };
  const HOST_MODEL = { providerId: 'byok', modelId: 'orion', variant: 'thinking' };
  const hostChat = { agentName: 'custom-x', workspaceDir: '/home/u/ws', isDefaultWorkspace: true };
  const pluginDir = (agentName: string) =>
    join('/data', 'agents', agentName, 'miniapps', 'demo%20board');

  it('lists the models with the default and, for a page, the host chat model', async () => {
    const { gateway, ports } = setup();
    ports.resolveHostSession.mockResolvedValue({ ...hostChat, model: HOST_MODEL });
    gateway.registerArena(ARENA);

    await expect(gateway.models(PAGE)).resolves.toEqual({
      models: MODEL_OPTIONS,
      default: DEFAULT_MODEL,
      host: HOST_MODEL,
    });
    expect(ports.resolveHostSession.mock.calls).toEqual([['chat-1']]);
  });

  it('reports the default as the host model when the host chat has none', async () => {
    const { gateway, ports } = setup();
    ports.resolveHostSession.mockResolvedValue(hostChat);
    gateway.registerArena(ARENA);

    await expect(gateway.models(PAGE)).resolves.toEqual({
      models: MODEL_OPTIONS,
      default: DEFAULT_MODEL,
      host: DEFAULT_MODEL,
    });
  });

  it('has no host model for a Node caller or a host chat that is gone', async () => {
    const { gateway, ports } = setup();
    gateway.registerArena(ARENA);

    const node = await gateway.models(CALLER);
    const gone = await gateway.models(PAGE);

    expect(node).toEqual({ models: MODEL_OPTIONS, default: DEFAULT_MODEL });
    expect(gone).toEqual({ models: MODEL_OPTIONS, default: DEFAULT_MODEL });
    expect(ports.resolveHostSession.mock.calls).toEqual([['chat-1']]);
  });

  it('fails models, run and create alike when the runtime has no usable default model', async () => {
    const { gateway, ports } = setup();
    const unusable = new MiniAppAgentError('INVALID_ARGUMENTS', 'Model is not available');
    ports.resolveModel.mockRejectedValue(unusable);
    ports.defaultSessionModel.mockRejectedValue(unusable);
    gateway.registerArena(ARENA);

    await expect(gateway.models(PAGE)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(gateway.run(PAGE, { text: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    await expect(gateway.create(PAGE)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.runTurn).not.toHaveBeenCalled();
  });

  it('lists the agents the runtime offers, mavis being the primary one', async () => {
    const { gateway } = setup();
    gateway.registerArena(ARENA);

    await expect(gateway.agents(PAGE)).resolves.toEqual({ agents: AGENT_OPTIONS });
  });

  it('reads the host chat only with session.read', async () => {
    const { gateway, ports } = setup();
    const session = {
      sessionId: 'chat-1',
      agent: 'mavis',
      workspaceDir: '/work/project',
      isDefaultWorkspace: false,
      createdAtMs: 10,
      updatedAtMs: 20,
      status: 'idle' as const,
    };
    ports.readUserSession.mockResolvedValue(session);
    gateway.registerArena({
      ...ARENA,
      policy: { kind: 'allowlist', capabilities: ['session.read'], maxConcurrent: 1 },
    });

    await expect(gateway.session(PAGE)).resolves.toEqual(session);
    expect(ports.readUserSession).toHaveBeenCalledWith('chat-1');
  });

  it('lists user sessions only with session.read', async () => {
    const { gateway, ports } = setup();
    const sessions = { sessions: [{ sessionId: 'chat-2' }] } as never;
    ports.listUserSessions.mockResolvedValue(sessions);
    gateway.registerArena({
      ...ARENA,
      policy: { kind: 'allowlist', capabilities: ['session.read'], maxConcurrent: 1 },
    });

    await expect(gateway.sessions(PAGE)).resolves.toEqual(sessions);
    expect(ports.listUserSessions).toHaveBeenCalledTimes(1);
  });

  it('lets session.run read only its own Mini App session', async () => {
    const { gateway, ports } = setup();
    const session = { sessionId: 'mini-session', agent: 'mavis' } as never;
    ports.getOwner.mockResolvedValue('demo board');
    ports.readMiniAppSession.mockResolvedValue(session);
    gateway.registerArena(ARENA);

    await expect(gateway.session({ ...PAGE, source: 'process' }, { sessionId: 'mini-session' }))
      .resolves.toEqual(session);
    expect(ports.readMiniAppSession).toHaveBeenCalledWith('mini-session');
    expect(ports.readUserSession).not.toHaveBeenCalled();
  });

  it('does not treat session.run as permission to read the host chat', async () => {
    const { gateway, ports } = setup();
    gateway.registerArena(ARENA);

    await expect(gateway.session(PAGE)).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
    expect(ports.readUserSession).not.toHaveBeenCalled();
  });

  it.each(['models', 'agents', 'create'] as const)(
    '%s refuses a deny-all policy and a stale caller like run',
    async (method) => {
      const { gateway, ports } = setup();
      const call = (caller: MiniAppAgentCaller) => gateway[method](caller);

      await expect(call(PAGE)).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
      gateway.registerArena({ ...ARENA, policy: { kind: 'deny-all' } });
      await expect(call(PAGE)).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
      gateway.registerArena(ARENA);
      await expect(call({ ...PAGE, processGeneration: 'gen-0' })).rejects.toMatchObject({
        code: 'AGENT_UNAVAILABLE',
        retryable: true,
      });
      expect(ports.listModels).not.toHaveBeenCalled();
      expect(ports.listAgents).not.toHaveBeenCalled();
      expect(ports.createSession).not.toHaveBeenCalled();
    },
  );

  it('creates a session bound like a first run would, without a turn or a run slot', async () => {
    const { gateway, ports, logger } = setup();
    ports.resolveHostSession.mockResolvedValue({ ...hostChat, model: HOST_MODEL });
    ports.runTurn.mockImplementation(({ signal }) => untilAborted(signal));
    const release = gateway.registerArena({
      ...ARENA,
      policy: { kind: 'allowlist', capabilities: ['session.run'], maxConcurrent: 1 },
    });
    const running = gateway.run(CALLER, { text: 'hold the only slot' });
    await vi.waitFor(() => expect(ports.runTurn).toHaveBeenCalledTimes(1));

    await expect(gateway.create(PAGE)).resolves.toEqual({ sessionId: 'session-new' });

    expect(ports.createSession).toHaveBeenLastCalledWith({
      pluginId: 'demo board',
      agentName: 'custom-x',
      workspaceDir: pluginDir('custom-x'),
      createDir: true,
      model: HOST_MODEL,
    });
    expect(ports.runTurn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'demo board',
        sessionId: 'session-new',
        operation: 'create',
        phase: 'admission',
        agentName: 'custom-x',
        model: 'byok/orion',
      }),
      'Mini App Agent run',
    );
    release();
    await running;
  });

  it('creates a Node session in the plugin directory with the runtime default model', async () => {
    const { gateway, ports } = setup();
    gateway.registerArena(ARENA);

    await expect(gateway.create(CALLER)).resolves.toEqual({ sessionId: 'session-new' });

    expect(ports.createSession).toHaveBeenCalledWith({
      pluginId: 'demo board',
      agentName: 'mavis',
      workspaceDir: pluginDir('mavis'),
      createDir: true,
      model: DEFAULT_MODEL,
    });
  });
});

describe('createMiniAppAgentGateway chosen agent and failing lookups', () => {
  const PAGE: MiniAppAgentCaller = { ...CALLER, source: 'page', hostSessionId: 'chat-1' };
  const HOST_MODEL = { providerId: 'byok', modelId: 'orion', variant: 'thinking' };
  const hostChat = { agentName: 'custom-x', workspaceDir: '/home/u/ws', isDefaultWorkspace: true };
  const pluginDir = (agentName: string) =>
    join('/data', 'agents', agentName, 'miniapps', 'demo%20board');

  it.each([
    [
      'create',
      (gateway: ReturnType<typeof setup>['gateway']) => gateway.create(PAGE, { agent: 'writer' }),
    ],
    [
      'run',
      (gateway: ReturnType<typeof setup>['gateway']) =>
        gateway.run(PAGE, { text: 'hi', agent: 'writer' }),
    ],
  ])('%s with a chosen agent binds it, keeping the host model', async (_label, start) => {
    const { gateway, ports } = setup();
    ports.resolveHostSession.mockResolvedValue({ ...hostChat, model: HOST_MODEL });
    gateway.registerArena(ARENA);

    await start(gateway);

    expect(ports.createSession).toHaveBeenCalledWith({
      pluginId: 'demo board',
      agentName: 'writer',
      workspaceDir: pluginDir('writer'),
      createDir: true,
      model: HOST_MODEL,
    });
  });

  it('keeps the host project directory when a different agent is chosen', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'miniapp-host-project-'));
    try {
      const { gateway, ports } = setup();
      ports.resolveHostSession.mockResolvedValue({
        agentName: 'custom-x',
        workspaceDir: projectDir,
        isDefaultWorkspace: false,
        model: HOST_MODEL,
      });
      gateway.registerArena(ARENA);

      await gateway.create(PAGE, { agent: 'writer' });

      expect(ports.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'writer',
          workspaceDir: projectDir,
          createDir: false,
        }),
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it.each([['nope'], ['main'], [''], [42]])(
    'rejects the agent %j as INVALID_ARGUMENTS without creating a session',
    async (agent) => {
      const { gateway, ports } = setup();
      gateway.registerArena(ARENA);

      await expect(gateway.create(PAGE, { agent: agent as string })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENTS',
      });
      await expect(gateway.run(PAGE, { text: 'hi', agent: agent as string })).rejects.toMatchObject(
        { code: 'INVALID_ARGUMENTS' },
      );
      expect(ports.createSession).not.toHaveBeenCalled();
      expect(ports.runTurn).not.toHaveBeenCalled();
    },
  );

  it('rejects choosing an agent for an existing session before anything runs', async () => {
    const { gateway, ports } = setup();
    ports.getOwner.mockResolvedValue('demo board');
    gateway.registerArena(ARENA);

    await expect(
      gateway.run(PAGE, { text: 'hi', sessionId: 'mine', agent: 'writer' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.listAgents).not.toHaveBeenCalled();
    expect(ports.runTurn).not.toHaveBeenCalled();
  });

  it('lets an unusable default model reach the caller as INVALID_ARGUMENTS', async () => {
    const { gateway, ports } = setup();
    const unusable = new MiniAppAgentError(
      'INVALID_ARGUMENTS',
      'Model is not available: no default',
    );
    ports.resolveModel.mockRejectedValue(unusable);
    ports.defaultSessionModel.mockRejectedValue(unusable);
    gateway.registerArena(ARENA);

    await expect(gateway.run(CALLER, { text: 'hi' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    await expect(gateway.create(CALLER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(ports.createSession).not.toHaveBeenCalled();
  });

  it.each(['models', 'agents', 'create'] as const)(
    '%s reports a failing lookup as retryable unavailable',
    async (method) => {
      const { gateway, ports } = setup();
      ports.listModels.mockRejectedValue(new Error('db locked'));
      ports.listAgents.mockRejectedValue(new Error('db locked'));
      ports.createSession.mockRejectedValue(new Error('db locked'));
      gateway.registerArena(ARENA);

      await expect(gateway[method](CALLER)).rejects.toMatchObject({
        code: 'AGENT_UNAVAILABLE',
        retryable: true,
      });
    },
  );
});

function setup(options: { readonly bind?: boolean } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const gateway = createMiniAppAgentGateway({ dataDir: '/data', logger, nowMs: () => 0 });
  const askListeners: Array<(ask: MiniAppPermissionAsk) => void> = [];
  const ports = {
    createSession: vi.fn<MiniAppAgentSessionPorts['createSession']>(async () => ({
      sessionId: 'session-new',
    })),
    getOwner: vi.fn<MiniAppAgentSessionPorts['getOwner']>(async () => undefined),
    resolveMiniAppRoot: vi.fn<MiniAppAgentSessionPorts['resolveMiniAppRoot']>(),
    defaultSessionModel: vi.fn<MiniAppAgentSessionPorts['defaultSessionModel']>(async () => ({
      selection: DEFAULT_MODEL,
    })),
    resolveModel: vi.fn<MiniAppAgentSessionPorts['resolveModel']>(
      async (requested) => requested ?? DEFAULT_MODEL,
    ),
    listModels: vi.fn<MiniAppAgentSessionPorts['listModels']>(async () => MODEL_OPTIONS),
    listAgents: vi.fn<MiniAppAgentSessionPorts['listAgents']>(async () => AGENT_OPTIONS),
    listUserSessions: vi.fn<MiniAppAgentSessionPorts['listUserSessions']>(async () => ({ sessions: [] })),
    readUserSession: vi.fn<MiniAppAgentSessionPorts['readUserSession']>(async () => undefined),
    readMiniAppSession: vi.fn<MiniAppAgentSessionPorts['readMiniAppSession']>(async () => undefined),
    readSessionModel: vi.fn<MiniAppAgentSessionPorts['readSessionModel']>(async () => undefined),
    setSessionModel: vi.fn<MiniAppAgentSessionPorts['setSessionModel']>(async () => undefined),
    resolveHostSession: vi.fn<MiniAppAgentSessionPorts['resolveHostSession']>(
      async () => undefined,
    ),
    runTurn: vi.fn<MiniAppAgentSessionPorts['runTurn']>(async () => ({
      turnId: 'turn-1',
      status: 'finished',
      text: 'reply',
    })),
    answerQuestion: vi.fn<MiniAppAgentSessionPorts['answerQuestion']>(async () => ({
      turnId: 'turn-2',
      status: 'finished',
      text: 'continued',
    })),
    replyPermission: vi.fn<MiniAppAgentSessionPorts['replyPermission']>(async () => 'processed'),
    subscribePermissionAsks: vi.fn<MiniAppAgentSessionPorts['subscribePermissionAsks']>(
      (listener) => {
        askListeners.push(listener);
        return () => askListeners.splice(askListeners.indexOf(listener), 1);
      },
    ),
  };
  // A Mini App session is its own root unless a test models delegated children.
  ports.resolveMiniAppRoot.mockImplementation(async (sessionId) => {
    const pluginId = await ports.getOwner(sessionId);
    return pluginId ? { rootSessionId: sessionId, pluginId } : undefined;
  });
  if (options.bind !== false) gateway.bind(ports);
  const ask = (value: MiniAppPermissionAsk): void => {
    for (const listener of askListeners) listener(value);
  };
  return { gateway, ports, logger, ask };
}

function untilAborted(
  signal: AbortSignal | undefined,
): ReturnType<MiniAppAgentSessionPorts['runTurn']> {
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve({ turnId: 'turn-1', status: 'aborted' }), {
      once: true,
    });
  });
}

/** Holds each turn until `finish(n)` (n-th turn started, from 0) or its abort. */
function holdTurns(ports: ReturnType<typeof setup>['ports']) {
  const finishers: Array<() => void> = [];
  ports.runTurn.mockImplementation(({ signal }) => {
    const turn = untilAborted(signal);
    return Promise.race([
      turn,
      new Promise<Awaited<typeof turn>>((resolve) => {
        finishers.push(() => resolve({ turnId: 'turn-1', status: 'finished' }));
      }),
    ]);
  });
  return {
    finish: (index: number) => finishers[index]?.(),
    texts: () => ports.runTurn.mock.calls.map(([input]) => input.text),
  };
}
