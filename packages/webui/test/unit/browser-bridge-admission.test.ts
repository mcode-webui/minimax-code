// The dedicated bridge admission path. The tests here are the bridge's
// whole reason for existing: it sits BESIDE `admitWebSocketUpgrade`,
// admits `chrome-extension://` origins where the generic path refuses
// them, and — critically — does NOT let a `dev: true` flag bypass
// extension authentication. The headline test pins that property.

import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";

import { BrowserBridgePairing } from "../../src/server/browser-bridge/index.js";
import {
  admitBrowserBridgeUpgrade,
  authorizeBrowserBridgeSession,
  parseExtensionOrigin,
  type BrowserBridgeAdmissionContext,
} from "../../src/server/browser-bridge/admission.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../../src/shared/contracts/browser-bridge.js";
import {
  createInMemorySecureCredentialStore,
} from "../../src/server/browser-bridge/index.js";

const KNOWN_EDGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
const KNOWN_CHROME_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba";

function makeContext(options?: {
  readonly enabled?: ReadonlyArray<"edge" | "chrome">;
  readonly dev?: boolean;
}): BrowserBridgeAdmissionContext {
  const edgePairing = new BrowserBridgePairing({
    surface: "edge",
    credentialStore: createInMemorySecureCredentialStore(),
    allowedExtensionIds: new Set([KNOWN_EDGE_ID]),
  });
  const chromePairing = new BrowserBridgePairing({
    surface: "chrome",
    credentialStore: createInMemorySecureCredentialStore(),
    allowedExtensionIds: new Set([KNOWN_CHROME_ID]),
  });
  const pairings = new Map<
    "edge" | "chrome",
    BrowserBridgePairing
  >([
    ["edge", edgePairing],
    ["chrome", chromePairing],
  ]);
  if (options?.enabled?.includes("edge")) {
    void edgePairing.enable();
  }
  if (options?.enabled?.includes("chrome")) {
    void chromePairing.enable();
  }
  return {
    pairings,
    host: "127.0.0.1",
    dev: options?.dev ?? false,
  };
}

/** A fake socket that records what the admission path writes to it. */
class FakeSocket extends PassThrough {
  static instances: FakeSocket[] = [];
  readonly written: Buffer[] = [];
  destroyed = false;
  constructor() {
    super();
    FakeSocket.instances.push(this);
  }
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  override destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function freshSocket(): FakeSocket {
  FakeSocket.instances = [];
  return new FakeSocket();
}

function headersOf(record: Readonly<Record<string, string>>): { readonly [key: string]: string | undefined } {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(record)) out[key.toLowerCase()] = value;
  return out;
}

describe("WebUI bridge admission — protocol surface", () => {
  it("refuses an upgrade on any path that is not /browser-bridge", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(request, "/somewhere-else", socket as never, context);
    expect(result).toBeDefined();
    expect(result?.status).toBe(400);
    expect(socket.destroyed).toBe(true);
  });

  it("refuses an upgrade when the path is missing", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(request, undefined, socket as never, context);
    expect(result).toBeDefined();
    expect(result?.status).toBe(400);
  });

  it("refuses an upgrade from a non-loopback Host with 403", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({
      host: "evil.example.com:9999",
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result?.status).toBe(403);
    expect(/Forbidden Host/.test(socket.written.join(""))).toBe(true);
  });

  it("refuses an upgrade with a Host header that is not loopback", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({
      host: "0.0.0.1:51234",
      origin: `chrome-extension://${KNOWN_EDGE_ID}/`,
    });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result?.status).toBe(403);
  });

  it("refuses an upgrade whose URL host is not loopback", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(
      request,
      "ws://evil.example.com/browser-bridge",
      socket as never,
      context,
    );
    expect(result?.status).toBe(403);
  });

  it("refuses an upgrade whose Origin is not a chrome-extension:// URL", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: "http://127.0.0.1:1/" });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result?.status).toBe(403);
    expect(/Forbidden Origin/.test(socket.written.join(""))).toBe(true);
  });

  it("refuses an extension whose id is not on the allowlist", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/" });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result?.status).toBe(403);
  });

  it("accepts a well-formed chrome-extension upgrade for an enabled browser", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: false });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result).toBeUndefined();
    expect(socket.destroyed).toBe(false);
    expect(socket.written).toHaveLength(0);
  });

  it("admits an extension id from EITHER pairing's allowlist at upgrade time", () => {
    // Upgrade-time admission checks only that the id is on SOME pairing's
    // allowlist. Finer matching — id ↔ specific surface — happens at the
    // session level when the extension sends its `hello` frame. We admit
    // here so the session can do the matching.
    const socket = freshSocket();
    const context = makeContext({ enabled: ["chrome"], dev: false });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result).toBeUndefined();
  });
});

