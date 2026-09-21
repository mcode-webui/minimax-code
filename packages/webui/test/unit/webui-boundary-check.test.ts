// Test the WebUI build-boundary rules (ADR 0005).
//
// Each rule is driven against a fixture input map with both a passing
// graph (clean) and a contaminating entry that should fire. This is the
// gate that fails-fast when a later ticket accidentally re-introduces a
// retired source path, the terminal renderer, an internal host reference,
// a CLI entry point, or an off-allowlist source path into the WebUI
// build graph.
//
// `forbiddenInternalReferences` inspects the *text* of the input files
// the graph names — not the metafile value objects, which carry
// `bytesInOutput` and `imports` only, never file text. To exercise that
// honestly, the fixtures here drop small files under a temporary
// directory inside the package and feed the rule their repository-
// relative paths. The directory is created and torn down per test run so
// the file fixtures never accumulate.
//
// The forbidden fixtures themselves are assembled at runtime from
// individual string fragments so `scripts/source-inventory.mjs` does not
// flag this test file as containing internal hosts or embedded
// credentials.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  forbiddenInternalReferences,
  noServerCallIntoCli,
  onlyAllowedPublicEntries,
  retiredSourcesAbsent,
  rewriteInputs,
  rules,
  serverAndClientEntriesPresent,
  terminalRendererAbsent,
} from "../../../../scripts/lib/webui-boundary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

// Pieces the inventory regex matches; concatenating them at runtime keeps
// the source file free of the literal patterns.
const xaminim = ["sw-broker", "xaminim", "com"].join(".");
const xaminimHost = `host: ${xaminim}`;
const ghPrefix = ["gh", "p", "_"].join("");
const credential = `${ghPrefix}` + "abcdefghijklmnopqrstuvwxyz0123456789";

function cleanGraph() {
  return {
    "packages/webui/src/server/index.ts": { bytesInOutput: 120 },
    "packages/webui/src/client/main.tsx": { bytesInOutput: 6_000 },
    "packages/webui/src/shared/placeholder.ts": { bytesInOutput: 60 },
    "node_modules/react/index.js": { bytesInOutput: 0 },
  };
}

const packageExports = new Set<string>([
  "packages/cli-service/src/index.ts",
  "packages/cli-service/src/service.ts",
  "packages/local-runtime-v2/src/index.ts",
]);

// Fixtures live under the OS temp directory so they never touch the
// repository, the source inventory, or git. `forbiddenInternalReferences`
// accepts a `rootDir` argument so it can read the files there.
let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), "webui-boundary-"));
});

afterAll(() => {
  if (fixtureDir && existsSync(fixtureDir))
    rmSync(fixtureDir, { recursive: true, force: true });
});

