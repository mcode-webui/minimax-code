// HTTP behaviour of GET /session-transfer.
//
// These exist because the first cut of the route answered 500 for a session
// that had been deleted: `getSession` rejects rather than returning an empty
// result, and the rejection fell through to the outer catch. A unit test on
// the payload builders could never have caught that -- the mistake was in how
// the port's failure modes were mapped onto status codes.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebuiService } from "../../src/server/service.js";
import { sessionHistoryDirSuffix } from "../../src/server/session-transfer.js";
import type { WebuiHarnessPort } from "../../src/server/port.js";

const token = "test-token";

const port = (over: Partial<WebuiHarnessPort> = {}): WebuiHarnessPort =>
  ({
    version: () => ({ dataDir: "C:/data" } as never),
    getSession: async () => ({ session: { sessionId: "mvs_1", title: "T" } }),
    getMessages: async () => ({ messages: [{ msgId: "m1", role: "user" }], hasMore: false }),
    close: async () => {},
    ...over,
  }) as unknown as WebuiHarnessPort;

const services: WebuiService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

async function serve(over: Partial<WebuiHarnessPort> = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const service = new WebuiService({ port: port(over), credential: { token }, dev: true });
  services.push(service);
  const info = await service.start();
  return { url: `http://${info.host}:${info.tcpPort}`, close: () => service.close() };
}

describe("GET /session-transfer", () => {
  it("serves the payload as a download and names the file after the session", async () => {
    const { url } = await serve();
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("T-");
    const body = await response.json() as { format: string; canonical: { envelopes: unknown[] } };
    expect(body.format).toBe("mcode-webui-session-transfer@1");
    expect(body.canonical.envelopes).toEqual([]);
  });

  it("answers 404, not 500, for a session the port rejects", async () => {
    // The regression this file exists for.
    const { url } = await serve({
      getSession: async () => { throw new Error("Session not found: mvs_gone"); },
    });
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_gone&token=${token}`);
    expect(response.status).toBe(404);
  });

  it("answers 404 for a session the port resolves to nothing", async () => {
    const { url } = await serve({ getSession: async () => ({}) });
    expect((await fetch(`${url}/session-transfer?sessionId=mvs_none&token=${token}`)).status).toBe(404);
  });

  it("answers 400 when no session id is supplied", async () => {
    const { url } = await serve();
    expect((await fetch(`${url}/session-transfer?token=${token}`)).status).toBe(400);
  });

  it("requires the credential, like every other route", async () => {
    // `dev: true` deliberately skips the credential check (service.ts), so
    // this needs a production-mode service to be testing anything.
    const service = new WebuiService({ port: port(), credential: { token }, dev: false });
    services.push(service);
    const info = await service.start();
    const response = await fetch(`http://${info.host}:${info.tcpPort}/session-transfer?sessionId=mvs_1`);
    expect(response.status).toBe(401);
  });

  it("reports a missing data dir instead of serving a half round trip", async () => {
    // A file with only the display layer would import as a transcript the
    // model cannot see, so the route refuses rather than pretending.
    const { url } = await serve({ version: () => ({ dataDir: undefined } as never) });
    expect((await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`)).status).toBe(503);
  });

  it("walks every message page and returns them oldest first", async () => {
    const load = vi.fn(async (request: { before?: string }) =>
      request.before === undefined
        ? { messages: [{ msgId: "m3" }, { msgId: "m4" }], nextCursor: "c1", hasMore: true }
        : { messages: [{ msgId: "m1" }, { msgId: "m2" }], hasMore: false });
    const { url } = await serve({ getMessages: load as never });
    const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
    const body = await response.json() as { display: { messages: { msgId: string }[] } };
    // The cursor walks backwards in time; reversing the flattened array would
    // yield m1, m3, m2, m4 instead.
    expect(body.display.messages.map((m) => m.msgId)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reads canonical history off disk and puts the catalog position in the file", async () => {
    // End to end through a real data dir, because the catalog only reaches the
    // response if the directory is located, parsed and merged. Asserting it on
    // `buildSessionTransfer` alone left the wiring unverified.
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-transfer-route-"));
    try {
      const historyDir = join(
        dataDir, "v2", "sessions", "2026", "10", "03", `04-42-59-970-${sessionHistoryDirSuffix("mvs_1")}`,
      );
      await mkdir(historyDir, { recursive: true });
      await writeFile(join(historyDir, "messages.jsonl"), [
        JSON.stringify({ message_id: "msg-c1", turn_id: "turn-1", message: { role: "user", content: "hi", timestamp: 1, hostMetadata: { immediateSendBatchId: "b1" } } }),
        JSON.stringify({ message_id: "msg-c2", turn_id: "turn-1", message: { role: "assistant", content: "yo", timestamp: 2 } }),
      ].join("\n"), "utf8");
      await writeFile(join(historyDir, "history-catalog.json"), JSON.stringify({ activeGeneration: 8, activeRevision: "sha256:abc" }), "utf8");

      const { url } = await serve({ version: () => ({ dataDir } as never) });
      const response = await fetch(`${url}/session-transfer?sessionId=mvs_1&token=${token}`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        canonical: { envelopes: { message_id: string }[]; activeGeneration?: number; activeRevision?: string };
        display: { messages: unknown[] };
      };
      expect(body.canonical.envelopes.map((e) => e.message_id)).toEqual(["msg-c1", "msg-c2"]);
      expect(body.canonical.activeGeneration).toBe(8);
      expect(body.canonical.activeRevision).toBe("sha256:abc");
      // Both layers, even though the disk only held the canonical one.
      expect(body.display.messages).toHaveLength(1);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });

  it("serves nothing under the transfer path except the route itself", async () => {
    // A `..` segment cannot be tested through fetch: it normalises the path
    // before the request leaves the client, so the server would only ever see
    // `/index.html`. What the server can be asked is whether the transfer path
    // is a prefix match or an exact one.
    const { url } = await serve();
    expect((await fetch(`${url}/session-transfer/extra?sessionId=mvs_1&token=${token}`)).status).toBe(404);
    expect((await fetch(`${url}/session-transfer?token=${token}`)).status).toBe(400);
  });
});
