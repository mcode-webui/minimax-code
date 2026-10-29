// The real-host model turn: the production WebUI chain driving one turn against a
// real runtime host, with only the external model service replaced.
//
// `real-host-loopback.test.ts` proves the network entrance reaches the real host
// for every operation that needs no model. This file closes the turn: the host
// boots in an isolated data directory whose `config.yaml` names a BYOK provider
// pointing at a local HTTP server this file starts, the turn's LLM call really goes
// out over HTTP to that server, and the scripted answer comes back through the real
// stream into the session's stored history. Nothing in the WebUI chain is replaced:
// assembly, adapter, port, registry, service and host are the production ones.
//
// The stub is the only outside dependency that is faked, which is what an
// end-to-end finding allows to be controlled so the answer is repeatable. The data
// directory is temporary, and its config file is written before boot so the harness
// cannot copy the developer's own config in (see `ensureConfigFile`,
// `packages/config/src/config.ts:1799-1805`).
//
// `MINIMAX_DATA_DIR` is set before the assembly module is imported (the imports are
// dynamic on purpose) because that variable is what resolves both the data
// directory and the config path out of the operator's environment.
//
// One cosmetic detail a reader should not mistake for a failure: after the turn the
// harness fires a fire-and-forget session-title model call, which the stub also
// answers. When teardown wins that race the harness logs "session title generation
// failed … MCP runtime is not initialized or has been closed". The turn's own
// assertions have already run at that point.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";

/**
 * The content-review gateway answers on both API versions the runtime uses:
 * V1 (`/mavis/api/v1/content`) and V2 (`/mavis/api/v2/content`).
 */
function isContentReviewRequest(url: string | undefined): boolean {
  return (
    (url ?? "").startsWith("/mavis/api/v1/content") ||
    (url ?? "").startsWith("/mavis/api/v2/content")
  );
}

const MODEL_ID = "stub-model";
const PROVIDER_NAME = "stub";
const PROVIDER_ID = `custom_provider:${PROVIDER_NAME}`;
const STUB_ANSWER = "stub answer";

interface Stub {
  readonly url: string;
  readonly requests: ReadonlyArray<{ readonly url: string; readonly authorization?: string; readonly body: string }>;
  close(): Promise<void>;
}

