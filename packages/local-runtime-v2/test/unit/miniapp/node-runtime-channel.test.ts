import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  MINIAPP_LOOPBACK_HEALTH_PATH,
  MINIAPP_LOOPBACK_TOKEN_HEADER,
  type MiniAppHostConnectorSession,
  type MiniAppHostConnectorSessionFactory,
  type MiniAppNodeRuntime,
  type ProcessMiniAppCandidate,
} from '../../../src/service/miniapp/contracts.js';
import { createMiniAppNodeRuntimeAdapter } from '../../../src/service/miniapp/process/node-runtime/node-runtime.js';
import type { MiniAppRunnerInitMessage } from '../../../src/service/miniapp/process/node-runtime/host-runner.js';

/**
 * A scripted child. The parent/child channel is scripted so the test can observe exactly what the
 * runtime sends and how it treats the child's own streams; nothing here spawns a node process.
 */
class ScriptedChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly received: MiniAppRunnerInitMessage[] = [];
  /** Reading this proves the runtime still treats stdin as transport. */
  stdinReads = 0;

  constructor(private readonly onExit: () => void) {
    super();
  }

  get stdin(): EventEmitter {
    this.stdinReads += 1;
    return new EventEmitter();
  }

  /**
   * The readiness probe is a real HTTP request, so the scripted child answers it for real: 401 without
   * the minted credential and 204 on the health path with it.
   */
  private async listen(init: MiniAppRunnerInitMessage): Promise<void> {
    const { createServer } = await import('node:http');
    const server = createServer((request, response) => {
      const authorized = request.headers[MINIAPP_LOOPBACK_TOKEN_HEADER] === init.loopbackToken;
      if (request.url?.startsWith(MINIAPP_LOOPBACK_HEALTH_PATH)) {
        response.writeHead(authorized ? 204 : 401).end();
        return;
      }
      response.writeHead(authorized ? 200 : 401).end('plugin');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(init.listen.port, init.listen.host, resolve);
    });
    this.server = server;
  }

  private server?: import('node:http').Server;

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const init = message as MiniAppRunnerInitMessage;
    if (init?.type === 'miniapp:init') {
      this.received.push(init);
      void this.listen(init).then(
        () => {
          callback?.(null);
          this.emit('message', {
            type: 'miniapp:started',
            pluginId: init.pluginId,
            processGeneration: init.processGeneration,
            readiness: init.readiness,
          });
        },
        (error: Error) => callback?.(error),
      );
      return true;
    }
    if (init?.type === 'miniapp:stop') {
      this.server?.close();
      this.exit(0);
    }
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.server?.close();
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
let sequence = 0;

const candidate = (
  policy: ProcessMiniAppCandidate['hostConnectorPolicy'],
  pluginId: string,
  agentPolicy?: ProcessMiniAppCandidate['agentPolicy'],
): ProcessMiniAppCandidate => ({
  pluginId,
  packageRoot,
  packageDigest: 'package-digest',
  clientDigest: 'client-digest',
  nodeDigest: 'node-digest',
  surfacePath: '/dashboard',
  lifecycle: 'on-demand',
  nodeEntry: 'miniapp/node/server.js',
  mcpEndpoints: [],
  hostConnectorPolicy: policy,
  ...(agentPolicy ? { agentPolicy } : {}),
});

const allowlist = { kind: 'allowlist', providers: ['weather'] } as const;
const denyAll = { kind: 'deny-all' } as const;

interface Harness {
  readonly pluginId: string;
  readonly runtime: MiniAppNodeRuntime;
  readonly child: ScriptedChild;
  readonly onLog: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
  readonly spawn: ReturnType<typeof vi.fn>;
}

