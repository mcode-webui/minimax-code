// HTTP behaviour of GET /session-transfer and POST /session-import.
//
// Two classes of mistake live here, and neither is visible from a unit test on
// the payload builders:
//
//   1. How the port's failure modes map onto status codes. The first cut of
//      the export route answered 500 for a session that had been deleted,
//      because `getSession` rejects rather than returning an empty result and
//      the rejection fell through to the outer catch.
//
//   2. Which port method produces the body. An earlier version read
//      `messages.jsonl` off disk and walked `getMessages` for the display
//      layer, so that no port change was needed -- and lost the canonical
//      receipts on ~1% of rows, because `getMessages` is a render view. The
//      tests below pin the payload to `exportSessionTransfer` so that shape
//      cannot come back by accident.

import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRequestBody, WebuiService } from "../../src/server/service.js";
import type {
  WebuiCreateSessionRequest,
  WebuiUpdateSessionRequest,
} from "../../src/shared/contracts/session.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import {
  assertWebuiTransferFile,
  WEBUI_LEGACY_CLIENT_EXPORT_FORMAT,
} from "../../src/client/session-import.js";

const token = "test-token";

const SNAPSHOT = {
  generation: 7,
  fileName: "gen-7.jsonl",
  revision: "sha256:parent",
  records: [{ message_id: "msg-c0", turn_id: "turn-0", message: { role: "user", content: "earlier" } }],
};

const TRANSFER_FILE = {
  format: "mcode-webui-session-transfer@1",
  exportedAt: "2026-10-03T04:42:59.970Z",
  session: { sessionId: "mvs_src", title: "Imported", agentName: "mavis", workspaceDir: "C:/repo" },
  canonical: {
    envelopes: [{ message_id: "msg-c1", turn_id: "turn-1", message: { role: "user", content: "hi" } }],
    // Present because `WebuiSessionTransferFile.canonical.snapshots` requires
    // it, and asserted below because the type alone does not stop the runtime
    // from dropping it before it reaches the wire.
    snapshots: [SNAPSHOT],
    generation: 8,
    revision: "sha256:abc",
  },
  display: { messages: [{ msg_id: "msg-c1", role: "user" }] },
};

const port = (over: Partial<WebuiHarnessPort> = {}): WebuiHarnessPort =>
  ({
    version: () => ({ dataDir: "C:/data" } as never),
    getSession: async () => ({ session: { sessionId: "mvs_1", title: "T" } }),
    getMessages: async () => ({ messages: [{ msgId: "m1", role: "user" }], hasMore: false }),
    exportSessionTransfer: async () => TRANSFER_FILE as never,
    importSessionTransfer: async (request: { targetSessionId: string }) =>
      ({ sessionId: request.targetSessionId, canonicalMessages: 1, displayMessages: 1, revision: "sha256:abc" }) as never,
    createSession: async () => ({ sessionId: "mvs_new" }),
    updateSession: async () => ({ session: { sessionId: "mvs_new" } }) as never,
    deleteSession: async () => ({ success: true }),
    close: async () => {},
    ...over,
  }) as unknown as WebuiHarnessPort;

const services: WebuiService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

async function serve(
  over: Partial<WebuiHarnessPort> = {},
  options: { dev?: boolean } = {},
): Promise<string> {
  const service = new WebuiService({
    port: port(over),
    credential: { token },
    dev: options.dev ?? true,
  });
  services.push(service);
  const info = await service.start();
  return `http://${info.host}:${info.tcpPort}`;
}

