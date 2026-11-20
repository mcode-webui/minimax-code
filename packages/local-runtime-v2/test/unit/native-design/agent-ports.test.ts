import { describe, expect, it, vi } from 'vitest';

import { RespDataType, Role } from '@mavis/agent-core/protocol';
import type { GlobalEvent } from '@mavis/shared/global-events';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';

import type { SessionFrame } from '../../../src/service/session-system/index.js';
import type { AgentTurnRunEvent } from '../../../src/service/agent-turn/contracts.js';
import {
  createNativeDesignAgentPorts,
  type NativeDesignAgentPortsOptions,
} from '../../../src/service/native-design/agent-ports.js';

const RUNTIME_CONFIG = {
  dataDir: '/tmp/native-design-agent-ports-config',
  defaultModel: 'minimax/M3',
  provider: {
    minimax: {
      models: { M3: { limit: { context: 512_000, output: 16_000 } } },
    },
  },
};

const QUESTION: AskQuestionnaireRequest = {
  id: 'question-1',
  sessionId: 'session-1',
  createdAt: 1,
  steps: [
    {
      id: 's1',
      question: 'Continue?',
      selectionMode: 'single',
      options: [{ id: 'a', label: 'A' }],
    },
  ],
} as AskQuestionnaireRequest;

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
      purpose?: string;
      visibility?: 'hidden';
      archived?: boolean;
      parentSessionId?: string;
      effectiveModel?: string | null;
      effectiveModelVariant?: string | null;
      effectiveModelThinking?: { effort?: string } | null;
    }
  >();
  const globalSubscribers = new Set<{ next(event: GlobalEvent): void }>();
  const queue: SessionFrame[] = [];
  const waiters: Array<(result: IteratorResult<SessionFrame>) => void> = [];
  const makeIterator = (): AsyncIterableIterator<SessionFrame> => {
    let ended = false;
    const iterator: AsyncIterableIterator<SessionFrame> = {
      [Symbol.asyncIterator]: () => iterator,
      async next() {
        if (ended) return { done: true, value: undefined };
        const value =
          queue.shift() ??
          (await new Promise<SessionFrame>((resolve) =>
            waiters.push((result) => resolve(result.value as SessionFrame)),
          ));
        if (value.kind === 'turn-terminal') ended = true;
        return { done: false, value };
      },
      return() {
        ended = true;
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
      steer: vi.fn<NativeDesignAgentPortsOptions['turns']['steer']>(async () => ({
        delivered: true,
        mode: 'activated',
        turnId: 'turn-1',
      })),
      abort: vi.fn<NativeDesignAgentPortsOptions['turns']['abort']>(async () => ({
        status: 'aborted',
        turnId: 'turn-1',
      })),
    },
    stream: { resume: vi.fn(() => makeIterator()) },
    messages: {
      listTurn: vi.fn(async () => []),
      listRecent: vi.fn(async () => []),
    },
    questionnaires: {
      getPending: vi.fn<NativeDesignAgentPortsOptions['questionnaires']['getPending']>(
        async () => undefined,
      ),
      reply: vi.fn<NativeDesignAgentPortsOptions['questionnaires']['reply']>(async () => ({
        ok: true,
      })),
    },
    permissions: {
      listPending: vi.fn<NativeDesignAgentPortsOptions['permissions']['listPending']>(
        async () => [],
      ),
      reply: vi.fn<NativeDesignAgentPortsOptions['permissions']['reply']>(async () => ({
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
    modelConfig: vi.fn<NativeDesignAgentPortsOptions['modelConfig']>(() => RUNTIME_CONFIG),
    models: { list: vi.fn<NativeDesignAgentPortsOptions['models']['list']>(async () => []) },
    nowMs: () => 42,
  };
  return {
    options: options as unknown as NativeDesignAgentPortsOptions,
    sessions,
    publish(event: GlobalEvent) {
      for (const subscriber of globalSubscribers) subscriber.next(event);
    },
    push(value: SessionFrame) {
      const resolve = waiters.shift();
      if (resolve) resolve({ done: false, value });
      else queue.push(value);
    },
  };
}

describe('native Design Agent ports', () => {
  it('routes delegated asks to the native run and forwards deny only for an owned pending request', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', {
      agentName: 'mavis',
      purpose: 'webui-design',
      visibility: 'hidden',
      effectiveModel: 'minimax/M3',
    });
    fake.sessions.set('child', { parentSessionId: 'session-1' });
    fake.sessions.set('foreign', { agentName: 'mavis' });
    fake.options.permissions.listPending.mockResolvedValue([
      { sessionId: 'child', requestId: 'design-permission' },
    ]);
    const ports = createNativeDesignAgentPorts(fake.options, '/synthetic/no-write');
    const events: AgentTurnRunEvent[] = [];
    const run = ports.run(
      {
        sessionId: 'session-1',
        text: 'native work',
        capabilitySelection: { tools: [] },
      },
      { onEvent: (event) => events.push(event) },
    );
    await vi.waitFor(() => expect(fake.options.turns.steer).toHaveBeenCalled());
    fake.publish({
      type: 'permission.ask',
      timestamp: 1,
      source: 'local-runtime',
      payload: {
        requestId: 'design-permission',
        sessionId: 'child',
        turnId: 'child-turn',
        agentName: 'mavis',
        toolName: 'bash',
        ruleContents: [],
        reason: 'synthetic permission',
        allowAlwaysSupported: false,
        createdAt: 1,
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'permission.requested', sessionId: 'child' }),
      ),
    );
    expect(fake.options.permissions.reply).not.toHaveBeenCalled();
    await expect(
      ports.reply({ sessionId: 'foreign', requestId: 'design-permission', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    await expect(
      ports.reply({ sessionId: 'child', requestId: 'other', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    await ports.reply({ sessionId: 'child', requestId: 'design-permission', decision: 'deny' });
    expect(fake.options.permissions.reply).toHaveBeenCalledExactlyOnceWith({
      requestIds: ['design-permission'],
      decision: 'deny',
    });
    expect(fake.options.turns.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        producerId: 'webui-design:session-1',
        provenance: expect.objectContaining({ source: 'webui-design' }),
        capabilitySelection: { tools: [] },
      }),
    );
    fake.push(frame('turn-terminal', { status: 'completed' }));
    await run;
    const count = events.length;
    fake.publish({
      type: 'permission.ask',
      timestamp: 2,
      source: 'local-runtime',
      payload: {
        requestId: 'late',
        sessionId: 'child',
        agentName: 'mavis',
        toolName: 'bash',
        ruleContents: [],
        reason: 'late',
        allowAlwaysSupported: false,
        createdAt: 2,
      },
    });
    await Promise.resolve();
    expect(events).toHaveLength(count);
  });

  it('observes permissions during questionnaire continuation and refuses pre-aborted work before dispatch', async () => {
    const fake = fakes();
    fake.sessions.set('session-1', {
      agentName: 'mavis',
      purpose: 'webui-design',
      visibility: 'hidden',
      effectiveModel: 'minimax/M3',
    });
    const ports = createNativeDesignAgentPorts(fake.options, '/synthetic/no-write');
    const aborted = new AbortController();
    aborted.abort();
    await expect(ports.run({ text: 'cancelled' }, { signal: aborted.signal })).rejects.toThrow();
    expect(fake.options.records.createInternalSession).not.toHaveBeenCalled();
    expect(fake.options.turns.steer).not.toHaveBeenCalled();
    fake.options.questionnaires.getPending.mockResolvedValueOnce(QUESTION);
    fake.options.questionnaires.reply.mockImplementation(async () => {
      fake.push(frame('runtime-event', textChunk('continued', 'turn-2'), 'turn-2'));
      return { ok: true, injected: true };
    });
    const events: AgentTurnRunEvent[] = [];
    const run = ports.answer(
      {
        sessionId: 'session-1',
        requestId: QUESTION.id,
        answers: [{ stepId: 's1', selectedOptionIds: ['a'], selectedOther: false }],
      },
      { onEvent: (event) => events.push(event) },
    );
    await vi.waitFor(() => expect(fake.options.questionnaires.reply).toHaveBeenCalled());
    fake.publish({
      type: 'permission.ask',
      timestamp: 1,
      source: 'local-runtime',
      payload: {
        requestId: 'continuation-permission',
        sessionId: 'session-1',
        turnId: 'turn-2',
        agentName: 'mavis',
        toolName: 'bash',
        ruleContents: [],
        reason: 'synthetic permission',
        allowAlwaysSupported: false,
        createdAt: 1,
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'permission.requested',
          requestId: 'continuation-permission',
        }),
      ),
    );
    fake.push(frame('turn-terminal', { status: 'completed' }, 'turn-2'));
    expect((await run).status).toBe('finished');
  });
});
