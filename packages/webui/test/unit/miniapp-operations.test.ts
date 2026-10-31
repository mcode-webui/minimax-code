/**
 * The Mini App wire operation vertical.
 *
 * Three operations, one runtime capability, and one seam that has to stay sealed:
 * `openMiniApp` starts a Mini App through the runtime facade and answers with the
 * **proxy's** URL — the Mini App's own origin, surface path and launch credential
 * never appear in a response. The proxy itself is real here (a listener on a
 * loopback port forwarding to a real upstream `http.Server`), so "one proxy per
 * plugin" is asserted against a listener that actually binds rather than against a
 * call count alone: a second listener on the same derived port could not bind at
 * all.
 *
 * The runtime side is a scripted facade behind the harness port (evidence level
 * 3). What is *not* covered here: the runtime's own start/stop path, the
 * credential its guard installs, and an Electron/desktop consumer of `viewUrl`.
 */
import http from "node:http";
import type { Duplex } from "node:stream";

import { MINIAPP_LOOPBACK_TOKEN_HEADER } from "@mavis/shared/miniapp-surface";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import { MINIAPP_CAPABILITY_ABSENT } from "../../src/runtime/port.js";
import type { WebuiOperationPort } from "../../src/server/operation/bind-handlers.js";
import { createMiniAppHandlerEntries } from "../../src/server/operation/handlers/miniapp.js";
import {
  listMiniAppsOperation,
  openMiniAppOperation,
  stopMiniAppOperation,
  watchMiniAppPresentationOperation,
  watchMiniAppPresenterOperation,
} from "../../src/server/operation/miniapp.js";
import { createOperationRegistry } from "../../src/server/operation/operations.js";
import type { WebuiOperationRegistryEntry } from "../../src/server/operation/operation-contract.js";
import {
  deriveMiniAppProxyPort,
  startMiniAppProxy,
  type MiniAppProxy,
  type MiniAppProxyTarget,
  type StartMiniAppProxyInput,
} from "../../src/server/miniapp/proxy.js";
import { WebuiErrorCode } from "../../src/shared/envelope.js";
import { createMiniAppPresenter } from "../../src/server/miniapp/presenter.js";
import type {
  WebuiMiniAppPresentationIntent,
  WebuiMiniAppPresentationState,
  WebuiMiniAppSummary,
} from "../../src/shared/contracts/miniapp.js";

const CREDENTIAL = "miniapp-credential-0123456789";
const SECOND_CREDENTIAL = "miniapp-credential-9876543210";
const SURFACE_PATH = "/surface/dashboard";

/** One plugin id per case, so each case derives a port of its own. */
const VIEW_PLUGIN = "operation.miniapp.view";
const REPLACE_PLUGIN = "operation.miniapp.replace";
const STOP_PLUGIN = "operation.miniapp.stop";
const UNREACHABLE_PLUGIN = "operation.miniapp.unreachable";

interface Seen {
  readonly headers: http.IncomingHttpHeaders;
}

const seen: Seen[] = [];
const upgraded = new Set<Duplex>();
let upstream: http.Server;
let upstreamOrigin = "";

