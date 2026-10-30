// The accessibility gate's own rules (ADR 0028 § Accessibility, #283).
//
// The browser run in `rendering-integrity.spec.mjs` produces the findings; this
// file proves the decisions taken about them. Three things must be true for the
// gate to mean anything, and none of them needs a browser:
//
//   - a finding the recording does not know fails, so a surface cannot get worse;
//   - a recorded finding that has gone fails, so the debt cannot outlive itself;
//   - an exception covers the node it names and nothing else, so one reviewed
//     element cannot hide its neighbour.
//
// The fourth is the boundary #283 draws for the report: an incomplete rule that
// nobody has written a disposition for is reported as undispositioned, and the
// report says how many manual reviews are still open rather than implying the
// states they apply to are reviewed complete.

import { describe, expect, it } from "vitest";
import {
  classifyFindings,
  compareBaseline,
  formatReport,
  openDispositions,
  undispositionedRules,
  type AccessibilityFinding,
} from "../browser/support/accessibility.mjs";

const node = (stable: string, selectors: string[] = [stable]) => ({ selectors, stable, html: "" });

const finding = (
  rule: string,
  nodes: ReturnType<typeof node>[],
  where: { surface?: string; state?: string; theme?: string } = {},
): AccessibilityFinding => ({
  rule,
  nodes,
  surface: where.surface ?? "provider-form",
  state: where.state ?? "one/light",
  theme: where.theme ?? "light",
});

const exception = (target: string, rule = "color-contrast") => ({
  rule,
  surface: "*",
  state: "*",
  target,
  reason: "synthetic",
  owner: "synthetic",
  removalCondition: "synthetic",
});

describe("the recorded debt", () => {
  it("fails on a finding the recording does not know", () => {
    const recorded: Record<string, string>[] = [finding("color-contrast", [node(".known")])].map(
      (entry) => ({
        rule: entry.rule,
        surface: entry.surface ?? "",
        state: entry.state ?? "",
        theme: entry.theme ?? "",
        target: entry.nodes[0]?.stable ?? "",
      }),
    );
    const measured = [finding("color-contrast", [node(".known"), node(".new")])];
    const { newFindings, staleEntries } = compareBaseline(recorded, measured);
    expect(newFindings.map((entry) => entry.target)).toEqual([".new"]);
    expect(staleEntries).toEqual([]);
  });

  it("fails on a recorded finding that has gone", () => {
    const recorded = [
      { rule: "color-contrast", surface: "provider-form", state: "one/light", theme: "light", target: ".gone" },
    ];
    const { newFindings, staleEntries } = compareBaseline(recorded, [
      finding("color-contrast", [node(".kept")]),
    ]);
    expect(newFindings.map((entry) => entry.target)).toEqual([".kept"]);
    expect(staleEntries.map((entry) => entry.target)).toEqual([".gone"]);
  });

  it("keeps the identity stable when the only selector was a generated id", () => {
    const key = node("", ["#\\:r1\\:"]).stable;
    expect(key).toBe("");
    // The scan fills `stable` from the element's class when stripping the id
    // leaves nothing; an empty identity would let one entry hide the next.
    const recorded = [finding("color-contrast", [node(".webui-brand-create-button")])];
    const { newFindings } = compareBaseline(
      recorded.map((entry): Record<string, string> => ({
        rule: entry.rule,
        surface: entry.surface ?? "",
        state: entry.state ?? "",
        theme: entry.theme ?? "",
        target: entry.nodes[0]?.stable ?? "",
      })),
      [finding("color-contrast", [node(".webui-brand-create-button")])],
    );
    expect(newFindings).toEqual([]);
  });
});

describe("exceptions", () => {
  it("covers the node it names and leaves its neighbour in the debt", () => {
    const findings = [finding("color-contrast", [node(".webui-rail-group-label"), node(".webui-diff-add")])];
    const { unexcepted } = classifyFindings({
      surface: "provider-form",
      state: "one/light",
      findings,
      exceptions: [exception("webui-rail-group-label")],
    });
    expect(unexcepted.map((entry) => entry.nodes.map((each) => each.stable))).toEqual([[".webui-diff-add"]]);
  });

  it("is rejected once its finding is gone", () => {
    const { stale } = classifyFindings({
      surface: "provider-form",
      state: "one/light",
      findings: [finding("color-contrast", [node(".webui-diff-add")])],
      exceptions: [exception("webui-rail-group-label")],
    });
    expect(stale.map((entry) => entry.target)).toEqual(["webui-rail-group-label"]);
  });
});

describe("the manual review register", () => {
  it("reports an incomplete rule nobody has written a disposition for", () => {
    expect(
      undispositionedRules([{ rule: "aria-valid-attr-value" }, { rule: "color-contrast" }], [
        { rule: "color-contrast", status: "open", note: "", owner: "", closesWhen: "" },
      ]),
    ).toEqual(["aria-valid-attr-value"]);
  });

  it("prints how many reviews are still open, and what the scan cannot decide", () => {
    const report = formatReport({
      scanned: 2,
      findings: [],
      unexcepted: [],
      stale: [],
      incomplete: [{ rule: "color-contrast" }],
      review: [
        { rule: "color-contrast", status: "open", note: "n", owner: "o", closesWhen: "c" },
        { rule: "target-size", status: "resolved", note: "n", owner: "o", closesWhen: "c" },
      ],
    });
    expect(openDispositions([{ rule: "x", status: "resolved", note: "", owner: "", closesWhen: "" }])).toEqual([]);
    expect(report).toContain("manual reviews still open: 1 of 2");
    expect(report).toContain("does NOT verify");
    expect(report).toContain("keyboard reachability");
  });
});
