/**
 * The WebUI host environment for the mcode-tools CLI.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The bundled mcode-tools CLI and the host environment are two independent
 * facts. The Agent runs whatever `mcode-tools` resolves to on PATH — the CLI
 * bundled next to this client in a packaged build, the CLI installed
 * elsewhere on the machine in a client running from source — and what
 * authenticates it is the broker the host starts, never the bundled binary.
 *
 * The host used to start that broker only after the bundled CLI validated. A
 * client running from source ships no bundled CLI, so it ended up with no
 * broker at all, and the Agent went looking under the data directory for
 * another host's broker to get a token. These tests pin the fixed behaviour:
 * the broker starts and the host keys are installed even when the bundled CLI
 * is missing, and a separate process that inherits only those keys can lease a
 * token from it.
 *
 * The lease is served by the real broker over the real socket, and the token
 * is minted by the real session adapter. The negative control runs the same
 * child without the host keys and requires it to refuse, so the keys are
 * proven load-bearing rather than incidental.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWebuiAuthLeaseSession,
  prepareWebuiMcodeToolsIntegration,
  type WebuiMcodeToolsReadiness,
} from "../../src/runtime/mcode-tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fixture = path.join(here, "mcode-tools-lease-client.fixture.ts");
const HOST_TOKEN = "webui-host-lease-token";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("the WebUI mcode-tools host environment", () => {
  it("serves a lease to a child process that inherits only the host keys", async () => {
    // A client running from source has no bundled CLI next to its entry. The
    // host environment still has to come up, because that is what lets the
    // Agent drive the mcode-tools CLI installed elsewhere on the machine.
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-mcode-tools-data-"));
    const entryDir = await mkdtemp(path.join(os.tmpdir(), "webui-mcode-tools-entry-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    cleanups.push(() => rm(entryDir, { recursive: true, force: true }));

    const environment: Record<string, string | undefined> = {};
    const readiness = await prepareWebuiMcodeToolsIntegration({
      requested: true,
      dataDir,
      buildEnv: "dev",
      region: "cn",
      session: createWebuiAuthLeaseSession(
        () => ({ accessToken: HOST_TOKEN }),
        () => undefined,
      ),
      entryUrl: pathToFileURL(path.join(entryDir, "runtime.js")).href,
      environment,
    });
    cleanups.push(() => readiness.dispose());

    // The bundled CLI is absent, and the readiness says so — but the host
    // environment is live.
    expect(readiness.requested).toBe(true);
    expect(readiness.ready).toBe(true);
    expect(readiness.category).toBe("resource_unavailable");

    expect(environment.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE).toBe(process.execPath);
    expect(environment.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBeTruthy();
    expect(environment.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE).toBeTruthy();
    expect(environment.__MAVIS_MCODE_TOOLS_REGION).toBe("cn");
    expect(environment.__MAVIS_MCODE_TOOLS_CONFIG_DIR).toBe(
      path.join(dataDir, "integrations", "mcode-tools", "cn"),
    );

    // The child inherits the host keys and nothing else that could mint a
    // token, and it still gets one: the keys are the whole contract.
    const leased = await runLeaseClient({ ...environment, PATH: process.env.PATH });
    expect(leased.stderr).toBe("");
    expect(leased.code).toBe(0);
    const reported = JSON.parse(leased.stdout.trim()) as {
      provider: string;
      region: string;
      configDir: string;
      lease: { accessToken: string; audience: string; scopes: string[] };
    };
    expect(reported.provider).toBe("shared-broker");
    expect(reported.region).toBe("cn");
    expect(reported.configDir).toBe(
      path.join(dataDir, "integrations", "mcode-tools", "cn"),
    );
    expect(reported.lease.accessToken).toBe(HOST_TOKEN);
    expect(reported.lease.audience).toBe("agent-backend");
    expect(reported.lease.scopes).toEqual(["agent.default"]);

    // The negative control: without the host keys the child refuses, exactly
    // as the real CLI refuses to run without a host broker.
    const withoutHostKeys = await runLeaseClient({ PATH: process.env.PATH });
    expect(withoutHostKeys.code).toBe(2);
    expect(withoutHostKeys.stdout).toBe("");
  }, 60_000);

  it("reports the bundled CLI as available when it validates", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-mcode-tools-data-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

    const readiness = await prepareWebuiMcodeToolsIntegration(
      {
        requested: true,
        dataDir,
        buildEnv: "prod",
        region: "en",
        session: createWebuiAuthLeaseSession(
          () => ({ accessToken: HOST_TOKEN }),
          () => undefined,
        ),
        entryUrl: pathToFileURL(path.join(dataDir, "runtime.js")).href,
        environment: {},
      },
      {
        validateResource: (() => ({
          rootDir: "/bundled/mcode-tools",
          cliPath: "/bundled/mcode-tools/cli.mjs",
          manifest: {} as never,
        })) as never,
      },
    );
    cleanups.push(() => readiness.dispose());

    expect(readiness.ready).toBe(true);
    expect(readiness.category).toBe("ready");
  }, 60_000);

  it("starts no host environment when the capability is disabled", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-mcode-tools-data-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

    const environment: Record<string, string | undefined> = {};
    const readiness: WebuiMcodeToolsReadiness =
      await prepareWebuiMcodeToolsIntegration({
        requested: false,
        dataDir,
        buildEnv: "dev",
        region: "cn",
        session: createWebuiAuthLeaseSession(
          () => ({ accessToken: HOST_TOKEN }),
          () => undefined,
        ),
        entryUrl: pathToFileURL(path.join(dataDir, "runtime.js")).href,
        environment,
      });
    cleanups.push(() => readiness.dispose());

    expect(readiness.requested).toBe(false);
    expect(readiness.ready).toBe(false);
    expect(readiness.category).toBe("disabled");
    expect(environment.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBeUndefined();
  });
});

interface LeaseClientResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the lease client as a separate process, the way the mcode-tools CLI
 * runs: a fresh process that only inherits the environment the host installed.
 */
async function runLeaseClient(
  env: Record<string, string | undefined>,
): Promise<LeaseClientResult> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx/esm", fixture],
      {
        cwd: repoRoot,
        env: {
          ...env,
          TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.standalone.json"),
        },
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
