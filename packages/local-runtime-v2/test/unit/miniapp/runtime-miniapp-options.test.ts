import { describe, expect, it } from 'vitest';

import { resolveRuntimeMiniAppOptions } from '../../../src/service/miniapp/composition.js';

describe('resolveRuntimeMiniAppOptions', () => {
  it('starts the service when the owner policy carries the cell', () => {
    expect(resolveRuntimeMiniAppOptions({ miniAppService: true })).toEqual({});
  });

  it('leaves the service off when the cell is absent or false', () => {
    expect(resolveRuntimeMiniAppOptions({})).toBeUndefined();
    expect(resolveRuntimeMiniAppOptions({ miniAppService: false })).toBeUndefined();
  });

  it('keeps explicit options reachable even when the policy cell is false', () => {
    const miniApp = { dataDir: '/tmp/miniapp' } as Parameters<
      typeof resolveRuntimeMiniAppOptions
    >[0]['miniApp'];

    expect(resolveRuntimeMiniAppOptions({ miniApp })).toBe(miniApp);
    expect(resolveRuntimeMiniAppOptions({ miniApp, miniAppService: false })).toBe(miniApp);
  });

});
