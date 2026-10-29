/**
 * The capability surface a real WebUI turn offers the model.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Built-in capabilities have gone missing three ways, and every one of them
 * was invisible until a turn failed:
 *
 *   * a skill dropped out of the rendered catalog — `mcode-tools-master` went
 *     with the readiness overwrite,
 *   * a native tool missing from the tool table — `web_search` went with the
 *     owner-kind gate,
 *   * an MCP server's tools never reaching the model — the stdio message limit
 *     and the discovery timeout both hid there.
 *
 * This gate watches the surface the model is actually offered: the skill
 * catalog and the tool table in the request body of a real turn. It pins that
 * surface to a reviewed baseline, so a capability that disappears fails the
 * gate — and a capability that is added fails it too, until the baseline is
 * updated on purpose.
 *
 * The host is the production one, booted in an isolated data directory whose
 * `config.yaml` and `mcp.json` are written before boot. The MCP server is a
 * real stdio server, so the MCP part of the surface is earned the way the
 * product earns it. The only fake part is the external model service.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";
import { CAPABILITY_SURFACE_BASELINE } from "./capability-surface-baseline.js";

const MODEL_ID = "stub-model";
const PROVIDER_NAME = "stub";
const PROVIDER_ID = `custom_provider:${PROVIDER_NAME}`;
const SKILL_CATALOG_OPEN = "<available_skills>";
const SKILL_CATALOG_CLOSE = "</available_skills>";

/** The MCP server the isolated data directory offers. */
const MCP_SERVER_NAME = "capability-fixture";
/** The tool that server exposes, projected into the tool table. */
const MCP_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__capability_probe`;

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

interface Stub {
  readonly url: string;
  readonly requests: ReadonlyArray<{ readonly body: string }>;
  close(): Promise<void>;
}

/** An OpenAI-completions endpoint that records the request and answers one turn. */
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
      res.write(frame({ role: "assistant", content: "stub answer" }, null));
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

interface ModelRequest {
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
}

/** Every text the request carries, in one string. */
function requestText(request: ModelRequest): string {
  const parts: string[] = [];
  for (const message of request.messages ?? []) {
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * The skill ids in the rendered catalog. The catalog renders one
 * `- <name>: <description>` line per skill; a skill whose description did not
 * fit the budget renders as a bare `- <name>`.
 */
function extractSkillIds(request: ModelRequest): string[] {
  const text = requestText(request);
  const start = text.indexOf(SKILL_CATALOG_OPEN);
  if (start < 0) return [];
  const end = text.indexOf(SKILL_CATALOG_CLOSE, start);
  const block = text.slice(start, end < 0 ? undefined : end);
  const ids: string[] = [];
  for (const line of block.split("\n")) {
    const match = /^- ([^:\n]+?)(?::|$)/u.exec(line.trim());
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

/** The tool names the model request carries. */
function extractToolNames(request: ModelRequest): string[] {
  return (request.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === "string");
}

interface Booted {
  close(): Promise<void>;
}

const booted: Booted[] = [];
const stubs: Stub[] = [];
const previousDataDir = process.env.MINIMAX_DATA_DIR;
const previousBuildEnv = process.env.MAVIS_BUILD_ENV;
const previousRegion = process.env.MAVIS_REGION;

afterEach(async () => {
  for (const entry of booted.splice(0)) await entry.close();
  for (const stub of stubs.splice(0)) await stub.close();
  if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = previousDataDir;
  if (previousBuildEnv === undefined) delete process.env.MAVIS_BUILD_ENV;
  else process.env.MAVIS_BUILD_ENV = previousBuildEnv;
  if (previousRegion === undefined) delete process.env.MAVIS_REGION;
  else process.env.MAVIS_REGION = previousRegion;
});

describe("the real host, the capability surface a turn offers", () => {
  it(
    "offers the reviewed skills and tools",
    async () => {
      const stub = await startStubServer();
      stubs.push(stub);
      process.env.MAVIS_BUILD_ENV = "test";
      // The region decides which built-in skills are offered, so the gate pins
      // it instead of inheriting the machine's.
      process.env.MAVIS_REGION = "en";
      const reviewBaseUrl = stub.url.replace(/\/v1$/u, "");

      const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-capability-"));
      const workspaceDir = join(dataDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(
        join(dataDir, "config.yaml"),
        [
          `defaultModel: ${PROVIDER_ID}/${MODEL_ID}`,
          "permissionMode: bypassPermissions",
          "contentReview:",
          `  testBaseURL: ${reviewBaseUrl}`,
          // The external skill roots scan the user's home and the workspace
          // tree, so a machine with skills installed in `~/.agents/skills`
          // would otherwise change what this gate sees. The pinned surface is
          // the client's own built-in skills; the external ones are not the
          // client's to promise.
          "skills:",
          "  external:",
          "    enabled: false",
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
      // A real MCP server: the surface it contributes is the one the product
      // earns, not a stubbed tool list.
      const fixtureServer = join(
        dirname(fileURLToPath(import.meta.url)),
        "mcp-capability-fixture-server.mjs",
      );
      await writeFile(
        join(dataDir, "mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              [MCP_SERVER_NAME]: {
                command: process.execPath,
                args: [fixtureServer],
              },
            },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );

      process.env.MINIMAX_DATA_DIR = dataDir;
      (await import("@mavis/config")).resetConfig();

      const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
      const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");

      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "real-host-capability-surface",
      });
      booted.push({
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
        content: "what can you do?",
      });
      expect(sent.ok).toBe(true);

      await expect.poll(() => stub.requests.length, { timeout: 120_000 }).toBeGreaterThan(0);
      const request = JSON.parse(stub.requests[0]?.body ?? "{}") as ModelRequest;
      const skills = extractSkillIds(request).sort();
      const tools = extractToolNames(request).sort();

      // The three capabilities that went missing before, named one by one so
      // the failure says which one went.
      expect(skills).toContain("mcode-tools-master");
      expect(tools).toContain("web_search");
      expect(tools).toContain(MCP_TOOL_NAME);

      // And the whole surface, against the reviewed baseline.
      expect({ skills, tools }).toEqual({
        skills: [...CAPABILITY_SURFACE_BASELINE.skills].sort(),
        tools: [...CAPABILITY_SURFACE_BASELINE.tools].sort(),
      });
    },
    240_000,
  );
});
