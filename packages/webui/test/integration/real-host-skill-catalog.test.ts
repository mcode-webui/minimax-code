// The skill catalog a WebUI turn really hands to the model.
//
// `real-host-model-turn.test.ts` proves the turn reaches the model. This file
// proves what the model is told: the built-in skill catalog is rendered into
// the prompt, and the `beta.mcodeTools` capability switch decides whether the
// `mcode-tools-master` skill is part of it.
//
// The regression this pins is the readiness overwrite. The WebUI used to
// publish `beta.mcodeTools = mcodeTools.ready`, so a client whose mcode-tools
// host integration was not ready lost the skill from the catalog — and with it
// the Agent's only entry point for multimodal generation. The capability switch
// and the integration readiness are two different facts: the switch is the
// configured intent, readiness says whether this client can host the
// integration right now. Only the switch belongs in the catalog.
//
// The host is the production one, booted in an isolated data directory whose
// `config.yaml` is written before boot (`ensureConfigFile` would otherwise
// copy the developer's own config, and with it their api key, into the
// directory). The only fake part is the external model service: it answers the
// real content-review contract and the scripted turn, and records the request
// body — the rendered `<available_skills>` catalog lands in that body.
//
// `MINIMAX_DATA_DIR` is set before the assembly module is imported (the
// imports are dynamic on purpose) because that variable is what resolves both
// the data directory and the config path out of the operator's environment.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";

const MODEL_ID = "stub-model";
const PROVIDER_NAME = "stub";
const PROVIDER_ID = `custom_provider:${PROVIDER_NAME}`;
const SKILL_CATALOG_OPEN = "<available_skills>";
const SKILL_CATALOG_CLOSE = "</available_skills>";

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
        // The content-review gateway: the owner row requires a verdict before the
        // turn reaches the model, so the stub answers the real review contract.
        // The body carries both shapes: the V1 verdict (pass/safe) and the V2
        // verdict (action).
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

/** The rendered catalog block, or an empty string when the prompt carries none. */
function extractSkillCatalog(body: string): string {
  const start = body.indexOf(SKILL_CATALOG_OPEN);
  if (start < 0) return "";
  const end = body.indexOf(SKILL_CATALOG_CLOSE, start);
  if (end < 0) return "";
  return body.slice(start, end + SKILL_CATALOG_CLOSE.length);
}

interface Booted {
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

interface CatalogRun {
  readonly catalog: string;
  /** What the WebUI asked the mcode-tools integration for. */
  readonly requested: boolean;
  /** What the integration reported back. */
  readonly ready: boolean;
}

/**
 * Boot one real WebUI host in an isolated data directory, run one turn against
 * the stub model, and return the skill catalog the model was given.
 *
 * `betaMcodeTools` is what the isolated `config.yaml` declares. When it is
 * `undefined` the file carries no `beta` section at all, which leaves the
 * capability switch at its resolved default.
 */
async function runTurnAndReadCatalog(betaMcodeTools: boolean | undefined): Promise<CatalogRun> {
  const stub = await startStubServer();
  stubs.push(stub);
  // A test build honours a loopback content-review base URL, so the turn can
  // reach a real review endpoint instead of the placeholder host.
  process.env.MAVIS_BUILD_ENV = "test";
  const reviewBaseUrl = stub.url.replace(/\/v1$/u, "");

  const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-skill-catalog-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const betaSection =
    betaMcodeTools === undefined ? [] : ["beta:", `  mcodeTools: ${betaMcodeTools}`];
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      `defaultModel: ${PROVIDER_ID}/${MODEL_ID}`,
      // The owner row requires a content-review verdict before the turn reaches
      // the model.
      "contentReview:",
      `  testBaseURL: ${reviewBaseUrl}`,
      ...betaSection,
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
  // case's config.
  (await import("@mavis/config")).resetConfig();

  const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
  const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");

  let requested = false;
  const assembled = await createWebuiRuntimeHost({
    dataDir,
    appVersion: "real-host-skill-catalog",
    mcodeTools: {
      prepare: async (options: { requested: boolean }) => {
        requested = options.requested;
        // The integration is not available in this client: the embedded host
        // resources are absent and the broker cannot be started. Readiness is
        // about this client, not about the user's configured intent.
        return {
          requested: options.requested,
          ready: false,
          category: "host_unavailable" as const,
          ensureCommandPath: () => undefined,
          dispose: async () => undefined,
        };
      },
    },
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

  const sent = await port.sendMessage({ id: sessionId as string, content: "hello stub" });
  expect(sent.ok).toBe(true);

  await expect.poll(() => stub.requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const body = stub.requests[0]?.body ?? "";
  const catalog = extractSkillCatalog(body);
  return { catalog, requested, ready: false };
}

describe("real host, the skill catalog a turn receives", () => {
  it(
    "keeps the mcode-tools skill in the catalog when the host integration is not ready",
    async () => {
      // No `beta` section: the capability switch stays at its resolved value.
      const run = await runTurnAndReadCatalog(undefined);

      // The catalog itself was rendered into the prompt, and it carries the
      // skills that need no capability switch.
      expect(run.catalog).toContain(SKILL_CATALOG_OPEN);
      expect(run.catalog).toContain("miniapp-creator");

      // The switch is on, the integration is not ready, and the skill is still
      // there: readiness must not overwrite the capability switch.
      expect(run.requested).toBe(true);
      expect(run.catalog).toContain("mcode-tools-master");
    },
    180_000,
  );

  it(
    "drops the mcode-tools skill when the capability switch is off",
    async () => {
      const run = await runTurnAndReadCatalog(false);

      // The catalog was rendered — this is not an empty-prompt artifact.
      expect(run.catalog).toContain(SKILL_CATALOG_OPEN);
      expect(run.catalog).toContain("miniapp-creator");
      // The switch is off, so the beta-gated skill is not offered.
      expect(run.catalog).not.toContain("mcode-tools-master");
    },
    180_000,
  );
});
