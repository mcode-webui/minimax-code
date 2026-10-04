// The model picker's hover timing (roadmap H).
//
// Two halves, split for the same reason `model-picker-cascade.test.ts` splits.
//
// The RULES are pure functions in `projection/model-picker-hover.ts` and are
// driven directly below: what the pointer arriving on a row does to a fly-out
// that may already be open, and how long a pointer has to rest. Those are the
// decisions that decide whether the panel chases the cursor, so they are pinned
// as behaviour.
//
// The WIRING is pinned as source tripwires. `WebuiModelPicker` renders through
// `renderToStaticMarkup` with the menu CLOSED, so neither "the panel waits
// before opening" nor "the search box puts the panel away" can be observed by
// rendering it — both need a real pointer and a real focus event. The
// tripwires check the shape those two fixes turn on: one delay around the open,
// no second path that opens a panel without paying it, and the search field
// wired to the same retract every other escape route uses.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MODEL_FLYOUT_HOVER_DELAY_MS,
  hoverArrival,
} from "../../src/client/projection/model-picker-hover.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const componentDir = path.resolve(here, "../../src/client/components");
const picker = readFileSync(
  path.join(componentDir, "ModelPicker.tsx"),
  "utf8",
);

describe("model picker — a hover that is not yet a decision", () => {
  it("waits long enough to outlast a sweep, and short enough to feel obeyed", () => {
    // The two ways this number is wrong, and both were reported. Too low and a
    // sweep down the list throws a panel after every row; too high and a
    // deliberate hover reads as the UI ignoring the pointer. A third of a
    // second sits above the sweep and below the "it is not working" threshold.
    expect(MODEL_FLYOUT_HOVER_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(MODEL_FLYOUT_HOVER_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it("opens nothing while the pointer is still travelling", () => {
    // No tier, no focused row, and the delay NOT yet paid: the only correct
    // answer is to wait. A path that opened here is the original bug.
    expect(
      hoverArrival({
        rowId: "minimax::minimax/M3",
        focusedRowId: undefined,
        tier: "list",
        hasFlyout: true,
      }),
    ).toBe("retract-then-open");
  });

  it("retracts the previous row's panel before scheduling this one", () => {
    // The panel describes the model, and the pointer has already left it. The
    // retract is part of the arrival rather than a separate step because the
    // row's highlight moves on the same mouse event: a panel left standing
    // re-anchors to the row the pointer has only passed over, so the user
    // watches one model's settings slide onto another before reading either.
    expect(
      hoverArrival({
        rowId: "minimax::minimax/M3",
        focusedRowId: "zai::zhipu/glm-5.3",
        tier: "settings",
        hasFlyout: true,
      }),
    ).toBe("retract-then-open");
  });

  it("leaves an open panel alone when the pointer comes back out of it", () => {
    // The panel is a hover region of its own. Retracting here would close it
    // under the pointer on its way to being used, which is the one move that
    // makes the panel unusable — and re-scheduling would restart the delay on a
    // hover that is already satisfied, so the panel would flicker.
    expect(
      hoverArrival({
        rowId: "zai::zhipu/glm-5.3",
        focusedRowId: "zai::zhipu/glm-5.3",
        tier: "settings",
        hasFlyout: true,
      }),
    ).toBe("keep-open");
  });

  it("opens nothing for a model with no settings to describe", () => {
    // An empty panel is worse than none, and the previous row's panel has to go
    // with it: left standing it describes a model nothing is pointing at.
    expect(
      hoverArrival({
        rowId: "openai::openai/gpt-6",
        focusedRowId: "zai::zhipu/glm-5.3",
        tier: "settings",
        hasFlyout: false,
      }),
    ).toBe("retract-only");
    expect(
      hoverArrival({
        rowId: "openai::openai/gpt-6",
        focusedRowId: undefined,
        tier: "list",
        hasFlyout: false,
      }),
    ).toBe("retract-only");
  });

  it("re-opens a row whose panel was retracted under it", () => {
    // The search box takes the interaction and the panel goes; the pointer is
    // still sitting on that row. Nothing fires a fresh arrival — the pointer
    // has not moved — so the row must be reachable by leaving and returning,
    // and returning to a CLOSED panel has to schedule like any other.
    expect(
      hoverArrival({
        rowId: "zai::zhipu/glm-5.3",
        focusedRowId: undefined,
        tier: "list",
        hasFlyout: true,
      }),
    ).toBe("retract-then-open");
  });

  it("does not let one copy of a model answer for the other", () => {
    // A starred model is rendered twice, so "the panel already describes this
    // one" has to mean this ROW. Answering by model leaves the panel anchored
    // to the shortlist's line while the pointer has moved to the provider's
    // copy of the same model — the panel then sits beside a line the pointer
    // is not on, which is the one place a fly-out must never be.
    expect(
      hoverArrival({
        rowId: "minimax::minimax/M3",
        focusedRowId: "__favorites::minimax/M3",
        tier: "settings",
        hasFlyout: true,
      }),
    ).toBe("retract-then-open");
    // …and the same row arriving twice still keeps its panel, which is the
    // pointer crossing back out of it.
    expect(
      hoverArrival({
        rowId: "__favorites::minimax/M3",
        focusedRowId: "__favorites::minimax/M3",
        tier: "settings",
        hasFlyout: true,
      }),
    ).toBe("keep-open");
  });
});

describe("model picker — the hover wiring", () => {
  it("pays the delay through one timer, and cancels it on the way out", () => {
    // One timer, because two would be two answers to "is a panel pending". The
    // cleanup is what stops a hover paid out after the menu is gone from
    // opening a panel on a picker that is no longer on screen.
    expect(picker).toContain("hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)");
    expect(picker).toContain("const clearPendingHover = () => {");
    expect(picker).toContain("clearTimeout(hoverTimer.current)");
    expect(picker).toMatch(/useEffect\(\(\) => clearPendingHover, \[\]\)/u);
  });

  it("opens a panel only through the delayed arrival or the keyboard", () => {
    // `handleHoverRow` is the single place that raises the `settings` tier, so
    // counting its callers counts every way a panel can appear. Two is the
    // whole list: the timer's callback, and the arrow keys — arrowing into a
    // row is a decision, not a pass over it, so it does not pay the delay. The
    // definition is `handleHoverRow = (` and so is not one of these.
    expect(picker.match(/handleHoverRow\(/gu) ?? []).toHaveLength(2);
    const delay = picker.slice(
      picker.indexOf("hoverTimer.current = setTimeout("),
      picker.indexOf("}, MODEL_FLYOUT_HOVER_DELAY_MS);"),
    );
    expect(delay).toContain("handleHoverRow(key, rowId);");
    const arrows = picker.slice(
      picker.indexOf("const moveFocusedRow = (delta: number) => {"),
      picker.indexOf("const searchIsEmpty ="),
    );
    expect(arrows).toContain("handleHoverRow(row.key, row.rowId);");
    expect(picker).toContain("}, MODEL_FLYOUT_HOVER_DELAY_MS);");
  });

  it("resolves a delayed row against the CURRENT catalogue, not the arrival's", () => {
    // The runtime refreshes the model catalogue underneath an open menu, so a
    // callback closing over `models` would look the row up in a snapshot up to
    // one delay old — and open a panel for a model the catalogue has since
    // dropped.
    expect(picker).toContain("const modelsRef = useRef(models);");
    expect(picker).toContain("modelsRef.current = models;");
    expect(
      (picker.match(/modelsRef\.current\.find\(\(entry\) => modelKey\(entry\) === key\)/gu) ?? []),
    ).toHaveLength(2);
  });

  it("puts the fly-out away when the search box takes the interaction", () => {
    // The reported defect: focus in the search field, and the previous
    // question's panel still standing over the results the search was opened
    // to read. Both routes into the box retract — focusing it, and typing into
    // it, since a keystroke can unmount the very row the panel is anchored to
    // and leave it describing a model that is no longer in the list.
    expect(picker).toContain("const retractFlyout = () => {");
    expect(picker).toMatch(/onFocus=\{\(\) => \{\s*\n\s*\/\/[\s\S]*?retractFlyout\(\);/u);
    expect(picker).toMatch(/onChange=\{\(event\) => \{[\s\S]*?retractFlyout\(\);/u);
  });

  it("keeps the row's highlight instant and its panel delayed", () => {
    // They are separate props on purpose. Highlighting is the list answering
    // "where is the pointer" and is expected to be immediate; the panel is the
    // list making a claim about that row, and claims wait. Folding them back
    // into one handler is the regression this split exists to prevent.
    expect(picker).toContain("onHoverIntent?: (key: string, rowId: string) => void;");
    expect(picker).toContain("onHoverLeave?: (rowId: string) => void;");
    expect(picker).toMatch(
      /onMouseEnter=\{\(\) => \{\s*\n\s*onHoverIntent\?\.\(key, rowId\);\s*\n\s*onFocus\(key, rowId\);/u,
    );
    expect(picker).toContain("onMouseLeave={() => onHoverLeave?.(rowId)}");
  });

  it("anchors the panel to the ROW, which a model key cannot name", () => {
    // The defect this exists for: a starred model is rendered twice, so a map
    // keyed by the model holds whichever copy mounted last — the provider's.
    // Hovering the shortlist's line then opened the panel beside a different
    // line entirely, at the other end of the list.
    expect(picker).toContain("export function rowIdOf(groupId: string, key: string): string {");
    expect(picker).toContain("const rowId = rowIdOf(group.id, key);");
    expect(picker).toContain("rowElements.current.get(focused.rowId)");
    // The keyboard walks rows for the same reason: a walk keyed by model would
    // step onto the shortlist's M3 and then the provider's M3, two presses for
    // one model.
    expect(picker).toContain("rowId: rowIdOf(group.id, key)");
    expect(picker).toContain("rows.findIndex((row) => row.rowId === focused.rowId)");
  });

  it("cancels a pending hover when the pointer leaves a row, without retracting", () => {
    // Leaving a row is the normal first step of moving INTO its panel, so the
    // departure may only call off a panel that has not opened yet. A
    // `setTier` in here is the regression: the panel would close under the
    // pointer and could not be clicked at all.
    const leave = picker.slice(picker.indexOf("const handleHoverLeave = () => {"));
    expect(leave.slice(0, leave.indexOf("};"))).toContain("clearPendingHover()");
    expect(leave.slice(0, leave.indexOf("};"))).not.toContain("setTier");
  });

  it("does not let the highlight cancel the hover it was queued with", () => {
    // Caught on the running app, not by any assertion: the list calls
    // `onHoverIntent` and then `onFocus` from ONE mouseenter, so a highlight
    // handler that also called off the pending hover cancelled the panel the
    // pointer had just asked for, and the list silently stopped opening one at
    // all. The highlight moves; the timer belongs to the pointer.
    const focus = picker.slice(
      picker.indexOf("const handleRowFocus = (key: string, rowId: string) => {"),
    );
    const body = focus.slice(0, focus.indexOf("};"));
    expect(body).toContain("setFocused({ key, rowId })");
    expect(body).not.toContain("clearPendingHover");
    expect(body).not.toContain("setTier");
  });
});