beforeAll(async () => {
  upstream = http.createServer((request, response) => {
    seen.push({ headers: { ...request.headers } });
    response.writeHead(200, { "content-type": "text/plain" }).end("from-upstream");
  });
  upstream.on("upgrade", (request, socket) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    seen.push({ headers: { ...request.headers } });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;
  upstreamOrigin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // An upgraded socket leaves the server's own tracking, so the fixture ends it
  // explicitly — the same teardown the proxy suite uses.
  for (const socket of upgraded) socket.destroy();
  upgraded.clear();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

interface FacadeCalls {
  readonly opened: Array<{ readonly pluginId: string; readonly signal?: AbortSignal }>;
  readonly stopped: string[];
  /** Every session id the lease asked about. */
  readonly sessions: string[];
  /** Makes the next open of this plugin answer with a fresh credential. */
  rotateCredential(pluginId: string, credential: string): void;
  /** How the session lookup answers for this id. */
  setSession(sessionId: string, answer: SessionAnswer): void;
}

/** How the scripted runtime answers `getSession`. */
type SessionAnswer = "live" | "missing" | "broken";

/**
 * The runtime side, scripted. It answers exactly what the port declares: publishable
 * rows for the catalogue, and server-only launch coordinates for an open.
 */
function createFacade(): { readonly port: WebuiOperationPort; readonly calls: FacadeCalls } {
  const opened: Array<{ pluginId: string; signal?: AbortSignal }> = [];
  const stopped: string[] = [];
  const sessions: string[] = [];
  const sessionAnswers = new Map<string, SessionAnswer>();
  const credentials = new Map<string, string>();
  const summary = (pluginId: string): WebuiMiniAppSummary => ({
    pluginId,
    displayName: "Fixture Mini App",
    runtime: { kind: "process", status: "running" },
  });
  const port = {
    async listMiniApps() {
      return { miniApps: [summary(VIEW_PLUGIN), summary(REPLACE_PLUGIN)] };
    },
    async openMiniApp(request: { pluginId: string; signal?: AbortSignal }) {
      opened.push(request);
      return {
        miniApp: summary(request.pluginId),
        launch: {
          origin: upstreamOrigin,
          surfacePath: SURFACE_PATH,
          runId: `run-${opened.length}`,
          credential: credentials.get(request.pluginId) ?? CREDENTIAL,
          credentialHeader: MINIAPP_LOOPBACK_TOKEN_HEADER,
        },
      };
    },
    async stopMiniApp(request: { pluginId: string }) {
      stopped.push(request.pluginId);
    },
    async getSession(request: { id: string }) {
      sessions.push(request.id);
      const answer = sessionAnswers.get(request.id) ?? "live";
      if (answer === "missing")
        // The runtime's own shape for a session that is not there.
        throw Object.assign(new Error(`session ${request.id} not found`), {
          status: 404,
          key: "SESSION_NOT_FOUND",
        });
      if (answer === "broken") throw new Error("harness unavailable");
      return { session: { sessionId: request.id } };
    },
  } as unknown as WebuiOperationPort;
  return {
    port,
    calls: {
      opened,
      stopped,
      sessions,
      rotateCredential: (pluginId, credential) => credentials.set(pluginId, credential),
      setSession: (sessionId, answer) => sessionAnswers.set(sessionId, answer),
    },
  };
}

type Outcome = Awaited<ReturnType<WebuiOperationRegistryEntry["handle"]>>;

function bodyOf(outcome: Outcome): unknown {
  return "body" in outcome ? outcome.body : undefined;
}

/** One handler set, invoked through the same validate → handle path the wire uses. */
function createHandlers(
  port: WebuiOperationPort,
  startProxy?: typeof startMiniAppProxy,
): (name: string, body: unknown) => Promise<unknown> {
  const entries = createMiniAppHandlerEntries(port, startProxy ? { startProxy } : {});
  return async (name, body) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`no Mini App handler for ${name}`);
    const validated = entry.operation.validate(body);
    if (!validated.ok) throw new Error(`rejected: ${validated.message}`);
    return bodyOf(await entry.handle({ requestId: `request-${name}` }, validated.body));
  };
}

interface StarterRecord {
  readonly target: MiniAppProxyTarget;
  readonly viewUrl: string;
  readonly proxy: MiniAppProxy;
  closed: boolean;
}

/**
 * The real proxy, with the lifecycle it reports made observable.
 *
 * Wrapping rather than replacing: the listener, its derived port and its
 * forwarding are the production ones, so a leak would be a real second listener
 * and not a simulated one.
 */
function countingStarter() {
  const records: StarterRecord[] = [];
  const startProxy = async (input: StartMiniAppProxyInput): Promise<MiniAppProxy> => {
    const proxy = await startMiniAppProxy(input);
    const record: StarterRecord = {
      target: input.target,
      viewUrl: proxy.viewUrl,
      proxy,
      closed: false,
    };
    records.push(record);
    return {
      port: proxy.port,
      viewUrl: proxy.viewUrl,
      async close() {
        record.closed = true;
        await proxy.close();
      },
    };
  };
  const closeAll = async () => {
    for (const record of records) {
      if (record.closed) continue;
      record.closed = true;
      await record.proxy.close();
    }
  };
  return { records, startProxy, closeAll };
}

interface Fetched {
  readonly status: number;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
}

function get(url: string): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

describe("the Mini App descriptors", () => {
  it("refuses a body on the catalogue operation", () => {
    expect(listMiniAppsOperation.validate(undefined)).toEqual({ ok: true, body: undefined });
    expect(listMiniAppsOperation.validate({})).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "listMiniApps does not accept a body",
    });
  });

  it("requires a non-empty, bounded pluginId on the two mutations", () => {
    for (const operation of [openMiniAppOperation, stopMiniAppOperation]) {
      expect(operation.validate(null)).toEqual({
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${operation.name} body must be an object`,
      });
      expect(operation.validate({})).toEqual({
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${operation.name} body requires a non-empty pluginId`,
      });
      expect(operation.validate({ pluginId: "   " })).toEqual({
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${operation.name} body requires a non-empty pluginId`,
      });
      expect(operation.validate({ pluginId: 7 })).toEqual({
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${operation.name} body requires a non-empty pluginId`,
      });
      expect(operation.validate({ pluginId: "x".repeat(201) })).toEqual({
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${operation.name} pluginId must be at most 200 characters`,
      });
      expect(operation.validate({ pluginId: " fixture.miniapp " })).toEqual({
        ok: true,
        body: { pluginId: "fixture.miniapp" },
      });
    }
  });

  it("accepts an origin-relative path on the open and refuses the rest", () => {
    expect(openMiniAppOperation.validate({ pluginId: "fixture.miniapp" })).toEqual({
      ok: true,
      body: { pluginId: "fixture.miniapp" },
    });
    expect(
      openMiniAppOperation.validate({ pluginId: "fixture.miniapp", path: "/items/42?tab=details" }),
    ).toEqual({
      ok: true,
      body: { pluginId: "fixture.miniapp", path: "/items/42?tab=details" },
    });
    // The shipped runtime's surface rules: a path that could leave the Mini App's
    // own origin, or that carries what a page never receives, is refused.
    for (const path of [
      "items/42",
      "//elsewhere.example/steal",
      "/items/42#fragment",
      "/items/42 with space",
      "/items/42%zz",
      `/${"x".repeat(4097)}`,
      7,
    ]) {
      expect(openMiniAppOperation.validate({ pluginId: "fixture.miniapp", path })).toEqual({
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "openMiniApp path must be an origin-relative path",
      });
    }
  });
});

describe("a host without the Mini App capability", () => {
  it("fails each operation with a typed refusal rather than an empty success", async () => {
    const handle = createHandlers({} as WebuiOperationPort);
    const cases: Array<[string, unknown]> = [
      ["listMiniApps", undefined],
      ["openMiniApp", { pluginId: VIEW_PLUGIN }],
      ["stopMiniApp", { pluginId: VIEW_PLUGIN }],
      ["watchMiniAppPresentation", { pluginId: VIEW_PLUGIN, sessionId: "session-1" }],
    ];
    for (const [name, body] of cases) {
      const failure = await handle(name, body).catch((error: unknown) => error);
      expect(failure, name).toBeInstanceOf(Error);
      expect((failure as Error).name, name).toBe("WebuiCapabilityUnavailableError");
      expect(
        (failure as { readonly code?: unknown }).code,
        name,
      ).toBe(WebuiErrorCode.capabilityUnavailable);
      expect((failure as Error).message, name).toBe(MINIAPP_CAPABILITY_ABSENT);
    }
  });

  it("still registers the three operations, so the refusal is not an unknown operation", () => {
    const registry = createOperationRegistry({} as WebuiOperationPort);
    for (const name of ["listMiniApps", "openMiniApp", "stopMiniApp"])
      expect(registry.has(name), name).toBe(true);
  });
});

describe("listMiniApps", () => {
  it("answers with the runtime catalogue, rows and runtime state included", async () => {
    const { port } = createFacade();
    const handle = createHandlers(port);

    expect(await handle("listMiniApps", undefined)).toEqual({
      miniApps: [
        {
          pluginId: VIEW_PLUGIN,
          displayName: "Fixture Mini App",
          runtime: { kind: "process", status: "running" },
          detached: false,
          presentationRevision: 0,
        },
        {
          pluginId: REPLACE_PLUGIN,
          displayName: "Fixture Mini App",
          runtime: { kind: "process", status: "running" },
          detached: false,
          presentationRevision: 0,
        },
      ],
    });
  });
});

describe("openMiniApp over a real loopback proxy", () => {
  it("answers with the proxy's URL and never the Mini App's own coordinates", async () => {
    const { port } = createFacade();
    const starter = countingStarter();
    const handle = createHandlers(port, starter.startProxy);
    try {
      const body = await handle("openMiniApp", { pluginId: VIEW_PLUGIN });
      const proxyPort = deriveMiniAppProxyPort(VIEW_PLUGIN);

      expect(body).toEqual({
        pluginId: VIEW_PLUGIN,
        viewUrl: `http://127.0.0.1:${proxyPort}${SURFACE_PATH}`,
        // The generation this start issued: what a page-bridge call must echo to
        // prove it is still the document being served.
        connection: 1,
      });
      expect(Object.keys(body as object).sort()).toEqual([
        "connection",
        "pluginId",
        "viewUrl",
      ]);
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain(CREDENTIAL);
      expect(serialised).not.toContain(MINIAPP_LOOPBACK_TOKEN_HEADER);
      expect(serialised).toContain(SURFACE_PATH);
      expect(serialised).not.toContain(upstreamOrigin);

      // The URL is not decorative: it serves the page, and the credential the
      // runtime issued reaches the Mini App's own guard from the proxy.
      expect(starter.records).toHaveLength(1);
      expect(starter.records[0]?.target).toEqual({
        pluginId: VIEW_PLUGIN,
        upstreamOrigin,
        surfacePath: SURFACE_PATH,
        credential: CREDENTIAL,
        credentialHeader: MINIAPP_LOOPBACK_TOKEN_HEADER,
      });
      const fetched = await get(`http://127.0.0.1:${proxyPort}/`);
      expect(fetched.status).toBe(200);
      expect(fetched.body).toBe("from-upstream");
      expect(seen.at(-1)?.headers[MINIAPP_LOOPBACK_TOKEN_HEADER]).toBe(CREDENTIAL);
      expect(fetched.headers).not.toHaveProperty(MINIAPP_LOOPBACK_TOKEN_HEADER);
    } finally {
      await handle("stopMiniApp", { pluginId: VIEW_PLUGIN }).catch(() => undefined);
      await starter.closeAll();
    }
  });

  it("keeps one listener per plugin: a second open replaces it instead of doubling it", async () => {
    const { port, calls } = createFacade();
    const starter = countingStarter();
    const handle = createHandlers(port, starter.startProxy);
    const proxyPort = deriveMiniAppProxyPort(REPLACE_PLUGIN);
    try {
      const first = await handle("openMiniApp", { pluginId: REPLACE_PLUGIN });
      calls.rotateCredential(REPLACE_PLUGIN, SECOND_CREDENTIAL);
      const second = await handle("openMiniApp", { pluginId: REPLACE_PLUGIN });

      // Two opens, two starts, and the second bound the same derived port — which
      // it could not have done had the first listener still been listening.
      expect(calls.opened).toHaveLength(2);
      expect(starter.records).toHaveLength(2);
      expect(starter.records[0]?.closed).toBe(true);
      expect(starter.records[1]?.closed).toBe(false);
      // The answer is the same presentation, opened again: same plugin and URL,
      // and a generation that advanced because a new document is being served.
      const openedFirst = first as {
        readonly pluginId: string;
        readonly viewUrl: string;
        readonly connection: number;
      };
      const openedSecond = second as typeof openedFirst;
      const { connection: firstConnection, ...firstShape } = openedFirst;
      const { connection: secondConnection, ...secondShape } = openedSecond;
      expect(firstShape).toEqual(secondShape);
      expect(secondConnection).toBe(firstConnection + 1);
      expect((second as { readonly viewUrl: string }).viewUrl).toBe(
        `http://127.0.0.1:${proxyPort}${SURFACE_PATH}`,
      );

      // The live listener is the replacement: it injects the credential the second
      // launch issued, not the one the closed proxy was built with.
      await get(`http://127.0.0.1:${proxyPort}/`);
      expect(seen.at(-1)?.headers[MINIAPP_LOOPBACK_TOKEN_HEADER]).toBe(SECOND_CREDENTIAL);
    } finally {
      await handle("stopMiniApp", { pluginId: REPLACE_PLUGIN }).catch(() => undefined);
      await starter.closeAll();
    }
  });

  it("serialises two opens for one plugin instead of racing them onto one port", async () => {
    const { port, calls } = createFacade();
    const starter = countingStarter();
    const handle = createHandlers(port, starter.startProxy);
    try {
      const bodies = await Promise.all([
        handle("openMiniApp", { pluginId: UNREACHABLE_PLUGIN }),
        handle("openMiniApp", { pluginId: UNREACHABLE_PLUGIN }),
      ]);

      expect(calls.opened).toHaveLength(2);
      expect(starter.records).toHaveLength(2);
      expect(starter.records[0]?.closed).toBe(true);
      expect(starter.records.filter((record) => !record.closed)).toHaveLength(1);
      // Serialised, not raced: one presentation at a time, so the second call's
      // generation is the first one's plus one rather than the same answer twice.
      const openedFirst = bodies[0] as {
        readonly pluginId: string;
        readonly viewUrl: string;
        readonly connection: number;
      };
      const openedSecond = bodies[1] as typeof openedFirst;
      const { connection: firstConnection, ...firstShape } = openedFirst;
      const { connection: secondConnection, ...secondShape } = openedSecond;
      expect(firstShape).toEqual(secondShape);
      expect(secondConnection).toBe(firstConnection + 1);
      expect(calls.stopped).toEqual([]);
    } finally {
      await handle("stopMiniApp", { pluginId: UNREACHABLE_PLUGIN }).catch(() => undefined);
      await starter.closeAll();
    }
  });

  it("stops the runtime it started when its proxy cannot be bound", async () => {
    const { port, calls } = createFacade();
    const handle = createHandlers(port, async () => {
      throw new Error("loopback port is already in use");
    });

    await expect(handle("openMiniApp", { pluginId: STOP_PLUGIN })).rejects.toThrow(
      "loopback port is already in use",
    );
    expect(calls.stopped).toEqual([STOP_PLUGIN]);
  });
});

