// Verify the WebUI's runtime-environment resolver (runtime-environment.ts).
//
// The WebUI hosts the same harness the terminal client uses, but it has no
// compile-time knowledge of `region` / `buildEnv` — without `MAVIS_REGION`
// and `MAVIS_BUILD_ENV` in this process's environment, `getRuntimeRegion()`
// falls back to `en` and `getRuntimeBuildEnv()` falls back to `dev`. That
// points the content-safety gateway at `matrix-overseas-test.example.invalid`,
// a placeholder domain that does not resolve, so input review fails with
// `failureKind: "transport"` / `transportKind: "dns"` and the service's
// one failure policy blocks the turn — see `content-safety.service.ts:35`.
// The result the user sees is the user message plus a `messages-rewound`
// frame, with no assistant content ever produced.
//
// The installed CLI writes the same three variables before it builds the
// host (`packages/tui/src/cli/environment.ts:40-72`); the WebUI does not,
// which is the regression this resolver was meant to cover.
//
// The scope comes from the OAuth namespace when it holds a login, so the two
// clients cannot disagree about which region the credential belongs to. The
// terminal client's private projection (`<dataDir>/cli-auth/**`) is not
// consulted. A fresh WebUI with no account scope defaults to cn/prod so its
// first account-login request reaches the production account service.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configureWebuiRuntimeEnvironment,
  type WebuiRuntimeScope,
} from "../../src/runtime/runtime-environment.js";

const RUNTIME_ENV_KEYS = [
  "MAVIS_REGION",
  "MAVIS_BUILD_ENV",
  "__MAVIS_RUNTIME_MANAGED",
] as const;

let dataDir: string;
let snapshot: Record<string, string | undefined>;

