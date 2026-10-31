import { describe, expect, it } from 'vitest';

import { resolveRuntimeOwnerPolicy } from '@mavis/local-runtime';
import { createMiniAppControlExtension, type MiniAppLifecycle } from '@mavis/agent-extension';
import type { ExtensionAPI, ModelContextAssemblyCtx } from '@mavis/agent-runtime';
import type { RuntimeTool } from '@mavis/agent-core/tools';

import { resolveRuntimeMiniAppOptions } from '../../../src/service/miniapp/composition.js';
import { resolveAgentPromptSurface } from '../../../src/service/turn-system/agent-host/preparation/agent-prompt-surface.js';
import { resolveMiniAppTurnAvailable } from '../../../src/service/turn-system/agent-host/preparation/config/local-agent-config-builder.js';

/**
 * The Mini App tool reaches the model through the host extension, so whether
 * it appears in a host session's tool table is decided by two facts: the host
 * declared the Mini App service (the owner policy cell), and the session's
 * surface may drive one. These checks keep the two in step.
 */
const SESSION = {
  sessionType: 'branch',
  sessionKind: 'conversation',
  visibility: 'visible',
  purpose: '',
} as const;

const lifecycle: MiniAppLifecycle = {
  list: async () => ({ miniApps: [] }),
  init: async () => {
    throw new Error('not reached by this gate');
  },
  open: async () => {
    throw new Error('not reached by this gate');
  },
  inspect: async () => {
    throw new Error('not reached by this gate');
  },
  publish: async () => {
    throw new Error('not reached by this gate');
  },
  restart: async () => {
    throw new Error('not reached by this gate');
  },
  stop: async () => {
    throw new Error('not reached by this gate');
  },
};

type MiniAppToolFactory = (
  ctx: ModelContextAssemblyCtx,
) => RuntimeTool | readonly RuntimeTool[] | null;

/**
 * Captures the tool factory the extension contributes to the model's tool
 * table. The stub covers the one extension API member this extension uses; the
 * decision under test is the real per-turn predicate.
 */
function resolveRegisteredMiniAppTool(): MiniAppToolFactory {
  let registered: MiniAppToolFactory | undefined;
  const api = {
    registerTool: (contribution: MiniAppToolFactory) => {
      registered = contribution;
    },
  } as unknown as ExtensionAPI;
  createMiniAppControlExtension(lifecycle).init(api);
  if (!registered) throw new Error('the Mini App extension registered no tool');
  return registered;
}

function assemblyContext(surface: string): ModelContextAssemblyCtx {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    agentName: 'mavis',
    workspaceDir: '/tmp/workspace',
    agentConfig: { agent_profile: { surface } },
    model: {},
    history: [],
  };
}

function resolveMiniAppTool(factory: MiniAppToolFactory, surface: string): RuntimeTool | null {
  const contributed = factory(assemblyContext(surface));
  if (contributed === null) return null;
  const tools: readonly RuntimeTool[] = Array.isArray(contributed)
    ? (contributed as readonly RuntimeTool[])
    : [contributed as RuntimeTool];
  return tools.find((tool) => tool.def.name === 'miniapp') ?? null;
}

/**
 * The host registers the Mini App extension only when the Mini App service
 * exists, so a host without the service contributes no tool at all.
 */
function resolveHostMiniAppTool(
  factory: MiniAppToolFactory,
  surface: string,
  serviceExists: boolean,
): RuntimeTool | null {
  if (!serviceExists) return null;
  return resolveMiniAppTool(factory, surface);
}

const HOSTS = [
  // The WebUI row is the Desktop row: it resolves an `interactive` surface, because
  // the browser client does have interactive surfaces (the browser panel, the
  // workspace panel, the Mini App presenter).
  { kind: 'webui', declaresMiniAppService: true, expectedSurface: 'interactive' },
  { kind: 'electron', declaresMiniAppService: true, expectedSurface: 'interactive' },
  { kind: 'tui', declaresMiniAppService: false, expectedSurface: 'cli' },
  { kind: 'cli', declaresMiniAppService: false, expectedSurface: 'cli' },
] as const;

describe('Mini App agent capability', () => {
  const factory = resolveRegisteredMiniAppTool();

  for (const host of HOSTS) {
    it(`the ${host.kind} host ${host.declaresMiniAppService ? 'exposes' : 'does not expose'} the Mini App tool`, () => {
      const policy = resolveRuntimeOwnerPolicy({
        kind: host.kind,
        cliEmbedded: true,
        electronHost: false,
        capabilityProfile: 'cli',
      });
      expect(policy.wiring.miniAppService).toBe(host.declaresMiniAppService);

      const serviceExists =
        resolveRuntimeMiniAppOptions({ miniAppService: policy.wiring.miniAppService }) !==
        undefined;
      expect(serviceExists).toBe(host.declaresMiniAppService);

      const surface = resolveAgentPromptSurface(
        SESSION,
        host.kind,
        policy.execution.promptSurfaceDefault,
      );
      expect(surface).toBe(host.expectedSurface);

      const tool = resolveHostMiniAppTool(factory, surface, serviceExists);
      if (host.declaresMiniAppService) {
        // The host registers the Mini App extension only when the service
        // exists, so the tool must reach the model's tool table here.
        expect(tool?.def.name).toBe('miniapp');
      } else {
        expect(tool).toBeNull();
      }
    });
  }

  it('keeps the Mini App tool away from a delegated child turn', () => {
    const policy = resolveRuntimeOwnerPolicy({
      kind: 'webui',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: 'cli',
    });
    expect(policy.wiring.miniAppService).toBe(true);

    expect(resolveMiniAppTool(factory, 'task-child')).toBeNull();
  });

  it('gates the Mini App scope on the host declaration and the surface', () => {
    expect(resolveMiniAppTurnAvailable(true, 'cli')).toBe(true);
    expect(resolveMiniAppTurnAvailable(true, 'interactive')).toBe(true);
    expect(resolveMiniAppTurnAvailable(true, 'task-child')).toBe(false);
    expect(resolveMiniAppTurnAvailable(false, 'cli')).toBe(false);
    expect(resolveMiniAppTurnAvailable(false, 'interactive')).toBe(false);
    expect(resolveMiniAppTurnAvailable(false, undefined)).toBe(false);
  });
});
