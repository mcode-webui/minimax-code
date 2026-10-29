import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMiniAppNodeRuntimeAdapter } from '../../../src/service/miniapp/process/node-runtime/node-runtime.js';

/** A Mini App entry that serves the port the Host assigned it. */
const PLUGIN_ENTRY = [
  "import { createServer } from 'node:http';",
  'export const start = async (context) => {',
  '  const server = createServer((request, response) => {',
  "    response.writeHead(200, { 'content-type': 'text/plain' });",
  "    response.end('miniapp');",
  '  });',
  '  await new Promise((resolve) => server.listen(context.listen.port, context.listen.host, resolve));',
  '  return { async dispose() { await new Promise((resolve) => server.close(resolve)); } };',
  '};',
].join('\n');

describe('Mini App node runtime runner startup', () => {
  // The real child compiles the runtime graph before it can answer, so this case needs a budget
  // larger than the default one; the assertions themselves stay the shipped ones.
  it('starts the runner that sits beside the runtime module', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'miniapp-runner-startup-'));
    const packageRoot = path.join(root, 'package');
    const dataDir = path.join(root, 'data');
    await mkdir(path.join(packageRoot, 'miniapp', 'node'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(packageRoot, 'miniapp', 'node', 'server.js'), PLUGIN_ENTRY);

    const adapter = createMiniAppNodeRuntimeAdapter({
      resolvePluginDataDir: () => dataDir,
      verifyCandidate: async () => true,
      materializePackage: async ({ targetRoot }) => {
        await mkdir(path.join(targetRoot, 'miniapp', 'node'), { recursive: true });
        await writeFile(path.join(targetRoot, 'miniapp', 'node', 'server.js'), PLUGIN_ENTRY);
      },
      isPortReserved: () => false,
    });

    try {
      const runtime = await adapter.prepare({
        candidate: {
          pluginId: 'test.miniapp',
          packageRoot,
          packageDigest: 'package-digest',
          clientDigest: 'client-digest',
          nodeDigest: 'node-digest',
          surfacePath: '/dashboard',
          lifecycle: 'on-demand',
          nodeEntry: 'miniapp/node/server.js',
          mcpEndpoints: [],
          hostConnectorPolicy: { kind: 'deny-all' },
        },
        processGeneration: 'generation-test',
        signal: new AbortController().signal,
        onLog: () => undefined,
      });
      expect(runtime.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
