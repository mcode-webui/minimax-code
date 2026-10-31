import { describe, expect, it, vi } from 'vitest';

import { CliService, type CliServiceOptions } from '../../../src/local/cli-service.js';

/**
 * The service is a pure forwarder here: it must not grow Mini App lifecycle logic of its own, and the
 * only thing worth pinning is that it reaches the application and does not swallow the launch object.
 */
function serviceWith(miniApps: unknown): CliService {
  return new CliService({
    applications: {},
    application: { miniApps },
    conversation: {},
    management: {},
  } as unknown as CliServiceOptions);
}

describe('CliService Mini App forwarding', () => {
  it('lists through the application', async () => {
    const list = vi.fn(async () => ({ miniApps: [] }));

    await expect(serviceWith({ list }).listMiniApps()).resolves.toEqual({ miniApps: [] });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('opens by plugin and returns the launch coordinates untouched', async () => {
    const launch = { launch: { origin: 'http://127.0.0.1:49999', surfacePath: '/dashboard', runId: 'run' } };
    const open = vi.fn(async () => launch);

    await expect(serviceWith({ open }).openMiniApp({ pluginId: 'fixture.miniapp' })).resolves.toBe(
      launch,
    );
    expect(open).toHaveBeenCalledWith({ pluginId: 'fixture.miniapp' });
  });

  it('stops by plugin', async () => {
    const stop = vi.fn(async () => undefined);

    await serviceWith({ stop }).stopMiniApp({ pluginId: 'fixture.miniapp' });
    expect(stop).toHaveBeenCalledWith({ pluginId: 'fixture.miniapp' });
  });

  it('fails loudly when the host has no Mini App capability', () => {
    expect(() => serviceWith(undefined).listMiniApps()).toThrow();
  });
});
