import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import type { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deriveMiniAppProxyPort,
  startMiniAppProxy,
  type MiniAppProxy,
} from '../../src/server/miniapp/proxy.js';

const CREDENTIAL = 'upstream-credential-0123456789';
const CREDENTIAL_HEADER = 'x-mavis-miniapp-token';

interface Seen {
  readonly method?: string;
  readonly url?: string;
  readonly headers: http.IncomingHttpHeaders;
}

const seen: Seen[] = [];
const upgraded = new Set<Duplex>();
let upstream: http.Server;
let upstreamPort = 0;
let proxy: MiniAppProxy;

beforeAll(async () => {
  upstream = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    if (request.url?.startsWith('/page')) {
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
        })
        .end('<!doctype html><html><head><title>app</title></head><body>page</body></html>');
      return;
    }
    if (request.url === '/compressed') {
      const body = gzipSync('<!doctype html><html><head></head><body>compressed</body></html>');
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
          'content-length': body.byteLength,
        })
        .end(body);
      return;
    }
    if (request.url === '/bare') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<p>no head here</p>');
      return;
    }
    if (request.url === '/echo') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('from-upstream');
      return;
    }
    response.writeHead(404).end();
  });
  upstream.on('upgrade', (request, socket) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    seen.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  upstreamPort = typeof address === 'object' && address ? address.port : 0;

  proxy = await startMiniAppProxy({
    target: {
      pluginId: 'fixture.miniapp',
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      surfacePath: '/page?mode=dashboard',
      credential: CREDENTIAL,
      credentialHeader: CREDENTIAL_HEADER,
    },
    port: 0,
    bridge: { path: '/__miniapp/bridge.js', script: 'globalThis.__bridge = true;' },
  });
});

