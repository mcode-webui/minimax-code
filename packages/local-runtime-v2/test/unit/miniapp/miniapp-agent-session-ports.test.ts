import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RespDataType,
  Role,
  RuntimeEventStatus,
  RuntimeEventType,
} from '@mavis/agent-core/protocol';
import type { GlobalEvent } from '@mavis/shared/global-events';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelProviderModelEntry } from '../../../src/service/model-system/index.js';
import type { SessionFrame } from '../../../src/service/session-system/index.js';
import type { MiniAppAgentRunEvent } from '../../../src/service/miniapp/agent/contracts.js';
import {
  createMiniAppAgentSessionPorts,
  type MiniAppAgentSessionPortsOptions,
} from '../../../src/service/miniapp/agent/session-ports.js';

const cleanup: string[] = [];

/** What `fakes()` resolves as the runtime default model (M3 has no thinking: variant `''`). */
const DEFAULT_MODEL = { providerId: 'minimax', modelId: 'M3', variant: '' };
const BYOK_CONFIG = {
  dataDir: '/tmp/miniapp-agent-ports-byok-config',
  defaultModel: 'byok-acme/orion',
  defaultModelVariant: 'thinking',
  defaultModelThinking: { effort: 'low' },
  defaultModelContextWindow: 128_000,
  provider: {
    'byok-acme': {
      models: {
        orion: {
          limit: { context: 128_000, output: 16_000 },
          contextWindowOptions: [128_000],
          thinking: { effortOptions: ['low', 'high'], defaultEffort: 'high' },
        },
      },
    },
  },
};
const RUNTIME_CONFIG = {
  dataDir: '/tmp/miniapp-agent-ports-config',
  defaultModel: 'minimax/M3',
  provider: {
    minimax: {
      models: { M3: { limit: { context: 512_000, output: 16_000 } } },
    },
  },
};

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('createMiniAppAgentSessionPorts records', () => {
  it('creates a hidden session of the given agent tagged with the plugin and makes its workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miniapp-agent-ports-'));
    cleanup.push(root);
    const workspaceDir = join(root, 'agent-workspace');
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.createSession({
        pluginId: 'demo.board',
        agentName: 'custom-x',
        workspaceDir,
        createDir: true,
        model: { providerId: 'minimax', modelId: 'M3', thinking: { effort: 'high' } },
      }),
    ).resolves.toEqual({ sessionId: 'session-1' });

    expect((await stat(workspaceDir)).isDirectory()).toBe(true);
    expect(fake.options.records.createInternalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'custom-x',
        sessionType: 'branch',
        sessionKind: 'conversation',
        visibility: 'hidden',
        purpose: 'miniapp:demo.board',
        workspaceDir,
        isDefaultWorkspace: false,

        title: 'demo.board',
        effectiveModel: 'minimax/M3',
        effectiveModelThinking: { effort: 'high' },
      }),
    );
  });

  it('works in the host chat project directory without creating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miniapp-agent-ports-'));
    cleanup.push(root);
    const projectDir = join(root, 'deleted-project');
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await ports.createSession({
      pluginId: 'demo.board',
      agentName: 'mavis',
      workspaceDir: projectDir,
      createDir: false,
      model: DEFAULT_MODEL,
    });

    await expect(stat(projectDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.options.records.createInternalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: projectDir,
        isDefaultWorkspace: false,

      }),
    );
  });

  it('reads the owner from the session record', async () => {
    const fake = fakes();
    fake.sessions.set('owned', { purpose: 'miniapp:demo' });
    fake.sessions.set('plain', {});
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.getOwner('owned')).resolves.toBe('demo');
    await expect(ports.getOwner('plain')).resolves.toBeUndefined();
    await expect(ports.getOwner('missing')).resolves.toBeUndefined();
  });

  it('reads what a new Mini App session takes from its host chat session record', async () => {
    const fake = fakes();
    fake.sessions.set('chat', {
      agentName: 'custom-x',
      workspaceDir: '/work/project',
      isDefaultWorkspace: false,
      parentSessionId: 'other',
      effectiveModel: 'minimax/M3',
      effectiveModelVariant: 'fast',
    });
    fake.sessions.set('modelless-chat', {
      agentName: 'custom-x',
      workspaceDir: '/work/project',
      isDefaultWorkspace: false,
      effectiveModel: '',
    });
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.resolveHostSession('chat')).resolves.toEqual({
      agentName: 'custom-x',
      workspaceDir: '/work/project',
      isDefaultWorkspace: false,
      model: { providerId: 'minimax', modelId: 'M3', variant: 'fast' },
    });
    await expect(ports.resolveHostSession('modelless-chat')).resolves.toMatchObject({
      model: undefined,
    });
    await expect(ports.resolveHostSession('missing')).resolves.toBeUndefined();
    fake.options.repository.get.mockRejectedValueOnce(new Error('db locked'));
    await expect(ports.resolveHostSession('chat')).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
      retryable: true,
    });
  });

  it('resolves the runtime default model, or validates a requested one like the composer', async () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.resolveModel()).resolves.toEqual(DEFAULT_MODEL);
    await expect(ports.resolveModel({ providerId: 'minimax', modelId: 'M3' })).resolves.toEqual(
      DEFAULT_MODEL,
    );
    await expect(ports.resolveModel({ providerId: 'nope', modelId: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
  });

  it('refuses a model this build does not offer instead of dispatching the turn', async () => {
    // The shipped generation replaced a retired official model with the default. This build scopes
    // that replacement to the legacy managed provider alias (`isLegacyManagedMinimaxProvider`,
    // packages/config/src/provider-auth-mode.ts:29): for an ordinary provider the request fails
    // closed here rather than starting a turn against a model the route does not serve.
    const fake = fakes();
    fake.options.modelConfig.mockReturnValue({
      ...RUNTIME_CONFIG,
      provider: {
        minimax: {
          options: { authMode: 'managed-login' },
          models: RUNTIME_CONFIG.provider.minimax.models,
          model_order: ['M3'],
        },
      },
    });
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.resolveModel({ providerId: 'minimax', modelId: 'MiniMax-M2.7' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });

  it('refuses a default model that is not configured', async () => {
    const fake = fakes();
    fake.options.modelConfig.mockReturnValue({ dataDir: '/tmp/x', provider: {} });
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.resolveModel()).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });

  it('reads the session record model, and nothing for a record without one or none at all', async () => {
    const fake = fakes();
    fake.sessions.set('with', {
      effectiveModel: 'minimax/M3',
      effectiveModelThinking: { effort: 'low' },
    });
    fake.sessions.set('without', { effectiveModel: null });
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.readSessionModel('with')).resolves.toEqual({
      providerId: 'minimax',
      modelId: 'M3',
      thinking: { effort: 'low' },
    });
    await expect(ports.readSessionModel('without')).resolves.toBeUndefined();
    await expect(ports.readSessionModel('missing')).resolves.toBeUndefined();
    fake.options.repository.get.mockRejectedValueOnce(new Error('db locked'));
    await expect(ports.readSessionModel('with')).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
      retryable: true,
    });
  });

  it('resolves the Mini App root through delegated child sessions', async () => {
    const fake = fakes();
    fake.sessions.set('root', { purpose: 'miniapp:demo' });
    fake.sessions.set('child', { parentSessionId: 'root' });
    fake.sessions.set('grandchild', { parentSessionId: 'child' });
    fake.sessions.set('chat', {});
    fake.sessions.set('page-root', {
      purpose: 'miniapp:demo',
    });
    fake.sessions.set('page-child', { parentSessionId: 'page-root' });
    fake.sessions.set('loop-a', { parentSessionId: 'loop-b' });
    fake.sessions.set('loop-b', { parentSessionId: 'loop-a' });
    for (let depth = 0; depth < 20; depth += 1) {
      fake.sessions.set(`deep-${depth}`, { parentSessionId: depth ? `deep-${depth - 1}` : 'root' });
    }
    const ports = createMiniAppAgentSessionPorts(fake.options);

    const root = { rootSessionId: 'root', pluginId: 'demo' };
    await expect(ports.resolveMiniAppRoot('root')).resolves.toEqual(root);
    await expect(ports.resolveMiniAppRoot('grandchild')).resolves.toEqual(root);
    await expect(ports.resolveMiniAppRoot('chat')).resolves.toBeUndefined();
    // Where the root was created is not part of the answer.
    await expect(ports.resolveMiniAppRoot('page-child')).resolves.toEqual({
      rootSessionId: 'page-root',
      pluginId: 'demo',
    });
    await expect(ports.resolveMiniAppRoot('missing')).resolves.toBeUndefined();
    expect(fake.options.logger.warn).not.toHaveBeenCalled();

    await expect(ports.resolveMiniAppRoot('loop-a')).resolves.toBeUndefined();
    await expect(ports.resolveMiniAppRoot('deep-19')).resolves.toBeUndefined();
    expect(fake.options.logger.warn.mock.calls).toEqual([
      [
        { sessionId: 'loop-a', hops: 2, cycle: true },
        'Mini App root lookup stopped at the hop limit or a cycle',
      ],
      [
        { sessionId: 'deep-19', hops: 17, cycle: false },
        'Mini App root lookup stopped at the hop limit or a cycle',
      ],
    ]);
  });
});

