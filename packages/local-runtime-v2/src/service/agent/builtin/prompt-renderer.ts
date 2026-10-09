import Handlebars from 'handlebars';
import yaml from 'yaml';
import {
  AGENT_BUILTIN_TOOL_IDS,
  isAgentBuiltinToolEnabled,
  type AgentBuiltinToolId,
  type ResolvedAgentCapabilities,
} from '@mavis/config';
import { roleDirectoryText } from '@mavis/agent-tools/desktop/subagent-roles';

import type { BuiltinRenderInput } from './definitions.js';

const BUILTIN_HANDLEBARS = Handlebars.create();

export const AGENT_PROMPT_PROFILES = ['desktop', 'tui'] as const;

/**
 * Runtime check for `promptProfile`.
 *
 * The union in `contracts.ts` is erased at runtime, so an out-of-union value used to
 * pass through silently: `profile.tui` became `false` and `usesV2Prompts` returned
 * false, which dropped the caller to the legacy renderer instead of the V2 prompts.
 * A typo therefore produced a working host with the wrong prompt text.
 *
 * `undefined` is explicitly valid. A caller that passes only `--prompt-mode
 * coding|work` never sets a profile at all, so requiring one would reject a supported
 * invocation; only a *present* value outside the union is an error.
 */
export function assertAgentPromptProfile(
  value: string | undefined,
): asserts value is 'desktop' | 'tui' | undefined {
  if (value === undefined) return;
  if (!(AGENT_PROMPT_PROFILES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown agent prompt profile ${JSON.stringify(value)}; expected one of ${AGENT_PROMPT_PROFILES.join(', ')} or none.`,
    );
  }
}

export function createBuiltinPromptContext(
  input: BuiltinRenderInput,
  featurePrompts: Readonly<Record<string, string>>,
): Record<string, unknown> {
  assertAgentPromptProfile(input.promptProfile);
  const capabilities: ResolvedAgentCapabilities = input.capabilities;
  const tools = Object.fromEntries(
    AGENT_BUILTIN_TOOL_IDS.map((toolName) => [
      toolName,
      isAgentBuiltinToolEnabled(capabilities, toolName),
    ]),
  ) as Record<AgentBuiltinToolId, boolean>;
  const skills = Object.fromEntries(
    (capabilities.skills ?? []).map((skill) => [skill, true]),
  ) as Record<string, boolean>;
  skills.mavis = capabilities.features.mavis;
  return {
    tools,
    persona: capabilities.persona,
    profile: { tui: input.promptProfile === 'tui' },
    features: capabilities.features,
    skills,
    memory: { enabled: input.memoryEnabled ?? capabilities.features.mavis },
    cron: { enabled: input.cronEnabled ?? capabilities.features.mavis },
    surface: {
      interactive: input.surface !== 'task-child',
      taskChild: input.surface === 'task-child',
      cli: input.surface === 'cli',
    },
    featurePrompts,
    DATA_DIR: input.dataDirToken ?? '{{DATA_DIR}}',
    ROLE_DIRECTORY: roleDirectoryText(),
  };
}

export function renderBuiltinTemplate(
  template: string,
  context: Record<string, unknown>,
  source: string,
): string {
  try {
    return BUILTIN_HANDLEBARS.compile(template, { noEscape: true, strict: true })(context);
  } catch (error) {
    throw new Error(`Invalid V2 built-in Agent prompt ${source}: ${describeError(error)}`, {
      cause: error,
    });
  }
}

export function parseFrontmatter(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const parsed = parseYaml(match[1] ?? '');
  return {
    frontmatter:
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: raw.slice(match[0].length),
  };
}

export function stripFrontmatter(raw: string): string {
  return parseFrontmatter(raw).body;
}

function parseYaml(raw: string): unknown {
  return yaml.parse(raw);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
