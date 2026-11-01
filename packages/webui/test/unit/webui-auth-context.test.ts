// Verify the WebUI's own account credential (auth-context.ts).
//
// Managed MiniMax login carries no API key: the runtime authenticates with an
// OAuth access token, so the assembly must hand over the getter and invalidator
// for that token. The harness defaults both to undefined when an assembly
// supplies neither — which is why every turn used to fail at the agent
// preflight with "managed OAuth bearer is not synced", with the credential
// sitting unread in the data directory the whole time.
//
// The credential is the WebUI's own now. It used to be read out of the
// terminal client's private projection (`<dataDir>/cli-auth/**`), which made
// the WebUI a reader of another client's store: the token it served was the
// terminal client's, and the WebUI could not be signed out of it. These cases
// pin the ownership that replaced it:
//
//   * the scope is resolved from the OAuth namespace — the same state files
//     the terminal client resolves its own scope from, so the two clients
//     cannot disagree about which region the credential belongs to;
//   * the reader serves the credential the WebUI's own auth session publishes,
//     and nothing else;
//   * a token the runtime reported as rejected is withheld until a different
//     one is published.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWebuiAuthContextReader,
  resolveAuthScope,
} from "../../src/runtime/auth-context.js";

const TOKEN = "token-from-the-webui-session";
const RENEWED_TOKEN = "token-after-the-renewal";

let dataDir: string;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Writes the OAuth namespace state file the core keeps for one scope.
 *
 * The credential itself stays inside the core's credential store; the state
 * file carries the scope, the status and the generation, and it is what both
 * clients resolve their scope from.
 */
function writeNamespace(
  buildEnv: string,
  region: string,
  options: {
    readonly status?: string;
    readonly clientId?: string;
    readonly stateRegion?: string;
    readonly stateBuildEnv?: string;
    /** The file's modification time, in seconds since the epoch. */
    readonly modifiedAtSeconds?: number;
  } = {},
): string {
  const directory = path.join(dataDir, "auth", buildEnv, region, "mcode-public");
  const statePath = path.join(directory, "auth-state.json");
  writeJson(statePath, {
    schemaVersion: 2,
    status: options.status ?? "authenticated",
    storeKind: "file",
    clientId: options.clientId ?? "mcode-public",
    scopes: ["agent.default"],
    audience: "agent-backend",
    buildEnv: options.stateBuildEnv ?? buildEnv,
    region: options.stateRegion ?? region,
    generation: 1,
  });
  if (options.modifiedAtSeconds !== undefined) {
    const seconds = options.modifiedAtSeconds;
    utimesSync(statePath, seconds, seconds);
  }
  return statePath;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "webui-auth-context-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the account scope", () => {
  it("is undefined when no namespace carries a login", () => {
    expect(resolveAuthScope(dataDir)).toBeUndefined();
  });

  it("comes from the namespace that holds a login", () => {
    writeNamespace("prod", "cn");
    expect(resolveAuthScope(dataDir)).toEqual({ buildEnv: "prod", region: "cn" });
  });

  it("is the most recently active namespace", () => {
    writeNamespace("prod", "cn", { modifiedAtSeconds: 1_000 });
    writeNamespace("test", "en", { modifiedAtSeconds: 2_000 });
    expect(resolveAuthScope(dataDir)).toEqual({ buildEnv: "test", region: "en" });
  });

  it("refuses a namespace whose status is not a live login", () => {
    writeNamespace("prod", "cn", { status: "anonymous" });
    expect(resolveAuthScope(dataDir)).toBeUndefined();
  });

  it("refuses a state file that belongs to another client or another scope", () => {
    writeNamespace("prod", "cn", { clientId: "someone-else" });
    expect(resolveAuthScope(dataDir)).toBeUndefined();

    writeNamespace("prod", "cn", { stateRegion: "en" });
    expect(resolveAuthScope(dataDir)).toBeUndefined();
  });

  it("ignores the terminal client's private projection", () => {
    // The projection the terminal client writes names a scope of its own. The
    // WebUI does not read it: the scope comes from the OAuth namespace, so
    // the two clients cannot end up pointed at different regions.
    writeJson(path.join(dataDir, "cli-auth", "shared-projection.json"), {
      version: 1,
      region: "en",
      buildEnv: "test",
    });
    expect(resolveAuthScope(dataDir)).toBeUndefined();

    writeNamespace("prod", "cn");
    expect(resolveAuthScope(dataDir)).toEqual({ buildEnv: "prod", region: "cn" });
  });
});

describe("the WebUI's own credential reader", () => {
  it("serves nothing before the session publishes a credential", () => {
    const reader = createWebuiAuthContextReader();
    expect(reader.getter()).toBeUndefined();
  });

  it("serves the credential the session published", () => {
    const reader = createWebuiAuthContextReader();
    reader.setAuthContext({ accessToken: TOKEN, realUserID: "user-1" });
    expect(reader.getter()).toEqual({ accessToken: TOKEN, realUserID: "user-1" });
  });

  it("withholds a token the runtime reported as rejected", () => {
    const reader = createWebuiAuthContextReader();
    reader.setAuthContext({ accessToken: TOKEN });
    expect(reader.getter()?.accessToken).toBe(TOKEN);

    reader.invalidator(TOKEN);
    expect(reader.getter()).toBeUndefined();
  });

  it("serves a different token after the rejection", () => {
    // A rejection is per credential, not per process: an unrelated renewal is
    // not a reason to distrust the account.
    const reader = createWebuiAuthContextReader();
    reader.setAuthContext({ accessToken: TOKEN });
    reader.invalidator(TOKEN);
    reader.setAuthContext({ accessToken: RENEWED_TOKEN });
    expect(reader.getter()?.accessToken).toBe(RENEWED_TOKEN);
  });

  it("serves a newer login epoch of the same token", () => {
    // The epoch is what tells two logins apart. A rejection made in one login
    // must not withhold the same token from a later one.
    const reader = createWebuiAuthContextReader();
    reader.setAuthContext({ accessToken: TOKEN, loginEpoch: "epoch-1" });
    reader.invalidator(TOKEN, "epoch-1");
    expect(reader.getter()).toBeUndefined();

    reader.setAuthContext({ accessToken: TOKEN, loginEpoch: "epoch-2" });
    expect(reader.getter()?.accessToken).toBe(TOKEN);
  });

  it("forgets the credential when the session clears it", () => {
    const reader = createWebuiAuthContextReader();
    reader.setAuthContext({ accessToken: TOKEN });
    reader.setAuthContext(undefined);
    expect(reader.getter()).toBeUndefined();
  });
});