afterAll(async () => {
  await proxy?.close();
  // An upgraded socket leaves the server's own tracking, so the fixture ends it explicitly.
  for (const socket of upgraded) socket.destroy();
  upgraded.clear();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

interface Result {
  readonly status: number;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
}

function get(port: number, path: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'GET', path, agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('Mini App proxy', () => {
  it('returns the runtime-selected surface path as the framed URL', () => {
    expect(proxy.viewUrl).toBe(`http://127.0.0.1:${proxy.port}/page?mode=dashboard`);
  });

  it('forwards the selected surface path with its query unchanged', async () => {
    const result = await get(proxy.port, '/page?mode=dashboard');

    expect(result.status).toBe(200);
    expect(seen.at(-1)?.url).toBe('/page?mode=dashboard');
  });
  it('forwards the path unchanged and returns the upstream response', async () => {
    const result = await get(proxy.port, '/echo');

    expect(result.status).toBe(200);
    expect(result.body).toBe('from-upstream');
    expect(seen.at(-1)?.url).toBe('/echo');
    expect(seen.at(-1)?.method).toBe('GET');
  });

  it('injects the credential outbound and never returns it to the caller', async () => {
    const result = await get(proxy.port, '/echo');

    expect(seen.at(-1)?.headers[CREDENTIAL_HEADER]).toBe(CREDENTIAL);
    expect(seen.at(-1)?.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    expect(result.headers).not.toHaveProperty(CREDENTIAL_HEADER);
  });

  it('rewrites a compressed HTML document after decoding it', async () => {
    const result = await get(proxy.port, '/compressed');

    expect(result.status).toBe(200);
    expect(result.headers).not.toHaveProperty('content-encoding');
    expect(result.body).toContain('<script src="/__miniapp/bridge.js"></script></head>');
    expect(result.body).toContain('compressed');
  });

  it('forwards an upgrade with the credential', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: proxy.port });
      let received = '';
      socket.once('connect', () => {
        socket.write(
          `GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
      });
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
        socket.destroy();
        resolve(received);
      });
      socket.once('error', reject);
      socket.setTimeout(2_000, () => {
        socket.destroy();
        reject(new Error('upgrade timed out'));
      });
    });

    expect(response).toContain('101');
    expect(seen.at(-1)?.url).toBe('/socket');
    expect(seen.at(-1)?.headers[CREDENTIAL_HEADER]).toBe(CREDENTIAL);
    expect(seen.at(-1)?.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it('keeps one plugin on the same port across a restart, so the page storage survives', async () => {
    const derived = deriveMiniAppProxyPort('fixture.miniapp');
    const target = {
      pluginId: 'fixture.miniapp',
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      surfacePath: '/page?mode=dashboard',
      credential: CREDENTIAL,
      credentialHeader: CREDENTIAL_HEADER,
    };

    const first = await startMiniAppProxy({ target, port: derived });
    const firstUrl = first.viewUrl;
    await first.close();

    const second = await startMiniAppProxy({ target, port: deriveMiniAppProxyPort('fixture.miniapp') });
    try {
      expect(second.viewUrl).toBe(firstUrl);
      expect(second.port).toBe(derived);
    } finally {
      await second.close();
    }
  });

  it('derives a stable loopback port per plugin', () => {
    const first = deriveMiniAppProxyPort('fixture.miniapp');

    expect(first).toBe(deriveMiniAppProxyPort('fixture.miniapp'));
    expect(first).toBeGreaterThanOrEqual(49_152);
    expect(first).toBeLessThanOrEqual(65_535);
    expect(deriveMiniAppProxyPort('another.miniapp')).not.toBe(first);
  });
});

describe('Mini App proxy document rewrite', () => {
  it('injects the bridge before the document head ends', async () => {
    const result = await get(proxy.port, '/page');

    expect(result.status).toBe(200);
    expect(result.body).toContain('<script src="/__miniapp/bridge.js"></script></head>');
    expect(result.body).toContain('<title>app</title>');
  });

  it('makes the document framable: drops X-Frame-Options and the frame-ancestors directive', async () => {
    const result = await get(proxy.port, '/page');

    expect(result.headers).not.toHaveProperty('x-frame-options');
    expect(result.headers['content-security-policy']).toBe("default-src 'self'; script-src 'self'");
  });

  it('injects before the body when the document has no head', async () => {
    const result = await get(proxy.port, '/bare');

    expect(result.body).toBe('<script src="/__miniapp/bridge.js"></script><p>no head here</p>');
  });

  it('serves the bridge itself and never forwards that path upstream', async () => {
    const before = seen.length;
    const result = await get(proxy.port, '/__miniapp/bridge.js');

    expect(result.status).toBe(200);
    expect(result.body).toBe('globalThis.__bridge = true;');
    expect(result.headers['content-type']).toContain('text/javascript');
    expect(seen.length).toBe(before);
  });

  it('serves the bridge when the browser appends a cache-busting query', async () => {
    const before = seen.length;
    const result = await get(proxy.port, '/__miniapp/bridge.js?v=1');

    expect(result.status).toBe(200);
    expect(result.body).toBe('globalThis.__bridge = true;');
    expect(seen.length).toBe(before);
  });
});

describe('Mini App proxy with an Agent-named path', () => {
  it('frames the path the Agent named instead of the declared surface', async () => {
    const named = await startMiniAppProxy({
      target: {
        pluginId: 'fixture.path.miniapp',
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        surfacePath: '/page?mode=dashboard',
        path: '/items/42?tab=details',
        credential: CREDENTIAL,
        credentialHeader: CREDENTIAL_HEADER,
      },
      port: 0,
    });

    try {
      expect(named.viewUrl).toContain('/items/42?tab=details');
      expect(named.viewUrl).not.toContain('/page');
    } finally {
      await named.close();
    }
  });

  it('frames the declared surface when the Agent named no path', async () => {
    const plain = await startMiniAppProxy({
      target: {
        pluginId: 'fixture.surface.miniapp',
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        surfacePath: '/page?mode=dashboard',
        credential: CREDENTIAL,
        credentialHeader: CREDENTIAL_HEADER,
      },
      port: 0,
    });

    try {
      expect(plain.viewUrl).toContain('/page?mode=dashboard');
    } finally {
      await plain.close();
    }
  });

  it('refuses a path that could leave the Mini App origin', async () => {
    await expect(
      startMiniAppProxy({
        target: {
          pluginId: 'fixture.bad.miniapp',
          upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
          surfacePath: '/page',
          path: '//elsewhere.example/steal',
          credential: CREDENTIAL,
          credentialHeader: CREDENTIAL_HEADER,
        },
        port: 0,
      }),
    ).rejects.toThrow(/origin-relative path/);
  });
});
