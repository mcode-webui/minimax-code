// The feedback budget's own rules (#292, ADR 0028 § Shared contracts).
//
// The migration is ratcheted, so the ratchet has to fail for the right reasons: a
// surface that invents its own announcement fails, and a migration that lands
// without lowering the entry fails too — otherwise the budget would record an
// intention rather than the code.
//
// The budget watches every announcement channel, not only `role="alert"`. A
// surface that writes its own `aria-live` region announces without the family
// deciding how, when and how loudly, and it is the same escape as an alert.

import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_CHANNELS,
  compareFeedback,
  countChannels,
  scanSource,
} from "../../../../scripts/check-webui-feedback.mjs";

describe("the feedback budget", () => {
  it("counts the alerts one source authors", () => {
    expect(scanSource('<p role="alert">a</p><p role="alert">b</p>')).toBe(2);
    expect(scanSource("<p>nothing</p>")).toBe(0);
  });

  it("counts every announcement channel, not only the alert", () => {
    expect(scanSource('<p role="status">a</p>')).toBe(1);
    expect(scanSource('<div aria-live="polite">a</div>')).toBe(1);
    expect(scanSource('<div role="progressbar">a</div>')).toBe(1);
    expect(scanSource('<div role="log">a</div>')).toBe(1);
  });

  it("does not read a dialog role as an alert", () => {
    expect(scanSource('<div role="alertdialog">a</div>')).toBe(0);
  });

  it("does not count prose", () => {
    expect(scanSource('// a role="alert" in a comment\n<p>text</p>')).toBe(0);
    expect(scanSource('/* role="status" */ <p>text</p>')).toBe(0);
  });

  it("reports the channels a source authors", () => {
    const { counts } = countChannels('<p role="alert">a</p><div aria-live="polite">b</div>');
    expect(counts).toEqual({ 'role="alert"': 1, "aria-live": 1 });
  });

  it("names every channel it watches", () => {
    expect(ANNOUNCEMENT_CHANNELS).toContain('role="alert"');
    expect(ANNOUNCEMENT_CHANNELS).toContain('role="status"');
    expect(ANNOUNCEMENT_CHANNELS).toContain("aria-live");
  });

  it("fails when a surface invents its own announcement", () => {
    const problems = compareFeedback({ "features/x/ui/A.tsx": 1 }, { files: {} });
    expect(problems[0]).toContain("features/x/ui/A.tsx: 1 announcement channel(s), budget says 0");
  });

  it("fails when a migration lands without lowering the entry", () => {
    const problems = compareFeedback({}, { files: { "features/x/ui/A.tsx": 2 } });
    expect(problems[0]).toContain("features/x/ui/A.tsx: 0 announcement channel(s) left, budget says 2");
  });

  it("ignores the shared layer, where these live", () => {
    expect(compareFeedback({ "ui/feedback.tsx": 9 }, { files: {} })).toEqual([]);
  });

  it("passes when a source matches its entry", () => {
    expect(compareFeedback({ "features/x/ui/A.tsx": 2 }, { files: { "features/x/ui/A.tsx": 2 } })).toEqual([]);
  });
});
