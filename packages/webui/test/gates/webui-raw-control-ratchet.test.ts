// The raw-form-control ratchet (ADR 0028 § Shared contracts).
//
// What this pins: a feature stylesheet may not take on a new selector that names
// a raw `button`, `input`, `select` or `textarea`. The control's states belong to
// the shared presentation layer (`client/styles/button.css` and whatever the
// other families adopt); a stylesheet that selects the element re-declares those
// states somewhere a shared owner cannot see, which is the drift this programme
// exists to stop.
//
// It watches every business stylesheet. The first version of this file listed
// three of the fourteen, and the eleven it did not list held fifty-eight
// selectors between them — a gate that watched what somebody remembered to put
// in it. A stylesheet that is not in the budget now fails the gate rather than
// passing it unseen.
//
// Why a budget and not zero: the selectors that remain belong to surfaces whose
// own tickets have not migrated them yet. Each is a named entry with its
// selector text, so the list is a statement of what is left rather than a rule
// that was quietly waived. The ratchet is symmetric: a new selector fails, and a
// recorded selector that has gone fails too, so the budget can only shrink. A
// migration that removes one updates the file in the same commit.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const budgetPath = path.join(repoRoot, "scripts/lib/webui-raw-control-budget.json");

/** The raw form-control element a selector ends on, if it ends on one. */
const RAW_ELEMENT = /(?:^|[\s>+~])(button|input|select|textarea)(?:[.:[#\s>+~]|$)/u;

export function rawControlSelectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found = new Set<string>();
  for (const match of withoutComments.matchAll(/([^{}]+)\{/gu)) {
    const selectorText = (match[1] ?? "").replace(/\s+/gu, " ").trim();
    if (selectorText.length === 0 || selectorText.startsWith("@")) continue;
    for (const part of selectorText.split(",")) {
      const selector = part.trim();
      if (selector.length > 0 && RAW_ELEMENT.test(selector)) found.add(selector);
    }
  }
  return [...found].sort();
}

describe("the raw form-control ratchet", () => {
  const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as {
    files: Record<string, string[]>;
  };

  // Every business stylesheet is watched, not the three the first version of
  // this file happened to list. A stylesheet that is absent from the budget is
  // a stylesheet nobody can see, and eleven of them were absent while holding
  // fifty-eight selectors between them.
  //
  // The list is discovered from the filesystem rather than written out, so the
  // per-file cases below are one per stylesheet on disk rather than one per
  // stylesheet somebody remembered to name.
  const featuresRoot = path.join(repoRoot, "packages/webui/src/client/features");
  const businessStylesheets = readdirSync(featuresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Not every feature owns a "ui" directory; the ones that do are the ones
    // that carry a stylesheet.
    .filter((business) => existsSync(path.join(featuresRoot, business.name, "ui")))
    .flatMap((business) =>
      readdirSync(path.join(featuresRoot, business.name, "ui"), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
        .map((entry) =>
          path
            .join("packages/webui/src/client/features", business.name, "ui", entry.name)
            .split(path.sep)
            .join("/"),
        ),
    )
    .sort();

  it("watches every business stylesheet", () => {
    expect(businessStylesheets.length).toBeGreaterThan(0);
    expect(Object.keys(budget.files).sort()).toEqual(businessStylesheets);
  });

  for (const relativePath of businessStylesheets) {
    it(`${relativePath} selects no raw form control beyond its recorded budget`, () => {
      const css = readFileSync(path.join(repoRoot, relativePath), "utf8");
      const measured = rawControlSelectors(css);
      const recorded = budget.files[relativePath] ?? [];

      // A selector that is not recorded is the drift: it belongs to a shared
      // control's states or it needs its own named class.
      expect(measured.filter((selector) => !recorded.includes(selector))).toEqual([]);
      // A recorded selector that has gone means the migration happened and the
      // budget was not told, which would let the next one back in unnoticed.
      expect(recorded.filter((selector) => !measured.includes(selector))).toEqual([]);
    });
  }

  it("finds the shared button's states outside any feature stylesheet", () => {
    const shared = readFileSync(
      path.join(repoRoot, "packages/webui/src/client/styles/button.css"),
      "utf8",
    );
    // The contract owns the states, so the assertions look for them where the
    // shared layer keeps them.
    expect(shared).toMatch(/\.webui-mavis-button\s*\{/u);
    expect(shared).toMatch(/\.webui-mavis-button:focus-visible/u);
    expect(shared).toMatch(/\.webui-mavis-button:disabled/u);
    expect(shared).toMatch(/\.webui-icon-button\s*\{/u);
  });
});
