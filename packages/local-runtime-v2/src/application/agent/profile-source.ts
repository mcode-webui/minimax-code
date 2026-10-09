import type {
  AgentExecutionProfile,
  FrozenAgentExecutionDefinition,
  LocalAgentService,
} from '../../service/agent/index.js';
import { describeAgentPromptSnapshot } from '../../service/agent/index.js';
import {
  isCommandLineRuntimeOwner,
  resolveRuntimeOwnerPolicy,
  type RuntimeOwnerPolicy,
} from '@mavis/local-runtime';
import { isLocalSourceProvenanceEnabled } from '@mavis/config';
import {
  omitManagedSourceCitationInstructions,
  restoreLegacyFileReferenceInstructions,
} from '@mavis/shared/source-provenance';
import type { LocalConversationRuntimeConfig } from '../../service/model-system/index.js';
import type {
  LocalAgentExecutionProfile,
  LocalAgentProfileSource,
} from '../../service/turn-system/index.js';
import { resolveAgentPromptSurface } from '../../service/turn-system/index.js';
import {
  isTaskSession,
  isCurrentSessionAgentDefinition,
  type SessionRecord,
  type SessionAgentDefinition,
} from '../../service/session-system/index.js';

export function createV2AgentProfileSource(
  agentService: LocalAgentService,
  configGetter: () => LocalConversationRuntimeConfig,
  runtimeOwnerKind: string | undefined,
  capabilityProfile: 'cli' | undefined,
  /** Resolved once at the composition root. Derived here only if omitted. */
  resolvedPolicy?: RuntimeOwnerPolicy,
): LocalAgentProfileSource {
  const policy =
    resolvedPolicy ??
    resolveRuntimeOwnerPolicy({
      kind: runtimeOwnerKind,
      // Cells consumed here do not depend on these two, so this fallback is exact —
      // but it exists only for direct test callers.
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile,
    });
  return {
    render: async ({ session, agent, agentBinding, promptRead }) => {
      const definition = requireCurrentDefinition(session, agentBinding);
      const metadata = agent.metadata ?? {};
      // Freeze one config snapshot for the complete profile render so a live
      // preference update cannot mix capability, memory, and dataDir versions.
      const config = configGetter();
      const capabilities = resolveConfiguredCapabilities(
      config,
      policy.execution.mavisFeatureBundle,
    );
      const frozenOwner = definition?.exactOwnerName;
      const requestRef = frozenOwner
        ? `agent:${frozenOwner}`
        : readMetadataRequestRef(metadata.requestRef);
      const request = {
        // Execution behavior follows the frozen canonical owner, while the
        // persisted Session may retain a legacy primary-family storage owner.
        exactOwnerName: frozenOwner ?? agent.executionOwnerName ?? agent.agentName,
        ...(requestRef === undefined ? {} : { requestRef }),
        surface: resolveAgentPromptSurface(
          session,
          runtimeOwnerKind,
          policy.execution.promptSurfaceDefault,
        ),
        promptProfile: policy.execution.promptProfile,
        appMode: session.appMode ?? 'coding',
        capabilities,
        // Not `restricted`: that cell requires an embedded CLI, and folding it in here
        // would re-open cron and memory for a non-embedded cli/tui owner. The
        // `isCommandLineRuntimeOwner` half keeps the original owner-kind reading, and
        // the policy half is what makes an UNRECOGNISED owner fail closed at the
        // prompt level too — without it this gate granted memory and cron to a typo.
        memoryEnabled:
          policy.execution.memoryFeature &&
          !isCommandLineRuntimeOwner(runtimeOwnerKind) &&
          config.memory?.enabled,
        cronEnabled:
          policy.wiring.cronService &&
          !isCommandLineRuntimeOwner(runtimeOwnerKind),
        dataDirToken: config.dataDir,
        ...(promptRead ? { promptReadContext: promptRead } : {}),
      } as const;
      const profile = await renderProfile(agentService, request, definition);
      return toLocalAgentExecutionProfile(applySourcePromptPolicy(profile, runtimeOwnerKind));
    },
  };
}