function post(url: string, body: unknown, query = "", path = "/session-import"): Promise<Response> {
  return fetch(`${url}${path}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /session-transfer", () => {
  it("serves the runtime's payload verbatim as a download", async () => {
    const url = await serve();
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    // Named from the *session*, with the runtime's own export timestamp.
    expect(response.headers.get("content-disposition")).toContain("T-20261003T044259");
    const body = await response.json() as typeof TRANSFER_FILE;
    expect(body).toEqual(TRANSFER_FILE);
  });

  it("carries the compaction lineage, not only the active generation", async () => {
    // A compacted session is the case the whole canonical layer exists for.
    // The active generation names its parent by `(generation, compactionId)`
    // and the import scanner walks the lineage before accepting anything, so a
    // file without the snapshots dies at import with `parent-snapshot-missing`.
    // The type now requires this field; this asserts the bytes carry it, since
    // a type cannot stop the runtime from emptying the array.
    const url = await serve();
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    const body = (await response.json()) as typeof TRANSFER_FILE;
    expect(body.canonical.snapshots).toEqual([SNAPSHOT]);
  });

  it("produces a file the client's own importer accepts", async () => {
    // The contract that was broken, and the reason this assertion lives on the
    // HTTP route rather than on either module alone.
    //
    // The rail's export used to be assembled in the browser under the tag
    // `mcode-webui-session@1`, while this route -- the one the import half
    // needs -- wrote `mcode-webui-session-transfer@1`. Every test on either
    // side passed: the client correctly built the file it was told to build,
    // the server correctly served the file it was told to serve, and the
    // importer correctly refused the tag it was documented to refuse. The user
    // exported a session, picked the file back, and got "这是旧版导出的会话
    // 文件…无法还原" for a file that UI had just written.
    //
    // A unit test on the payload builder cannot see this, and neither can a
    // test of the importer: the failure is the *relationship* between two
    // modules that never referenced each other. So this takes the bytes off
    // the wire and hands them to the function the browser hands them to.
    const url = await serve();
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    const downloaded = await response.json();

    expect(() => assertWebuiTransferFile(downloaded)).not.toThrow();
  });

  it("still refuses the retired client-side export, by name", async () => {
    // The refusal is the only thing standing between a user and a session that
    // reads back but that the model cannot continue. It has to survive the
    // route being pointed at the importable format.
    const url = await serve({
      exportSessionTransfer: async () =>
        ({ ...TRANSFER_FILE, format: WEBUI_LEGACY_CLIENT_EXPORT_FORMAT }) as never,
    });
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    const downloaded = await response.json();

    expect(() => assertWebuiTransferFile(downloaded)).toThrow(/旧版导出/u);
  });

  it("takes the body from exportSessionTransfer, never from getMessages", async () => {
    // The regression guard. `getMessages` returns a view that drops the
    // canonical receipts on compaction and fork-origin rows, so a body built
    // from it is a lossy file wearing a complete file's format tag.
    const getMessages = vi.fn(async () => ({ messages: [{ msgId: "m1" }], hasMore: false }));
    const url = await serve({ getMessages: getMessages as never });
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    const body = await response.json() as { display: { messages: { msg_id?: string }[] } };

    expect(getMessages).not.toHaveBeenCalled();
    // The stored record's own id, not the view's `msgId`.
    expect(body.display.messages[0]?.msg_id).toBe("msg-c1");
  });

  it("answers 404, not 500, for a session the port rejects", async () => {
    // The regression this file was originally created for.
    const url = await serve({ getSession: async () => { throw new Error("Session not found: mvs_gone"); } });
    expect((await fetch(`${url}/session-transfer?sessionId=mvs_gone&token=${token}`)).status).toBe(404);
  });

  it("answers 404 for a session the port resolves to nothing", async () => {
    const url = await serve({ getSession: async () => ({}) });
    expect((await fetch(`${url}/session-transfer?sessionId=mvs_none&token=${token}`)).status).toBe(404);
  });

  it("answers 400 when no session id is supplied", async () => {
    const url = await serve();
    expect((await fetch(`${url}/session-transfer?token=${token}`)).status).toBe(400);
  });

  it("answers 500 when the runtime cannot produce the payload", async () => {
    const url = await serve({ exportSessionTransfer: async () => { throw new Error("history locked"); } });
    expect((await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`)).status).toBe(500);
  });

  it("requires the credential, like every other route", async () => {
    // `dev: true` deliberately skips the credential check, so this needs a
    // production-mode service to be testing anything.
    const url = await serve({}, { dev: false });
    expect((await fetch(`${url}/session-transfer?sessionId=mvs_1`)).status).toBe(401);
  });

  it("matches the path exactly rather than by prefix", async () => {
    const url = await serve();
    expect((await fetch(`${url}/session-transfer/extra?sessionId=mvs_1&token=${token}`)).status).toBe(404);
  });
});