describe('createMiniAppAgentSessionPorts model snapshot', () => {
  it('applies the global variant, thinking and context window to the runtime default', async () => {
    const fake = fakes();
    fake.options.modelConfig.mockReturnValue(BYOK_CONFIG);
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const selection = {
      providerId: 'byok-acme',
      modelId: 'orion',
      variant: 'thinking',
      thinking: { effort: 'low' },
    };

    await expect(ports.defaultSessionModel()).resolves.toEqual({
      selection,
      contextWindow: 128_000,
    });
    await expect(ports.resolveModel()).resolves.toEqual(selection);
  });

  it('keeps variant "" (thinking off) when resolving, creating and switching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miniapp-agent-ports-'));
    cleanup.push(root);
    const fake = fakes();
    fake.options.modelConfig.mockReturnValue(BYOK_CONFIG);
    fake.sessions.set('chat', {
      agentName: 'mavis',
      workspaceDir: '/work/project',
      isDefaultWorkspace: false,
      effectiveModel: 'byok-acme/orion',
      effectiveModelVariant: '',
    });
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const off = { providerId: 'byok-acme', modelId: 'orion', variant: '' };

    await expect(ports.resolveHostSession('chat')).resolves.toMatchObject({ model: off });
    await expect(ports.resolveModel(off)).resolves.toMatchObject(off);
    await ports.createSession({
      pluginId: 'demo.board',
      agentName: 'mavis',
      workspaceDir: join(root, 'ws'),
      createDir: true,
      model: off,
    });
    await ports.setSessionModel('mine', off);

    expect(fake.options.records.createInternalSession).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveModel: 'byok-acme/orion', effectiveModelVariant: '' }),
    );
    expect(fake.options.lifecycle.mutateSession).toHaveBeenCalledWith(
      'mine',
      expect.objectContaining({ effectiveModelVariant: '', effectiveModelContextWindow: null }),
    );
  });

  it('writes the default context window only when the gateway hands it over', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miniapp-agent-ports-'));
    cleanup.push(root);
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const base = {
      pluginId: 'demo.board',
      agentName: 'mavis',
      workspaceDir: join(root, 'ws'),
      createDir: true,
      model: DEFAULT_MODEL,
    };

    await ports.createSession({ ...base, contextWindow: 128_000 });
    await ports.createSession(base);

    const written = fake.options.records.createInternalSession;
    expect(written).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ effectiveModelContextWindow: 128_000 }),
    );
    expect(written).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ effectiveModelContextWindow: expect.anything() }),
    );
  });
});

