// The standalone Mini App's route, on both sides of the wire.
//
// ADR 0020 gives the standalone presentation one URL — `/miniapp?plugin=&session=`
// — and it has to mean the same thing in two places: the client must resolve it to
// a document that renders only the Mini App, and the service must serve that
// document rather than a 404. A route that exists in only one of them is a deep
// link that opens a blank page, so both are asserted here.
//
// The service half runs the real `serveHttpRequest` over a real socket with a real
// temporary client directory: what is proven is the production name resolution and
// the token rule, not a stub of them.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  miniAppDeepLink,
  route,
} from "../../src/client/projection/common/router.js";
import { serveHttpRequest } from "../../src/server/http/router.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";

const TOKEN = "standalone-route-token";

describe("the client's routes", () => {
  it("resolves the standalone route and leaves the shell route alone", () => {
    expect(route("/")).toBe("archon");
    expect(route("/archon")).toBe("archon");
    expect(route("/miniapp")).toBe("miniapp");
    expect(route("/miniapp/extra")).toBe("404");
    expect(route("/nope")).toBe("404");
  });

  it("reads the plugin and the session out of a deep link", () => {
    expect(miniAppDeepLink("?token=abc&plugin=demo.miniapp&session=session-9")).toEqual({
      pluginId: "demo.miniapp",
      sessionId: "session-9",
    });
    // The leading `?` is optional, because the parser is handed `location.search`
    // on one path and a raw query on another.
    expect(miniAppDeepLink("plugin=demo.miniapp&session=session-9")).toEqual({
      pluginId: "demo.miniapp",
      sessionId: "session-9",
    });
  });

  it("refuses a link that does not name both a plugin and a session", () => {
    expect(miniAppDeepLink("")).toBeUndefined();
    expect(miniAppDeepLink("?plugin=demo.miniapp")).toBeUndefined();
    expect(miniAppDeepLink("?session=session-9")).toBeUndefined();
    expect(miniAppDeepLink("?plugin=%20&session=session-9")).toBeUndefined();
    expect(miniAppDeepLink("?plugin=demo.miniapp&session=%20")).toBeUndefined();
  });
});

interface Served {
  readonly status: number;
  readonly body: string;
}

describe("the service's standalone route", () => {
  let clientDir = "";
  let dataDir = "";
  let server: http.Server;
  let origin = "";
  let boundPort: number | undefined;

  /** One request against the real router over a real socket. */
  function get(pathname: string): Promise<Served> {
    return new Promise((resolve, reject) => {
      const request = http.request(`${origin}${pathname}`, { agent: false }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on("error", reject);
      request.end();
    });
  }

  beforeAll(async () => {
    clientDir = await mkdtemp(path.join(os.tmpdir(), "webui-standalone-client-"));
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-standalone-data-"));
    await writeFile(
      path.join(clientDir, "index.html"),
      "<!doctype html><html><head><title>webui</title></head><body><div id=\"webui-root\"></div></body></html>",
      "utf8",
    );
    server = http.createServer((request, response) => {
      void serveHttpRequest(request, response, {
        host: "127.0.0.1",
        boundTcpPort: () => boundPort,
        configuredTcpPort: 0,
        credential: { token: TOKEN },
        dev: false,
        clientDir,
        // The only thing the router reads off the harness port on this path is the
        // data directory it injects into the page configuration.
        port: { version: async () => ({ dataDir }) } as unknown as WebuiHarnessPort,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    boundPort = typeof address === "object" && address ? address.port : undefined;
    origin = `http://127.0.0.1:${boundPort}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(clientDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serves the client document for a standalone deep link", async () => {
    const served = await get(`/miniapp?token=${TOKEN}&plugin=demo.miniapp&session=session-9`);

    expect(served.status).toBe(200);
    // The same document as `/`: the standalone presentation is this client with a
    // different composition, so the runtime configuration is injected just as it
    // is for the workspace.
    expect(served.body).toContain('<div id="webui-root"></div>');
    expect(served.body).toContain("__WEBUI_CONFIG__");
    expect(served.body).toContain(TOKEN);
  });

  it("still requires the service token on that route", async () => {
    const served = await get("/miniapp?plugin=demo.miniapp&session=session-9");
    expect(served.status).toBe(401);
  });

  it("does not widen the document routes to any path", async () => {
    expect((await get(`/miniapp-extra?token=${TOKEN}`)).status).toBe(404);
  });
});