function renderProfile(
  agentService: LocalAgentService,
  request: Parameters<LocalAgentService['renderProfile']>[0],
  definition: ReturnType<typeof requireCurrentDefinition>,
): Promise<AgentExecutionProfile> {
  return definition
    ? agentService.renderFrozenProfile(request, frozenDefinition(definition))
    : agentService.renderProfile(request);
}

function resolveConfiguredCapabilities(
  config: LocalConversationRuntimeConfig,
  mavisFeatureBundle: boolean,
) {
  const configured = config.agents?.default;
  if (mavisFeatureBundle) return configured;
  return {
    ...configured,
    features: { ...configured?.features, mavis: false },
  };
}

function requireCurrentDefinition(
  session: SessionRecord,
  binding: SessionAgentDefinition | undefined,
): Extract<SessionAgentDefinition['definition'], { readonly definitionVersion: 2 }> | undefined {
  if (!isTaskSession(session)) return undefined;
  const { sessionId } = session;
  if (!binding) return undefined;
  if (binding.sessionId !== sessionId)
    throw new Error(`Session Agent definition owner mismatch: ${sessionId}`);
  if (!isCurrentSessionAgentDefinition(binding.definition)) {
    throw new Error(`Session Agent definition requires migration: ${sessionId}`);
  }
  return binding.definition;
}

function readMetadataRequestRef(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Re-exported from the policy module rather than re-implemented. It was duplicated
// verbatim in task-agent-binding-capture.ts, and the two copies are the same class of
// defect as isCliRestrictedRuntime vs isCommandLineRuntimeOwner.
export { isCommandLineRuntimeOwner };

function applySourcePromptPolicy(
  profile: AgentExecutionProfile,
  runtimeOwnerKind: string | undefined,
): AgentExecutionProfile {
  // Apply after Apollo/frozen profile resolution, before prompt range assembly.
  if (isLocalSourceProvenanceEnabled(runtimeOwnerKind)) return profile;
  return {
    ...profile,
    corePrompt: restoreLegacyFileReferenceInstructions(
      omitManagedSourceCitationInstructions(profile.corePrompt),
    ),
    ...(profile.agentSystemPrompt !== undefined
      ? { agentSystemPrompt: omitManagedSourceCitationInstructions(profile.agentSystemPrompt) }
      : {}),
  };
}

function toLocalAgentExecutionProfile(profile: AgentExecutionProfile): LocalAgentExecutionProfile {
  return {
    ...(profile.excludeAgentResources ? { excludeAgentResources: true } : {}),
    ...(profile.skipAgentResolution ? { skipAgentResolution: true } : {}),
    ...(profile.expectedAgentInstanceId
      ? { expectedAgentInstanceId: profile.expectedAgentInstanceId }
      : {}),
    requestRef: profile.requestRef,
    resourceReadRef: profile.resourceReadRef,
    exactOwnerName: profile.exactOwnerName,
    canonicalViewName: profile.canonicalViewName,
    resolvedAgentName: profile.resolvedAgentName,
    agentRole: profile.agentRole,
    creationSource: profile.creationSource,
    surface: profile.surface,
    memoryReadAgentNames: profile.memoryReadAgentNames,
    ...(profile.persona !== undefined ? { persona: profile.persona } : {}),
    ...(profile.agentSystemPrompt !== undefined
      ? { agentSystemPrompt: profile.agentSystemPrompt }
      : {}),
    ...(profile.promptSnapshot
      ? { promptMetadata: describeAgentPromptSnapshot(profile.promptSnapshot) }
      : {}),
    corePrompt: profile.corePrompt,
    surfacePrompt: profile.surfacePrompt,
    ...(profile.configSelection ? { configSelection: profile.configSelection } : {}),
    capabilityCeiling: profile.capabilityCeiling,
    provenance: profile.provenance,
  };
}

function frozenDefinition(input: {
  readonly ownerInstanceId?: string;
  readonly systemPrompt: string;
  readonly promptSnapshot?: FrozenAgentExecutionDefinition['promptSnapshot'];
  readonly capabilities: FrozenAgentExecutionDefinition['capabilities'];
}): FrozenAgentExecutionDefinition {
  return {
    ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
    systemPrompt: input.systemPrompt,
    ...(input.promptSnapshot ? { promptSnapshot: input.promptSnapshot } : {}),
    capabilities: input.capabilities,
  };
}