describe('createMiniAppAgentSessionPorts runTurn', () => {
  it('projects frames in order and returns the final assistant text on completion', async () => {
    const fake = fakes();
    fake.messages.push(
      { role: 'user', msg_content: 'question' },
      { role: 'assistant', msg_content: 'thinking aloud' },
      { role: 'assistant', msg_content: 'final answer' },
    );
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('runtime-event', textChunk('fin')));
    fake.push(frame('message-committed', { messages: [] }));
    fake.push(frame('turn-terminal', { status: 'completed' }));

    await expect(run).resolves.toEqual({
      turnId: 'turn-1',
      model: DEFAULT_MODEL,
      status: 'finished',
      text: 'final answer',
    });
    // turn.finished carries the settled text read after the terminal frame.
    expect(events).toEqual([
      { type: 'text.delta', sessionId: 'session-1', turnId: 'turn-1', text: 'fin' },
      {
        type: 'turn.finished',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'finished',
        text: 'final answer',
      },
    ]);
    expect(fake.options.turns.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        input: { text: 'hello' },
        producerId: 'miniapp:session-1',
        provenance: expect.objectContaining({ source: 'miniapp' }),
      }),
    );
    expect(fake.options.messages.listTurn).toHaveBeenCalledWith('session-1', 'turn-1');
  });

  it('maps a failed terminal to an error result', async () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'failed', error: 'boom', errorSource: 'model' }));

    const error = { code: 'model', message: 'The Agent turn failed.' };
    await expect(run).resolves.toEqual({
      turnId: 'turn-1',
      model: DEFAULT_MODEL,
      status: 'error',
      error,
    });
    expect(events).toEqual([
      { type: 'turn.finished', sessionId: 'session-1', turnId: 'turn-1', status: 'error', error },
    ]);
  });

  it('never forwards free-text runtime error sources as the error code', async () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    const run = ports.runTurn({ sessionId: 'session-1', text: 'hello' });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'failed', errorSource: 'db at /private/x failed' }));

    await expect(run).resolves.toMatchObject({
      error: { code: 'TURN_FAILED', message: 'The Agent turn failed.' },
    });
  });

  it('aborts the running turn and resolves aborted when the signal fires', async () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const controller = new AbortController();

    const events: MiniAppAgentRunEvent[] = [];
    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    controller.abort();
    await vi.waitFor(() =>
      expect(fake.options.turns.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-1' }),
      ),
    );
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    fake.push(frame('turn-terminal', { status: 'failed' }, 'turn-0'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Still waiting for its own terminal so a follow-up run finds the session idle.
    expect(settled).toBe(false);
    fake.push(frame('turn-terminal', { status: 'aborted' }));

    await expect(run).resolves.toEqual({
      turnId: 'turn-1',
      model: DEFAULT_MODEL,
      status: 'aborted',
    });
    expect(events).toEqual([
      { type: 'turn.finished', sessionId: 'session-1', turnId: 'turn-1', status: 'aborted' },
    ]);
    expect(fake.closed()).toBe(true);
  });

  it('stops waiting for the aborted terminal after the settle timeout once the abort was acknowledged', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakes();
      const ports = createMiniAppAgentSessionPorts(fake.options);
      const controller = new AbortController();

      const run = ports.runTurn({
        sessionId: 'session-1',
        text: 'hello',
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
      controller.abort();
      await vi.waitFor(() => expect(fake.options.turns.abort).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(run).resolves.toEqual({
        turnId: 'turn-1',
        model: DEFAULT_MODEL,
        status: 'aborted',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps running when the event listener throws', async () => {
    const fake = fakes();
    fake.messages.push({ role: 'assistant', msg_content: 'done' });
    const ports = createMiniAppAgentSessionPorts(fake.options);

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: () => {
        throw new Error('listener failed');
      },
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('runtime-event', textChunk('d')));
    fake.push(frame('turn-terminal', { status: 'completed' }));

    await expect(run).resolves.toMatchObject({ status: 'finished', text: 'done' });
  });

  it('rejects as unavailable when the steer is not delivered', async () => {
    const fake = fakes();
    fake.options.turns.steer.mockResolvedValueOnce({
      delivered: false,
      reason: 'delivery-closed',
    });
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.runTurn({ sessionId: 'session-1', text: 'hello' })).rejects.toMatchObject({
      code: 'AGENT_UNAVAILABLE',
    });
    expect(fake.closed()).toBe(true);
  });
});

describe('createMiniAppAgentSessionPorts run model', () => {
  it('reports the session record model on turn.started and the result, not a default', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', {
      effectiveModel: 'byok/orion',
      effectiveModelVariant: 'thinking',
      effectiveModelThinking: { effort: 'high' },
    });
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];
    const model = {
      providerId: 'byok',
      modelId: 'orion',
      variant: 'thinking',
      thinking: { effort: 'high' },
    };

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(
      frame('runtime-event', {
        type: RuntimeEventType.SESSION_STATUS,
        payload: { status: RuntimeEventStatus.RUNNING },
      }),
    );
    fake.push(frame('turn-terminal', { status: 'completed' }));

    await expect(run).resolves.toMatchObject({ turnId: 'turn-1', status: 'finished', model });
    expect(events[0]).toEqual({
      type: 'turn.started',
      sessionId: 'session-1',
      turnId: 'turn-1',
      model,
    });
    expect(fake.options.modelConfig).not.toHaveBeenCalled();
  });

  it('reports the runtime default model for a record that predates the model snapshot', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { effectiveModel: null });
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(
      frame('runtime-event', {
        type: RuntimeEventType.SESSION_STATUS,
        payload: { status: RuntimeEventStatus.RUNNING },
      }),
    );
    fake.push(frame('turn-terminal', { status: 'completed' }));

    await expect(run).resolves.toMatchObject({ status: 'finished', model: DEFAULT_MODEL });
    expect(events[0]).toMatchObject({ type: 'turn.started', model: DEFAULT_MODEL });
  });
});