describe("POST /session-import", () => {
  it("creates a session and imports the file into it", async () => {
    const importSessionTransfer = vi.fn(async (request: { targetSessionId: string; sourceSessionId?: string; file: unknown }) =>
      ({ sessionId: request.targetSessionId, canonicalMessages: 1, displayMessages: 1, revision: "sha256:abc" }) as never);
    const url = await serve({ importSessionTransfer });
    const response = await post(url, TRANSFER_FILE, `?token=${token}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessionId: "mvs_new",
      canonicalMessages: 1,
      displayMessages: 1,
      revision: "sha256:abc",
    });
    const request = importSessionTransfer.mock.calls[0]?.[0];
    expect(request?.targetSessionId).toBe("mvs_new");
    // The originating session is lineage only; it is never trusted for a path.
    expect(request?.sourceSessionId).toBe("mvs_src");
    expect(request?.file).toEqual(TRANSFER_FILE);
  });

  it("accepts the file wrapped as { file }, as well as bare", async () => {
    const importSessionTransfer = vi.fn(async (request: { targetSessionId: string; file: unknown }) =>
      ({ sessionId: request.targetSessionId, canonicalMessages: 0, displayMessages: 0, revision: "" }) as never);
    const url = await serve({ importSessionTransfer });
    await post(url, { file: TRANSFER_FILE }, `?token=${token}`);
    expect(importSessionTransfer.mock.calls[0]?.[0]?.file).toEqual(TRANSFER_FILE);
  });

  it("creates the session under the agent and workspace the caller is importing into", async () => {
    // `WebuiCreateSessionRequest.name` is the agent to run under, not a
    // title -- the client always passes "main" here. Getting this backwards
    // produced a 500: the runtime was asked to start a session under an agent
    // literally named after the previous session's id.
    const createSession = vi.fn(async () => ({ sessionId: "mvs_new" }));
    const updateSession = vi.fn(async () => ({ session: { sessionId: "mvs_new" } }) as never);
    const url = await serve({ createSession, updateSession });
    const response = await post(
      url,
      TRANSFER_FILE,
      `?agentName=coder&workspaceDir=C%3A%2Fwork&token=${token}`,
    );

    expect(createSession).toHaveBeenCalledWith({ name: "coder", workspaceDir: "C:/work" });
    // The title is the one thing taken from the file, and it is applied after
    // the history lands, so a failed import never leaves a session that merely
    // looks like the imported one.
    expect(updateSession).toHaveBeenCalledWith({ id: "mvs_new", title: "Imported" });
    expect(response.status).toBe(200);
  });

  it("never lets the file choose the agent or the working directory", async () => {
    // A downloaded file is untrusted. If its session block could name an
    // agent or a workspace, importing a file would aim a session at an
    // arbitrary directory on this machine -- or ask for an agent that does
    // not exist and take the whole import down with it.
    const createSession = vi.fn(async (_request: WebuiCreateSessionRequest) => ({ sessionId: "mvs_new" }));
    const url = await serve({ createSession });
    await post(url, TRANSFER_FILE, `?token=${token}`);

    // `agentName: "mavis"` and `workspaceDir: "C:/repo"` are in the file and
    // are both ignored in favour of the default agent.
    expect(createSession).toHaveBeenCalledWith({ name: "main" });
    // The mock takes the request the route actually passes, so the keys read
    // here are the ones `service.ts` wrote -- not an `any` the cast invented.
    const request = createSession.mock.calls[0]?.[0];
    expect(Object.keys(request ?? {})).toEqual(["name"]);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "mvs_new" }));
    const url = await serve({ createSession });
    expect((await post(url, "{not json", `?token=${token}`)).status).toBe(400);
    // Nothing was created from a body the server could not even read.
    expect(createSession).not.toHaveBeenCalled();
  });

  it("answers 400 when the file is not a transfer file at all", async () => {
    const url = await serve({
      importSessionTransfer: async () => { throw Object.assign(new Error("nope"), { code: "not-a-transfer-file" }); },
    });
    const response = await post(url, { format: "something-else" }, `?token=${token}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Not a session transfer file" });
  });

  it("answers 422 when the file parses but cannot be replayed", async () => {
    const url = await serve({
      importSessionTransfer: async () => { throw Object.assign(new Error("bad"), { code: "malformed-transfer-file" }); },
    });
    expect((await post(url, TRANSFER_FILE, `?token=${token}`)).status).toBe(422);
  });

  it("deletes the session it created when the import fails", async () => {
    // Otherwise every malformed file the user tries leaves an empty shell in
    // the sidebar, indistinguishable from a session that imported cleanly.
    const deleteSession = vi.fn(async () => ({ success: true }));
    const url = await serve({
      deleteSession,
      importSessionTransfer: async () => { throw Object.assign(new Error("bad"), { code: "malformed-transfer-file" }); },
    });
    await post(url, TRANSFER_FILE, `?token=${token}`);
    expect(deleteSession).toHaveBeenCalledWith({ id: "mvs_new" });
  });

  it("still reports the failure when the cleanup delete also fails", async () => {
    const url = await serve({
      deleteSession: async () => { throw new Error("already gone"); },
      importSessionTransfer: async () => { throw Object.assign(new Error("bad"), { code: "malformed-transfer-file" }); },
    });
    expect((await post(url, TRANSFER_FILE, `?token=${token}`)).status).toBe(422);
  });

  it("answers 500 when no session can be created at all", async () => {
    const importSessionTransfer = vi.fn();
    const url = await serve({
      createSession: async () => { throw new Error("disk full"); },
      importSessionTransfer: importSessionTransfer as never,
    });
    expect((await post(url, TRANSFER_FILE, `?token=${token}`)).status).toBe(500);
    expect(importSessionTransfer).not.toHaveBeenCalled();
  });

  it("answers 500 when session creation returns no id", async () => {
    const url = await serve({ createSession: async () => ({}) });
    expect((await post(url, TRANSFER_FILE, `?token=${token}`)).status).toBe(500);
  });

  it("requires the credential", async () => {
    const url = await serve({}, { dev: false });
    expect((await post(url, TRANSFER_FILE)).status).toBe(401);
  });

  it("is not reachable by GET, and the export route is not reachable by POST", async () => {
    const url = await serve();
    expect((await fetch(`${url}/session-import?token=${token}`)).status).toBe(404);
    expect((await post(url, TRANSFER_FILE, `?sessionId=mvs_1&token=${token}`, "/session-transfer")).status).toBe(404);
  });

  it("matches its own path exactly, not by prefix", async () => {
    // A prefix match would make `/session-import/anything` a second, unlisted
    // way to create a session.
    const importSessionTransfer = vi.fn();
    const url = await serve({ importSessionTransfer: importSessionTransfer as never });
    expect((await post(url, TRANSFER_FILE, `?token=${token}`, "/session-import/extra")).status).toBe(404);
    expect(importSessionTransfer).not.toHaveBeenCalled();
  });

  it("caps how much of an untrusted string it will pass on", async () => {
    // The payload is a file the user picked off disk; its session block is
    // attacker-controlled as far as this server is concerned.
    const createSession = vi.fn(async (_request: WebuiCreateSessionRequest) => ({ sessionId: "mvs_new" }));
    const updateSession = vi.fn(async (_request: WebuiUpdateSessionRequest) => ({ session: { sessionId: "mvs_new" } }) as never);
    const url = await serve({ createSession, updateSession });
    const hostile = {
      ...TRANSFER_FILE,
      session: { ...TRANSFER_FILE.session, title: "T".repeat(5000) },
    };
    await post(url, hostile, `?token=${token}`);
    // The agent comes from the query string, which is the same-origin user's
    // own input; only the title is capped here.
    expect(updateSession.mock.calls[0]?.[0]?.title).toHaveLength(200);
  });

  it("ignores a non-string session block instead of stringifying it", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "mvs_new" }));
    const updateSession = vi.fn(async () => ({ session: { sessionId: "mvs_new" } }) as never);
    const url = await serve({ createSession, updateSession });
    await post(url, { ...TRANSFER_FILE, session: { title: { evil: true }, agentName: 7 } }, `?token=${token}`);
    // Falls back to the default agent rather than passing an object to
    // `createSession`, which would reach an agent registry lookup.
    expect(createSession).toHaveBeenCalledWith({ name: "main" });
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe("readRequestBody", () => {
  // A real stream, not a hand-rolled event emitter: the guard only means
  // anything if it fires on the same events a real request emits.
  const body = (chunks: readonly string[]): IncomingMessage =>
    Readable.from(chunks.map((chunk) => Buffer.from(chunk, "utf8"))) as unknown as IncomingMessage;

  it("collects the whole body when it is under the cap", async () => {
    const raw = await readRequestBody(body(["hello ", "world"]), 1024);
    expect(raw.toString("utf8")).toBe("hello world");
  });

  it("refuses a body past the cap instead of buffering all of it", async () => {
    // Session files run to tens of megabytes, so the cap cannot just be
    // raised: a request that never ends would pin the heap indefinitely.
    await expect(readRequestBody(body(["x".repeat(50), "y".repeat(50)]), 60)).rejects.toThrow(
      /too large/,
    );
  });

  it("accepts a body exactly at the cap", async () => {
    await expect(readRequestBody(body(["z".repeat(60)]), 60)).resolves.toHaveLength(60);
  });

  it("rejects an empty body as an empty buffer, not an error", async () => {
    await expect(readRequestBody(body([]), 60)).resolves.toHaveLength(0);
  });
});
