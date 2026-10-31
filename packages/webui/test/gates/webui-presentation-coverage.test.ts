// Tests for the WebUI presentation-coverage gate (ADR 0028).
//
// The gate's job is to keep the classification true: every client UI module is
// classified, no entry outlives its module, and no entry carries a disposition,
// kind or family the ADR does not define. Those three failures each get a
// negative fixture below, built in a temporary directory so
// `scripts/source-inventory.mjs` never sees them.
//
// What the gate cannot do is decided by the ADR: it cannot see a surface added
// inside an already classified module. The fixtures therefore also pin the
// report that stands in for that — a module whose rendered vocabulary moved is
// reported for review and does not fail — and pin that the report is about the
// rendered vocabulary rather than about every edit.

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CLIENT_SOURCE_DIRECTORY,
  DISPOSITIONS,
  FAMILIES,
  INVENTORY_FILE,
  discoverPresentationModules,
  evaluatePresentationCoverage,
  isPresentationModule,
  parseInventory,
  type PresentationModule,
  recordReviewedSignatures,
  serializeInventory,
  sharedHomeValueImports,
  surfaceSignature,
} from "../../../../scripts/lib/webui-presentation-coverage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const cliPath = path.join(repoRoot, "scripts/check-webui-presentation.mjs");

vi.setConfig({ testTimeout: 30_000 });

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

const SHARED_DROPDOWN = `
export function Dropdown(): JSX.Element {
  return <div role="menu"><button type="button">Open</button></div>;
}
`;

const PROVIDER_FORM = `
export function ProviderFormPanel(): JSX.Element {
  return <form><input name="model" /><button type="submit">Save</button></form>;
}
`;

const ARCHON_SHELL = `
export function ArchonShell(): JSX.Element {
  return <main className="shell">{null}</main>;
}
`;

/**
 * A client tree with one module in each of the three presentation homes, plus
 * two files the gate must not treat as presentation modules.
 */
function buildClientTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "webui-presentation-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return root;
}

const baseTree = () =>
  buildClientTree({
    "ui/Dropdown.tsx": SHARED_DROPDOWN,
    "features/models/ui/ProviderFormPanel.tsx": PROVIDER_FORM,
    "shell/ArchonShell.tsx": ARCHON_SHELL,
    // Not presentation modules: a role directory is flat, and an application
    // file is not presentation.
    "features/models/ui/nested/Inner.tsx": "export const Inner = () => null;\n",
    "features/models/application/commands.ts": "export const command = 1;\n",
  });

interface TestEntry {
  path: string;
  label: string;
  kind: string;
  families: string[];
  disposition: string;
  reason?: string;
  revisit?: string;
}

interface TestInventory {
  version: number;
  entries: TestEntry[];
  reviewed: Record<string, string>;
}

const modulesFor = (clientRoot: string): PresentationModule[] =>
  discoverPresentationModules(clientRoot).map((relativePath) => ({
    path: relativePath,
    signature: surfaceSignature(readFileSync(path.join(clientRoot, relativePath), "utf8"), relativePath),
    sharedHomeValues: sharedHomeValueImports(
      readFileSync(path.join(clientRoot, relativePath), "utf8"),
      relativePath,
    ),
  }));

const entryFor = (relativePath: string, overrides: Partial<TestEntry> = {}): TestEntry => ({
  path: relativePath,
  label: path.basename(relativePath).replace(/\.(ts|tsx)$/u, ""),
  kind: "surface",
  families: ["controls-and-form-composition"],
  disposition: "pending-contract-decision",
  ...overrides,
});

const inventoryOf = (entries: TestEntry[], reviewed: Record<string, string> = {}): TestInventory => ({
  version: 1,
  entries,
  reviewed,
});

const inventoryFor = (modules: PresentationModule[]): TestInventory =>
  inventoryOf(modules.map((module) => entryFor(module.path)));

const withSignatures = (modules: PresentationModule[]): TestInventory =>
  inventoryOf(
    modules.map((module) => entryFor(module.path)),
    Object.fromEntries(modules.map((module) => [module.path, module.signature])),
  );

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("presentation module discovery", () => {
  it("finds the three presentation homes and nothing else", () => {
    const clientRoot = baseTree();
    expect(discoverPresentationModules(clientRoot)).toEqual([
      "features/models/ui/ProviderFormPanel.tsx",
      "shell/ArchonShell.tsx",
      "ui/Dropdown.tsx",
    ]);
    expect(isPresentationModule("features/models/ui/nested/Inner.tsx")).toBe(false);
    expect(isPresentationModule("features/models/application/commands.ts")).toBe(false);
    expect(isPresentationModule("features/models/ui/styles.css")).toBe(false);
  });
});