describe('createMiniAppAgentSessionPorts setSessionModel', () => {
  it('stores the selection on the session, clearing the parameters and limits it does not carry', async () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await ports.setSessionModel('mine', {
      providerId: 'minimax',
      modelId: 'M3',
      variant: 'fast',
      thinking: { effort: 'high' },
    });
    await ports.setSessionModel('mine', { providerId: 'minimax', modelId: 'M3' });

    expect(fake.options.lifecycle.mutateSession.mock.calls).toEqual([
      [
        'mine',
        {
          effectiveModel: 'minimax/M3',
          effectiveModelVariant: 'fast',
          effectiveModelThinking: { effort: 'high' },
          effectiveModelContextWindow: null,
          effectiveModelMaxOutputTokens: null,
        },
      ],
      [
        'mine',
        {
          effectiveModel: 'minimax/M3',
          effectiveModelVariant: null,
          effectiveModelThinking: null,
          effectiveModelContextWindow: null,
          effectiveModelMaxOutputTokens: null,
        },
      ],
    ]);
  });

  it('fails as retryable unavailable, logging the stage, when the record cannot be written', async () => {
    const fake = fakes();
    fake.options.lifecycle.mutateSession.mockRejectedValueOnce(new Error('db locked'));
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.setSessionModel('mine', { providerId: 'minimax', modelId: 'M3' }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(fake.options.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'set-session-model', sessionId: 'mine' }),
      'Mini App Agent lookup failed before dispatch',
    );
  });
});

describe('createMiniAppAgentSessionPorts turn correlation', () => {
  it('ignores frames and terminals of other turns and settles on its own terminal', async () => {
    const fake = fakes();
    fake.messages.push({ role: 'assistant', msg_content: 'mine' });
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('runtime-event', textChunk('x', 'turn-0'), 'turn-0'));
    fake.push(frame('turn-terminal', { status: 'failed' }, 'turn-0'));
    fake.push(frame('session-status', {}, null));
    fake.push(frame('runtime-event', textChunk('y')));
    fake.push(frame('turn-terminal', { status: 'completed' }));

    await expect(run).resolves.toEqual({
      turnId: 'turn-1',
      model: DEFAULT_MODEL,
      status: 'finished',
      text: 'mine',
    });
    expect(events).toEqual([
      { type: 'text.delta', sessionId: 'session-1', turnId: 'turn-1', text: 'y' },
      {
        type: 'turn.finished',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'finished',
        text: 'mine',
      },
    ]);
    // The stale terminal closed the first iterator; the run resumed from its cursor.
    expect(fake.options.stream.resume).toHaveBeenCalledTimes(2);
    expect(fake.options.stream.resume).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      afterCursor: 'cursor:turn-terminal:turn-0',
      waitForTerminal: true,
    });
  });

  it('rejects as BUSY without forwarding frames when the text was merged into a running turn', async () => {
    const fake = fakes();
    fake.options.turns.steer.mockResolvedValueOnce({
      delivered: true,
      mode: 'steered',
      turnId: 'turn-0',
    });
    fake.push(frame('runtime-event', textChunk('busy', 'turn-0'), 'turn-0'));
    const onEvent = vi.fn();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.runTurn({ sessionId: 'session-1', text: 'hello', onEvent }),
    ).rejects.toMatchObject({ code: 'BUSY', retryable: true, reason: 'session_busy' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(fake.options.turns.abort).not.toHaveBeenCalled();
    expect(fake.closed()).toBe(true);
  });

  it('aborts its turn and rejects when the stream ends before the terminal', async () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    const run = ports.runTurn({ sessionId: 'session-1', text: 'hello' });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.end();

    await expect(run).rejects.toThrow('Session stream ended');
    expect(fake.options.turns.abort).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      reason: 'miniapp-stream-lost',
    });
  });
});

const QUESTION = {
  schemaVersion: 2,
  id: 'question-1',
  presentation: 'inline',
  steps: [],
} as unknown as AskQuestionnaireRequest;

