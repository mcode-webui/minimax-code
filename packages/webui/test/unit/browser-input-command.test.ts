// Browser input commands: what may be forwarded, and what may not.
//
// The panel is the only place that knows what the user aimed at, so it is also
// the only place that can refuse a gesture before it becomes a page action. These
// functions are pure precisely so that refusal can be asserted here rather than
// discovered in a browser: this package has no DOM in its test environment, and
// the decision under test is a decision, not an interaction.

import { describe, expect, it } from "vitest";

import {
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  type WebuiBrowserInputModifier,
  type WebuiBrowserTargetId,
} from "../../src/shared/contracts/browser.js";
import {
  WEBUI_BROWSER_TEXT_MAX_LENGTH,
  applyWebuiBrowserAuthorizationChange,
  buildWebuiBrowserInputCommand,
  checkWebuiBrowserInputTarget,
  prepareWebuiBrowserInputCommand,
  webuiBrowserAuthorizationChange,
  webuiBrowserModifierFlags,
  webuiBrowserPicturePoint,
  webuiBrowserPointerButton,
} from "../../src/client/features/browser/application/browser-commands.js";
import type { WebuiBrowserPanelState } from "../../src/client/features/browser/contracts/browser-panel.js";
import { selectWebuiBrowserViewedTarget } from "../../src/client/features/browser/projection/browser-state.js";

function target(overrides: Partial<WebuiBrowserTargetId> = {}): WebuiBrowserTargetId {
  return { surface: "isolated-chromium", browserId: "chromium-1", targetId: "tab-1", generation: 7, ...overrides };
}

/**
 * The two cells, as the panel holds them: the run's selection is the runtime's,
 * the viewed page is the client's. Most cases here only need one of them.
 */
function panelState(cells: {
  readonly viewedPage?: WebuiBrowserTargetId;
  readonly runSelection?: WebuiBrowserTargetId;
}): WebuiBrowserPanelState {
  return {
    authorization: WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
    surface: "isolated-chromium",
    targets: [],
    frames: {},
    status: cells.viewedPage ? "loading" : "idle",
    droppedFrameCount: 0,
    ...cells,
  };
}

