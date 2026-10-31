import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer as createNetServer, connect as connectNet, type Socket } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MINIAPP_LOOPBACK_HEALTH_PATH,
  MINIAPP_LOOPBACK_TOKEN_HEADER,
} from '../../../src/service/miniapp/contracts.js';
import { probeMiniAppPortOwnership } from '../../../src/service/miniapp/process/node-runtime/loopback-ownership.js';
import { waitForLoopbackReadiness } from '../../../src/service/miniapp/process/node-runtime/loopback-readiness.js';
import {
  isMiniAppRunnerInitMessage,
  startMiniAppModule,
  type MiniAppRunnerInitMessage,
  type RunningMiniAppModule,
} from '../../../src/service/miniapp/process/node-runtime/host-runner.js';

/**
 * The guard patches `http.Server.prototype.emit` process-wide and has no uninstall, which is
 * exactly how it behaves inside a Mini App process: one credential, one port, every server in
 * that process. So this file installs one guarded plugin server and interrogates it, rather than
 * starting a fresh one per case.
 */
const TOKEN = 'test-loopback-credential-0123456789';

interface ObservedRequest {
  readonly headers: http.IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly url: string;
}

const observed: ObservedRequest[] = [];
let server: RunningMiniAppModule | undefined;
let port = 0;
let packageRoot = '';

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const allocated = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return allocated;
}

function initMessage(): MiniAppRunnerInitMessage {
  return {
    type: 'miniapp:init',
    protocolVersion: 1,
    pluginId: 'fixture.miniapp',
    processGeneration: 'generation-1',
    packageRoot,
    nodeEntry: 'miniapp/node/server.js',
    dataDir: packageRoot,
    listen: { host: '127.0.0.1', port },
    readiness: { startupToken: 'startup-token', nodeDigest: 'node-digest' },
    loopbackToken: TOKEN,
    hostConnectorPolicy: { kind: 'deny-all' },
    agentPolicy: { kind: 'deny-all' },
  };
}

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'miniapp guard '));
  // The runner resolves the declared entry for real before the injected loader runs.
  const entry = join(packageRoot, 'miniapp', 'node', 'server.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, 'export const start = async () => undefined;\n');
  port = await freePort();
  server = await startMiniAppModule(initMessage(), {
    loadModule: async () => ({
      start: async (context: { readonly listen: { host: string; port: number } }) => {
        const pluginServer = http.createServer((request, response) => {
          observed.push({
            headers: { ...request.headers },
            rawHeaders: [...request.rawHeaders],
            url: request.url ?? '',
          });
          response.writeHead(200, { 'content-type': 'text/plain' }).end('plugin');
        });
        const upgraded = new Set<import('node:net').Socket>();
        pluginServer.on('upgrade', (request, socket) => {
          upgraded.add(socket);
          socket.once('close', () => upgraded.delete(socket));
          observed.push({
            headers: { ...request.headers },
            rawHeaders: [...request.rawHeaders],
            url: request.url ?? '',
          });
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
          );
        });
        await new Promise<void>((resolve, reject) => {
          pluginServer.once('error', reject);
          pluginServer.listen(context.listen.port, context.listen.host, resolve);
        });
        return {
          async dispose() {
            // An upgraded socket leaves the server's own tracking; the fixture ends it here.
            for (const socket of upgraded) socket.destroy();
            pluginServer.closeAllConnections();
            await new Promise<void>((resolve) => pluginServer.close(() => resolve()));
          },
        };
      },
    }),
  });
});

afterAll(async () => {
  await server?.stop();
  await rm(packageRoot, { recursive: true, force: true });
});

interface Response {
  readonly status: number;
  readonly body: string;
}

function request(input: {
  readonly path: string;
  readonly token?: string;
  readonly host?: string;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: input.path,
        // A kept-alive socket would hold the fixture server open past the last assertion.
        agent: false,
        headers: {
          ...(input.token === undefined ? {} : { [MINIAPP_LOOPBACK_TOKEN_HEADER]: input.token }),
          ...(input.host === undefined ? {} : { host: input.host }),
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Resolves with the first bytes the server sends, or 'closed' when the socket is destroyed. */
function upgradeOutcome(token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectNet({ host: '127.0.0.1', port });
    let received = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(received === '' ? 'closed' : received);
    };
    socket.once('connect', () => {
      const extra = token === undefined ? '' : `${MINIAPP_LOOPBACK_TOKEN_HEADER}: ${token}\r\n`;
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extra}\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      finish();
    });
    socket.once('error', finish);
    socket.once('end', finish);
    socket.once('close', finish);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error('upgrade outcome timed out'));
    });
  });
}

