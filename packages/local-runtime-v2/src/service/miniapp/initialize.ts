import type { AppDb } from '../../infra/db/client.js';
import type { HostProcessConnectorGateway } from '../host-connector-system/index.js';
import type { MiniAppAgentGateway } from './agent/contracts.js';
import { HostMiniAppPortRegistry } from './process/node-runtime/port-registry.js';
import { DrizzleMiniAppStateStore } from './supervisor/state.repository.js';
import type { MiniAppCandidate, MiniAppSupervisor } from './contracts.js';
import { createMiniAppHostConnectorSessionFactory } from './process/host-connector/host-connector.js';
import { createMiniAppNodeRuntimeAdapter } from './process/node-runtime/node-runtime.js';
import { DefaultMiniAppSupervisor } from './supervisor/supervisor.js';

export interface InitializeMiniAppSupervisorOptions {
  readonly db: AppDb;
  readonly connectorGateway: HostProcessConnectorGateway;
  /** The runtime's Agent gateway; the child IPC connector registers its arena against it. */
  readonly agentGateway?: MiniAppAgentGateway;
  /** Stable runtime-owner label shown when another client already owns a Mini App. */
  readonly ownerClient?: string;
  readonly verifyCandidate: (candidate: MiniAppCandidate) => Promise<boolean>;
  readonly materializePackage: (input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
  }) => Promise<void>;
  readonly resolvePluginDataDir: (pluginId: string) => string | Promise<string>;
  readonly productReservedPorts?: ReadonlySet<number>;
  readonly nowMs?: () => number;
  readonly closeTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly logCapacity?: number;
}

/** Host-only production assembly seam. Recovery starts later through RuntimeServices.ready(). */
export function initializeMiniAppSupervisor(
  options: InitializeMiniAppSupervisorOptions,
): MiniAppSupervisor {
  const ports = new HostMiniAppPortRegistry(options.productReservedPorts);
  const nodeRuntime = createMiniAppNodeRuntimeAdapter({
    resolvePluginDataDir: options.resolvePluginDataDir,
    ...(options.ownerClient ? { ownerClient: options.ownerClient } : {}),
    verifyCandidate: options.verifyCandidate,
    materializePackage: options.materializePackage,
    isPortReserved: (input) => ports.isReserved(input),
    reservePort: (input) => ports.reserve(input),
    hostConnectorSessionFactory: createMiniAppHostConnectorSessionFactory({
      gateway: options.connectorGateway,
      ...(options.agentGateway ? { agentGateway: options.agentGateway } : {}),
    }),
  });
  const supervisor = new DefaultMiniAppSupervisor({
    stateStore: new DrizzleMiniAppStateStore(options.db),
    nodeRuntime,
    verifyCandidate: options.verifyCandidate,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.closeTimeoutMs ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.logCapacity ? { logCapacity: options.logCapacity } : {}),
  });
  return supervisor;
}
