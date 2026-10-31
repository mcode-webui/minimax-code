import { describe, expect, it } from 'vitest';

import type { ExtensionAPI, ModelContextAssemblyCtx } from '@mavis/agent-runtime';

import {
  createMiniAppControlExtension,
  type MiniAppLifecycle,
  type MiniAppOpenActionContext,
  type MiniAppOpenResult,
} from '../src/miniapp.js';

/**
 * The `open` path is validated by the tool's own schema and forwarded to the lifecycle, so these
 * checks pin that boundary: a legal origin-relative path reaches the lifecycle unchanged, and an
 * illegal one never reaches it at all.
 */
interface MiniAppToolLike {
  readonly impl: {
    execute(
      context: { readonly sessionId: string; readonly turnId: string },
      rawInput: unknown,
      signal?: AbortSignal,
    ): Promise<{ readonly details?: Record<string, unknown> }>;
  };
}

type MiniAppToolFactory = (ctx: ModelContextAssemblyCtx) => MiniAppToolLike | null;

function miniAppTool(lifecycle: MiniAppLifecycle): MiniAppToolLike {
  let registered: MiniAppToolFactory | undefined;
  const api = {
    registerTool: (contribution: MiniAppToolFactory) => {
      registered = contribution;
    },
  } as unknown as ExtensionAPI;
  createMiniAppControlExtension(lifecycle).init(api);
  if (!registered) throw new Error('the Mini App extension registered no tool');
  const tool = registered({
    sessionId: 'session-1',
    turnId: 'turn-1',
    agentName: 'mavis',
    workspaceDir: '/tmp/workspace',
    agentConfig: { agent_profile: { surface: 'cli' } },
    model: {},
    history: [],
  } as unknown as ModelContextAssemblyCtx);
  if (!tool) throw new Error('the Mini App extension contributed no tool for a cli surface');
  return tool;
}

function lifecycleWith(overrides: Partial<MiniAppLifecycle>): MiniAppLifecycle {
  const unused = async (): Promise<never> => {
    throw new Error('not reached by this gate');
  };
  return {
    list: async () => ({ miniApps: [] }),
    init: unused,
    open: unused,
    inspect: unused,
    publish: unused,
    restart: unused,
    stop: unused,
    ...overrides,
  };
}

function openResult(): MiniAppOpenResult {
  return {
    miniApp: {
      pluginId: 'weather-board',
      source: 'local',
      runtime: { kind: 'process', status: 'running' },
    },
    opened: true,
  };
}

async function runOpen(
  lifecycle: MiniAppLifecycle,
  rawInput: unknown,
): Promise<Record<string, unknown> | undefined> {
  const result = await miniAppTool(lifecycle).impl.execute(
    { sessionId: 'session-1', turnId: 'turn-1' },
    rawInput,
  );
  return result.details;
}

describe('Mini App open path', () => {
  it('forwards an origin-relative path to the lifecycle', async () => {
    const opened: MiniAppOpenActionContext[] = [];
    const lifecycle = lifecycleWith({
      open: async (context) => {
        opened.push(context);
        return openResult();
      },
    });

    const details = await runOpen(lifecycle, {
      action: 'open',
      pluginId: 'weather-board',
      path: '/items/42?tab=details',
    });

    expect(details?.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.path).toBe('/items/42?tab=details');
    expect(opened[0]?.pluginId).toBe('weather-board');
  });

  it('omits the path when the action does not carry one', async () => {
    const opened: MiniAppOpenActionContext[] = [];
    const lifecycle = lifecycleWith({
      open: async (context) => {
        opened.push(context);
        return openResult();
      },
    });

    const details = await runOpen(lifecycle, { action: 'open', pluginId: 'weather-board' });

    expect(details?.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toHaveProperty('path');
  });

  it('rejects a path that is not origin-relative', async () => {
    const opened: MiniAppOpenActionContext[] = [];
    const lifecycle = lifecycleWith({
      open: async (context) => {
        opened.push(context);
        return openResult();
      },
    });

    const details = await runOpen(lifecycle, {
      action: 'open',
      pluginId: 'weather-board',
      path: 'items/42',
    });

    expect(details?.ok).toBe(false);
    expect((details?.error as { code?: string }).code).toBe('INVALID_ARGUMENTS');
    expect(opened).toHaveLength(0);
  });

  it('rejects a path that carries a space or a fragment', async () => {
    const opened: MiniAppOpenActionContext[] = [];
    const lifecycle = lifecycleWith({
      open: async (context) => {
        opened.push(context);
        return openResult();
      },
    });

    for (const path of ['/items/42 43', '/items/42#details', '//items/42', '/items/42%zz']) {
      const details = await runOpen(lifecycle, {
        action: 'open',
        pluginId: 'weather-board',
        path,
      });
      expect((details?.error as { code?: string }).code, path).toBe('INVALID_ARGUMENTS');
    }
    expect(opened).toHaveLength(0);
  });

  it('rejects a path on an action that does not accept one', async () => {
    const inspected: unknown[] = [];
    const lifecycle = lifecycleWith({
      inspect: async (context) => {
        inspected.push(context);
        return {
          miniApp: {
            pluginId: context.pluginId,
            source: 'local',
            runtime: { kind: 'process', status: 'stopped' },
          },
          diagnostics: {
            scope: 'host',
            retention: 'runtime-memory',
            logs: { entries: [], truncated: false, omittedCount: 0 },
          },
        };
      },
    });

    const details = await runOpen(lifecycle, {
      action: 'inspect',
      pluginId: 'weather-board',
      path: '/items/42',
    });

    expect((details?.error as { code?: string }).code).toBe('INVALID_ARGUMENTS');
    expect(inspected).toHaveLength(0);
  });
});
