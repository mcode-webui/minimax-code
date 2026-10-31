import { describe, expect, it } from 'vitest';

import { HostMiniAppPortRegistry } from '../../../src/service/miniapp/process/node-runtime/port-registry.js';

describe('Mini App Node runtime port registry', () => {
  it('keeps product ports and generation reservations mutually exclusive', () => {
    const registry = new HostMiniAppPortRegistry(new Set([50_000]));

    expect(registry.isReserved({ pluginId: 'one', port: 50_000 })).toBe(true);
    const first = registry.reserve({
      pluginId: 'one',
      port: 50_001,
      processGeneration: 'process-1',
    });
    expect(first).toBeDefined();
    expect(
      registry.reserve({
        pluginId: 'two',
        port: 50_001,
        processGeneration: 'process-2',
      }),
    ).toBeUndefined();

    first?.release();
    first?.release();
    expect(registry.isReserved({ pluginId: 'one', port: 50_001 })).toBe(false);
  });
});
