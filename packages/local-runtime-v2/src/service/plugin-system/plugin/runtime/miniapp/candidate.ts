import { MINIAPP_AGENT_DEFAULT_CONCURRENCY, type MiniAppAgentPolicy } from '../../../../miniapp/contracts.js';

import { PluginSystemError } from '../../../errors.js';
import type { RuntimeEligibleScannedReadPluginPackage } from '../../package/types.js';
import type { PluginSnapshot } from '../snapshot-builder.js';

/** Candidate projection consumed by PluginSystem's publication participant. */
export interface PluginMiniAppCandidate {
  readonly pluginId: string;
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly clientDigest: string;
  readonly surfacePath: string;
  readonly lifecycle: 'on-demand';
  readonly nodeDigest: string;
  readonly nodeEntry: string;
  readonly mcpEndpoints: readonly { readonly id: string; readonly path: string }[];
  readonly hostConnectorPolicy:
    | { readonly kind: 'deny-all' }
    | { readonly kind: 'allowlist'; readonly providers: readonly string[] };
  /** Derived from the parsed manifest's `agentAccess`; deny-all when it declares none. */
  readonly agentPolicy?: MiniAppAgentPolicy;
}

export interface MiniAppDefinition {
  readonly source: 'official' | 'local';
  readonly displayName?: string;
  readonly description?: string;
  readonly iconPath?: string;
  readonly candidate: PluginMiniAppCandidate;
}

/** Host-facing name retained for the workspace publication interface. */
export type AcceptedMiniApp = MiniAppDefinition;

export function sameMiniAppCandidate(
  left: PluginMiniAppCandidate,
  right: PluginMiniAppCandidate,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Every installed Mini App, enabled or not.
 *
 * The enabled-only projection below is what activation, publication and the
 * runtime's own projection must keep using. This one exists because a management
 * surface has to be able to show a Mini App it disabled and offer to turn it back
 * on: a listing that drops the package answers "nothing is installed", which is
 * the one answer that leaves the person with no action.
 *
 * The two share this walk, so a package cannot be a Mini App for one and not for
 * the other. Official packages carry no per-package switch in this snapshot, so
 * they are enabled whenever the package is present — which is what the enabled
 * projection has always assumed for them. A local package's `enabled` is the
 * projection's own flag, the same one the rest of the plugin system reads.
 */
export function listInstalledMiniAppDefinitions(
  snapshot: PluginSnapshot,
): readonly (MiniAppDefinition & { readonly enabled: boolean })[] {
  const packages = [
    ...snapshot.officialPackages.flatMap(({ plugin }) =>
      plugin?.miniapp ? [{ plugin, enabled: true }] : [],
    ),
    ...snapshot.localPlugins
      .filter((projection) => projection.plugin.miniapp !== undefined)
      .map((projection) => ({ plugin: projection.plugin, enabled: projection.enabled })),
  ];
  return packages
    .map<MiniAppDefinition & { readonly enabled: boolean }>(({ plugin, enabled }) => ({
      enabled,
      source: plugin.source === 'OFFICIAL' ? 'official' : 'local',
      ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
      ...(plugin.description ? { description: plugin.description } : {}),
      ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
      candidate: miniAppCandidateFromPackage({ plugin }),
    }))
    .sort((left, right) => left.candidate.pluginId.localeCompare(right.candidate.pluginId));
}

/** Enabled and valid authored definitions, independent from Host runtime acceptance. */
export function listEnabledMiniAppDefinitions(
  snapshot: PluginSnapshot,
): readonly MiniAppDefinition[] {
  return listInstalledMiniAppDefinitions(snapshot).filter((definition) => definition.enabled);
}

/** Runtime-only projection after a publication snapshot has been admission-filtered. */
export function listAcceptedMiniApps(snapshot: PluginSnapshot): readonly MiniAppDefinition[] {
  return listEnabledMiniAppDefinitions(snapshot);
}

export function miniAppCandidateFromPackage(packageEntry: {
  readonly plugin: RuntimeEligibleScannedReadPluginPackage;
}): PluginMiniAppCandidate {
  const miniapp = packageEntry.plugin.miniapp;
  if (!miniapp) throw candidateError('MINIAPP_CONTRIBUTION_MISSING');
  return {
    pluginId: packageEntry.plugin.name,
    packageRoot: packageEntry.plugin.rootPath,
    // Runtime identity follows the authored MiniApp payload. Ordinary Skill,
    // App, and non-managed MCP changes must not force a service replacement.
    packageDigest: miniapp.contentDigest,
    clientDigest: miniapp.clientDigest,
    surfacePath: miniapp.surface.path,
    lifecycle: miniapp.runtime.lifecycle,
    nodeDigest: miniapp.nodeDigest,
    nodeEntry: miniapp.runtime.entry,
    mcpEndpoints: miniapp.mcpEndpoints.map(({ server, path }) => ({ id: server, path })),
    hostConnectorPolicy: miniapp.hostConnectorAccess?.providers.length
      ? { kind: 'allowlist', providers: [...miniapp.hostConnectorAccess.providers] }
      : { kind: 'deny-all' },
    // An absent or empty list denies: a manifest that never asked for agent access admits none.
    agentPolicy: miniapp.agentAccess?.length
      ? {
          kind: 'allowlist',
          capabilities: [...miniapp.agentAccess],
          maxConcurrent: miniapp.agentConcurrency ?? MINIAPP_AGENT_DEFAULT_CONCURRENCY,
        }
      : { kind: 'deny-all' },
  };
}

function candidateError(code: string): PluginSystemError {
  return new PluginSystemError(code, 'Mini App publication preparation failed');
}
