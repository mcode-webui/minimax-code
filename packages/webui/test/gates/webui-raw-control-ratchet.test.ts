// The raw-form-control ratchet (ADR 0028 § Shared contracts).
//
// What this pins: a feature stylesheet may not take on a new selector that names
// a raw `button`, `input`, `select` or `textarea`. The control's states belong to
// the shared presentation layer (`client/styles/button.css` and whatever the
// other families adopt); a stylesheet that selects the element re-declares those
// states somewhere a shared owner cannot see, which is the drift this programme
// exists to stop.
//
// Why a budget and not zero: the selectors still in the settings stylesheet
// belong to surfaces whose own tickets have not migrated them yet — the memory
// manager menu, the search fields of two other businesses, the segmented
// control, the settings dialog's close button. Each is a named entry with its
// selector text, so the list is a statement of what is left rather than a rule
// that was quietly waived. The ratchet is symmetric: a new selector fails, and a
// recorded selector that has gone fails too, so the budget can only shrink. A
// migration that removes one updates the file in the same commit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  for (const [relativePath, recorded] of Object.entries(budget.files)) {
    it(`${relativePath} selects no raw form control beyond its recorded budget`, () => {
      const css = readFileSync(path.join(repoRoot, relativePath), "utf8");
      const measured = rawControlSelectors(css);

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