describe("stopMiniApp", () => {
  it("stops the runtime, closes that plugin's proxy and leaves no listener behind", async () => {
    const { port, calls } = createFacade();
    const starter = countingStarter();
    const handle = createHandlers(port, starter.startProxy);
    const proxyPort = deriveMiniAppProxyPort(STOP_PLUGIN);
    try {
      const opened = await handle("openMiniApp", { pluginId: STOP_PLUGIN });
      expect((opened as { readonly viewUrl: string }).viewUrl).toBe(
        `http://127.0.0.1:${proxyPort}${SURFACE_PATH}`,
      );
      expect((await get(`http://127.0.0.1:${proxyPort}/`)).status).toBe(200);

      expect(await handle("stopMiniApp", { pluginId: STOP_PLUGIN })).toEqual({ success: true });
      expect(calls.stopped).toEqual([STOP_PLUGIN]);
      expect(starter.records[0]?.closed).toBe(true);
      await expect(get(`http://127.0.0.1:${proxyPort}/`)).rejects.toThrow();

      // A stop for a plugin that is not running is still a stop: the runtime is
      // asked, and there is no listener to close.
      expect(await handle("stopMiniApp", { pluginId: STOP_PLUGIN })).toEqual({ success: true });
      expect(calls.stopped).toEqual([STOP_PLUGIN, STOP_PLUGIN]);
    } finally {
      await starter.closeAll();
    }
  });
});