describe('createMiniAppAgentSessionPorts questions', () => {
  it('reports the questionnaire a finished turn paused on before turn.finished', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'custom-x' });
    fake.options.questionnaires.getPending.mockResolvedValue(QUESTION);
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'completed' }));

    const pendingQuestion = { requestId: 'question-1', mode: 'questionnaire', request: QUESTION };
    await expect(run).resolves.toEqual({
      turnId: 'turn-1',
      model: DEFAULT_MODEL,
      status: 'finished',
      pendingQuestion,
    });
    expect(events).toEqual([
      { type: 'question.requested', sessionId: 'session-1', turnId: 'turn-1', ...pendingQuestion },
      { type: 'turn.finished', sessionId: 'session-1', turnId: 'turn-1', status: 'finished' },
    ]);
    expect(fake.options.questionnaires.getPending).toHaveBeenCalledWith({
      agentName: 'custom-x',
      sessionId: 'session-1',
    });
  });

  it('rejects as unknown after delivering the terminal when the question lookup fails', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockRejectedValue(new Error('db locked'));
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'completed' }));

    // The turn ended, but "nothing to answer" is not confirmed.
    await expect(run).rejects.toMatchObject({ code: 'AGENT_OUTCOME_UNKNOWN', retryable: false });
    expect(events).toEqual([
      { type: 'turn.finished', sessionId: 'session-1', turnId: 'turn-1', status: 'finished' },
    ]);
    expect(fake.options.logger.warn).toHaveBeenCalledWith(
      {
        stage: 'pending-question-lookup',
        sessionId: 'session-1',
        turnId: 'turn-1',
        errorName: 'Error',
        error: 'db locked',
      },
      'Mini App Agent pending questionnaire lookup failed',
    );
    expect(fake.options.turns.abort).not.toHaveBeenCalled();
  });

  it('does not report a questionnaire left pending by an earlier turn', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValue({ ...QUESTION, createdAt: 41 });
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];

    const run = ports.runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'completed' }));

    await expect(run).resolves.toEqual({
      turnId: 'turn-1',
      model: DEFAULT_MODEL,
      status: 'finished',
    });
    expect(events.map((event) => event.type)).toEqual(['turn.finished']);
  });
});

describe('createMiniAppAgentSessionPorts answers', () => {
  it('answers the pending question and follows the continuation turn it starts', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValueOnce(QUESTION);
    fake.options.questionnaires.reply.mockImplementation(async () => {
      fake.push(frame('session-status', {}, null));
      fake.push(frame('runtime-event', textChunk('ok', 'turn-2'), 'turn-2'));
      return { ok: true, injected: true };
    });
    fake.messages.push({ role: 'assistant', msg_content: 'continued' });
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const events: MiniAppAgentRunEvent[] = [];
    const answers = [{ stepId: 's1', selectedOptionIds: ['a'], selectedOther: false }];

    const run = ports.answerQuestion({
      sessionId: 'session-1',
      requestId: 'question-1',
      answers,
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.questionnaires.reply).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'completed' }, 'turn-2'));

    await expect(run).resolves.toEqual({
      turnId: 'turn-2',
      model: DEFAULT_MODEL,
      status: 'finished',
      text: 'continued',
    });
    expect(fake.options.questionnaires.reply).toHaveBeenCalledWith({
      agentName: 'mavis',
      requestId: 'question-1',
      answers,
      submittedAt: 42,
    });
    // The stream was subscribed before replying, so no continuation frame is missed.
    expect(fake.options.stream.resume.mock.invocationCallOrder[0]).toBeLessThan(
      fake.options.questionnaires.reply.mock.invocationCallOrder[0] ?? 0,
    );
    expect(events).toEqual([
      { type: 'text.delta', sessionId: 'session-1', turnId: 'turn-2', text: 'ok' },
      {
        type: 'turn.finished',
        sessionId: 'session-1',
        turnId: 'turn-2',
        status: 'finished',
        text: 'continued',
      },
    ]);
    expect(fake.options.messages.listTurn).toHaveBeenCalledWith('session-1', 'turn-2');
  });

  it.each([
    ['no pending question', undefined],
    ['another pending question', { ...QUESTION, id: 'question-2' }],
  ])('rejects an answer with REQUEST_NOT_FOUND when there is %s', async (_label, pending) => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValue(pending);
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.answerQuestion({ sessionId: 'session-1', requestId: 'question-1', answers: [] }),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    expect(fake.options.questionnaires.reply).not.toHaveBeenCalled();
  });

  it('aborts the continuation turn when cancelled before it was seen', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValue(QUESTION);
    const controller = new AbortController();
    const events: MiniAppAgentRunEvent[] = [];
    const ports = createMiniAppAgentSessionPorts(fake.options);

    const run = ports.answerQuestion({
      sessionId: 'session-1',
      requestId: 'question-1',
      answers: [],
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(fake.options.questionnaires.reply).toHaveBeenCalled());
    controller.abort();
    fake.push(frame('runtime-event', textChunk('late', 'turn-2'), 'turn-2'));
    await vi.waitFor(() =>
      expect(fake.options.turns.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-2' }),
      ),
    );
    fake.push(frame('turn-terminal', { status: 'aborted' }, 'turn-2'));

    await expect(run).resolves.toEqual({
      turnId: 'turn-2',
      model: DEFAULT_MODEL,
      status: 'aborted',
    });
    expect(events).toEqual([
      { type: 'turn.finished', sessionId: 'session-1', turnId: 'turn-2', status: 'aborted' },
    ]);
  });

  it('settles finished without a turn when the answer starts no continuation', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValue(QUESTION);
    fake.options.questionnaires.reply.mockResolvedValue({ ok: true, injected: false });
    const onEvent = vi.fn();
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.answerQuestion({
        sessionId: 'session-1',
        requestId: 'question-1',
        answers: [],
        onEvent,
      }),
    ).resolves.toEqual({ status: 'finished' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(fake.options.messages.listTurn).not.toHaveBeenCalled();
    expect(fake.options.turns.abort).not.toHaveBeenCalled();
    expect(fake.closed()).toBe(true);
  });

  it('rejects as retryable unavailable when the pending lookup fails before answering', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockRejectedValue(new Error('db locked'));
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.answerQuestion({ sessionId: 'session-1', requestId: 'question-1', answers: [] }),
    ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE', retryable: true });
    expect(fake.options.questionnaires.reply).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'INVALID_ARGUMENTS'],
    [410, 'REQUEST_NOT_FOUND'],
  ])('maps a %d questionnaire reply rejection to %s', async (status, code) => {
    const fake = fakes();
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValue(QUESTION);
    fake.options.questionnaires.reply.mockRejectedValue(Object.assign(new Error('x'), { status }));
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(
      ports.answerQuestion({ sessionId: 'session-1', requestId: 'question-1', answers: [] }),
    ).rejects.toMatchObject({ code });
    expect(fake.options.turns.abort).not.toHaveBeenCalled();
  });
});

