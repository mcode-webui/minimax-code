import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeDirectoryRoute, validateNativeDirectory } from "../../src/server/http/native-directory.js";
import { captureNativeDirectoryLaunchGrant, pickNativeWorkspaceDirectory } from "../../src/client/platform/native-directory-picker.js";

const grant = "11111111-2222-3333-4444-555555555555";
const context = { host: "127.0.0.1", port: 2233, credential: { token: "test-token" }, fullAccess: false };
function request(headers: Record<string, string> = {}, address = "127.0.0.1") {
  return Object.assign(new EventEmitter(), { headers: {
    host: "127.0.0.1:2233", origin: "http://127.0.0.1:2233", "sec-fetch-site": "same-origin",
    "x-webui-native-grant": grant, "x-webui-token": "test-token", ...headers,
  }, socket: { remoteAddress: address } }) as unknown as IncomingMessage;
}
function response() {
  const value = Object.assign(new EventEmitter(), {
    statusCode: 200, body: "", destroyed: false, writableEnded: false,
    setHeader: vi.fn(), writeHead(status: number) { this.statusCode = status; }, end(body: string) { this.body = body; this.writableEnded = true; },
  });
  return value;
}
const asResponse = (value: ReturnType<typeof response>) => value as unknown as ServerResponse;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native directory HTTP desktop capability", () => {
  it("bounds returned-directory inspection without blocking on an unavailable share", async () => {
    const inspect = vi.fn(() => new Promise<{ isDirectory(): boolean }>(() => {}));
    expect(await validateNativeDirectory(tmpdir(), 5, inspect)).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(await validateNativeDirectory("relative", 5, inspect)).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(await validateNativeDirectory(tmpdir(), 5, async () => ({ isDirectory: () => false }))).toBe(false);
  });
  it("serves a real authenticated loopback POST without query credentials", async () => {
    const choose = vi.fn(async () => ({ kind: "selected" as const, directory: tmpdir() }));
    const route = createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    const server = createServer((req, res) => {
      const address = server.address();
      void route.handle(req, res, { ...context, port: typeof address === "object" && address ? address.port : 0 });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/native-directory-picker`, { method: "POST", headers: {
        Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Webui-Native-Grant": grant, "X-Webui-Token": "test-token",
      } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ kind: "selected", directory: tmpdir() });
      expect(choose).toHaveBeenCalledTimes(1);
    } finally {
      await route.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it.each<Record<string, string>>([
    { origin: "" }, { origin: "null" }, { origin: "http://evil.example:2233" },
    { origin: "https://127.0.0.1:2233" }, { host: "localhost:2233" },
    { "sec-fetch-site": "cross-site" }, { forwarded: "for=127.0.0.1" },
    { "x-forwarded-host": "example.test" }, { "x-webui-native-grant": "wrong" },
  ])("denies unsafe request %j without invoking provider", async (headers) => {
    const choose = vi.fn(); const route = createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    for (const action of ["choose", "authorize"] as const) {
      const res = response(); await route.handle(request(headers), asResponse(res), context, action);
      expect(res.statusCode).toBe(403); expect(res.setHeader).not.toHaveBeenCalledWith("Set-Cookie", expect.anything());
    }
    expect(choose).not.toHaveBeenCalled();
  });
  it.each([{ ...context, fullAccess: true }, { ...context, host: "0.0.0.0" }])("denies deployment %j", async (admission) => {
    const choose = vi.fn(); const route = createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    for (const action of ["choose", "authorize"] as const) {
      const res = response(); await route.handle(request(), asResponse(res), admission, action);
      expect(res.statusCode).toBe(403);
    }
    expect(choose).not.toHaveBeenCalled();
  });
  it("requires credential even in a locally admitted service and refuses remote sockets", async () => {
    const choose = vi.fn(); const route = createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    for (const action of ["choose", "authorize"] as const) {
      const missing = response(); await route.handle(request({ "x-webui-token": "" }), asResponse(missing), context, action);
      expect(missing.statusCode).toBe(401);
      const remote = response(); await route.handle(request({}, "192.0.2.1"), asResponse(remote), context, action);
      expect(remote.statusCode).toBe(403);
    }
    expect(choose).not.toHaveBeenCalled();
  });
  it("accepts no request body or client-selected path", async () => {
    const choose = vi.fn(); const route = createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    for (const action of ["choose", "authorize"] as const) {
      const res = response(); await route.handle(request({ "content-length": "10" }), asResponse(res), context, action);
      expect(res.statusCode).toBe(400);
    }
    expect(choose).not.toHaveBeenCalled();
  });
  it("rotates both browser proofs when the service restarts on the same port", async () => {
    const choose = vi.fn(async () => ({ kind: "cancelled" as const }));
    const makeRoute = () => createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    async function pair(route: ReturnType<typeof makeRoute>) {
      const res = response();
      await route.handle(request(), asResponse(res), context, "authorize");
      expect(res.statusCode).toBe(200);
      const cookie = res.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1] as string;
      return { "x-webui-native-grant": "", "x-webui-native-browser": JSON.parse(res.body).browserKey as string,
        cookie: cookie.split(";")[0]! };
    }
    const previous = makeRoute();
    const oldProofs = await pair(previous);
    await previous.dispose();
    const current = makeRoute();
    const newProofs = await pair(current);
    expect(newProofs.cookie).not.toBe(oldProofs.cookie);
    expect(newProofs["x-webui-native-browser"]).not.toBe(oldProofs["x-webui-native-browser"]);
    for (const stale of [oldProofs, { ...newProofs, cookie: oldProofs.cookie }, { ...oldProofs, cookie: newProofs.cookie }]) {
      const res = response();
      await current.handle(request(stale), asResponse(res), context);
      expect(res.statusCode).toBe(403);
    }
    expect(choose).not.toHaveBeenCalled();
    const accepted = response();
    await current.handle(request(newProofs), asResponse(accepted), context);
    expect(JSON.parse(accepted.body)).toEqual({ kind: "cancelled" });
    expect(choose).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ kind: "selected", directory: tmpdir() }, 200],
    [{ kind: "selected", directory: "relative-directory" }, 422],
    [{ kind: "cancelled" }, 200],
  ] as const)("validates native result %j", async (result, status) => {
    const res = response();
    await createNativeDirectoryRoute({ grant, choose: async () => result, dispose: async () => {} }).handle(request(), asResponse(res), context);
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(JSON.parse(res.body)).toEqual(result);
  });
  it("holds one dialog, aborts on disconnect, and permits another after settlement", async () => {
    let signal!: AbortSignal;
    const choose = vi.fn((value: AbortSignal) => { signal = value; return new Promise<{ kind: "cancelled" }>(resolve => value.addEventListener("abort", () => resolve({ kind: "cancelled" }))); });
    const route = createNativeDirectoryRoute({ grant, choose, dispose: async () => {} });
    const first = response(); const pending = route.handle(request(), asResponse(first), context);
    await Promise.resolve();
    const second = response(); await route.handle(request(), asResponse(second), context);
    expect(second.statusCode).toBe(409); expect(choose).toHaveBeenCalledTimes(1);
    first.destroyed = true; first.emit("close"); await pending; expect(signal.aborted).toBe(true);
    const third = response(); const again = route.handle(request(), asResponse(third), context);
    await Promise.resolve(); await route.dispose(); await again;
    expect(choose).toHaveBeenCalledTimes(2); expect(signal.aborted).toBe(true);
  });
  it("times out by cancelling the owned provider and sanitizes provider failures", async () => {
    const res = response();
    const route = createNativeDirectoryRoute({ grant, choose: signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ kind: "cancelled" }))), dispose: async () => {} }, 5);
    await route.handle(request(), asResponse(res), context); expect(JSON.parse(res.body)).toEqual({ kind: "cancelled" });
    const failure = response();
    await createNativeDirectoryRoute({ grant, choose: async () => { throw new Error("private details"); }, dispose: async () => {} }).handle(request(), asResponse(failure), context);
    expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain("private");
  });
});

function browser(url = `http://127.0.0.1:2233/#nativeDirectoryGrant=${grant}&session=A`) {
  vi.stubGlobal("location", new URL(url));
  const replaceState = vi.fn();
  vi.stubGlobal("history", { state: null, replaceState });
  vi.stubGlobal("__WEBUI_CONFIG__", { websocketUrl: "ws://127.0.0.1:2233", token: "test-token" });
  captureNativeDirectoryLaunchGrant();
  return replaceState;
}

describe("native directory launch grant transport", () => {
  const origin = "http://127.0.0.1:2233";
  const browserKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const signal = new AbortController().signal;

  it("exchanges the fragment before choosing, and uses the browser pairing after a refresh or a new launch", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v) });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ browserKey }))
      .mockImplementation(async () => Response.json({ kind: "selected", directory: "C:\\Work" }));
    vi.stubGlobal("fetch", fetch);
    const replace = browser();
    expect(replace.mock.calls[0]?.[2]).toBe(origin + "/#session=A");
    expect(await pickNativeWorkspaceDirectory(signal)).toEqual({ kind: "selected", directory: "C:\\Work" });
    expect(fetch.mock.calls[0]).toEqual([origin + "/native-directory-picker/authorize", expect.objectContaining({
      credentials: "same-origin", headers: { "X-Webui-Native-Grant": grant, "X-Webui-Token": "test-token" },
    })]);
    expect([...storage.values()]).toEqual([browserKey]);

    browser(origin + "/");
    await pickNativeWorkspaceDirectory(signal);
    expect(fetch.mock.calls[2]).toEqual([origin + "/native-directory-picker", expect.objectContaining({
      signal, headers: { "X-Webui-Native-Browser": browserKey, "X-Webui-Token": "test-token" },
    })]);
    // A different tab pairs a restarted launcher while this page remains open.
    const newKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    for (const key of storage.keys()) storage.set(key, newKey);
    await pickNativeWorkspaceDirectory(signal);
    expect(fetch.mock.calls[3]?.[1].headers["X-Webui-Native-Browser"]).toBe(newKey);
  });

  it("uses the key in memory if storage is unavailable and preserves cancellation", async () => {
    vi.stubGlobal("localStorage", undefined);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ browserKey }))
      .mockResolvedValueOnce(Response.json({ kind: "cancelled" }))
      .mockResolvedValueOnce(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    browser();
    expect(await pickNativeWorkspaceDirectory(signal)).toEqual({ kind: "cancelled" });
    expect(await pickNativeWorkspaceDirectory(signal)).toEqual({ kind: "unavailable" });
  });

  it("does not contact a picker from an unpaired, remote, or mismatched-runtime page", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", undefined);
    browser(origin + "/");
    expect(await pickNativeWorkspaceDirectory(signal)).toEqual({ kind: "unavailable" });
    vi.stubGlobal("localStorage", { getItem: () => browserKey });
    browser(`http://example.test/#nativeDirectoryGrant=${grant}`);
    expect(await pickNativeWorkspaceDirectory(signal)).toEqual({ kind: "unavailable" });
    browser(origin + "/");
    vi.stubGlobal("__WEBUI_CONFIG__", { websocketUrl: "ws://127.0.0.1:9999", token: "test-token" });
    expect(await pickNativeWorkspaceDirectory(signal)).toEqual({ kind: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
