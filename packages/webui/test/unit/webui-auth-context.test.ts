// Verify the WebUI's account credential adapter (auth-context.ts).
//
// Managed MiniMax login carries no API key: the runtime authenticates with an
// OAuth access token. Assembly step 3 of `docs/webui-v1-scope.md` requires the
// getter and invalidator that hand that token over, and the harness defaults
// both to undefined when an assembly supplies neither — which is why every turn
// used to fail at the agent preflight with "managed OAuth bearer is not synced",
// with the credential sitting unread in the data directory the whole time.
//
// The layout exercised here is the one `packages/tui/src/auth/storage.ts`
// writes, and ADR 0003 forbids importing that reader, so these cases pin the
// behaviour this adapter has to match deliberately rather than by import.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWebuiAuthContextReader,
  readWebuiAuthContext,
  resolveAuthScope,
} from "../../src/runtime/auth-context.js";

const TOKEN = "token-from-the-installed-client";
const RENEWED_TOKEN = "token-after-upstream-renewal";

let dataDir: string;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Writes the `cli-auth/<buildEnv>/<region>` directory the client owns. */
function writeScope(
  buildEnv: string,
  region: string,
  options: {
    readonly token?: string;
    readonly scopeRegion?: string;
    readonly scopeVersion?: number;
    readonly authVersion?: number;
    /**
     * Whether the directory should also carry `local-runtime.auth.json`.
     * Defaults to true; pass `false` to leave the directory with only
     * its scope file, which is exactly the layout that would strand
     * the runtime on a stale projection if the resolver did not check
     * that the directory behind it can supply a credential.
     */
    readonly credential?: boolean;
  } = {},
): string {
  const directory = path.join(dataDir, "cli-auth", buildEnv, region);
  writeJson(path.join(directory, "cli-auth.scope.json"), {
    version: options.scopeVersion ?? 1,
    updatedAtMs: 1,
    region: options.scopeRegion ?? region,
    buildEnv,
  });
  if (options.credential !== false) {
    writeJson(path.join(directory, "local-runtime.auth.json"), {
      version: options.authVersion ?? 1,
      updatedAtMs: 1,
      auth: {
        accessToken: options.token ?? TOKEN,
        realUserID: "user-1",
      },
    });
  }
  return directory;
}

/** Writes the record naming the scope the client last used. */
function writeProjection(buildEnv: string, region: string): void {
  writeJson(path.join(dataDir, "cli-auth", "shared-projection.json"), {
    version: 1,
    region,
    buildEnv,
    authFingerprint: "sha256:test",
    updatedAtMs: 1,
  });
}

