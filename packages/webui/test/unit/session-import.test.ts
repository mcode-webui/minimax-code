import { describe, expect, it, vi } from "vitest";

import {
  assertWebuiTransferFile,
  importWebuiSessionFile,
  readWebuiSessionImportTarget,
  WEBUI_LEGACY_CLIENT_EXPORT_FORMAT,
  WebuiSessionImportRefused,
} from "../../src/client/session-import.js";
import { WEBUI_SESSION_TRANSFER_FORMAT } from "../../src/shared/session-transfer-format.js";

const TRANSFER = {
  format: WEBUI_SESSION_TRANSFER_FORMAT,
  exportedAt: "2026-10-03T06:00:00.000Z",
  session: { sessionId: "mvs_src", title: "Imported" },
  canonical: { envelopes: [], snapshots: [], generation: 1, revision: "r" },
  display: { messages: [] },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function blob(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: "application/json" });
}

function options(fetchImpl: typeof fetch) {
  return { origin: "http://127.0.0.1:8788", token: "tok", fetchImpl };
}

describe("session transfer format", () => {
  it("is the tag the server route writes", () => {
    // Pinned as a literal on both sides rather than by importing the runtime
    // across the package boundary: the runtime exports no application-layer
    // subpath, and adding one would mean editing its `exports` map, running
    // `gen:tsconfig` and refreshing the source inventory for a test-only
    // concern. The runtime pins the same literal in
    // `transfer-application.test.ts`, so a change to either side fails one of
    // the two suites.
    expect(WEBUI_SESSION_TRANSFER_FORMAT).toBe("mcode-webui-session-transfer@1");
  });
});

describe("assertWebuiTransferFile", () => {
  it("accepts a transfer file", () => {
    expect(() => assertWebuiTransferFile(TRANSFER)).not.toThrow();
  });

  it("names the legacy client export instead of failing as a parse error", () => {
    // The old client-side export is display-only: replaying it would give the
    // user a transcript the model cannot see, which looks like success and is
    // not. It has to be refused by name.
    let thrown: unknown;
    try {
      assertWebuiTransferFile({ format: WEBUI_LEGACY_CLIENT_EXPORT_FORMAT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebuiSessionImportRefused);
    expect((thrown as WebuiSessionImportRefused).reason).toBe("legacy-client-export");
    expect((thrown as Error).message).toContain("transfer.json");
  });

  it("refuses a non-object and an array with the same reason", () => {
    for (const value of [null, "x", 7, []]) {
      let thrown: unknown;
      try {
        assertWebuiTransferFile(value);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as WebuiSessionImportRefused).reason).toBe("not-a-transfer-file");
    }
  });

  it("refuses an unknown tag", () => {
    expect(() => assertWebuiTransferFile({ format: "mcode-webui-session@99" })).toThrow(
      WebuiSessionImportRefused,
    );
  });
});

describe("importWebuiSessionFile", () => {
  it("posts the file and returns the new session", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        sessionId: "mvs_new",
        canonicalMessages: 902,
        displayMessages: 435,
        revision: "sha256:abc",
      }),
    ) as unknown as typeof fetch;

    const result = await importWebuiSessionFile(blob(TRANSFER), options(fetchImpl));

    expect(result).toEqual({
      sessionId: "mvs_new",
      canonicalMessages: 902,
      displayMessages: 435,
      revision: "sha256:abc",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/session-import?");
    expect(url).toContain("token=tok");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(TRANSFER);
  });

  it("keeps the caller's origin when the injected token is empty", async () => {
    // An injected target is chosen by presence, not by truthiness. If the
    // empty token sent the call back to the global config, an explicit
    // `origin` would be silently discarded -- the request would go somewhere
    // the caller never named.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { sessionId: "mvs_injected" }),
    ) as unknown as typeof fetch;
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    global.__WEBUI_CONFIG__ = { websocketUrl: "ws://global-host:9999/ws", token: "global" };
    try {
      await importWebuiSessionFile(blob(TRANSFER), { origin: "http://injected:1234", token: "", fetchImpl });
      const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://injected:1234/session-import?token=");
    } finally {
      delete global.__WEBUI_CONFIG__;
    }
  });

  it("never puts the file's own agent or workspace in the request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { sessionId: "mvs_new" }),
    ) as unknown as typeof fetch;
    const hostile = {
      ...TRANSFER,
      session: { sessionId: "mvs_src", title: "T", agentName: "root", workspaceDir: "C:/Windows" },
    };

    await importWebuiSessionFile(blob(hostile), {
      origin: "http://127.0.0.1:8788",
      token: "tok",
      fetchImpl,
      agentName: "main",
      workspaceDir: "C:/work",
    });

    // Identity is the caller's context, never the payload's.
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("agentName=main");
    expect(url).toContain("workspaceDir=C%3A%2Fwork");
    expect(url).not.toContain("root");
    expect(url).not.toContain("Windows");
  });

  it("refuses a wrong file before making any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      importWebuiSessionFile(blob({ format: "nope" }), options(fetchImpl)),
    ).rejects.toBeInstanceOf(WebuiSessionImportRefused);
    // A real transfer file is tens of megabytes; uploading one to be told the
    // tag is wrong is the failure this check exists to prevent.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses unparsable JSON without a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const notJson = new Blob(["{not json"], { type: "application/json" });
    await expect(importWebuiSessionFile(notJson, options(fetchImpl))).rejects.toMatchObject({
      reason: "not-json",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the server's own message for a rejected file", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: "Not a session transfer file" }),
    ) as unknown as typeof fetch;
    await expect(importWebuiSessionFile(blob(TRANSFER), options(fetchImpl))).rejects.toMatchObject({
      reason: "not-a-transfer-file",
      message: "Not a session transfer file",
    });
  });

  it("surfaces a replay failure distinctly from a foreign file", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { error: "Session import failed" })) as unknown as typeof fetch;
    await expect(importWebuiSessionFile(blob(TRANSFER), options(fetchImpl))).rejects.toMatchObject({
      reason: "unreadable",
      message: "Session import failed",
    });
  });

  it("refuses a success that carries no session id", async () => {
    // Otherwise the caller would try to select a session that does not exist.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { canonicalMessages: 1 })) as unknown as typeof fetch;
    await expect(importWebuiSessionFile(blob(TRANSFER), options(fetchImpl))).rejects.toMatchObject({
      reason: "unreadable",
    });
  });

  it("defaults the counts when the server omits them", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { sessionId: "mvs_new" })) as unknown as typeof fetch;
    await expect(importWebuiSessionFile(blob(TRANSFER), options(fetchImpl))).resolves.toEqual({
      sessionId: "mvs_new",
      canonicalMessages: 0,
      displayMessages: 0,
      revision: "",
    });
  });

  it("reports a missing runtime instead of calling an undefined origin", async () => {
    await expect(importWebuiSessionFile(blob(TRANSFER))).rejects.toMatchObject({
      reason: "unreadable",
    });
  });
});

