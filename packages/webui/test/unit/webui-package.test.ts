// Test that the WebUI foundation registers correctly with the standalone
// distribution: package scope, manifest, license and own tsconfigs.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "../..");
const repoRoot = path.resolve(packageDir, "../..");

describe("webui package foundation", () => {
  it("declares a workspace manifest with an MIT license", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    expect(manifest.name).toBe("@mavis/webui");
    expect(manifest.license).toBe("MIT");
    expect(manifest.private).toBe(true);
    // Server, client and shared are deliberately NOT published subpaths:
    // the standalone CLI configuration is not asked to cover them
    // (ADR 0005 / acceptance criteria for ticket 01).
    expect(manifest.exports).toBeUndefined();
  });

  it("ships a license file matching the package declaration", () => {
    const licensePath = path.join(packageDir, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    expect(statSync(licensePath).size).toBeGreaterThan(200);
    expect(readFileSync(licensePath, "utf8")).toContain("MIT License");
  });

  it("lists the workspace in pnpm-workspace.yaml", () => {
    const workspace = readFileSync(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(workspace).toMatch(/packages\/webui/);
  });

  it("is listed in release/extraction.json packageRoots", () => {
    const extraction = JSON.parse(
      readFileSync(path.join(repoRoot, "release/extraction.json"), "utf8"),
    );
    expect(extraction.packageRoots).toContain("packages/webui");
  });

  it("has its own server and client TypeScript configuration", () => {
    expect(existsSync(path.join(packageDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(path.join(packageDir, "tsconfig.server.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(packageDir, "tsconfig.client.json"))).toBe(
      true,
    );
    const client = JSON.parse(
      readFileSync(path.join(packageDir, "tsconfig.client.json"), "utf8"),
    );
    expect(client.compilerOptions.jsx).toBe("react-jsx");
    expect(client.compilerOptions.lib).toContain("DOM");
  });

  it("does not ask the standalone CLI config to cover the WebUI", () => {
    const standalone = JSON.parse(
      readFileSync(
        path.join(repoRoot, "tsconfig.standalone.json"),
        "utf8",
      ),
    );
    const paths = standalone.compilerOptions.paths ?? {};
    expect(paths["@mavis/webui"]).toBeUndefined();
    expect(paths["@mavis/webui/client"]).toBeUndefined();
    expect(paths["@mavis/webui/server"]).toBeUndefined();
  });

  it("has its own build and boundary check scripts", () => {
    expect(existsSync(path.join(repoRoot, "scripts/build-webui.mjs"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(repoRoot, "scripts/check-webui-boundary.mjs")),
    ).toBe(true);
  });

  it("declares the place-holder server, client and shared sources", () => {
    expect(
      existsSync(path.join(packageDir, "src/server/index.ts")),
    ).toBe(true);
    expect(existsSync(path.join(packageDir, "src/client/main.tsx"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(packageDir, "src/shared/placeholder.ts")),
    ).toBe(true);
  });
});