describe("the classification", () => {
  it("passes when every module is classified by a defined disposition and family", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    const { failures, reviews, summary } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures).toEqual([]);
    expect(reviews).toEqual([]);
    expect(summary.modules).toBe(3);
    expect(summary.classifiedModules).toBe(3);
    expect(summary.inventoryComplete).toBe(true);
  });

  it("fails on a module with no entry", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    inventory.entries = inventory.entries.filter(
      (entry: { path: string }) => entry.path !== "shell/ArchonShell.tsx",
    );
    const { failures } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures.map((failure: { kind: string; path: string }) => [failure.kind, failure.path])).toEqual([
      ["unclassified", "shell/ArchonShell.tsx"],
    ]);
  });

  it("fails on an entry whose module no longer exists", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    inventory.entries.push(entryFor("features/models/ui/GonePanel.tsx"));
    const { failures, summary } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures.map((failure: { kind: string; path: string }) => [failure.kind, failure.path])).toEqual([
      ["stale", "features/models/ui/GonePanel.tsx"],
    ]);
    expect(summary.inventoryComplete).toBe(false);
  });

  it("fails on a disposition the ADR does not define", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    inventory.entries[0].disposition = "shared-someday";
    const { failures } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("invalid-disposition");
    expect(failures[0].path).toBe(inventory.entries[0].path);
    expect(failures[0].detail).toContain("shared-someday");
  });

  it("fails on a family the ADR does not name, and on an empty family list", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    inventory.entries[0].families = ["everything"];
    inventory.entries[1].families = [];
    const { failures } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures.map((failure: { kind: string }) => failure.kind)).toEqual([
      "invalid-family",
      "invalid-family",
    ]);
    expect(failures[0].detail).toContain("everything");
  });

  it("fails on a business exception recorded without a reason", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    inventory.entries[0].disposition = "business-exception";
    inventory.entries[1].disposition = "business-exception";
    inventory.entries[1].reason = "owns a canvas the shared layer cannot express";
    inventory.entries[1].revisit = "a second surface needs the same canvas";
    const { failures } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures.map((failure: { kind: string; path: string }) => [failure.kind, failure.path])).toEqual([
      ["invalid-disposition", inventory.entries[0].path],
    ]);
    expect(failures[0].detail).toContain("recorded reason");
  });

  it("fails on a business exception recorded without a revisit condition", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    inventory.entries[0].disposition = "business-exception";
    inventory.entries[0].reason = "owns a canvas the shared layer cannot express";
    const { failures } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures.map((failure: { kind: string; path: string }) => [failure.kind, failure.path])).toEqual([
      ["invalid-disposition", inventory.entries[0].path],
    ]);
    expect(failures[0].detail).toContain("condition under which it is revisited");
  });

  it("keeps a pending disposition valid and marks the unification unfinished", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    const { failures, summary } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures).toEqual([]);
    expect(summary.dispositions["pending-contract-decision"]).toBe(3);
    expect(summary.inventoryComplete).toBe(true);
    expect(summary.unificationComplete).toBe(false);
  });

  // The thin-adopter rule: a classification that claims adoption has to be true.
  // A module that only imports a type from the shared home knows what a contract
  // looks like without rendering one, and calling that adoption is the defect
  // this rule exists for.
  describe("the thin-adopter rule", () => {
    const adopter = `
      import { WebuiButton } from "../../../ui/button.js";
      export function Adopter(): JSX.Element {
        return <WebuiButton variant="secondary">Save</WebuiButton>;
      }
    `;

    const typeOnlyAdopter = `
      import { type WebuiContextMenuItem } from "../../../ui/ContextMenu.js";
      export function TypeOnlyAdopter(items: WebuiContextMenuItem[]): JSX.Element {
        return <span>{items.length}</span>;
      }
    `;

    it("fails on a module that claims adoption and renders nothing from the shared home", () => {
      const clientRoot = buildClientTree({
        "ui/Dropdown.tsx": SHARED_DROPDOWN,
        "features/models/ui/TypeOnlyAdopter.tsx": typeOnlyAdopter,
      });
      const modules = modulesFor(clientRoot);
      const inventory = withSignatures(modules);
      const entry = inventory.entries.find((candidate) => candidate.path.endsWith("TypeOnlyAdopter.tsx"));
      entry!.disposition = "newly-adopted-contract";
      const { failures } = evaluatePresentationCoverage({ modules, inventory });
      expect(failures.map((failure: { kind: string }) => failure.kind)).toEqual(["thin-adopter"]);
      expect(failures[0].detail).toContain("newly-adopted-contract");
    });

    it("passes a module that renders the shared contract it claims", () => {
      const clientRoot = buildClientTree({
        "ui/Dropdown.tsx": SHARED_DROPDOWN,
        "features/models/ui/Adopter.tsx": adopter,
      });
      const modules = modulesFor(clientRoot);
      const inventory = withSignatures(modules);
      const entry = inventory.entries.find((candidate) => candidate.path.endsWith("Adopter.tsx"));
      entry!.disposition = "newly-adopted-contract";
      const { failures } = evaluatePresentationCoverage({ modules, inventory });
      expect(failures).toEqual([]);
    });

    it("does not hold the shared home itself to the rule", () => {
      const clientRoot = buildClientTree({
        "ui/Dropdown.tsx": SHARED_DROPDOWN,
        "features/models/ui/Adopter.tsx": adopter,
      });
      const modules = modulesFor(clientRoot);
      const inventory = withSignatures(modules);
      const entry = inventory.entries.find((candidate) => candidate.path === "ui/Dropdown.tsx");
      entry!.disposition = "newly-adopted-contract";
      const { failures } = evaluatePresentationCoverage({ modules, inventory });
      expect(failures).toEqual([]);
    });

    it("counts a value import and not a type import", () => {
      expect(
        sharedHomeValueImports(adopter, "features/models/ui/Adopter.tsx"),
      ).toEqual(["WebuiButton"]);
      expect(
        sharedHomeValueImports(typeOnlyAdopter, "features/models/ui/TypeOnlyAdopter.tsx"),
      ).toEqual([]);
    });

    it("does not mistake a business's own ui directory for the shared home", () => {
      // Every business has a `ui/` directory of its own, so the shared home has
      // to be found by resolving the import rather than by spotting a `ui/`
      // segment in the specifier.
      const businessModule = `
        import { GreetingSkeleton } from "../features/transcript/ui/GreetingSkeleton.js";
        export function Business(): JSX.Element {
          return <GreetingSkeleton />;
        }
      `;
      expect(
        sharedHomeValueImports(businessModule, "features/account/ui/Business.tsx"),
      ).toEqual([]);
    });
  });

  it("reports every disposition and family the ADR defines", () => {
    expect([...DISPOSITIONS]).toEqual([
      "existing-shared-contract",
      "newly-adopted-contract",
      "composition",
      "business-exception",
      "pending-contract-decision",
    ]);
    expect([...FAMILIES]).toEqual([
      "foundations",
      "controls-and-form-composition",
      "navigation-and-selection",
      "overlays",
      "structure",
      "surfaces-and-content",
      "feedback-and-recovery",
      "conversation-and-workspace-interaction",
    ]);
  });
});

