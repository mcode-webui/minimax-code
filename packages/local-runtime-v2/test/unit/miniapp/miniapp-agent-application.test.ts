/**
 * The client-facing agent capability: what the application facade offers a caller, and what it
 * withholds.
 *
 * The gateway owns admission, run slots and the session ports. The facade is the only thing a client
 * sees, so it must carry the eleven operations and none of the gateway's own surface — no `bind`, no
 * `registerArena`, no ports.
 */
import { describe, expect, it, vi } from 'vitest';

import { createProcessLocalMiniAppAgentApplication } from '../../../src/application/session/process-local-miniapp-agent-application.js';

type Gateway = Parameters<typeof createProcessLocalMiniAppAgentApplication>[0];

function gatewayDouble() {
  return {
    run: vi.fn(async () => ({
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'finished' as const,
      text: 'reply',
    })),
    models: vi.fn(async () => ({ models: [], default: { providerId: 'p', modelId: 'm' } })),
    agents: vi.fn(async () => ({ agents: [] })),
    sessions: vi.fn(async () => ({ sessions: [] })),
    session: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ sessionId: 'session-2' })),
    reply: vi.fn(async () => undefined),
    answer: vi.fn(async () => ({ sessionId: 'session-1', status: 'finished' as const })),
    open: vi.fn(async () => ({ sessionId: 'session-1', hostSessionId: 'chat-1' })),
    panelOpened: vi.fn(async () => undefined),
    panelClosed: vi.fn(async () => undefined),
  };
}

const CALLER = { pluginId: 'demo.board', runId: 'gen-1', hostSessionId: 'chat-1' } as const;

describe('createProcessLocalMiniAppAgentApplication', () => {
  it('exposes exactly the client operations, without the gateway or its ports', () => {
    const facade = createProcessLocalMiniAppAgentApplication(gatewayDouble() as unknown as Gateway);

    expect(Object.keys(facade).sort()).toEqual([
      'agents',
      'answer',
      'create',
      'models',
      'open',
      'panelClosed',
      'panelOpened',
      'reply',
      'run',
      'session',
      'sessions',
    ]);
    expect(facade).not.toHaveProperty('bind');
    expect(facade).not.toHaveProperty('registerArena');
    expect(facade).not.toHaveProperty('ports');
    expect(facade).not.toHaveProperty('subscribePermissionAsks');
  });

  it('turns the trusted tab identity into a page caller for every operation', async () => {
    const gateway = gatewayDouble();
    const facade = createProcessLocalMiniAppAgentApplication(gateway as unknown as Gateway);

    await facade.run({ caller: CALLER, text: 'hi' });
    await facade.models({ caller: CALLER });
    await facade.create({ caller: CALLER, agent: 'writer' });
    await facade.reply({ caller: CALLER, sessionId: 's', requestId: 'r', decision: 'deny' });
    await facade.open({ caller: CALLER, sessionId: 's' });

    const pageCaller = {
      pluginId: 'demo.board',
      processGeneration: 'gen-1',
      source: 'page',
      hostSessionId: 'chat-1',
    };
    expect(gateway.run).toHaveBeenCalledWith(pageCaller, { text: 'hi' }, {});
    expect(gateway.models).toHaveBeenCalledWith(pageCaller);
    expect(gateway.create).toHaveBeenCalledWith(pageCaller, { agent: 'writer' });
    expect(gateway.reply).toHaveBeenCalledWith(pageCaller, {
      sessionId: 's',
      requestId: 'r',
      decision: 'deny',
    });
    expect(gateway.open).toHaveBeenCalledWith(pageCaller, { sessionId: 's' });
  });

  it('carries the caller abort signal and event listener into the run it starts', async () => {
    const gateway = gatewayDouble();
    const facade = createProcessLocalMiniAppAgentApplication(gateway as unknown as Gateway);
    const controller = new AbortController();
    const onEvent = vi.fn();

    await facade.run({
      caller: CALLER,
      text: 'hi',
      sessionId: 'session-9',
      model: { providerId: 'minimax', modelId: 'M3' },
      signal: controller.signal,
      onEvent,
    });

    expect(gateway.run).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'demo.board', processGeneration: 'gen-1' }),
      {
        text: 'hi',
        sessionId: 'session-9',
        model: { providerId: 'minimax', modelId: 'M3' },
      },
      { signal: controller.signal, onEvent },
    );
  });
});