describe("the runtime adapter behind the port", () => {
  const runtimeSummary = {
    pluginId: "fixture.miniapp",
    displayName: "Fixture Mini App",
    runtime: { kind: "process", status: "running" },
    // Not part of the publishable row; must not survive the conversion.
    launch: { credential: CREDENTIAL },
  };

  function scriptedHost() {
    const calls: string[] = [];
    const host = {
      apiHost: { close: async () => {} },
      cliService: {
        listMiniApps: async () => {
          calls.push("listMiniApps");
          return { miniApps: [runtimeSummary] };
        },
        openMiniApp: async (request: { pluginId: string; signal?: AbortSignal }) => {
          calls.push(`openMiniApp:${request.pluginId}`);
          return {
            miniApp: runtimeSummary,
            launch: {
              origin: upstreamOrigin,
              surfacePath: SURFACE_PATH,
              runId: "run-1",
              credential: CREDENTIAL,
            },
          };
        },
        stopMiniApp: async (request: { pluginId: string }) => {
          calls.push(`stopMiniApp:${request.pluginId}`);
        },
      } as never,
    };
    return { port: createHarnessPortFromHost(host), calls };
  }

  it("publishes the catalogue row without the fields the wire does not carry", async () => {
    const { port } = scriptedHost();

    const list = await port.listMiniApps!();

    expect(list).toEqual({
      miniApps: [
        {
          pluginId: "fixture.miniapp",
          displayName: "Fixture Mini App",
          runtime: { kind: "process", status: "running" },
        },
      ],
    });
    expect(JSON.stringify(list)).not.toContain(CREDENTIAL);
  });

  it("hands the launch over with the credential and the header its guard reads", async () => {
    const { port, calls } = scriptedHost();

    const launch = await port.openMiniApp!({ pluginId: "fixture.miniapp" });

    expect(calls).toEqual(["openMiniApp:fixture.miniapp"]);
    expect(launch).toEqual({
      miniApp: {
        pluginId: "fixture.miniapp",
        displayName: "Fixture Mini App",
        runtime: { kind: "process", status: "running" },
      },
      launch: {
        origin: upstreamOrigin,
        surfacePath: SURFACE_PATH,
        runId: "run-1",
        credential: CREDENTIAL,
        credentialHeader: MINIAPP_LOOPBACK_TOKEN_HEADER,
      },
    });
  });

  it("forwards a stop", async () => {
    const { port, calls } = scriptedHost();

    await expect(port.stopMiniApp!({ pluginId: "fixture.miniapp" })).resolves.toBeUndefined();
    expect(calls).toEqual(["stopMiniApp:fixture.miniapp"]);
  });

  it("refuses when the runtime's facade has no Mini App cell", async () => {
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: {} as never,
    });

    for (const call of [
      () => port.listMiniApps!(),
      () => port.openMiniApp!({ pluginId: "fixture.miniapp" }),
      () => port.stopMiniApp!({ pluginId: "fixture.miniapp" }),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect((failure as { readonly code?: unknown }).code).toBe(
        WebuiErrorCode.capabilityUnavailable,
      );
      expect((failure as Error).message).toBe(MINIAPP_CAPABILITY_ABSENT);
    }
  });
});

