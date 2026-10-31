import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readOptionalMiniAppContribution } from '../../../src/service/plugin-system/plugin/package/miniapp/reader.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** The smallest package the reader accepts: a process runtime and its two payload roots. */
async function readManifest(miniapp: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'miniapp manifest '));
  roots.push(root);
  await writeTree(root, {
    'package.json': JSON.stringify({
      name: 'miniapp-fixture',
      version: '0.0.0',
      mcode: { schemaVersion: 2, miniApp: './miniapp/miniapp.json' },
    }),
    'miniapp/miniapp.json': JSON.stringify({
      schemaVersion: 1,
      artifacts: { client: ['./miniapp/client'], node: ['./miniapp/node'] },
      runtime: { kind: 'process', entry: './miniapp/node/server.js' },
      surface: { path: '/dashboard' },
      ...miniapp,
    }),
    'miniapp/client/index.html': '<!doctype html>\n',
    'miniapp/node/server.js': 'export {};\n',
  });
  return readOptionalMiniAppContribution(root, []);
}

describe('Mini App manifest compatibility with the shipped generation', () => {
  it('reads a manifest written for the shipped client', async () => {
    const contribution = await readManifest({
      surface: { path: '/dashboard', window: { width: 800, height: 600, alwaysOnTop: true } },
      agentAccess: ['session.run', 'session.read'],
      agentConcurrency: 4,
    });

    expect(contribution).toMatchObject({
      surface: { path: '/dashboard' },
      agentAccess: ['session.run', 'session.read'],
      agentConcurrency: 4,
    });
  });

  it.each([
    ['a desktop window declaration', { width: 800, height: 600, frame: false }],
    ['a declaration the dropped rule set would reject', { transparent: true }],
    ['a value of the wrong type', 'window'],
  ])('gives surface.window no effect: %s', async (_label, window) => {
    const contribution = await readManifest({ surface: { path: '/dashboard', window } });

    expect(contribution?.surface).toEqual({ path: '/dashboard' });
  });

  it('deduplicates agentAccess', async () => {
    const contribution = await readManifest({ agentAccess: ['session.run', 'session.run'] });

    expect(contribution?.agentAccess).toEqual(['session.run']);
  });

  it('omits both agent keys when the manifest does not declare them', async () => {
    const contribution = await readManifest({});

    expect(contribution).not.toHaveProperty('agentAccess');
    expect(contribution).not.toHaveProperty('agentConcurrency');
  });

  it.each([[['session.observe']], [['session.run', 'session.stop']], ['session.run']])(
    'fails closed for agentAccess %j',
    async (agentAccess) => {
      await expect(readManifest({ agentAccess })).rejects.toMatchObject({
        code: 'MINIAPP_AGENT_ACCESS_INVALID',
      });
    },
  );

  it('accepts session.read as a declared Agent capability', async () => {
    const contribution = await readManifest({ agentAccess: ['session.read'] });

    expect(contribution?.agentAccess).toEqual(['session.read']);
  });

  it.each([[1], [32], [4]])(
    'accepts agentConcurrency %j without agentAccess, where it has no effect',
    async (agentConcurrency) => {
      const contribution = await readManifest({ agentConcurrency });

      expect(contribution?.agentConcurrency).toBe(agentConcurrency);
      expect(contribution).not.toHaveProperty('agentAccess');
    },
  );

  it.each([[0], [33], [4.5], ['4'], [null]])(
    'fails closed for agentConcurrency %j',
    async (agentConcurrency) => {
      await expect(readManifest({ agentConcurrency })).rejects.toMatchObject({
        code: 'MINIAPP_AGENT_CONCURRENCY_INVALID',
      });
    },
  );
});

describe('Mini App manifest allowlist', () => {
  it('fails a manifest with an unknown top-level key', async () => {
    await expect(readManifest({ detach: true })).rejects.toMatchObject({
      code: 'MINIAPP_MANIFEST_SCHEMA_INVALID',
    });
  });

  it('fails an unknown key beside surface.window', async () => {
    await expect(
      readManifest({ surface: { path: '/dashboard', window: {}, surfaceId: 'app' } }),
    ).rejects.toMatchObject({
      // The message is part of the behaviour: a relaxed predicate must not read as a pass.
      code: 'MINIAPP_SURFACE_INVALID',
      message: 'MINIAPP_SURFACE_INVALID: surface must contain only path and window',
    });
  });
});
