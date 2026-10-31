import { describe, expect, it, vi } from 'vitest';

import { createSessionMiniAppLifecycle } from '../../../src/application/session/miniapp-actions.js';
import type { MiniAppPresenter } from '../../../src/application/session/process-local-application-contract.js';
import type { MiniAppStatus, MiniAppSupervisor } from '../../../src/service/miniapp/index.js';
import type {
  AvailableMiniAppDefinition,
  MiniAppPluginControl,
} from '../../../src/service/plugin-system/index.js';

const DEFINITION: AvailableMiniAppDefinition = {
  pluginId: 'weather-board',
  source: 'local',
  displayName: 'Weather Board',
};

const DIAGNOSTICS = {
  scope: 'host',
  retention: 'runtime-memory',
  failure: { code: 'RUNTIME_START_FAILED', message: 'Mini App runtime preparation failed.' },
  run: {
    runId: 'run-1',
    current: false,
    preparationStartedAtMs: 1,
    failure: { code: 'RUNTIME_START_FAILED', message: 'Mini App runtime preparation failed.' },
  },
  logs: {
    entries: [
      {
        sequence: 1,
        atMs: 2,
        code: 'runtime.start_requested',
        message: 'Host requested a new Mini App runtime.',
      },
    ],
    truncated: false,
    omittedCount: 0,
  },
} as const;

const STATUS: MiniAppStatus = {
  pluginId: DEFINITION.pluginId,
  phase: 'failed',
  retiringGenerationIds: [],
  leaseCount: 0,
  failureCode: 'RUNTIME_START_FAILED',
  logs: [],
  diagnostics: DIAGNOSTICS,
};

function pluginControl(): MiniAppPluginControl {
  return {
    listAvailableMiniApps: async () => [DEFINITION],
    listInstalledMiniApps: async () => [DEFINITION],
    listAcceptedMiniApps: () => [],
    isAcceptedMiniAppRunning: () => false,
    activateMiniApp: async () => undefined,
    restartMiniApp: async () => undefined,
    stopMiniApp: async () => undefined,
    initializeWorkspaceMiniApp: async () => {
      throw new Error('not reached by this gate');
    },
    publishWorkspaceMiniApp: async () => {
      throw new Error('not reached by this gate');
    },
  } as unknown as MiniAppPluginControl;
}

function supervisorWith(status: MiniAppStatus | undefined): Pick<MiniAppSupervisor, 'inspect'> {
  return {
    inspect: (pluginId?: string) => (status && (!pluginId || pluginId === status.pluginId) ? [status] : []),
  };
}

/**
 * The Agent-facing `inspect` result and the Agent-facing `open` path are the two Mini App
 * capabilities the Host owns on the Agent's behalf, so these checks pin that the diagnostics come
 * from the supervisor's recorded status and that the path reaches the presenter unchanged.
 */
describe('Mini App session actions', () => {
  const sessions = { get: async () => ({ workspaceDir: '/tmp/workspace' }) };

  it('returns the host diagnostics alongside the Mini App summary', async () => {
    const lifecycle = createSessionMiniAppLifecycle(
      pluginControl(),
      supervisorWith(STATUS),
      sessions,
    );
    if (!lifecycle) throw new Error('the Mini App lifecycle was not created');

    const result = await lifecycle.inspect({
      sessionId: 'session-1',
      turnId: 'turn-1',
      pluginId: DEFINITION.pluginId,
    });

    expect(result.diagnostics).toEqual(DIAGNOSTICS);
    expect(result.diagnostics.run?.runId).toBe('run-1');
    expect(result.miniApp.runtime).toEqual({
      kind: 'process',
      status: 'failed',
      errorCode: 'RUNTIME_START_FAILED',
    });
  });

  it('returns an empty host diagnostics block for a Mini App that never ran', async () => {
    const lifecycle = createSessionMiniAppLifecycle(
      pluginControl(),
      supervisorWith(undefined),
      sessions,
    );
    if (!lifecycle) throw new Error('the Mini App lifecycle was not created');

    const result = await lifecycle.inspect({
      sessionId: 'session-1',
      turnId: 'turn-1',
      pluginId: DEFINITION.pluginId,
    });

    expect(result.diagnostics).toEqual({
      scope: 'host',
      retention: 'runtime-memory',
      logs: { entries: [], truncated: false, omittedCount: 0 },
    });
  });

  it('forwards the origin-relative path to the presenter', async () => {
    const open = vi.fn<MiniAppPresenter['open']>(async () => undefined);
    const surface: MiniAppPresenter = { open, close: async () => undefined };
    const lifecycle = createSessionMiniAppLifecycle(
      pluginControl(),
      supervisorWith(STATUS),
      sessions,
      { surface },
    );
    if (!lifecycle) throw new Error('the Mini App lifecycle was not created');

    await lifecycle.open({
      sessionId: 'session-1',
      turnId: 'turn-1',
      pluginId: DEFINITION.pluginId,
      path: '/items/42?tab=details',
    });

    expect(open).toHaveBeenCalledWith({
      sessionId: 'session-1',
      pluginId: DEFINITION.pluginId,
      path: '/items/42?tab=details',
    });
  });

  it('omits the path when the action does not carry one', async () => {
    const open = vi.fn<MiniAppPresenter['open']>(async () => undefined);
    const surface: MiniAppPresenter = { open, close: async () => undefined };
    const lifecycle = createSessionMiniAppLifecycle(
      pluginControl(),
      supervisorWith(STATUS),
      sessions,
      { surface },
    );
    if (!lifecycle) throw new Error('the Mini App lifecycle was not created');

    await lifecycle.open({
      sessionId: 'session-1',
      turnId: 'turn-1',
      pluginId: DEFINITION.pluginId,
    });

    const input = open.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty('path');
  });
});