/**
 * The standalone presentation lease over the wire.
 *
 * ADR 0020 ties the record to the standalone document's connection, so the two
 * things to prove are that the stream holds it (and that the catalogue says so
 * while it does) and that the stream ending is what releases it. The session half
 * is the ticket's other criterion: an ended session is reported beside a page that
 * keeps rendering, and a lookup that merely failed is a failure rather than an
 * ended session.
 */
describe("watchMiniAppPresentation", () => {
  // The scripted catalogue lists two plugins; a lease case needs one of them, so
  // the row it reads back is a row the listing actually carries.
  const LEASE_PLUGIN = VIEW_PLUGIN;
  const SESSION = "session-lease";

  interface LeaseStream {
    readonly frames: AsyncIterator<WebuiMiniAppPresentationState>;
  }

  /**
   * One handler set per case.
   *
   * Essential rather than tidy: the lease record lives in the handler closure, so
   * a second set would answer the catalogue from a record the stream never wrote
   * to — and the "detached reflects the live presentation" assertion would then
   * pass or fail for the wrong reason.
   */
  function createLeaseHarness(port: WebuiOperationPort) {
    const entries = createMiniAppHandlerEntries(port);
    const handle = async (name: string, body: unknown): Promise<unknown> => {
      const entry = entries.get(name);
      if (!entry) throw new Error(`no Mini App handler for ${name}`);
      const validated = entry.operation.validate(body);
      if (!validated.ok) throw new Error(validated.message);
      return bodyOf(await entry.handle({ requestId: `request-${name}` }, validated.body));
    };
    /** Invoke the stream operation the way the dispatcher does, and keep its source. */
    const openLease = async (
      body: { readonly pluginId: string; readonly sessionId: string },
      signal?: AbortSignal,
    ): Promise<LeaseStream> => {
      const entry = entries.get(watchMiniAppPresentationOperation.name);
      if (!entry) throw new Error("watchMiniAppPresentation is not registered");
      const validated = entry.operation.validate(body);
      if (!validated.ok) throw new Error(validated.message);
      const result = await entry.handle(
        { requestId: "lease", ...(signal ? { signal } : {}) },
        validated.body,
      );
      if (!("stream" in result) || !result.stream.ok) throw new Error("expected a stream");
      const source = result.stream.source as AsyncIterable<WebuiMiniAppPresentationState>;
      return { frames: source[Symbol.asyncIterator]() };
    };
    return { handle, openLease };
  }

  it("registers the lease beside the other three, so it is not an unknown operation", () => {
    const registry = createOperationRegistry({} as WebuiOperationPort);
    expect(registry.has(watchMiniAppPresentationOperation.name)).toBe(true);
  });

  it("holds the lease while the stream is open, and the catalogue says so", async () => {
    const { port, calls } = createFacade();
    const { handle, openLease } = createLeaseHarness(port);
    const controller = new AbortController();
    const lease = await openLease(
      { pluginId: LEASE_PLUGIN, sessionId: SESSION },
      controller.signal,
    );

    const first = await lease.frames.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      pluginId: LEASE_PLUGIN,
      sessionId: SESSION,
      presentationRevision: 1,
      session: "live",
    });
    expect(calls.sessions).toEqual([SESSION]);

    // `detached` is the live record, not a constant: it is true now.
    const listed = (await handle("listMiniApps", undefined)) as {
      miniApps: ReadonlyArray<{ pluginId: string; detached: boolean; presentationRevision: number }>;
    };
    const row = listed.miniApps.find((candidate) => candidate.pluginId === LEASE_PLUGIN);
    expect(row).toMatchObject({ detached: true, presentationRevision: 1 });

    // A second frame never arrives on its own: the stream is the lease, not a feed.
    const parked = await Promise.race([
      lease.frames.next().then(() => "settled" as const),
      new Promise<"parked">((resolve) => setTimeout(() => resolve("parked"), 20)),
    ]);
    expect(parked).toBe("parked");

    // The connection going away is the release.
    controller.abort();
    await lease.frames.next().catch(() => undefined);
    const afterClose = (await handle("listMiniApps", undefined)) as {
      miniApps: ReadonlyArray<{ pluginId: string; detached: boolean; presentationRevision: number }>;
    };
    expect(afterClose.miniApps.find((candidate) => candidate.pluginId === LEASE_PLUGIN)).toMatchObject(
      // The revision stays where it was: it counts acquisitions, it is not a flag.
      { detached: false, presentationRevision: 1 },
    );
  });

  it("moves the revision on each acquisition the inline view can read", async () => {
    const { port } = createFacade();
    const { handle, openLease } = createLeaseHarness(port);
    const first = new AbortController();
    const reopened = await openLease(
      { pluginId: LEASE_PLUGIN, sessionId: SESSION },
      first.signal,
    );
    expect((await reopened.frames.next()).value).toMatchObject({ presentationRevision: 1 });
    first.abort();
    await reopened.frames.next().catch(() => undefined);

    const second = new AbortController();
    const again = await openLease(
      { pluginId: LEASE_PLUGIN, sessionId: SESSION },
      second.signal,
    );
    expect((await again.frames.next()).value).toMatchObject({ presentationRevision: 2 });

    const listed = (await handle("listMiniApps", undefined)) as {
      miniApps: ReadonlyArray<{ pluginId: string; detached: boolean; presentationRevision: number }>;
    };
    expect(listed.miniApps.find((candidate) => candidate.pluginId === LEASE_PLUGIN)).toMatchObject({
      detached: true,
      presentationRevision: 2,
    });
    second.abort();
    await again.frames.next().catch(() => undefined);
  });

  it("reports a session the runtime no longer has, and keeps the page's lease", async () => {
    const { port, calls } = createFacade();
    const { openLease } = createLeaseHarness(port);
    calls.setSession(SESSION, "missing");
    const controller = new AbortController();
    const lease = await openLease({ pluginId: LEASE_PLUGIN, sessionId: SESSION }, controller.signal);

    const frame = await lease.frames.next();
    // Reported, not enforced: the Mini App is plugin-scoped, so the lease is taken
    // exactly as it would be for a live session and the view keeps rendering.
    expect(frame.value).toMatchObject({ session: "ended", presentationRevision: 1 });

    controller.abort();
    await lease.frames.next().catch(() => undefined);
  });

  it("keeps the presentation lease when session lookup cannot confirm a live or ended session", async () => {
    const { port, calls } = createFacade();
    const { handle, openLease } = createLeaseHarness(port);
    calls.setSession(SESSION, "broken");
    const controller = new AbortController();

    const lease = await openLease(
      { pluginId: LEASE_PLUGIN, sessionId: SESSION },
      controller.signal,
    );
    const frame = await lease.frames.next();

    // Lookup is observational: keep the app presentation alive without claiming
    // the session ended. The lease prevents another document opening a duplicate.
    expect(frame.value).toMatchObject({ session: "unresolved", presentationRevision: 1 });
    const listed = (await handle("listMiniApps", undefined)) as {
      miniApps: ReadonlyArray<{ pluginId: string; detached: boolean; presentationRevision: number }>;
    };
    expect(
      listed.miniApps.find((candidate) => candidate.pluginId === LEASE_PLUGIN),
    ).toMatchObject({ detached: true, presentationRevision: 1 });
    controller.abort();
    await lease.frames.next().catch(() => undefined);
  });
});