describe('createMiniAppAgentSessionPorts unconfirmed outcomes', () => {
  /** Runs `body` under fake timers; the run's assertion is attached before time moves. */
  async function withFakeTimers(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  function answering(fake: ReturnType<typeof fakes>, signal?: AbortSignal) {
    fake.sessions.set('session-1', { agentName: 'mavis' });
    fake.options.questionnaires.getPending.mockResolvedValue(QUESTION);
    const onEvent = vi.fn();
    const run = createMiniAppAgentSessionPorts(fake.options).answerQuestion({
      sessionId: 'session-1',
      requestId: 'question-1',
      answers: [],
      ...(signal ? { signal } : {}),
      onEvent,
    });
    return { run, onEvent };
  }

  it('rejects as unknown when the answer was recorded but no continuation turn was seen', () =>
    withFakeTimers(async () => {
      const fake = fakes();
      const { run, onEvent } = answering(fake);
      const settled = expect(run).rejects.toMatchObject({
        code: 'AGENT_OUTCOME_UNKNOWN',
        retryable: false,
        message: expect.stringContaining('follow-up turn was not observed'),
      });
      await vi.waitFor(() => expect(fake.options.questionnaires.reply).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(15_000);

      await settled;
      expect(onEvent).not.toHaveBeenCalled();
      expect(fake.options.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'answer-continuation', requestId: 'question-1' }),
        'Mini App Agent answer continuation turn was not observed',
      );
    }));

  it('rejects as unknown when an answer is cancelled and its continuation never appears', () =>
    withFakeTimers(async () => {
      const fake = fakes();
      const controller = new AbortController();
      const { run, onEvent } = answering(fake, controller.signal);
      const settled = expect(run).rejects.toMatchObject({ code: 'AGENT_OUTCOME_UNKNOWN' });
      await vi.waitFor(() => expect(fake.options.questionnaires.reply).toHaveBeenCalled());
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);

      await settled;
      expect(onEvent).not.toHaveBeenCalled();
      expect(fake.options.turns.abort).not.toHaveBeenCalled();
    }));

  it.each([
    ['the abort timed out and no terminal arrived', 'abort-timeout', undefined, undefined],
    ['the turn had stopped running and ended aborted', 'not-running', 'aborted', 'aborted'],
    ['the turn had stopped running and ended completed', 'not-running', 'completed', undefined],
  ] as const)('a cancelled run where %s', (_label, abortStatus, terminalStatus, expected) =>
    withFakeTimers(async () => {
      const fake = fakes();
      fake.options.turns.abort.mockResolvedValue(
        abortStatus === 'not-running'
          ? { status: abortStatus }
          : { status: abortStatus, turnId: 'turn-1' },
      );
      const controller = new AbortController();
      const events: MiniAppAgentRunEvent[] = [];
      const run = createMiniAppAgentSessionPorts(fake.options).runTurn({
        sessionId: 'session-1',
        text: 'hello',
        signal: controller.signal,
        onEvent: (event) => events.push(event),
      });
      const settled = expected
        ? expect(run).resolves.toEqual({ turnId: 'turn-1', model: DEFAULT_MODEL, status: expected })
        : expect(run).rejects.toMatchObject({ code: 'AGENT_OUTCOME_UNKNOWN' });
      await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
      controller.abort();
      await vi.waitFor(() => expect(fake.options.turns.abort).toHaveBeenCalled());
      if (terminalStatus) fake.push(frame('turn-terminal', { status: terminalStatus }));
      await vi.advanceTimersByTimeAsync(15_000);

      await settled;
      // An unconfirmed cancel reports no terminal and does not abort again.
      expect(events.map((event) => event.type)).toEqual(expected ? ['turn.finished'] : []);
      expect(fake.options.turns.abort).toHaveBeenCalledTimes(1);
    }),
  );

  it('rejects a terminal without a known status as unknown, not as a failed turn', async () => {
    const fake = fakes();
    const onEvent = vi.fn();
    const run = createMiniAppAgentSessionPorts(fake.options).runTurn({
      sessionId: 'session-1',
      text: 'hello',
      onEvent,
    });
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.push(frame('turn-terminal', { status: 'exploded' }));

    await expect(run).rejects.toMatchObject({ code: 'AGENT_OUTCOME_UNKNOWN' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(fake.options.turns.abort).not.toHaveBeenCalled();
    expect(fake.options.logger.warn).toHaveBeenCalledWith(
      {
        stage: 'turn-terminal',
        sessionId: 'session-1',
        turnId: 'turn-1',
        terminalStatus: 'exploded',
      },
      'Mini App Agent turn terminal has no known status',
    );
  });
});

describe('createMiniAppAgentSessionPorts permissions', () => {
  it('decides only a pending request raised under the same Mini App root', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { purpose: 'miniapp:demo' });
    fake.sessions.set('session-2', { purpose: 'miniapp:demo' });
    fake.sessions.set('child', { parentSessionId: 'session-1' });
    fake.options.permissions.listPending.mockResolvedValue([
      { requestId: 'perm-1', sessionId: 'session-1' },
      { requestId: 'perm-2', sessionId: 'chat' },
      { requestId: 'perm-3', sessionId: 'session-2' },
      { requestId: 'perm-c', sessionId: 'child' },
    ]);
    fake.options.permissions.reply.mockImplementation(async ({ requestIds }) => ({
      processed: [...requestIds],
    }));
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const input = { sessionId: 'session-1', decision: 'allowOnce' } as const;

    await expect(ports.replyPermission({ ...input, requestId: 'perm-1' })).resolves.toBe(
      'processed',
    );
    await expect(ports.replyPermission({ ...input, requestId: 'perm-2' })).resolves.toBe('skipped');
    // Another session of the same plugin is a different root.
    await expect(ports.replyPermission({ ...input, requestId: 'perm-3' })).resolves.toBe('skipped');
    // A delegated child's request belongs to its root, whichever of the two the author names.
    await expect(
      ports.replyPermission({ ...input, sessionId: 'child', requestId: 'perm-c' }),
    ).resolves.toBe('processed');
    await expect(ports.replyPermission({ ...input, requestId: 'perm-c' })).resolves.toBe(
      'processed',
    );
    await expect(
      ports.replyPermission({ ...input, sessionId: 'chat', requestId: 'perm-2' }),
    ).resolves.toBe('skipped');
    expect(fake.options.permissions.reply.mock.calls.map(([call]) => call.requestIds)).toEqual([
      ['perm-1'],
      ['perm-c'],
      ['perm-c'],
    ]);

    fake.options.permissions.reply.mockResolvedValue({ processed: [] });
    await expect(ports.replyPermission({ ...input, requestId: 'perm-1' })).resolves.toBe('skipped');
  });

  it('reports lookup failures before the decision as retryable and passes reply failures through', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', { purpose: 'miniapp:demo' });
    fake.options.permissions.listPending.mockResolvedValue([
      { requestId: 'perm-1', sessionId: 'session-1' },
    ]);
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const input = { sessionId: 'session-1', requestId: 'perm-1', decision: 'deny' } as const;
    const unavailable = { code: 'AGENT_UNAVAILABLE', retryable: true };

    fake.options.repository.get.mockRejectedValueOnce(new Error('db locked'));
    await expect(ports.replyPermission(input)).rejects.toMatchObject(unavailable);
    fake.options.permissions.listPending.mockRejectedValueOnce(new Error('ipc closed'));
    await expect(ports.replyPermission(input)).rejects.toMatchObject(unavailable);
    expect(fake.options.permissions.reply).not.toHaveBeenCalled();
    expect(fake.options.logger.warn).toHaveBeenLastCalledWith(
      {
        stage: 'reply-lookup',
        sessionId: 'session-1',
        requestId: 'perm-1',
        errorName: 'Error',
        error: 'ipc closed',
      },
      'Mini App Agent lookup failed before dispatch',
    );

    // The decision may already apply once `permissions.reply` was called.
    const sent = new Error('reply lost');
    fake.options.permissions.reply.mockRejectedValueOnce(sent);
    await expect(ports.replyPermission(input)).rejects.toBe(sent);
  });

  it('projects permission asks from the global event bus and stops on unsubscribe', () => {
    const fake = fakes();
    const ports = createMiniAppAgentSessionPorts(fake.options);
    const listener = vi.fn();

    const unsubscribe = ports.subscribePermissionAsks(listener);
    fake.publish({
      type: 'permission.ask',
      timestamp: 1,
      source: 'local-runtime',
      payload: {
        requestId: 'perm-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentName: 'mavis',
        toolName: 'bash',
        ruleContents: ['Bash(ls)'],
        toolInput: 'ls',
        toolDescription: 'list',
        reason: 'Run a shell command',
        allowAlwaysSupported: true,
        createdAt: 1,
      },
    });
    fake.publish({
      type: 'permission.resolved',
      timestamp: 1,
      source: 'local-runtime',
      payload: {},
    } as unknown as GlobalEvent);
    unsubscribe();
    fake.publish({
      type: 'permission.ask',
      timestamp: 2,
      source: 'local-runtime',
      payload: {
        requestId: 'perm-2',
        sessionId: 'session-1',
        agentName: 'mavis',
        toolName: 'bash',
        ruleContents: [],
        reason: 'r',
        allowAlwaysSupported: false,
        createdAt: 2,
      },
    });

    expect(listener.mock.calls).toEqual([
      [
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          requestId: 'perm-1',
          toolName: 'bash',
          toolInput: 'ls',
          reason: 'Run a shell command',
        },
      ],
    ]);
  });
});

