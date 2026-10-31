// The harness the real Mini App gates share.
//
// One real host, one real install, one real client — booted once per case and
// torn down with it. The two gate files use this so that the wire-level flow
// and the browser-level flow drive the same product, not two lookalikes.
//
// Nothing here is a stand-in: the host is the production assembly, the install
// is the product's own file move, the operations are the real ones, and the
// Mini App that starts is a real child process serving a real page.

import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import { createWebuiRuntimeHost } from "../../src/runtime/assembly.js";
import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import { WebuiTerminalManager } from "../../src/runtime/index.js";
import { WebuiService, createOperationRegistry } from "../../src/server/index.js";
import { createMiniAppProxyRegistry } from "../../src/server/miniapp/proxy-registry.js";
import { WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";
import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";

export const CREDENTIAL_TOKEN = "miniapp-real-flow-token";

/** The local plugin source, as the wire carries it. */
export const LOCAL_SOURCE = 2;

/** The marker the Mini App's own page carries, so a read back cannot be anything else. */
export const PAGE_MARKER = "miniapp-real-flow-page";

/** A one-pixel PNG, so the manifest's icon path names a real file. */
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface Booted {
  readonly service: WebuiService;
  readonly url: string;
  readonly tcpPort: number;
  readonly dataDir: string;
  readonly port: ReturnType<typeof createHarnessPortFromHost>;
  readonly proxies: ReturnType<typeof createMiniAppProxyRegistry>;
  close(): Promise<void>;
}

const booted: Booted[] = [];
const previousDataDir = process.env.MINIMAX_DATA_DIR;

/** Releases every host this module booted. */
export async function closeAllBootedHosts(): Promise<void> {
  for (const entry of booted.splice(0)) await entry.close();
  if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = previousDataDir;
}

/**
 * The production wiring of `scripts/run-webui-server.mjs`, with two deliberate
 * differences: the data directory is temporary, and `mcodeTools.prepare` is
 * stubbed — mcode-tools is a side capability the harness acquires alongside
 * the host, not part of the request path under test.
 */
export async function bootRealHost(
  options: { readonly dev?: boolean; readonly serveBuiltClient?: boolean } = {},
): Promise<Booted> {
  // The host's unix socket path is built from this directory: the plugin's
  // own data directory sits under it, and the socket file under that. A unix
  // socket path may not exceed 104 characters, and the macOS runner's
  // temporary directory alone is 44 characters deep, so a fixture directory
  // under it leaves too little room for the rest of the path. On the
  // platforms that use a unix socket the fixture therefore lives directly
  // under /tmp; Windows uses a named pipe and keeps the temporary directory.
  const dataDir = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "webui-mf-"),
  );
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  // A config file that already exists stops `ensureConfigFile()` from copying the
  // operator's own config — and therefore their provider entries — into this run.
  await writeFile(
    join(dataDir, "config.yaml"),
    "# webui miniapp-real-flow fixture — no provider entry, no credential.\n",
    { mode: 0o600 },
  );
  process.env.MINIMAX_DATA_DIR = dataDir;
  (await import("@mavis/config")).resetConfig();

  const assembled = await createWebuiRuntimeHost({
    dataDir,
    appVersion: "miniapp-real-flow",
    mcodeTools: {
      prepare: async () => ({
        requested: false,
        ready: false,
        category: "disabled" as const,
        ensureCommandPath: () => undefined,
        dispose: async () => undefined,
      }),
    },
  });
  const port = createHarnessPortFromHost(assembled.host);
  const terminal = new WebuiTerminalManager();
  const proxies = createMiniAppProxyRegistry();
  const service = new WebuiService({
    port,
    operations: createOperationRegistry(port, terminal, undefined, undefined, proxies),
    terminal,
    tcpPort: 0,
    credential: { token: CREDENTIAL_TOKEN },
    ...(options.dev ? { dev: true } : {}),
    ...(options.serveBuiltClient ? { clientDir: join(process.cwd(), "dist-webui/client") } : {}),
  });
  const info = await service.start();
  const entry: Booted = {
    service,
    url: `ws://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}`,
    tcpPort: info.tcpPort,
    dataDir,
    port,
    proxies,
    close: async () => {
      await service.close().catch(() => undefined);
      await proxies.closeAll().catch(() => undefined);
      await assembled.host.apiHost.close().catch(() => undefined);
      await removeRealHostDataDir(dataDir);
    },
  };
  booted.push(entry);
  return entry;
}

export interface Client {
  call(operation: string, body?: unknown): Promise<Record<string, unknown>>;
  close(): void;
}

/** The real `ws` client behind the wire's socket interface. */
export function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  ws.on("error", () => undefined);
  let counter = 0;
  const call = (operation: string, body?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = `r${(counter += 1)}`;
      const onMessage = (raw: RawData) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch (error) {
          reject(error);
          return;
        }
        if (frame.requestId !== requestId) return;
        ws.off("message", onMessage);
        resolve(frame);
      };
      ws.on("message", onMessage);
      const frame: Record<string, unknown> = {
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        operation,
      };
      if (body !== undefined) frame.body = body;
      ws.send(JSON.stringify(frame));
    });
  return new Promise((resolve) => {
    ws.addEventListener("open", () => {
      resolve({
        call,
        close: () => ws.close(),
      });
    });
  });
}