describe("a change inside a classified module", () => {
  const rewritten = (modules: { path: string; signature: string }[], target: string, source: string) =>
    modules.map((module) =>
      module.path === target
        ? { path: module.path, signature: surfaceSignature(source, module.path) }
        : module,
    );

  it("is reviewed, not failed, when the rendered vocabulary moves", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    const changed = rewritten(
      modules,
      "features/models/ui/ProviderFormPanel.tsx",
      `${PROVIDER_FORM}\nexport function ProviderFormSummary(): JSX.Element {\n  return <output role="status" />;\n}\n`,
    );
    const { failures, reviews, summary } = evaluatePresentationCoverage({
      modules: changed,
      inventory,
    });
    expect(failures).toEqual([]);
    expect(reviews.map((review: { path: string }) => review.path)).toEqual([
      "features/models/ui/ProviderFormPanel.tsx",
    ]);
    expect(reviews[0].recorded).toBe(inventory.reviewed["features/models/ui/ProviderFormPanel.tsx"]);
    expect(reviews[0].current).not.toBe(reviews[0].recorded);
    expect(summary.reviewRequired).toBe(1);
  });

  it("is reported when a classified module has no recorded signature", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = inventoryFor(modules);
    const { failures, reviews } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures).toEqual([]);
    expect(reviews).toHaveLength(3);
    expect(reviews[0].recorded).toBeNull();
  });

  it("stays quiet for an edit that does not change what the module renders", () => {
    const signature = surfaceSignature(PROVIDER_FORM, "ProviderFormPanel.tsx");
    const commented = `// The provider form, after the shared button migration.\n${PROVIDER_FORM}/* trailing note */\n`;
    const relabelled = PROVIDER_FORM.replace('name="model"', 'name="model" data-field="model"');
    expect(surfaceSignature(commented, "ProviderFormPanel.tsx")).toBe(signature);
    expect(surfaceSignature(relabelled, "ProviderFormPanel.tsx")).toBe(signature);
  });

  it("moves when a control, an exported name or a role changes", () => {
    const signature = surfaceSignature(PROVIDER_FORM, "ProviderFormPanel.tsx");
    expect(signature).not.toBe(
      surfaceSignature(PROVIDER_FORM.replace("<button", "<a").replace("</button>", "</a>"), "ProviderFormPanel.tsx"),
    );
    expect(signature).not.toBe(
      surfaceSignature(PROVIDER_FORM.replace("ProviderFormPanel", "ProviderForm"), "ProviderFormPanel.tsx"),
    );
    expect(signature).not.toBe(
      surfaceSignature(PROVIDER_FORM.replace("<form>", '<form role="form">'), "ProviderFormPanel.tsx"),
    );
  });

  it("records the reported signatures and nothing else", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    const changed = rewritten(
      modules,
      "shell/ArchonShell.tsx",
      `${ARCHON_SHELL}\nexport const shellHeader = <header role="banner" />;\n`,
    );
    const { reviews } = evaluatePresentationCoverage({ modules: changed, inventory });
    const next = recordReviewedSignatures(inventory, changed, reviews.map((review) => review.path));
    expect(next.reviewed["shell/ArchonShell.tsx"]).toBe(
      changed.find((module) => module.path === "shell/ArchonShell.tsx")?.signature,
    );
    // An unreported module keeps the signature it was reviewed with.
    const untouched = inventory.reviewed["ui/Dropdown.tsx"];
    expect(next.reviewed["ui/Dropdown.tsx"]).toBe(untouched);
    expect(evaluatePresentationCoverage({ modules: changed, inventory: next }).reviews).toEqual([]);
  });

  it("round-trips through the reviewed form", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventory = withSignatures(modules);
    const written = serializeInventory(inventory);
    expect(written.endsWith("\n")).toBe(true);
    expect(written.split("\n").filter((line) => line.startsWith("    {\"path\"")).length).toBe(3);
    expect(parseInventory(written)).toEqual(inventory);
  });
});

