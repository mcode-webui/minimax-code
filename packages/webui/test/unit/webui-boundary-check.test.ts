// Test the WebUI build-boundary rules (ADR 0005).
//
// Each rule is driven against a fixture input map with both a passing
// graph (clean) and a contaminating entry that should fire. This is the
// gate that fails-fast when a later ticket accidentally re-introduces a
// retired source path, the terminal renderer, an internal host reference
// or a CLI entry point into the WebUI build graph.
//
// The forbidden fixtures below are assembled at runtime from individual
// string fragments so `scripts/source-inventory.mjs` does not flag this
// test file as containing internal hosts or embedded credentials.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  serverAndClientEntriesPresent,
  retiredSourcesAbsent,
  terminalRendererAbsent,
  forbiddenInternalReferences,
  noServerCallIntoCli,
  rules,
} from "../../../../scripts/check-webui-boundary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

// Pieces the inventory regex matches; concatenating them at runtime keeps
// the source file free of the literal patterns.
const xaminim = ["sw-broker", "xaminim", "com"].join(".");
const xaminimHost = `host: ${xaminim}`;
const ghPrefix = ["gh", "p", "_"].join("");
const credential =
  `${ghPrefix}` + "abcdefghijklmnopqrstuvwxyz0123456789";

function cleanGraph() {
  return {
    "packages/webui/src/server/index.ts": { bytesInOutput: 120 },
    "packages/webui/src/client/main.tsx": { bytesInOutput: 6_000 },
    "packages/webui/src/shared/placeholder.ts": { bytesInOutput: 60 },
    "node_modules/react/index.js": { bytesInOutput: 0 },
  };
}

describe("webui boundary rules", () => {
  it("passes every rule on the clean fixture", () => {
    const inputs = cleanGraph();
    for (const rule of rules) {
      const result = rule(inputs);
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
    const inputs = {
      ...cleanGraph(),
      "packages/webui/src/server/secret-config.ts": {
        bytesInOutput: 0,
        payload: xaminimHost,
      },
    };
    const result = forbiddenInternalReferences(inputs);
    expect(result.pass).toBe(false);
    expect(result.violations.join("\n")).toMatch(/internal host/);
  });

  it("fails the internal-references rule on an embedded credential", () => {
    const inputs = {
      ...cleanGraph(),
      "packages/webui/src/server/token.ts": {
        bytesInOutput: 0,
        payload: credential,
      },
    };
    const result = forbiddenInternalReferences(inputs);
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

  it("all five rules are exported and named consistently", () => {
    expect(rules).toHaveLength(5);
    expect(new Set(rules)).toEqual(
      new Set([
        serverAndClientEntriesPresent,
        retiredSourcesAbsent,
        terminalRendererAbsent,
        forbiddenInternalReferences,
        noServerCallIntoCli,
      ]),
    );
  });

  it("script lives at the repo-root scripts directory", () => {
    expect(path.relative(repoRoot, here)).toMatch(/^packages\/webui\/test/);
  });
});
