/**
 * What the Agent's Bash actually inherits when the WebUI hosts mcode-tools.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The host environment is only half the contract. The keys the integration
 * installs have to survive the whole way into the Bash subprocess: the runtime
 * builds that environment from the host process, and the Bash tool applies a
 * two-layer sanitizer before every spawn. A key that never reaches the child
 * is the same failure as no broker at all — the Agent's mcode-tools run comes
 * back with "Embedded mcode-tools requires MCODE_AUTH_PROVIDER=shared-broker
 * from the MCode host."
 *
 * This suite closes that half. It boots the real WebUI host — the real
 * mcode-tools integration, the real runtime, the real Bash tool — and drives
 * one turn against a stub model that asks the Agent to read the host keys
 * back. The tool result in the next model request is the Bash subprocess's
 * own output.
 *
 * The only fake part is the external model service. The stub answers the real
 * content-review contract and the scripted turn, and records the request
 * bodies.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";

const MODEL_ID = "stub-model";
const PROVIDER_NAME = "stub";
const PROVIDER_ID = `custom_provider:${PROVIDER_NAME}`;
const HOST_KEY_PREFIX = "__MAVIS_MCODE_TOOLS_";

/** The Bash command that reads the host keys back out of the child env. */
const READ_HOST_KEYS = `env | grep '^${HOST_KEY_PREFIX}' | sort`;

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

/** Whether a recorded model request already carries a tool result. */
function carriesToolResult(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      messages?: Array<{ role?: string }>;
    };
    return (parsed.messages ?? []).some((message) => message.role === "tool");
  } catch {
    return false;
  }
}

interface Stub {
  readonly url: string;
  readonly requests: ReadonlyArray<{ readonly body: string }>;
  close(): Promise<void>;
}

/**
 * An OpenAI-completions endpoint that scripts one Bash call and records every
 * request body.
 */
async function startStubServer(): Promise<Stub> {
  const requests: { body: string }[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (isContentReviewRequest(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"pass":true,"safe":true,"action":1,"errorCode":0}');
        return;
      }
      requests.push({ body });
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
      if (carriesToolResult(body)) {
        // The Bash call came back; the turn ends here.
        res.write(frame({ role: "assistant", content: "host keys read" }, null));
        res.write(frame({}, "stop"));
      } else {
        res.write(
          frame(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-read-host-keys",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: READ_HOST_KEYS }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      }
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

interface Booted {
  close(): Promise<void>;
}

const booted: Booted[] = [];
const stubs: Stub[] = [];
const previousDataDir = process.env.MINIMAX_DATA_DIR;
const previousBuildEnv = process.env.MAVIS_BUILD_ENV;
const hostKeySnapshot = new Map<string, string | undefined>();

/** The host keys the integration installs, remembered so they can be restored. */
function rememberHostKeys(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(HOST_KEY_PREFIX) && !hostKeySnapshot.has(name))
      hostKeySnapshot.set(name, process.env[name]);
  }
}

afterEach(async () => {
  for (const entry of booted.splice(0)) await entry.close();
  for (const stub of stubs.splice(0)) await stub.close();
  if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = previousDataDir;
  if (previousBuildEnv === undefined) delete process.env.MAVIS_BUILD_ENV;
  else process.env.MAVIS_BUILD_ENV = previousBuildEnv;
  // The integration installs the host keys on the process environment, and
  // the host close restores them. Restore defensively as well, so a failed
  // boot cannot leak them into the next case.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(HOST_KEY_PREFIX)) delete process.env[name];
  }
  for (const [name, value] of hostKeySnapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hostKeySnapshot.clear();
});

describe("the real host, what the Agent's Bash inherits", () => {
  it(
    "hands the mcode-tools host keys to the Bash subprocess",
    async () => {
      const stub = await startStubServer();
      stubs.push(stub);
      process.env.MAVIS_BUILD_ENV = "test";
      const reviewBaseUrl = stub.url.replace(/\/v1$/u, "");

      const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-mcode-tools-"));
      const workspaceDir = join(dataDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(
        join(dataDir, "config.yaml"),
        [
          `defaultModel: ${PROVIDER_ID}/${MODEL_ID}`,
          // The Agent must not stop at an approval prompt: the Bash call is the
          // subject of this case, not a permission question.
          "permissionMode: bypassPermissions",
          "contentReview:",
          `  testBaseURL: ${reviewBaseUrl}`,
          "beta:",
          "  mcodeTools: true",
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

      // The real integration runs here: no `mcodeTools.prepare` override, so
      // the host starts its own broker and installs the host keys itself.
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "real-host-mcode-tools-bash-environment",
      });
      booted.push({
        close: async () => {
          await assembled.host.apiHost.close().catch(() => undefined);
          await removeRealHostDataDir(dataDir);
        },
      });
      rememberHostKeys();

      // The client has no bundled mcode-tools CLI next to its entry, and the
      // host environment is live anyway — that is the decoupling this change
      // made, and it is what lets the Bash call below authenticate.
      expect(assembled.mcodeTools.ready).toBe(true);
      expect(assembled.mcodeTools.category).toBe("resource_unavailable");

      const endpoint = process.env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT;
      const capabilityFile = process.env.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE;
      expect(endpoint).toBeTruthy();
      expect(capabilityFile).toBeTruthy();
      await expect(access(capabilityFile as string)).resolves.toBeUndefined();

      const port = createHarnessPortFromHost(assembled.host);
      const created = await port.createSession({ name: "main", workspaceDir });
      const sessionId = created.session?.sessionId;
      expect(typeof sessionId).toBe("string");

      const sent = await port.sendMessage({
        id: sessionId as string,
        content: "read the mcode-tools host keys",
      });
      expect(sent.ok).toBe(true);

      // The second model request carries the Bash tool's own output.
      await expect
        .poll(
          () => stub.requests.filter((request) => carriesToolResult(request.body)).length,
          { timeout: 120_000 },
        )
        .toBeGreaterThan(0);
      const withResult = stub.requests.find((request) => carriesToolResult(request.body));
      const toolOutput = withResult?.body ?? "";

      // The Bash subprocess saw the host keys — the endpoint and the
      // capability file that authenticate an mcode-tools run.
      expect(toolOutput).toContain(`${HOST_KEY_PREFIX}BROKER_ENDPOINT=${endpoint}`);
      expect(toolOutput).toContain(`${HOST_KEY_PREFIX}BROKER_CAPABILITY_FILE=${capabilityFile}`);
      expect(toolOutput).toContain(`${HOST_KEY_PREFIX}RUNTIME_EXECUTABLE=`);
      expect(toolOutput).toContain(`${HOST_KEY_PREFIX}REGION=`);
    },
    240_000,
  );
});
