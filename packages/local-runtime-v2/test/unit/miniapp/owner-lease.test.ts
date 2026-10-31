import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireMiniAppOwner,
  readMiniAppOwnerIdentity,
  resolveMiniAppOwnerEndpoint,
  type MiniAppOwnerAcquisition,
} from '../../../src/service/miniapp/process/node-runtime/owner-lease.js';

const roots: string[] = [];
const held: MiniAppOwnerAcquisition[] = [];

afterEach(async () => {
  for (const acquisition of held.splice(0)) {
    if (acquisition.kind === 'acquired') await acquisition.release();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function pluginDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'miniapp owner '));
  roots.push(dir);
  return dir;
}

async function acquire(dir: string, client = 'webui'): Promise<MiniAppOwnerAcquisition> {
  const acquisition = await acquireMiniAppOwner({
    pluginDataDir: dir,
    pluginId: 'fixture.miniapp',
    identity: { client },
  });
  if (acquisition.kind === 'acquired') held.push(acquisition);
  return acquisition;
}

describe('Mini App ownership', () => {
  it('acquires an unowned Mini App and can take it again after releasing', async () => {
    const dir = await pluginDataDir();

    const first = await acquire(dir);
    expect(first.kind).toBe('acquired');
    if (first.kind === 'acquired') await first.release();

    expect((await acquire(dir)).kind).toBe('acquired');
  });

  it('refuses while another client holds it, and names that client', async () => {
    const dir = await pluginDataDir();

    expect((await acquire(dir, 'desktop')).kind).toBe('acquired');
    expect(await readMiniAppOwnerIdentity(dir)).toMatchObject({ client: 'desktop', pid: process.pid });

    const second = await acquire(dir, 'webui');
    expect(second.kind).toBe('held');
    if (second.kind === 'held') {
      expect(second.owner?.client).toBe('desktop');
      expect(second.owner?.pid).toBe(process.pid);
    }
  });

  it('reclaims an endpoint left behind by an owner that died', async () => {
    const dir = await pluginDataDir();
    const endpoint = resolveMiniAppOwnerEndpoint(dir, 'fixture.miniapp');
    // An owner that died without cleanup leaves the socket file and nothing listening on it.
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(endpoint, resolve));
    await new Promise<void>((resolve) => stale.close(() => resolve()));

    expect((await acquire(dir)).kind).toBe('acquired');
  });

  it('lets two different Mini Apps be owned at the same time', async () => {
    const first = await pluginDataDir();
    const second = await pluginDataDir();

    expect((await acquire(first)).kind).toBe('acquired');
    expect((await acquire(second)).kind).toBe('acquired');
  });

  it('names the endpoint after the plugin data directory, not a global path', async () => {
    const first = await pluginDataDir();
    const second = await pluginDataDir();

    expect(resolveMiniAppOwnerEndpoint(first, 'fixture.miniapp')).not.toBe(
      resolveMiniAppOwnerEndpoint(second, 'fixture.miniapp'),
    );
    expect(resolveMiniAppOwnerEndpoint(first, 'fixture.miniapp', 'win32')).toMatch(
      /^\\\\\.\\pipe\\mcode-miniapp-owner-[a-f0-9]{16}$/u,
    );
  });
});