describe("malformed input is refused, never forwarded", () => {
  it("refuses a non-finite coordinate with a stable reason", () => {
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = buildWebuiBrowserInputCommand(
        { kind: "pointer", x, y: 4, button: "left", clickCount: 1 },
        target(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("pointer_coordinate");
      expect(result.error.code).toBe("browser_command_invalid");
    }
  });

  it("refuses a negative coordinate rather than clamping it to the page edge", () => {
    // A clamped coordinate aims at somewhere the user never pointed, which is a
    // worse failure than a refused one.
    const result = buildWebuiBrowserInputCommand(
      { kind: "pointer", x: -1, y: 10, button: "left", clickCount: 1 },
      target(),
    );
    expect(result).toMatchObject({ ok: false, reason: "pointer_coordinate" });
  });

  it("refuses an unknown button and a fractional click count", () => {
    expect(
      buildWebuiBrowserInputCommand(
        { kind: "pointer", x: 1, y: 1, button: "back" as unknown as "left", clickCount: 1 },
        target(),
      ),
    ).toMatchObject({ ok: false, reason: "pointer_button" });
    expect(
      buildWebuiBrowserInputCommand(
        { kind: "pointer", x: 1, y: 1, button: "left", clickCount: 1.5 },
        target(),
      ),
    ).toMatchObject({ ok: false, reason: "pointer_click_count" });
  });

  it("refuses an empty text payload but keeps a single space", () => {
    // The person typing a space meant a space; trimming it would insert nothing
    // where they expected one character.
    expect(buildWebuiBrowserInputCommand({ kind: "text", text: "" }, target())).toMatchObject({
      ok: false,
      reason: "text_empty",
    });
    expect(buildWebuiBrowserInputCommand({ kind: "text", text: " " }, target())).toMatchObject({ ok: true });
  });

  it("refuses a text payload past the cap instead of truncating it", () => {
    const result = buildWebuiBrowserInputCommand(
      { kind: "text", text: "a".repeat(WEBUI_BROWSER_TEXT_MAX_LENGTH + 1) },
      target(),
    );
    expect(result).toMatchObject({ ok: false, reason: "text_too_long" });
  });

  it("refuses an unknown modifier instead of dropping it", () => {
    // Dropping it would send a bare keystroke where the user held a key down,
    // which is how a shortcut turns into the command it stood in for.
    const result = buildWebuiBrowserInputCommand(
      {
        kind: "key",
        key: "k",
        modifiers: ["super"] as unknown as readonly WebuiBrowserInputModifier[],
      },
      target(),
    );
    expect(result).toMatchObject({ ok: false, reason: "key_modifier" });
  });

  it("refuses an empty key name and an unusable target identity", () => {
    expect(buildWebuiBrowserInputCommand({ kind: "key", key: "   ", modifiers: [] }, target())).toMatchObject({
      ok: false,
      reason: "key_name",
    });
    expect(
      buildWebuiBrowserInputCommand({ kind: "text", text: "hi" }, target({ targetId: "" })),
    ).toMatchObject({ ok: false, reason: "target_identity" });
    expect(
      buildWebuiBrowserInputCommand({ kind: "text", text: "hi" }, target({ generation: Number.NaN })),
    ).toMatchObject({ ok: false, reason: "target_identity" });
  });
});

describe("a command carries the generation it was aimed at", () => {
  it("builds the command against the target it was given", () => {
    const aimed = target({ generation: 12, targetId: "tab-9" });
    const result = buildWebuiBrowserInputCommand({ kind: "pointer", x: 3, y: 4, button: "right", clickCount: 2 }, aimed);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toEqual({
      kind: "pointer",
      target: aimed,
      x: 3,
      y: 4,
      button: "right",
      clickCount: 2,
    });
    expect(result.command.target.generation).toBe(12);
  });

  it("keeps the modifiers a set, in a fixed order", () => {
    const result = buildWebuiBrowserInputCommand(
      { kind: "key", key: "Enter", code: "Enter", modifiers: ["shift", "alt", "shift"] },
      target(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.kind).toBe("key");
    if (result.command.kind !== "key") return;
    expect(result.command.modifiers).toEqual(["alt", "shift"]);
    // A named key produces no character, so none is carried.
    expect(result.command.text).toBeUndefined();
  });

  it("reads DOM modifier flags in a fixed order", () => {
    expect(
      webuiBrowserModifierFlags({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toEqual(["ctrl", "shift"]);
  });

  it("maps a mouse button number, treating anything unknown as a left click", () => {
    expect(webuiBrowserPointerButton(0)).toBe("left");
    expect(webuiBrowserPointerButton(1)).toBe("middle");
    expect(webuiBrowserPointerButton(2)).toBe("right");
    expect(webuiBrowserPointerButton(4)).toBe("left");
  });
});

describe("a command is refused unless it names the page the person is looking at", () => {
  it("accepts a command aimed at the page in front and its generation", () => {
    const viewed = target();
    const result = prepareWebuiBrowserInputCommand(viewed, {
      kind: "pointer",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });

    expect(result.ok).toBe(true);
  });

  it("binds to the tab the person is looking at while the run's selection is elsewhere", () => {
    // The two cells are one apart in this state on purpose: the Agent is working
    // in `tab-agent`, the person is looking at `tab-person`. The text the person
    // typed must be bound to the page in front, and the run's selection must not
    // be reachable from this path at all.
    const state = panelState({
      viewedPage: target({ targetId: "tab-person" }),
      runSelection: target({ targetId: "tab-agent" }),
    });
    const result = prepareWebuiBrowserInputCommand(selectWebuiBrowserViewedTarget(state)?.id ?? state.viewedPage, {
      kind: "text",
      text: "hi",
    });

    expect(result).toMatchObject({
      ok: true,
      command: { target: { targetId: "tab-person" } },
    });
  });

  it("refuses a command bound to a generation the page has moved past", () => {
    const shown = target({ generation: 8 });
    const stale = checkWebuiBrowserInputTarget(shown, target({ generation: 7 }));

    expect(stale).toMatchObject({
      ok: false,
      reason: "target_generation_behind",
      error: { code: "browser_target_stale" },
    });
  });

  it("refuses a command bound to a generation the panel has not adopted yet", () => {
    // Forwarding it would act on a page the person cannot see.
    expect(checkWebuiBrowserInputTarget(target({ generation: 8 }), target({ generation: 9 }))).toMatchObject({
      ok: false,
      reason: "target_generation_ahead",
    });
  });

  it("refuses a command aimed at another tab entirely", () => {
    expect(checkWebuiBrowserInputTarget(target({ targetId: "tab-1" }), target({ targetId: "tab-2" }))).toMatchObject({
      ok: false,
      error: { code: "browser_target_stale" },
    });
  });

  it("refuses every command while no page is in front", () => {
    const result = prepareWebuiBrowserInputCommand(undefined, { kind: "text", text: "hi" });

    expect(result).toMatchObject({
      ok: false,
      reason: "target_unknown",
      error: { code: "browser_target_unknown" },
    });
  });

  it("refuses a malformed gesture even when the target is right", () => {
    // The binding check must not paper over a bad payload: the two are separate
    // facts and the caller is told which one failed.
    const shown = target();
    expect(
      prepareWebuiBrowserInputCommand(shown, {
        kind: "pointer",
        x: Number.NaN,
        y: 0,
        button: "left",
        clickCount: 1,
      }),
    ).toMatchObject({ ok: false, reason: "pointer_coordinate" });
  });
});

describe("the four authorization switches", () => {
  const allOn = { isolatedChromium: true, edge: true, chrome: true, fullCdp: true };

  it("defaults every switch off", () => {
    expect(WEBUI_BROWSER_AUTHORIZATION_DEFAULT).toEqual({
      isolatedChromium: false,
      edge: false,
      chrome: false,
      fullCdp: false,
    });
  });

  it("names exactly one field on the wire, so a write cannot clear the others", () => {
    for (const [surface, field] of [
      ["isolated-chromium", "isolatedChromium"],
      ["edge", "edge"],
      ["chrome", "chrome"],
      ["full-cdp", "fullCdp"],
    ] as const) {
      const change = webuiBrowserAuthorizationChange({ surface, enabled: true });
      expect(change).toEqual({ [field]: true });
      // The other three are absent, not `false`: absent is what the change does
      // not speak about, and the write therefore cannot clear them.
      expect(Object.keys(change)).toHaveLength(1);
    }
  });

  it("changes exactly the switch it names", () => {
    const off = WEBUI_BROWSER_AUTHORIZATION_DEFAULT;
    expect(applyWebuiBrowserAuthorizationChange(off, webuiBrowserAuthorizationChange({ surface: "edge", enabled: true })))
      .toEqual({ isolatedChromium: false, edge: true, chrome: false, fullCdp: false });
    expect(applyWebuiBrowserAuthorizationChange(off, webuiBrowserAuthorizationChange({ surface: "chrome", enabled: true })))
      .toEqual({ isolatedChromium: false, edge: false, chrome: true, fullCdp: false });
    expect(applyWebuiBrowserAuthorizationChange(off, webuiBrowserAuthorizationChange({ surface: "isolated-chromium", enabled: true })))
      .toEqual({ isolatedChromium: true, edge: false, chrome: false, fullCdp: false });
  });

  it("leaves the surfaces untouched when Full CDP moves", () => {
    // The independence the ADR requires: Full CDP widens the command set of a
    // browser that is already on, and never enables one.
    expect(
      applyWebuiBrowserAuthorizationChange(allOn, webuiBrowserAuthorizationChange({ surface: "full-cdp", enabled: false })),
    ).toEqual({ isolatedChromium: true, edge: true, chrome: true, fullCdp: false });

    const offSurfaces = { isolatedChromium: false, edge: false, chrome: false, fullCdp: false };
    expect(
      applyWebuiBrowserAuthorizationChange(offSurfaces, webuiBrowserAuthorizationChange({ surface: "full-cdp", enabled: true })),
    ).toEqual({ isolatedChromium: false, edge: false, chrome: false, fullCdp: true });
  });

  it("leaves Full CDP untouched when a surface moves", () => {
    expect(
      applyWebuiBrowserAuthorizationChange(allOn, webuiBrowserAuthorizationChange({ surface: "edge", enabled: false })),
    ).toEqual({ isolatedChromium: true, edge: false, chrome: true, fullCdp: true });
  });
});

describe("a click is a point in the top-left anchored picture, not in its surface", () => {
  // The frame covers the surface without distortion and anchors at top-left;
  // overflow is clipped on the right or bottom.
  const surface = { left: 0, top: 0, width: 800, height: 600 };
  const picture = { naturalWidth: 1280, naturalHeight: 800 };

  it("maps a click through the top-left anchored crop", () => {
    // The picture is scaled by 0.75 to cover 800x600, leaving 160px clipped
    // from the right edge; the top-left stays at the source origin.
    const centre = webuiBrowserPicturePoint(surface, picture, 400, 300);
    expect(centre.x).toBeCloseTo(400 / 0.75);
    expect(centre.y).toBeCloseTo(400);
  });

  it("clips points at the source page's right and bottom edges", () => {
    const bottomRight = webuiBrowserPicturePoint(surface, picture, 800, 600);
    expect(bottomRight.x).toBeCloseTo(800 / 0.75);
    expect(bottomRight.y).toBe(800);
    const topLeft = webuiBrowserPicturePoint(surface, picture, 0, 0);
    expect(topLeft).toEqual({ x: 0, y: 0 });
  });

  it("falls back to the surface when the picture has no size yet", () => {
    // Before the first frame there is no picture to measure, and the surface
    // is the only thing that can be measured.
    const point = webuiBrowserPicturePoint(surface, undefined, 100, 50);
    expect(point).toEqual({ x: 100, y: 50 });
  });
});
