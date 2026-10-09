import type { AgentExecutionPolicy } from '../runtime/runtime-owner-policy.js';
import {
  createHostedAgentCapabilities,
  type HostedAgentCapabilities,
  type HostedAgentCapabilitiesHost,
} from './hosted-agent-capabilities.js';

/**
 * Embedded command-line owners run a v2 Runtime without a Scheduler, so Cron,
 * memory and CU are unavailable there.
 *
 * The restriction itself is no longer derived here. It arrives as
 * `execution.restricted`, resolved once from the owner kind and host capabilities by
 * `resolveRuntimeOwnerPolicy`. That was previously the single source of truth for
 * "this host is a restricted command-line runtime"; it is now one consumer of one
 * row, so the reminder pipeline and the capability matrix cannot drift apart — and
 * a client cannot accidentally disagree with itself about whether it is restricted.
 *
 * `disableMemory` / `disableCron` / `disableComputerUse` still move together: they
 * share one branch and the cell cannot be taken partially.
 */
export function createHostedCapabilities(
  host: HostedAgentCapabilitiesHost,
  execution: AgentExecutionPolicy,
  capabilityProfile?: 'cli',
): HostedAgentCapabilities {
  return createHostedAgentCapabilities(
    host,
    execution.restricted
      ? {
          disableMemory: true,
          disableCron: true,
          disableComputerUse: true,
          ...(capabilityProfile === 'cli'
            ? {
                disableMavis: true,
                disabledBuiltinSkillNames: ['mavis-doctor', 'plugin-creator'] as const,
                resumeCodexAvailable: true,
              }
            : {}),
        }
      : undefined,
  );
}