/**
 * The Mini App package these gates install.
 *
 * The manifest is the shape the shipped reader accepts: a MiniMax plugin
 * manifest, a package declaration pointing at the Mini App manifest, the Mini
 * App manifest itself, and the two payload roots it names.
 */
export async function writeMiniAppPackage(
  root: string,
  options: { readonly name: string; readonly entry?: string; readonly broken?: boolean },
): Promise<void> {
  const entry = options.entry ?? "server.js";
  await mkdir(join(root, ".minimax-plugin"), { recursive: true });
  await mkdir(join(root, "miniapp", "client"), { recursive: true });
  await mkdir(join(root, "miniapp", "node"), { recursive: true });
  await writeFile(
    join(root, ".minimax-plugin", "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: options.name,
      version: "0.0.0",
      description: "A Mini App the real-flow gate installs.",
      author: "webui-gate",
      category: "Other",
      icon: "icon.png",
      // The capability lists the manifest requires, empty because this package
      // contributes a Mini App and nothing else.
      exampleQueries: [],
      apps: [],
      mcpServers: [],
      skills: [],
    }),
  );
  await writeFile(join(root, "icon.png"), ICON_PNG);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.0.0",
      mcode: { schemaVersion: 2, miniApp: "./miniapp/miniapp.json" },
    }),
  );
  await writeFile(
    join(root, "miniapp", "miniapp.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifacts: { client: ["./miniapp/client"], node: ["./miniapp/node"] },
      runtime: { kind: "process", entry: `./miniapp/node/${entry}` },
      surface: { path: "/dashboard" },
    }),
  );
  await writeFile(
    join(root, "miniapp", "client", "index.html"),
    `<!doctype html><title>${PAGE_MARKER}</title><p id="marker">${PAGE_MARKER}</p>\n`,
  );
  await writeFile(
    join(root, "miniapp", "node", entry),
    [
      "import { createServer } from 'node:http';",
      "",
      options.broken ? "throw new Error('the Mini App entry refused to start');" : "",
      "// The page is embedded rather than read from the package: the runner runs the",
      "// node artifact, and the artifact layout around it is the runtime's business.",
      `const page = '<!doctype html><title>${PAGE_MARKER}</title><p id="marker">${PAGE_MARKER}</p>';`,
      "",
      "export const start = async (context) => {",
      "  const server = createServer((request, response) => {",
      "    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
      "    response.end(page);",
      "  });",
      "  await new Promise((resolve) => server.listen(context.listen.port, context.listen.host, resolve));",
      "  return { async dispose() { await new Promise((resolve) => server.close(resolve)); } };",
      "};",
      "",
    ].join("\n"),
  );
}

/**
 * Publishes a package the way the real importer does: out of the import staging
 * area, into the local plugin root, in one move.
 */
export async function publishLocalPackage(
  dataDir: string,
  name: string,
  options: { readonly entry?: string; readonly broken?: boolean } = {},
): Promise<void> {
  const stagingParent = join(dataDir, "v2", "plugin-import");
  await mkdir(stagingParent, { recursive: true });
  const stagingRoot = join(stagingParent, `staged-${name}-${Date.now()}`);
  await writeMiniAppPackage(stagingRoot, { name, ...options });
  const pluginsRoot = join(dataDir, "plugins");
  await mkdir(pluginsRoot, { recursive: true });
  await rename(stagingRoot, join(pluginsRoot, name));
}

/** The body of a successful response, or the refusal that replaced it. */
export function bodyOf(frame: Record<string, unknown>): Record<string, unknown> {
  const body = frame.body as Record<string, unknown> | undefined;
  return body ?? {};
}

/** The catalogue rows a `listMiniApps` answer carries. */
/** The runtime state a catalogue row reports, when it reports one. */
export function runtimeStatusOf(
  row: Record<string, unknown> | undefined,
): string | undefined {
  const runtime = row?.runtime as { readonly status?: unknown } | undefined;
  return typeof runtime?.status === "string" ? runtime.status : undefined;
}

export function rowsOf(frame: Record<string, unknown>): Record<string, unknown>[] {
  const miniApps = bodyOf(frame).miniApps;
  return Array.isArray(miniApps) ? (miniApps as Record<string, unknown>[]) : [];
}

/**
 * Asserts that a call was answered, and says what the answer was when it was
 * not: a refusal that names its code is the gate's evidence, so the frame goes
 * into the failure message rather than only its kind.
 */
export function expectAnswered(frame: Record<string, unknown>): Record<string, unknown> {
  expect(frame.kind, `the operation answered ${JSON.stringify(frame)}`).toBe("response");
  return frame;
}

/** Waits for a read to produce a value, or fails naming what it waited for. */
export async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The runtime's own reason behind a refused open, as a chain of codes.
 *
 * The wire answers with a code and a message; the reason behind them lives in
 * the runtime, and a gate that cannot reach it cannot report it either.
 */
export async function openCause(
  host: Booted,
  pluginId: string,
): Promise<readonly string[]> {
  try {
    await host.port.openMiniApp?.({ pluginId });
  } catch (error) {
    const chain: string[] = [];
    let cause = error as
      | {
          readonly code?: string;
          readonly name?: string;
          readonly message?: string;
          readonly cause?: unknown;
        }
      | undefined;
    for (let depth = 0; cause && depth < 6; depth += 1) {
      chain.push(`${cause.code ?? cause.name ?? "?"}: ${cause.message ?? ""}`);
      cause = cause.cause as typeof cause;
    }
    return chain;
  }
  return [];
}
