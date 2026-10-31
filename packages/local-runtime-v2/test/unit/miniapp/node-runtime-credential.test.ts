import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MiniAppNodeRuntime, ProcessMiniAppCandidate } from '../../../src/service/miniapp/contracts.js';
import {
  createMiniAppNodeRuntimeAdapter,
  deriveMiniAppNodePort,
} from '../../../src/service/miniapp/process/node-runtime/node-runtime.js';
import {
  startMiniAppModule,
  type MiniAppRunnerInitMessage,
  type RunningMiniAppModule,
} from '../../../src/service/miniapp/process/node-runtime/host-runner.js';

/**
 * A scripted child: it is the real runner running in this process, so the readiness probe meets the
 * real guard. Everything else about the child process is scripted, which lets the test observe the
 * credential the runtime mints and hands down without spawning a node process per case.
 */
class ScriptedChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new EventEmitter() as unknown as ChildProcess['stdin'];

  readonly received: MiniAppRunnerInitMessage[] = [];
  private runner: RunningMiniAppModule | undefined;

  constructor(
    private readonly onExit: () => void,
    /** A child that accepts the init message and never reports readiness. */
    private readonly silent = false,
    private readonly beforeStart?: (init: MiniAppRunnerInitMessage) => Promise<void>,
  ) {
    super();
  }

  async send(message: unknown, callback?: (error: Error | null) => void): Promise<boolean> {
    const init = message as MiniAppRunnerInitMessage;
    if (init?.type === 'miniapp:init') {
      this.received.push(init);
      if (this.silent) return true;
      try {
        await this.beforeStart?.(init);
        this.runner = await startMiniAppModule(init, {
          loadModule: async () => ({
            start: async (context: { readonly listen: { host: string; port: number } }) => {
              const { createServer } = await import('node:http');
              const server = createServer((_request, response) => {
                response.writeHead(200).end('plugin');
              });
              await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(context.listen.port, context.listen.host, resolve);
              });
              return {
                async dispose() {
                  server.closeAllConnections();
                  await new Promise<void>((resolve) => server.close(() => resolve()));
                },
              };
            },
          }),
        });
      } catch (error) {
        callback?.(error as Error);
        const code =
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'
            ? 'EADDRINUSE'
            : 'RUNNER_START_FAILED';
        this.emit('message', { type: 'miniapp:error', code, errorText: String(error) });
        return false;
      }
      callback?.(null);
      this.emit('message', {
        type: 'miniapp:started',
        pluginId: init.pluginId,
        processGeneration: init.processGeneration,
        readiness: init.readiness,
      });
      return true;
    }
    if (init?.type === 'miniapp:stop') {
      await this.runner?.stop();
      this.exit(0);
    }
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    this.onExit();
    this.emit('exit', code, null);
  }

  kill(): boolean {
    this.exit(0);
    return true;
  }
}

let packageRoot = '';

const candidate = (pluginId = 'fixture.miniapp'): ProcessMiniAppCandidate => ({
  pluginId,
  packageRoot,
  packageDigest: 'package-digest',
  clientDigest: 'client-digest',
  nodeDigest: 'node-digest',
  surfacePath: '/dashboard',
  lifecycle: 'on-demand',
  nodeEntry: 'miniapp/node/server.js',
  mcpEndpoints: [],
  hostConnectorPolicy: { kind: 'deny-all' },
});

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'miniapp runtime '));
  const entry = join(packageRoot, 'miniapp', 'node', 'server.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, 'export const start = async () => undefined;\n');
});

afterAll(async () => {
  await rm(packageRoot, { recursive: true, force: true });
});

