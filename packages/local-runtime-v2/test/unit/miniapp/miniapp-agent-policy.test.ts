/**
 * The parsed manifest's `agentAccess` becomes the runtime's admission policy.
 *
 * The reader half (`validation.ts`) is pinned by `miniapp-manifest.test.ts`; this suite covers the
 * seam after it: the contribution a real reader produces, projected onto the candidate the runtime
 * admits Mini App agent calls from. Nothing here is a mock — the manifest is real files on disk and
 * the contribution is what `readOptionalMiniAppContribution` returns for them.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readOptionalMiniAppContribution } from '../../../src/service/plugin-system/plugin/package/miniapp/reader.js';
import type { RuntimeEligibleScannedReadPluginPackage } from '../../../src/service/plugin-system/plugin/package/types.js';
import { miniAppCandidateFromPackage } from '../../../src/service/plugin-system/plugin/runtime/miniapp/candidate.js';

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

/** The smallest package the reader accepts, plus whatever agent fields the case declares. */
async function candidateFor(miniapp: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'miniapp-agent-policy-'));
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
  const contribution = await readOptionalMiniAppContribution(root, []);
  if (!contribution) throw new Error('reader rejected the fixture package');
  return miniAppCandidateFromPackage({
    plugin: {
      name: 'demo.board',
      rootPath: root,
      miniapp: contribution,
    } as unknown as RuntimeEligibleScannedReadPluginPackage,
  });
}

describe('Mini App agent policy from the parsed manifest', () => {
  it('admits session.run and carries the declared concurrency', async () => {
    const candidate = await candidateFor({ agentAccess: ['session.run'], agentConcurrency: 2 });

    expect(candidate.agentPolicy).toEqual({
      kind: 'allowlist',
      capabilities: ['session.run'],
      maxConcurrent: 2,
    });
  });

  it('defaults the concurrency when agentAccess is declared without agentConcurrency', async () => {
    const candidate = await candidateFor({ agentAccess: ['session.run'] });

    expect(candidate.agentPolicy).toEqual({
      kind: 'allowlist',
      capabilities: ['session.run'],
      maxConcurrent: 4,
    });
  });

  it('denies everything when the manifest declares no agentAccess', async () => {
    const candidate = await candidateFor({});

    expect(candidate.agentPolicy).toEqual({ kind: 'deny-all' });
  });

  it('denies everything for an empty agentAccess list', async () => {
    const candidate = await candidateFor({ agentAccess: [] });

    expect(candidate.agentPolicy).toEqual({ kind: 'deny-all' });
  });

  it('keeps agentConcurrency inert without agentAccess', async () => {
    const candidate = await candidateFor({ agentConcurrency: 7 });

    expect(candidate.agentPolicy).toEqual({ kind: 'deny-all' });
  });
});