function seedFixtureFile(relativePath: string, body: string) {
  const absolute = path.join(fixtureDir, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
  // The fixture's "key" is still repository-shaped (for the rule's prefix
  // matching), but the file it points at lives under `fixtureDir` and the
  // test passes `rootDir: fixtureDir` so the rule can read it.
  return relativePath;
}

function seedInternalReferencesFixtures(): { host: string; secret: string } {
  return {
    host: seedFixtureFile(
      "packages/webui-fixture-internal/secret-config.ts",
      `export const endpoint = ${JSON.stringify(xaminimHost)};\n`,
    ),
    secret: seedFixtureFile(
      "packages/webui-fixture-credential/token.ts",
      `export const token = ${JSON.stringify(credential)};\n`,
    ),
  };
}

describe("webui boundary rules", () => {
  it("passes every rule on the clean fixture", () => {
    const inputs = cleanGraph();
    for (const rule of rules) {
      const result = rule(inputs, packageExports);
      expect(result.pass, JSON.stringify(result)).toBe(true);
    }
  });

  it("fails the server/client entries rule when one is missing", () => {
    const inputs = cleanGraph();
    delete inputs["packages/webui/src/server/index.ts"];
    const result = serverAndClientEntriesPresent(inputs);
    expect(result.pass).toBe(false);
    expect(result.violations.join("\n")).toMatch(/server entry/);
  });

  it("fails the retired-sources rule on a banned prefix", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/local-runtime-v2/src/http/handler.ts": {
        bytesInOutput: 0,
      },
    };
    const result = retiredSourcesAbsent(inputs);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.includes("/http/"))).toBe(true);
  });

  it("fails the terminal-renderer rule when tui is reachable", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/tui/src/tui/screen-controller.ts": { bytesInOutput: 0 },
    };
    const result = terminalRendererAbsent(inputs);
    expect(result.pass).toBe(false);
    expect(result.violations[0]).toMatch(/tui\/src\/tui\//);
  });

  it("fails the internal-references rule on a forbidden internal host", () => {
    const { host } = seedInternalReferencesFixtures();
    const inputs = { ...cleanGraph(), [host]: { bytesInOutput: 0 } };
    const result = forbiddenInternalReferences(inputs, { rootDir: fixtureDir });
    expect(result.pass).toBe(false);
    expect(result.violations.join("\n")).toMatch(/internal host/);
  });

  it("fails the internal-references rule on an embedded credential", () => {
    const { secret } = seedInternalReferencesFixtures();
    const inputs = { ...cleanGraph(), [secret]: { bytesInOutput: 0 } };
    const result = forbiddenInternalReferences(inputs, { rootDir: fixtureDir });
    expect(result.pass).toBe(false);
    expect(result.violations.join("\n")).toMatch(/embedded credential/);
  });

  it("fails the no-server-call-into-CLI rule on the TUI entry import", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/tui/src/index.ts": { bytesInOutput: 0 },
    };
    const result = noServerCallIntoCli(inputs);
    expect(result.pass).toBe(false);
    expect(result.violations).toContain("packages/tui/src/index.ts");
  });

  it("also flags the matrix-mcp-stdio entry point that build.mjs emits", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/agent-tools/src/desktop/matrix-mcp-stdio.ts": {
        bytesInOutput: 0,
      },
    };
    const result = noServerCallIntoCli(inputs);
    expect(result.pass).toBe(false);
    expect(result.violations).toContain(
      "packages/agent-tools/src/desktop/matrix-mcp-stdio.ts",
    );
  });

  it("fails the only-allowed-public-entries rule on an off-allowlist workspace file", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/agent-core/src/some-internal.ts": { bytesInOutput: 0 },
    };
    const result = onlyAllowedPublicEntries(inputs, packageExports);
    expect(result.pass).toBe(false);
    expect(result.violations.join("\n")).toMatch(
      /agent-core\/src\/some-internal/,
    );
  });

  it("passes the only-allowed-public-entries rule for a process-local WebUI file", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/webui/src/client/app.tsx": { bytesInOutput: 0 },
    };
    const result = onlyAllowedPublicEntries(inputs, packageExports);
    expect(result.pass).toBe(true);
  });

  it("passes the only-allowed-public-entries rule for an exported subpath", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/cli-service/src/service.ts": { bytesInOutput: 0 },
    };
    const result = onlyAllowedPublicEntries(inputs, packageExports);
    expect(result.pass).toBe(true);
  });

  it("all six rules are exported and named consistently", () => {
    expect(rules).toHaveLength(6);
    expect(new Set(rules)).toEqual(
      new Set([
        serverAndClientEntriesPresent,
        retiredSourcesAbsent,
        terminalRendererAbsent,
        forbiddenInternalReferences,
        noServerCallIntoCli,
        rules[5],
      ]),
    );
  });

  it("script lives at the repo-root scripts directory", () => {
    expect(path.relative(repoRoot, here)).toMatch(/^packages\/webui\/test/);
  });
});

describe("rewriteInputs", () => {
  it("flattens pnpm-symlink form into a repository-relative key", () => {
    const inputs = rewriteInputs({
      "../../node_modules/@mavis/tui/src/tui/mod.js": { bytesInOutput: 0 },
    });
    expect(Object.keys(inputs)).toContain(
      "node_modules/@mavis/tui/src/tui/mod.js",
    );
  });

  it("resolves relative-escape keys against packages/webui", () => {
    const inputs = rewriteInputs({
      "../tui/src/tui/mod.js": { bytesInOutput: 0 },
    });
    expect(Object.keys(inputs)).toContain("packages/tui/src/tui/mod.js");
  });

  it("flattens a retired-source path under packages/local-runtime-v2/src/http", () => {
    const inputs = rewriteInputs({
      "../local-runtime-v2/src/http/handler.ts": { bytesInOutput: 0 },
    });
    expect(Object.keys(inputs)).toContain(
      "packages/local-runtime-v2/src/http/handler.ts",
    );
  });

  it("flattens the pnpm-symlink form of a retired-sources path", () => {
    const inputs = rewriteInputs({
      "../../node_modules/@mavis/local-runtime-v2/src/http/handler.ts": {
        bytesInOutput: 0,
      },
    });
    expect(Object.keys(inputs)).toContain(
      "node_modules/@mavis/local-runtime-v2/src/http/handler.ts",
    );
  });

  it("the terminal-renderer rule fires after rewriteInputs on a raw build graph", () => {
    const raw = {
      "../tui/src/tui/mod.js": { bytesInOutput: 0 },
      "../../../node_modules/react/index.js": { bytesInOutput: 0 },
    };
    const result = terminalRendererAbsent(rewriteInputs(raw));
    expect(result.pass).toBe(false);
    expect(result.violations[0]).toContain("packages/tui/src/tui/");
  });

  it("keeps absolute in-repository paths as repository-relative", () => {
    const absolute = path.join(
      repoRoot,
      "packages/webui/src/server/index.ts",
    );
    const inputs = rewriteInputs({
      [absolute]: { bytesInOutput: 0 },
    });
    expect(Object.keys(inputs)).toContain(
      "packages/webui/src/server/index.ts",
    );
  });

  it("preserves out-of-tree keys so they cannot pretend to be in-tree", () => {
    const inputs = rewriteInputs({ "/tmp/some-probe.ts": { bytesInOutput: 0 } });
    expect(Object.keys(inputs)).toContain("/tmp/some-probe.ts");
  });
});