describe('Mini App loopback credential', () => {
  it('mints one credential per preparation and hands that exact value down', async () => {
    let minted = 0;
    const child = new ScriptedChild(() => undefined);
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp data '));
    const adapter = createMiniAppNodeRuntimeAdapter({
      resolvePluginDataDir: () => dataDir,
      verifyCandidate: async () => true,
      materializePackage: async ({ targetRoot }) => {
        const target = join(targetRoot, 'miniapp', 'node', 'server.js');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'export const start = async () => undefined;\n');
      },
      isPortReserved: () => false,
      makeLoopbackToken: () => {
        minted += 1;
        return `credential-${minted}`;
      },
      spawn: () => child as unknown as ChildProcess,
      createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
    });

    let runtime: MiniAppNodeRuntime | undefined;
    try {
      runtime = await adapter.prepare({
        candidate: candidate(),
        processGeneration: 'generation-1',
        signal: new AbortController().signal,
        onLog: () => undefined,
      });

      expect(minted).toBe(1);
      expect(child.received).toHaveLength(1);
      expect(child.received[0]?.loopbackToken).toBe('credential-1');
      // The handle carries the same value the guard was installed with, and readiness passed only
      // because the guard answered 204 for it.
      expect(runtime.loopbackToken).toBe('credential-1');
    } finally {
      await runtime?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Mini App process generations', () => {
  it('gives a new process generation a different credential', async () => {
    let minted = 0;
    const tokens: string[] = [];
    const token = () => {
      minted += 1;
      const value = `credential-${minted}`;
      tokens.push(value);
      return value;
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp data '));
    const build = (child: ScriptedChild) =>
      createMiniAppNodeRuntimeAdapter({
        resolvePluginDataDir: () => dataDir,
        verifyCandidate: async () => true,
        materializePackage: async ({ targetRoot }) => {
          const target = join(targetRoot, 'miniapp', 'node', 'server.js');
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, 'export const start = async () => undefined;\n');
        },
        isPortReserved: () => false,
        makeLoopbackToken: token,
        spawn: () => child as unknown as ChildProcess,
        createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
        // Fails fast: this case only needs the init message a new generation would receive.
        runnerStartTimeoutMs: 40,
        nowMs: Date.now,
      });

    try {
      const first = new ScriptedChild(() => undefined);
      const firstRuntime = await build(first).prepare({
        candidate: { ...candidate(), pluginId: 'fixture.first' },
        processGeneration: 'generation-1',
        signal: new AbortController().signal,
        onLog: () => undefined,
      });
      expect(first.received[0]?.loopbackToken).toBe(tokens[0]);
      await firstRuntime.stop();

      const second = new ScriptedChild(() => undefined, true);
      await expect(
        build(second).prepare({
          candidate: { ...candidate(), pluginId: 'fixture.first' },
          processGeneration: 'generation-2',
          signal: new AbortController().signal,
          onLog: () => undefined,
        }),
      ).rejects.toBeDefined();

      expect(second.received).toHaveLength(1);
      expect(second.received[0]?.loopbackToken).toBe(tokens[1]);
      expect(new Set(tokens).size).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Mini App ownership before spawn', () => {
  it('re-probes after a bind race and does not retry on another port', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp external race '));
    let guardedServer: Server | undefined;
    const child = new ScriptedChild(() => undefined, false, async (init) => {
      guardedServer = createServer((_request, response) => {
        response.writeHead(401).end();
      });
      await new Promise<void>((resolve, reject) => {
        guardedServer?.once('error', reject);
        guardedServer?.listen(init.listen.port, '127.0.0.1', resolve);
      });
    });
    const adapter = createMiniAppNodeRuntimeAdapter({
      resolvePluginDataDir: () => dataDir,
      verifyCandidate: async () => true,
      materializePackage: async ({ targetRoot }) => {
        const target = join(targetRoot, 'miniapp', 'node', 'server.js');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'export const start = async () => undefined;\n');
      },
      isPortReserved: () => false,
      maxPortAttempts: 1,
      spawn: () => child as unknown as ChildProcess,
      createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
    });

    try {
      await expect(
        adapter.prepare({
          candidate: candidate(),
          processGeneration: 'generation-bind-race',
          preferredPort: deriveMiniAppNodePort(candidate().pluginId),
          signal: new AbortController().signal,
          onLog: () => undefined,
        }),
      ).rejects.toMatchObject({ code: 'OWNED_ELSEWHERE' });
      expect(child.received).toHaveLength(1);
    } finally {
      guardedServer?.closeAllConnections();
      if (guardedServer) {
        await new Promise<void>((resolve) => guardedServer?.close(() => resolve()));
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses a guarded derived port owned by another client before retrying on a new port', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp external owner '));
    let guardedServer: Server | undefined;
    let guardedPort: number | undefined;
    let ownerPluginId: string | undefined;
    for (let attempt = 0; attempt < 100 && guardedServer === undefined; attempt += 1) {
      const candidateId = `fixture.external-owner-${attempt}`;
      const port = deriveMiniAppNodePort(candidateId);
      const server = createServer((_request, response) => {
        response.writeHead(401).end();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        guardedServer = server;
        guardedPort = port;
        ownerPluginId = candidateId;
      } catch {
        server.closeAllConnections();
      }
    }
    if (!guardedServer || guardedPort === undefined || !ownerPluginId)
      throw new Error('Could not reserve a derived test port');

    const child = new ScriptedChild(() => undefined);
    const adapter = createMiniAppNodeRuntimeAdapter({
      resolvePluginDataDir: () => dataDir,
      verifyCandidate: async () => true,
      materializePackage: async ({ targetRoot }) => {
        const target = join(targetRoot, 'miniapp', 'node', 'server.js');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'export const start = async () => undefined;\n');
      },
      isPortReserved: () => false,
      spawn: () => child as unknown as ChildProcess,
      createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
    });

    try {
      const preparation = adapter.prepare({
        candidate: candidate(ownerPluginId),
        processGeneration: 'generation-external-owner',
        signal: new AbortController().signal,
        onLog: () => undefined,
      });

      await expect(preparation).rejects.toMatchObject({ code: 'OWNED_ELSEWHERE' });
      expect(child.received).toHaveLength(0);
    } finally {
      guardedServer.closeAllConnections();
      await new Promise<void>((resolve) => guardedServer.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('checks deterministic-port ownership even when the Host reservation skips that port', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp reserved owner '));
    let guardedServer: Server | undefined;
    let guardedPort: number | undefined;
    let ownerPluginId: string | undefined;
    for (let attempt = 0; attempt < 100 && guardedServer === undefined; attempt += 1) {
      const candidateId = `fixture.reserved-owner-${attempt}`;
      const port = deriveMiniAppNodePort(candidateId);
      const server = createServer((_request, response) => response.writeHead(401).end());
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        guardedServer = server;
        guardedPort = port;
        ownerPluginId = candidateId;
      } catch {
        server.closeAllConnections();
      }
    }
    if (!guardedServer || guardedPort === undefined || !ownerPluginId)
      throw new Error('Could not reserve a derived test port');

    const child = new ScriptedChild(() => undefined);
    const adapter = createMiniAppNodeRuntimeAdapter({
      resolvePluginDataDir: () => dataDir,
      verifyCandidate: async () => true,
      materializePackage: async ({ targetRoot }) => {
        const target = join(targetRoot, 'miniapp', 'node', 'server.js');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'export const start = async () => undefined;\n');
      },
      isPortReserved: ({ port }) => port === guardedPort,
      maxPortAttempts: 1,
      spawn: () => child as unknown as ChildProcess,
      createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
    });

    try {
      const result = adapter.prepare({
        candidate: candidate(ownerPluginId),
        processGeneration: 'generation-reserved-owner',
        signal: new AbortController().signal,
        onLog: () => undefined,
      });
      const outcome = await result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await outcome.value?.stop();
      expect(outcome).toHaveProperty('error');
      expect('error' in outcome ? outcome.error : undefined).toMatchObject({
        code: 'OWNED_ELSEWHERE',
      });
      expect(child.received).toHaveLength(0);
    } finally {
      guardedServer.closeAllConnections();
      await new Promise<void>((resolve) => guardedServer?.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('checks the derived ownership port when a different preferred listen port exists', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp preferred owner '));
    let guardedServer: Server | undefined;
    let pluginId: string | undefined;
    let guardedPort: number | undefined;
    for (let attempt = 0; attempt < 100 && guardedServer === undefined; attempt += 1) {
      const candidateId = `fixture.preferred-owner-${attempt}`;
      const port = deriveMiniAppNodePort(candidateId);
      const server = createServer((_request, response) => response.writeHead(401).end());
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        guardedServer = server;
        pluginId = candidateId;
        guardedPort = port;
      } catch {
        server.closeAllConnections();
      }
    }
    if (!guardedServer || !pluginId || guardedPort === undefined)
      throw new Error('Could not reserve a derived test port');
    const preferredPort = guardedPort === 65_535 ? 49_152 : guardedPort + 1;
    const child = new ScriptedChild(() => undefined);
    const adapter = createMiniAppNodeRuntimeAdapter({
      resolvePluginDataDir: () => dataDir,
      verifyCandidate: async () => true,
      materializePackage: async ({ targetRoot }) => {
        const target = join(targetRoot, 'miniapp', 'node', 'server.js');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'export const start = async () => undefined;\n');
      },
      isPortReserved: () => false,
      maxPortAttempts: 1,
      spawn: () => child as unknown as ChildProcess,
      createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
    });

    try {
      const outcome = await adapter.prepare({
        candidate: candidate(pluginId),
        processGeneration: 'generation-preferred-owner',
        preferredPort,
        signal: new AbortController().signal,
        onLog: () => undefined,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await outcome.value?.stop();
      expect(outcome).toHaveProperty('error');
      expect('error' in outcome ? outcome.error : undefined).toMatchObject({
        code: 'OWNED_ELSEWHERE',
      });
      expect(child.received).toHaveLength(0);
    } finally {
      guardedServer.closeAllConnections();
      await new Promise<void>((resolve) => guardedServer?.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses a Mini App another client owns, without spawning a process', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'miniapp owned '));
    const build = (child: ScriptedChild) =>
      createMiniAppNodeRuntimeAdapter({
        resolvePluginDataDir: () => dataDir,
        verifyCandidate: async () => true,
        materializePackage: async ({ targetRoot }) => {
          const target = join(targetRoot, 'miniapp', 'node', 'server.js');
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, 'export const start = async () => undefined;\n');
        },
        isPortReserved: () => false,
        ownerClient: 'webui',
        spawn: () => child as unknown as ChildProcess,
        createTerminator: () => ({ stop: async () => ({ proven: true }) }) as never,
      });

    const owner = new ScriptedChild(() => undefined);
    const runtime = await build(owner).prepare({
      candidate: candidate(),
      processGeneration: 'generation-1',
      signal: new AbortController().signal,
      onLog: () => undefined,
    });
    try {
      const second = new ScriptedChild(() => undefined);
      await expect(
        build(second).prepare({
          candidate: candidate(),
          processGeneration: 'generation-2',
          signal: new AbortController().signal,
          onLog: () => undefined,
        }),
      ).rejects.toMatchObject({ code: 'OWNED_ELSEWHERE' });
      // The refusal happened before any spawn, so the second client never reached a process.
      expect(second.received).toHaveLength(0);
    } finally {
      await runtime.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
