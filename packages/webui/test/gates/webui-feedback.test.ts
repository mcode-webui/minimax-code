// The feedback budget's own rules (#292, ADR 0028 § Shared contracts).
//
// The migration is ratcheted, so the ratchet has to fail for the right reasons: a
// surface that invents its own alert fails, and a migration that lands without
// lowering the entry fails too — otherwise the budget would record an intention
// rather than the code.

import { describe, expect, it } from "vitest";
import { compareFeedback, scanSource } from "../../../../scripts/check-webui-feedback.mjs";

describe("the feedback budget", () => {
  it("counts the alerts one source authors", () => {
    expect(scanSource('<p role="alert">a</p><p role="alert">b</p>')).toBe(2);
    expect(scanSource("<p>nothing</p>")).toBe(0);
  });

  it("fails when a surface invents its own alert", () => {
    const problems = compareFeedback({ "features/x/ui/A.tsx": 1 }, { files: {} });
    expect(problems[0]).toContain("features/x/ui/A.tsx: 1 alert(s), budget says 0");
  });

  it("fails when a migration lands without lowering the entry", () => {
    const problems = compareFeedback({}, { files: { "features/x/ui/A.tsx": 2 } });
    expect(problems[0]).toContain("features/x/ui/A.tsx: 0 alert(s) left, budget says 2");
  });

  it("ignores the shared layer, where these live", () => {
    expect(compareFeedback({ "ui/feedback.tsx": 9 }, { files: {} })).toEqual([]);
  });

  it("passes when a source matches its entry", () => {
    expect(compareFeedback({ "features/x/ui/A.tsx": 2 }, { files: { "features/x/ui/A.tsx": 2 } })).toEqual([]);
  });
});
