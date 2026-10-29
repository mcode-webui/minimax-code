import type { MiniAppSurfaceSummary } from '@mavis/shared/miniapp-surface';

import {
  miniAppBusyReason,
  deriveMiniAppNodePort,
  probeMiniAppPortOwnership,
  type MiniAppStatus,
  type MiniAppSupervisor,
} from '../../service/miniapp/index.js';
import type {
  AvailableMiniAppDefinition,
  MiniAppPluginControl,
} from '../../service/plugin-system/index.js';
import type {
  LocalRuntimeApplication,
  ProcessLocalMiniAppLaunch,
} from './process-local-application-contract.js';

type ProcessLocalMiniAppApplication = NonNullable<LocalRuntimeApplication['miniApps']>;

/** Projects installed MiniApp definitions and Supervisor state for the Electron bridge. */
export function createProcessLocalMiniAppApplication(
  plugins: MiniAppPluginControl,
  supervisor: Pick<MiniAppSupervisor, 'inspect' | 'launchCredential' | 'ownerClient'> | undefined,
): ProcessLocalMiniAppApplication | undefined {
  if (!supervisor) return undefined;

  const requireDefinition = async (pluginId: string): Promise<AvailableMiniAppDefinition> => {
    const miniApp = (await plugins.listAvailableMiniApps()).find(
      (candidate) => candidate.pluginId === pluginId,
    );
    if (!miniApp) throw applicationError('NOT_FOUND');
    return miniApp;
  };

  const launch = (
    miniApp: AvailableMiniAppDefinition,
    status: MiniAppStatus | undefined,
  ): ProcessLocalMiniAppLaunch => {
    const active = status?.active;
    if (
      status?.phase !== 'active' ||
      !active?.origin ||
      !active.processGeneration ||
      active.pluginId !== miniApp.pluginId
    ) {
      throw applicationError(status?.failureCode ?? 'RUNTIME_FAILED');
    }
    const credential = supervisor.launchCredential(miniApp.pluginId);
    if (credential === undefined) throw applicationError('RUNTIME_FAILED');
    return {
      miniApp: summary(miniApp, status),
      launch: {
        origin: active.origin,
        surfacePath: active.surfacePath,
        runId: active.processGeneration,
        credential,
      },
    };
  };

  const open = async (
    pluginId: string,
    signal?: AbortSignal,
  ): Promise<ProcessLocalMiniAppLaunch> => {
    signal?.throwIfAborted();
    const miniApp = await requireDefinition(pluginId);
    try {
      await plugins.activateMiniApp({ pluginId, ...(signal ? { signal } : {}) });
    } catch (error) {
      const busyReason = miniAppBusyReason(error);
      if (!busyReason) throw error;
      throw Object.assign(applicationError('BUSY', { cause: error }), { busyReason });
    }
    signal?.throwIfAborted();
    return launch(miniApp, supervisor.inspect(pluginId)[0]);
  };

  const listRows = async (
    definitions: readonly AvailableMiniAppDefinition[],
    statuses: ReadonlyMap<string, MiniAppStatus>,
  ): Promise<readonly MiniAppSurfaceSummary[]> =>
    Promise.all(
      definitions.map(async (miniApp) => {
        const status = statuses.get(miniApp.pluginId);
        if (status?.phase === 'active' || status?.phase === 'starting' || status?.phase === 'preparing') {
          return summary(miniApp, status);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 500);
        timer.unref();
        try {
          const ownership = await probeMiniAppPortOwnership({
            port: deriveMiniAppNodePort(miniApp.pluginId),
            timeoutMs: 500,
            signal: controller.signal,
          });
          const ownedElsewhere = ownership === 'guarded';
          const ownerClient = ownedElsewhere && supervisor.ownerClient
            ? await supervisor.ownerClient(miniApp.pluginId).catch(() => undefined)
            : undefined;
          return summary(miniApp, status, ownedElsewhere, ownerClient);
        } catch {
          return summary(miniApp, status);
        } finally {
          clearTimeout(timer);
        }
      }),
    );

  return {
    list: async () => {
      const definitions = await plugins.listAvailableMiniApps();
      const statuses = new Map(supervisor.inspect().map((status) => [status.pluginId, status]));
      return { miniApps: await listRows(definitions, statuses) };
    },
    listInstalled: async () => {
      const definitions = await plugins.listInstalledMiniApps();
      const statuses = new Map(supervisor.inspect().map((status) => [status.pluginId, status]));
      return { miniApps: await listRows(definitions, statuses) };
    },
    open: ({ pluginId, signal }) => open(pluginId, signal),
    stop: async ({ pluginId, signal }) => {
      await requireDefinition(pluginId);
      await plugins.stopMiniApp({ pluginId, ...(signal ? { signal } : {}) });
    },
  };
}

function summary(
  miniApp: AvailableMiniAppDefinition,
  status: MiniAppStatus | undefined,
  ownedElsewhere = false,
  ownerClient?: string,
): MiniAppSurfaceSummary {
  const runtimeStatus = mapRuntimeStatus(status?.phase);
  return {
    pluginId: miniApp.pluginId,
    source: miniApp.source,
    ...(miniApp.enabled !== undefined ? { enabled: miniApp.enabled } : {}),
    ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
    ...(miniApp.description ? { description: miniApp.description } : {}),
    ...(miniApp.iconPath ? { iconUrl: localIconUrl(miniApp.iconPath) } : {}),
    runtime: {
      kind: 'process',
      status: runtimeStatus,
      ...(runtimeStatus === 'failed' && status?.failureCode
        ? { errorCode: status.failureCode }
        : {}),
      ...(ownedElsewhere
        ? {
            ownership: 'other-client' as const,
            ...(ownerClient ? { ownerClient } : {}),
          }
        : {}),
    },
  };
}

function localIconUrl(iconPath: string): string {
  return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}

function mapRuntimeStatus(
  phase: MiniAppStatus['phase'] | undefined,
): MiniAppSurfaceSummary['runtime']['status'] {
  if (phase === 'active') return 'running';
  if (phase === 'starting' || phase === 'preparing') return 'starting';
  if (phase === 'failed' || phase === 'quarantined') return 'failed';
  return 'stopped';
}

function applicationError(code: string, options?: ErrorOptions): Error & { readonly code: string } {
  return Object.assign(new Error('Mini App surface action failed', options), { code });
}