describe("readWebuiSessionImportTarget", () => {
  it("derives the origin from the websocket url and carries the token", () => {
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    global.__WEBUI_CONFIG__ = { websocketUrl: "ws://127.0.0.1:8788/?token=abc", token: "abc" };
    try {
      expect(readWebuiSessionImportTarget()).toEqual({ origin: "http://127.0.0.1:8788", token: "abc" });
    } finally {
      delete global.__WEBUI_CONFIG__;
    }
  });

  it("returns nothing when the runtime config was never injected", () => {
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    delete global.__WEBUI_CONFIG__;
    expect(readWebuiSessionImportTarget()).toBeUndefined();
  });

  it("accepts the dev server's empty token as a usable target", () => {
    // `vite.config.ts` injects `token:''` and the dev service skips the
    // credential check entirely (`service.ts` gates on `this.dev`, not on the
    // token's shape). An empty token is therefore the *normal* dev state, not a
    // signal that the app is disconnected -- treating it as one makes the import
    // button refuse on every dev machine while production works fine.
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    global.__WEBUI_CONFIG__ = { websocketUrl: "ws://127.0.0.1:5199/ws", token: "" };
    try {
      expect(readWebuiSessionImportTarget()).toEqual({ origin: "http://127.0.0.1:5199", token: "" });
    } finally {
      delete global.__WEBUI_CONFIG__;
    }
  });

  it("refuses a config with no websocket url rather than posting to nowhere", () => {
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    global.__WEBUI_CONFIG__ = { websocketUrl: "", token: "abc" };
    try {
      expect(readWebuiSessionImportTarget()).toBeUndefined();
    } finally {
      delete global.__WEBUI_CONFIG__;
    }
  });

  it("refuses an unparseable websocket url instead of throwing out of the picker", () => {
    // Non-empty but not a URL. This is the case the empty-string guard cannot
    // catch, and it reaches the user as an unhandled `TypeError` if the parse is
    // unguarded -- a file picker that throws instead of showing a message.
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    global.__WEBUI_CONFIG__ = { websocketUrl: "not a url", token: "abc" };
    try {
      expect(readWebuiSessionImportTarget()).toBeUndefined();
    } finally {
      delete global.__WEBUI_CONFIG__;
    }
  });
});

describe("importWebuiSessionFile under the dev config", () => {
  it("posts the file with an empty token instead of refusing", async () => {
    // The user-visible consequence of the guard above: with the config the dev
    // server actually injects, picking a file must reach the route. A guard that
    // reads "empty token" as "no runtime" makes this reject before any request.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { sessionId: "mvs_dev", canonicalMessages: 902, displayMessages: 435, revision: "sha256:dev" }),
    ) as unknown as typeof fetch;
    const global = globalThis as { __WEBUI_CONFIG__?: unknown };
    global.__WEBUI_CONFIG__ = { websocketUrl: "ws://127.0.0.1:5199/ws", token: "" };
    try {
      await expect(importWebuiSessionFile(blob(TRANSFER), { fetchImpl })).resolves.toMatchObject({
        sessionId: "mvs_dev",
      });
      const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:5199/session-import?token=");
    } finally {
      delete global.__WEBUI_CONFIG__;
    }
  });
});
