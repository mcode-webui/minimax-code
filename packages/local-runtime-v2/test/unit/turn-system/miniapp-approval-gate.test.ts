/**
 * A Mini App's permission ask must be answerable by somebody.
 *
 * A Mini App session is created by a plugin, not by the user, so nobody is watching it unless the run
 * that asked registered an event listener or a host chat has the session open in a side panel. When
 * neither holds, waiting on the approval port leaves the turn parked on a prompt no one can answer and
 * the plugin's queue never drains. The gate therefore consults the Mini App approval router before it
 * asks, and denies with a reason the model can act on.
 *
 * Only the router is faked here; the gate itself is the production class.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  LocalTurnPermissionGate,
  type LocalTurnPermissionDecisionSource,
} from '../../../src/service/turn-system/agent-host/runner/policy/local-turn-permission-gate.js';

const SESSION_LINEAGE_MINIAPP = { miniApp: true } as const;
const SESSION_LINEAGE_ORDINARY = { miniApp: false, parentSessionId: null } as const;

function harness(
  router: { shouldDenyApproval: ReturnType<typeof vi.fn> } | undefined,
) {
  const approval = { request: vi.fn(async () => 'allowOnce' as const) };
  const decisions: LocalTurnPermissionDecisionSource = {
    check: async () => ({ behavior: 'ask', reason: 'This tool needs approval.' }),
  };
  const gate = new LocalTurnPermissionGate({
    decisions,
    approval,
    ...(router ? { miniAppApprovals: router as never } : {}),
  });
  return { gate, approval };
}

function input(lineage?: unknown) {
  return {
    sessionId: 'session-miniapp',
    turnId: 'turn-1',
    agentName: 'mavis',
    model: 'minimax/M3',
    cwd: '/workspace',
    toolContext: {
      toolCall: { id: 'call-1', name: 'mcp_report', source: 'plugin' },
      args: { target: 'weekly' },
    },
    ...(lineage !== undefined ? { sessionLineage: lineage } : {}),
  };
}

describe('LocalTurnPermissionGate Mini App approval routing', () => {
  it('denies an ask nobody can answer instead of waiting on the approval port', async () => {
    const router = { shouldDenyApproval: vi.fn(async () => true) };
    const { gate, approval } = harness(router);

    const result = await gate.beforeToolCall(input(SESSION_LINEAGE_MINIAPP) as never);

    expect(router.shouldDenyApproval).toHaveBeenCalledWith('session-miniapp', SESSION_LINEAGE_MINIAPP);
    expect(approval.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
    expect(result?.reason).toMatch(/nobody can answer/i);
    expect(result?.reason).toContain('mcp_report');
  });

  it('asks the user when a run listener or an open panel can answer', async () => {
    const router = { shouldDenyApproval: vi.fn(async () => false) };
    const { gate, approval } = harness(router);

    const result = await gate.beforeToolCall(input(SESSION_LINEAGE_MINIAPP) as never);

    expect(router.shouldDenyApproval).toHaveBeenCalledTimes(1);
    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('does not consult the router for an ordinary root Session', async () => {
    const router = { shouldDenyApproval: vi.fn(async () => true) };
    const { gate, approval } = harness(router);

    const result = await gate.beforeToolCall(input(SESSION_LINEAGE_ORDINARY) as never);

    expect(router.shouldDenyApproval).not.toHaveBeenCalled();
    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('keeps asking when the runtime has no Mini App router', async () => {
    const { gate, approval } = harness(undefined);

    const result = await gate.beforeToolCall(input(SESSION_LINEAGE_MINIAPP) as never);

    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('fails closed when the router cannot answer for a Mini App root', async () => {
    const router = {
      shouldDenyApproval: vi.fn(async () => {
        throw new Error('routing unavailable');
      }),
    };
    const { gate, approval } = harness(router);

    const result = await gate.beforeToolCall(input(SESSION_LINEAGE_MINIAPP) as never);

    expect(approval.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
  });

  it('asks normally when the router fails and the lineage is not known to be a Mini App', async () => {
    const router = {
      shouldDenyApproval: vi.fn(async () => {
        throw new Error('routing unavailable');
      }),
    };
    const { gate, approval } = harness(router);

    const result = await gate.beforeToolCall(input({ miniApp: false, parentSessionId: 'parent-1' }) as never);

    expect(router.shouldDenyApproval).toHaveBeenCalledTimes(1);
    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });
});
