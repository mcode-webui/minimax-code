// The real-host Mini App tool: the production WebUI chain, with only the
// external model service replaced, proves that this client's agent sees the
// Mini App tool.
//
// The host boots in an isolated data directory whose `config.yaml` names a BYOK
// provider pointing at a local HTTP server this file starts. The turn's LLM call
// really goes out over HTTP, and the request body that arrives there is the
// model's tool table — the thing the Mini App capability actually has to reach.
// Assembly, adapter, port, registry, service and host are the production ones.
//
// The stub is the only outside dependency that is faked, which is what makes
// the observation repeatable. `MINIMAX_DATA_DIR` is set before the assembly
// module is imported (the imports are dynamic on purpose) because that variable
// resolves both the data directory and the config path.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  readonly requests: ReadonlyArray<{ readonly url: string; readonly body: string }>;
  close(): Promise<void>;
}

/** An OpenAI-completions endpoint that streams one scripted assistant message. */
async function startStubServer(): Promise<Stub> {
  const requests: { url: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (isContentReviewRequest(req.url)) {
        // The content-review gateway. This client's owner row requires a verdict
        // before a turn reaches the model, so the stub answers the real review
        // contract instead of leaving the gateway unreachable. The body carries
        // both shapes: the V1 verdict (pass/safe) and the V2 verdict (action).
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{\"pass\":true,\"safe\":true,\"action\":1,\"errorCode\":0}");
        return;
      }
      requests.push({ url: req.url ?? "", body });
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
      server.close((error) => (error === undefined ? resolve() : reject(error)));
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

describe("the real WebUI host", () => {
  it(
    "offers the agent the Mini App tool",
    async () => {
      const stub = await startStubServer();
      stubs.push(stub);
      // A test build honours a loopback content-review base URL, so the turn can
      // reach a real review endpoint instead of the placeholder host.
      process.env.MAVIS_BUILD_ENV = "test";
      const reviewBaseUrl = stub.url.replace(/\/v1$/u, "");

      const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-miniapp-tool-"));
      const workspaceDir = join(dataDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      // Written before boot: `ensureConfigFile` would otherwise copy the
      // operator's own config (and its api key) into this directory.
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

      process.env.MINIMAX_DATA_DIR = dataDir;
      (await import("@mavis/config")).resetConfig();

      const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
      const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "real-host-miniapp-tool",
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

      const created = await port.createSession({ name: "main", workspaceDir });
      const sessionId = created.session?.sessionId;
      expect(typeof sessionId).toBe("string");

      const sent = await port.sendMessage({
        id: sessionId as string,
        content: "open the minimax-bot miniapp",
      });
      expect(sent.ok).toBe(true);
      if (sent.ok) for await (const _frame of sent.source) void _frame;

      // The stub served a real turn, so the request body it recorded is the
      // tool table this client's agent actually works with.
      expect(stub.requests.length).toBeGreaterThan(0);
      const body = JSON.parse(stub.requests[0]?.body ?? "{}") as {
        readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
      };
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name);
      expect(toolNames).toContain("miniapp");
    },
    120_000,
  );
});