describe("the command", () => {
  it("exits non-zero on an unclassified module and names it", () => {
    const clientRoot = baseTree();
    const inventory = withSignatures(modulesFor(clientRoot));
    const inventoryPath = path.join(clientRoot, "inventory.json");
    inventory.entries = inventory.entries.filter(
      (entry: { path: string }) => entry.path !== "ui/Dropdown.tsx",
    );
    writeFileSync(inventoryPath, serializeInventory(inventory), "utf8");
    const result = runCli(["--client-root", clientRoot, "--inventory", inventoryPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[unclassified] ui/Dropdown.tsx");
    expect(result.stdout).toContain("inventory complete: no");
  });

  it("exits zero with the classification summary, and records a review on request", () => {
    const clientRoot = baseTree();
    const modules = modulesFor(clientRoot);
    const inventoryPath = path.join(clientRoot, "inventory.json");
    writeFileSync(inventoryPath, serializeInventory(inventoryFor(modules)), "utf8");

    const reported = runCli(["--client-root", clientRoot, "--inventory", inventoryPath]);
    expect(reported.status).toBe(0);
    expect(reported.stdout).toContain("scanned 3 client UI modules; 3 entries classify 3");
    expect(reported.stdout).toContain("inventory complete: yes");
    expect(reported.stdout).toContain("unification: incomplete — 3 entries carry a pending contract decision");
    expect(reported.stdout).toContain("REVIEW REQUIRED (3)");

    const accepted = runCli(["--client-root", clientRoot, "--inventory", inventoryPath, "--accept-review"]);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("recorded 3 reviewed module signature(s)");

    const clean = runCli(["--client-root", clientRoot, "--inventory", inventoryPath]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).not.toContain("REVIEW REQUIRED");
  });
});

describe("the repository's own inventory", () => {
  const clientRoot = path.join(repoRoot, CLIENT_SOURCE_DIRECTORY);
  const inventory = parseInventory(
    readFileSync(path.join(repoRoot, INVENTORY_FILE), "utf8"),
  ) as TestInventory;

  it("classifies every client UI module in this repository", () => {
    const modules = modulesFor(clientRoot);
    expect(modules.length).toBeGreaterThan(100);
    const { failures } = evaluatePresentationCoverage({ modules, inventory });
    expect(failures).toEqual([]);
  });

  it("has been reviewed against the modules it classifies", () => {
    const modules = modulesFor(clientRoot);
    const { reviews } = evaluatePresentationCoverage({ modules, inventory });
    expect(reviews.map((review: { path: string }) => review.path)).toEqual([]);
  });

  it("records the shared presentation home as an existing contract", () => {
    const shared = inventory.entries.filter((entry: { path: string }) =>
      entry.path.startsWith("ui/"),
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const entry of shared) {
      // The shared home holds contracts, and only contracts: the ones that were
      // there before the programme are existing, the ones it created are newly
      // adopted. Neither is a business exception and neither is pending.
      expect(["existing-shared-contract", "newly-adopted-contract"], entry.path).toContain(entry.disposition);
      expect(FAMILIES).toContain(entry.families[0]);
    }
  });
});