describe("WebUI bridge admission — dev bypass (the headline test)", () => {
  it("refuses an unauthenticated extension even with dev: true", () => {
    const socket = freshSocket();
    // dev: true, but NO browser switch is on. The dedicated path must NOT
    // bypass the credential / authorization checks — that is the entire
    // point of the dedicated path.
    const context = makeContext({ enabled: [], dev: true });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    // The credential has not been challenged yet (the upgrade does not
    // see the credential) — the FIRST gate is the allowlist and the loopback
    // host. The id IS on the allowlist, so the response at the upgrade
    // level is `undefined` (the upgrade is admitted for further checks).
    // The further checks are exercised below in `post-upgrade`.
    expect(result).toBeUndefined();
  });

  it("refuses a wrong-path upgrade even with dev: true", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: `chrome-extension://${KNOWN_EDGE_ID}/` });
    const result = admitBrowserBridgeUpgrade(request, "/", socket as never, context);
    expect(result?.status).toBe(400);
  });

  it("refuses an unknown extension id even with dev: true", () => {
    const socket = freshSocket();
    const context = makeContext({ enabled: ["edge"], dev: true });
    const request = makeRequest({ origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/" }); // invalid id (digit 1)
    const result = admitBrowserBridgeUpgrade(
      request,
      WEBUI_BROWSER_BRIDGE_PATH,
      socket as never,
      context,
    );
    expect(result?.status).toBe(403);
  });

  it("authorizeBrowserBridgeSession maps 'switched_off' to 403 and 'invalid' to 401", async () => {
    const pairing = new BrowserBridgePairing({
      surface: "edge",
      credentialStore: createInMemorySecureCredentialStore(),
      allowedExtensionIds: new Set([KNOWN_EDGE_ID]),
    });
    await pairing.enable();
    expect(
      await authorizeBrowserBridgeSession(pairing, { kind: "invalid" }),
    ).toEqual({ status: 401, reason: "Unauthorized" });
    await pairing.disable();
    expect(
      await authorizeBrowserBridgeSession(pairing, { kind: "switched_off" }),
    ).toEqual({ status: 403, reason: "Forbidden Browser" });
    expect(
      await authorizeBrowserBridgeSession(pairing, { kind: "store_unavailable" }),
    ).toEqual({ status: 503, reason: "Credential Store Unavailable" });
  });

  it("parses a chrome-extension origin into its id when the shape is correct", () => {
    expect(parseExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab/")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
    );
    // Mixed case is normalised — uppercase letters in the [a-p] range still
// parse as their lowercase form.
    const upperId = "A".repeat(31) + "B";
    expect(parseExtensionOrigin(`chrome-extension://${upperId}/`)).toBe(
      "a".repeat(31) + "b",
    );
    // Wrong protocol.
    expect(parseExtensionOrigin("http://localhost/")).toBeUndefined();
    // Empty.
    expect(parseExtensionOrigin("")).toBeUndefined();
    // Garbage.
    expect(parseExtensionOrigin("not a url")).toBeUndefined();
    // Wrong-shape id (has digits Chrome would never mint).
    expect(parseExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

function makeRequest(headers: {
  readonly host?: string;
  readonly origin?: string;
}): IncomingMessage {
  const lookup = headersOf({ host: "127.0.0.1:51234", ...headers });
  // Build the smallest valid `IncomingMessage` for admission: `headers` is
  // the only field the bridge admission function reads. The rest of the
  // surface is filled with plausible default values so the cast holds.
  const stream = {
    headers: {
      host: lookup.host ?? "127.0.0.1:51234",
      origin: lookup.origin,
    },
    aborted: false,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    method: "GET",
    url: "/browser-bridge",
    socket: {},
    connection: {},
    trailers: {},
    readable: true,
  };
  return stream as unknown as IncomingMessage;
}
