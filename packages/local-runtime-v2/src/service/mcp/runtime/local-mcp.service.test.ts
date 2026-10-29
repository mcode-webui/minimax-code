/**
 * The turn's tool-discovery budget.
 *
 * A stdio server has to start its process before it can answer, and the servers
 * with the largest tool lists take the longest to get there. The budget decides
 * whether a slow server reads as slow or as broken, so it is pinned here: the
 * Desktop allows 30 seconds for a stdio server, and a shorter budget turns a slow
 * server into a failed connection that the client then reports as unavailable.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveTurnDiscoveryTimeoutMs,
  TURN_DISCOVERY_TIMEOUT_MS,
  TURN_STDIO_DISCOVERY_TIMEOUT_MS,
} from './local-mcp.service.js';

describe('the turn tool-discovery budget', () => {
  it('gives a stdio server the Desktop budget', () => {
    expect(TURN_STDIO_DISCOVERY_TIMEOUT_MS).toBe(30_000);
    expect(resolveTurnDiscoveryTimeoutMs({ transportType: 'stdio' })).toBe(30_000);
  });

  it('keeps a remote server on the short budget', () => {
    expect(TURN_DISCOVERY_TIMEOUT_MS).toBe(2_000);
    expect(resolveTurnDiscoveryTimeoutMs({ transportType: 'http' })).toBe(2_000);
  });

  it('lets a configured budget win', () => {
    expect(
      resolveTurnDiscoveryTimeoutMs({
        transportType: 'stdio',
        turnStdioDiscoveryTimeoutMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      resolveTurnDiscoveryTimeoutMs({
        transportType: 'stdio',
        turnDiscoveryTimeoutMs: 7_000,
      }),
    ).toBe(7_000);
    expect(
      resolveTurnDiscoveryTimeoutMs({
        transportType: 'http',
        turnDiscoveryTimeoutMs: 7_000,
      }),
    ).toBe(7_000);
  });
});