function setStoredToken(
  buildEnv: string,
  region: string,
  token: string,
): void {
  writeJson(
    path.join(dataDir, "cli-auth", buildEnv, region, "local-runtime.auth.json"),
    { version: 1, updatedAtMs: 2, auth: { accessToken: token, realUserID: "user-1" } },
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "webui-auth-context-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WebUI auth context", () => {
  it("returns nothing when the client left no store behind", () => {
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();
  });

  it("reads the credential of the scope the client last projected", () => {
    writeScope("prod", "cn");
    writeProjection("prod", "cn");
    expect(readWebuiAuthContext(dataDir)).toEqual({
      accessToken: TOKEN,
      realUserID: "user-1",
    });
  });

  it("falls back to scanning when no projection was written", () => {
    writeScope("prod", "cn");
    expect(readWebuiAuthContext(dataDir)).toEqual({
      accessToken: TOKEN,
      realUserID: "user-1",
    });
  });

  it("prefers the projected scope over another scope that also carries a token", () => {
    writeScope("prod", "cn", { token: "prod-cn-token" });
    writeScope("dev", "en", { token: "dev-en-token" });
    writeProjection("dev", "en");
    expect(readWebuiAuthContext(dataDir)?.accessToken).toBe("dev-en-token");
  });

  it("refuses a scope record that disagrees with the directory it sits in", () => {
    // A credential is bound to a scope by its scope file; a directory claiming
    // one scope while sitting under another is not a live login.
    writeScope("prod", "cn", { scopeRegion: "en" });
    writeProjection("prod", "cn");
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();
    // The scan path derives its scope from the path, so it refuses it too.
    rmSync(path.join(dataDir, "cli-auth", "shared-projection.json"), { force: true });
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();
  });

  it("refuses a blank token, an unknown record version, and malformed JSON", () => {
    writeScope("prod", "cn", { token: "   " });
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();

    writeScope("prod", "cn", { authVersion: 2 });
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();

    writeScope("prod", "cn", { scopeVersion: 2 });
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();

    writeFileSync(
      path.join(dataDir, "cli-auth", "prod", "cn", "local-runtime.auth.json"),
      "{ not json",
      "utf8",
    );
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();
  });

  it("serves a cached read inside the window and re-reads after it", () => {
    writeScope("prod", "cn");
    writeProjection("prod", "cn");
    let now = 1_000;
    const reader = createWebuiAuthContextReader(dataDir, { nowMs: () => now });

    expect(reader.getter()?.accessToken).toBe(TOKEN);
    // A renewal upstream is not visible while the cache holds.
    setStoredToken("prod", "cn", RENEWED_TOKEN);
    now += 1_000;
    expect(reader.getter()?.accessToken).toBe(TOKEN);
    // Past the window the read is repeated, so the renewal lands.
    now += 5_000;
    expect(reader.getter()?.accessToken).toBe(RENEWED_TOKEN);
  });

  it("withholds a token the runtime reported as rejected", () => {
    writeScope("prod", "cn");
    writeProjection("prod", "cn");
    const reader = createWebuiAuthContextReader(dataDir, { nowMs: () => 1_000 });

    expect(reader.getter()?.accessToken).toBe(TOKEN);
    reader.invalidator(TOKEN);
    expect(reader.getter()).toBeUndefined();
    // The rejection is per token: a renewal upstream is served again.
    setStoredToken("prod", "cn", RENEWED_TOKEN);
    expect(reader.getter()?.accessToken).toBe(RENEWED_TOKEN);
  });

  it("re-reads immediately after invalidation rather than waiting out the window", () => {
    writeScope("prod", "cn");
    writeProjection("prod", "cn");
    const reader = createWebuiAuthContextReader(dataDir, { nowMs: () => 1_000 });

    expect(reader.getter()?.accessToken).toBe(TOKEN);
    setStoredToken("prod", "cn", RENEWED_TOKEN);
    reader.invalidator();
    expect(reader.getter()?.accessToken).toBe(RENEWED_TOKEN);
  });

  it("refuses a projection that names a scope whose directory carries no credential", () => {
    // Shape B: a stale projection that names prod/cn, but that
    // directory exists only as a scope file (no auth). The resolver
    // must NOT adopt that scope — adopting it would strand the
    // runtime on the OAuth-preflight failure
    // (`managed OAuth bearer is not synced`) for a different cause
    // than the credential gap. The credential reader returns undefined
    // and `resolveAuthScope` agrees.
    writeScope("prod", "cn", { credential: false });
    writeProjection("prod", "cn");
    expect(readWebuiAuthContext(dataDir)).toBeUndefined();
    expect(resolveAuthScope(dataDir)).toBeUndefined();
  });

  it("falls through to a different scope when the projection names a scope with no credential", () => {
    // Shape C: the projection names prod/cn but its directory has no
    // credential; only the test/en directory does. The credential
    // reader and the scope resolver must both pick test/en — they
    // agree by construction.
    writeScope("prod", "cn", { credential: false });
    writeScope("test", "en");
    writeProjection("prod", "cn");
    expect(readWebuiAuthContext(dataDir)?.accessToken).toBe(TOKEN);
    expect(resolveAuthScope(dataDir)).toEqual({
      region: "en",
      buildEnv: "test",
    });
  });

  it("lets the scan pick the first directory with a credential when the projection is missing", () => {
    // Shape B': two scoped directories exist, but only the second
    // carries a credential. The scan walks sorted buildEnvs (`dev` <
    // `prod`) and skips `dev/en` because its credential read fails —
    // so `prod/cn` wins. Both consumers must agree.
    writeScope("dev", "en", { credential: false });
    writeScope("prod", "cn");
    expect(readWebuiAuthContext(dataDir)?.accessToken).toBe(TOKEN);
    expect(resolveAuthScope(dataDir)).toEqual({
      region: "cn",
      buildEnv: "prod",
    });
  });

  it("agrees with the runtime scope resolver on every shape", () => {
    // The same five shapes the operator script reproduces. Both
    // consumers — the OAuth bearer the credential reader serves and
    // the `MAVIS_REGION` / `MAVIS_BUILD_ENV` the runtime-environment
    // resolver writes — must agree on the scope they adopt, including
    // the no-op `undefined` case. A mutation that drops the
    // credential guard on either side would diverge here.
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly projection?: { region: string; buildEnv: string };
      readonly dirs: ReadonlyArray<{
        region: string;
        buildEnv: string;
        credential: boolean;
      }>;
    }> = [
      {
        label: "A. projection prod/cn + that directory HAS a credential",
        projection: { region: "cn", buildEnv: "prod" },
        dirs: [{ region: "cn", buildEnv: "prod", credential: true }],
      },
      {
        label: "B. projection prod/cn + that directory has NO credential",
        projection: { region: "cn", buildEnv: "prod" },
        dirs: [{ region: "cn", buildEnv: "prod", credential: false }],
      },
      {
        label: "C. projection prod/cn + credential only under a DIFFERENT scope",
        projection: { region: "cn", buildEnv: "prod" },
        dirs: [
          { region: "cn", buildEnv: "prod", credential: false },
          { region: "en", buildEnv: "test", credential: true },
        ],
      },
      {
        label: "D. no projection + one directory with a credential",
        dirs: [{ region: "cn", buildEnv: "prod", credential: true }],
      },
      {
        label: "E. nothing at all",
        dirs: [],
      },
    ];
    for (const { label, projection, dirs } of cases) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "webui-agree-"));
      try {
        if (projection) {
          writeJson(path.join(dir, "cli-auth", "shared-projection.json"), {
            version: 1,
            ...projection,
          });
        }
        for (const entry of dirs) {
          writeJson(
            path.join(dir, "cli-auth", entry.buildEnv, entry.region, "cli-auth.scope.json"),
            { version: 1, region: entry.region, buildEnv: entry.buildEnv },
          );
          if (entry.credential) {
            writeJson(
              path.join(dir, "cli-auth", entry.buildEnv, entry.region, "local-runtime.auth.json"),
              {
                version: 1,
                auth: { accessToken: TOKEN, realUserID: "u1" },
              },
            );
          }
        }
        const scope = resolveAuthScope(dir);
        const auth = readWebuiAuthContext(dir);
        // One decision, two consumers. The scope is `undefined` exactly
        // when the credential is `undefined`; otherwise the scope and
        // the credential come from the same directory.
        if (scope === undefined) {
          expect(auth, label).toBeUndefined();
        } else {
          expect(auth, label).toBeDefined();
          // The scope that adopted the credential must match what the
          // credential reader served — no projection / scan mismatch.
          const dirKey = `${scope.buildEnv}/${scope.region}`;
          expect(dirKey, label).toBe(`${dirs.find((d) => d.credential)?.buildEnv}/${dirs.find((d) => d.credential)?.region}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