async function prepare(input: {
  readonly policy: ProcessMiniAppCandidate['hostConnectorPolicy'];
  readonly agentPolicy?: ProcessMiniAppCandidate['agentPolicy'];
  readonly withFactory?: boolean;
  readonly childConnected?: boolean;
}): Promise<Harness> {
  // The listen port is derived from the plugin id, so each case gets its own plugin and port.
  const pluginId = `fixture.miniapp-${(sequence += 1)}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'miniapp data '));
  const child = new ScriptedChild(() => undefined);
  child.connected = input.childConnected ?? true;
  const onLog = vi.fn();
  const create = vi.fn(
    (): MiniAppHostConnectorSession => ({
      startHandshake: vi.fn(),
      activate: vi.fn(),
      beginQuiesce: vi.fn(),
      retire: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }),
  );
  const factory: MiniAppHostConnectorSessionFactory = { create };
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const adapter = createMiniAppNodeRuntimeAdapter({
    resolvePluginDataDir: () => dataDir,
    verifyCandidate: async () => true,
    materializePackage: async ({ targetRoot }) => {
      const target = join(targetRoot, 'miniapp', 'node', 'server.js');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'export const start = async () => undefined;\n');
    },
    isPortReserved: () => false,
    makeLoopbackToken: () => 'credential-1',
    connectPort: async () => undefined,
    spawn,
    createTerminator: () => ({
      stop: async () => {
        child.exit(0);
        return { proven: true };
      },
    }) as never,
    ...(input.withFactory === false ? {} : { hostConnectorSessionFactory: factory }),
  });
  const runtime = await adapter.prepare({
    candidate: candidate(input.policy, pluginId, input.agentPolicy),
    processGeneration: 'generation-1',
    signal: new AbortController().signal,
    onLog,
  });
  return { pluginId, runtime, child, onLog, create, spawn };
}

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'miniapp runtime '));
  const entry = join(packageRoot, 'miniapp', 'node', 'server.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, 'export const start = async () => undefined;\n');
});

afterAll(async () => {
  await rm(packageRoot, { recursive: true, force: true });
});

describe('Mini App Node runtime connector channel', () => {
  it('ignores the child stdin so no protocol traffic can travel on it', async () => {
    const harness = await prepare({ policy: allowlist });
    try {
      expect(harness.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
      );
      expect(harness.child.stdinReads).toBe(0);
    } finally {
      await harness.runtime.stop();
    }
  });

  it('binds the connector session to the child IPC channel instead of its streams', async () => {
    const harness = await prepare({ policy: allowlist });
    try {
      expect(harness.create).toHaveBeenCalledTimes(1);
      const input = harness.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input.pluginId).toBe(harness.pluginId);
      expect(input.processGeneration).toBe('generation-1');
      expect(input.providers).toEqual(['weather']);
      expect(input.transport).toBe(harness.child);
      expect(input).not.toHaveProperty('request');
      expect(input).not.toHaveProperty('response');
      expect(harness.child.stdinReads).toBe(0);
    } finally {
      await harness.runtime.stop();
    }
  });

  it('refuses a connector allowlist when the child has no IPC channel', async () => {
    await expect(prepare({ policy: allowlist, childConnected: false })).rejects.toMatchObject({
      code: 'HOST_CONNECTOR_UNAVAILABLE',
    });
  });

  it('does not open the channel for a deny-all connector policy', async () => {
    const harness = await prepare({ policy: denyAll });
    try {
      expect(harness.create).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.stop();
    }
  });
});

describe('Mini App Node runtime Agent channel', () => {
  it('opens the shared channel for an agent-only allowlist and forwards the declared policy', async () => {
    const agentPolicy = {
      kind: 'allowlist',
      capabilities: ['session.run'],
      maxConcurrent: 7,
    } as const;
    const harness = await prepare({ policy: denyAll, agentPolicy });
    try {
      expect(harness.create).toHaveBeenCalledTimes(1);
      const input = harness.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input.providers).toEqual([]);
      expect(input.agentPolicy).toEqual(agentPolicy);
      expect(input.transport).toBe(harness.child);
      expect(harness.child.received[0]?.agentPolicy).toEqual(agentPolicy);
    } finally {
      await harness.runtime.stop();
    }
  });

  it('denies Agent access in the init message when the candidate declares no policy', async () => {
    const harness = await prepare({ policy: denyAll });
    try {
      expect(harness.create).not.toHaveBeenCalled();
      expect(harness.child.received[0]?.agentPolicy).toEqual({ kind: 'deny-all' });
    } finally {
      await harness.runtime.stop();
    }
  });
});

describe('Mini App child stream logging', () => {
  it('treats stdout and stderr as bounded user logs without aborting the runtime', async () => {
    const harness = await prepare({ policy: denyAll });
    try {
      harness.child.stdout.emit('data', Buffer.from('plugin.stdout\n'));
      harness.child.stderr.emit('data', Buffer.from('plugin.stderr\n'));
      expect(harness.onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', message: 'plugin.stdout', byteLength: 14 }),
      );
      expect(harness.onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', message: 'plugin.stderr', byteLength: 14 }),
      );
      // A logging plugin keeps running: the same runtime still stops normally.
      await expect(harness.runtime.stop()).resolves.toEqual({ proven: true });
    } finally {
      await harness.runtime.stop();
    }
  });

  it('bounds how many stream log bytes one runtime window accepts', async () => {
    const harness = await prepare({ policy: denyAll });
    try {
      for (let index = 0; index < 32; index += 1) {
        harness.child.stdout.emit('data', Buffer.alloc(8 * 1024, 97));
      }
      expect(harness.onLog.mock.calls.length).toBeLessThanOrEqual(17);
    } finally {
      await harness.runtime.stop();
    }
  });
});