describe('Mini App loopback guard', () => {
  it('answers an unauthenticated request with 401 and no body', async () => {
    const response = await request({ path: '/' });

    expect(response.status).toBe(401);
    expect(response.body).toBe('');
  });

  it('answers a request carrying the wrong credential with 401', async () => {
    const response = await request({ path: '/', token: 'not-the-credential' });

    expect(response.status).toBe(401);
    expect(response.body).toBe('');
  });

  it('rejects the right credential on the wrong host', async () => {
    const response = await request({ path: '/', token: TOKEN, host: `localhost:${port}` });

    expect(response.status).toBe(401);
  });

  it('reaches the plugin handler with the right credential and hides the header from it', async () => {
    observed.length = 0;
    const response = await request({ path: '/dashboard', token: TOKEN });

    expect(response.status).toBe(200);
    expect(response.body).toBe('plugin');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toBe('/dashboard');
    expect(observed[0]?.headers).not.toHaveProperty(MINIAPP_LOOPBACK_TOKEN_HEADER);
    expect(
      observed[0]?.rawHeaders.some(
        (value) => value.toLowerCase() === MINIAPP_LOOPBACK_TOKEN_HEADER,
      ),
    ).toBe(false);
  });

  it('answers the reserved health path itself, before the plugin handler', async () => {
    observed.length = 0;
    const authenticated = await request({ path: MINIAPP_LOOPBACK_HEALTH_PATH, token: TOKEN });

    expect(authenticated.status).toBe(204);
    expect(observed).toHaveLength(0);

    const anonymous = await request({ path: MINIAPP_LOOPBACK_HEALTH_PATH });
    expect(anonymous.status).toBe(401);
    expect(observed).toHaveLength(0);
  });

  it('destroys an upgrade without the credential and forwards one that carries it', async () => {
    observed.length = 0;
    expect(await upgradeOutcome()).toBe('closed');
    expect(observed).toHaveLength(0);

    const forwarded = await upgradeOutcome(TOKEN);
    expect(forwarded).toContain('101');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.headers).not.toHaveProperty(MINIAPP_LOOPBACK_TOKEN_HEADER);
  });
});

describe('runner init message', () => {
  it('requires a non-empty loopback credential', () => {
    expect(isMiniAppRunnerInitMessage(initMessage())).toBe(true);

    const withoutToken: Record<string, unknown> = { ...initMessage() };
    delete withoutToken.loopbackToken;
    expect(isMiniAppRunnerInitMessage(withoutToken)).toBe(false);
    expect(isMiniAppRunnerInitMessage({ ...initMessage(), loopbackToken: '' })).toBe(false);
    expect(isMiniAppRunnerInitMessage({ ...initMessage(), loopbackToken: 42 })).toBe(false);
    expect(isMiniAppRunnerInitMessage({ ...initMessage(), loopbackToken: ['token'] })).toBe(false);
  });
});

describe('Mini App loopback readiness', () => {
  function readiness(port: number, token: string, timeoutMs = 2_000) {
    return waitForLoopbackReadiness({
      port,
      token,
      deadline: Date.now() + timeoutMs,
      nowMs: Date.now,
      probeTimeoutMs: 500,
      retryMs: 25,
      wait: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        }),
      signal: new AbortController().signal,
    });
  }

  it('passes when the guard rejects the anonymous probe and answers the credentialed one', async () => {
    await expect(readiness(port, TOKEN)).resolves.toBeUndefined();
  });

  it('fails when the credentialed probe is rejected', async () => {
    await expect(readiness(port, 'wrong-credential')).rejects.toMatchObject({
      code: 'READINESS_PROBE_REJECTED',
      message: 'authenticated health probe expected 204, received 401',
    });
  });

  it('fails when an anonymous probe is not rejected', async () => {
    const plainPort = await freePort();
    const script = [
      "const http = require('node:http');",
      'http',
      '  .createServer((_request, response) => response.writeHead(200).end())',
      `  .listen(${plainPort}, '127.0.0.1');`,
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readiness(plainPort, TOKEN)).rejects.toMatchObject({
        code: 'READINESS_PROBE_REJECTED',
        message: 'unauthenticated health probe expected 401, received 200',
      });
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('times out when nothing is listening', async () => {
    const closedPort = await freePort();
    await expect(readiness(closedPort, TOKEN, 150)).rejects.toMatchObject({
      code: 'READINESS_TIMEOUT',
    });
  });
});

describe('Mini App port ownership', () => {
  const probe = (target: number) =>
    probeMiniAppPortOwnership({
      port: target,
      timeoutMs: 500,
      signal: new AbortController().signal,
    });

  it('reports a closed port as free', async () => {
    expect(await probe(await freePort())).toBe('free');
  });

  it('reports a port whose guard rejects an anonymous request as guarded', async () => {
    expect(await probe(port)).toBe('guarded');
  });

  it('reports a port held by something that does not answer like the guard as foreign', async () => {
    const plainPort = await freePort();
    const script = [
      "const http = require('node:http');",
      'http',
      '  .createServer((_request, response) => response.writeHead(200).end())',
      `  .listen(${plainPort}, '127.0.0.1');`,
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await probe(plainPort)).toBe('foreign');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reports a stalled listener as unknown rather than free', async () => {
    const stalledPort = await freePort();
    const sockets = new Set<Socket>();
    const stalledServer = createNetServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      stalledServer.once('error', reject);
      stalledServer.listen(stalledPort, '127.0.0.1', resolve);
    });
    try {
      await expect(
        probeMiniAppPortOwnership({
          port: stalledPort,
          timeoutMs: 10,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe('unknown');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
    }
  });
});