/** An OpenAI-completions endpoint that streams one scripted assistant message. */
async function startStubServer(responseGate?: Promise<void>): Promise<Stub> {
  const requests: { url: string; authorization?: string; body: string }[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", async () => {
      if (isContentReviewRequest(req.url)) {
        // The content-review gateway: the owner row requires a verdict before the
        // turn reaches the model, so the stub answers the real review contract.
        // The body carries both shapes: the V1 verdict (pass/safe) and the V2
        // verdict (action).
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{\"pass\":true,\"safe\":true,\"action\":1,\"errorCode\":0}");
        return;
      }
      requests.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      await responseGate;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const frame = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: 1,
          model: MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.write(frame({ role: "assistant", content: STUB_ANSWER }, null));
      res.write(frame({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("stub server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

interface Booted {
  readonly dataDir: string;
  readonly workspaceDir: string;
  close(): Promise<void>;
}

const booted: Booted[] = [];
const stubs: Stub[] = [];
const previousDataDir = process.env.MINIMAX_DATA_DIR;
const previousBuildEnv = process.env.MAVIS_BUILD_ENV;

afterEach(async () => {
  for (const entry of booted.splice(0)) await entry.close();
  for (const stub of stubs.splice(0)) await stub.close();
  if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = previousDataDir;
  if (previousBuildEnv === undefined) delete process.env.MAVIS_BUILD_ENV;
  else process.env.MAVIS_BUILD_ENV = previousBuildEnv;
});

describe("real host, one turn against a controlled model service", () => {
  it(
    "turns a host-side failure into an error frame rather than a silent success",
    async () => {
      const stub = await startStubServer();
      stubs.push(stub);
      const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-error-"));
      await mkdir(join(dataDir, "workspace"), { recursive: true });
      await writeFile(join(dataDir, "config.yaml"), "# no provider entry\n", { mode: 0o600 });
      process.env.MINIMAX_DATA_DIR = dataDir;
      // `@mavis/config` caches its snapshot per process, and both cases in this
      // file boot a host; without this the second case would read the first
      // case's config (which has no provider entry).
      (await import("@mavis/config")).resetConfig();

      const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
      const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");
      const { WebuiTerminalManager } = await import("../../src/runtime/index.js");
      const { WebuiService, createOperationRegistry } = await import("../../src/server/index.js");
      const { WEBUI_PROTOCOL_VERSION } = await import("../../src/shared/envelope.js");

      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "real-host-model-error",
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
      const service = new WebuiService({
        port,
        operations: createOperationRegistry(port, terminal),
        terminal,
        tcpPort: 0,
        credential: { token: "real-host-model-error-token" },
      });
      booted.push({
        dataDir,
        workspaceDir: join(dataDir, "workspace"),
        close: async () => {
          await service.close().catch(() => undefined);
          await assembled.host.apiHost.close().catch(() => undefined);
          await removeRealHostDataDir(dataDir);
        },
      });

      const info = await service.start();
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`ws://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}`);
      ws.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const response = new Promise<Record<string, unknown>>((resolve) => {
        ws.on("message", (raw) => resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>));
      });
      ws.send(
        JSON.stringify({
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId: "r1",
          operation: "sendMessage",
          body: { id: "mvs_does_not_exist", content: "hello" },
        }),
      );

      // The failure comes from the host itself (the session does not exist), so
      // this pins propagation rather than validation: the frame is the error the
      // dispatcher builds from a rejecting handler.
      const frame = await response;
      expect(frame.kind).toBe("error");
      expect(frame.code).toBe("local_session_not_found");
      expect(frame.message).toBe("Session not found");
      ws.close();
    },
    120_000,
  );

  it(
    "runs a turn whose answer comes from the stub model and lands in the session history",
    async () => {
      let releaseModel!: () => void;
      const responseGate = new Promise<void>((resolve) => { releaseModel = resolve; });
      const stub = await startStubServer(responseGate);
      stubs.push(stub);
      // A test build honours a loopback content-review base URL, so the turn can
      // reach a real review endpoint instead of the placeholder host.
      process.env.MAVIS_BUILD_ENV = "test";
      const reviewBaseUrl = stub.url.replace(/\/v1$/u, "");

      const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-turn-"));
      const workspaceDir = join(dataDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      // Written before boot: `ensureConfigFile` would otherwise copy the
      // developer's own config (and its api key) into this directory.
      await writeFile(
        join(dataDir, "config.yaml"),
        [
          `defaultModel: ${PROVIDER_ID}/${MODEL_ID}`,
          // The owner row requires a content-review verdict before the turn reaches
          // the model.
          "contentReview:",
          `  testBaseURL: ${reviewBaseUrl}`,
          "custom_provider:",
          `  ${PROVIDER_NAME}:`,
          "    name: Stub",
          "    api: openai-completions",
          "    options:",
          `      baseURL: ${stub.url}`,
          "      apiKey: stub-key",
          "    models:",
          `      ${MODEL_ID}:`,
          `        id: ${MODEL_ID}`,
          "        name: Stub Model",
          "        tool_call: true",
          "        limit:",
          "          context: 100000",
          "          output: 4096",
          "        modalities:",
          "          input: [text]",
          "          output: [text]",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      // Set before the assembly is imported, so `getDataDir()`/`getConfigPath()`
      // resolve inside this directory rather than into a mavis repo profile.
      process.env.MINIMAX_DATA_DIR = dataDir;
      // `@mavis/config` caches its snapshot per process, and both cases in this
      // file boot a host; without this the second case would read the first
      // case's config (which has no provider entry).
      (await import("@mavis/config")).resetConfig();

      const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
      const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "real-host-model-turn",
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
      booted.push({
        dataDir,
        workspaceDir,
        close: async () => {
          await assembled.host.apiHost.close().catch(() => undefined);
          await removeRealHostDataDir(dataDir);
        },
      });
      const port = createHarnessPortFromHost(assembled.host);

      // The config reached the model list: the stub model is what the session
      // will ask for, so a turn cannot silently use another provider.
      const models = await port.listModels({});
      const stubModel = models.find((model) => model.modelConfigId === `${PROVIDER_ID}/${MODEL_ID}`);
      expect(stubModel).toBeDefined();
      expect(stubModel?.selected).toBe(true);

      const created = await port.createSession({ name: "main", workspaceDir });
      const sessionId = created.session?.sessionId;
      expect(typeof sessionId).toBe("string");

      const sent = await port.sendMessage({ id: sessionId as string, content: "hello stub" });
      expect(sent.ok).toBe(true);
      // V23: the real host exposes an active turn while the external response
      // is held, and an idle probe after delivery settles. This is an ordering
      // observation, not an atomic snapshot/event barrier.
      try {
        await expect.poll(() => stub.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);
        const active = await port.getActiveTurn({ id: sessionId as string });
        expect(active?.busyReason).toBe("turn");
        expect(active?.turnId).toBeTruthy();
      } finally { releaseModel(); }
      const frames: Record<string, unknown>[] = [];
      if (sent.ok)
        for await (const frame of sent.source)
          frames.push(JSON.parse(JSON.stringify(frame)) as Record<string, unknown>);

      // The stub really served the turn: one request, to the configured provider,
      // carrying the configured key and the configured model id.
      expect(stub.requests.length).toBeGreaterThan(0);
      const turnRequest = stub.requests[0];
      expect(turnRequest?.authorization).toBe("Bearer stub-key");
      expect(turnRequest?.body).toContain(`"model":"${MODEL_ID}"`);
      expect(turnRequest?.body).toContain("hello stub");

      // The stream carried the assistant message the stub scripted.
      const streamed = frames
        .map((frame) => String(frame.dataJson ?? ""))
        .filter((json) => json.includes("agent_message_chunk"));
      expect(streamed.length).toBeGreaterThan(0);
      expect(streamed.some((json) => json.includes(STUB_ANSWER))).toBe(true);

      // And the turn landed in the host's own history, as the client reads it.
      const history = await port.getMessages({ id: sessionId as string });
      const messages = history.messages ?? [];
      expect(messages.map((message) => message.msgContent)).toContain("hello stub");
      const answer = messages.find((message) => message.role === "assistant");
      expect(answer?.msgContent).toBe(STUB_ANSWER);
      expect(answer?.finishReason).toBe("stop");
      await expect.poll(() => port.getActiveTurn({ id: sessionId as string })).toBeUndefined();
    },
    120_000,
  );
});