function captureProcessEnv(): void {
  snapshot = {};
  for (const key of RUNTIME_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
}

function restoreProcessEnv(): void {
  for (const key of RUNTIME_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearRuntimeEnv(): void {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Writes the OAuth namespace state file the core keeps for one scope.
 *
 * The credential itself stays inside the core's credential store; the state
 * file carries the scope, the status and the generation.
 */
function writeNamespace(
  buildEnv: string,
  region: string,
  options: {
    readonly status?: string;
    readonly stateBuildEnv?: string;
    readonly stateRegion?: string;
  } = {},
): void {
  writeJson(
    path.join(dataDir, "auth", buildEnv, region, "mcode-public", "auth-state.json"),
    {
      schemaVersion: 2,
      status: options.status ?? "authenticated",
      storeKind: "file",
      clientId: "mcode-public",
      scopes: ["agent.default"],
      audience: "agent-backend",
      buildEnv: options.stateBuildEnv ?? buildEnv,
      region: options.stateRegion ?? region,
      generation: 1,
    },
  );
}

function snapshotTarget(): Record<string, string | undefined> {
  const target: Record<string, string | undefined> = {};
  for (const key of RUNTIME_ENV_KEYS) target[key] = process.env[key];
  return target;
}

function expectedWriteEffect(
  scope: WebuiRuntimeScope | undefined,
): {
  MAVIS_REGION: string | undefined;
  MAVIS_BUILD_ENV: string | undefined;
  __MAVIS_RUNTIME_MANAGED: string | undefined;
} {
  if (!scope) {
    return {
      MAVIS_REGION: undefined,
      MAVIS_BUILD_ENV: undefined,
      __MAVIS_RUNTIME_MANAGED: undefined,
    };
  }
  return {
    MAVIS_REGION: scope.region,
    MAVIS_BUILD_ENV: scope.buildEnv,
    __MAVIS_RUNTIME_MANAGED: "1",
  };
}

beforeEach(() => {
  captureProcessEnv();
  clearRuntimeEnv();
  dataDir = mkdtempSync(path.join(os.tmpdir(), "webui-runtime-env-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  restoreProcessEnv();
});

describe("configureWebuiRuntimeEnvironment", () => {
  it("returns the scope the OAuth namespace holds and writes the three env vars", () => {
    writeNamespace("prod", "cn");

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({
      region: "cn",
      buildEnv: "prod",
      source: "oauth-namespace",
    });
    expect(snapshotTarget()).toEqual(expectedWriteEffect(scope));
  });

  it("defaults a fresh install to the China production account scope", () => {
    // A fresh install must be able to start the device-authorization flow;
    // en/dev resolves to an example.invalid endpoint that cannot be reached.
    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({ region: "cn", buildEnv: "prod", source: "default" });
    expect(snapshotTarget()).toEqual(expectedWriteEffect(scope));
  });

  it("ignores a namespace whose status is not a live login", () => {
    writeNamespace("prod", "cn", { status: "anonymous" });

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({ region: "cn", buildEnv: "prod", source: "default" });
    expect(snapshotTarget()).toEqual(expectedWriteEffect(scope));
  });

  it("ignores the terminal client's private projection", () => {
    // The projection names a scope of its own. The WebUI does not read it:
    // the scope comes from the OAuth namespace, so a terminal client and the
    // browser cannot end up pointed at different regions.
    writeJson(path.join(dataDir, "cli-auth", "shared-projection.json"), {
      version: 1,
      region: "en",
      buildEnv: "test",
    });

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({ region: "cn", buildEnv: "prod", source: "default" });

    clearRuntimeEnv();
    writeNamespace("prod", "cn");
    expect(configureWebuiRuntimeEnvironment({ dataDir })).toEqual({
      region: "cn",
      buildEnv: "prod",
      source: "oauth-namespace",
    });
  });

  it("lets an explicit MAVIS_REGION + MAVIS_BUILD_ENV win over the store", () => {
    writeNamespace("prod", "cn");
    process.env.MAVIS_REGION = "en";
    process.env.MAVIS_BUILD_ENV = "staging";

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({
      region: "en",
      buildEnv: "staging",
      source: "env",
    });
    expect(snapshotTarget()).toEqual(expectedWriteEffect(scope));
  });

  it("falls back to the store when only one of the two env vars is explicit", () => {
    // Mixed half-explicit input is exactly the case where two unrelated
    // resolution paths would disagree. The resolver treats explicit env as
    // complete or not at all, so a lone region falls back to the store.
    writeNamespace("prod", "cn");
    process.env.MAVIS_REGION = "en";

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({
      region: "cn",
      buildEnv: "prod",
      source: "oauth-namespace",
    });
    expect(snapshotTarget()).toEqual(expectedWriteEffect(scope));
  });

  it("refuses an explicit env var whose value the harness would reject", () => {
    // The same validation the harness applies (config.ts:120-151) keeps
    // `getRuntimeRegion()` from ever returning `zz`. The resolver matches
    // it so an invalid literal cannot poison the runtime.
    writeNamespace("prod", "cn");
    process.env.MAVIS_REGION = "zz";

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({
      region: "cn",
      buildEnv: "prod",
      source: "oauth-namespace",
    });
  });

  it("refuses a namespace whose state names a scope the store does not sit in", () => {
    // A state file is whatever the core wrote. The resolver checks the scope
    // it names against the scope it sits in, so a file that was moved cannot
    // point the runtime at a region the credential was not issued for.
    writeNamespace("prod", "cn", { stateRegion: "en" });

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({ region: "cn", buildEnv: "prod", source: "default" });
    expect(snapshotTarget()).toEqual(expectedWriteEffect(scope));
  });

  it("does not clobber an explicit __MAVIS_RUNTIME_MANAGED=0", () => {
    writeNamespace("prod", "cn");
    process.env.__MAVIS_RUNTIME_MANAGED = "0";

    const scope = configureWebuiRuntimeEnvironment({ dataDir });

    expect(scope).toEqual({
      region: "cn",
      buildEnv: "prod",
      source: "oauth-namespace",
    });
    expect(process.env.__MAVIS_RUNTIME_MANAGED).toBe("0");
  });

  it("writes through an injectable target instead of process.env", () => {
    writeNamespace("prod", "cn");

    const target: Record<string, string | undefined> = {};
    const scope = configureWebuiRuntimeEnvironment({ dataDir, target });

    expect(scope).toEqual({
      region: "cn",
      buildEnv: "prod",
      source: "oauth-namespace",
    });
    expect(target.MAVIS_REGION).toBe("cn");
    expect(target.MAVIS_BUILD_ENV).toBe("prod");
    expect(target.__MAVIS_RUNTIME_MANAGED).toBe("1");
    // The injected target must not leak into process.env — the runtime
    // host reads from process.env via getRuntimeRegion / getRuntimeBuildEnv.
    expect(process.env.MAVIS_REGION).toBeUndefined();
    expect(process.env.MAVIS_BUILD_ENV).toBeUndefined();
    expect(process.env.__MAVIS_RUNTIME_MANAGED).toBeUndefined();
  });

  it("writes the first-run account scope to an injected environment", () => {
    const target: Record<string, string | undefined> = {};

    const scope = configureWebuiRuntimeEnvironment({ dataDir, target });

    expect(scope).toEqual({ region: "cn", buildEnv: "prod", source: "default" });
    expect(target.MAVIS_REGION).toBe("cn");
    expect(target.MAVIS_BUILD_ENV).toBe("prod");
    expect(target.__MAVIS_RUNTIME_MANAGED).toBe("1");
    expect(process.env.MAVIS_REGION).toBeUndefined();
    expect(process.env.MAVIS_BUILD_ENV).toBeUndefined();
    expect(process.env.__MAVIS_RUNTIME_MANAGED).toBeUndefined();
  });
});