describe("watchMiniAppPresenter", () => {
  it("replays the active request and streams later close events until disconnected", async () => {
    const presenter = createMiniAppPresenter({});
    await presenter.presenter.open({ sessionId: "session-presenter", pluginId: "agent.app" });
    const entries = createMiniAppHandlerEntries({} as WebuiOperationPort, { presenter });
    const entry = entries.get(watchMiniAppPresenterOperation.name);
    if (!entry) throw new Error("watchMiniAppPresenter is not registered");
    const controller = new AbortController();
    const result = await entry.handle({ requestId: "presenter", signal: controller.signal }, undefined);
    if (!("stream" in result) || !result.stream.ok) throw new Error("expected a presenter stream");
    const frames = (result.stream.source as AsyncIterable<WebuiMiniAppPresentationIntent>)[Symbol.asyncIterator]();

    expect(await frames.next()).toEqual({
      done: false,
      value: {
        epoch: expect.any(String),
        revision: 1,
        action: "open",
        sessionId: "session-presenter",
        pluginId: "agent.app",
      },
    });
    await presenter.presenter.close({ pluginId: "agent.app" });
    expect(await frames.next()).toEqual({
      done: false,
      value: {
        epoch: (presenter.snapshot() as WebuiMiniAppPresentationIntent).epoch,
        revision: 2,
        action: "close",
        sessionId: "session-presenter",
        pluginId: "agent.app",
      },
    });
    controller.abort();
    expect(await frames.next()).toMatchObject({ done: true });
  });
});