/** Stream responses reach the frame as the JSON `RespData` string the agent projection writes. */
function textChunk(text: string, turnId = 'turn-1'): string {
  return JSON.stringify({
    type: RespDataType.AgentMessageChunk,
    agent_message_chunk: { msg_id: 'm1', role: Role.Assistant, turn_id: turnId, msg_content: text },
  });
}

function frame(
  kind: SessionFrame['kind'],
  data: unknown,
  turnId: string | null = 'turn-1',
): SessionFrame {
  return {
    identity: `${kind}-id`,
    sessionId: 'session-1',
    ...(turnId ? { turnId } : {}),
    kind,
    data,
    cursor: `cursor:${kind}:${turnId ?? 'session'}`,
    createdAtMs: 5,
  };
}

function fakes() {
  const sessions = new Map<
    string,
    {
      agentName?: string;
      workspaceDir?: string;
      isDefaultWorkspace?: boolean;
      parentSessionId?: string;
      purpose?: string;
      effectiveModel?: string | null;
      effectiveModelVariant?: string | null;
      effectiveModelThinking?: { effort?: string } | null;
    }
  >();
  const messages: Record<string, unknown>[] = [];
  const globalSubscribers = new Set<{ next(event: GlobalEvent): void }>();
  const queue: SessionFrame[] = [];
  const waiters: Array<(result: IteratorResult<SessionFrame>) => void> = [];
  let closed = false;
  // Mirrors SessionResumeIterator: each resume() is a fresh iterator over the session's
  // frames, and any turn-terminal closes it.
  const iterators: { ended: boolean }[] = [];
  const makeIterator = (): AsyncIterableIterator<SessionFrame> => {
    const state = { ended: false };
    iterators.push(state);
    const iterator: AsyncIterableIterator<SessionFrame> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async next() {
        if (state.ended) return { done: true, value: undefined };
        const value =
          queue.shift() ??
          (closed
            ? undefined
            : await new Promise<SessionFrame | undefined>((resolve) =>
                waiters.push((result) => resolve(result.done ? undefined : result.value)),
              ));
        if (!value) return { done: true, value: undefined };
        if (value.kind === 'turn-terminal') state.ended = true;
        return { done: false, value };
      },
      return() {
        state.ended = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return iterator;
  };
  const options = {
    records: {
      createInternalSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    },
    lifecycle: {
      mutateSession: vi.fn(async (_sessionId: string, _fields: object) => ({})),
    },
    repository: { get: vi.fn(async (sessionId: string) => sessions.get(sessionId)) },
    turns: {
      steer: vi.fn<MiniAppAgentSessionPortsOptions['turns']['steer']>(async () => ({
        delivered: true,
        mode: 'activated',
        turnId: 'turn-1',
        completion: new Promise(() => undefined),
      })),
      abort: vi.fn<MiniAppAgentSessionPortsOptions['turns']['abort']>(async () => ({
        status: 'aborted',
        turnId: 'turn-1',
      })),
    },
    stream: { resume: vi.fn(() => makeIterator()) },
    messages: { listTurn: vi.fn(async () => messages) },
    questionnaires: {
      getPending: vi.fn<MiniAppAgentSessionPortsOptions['questionnaires']['getPending']>(
        async () => undefined,
      ),
      reply: vi.fn<MiniAppAgentSessionPortsOptions['questionnaires']['reply']>(async () => ({
        ok: true,
      })),
    },
    permissions: {
      listPending: vi.fn<MiniAppAgentSessionPortsOptions['permissions']['listPending']>(
        async () => [],
      ),
      reply: vi.fn<MiniAppAgentSessionPortsOptions['permissions']['reply']>(async () => ({
        processed: [],
      })),
    },
    eventBus: {
      subscribe: vi.fn((subscriber: { next(event: GlobalEvent): void }) => {
        globalSubscribers.add(subscriber);
        return () => globalSubscribers.delete(subscriber);
      }),
    },
    logger: { warn: vi.fn() },
    modelConfig: vi.fn<MiniAppAgentSessionPortsOptions['modelConfig']>(() => RUNTIME_CONFIG),
    models: { list: vi.fn<MiniAppAgentSessionPortsOptions['models']['list']>(async () => []) },
    agents: { list: vi.fn<MiniAppAgentSessionPortsOptions['agents']['list']>(async () => []) },
    nowMs: () => 42,
  };
  return {
    publish(event: GlobalEvent) {
      for (const subscriber of globalSubscribers) subscriber.next(event);
    },
    options: options as typeof options & MiniAppAgentSessionPortsOptions,
    sessions,
    messages,
    closed: () => iterators.length > 0 && iterators.every((state) => state.ended),
    end() {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve({ done: true, value: undefined });
    },
    push(value: SessionFrame) {
      const resolve = waiters.shift();
      if (resolve) resolve({ done: false, value });
      else queue.push(value);
    },
  };
}

describe('createMiniAppAgentSessionPorts catalogs', () => {
  it('lists only enabled models, projecting variants and thinking efforts', async () => {
    const fake = fakes();
    fake.options.models.list.mockResolvedValue([
      modelEntry({
        modelId: 'M3',
        displayName: 'MiniMax M3',
        effortOptions: ['low', 'high'],
        defaultEffort: 'high',
        supportedVariants: ['fast'],
      }),
      modelEntry({ modelId: 'plain', displayName: 'Plain', effortOptions: [] }),
      modelEntry({ modelId: 'off', displayName: 'Off', enabled: false }),
    ]);
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.listModels()).resolves.toEqual([
      {
        providerId: 'minimax',
        modelId: 'M3',
        displayName: 'MiniMax M3',
        variants: ['fast'],
        thinking: { efforts: ['low', 'high'], default: 'high' },
      },
      { providerId: 'minimax', modelId: 'plain', displayName: 'Plain' },
    ]);
  });

  it('lists agents by canonical name, without aliases or duplicates, marking mavis primary', async () => {
    const fake = fakes();
    fake.options.agents.list.mockResolvedValue([
      { canonicalViewName: 'mavis', displayName: 'Mavis' },
      { canonicalViewName: 'writer', displayName: '' },
      { canonicalViewName: 'writer', displayName: 'Writer' },
    ]);
    const ports = createMiniAppAgentSessionPorts(fake.options);

    await expect(ports.listAgents()).resolves.toEqual([
      { name: 'mavis', displayName: 'Mavis', primary: true },
      { name: 'writer', displayName: 'writer', primary: false },
    ]);
    expect(fake.options.agents.list).toHaveBeenCalledWith({ includeAliases: false });
  });
});

function modelEntry(
  fields: Partial<ModelProviderModelEntry> &
    Pick<ModelProviderModelEntry, 'modelId' | 'displayName'>,
): ModelProviderModelEntry {
  return {
    providerId: 'minimax',
    modelConfigId: `minimax/${fields.modelId}`,
    enabled: true,
    selected: false,
    providerSource: 'provider',
    providerKind: 'minimax-managed',
    providerName: 'MiniMax',
    ...fields,
  };
}
