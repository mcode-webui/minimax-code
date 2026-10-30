import type { MiniAppInspectDiagnostics } from '@mavis/agent-extension';

import type { MiniAppRuntimeLogEntry, MiniAppStatus } from '../contracts.js';
import {
  activeStatusPhase,
  type MiniAppGeneration as Generation,
} from './supervisor-generation.js';

/** Read-only supervisor state needed to project one plugin's `MiniAppStatus`. */
export interface StatusProjectionState {
  readonly active: ReadonlyMap<string, Generation>;
  readonly retiring: ReadonlyMap<string, readonly Generation[]>;
  readonly failures: ReadonlyMap<string, string>;
  readonly quarantined: ReadonlySet<string>;
  readonly disabled: ReadonlySet<string>;
  readonly preparations: ReadonlyMap<string, unknown>;
  readonly cold: ReadonlySet<string>;
}

/** Narrow read of `MiniAppSupervisorDiagnostics` needed to fill in a status projection. */
export interface StatusDiagnosticsReader {
  logs(pluginId: string): readonly MiniAppRuntimeLogEntry[];
  inspect(
    pluginId: string,
    currentRunId: string | undefined,
    failureCode?: string,
  ): MiniAppInspectDiagnostics;
}

function statusPhase(
  state: Pick<
    StatusProjectionState,
    'quarantined' | 'disabled' | 'preparations' | 'failures' | 'cold'
  >,
  pluginId: string,
  active: Generation | undefined,
): MiniAppStatus['phase'] {
  if (state.quarantined.has(pluginId)) return 'quarantined';
  if (state.disabled.has(pluginId)) return 'disabled';
  if (active) return activeStatusPhase(active, state.failures.has(pluginId));
  if (state.preparations.has(pluginId)) return 'preparing';
  if (state.failures.has(pluginId)) return 'failed';
  if (state.cold.has(pluginId)) return 'cold';
  return 'inactive';
}

export function statusFor(
  state: StatusProjectionState,
  diagnostics: StatusDiagnosticsReader,
  pluginId: string,
): MiniAppStatus {
  const active = state.active.get(pluginId);
  const retiring = state.retiring.get(pluginId) ?? [];
  const failureCode = state.failures.get(pluginId);
  return {
    pluginId,
    phase: statusPhase(state, pluginId, active),
    ...(active ? { active: active.view } : {}),
    retiringGenerationIds: retiring.map((generation) => generation.view.miniAppGeneration),
    leaseCount:
      (active?.leases.size ?? 0) +
      retiring.reduce((count, generation) => count + generation.leases.size, 0),
    ...(failureCode ? { failureCode } : {}),
    logs: diagnostics.logs(pluginId),
    diagnostics: diagnostics.inspect(pluginId, active?.view.processGeneration, failureCode),
  };
}
