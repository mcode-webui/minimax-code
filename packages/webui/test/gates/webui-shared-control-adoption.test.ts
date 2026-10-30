// The adoption gate (ADR 0028 § Shared contracts, #295).
//
// A shared contract is adopted by rendering its component. A class name is not
// adoption: it carries no variant, no size default, no `type="button"` and no
// required accessible name, and it lets a caller re-derive the recipe the
// contract owns. This gate reads the client's TSX sources and fails when a file
// outside the shared home names a shared control's class.
//
// Why the shared home is exempt, and only for the reason it is exempt: the class
// strings are that module's implementation. It is the one place they are allowed
// to appear, and the exemption is by path rather than by rule — a second file
// that wants them is a defect, not a variation.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const clientRoot = path.join(repoRoot, "packages/webui/src/client");

/**
 * The class names a call site may not spell.
 *
 * They are prefixes on purpose: `webui-mavis-button-gray`, `-compact`,
 * `-header`, `-plain` and `webui-icon-button--bare` are all the same defect.
 */
const SHARED_CONTROL_CLASSES = ["webui-mavis-button", "webui-icon-button"];

/** Files allowed to name them: the module that owns them. */
const SHARED_HOME = ["packages/webui/src/client/ui/button.tsx"];

function listTsx(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listTsx(full));
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** Every file under `root` that spells a shared control's class, as relative paths. */
export function findClassStringCallers(root: string, exempt: readonly string[] = SHARED_HOME): string[] {
  const offenders: string[] = [];
  for (const file of listTsx(root)) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    if (exempt.includes(relative)) continue;
    const source = readFileSync(file, "utf8");
    if (SHARED_CONTROL_CLASSES.some((name) => source.includes(name))) offenders.push(relative);
  }
  return offenders.sort();
}

describe("the adoption gate", () => {
  it("reports no call site in this repository that spells a shared control's class", () => {
    expect(findClassStringCallers(clientRoot)).toEqual([]);
  });

  it("keeps the shared home exempt, because the classes are its implementation", () => {
    const sharedHome = path.join(repoRoot, SHARED_HOME[0] ?? "");
    expect(readFileSync(sharedHome, "utf8")).toContain("webui-mavis-button");
  });

  it("fails on a caller that spells the class instead of rendering the component", () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "webui-adoption-"));
    try {
      mkdirSync(path.join(fixtureRoot, "features/synthetic/ui"), { recursive: true });
      writeFileSync(
        path.join(fixtureRoot, "features/synthetic/ui/Panel.tsx"),
        'export const Panel = () => <button className="webui-mavis-button webui-mavis-button-gray">x</button>;\n',
        "utf8",
      );
      const offenders = findClassStringCallers(fixtureRoot, []);
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain("Panel.tsx");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("passes a caller that renders the component", () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "webui-adoption-ok-"));
    try {
      mkdirSync(path.join(fixtureRoot, "features/synthetic/ui"), { recursive: true });
      writeFileSync(
        path.join(fixtureRoot, "features/synthetic/ui/Panel.tsx"),
        'import { WebuiButton } from "../../../ui/button.js";\nexport const Panel = () => <WebuiButton variant="secondary">x</WebuiButton>;\n',
        "utf8",
      );
      expect(findClassStringCallers(fixtureRoot, [])).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
