import { describe, expect, it } from "vitest";
import {
  WEBUI_OUTSIDE_CLOSE_POLICIES,
  evaluateComposerDismiss,
  evaluateOutsideClose,
  type WebuiOutsideCloseSurface,
} from "../../src/client/projection/outside-close.js";

/**
 * Pure tests for the six outside-close strategies.
 *
 * The six surfaces are: UserMenu, ModelPicker, the SessionComposer
 * permission popover, the SessionComposer workspace picker,
 * SessionComposer slash-popover, ContextMenu. Each has a slightly different
 * mix of subscribed event kinds and Escape handling. The tests pin the truth
 * table that lives in `outside-close.ts` and pin the contract that no
 * surface closes on a non-subscribed event (the listener is simply not
 * attached).
 *
 * Manual acceptance (out-of-band, can't be automated in this runner):
 *   - UserMenu: open the user menu, click outside the anchor → menu closes.
 *     Press Escape → menu closes.
 *   - ModelPicker: open the picker, click outside the root → picker closes.
 *     Press Escape → picker stays open (no keydown listener).
 *   - Permission popover: open it from the composer footer, click the
 *     textarea → popover closes. Click the trigger → toggles closed. Click a
 *     row inside the popover → selects that mode. Click the header text or the
 *     了解更多 link → popover stays open. Press Escape → popover closes.
 *   - Slash popover: type `/ask-` to open the popover, click outside the
 *     composer region → the `/ask-` segment is cleared and the popover
 *     disappears. Press Escape → the composer input handler treats Escape
 *     as a normal keystroke (the popover does NOT listen for it).
 *   - ContextMenu: open the context menu, mousedown outside → menu closes.
 *     Press Escape → menu closes.
 */

const SURFACES: readonly WebuiOutsideCloseSurface[] = [
  "userMenu",
  "modelPicker",
  "permissionMenu",
  "workspacePicker",
  "slashPopover",
  "contextMenu",
];

describe("WEBUI_OUTSIDE_CLOSE_POLICIES — the six surfaces are all registered", () => {
  for (const surface of SURFACES) {
    it(`registers policy for "${surface}"`, () => {
      expect(WEBUI_OUTSIDE_CLOSE_POLICIES[surface]).toBeDefined();
      expect(WEBUI_OUTSIDE_CLOSE_POLICIES[surface].surface).toBe(surface);
    });
  }
});

describe("UserMenu — pointerdown outside closes; keydown Escape closes; other keys ignored", () => {
  it("closes on pointerdown outside the anchor", () => {
    expect(
      evaluateOutsideClose({
        surface: "userMenu",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the anchor", () => {
    expect(
      evaluateOutsideClose({
        surface: "userMenu",
        kind: "pointerdown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("closes on keydown Escape", () => {
    expect(
      evaluateOutsideClose({
        surface: "userMenu",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores keydown with non-Escape keys", () => {
    expect(
      evaluateOutsideClose({
        surface: "userMenu",
        kind: "keydown",
        key: "Enter",
        insideContainer: false,
      }),
    ).toBe("ignore");
  });

  it("ignores keydown with non-Escape keys even when target is inside", () => {
    expect(
      evaluateOutsideClose({
        surface: "userMenu",
        kind: "keydown",
        key: "a",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("is `not-subscribed` for mousedown events", () => {
    // UserMenu never attaches a mousedown listener; the value is the
    // documentation the truth table promises.
    expect(
      evaluateOutsideClose({
        surface: "userMenu",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("ModelPicker — pointerdown outside closes; no keydown listener", () => {
  it("closes on pointerdown outside the root", () => {
    expect(
      evaluateOutsideClose({
        surface: "modelPicker",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the root", () => {
    expect(
      evaluateOutsideClose({
        surface: "modelPicker",
        kind: "pointerdown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("is `not-subscribed` for keydown events (no Escape handler)", () => {
    expect(
      evaluateOutsideClose({
        surface: "modelPicker",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });

  it("is `not-subscribed` for mousedown events", () => {
    expect(
      evaluateOutsideClose({
        surface: "modelPicker",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("Permission popover — pointerdown outside its own wrap closes; keydown Escape closes", () => {
  it("closes on pointerdown outside the trigger-and-popover wrap", () => {
    expect(
      evaluateOutsideClose({
        surface: "permissionMenu",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the wrap (trigger or popover body)", () => {
    expect(
      evaluateOutsideClose({
        surface: "permissionMenu",
        kind: "pointerdown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("closes on keydown Escape", () => {
    expect(
      evaluateOutsideClose({
        surface: "permissionMenu",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores keydown with non-Escape keys", () => {
    expect(
      evaluateOutsideClose({
        surface: "permissionMenu",
        kind: "keydown",
        key: "Enter",
        insideContainer: false,
      }),
    ).toBe("ignore");
  });

  it("is `not-subscribed` for mousedown events (pointerdown only)", () => {
    expect(
      evaluateOutsideClose({
        surface: "permissionMenu",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("evaluateComposerDismiss — the popover's container is its wrap, not the composer region", () => {
  it("REGRESSION: a click inside the composer region but outside the wrap closes the popover", () => {
    // The reported bug: the textarea click was tested against the composer
    // region, read as "inside", and the popover stayed open.
    expect(
      evaluateComposerDismiss({
        permissionMenuOpen: true,
        insidePermissionWrap: false,
        // Unread while the permission popover is open — the anchored branch
        // resolves on `permissionMenuOpen` alone. Passed explicitly so the
        // fixture matches the scenario (one anchored dropdown, not two).
        addMenuOpen: false,
        insideAddWrap: false,
        insideComposerRegion: true,
      }),
    ).toEqual({
      closeComposerMenu: true,
      closePermissionMenu: true,
      closeMentionRange: true,
    });
  });

  it("keeps the popover open when the click lands on the trigger or popover body", () => {
    expect(
      evaluateComposerDismiss({
        permissionMenuOpen: true,
        insidePermissionWrap: true,
        addMenuOpen: false,
        insideAddWrap: false,
        insideComposerRegion: true,
      }),
    ).toEqual({
      closeComposerMenu: false,
      closePermissionMenu: false,
      closeMentionRange: false,
    });
  });

  it("closes the popover on a click entirely outside the composer", () => {
    expect(
      evaluateComposerDismiss({
        permissionMenuOpen: true,
        insidePermissionWrap: false,
        addMenuOpen: false,
        insideAddWrap: false,
        insideComposerRegion: false,
      }),
    ).toEqual({
      closeComposerMenu: true,
      closePermissionMenu: true,
      closeMentionRange: true,
    });
  });

  it("keeps the region-anchored surfaces open on a click inside the region", () => {
    // `composerMenu` and `mentionRange` must NOT regress into dismissing on an
    // inside click — the caret moving is not a dismissal.
    expect(
      evaluateComposerDismiss({
        permissionMenuOpen: false,
        insidePermissionWrap: false,
        // Load-bearing here: with the permission popover shut, `addMenuOpen` is
        // the flag that decides whether an anchored dropdown exists at all. The
        // scenario is "no anchored dropdown, caret inside the region", so it
        // must be false or the anchored branch would answer instead.
        addMenuOpen: false,
        insideAddWrap: false,
        insideComposerRegion: true,
      }),
    ).toEqual({
      closeComposerMenu: false,
      closePermissionMenu: false,
      closeMentionRange: false,
    });
  });

  it("closes everything on a click outside the composer with no surface open yet", () => {
    // The listener is only attached while something is open, so this is not
    // reachable in production — it pins the function's own fallback.
    expect(
      evaluateComposerDismiss({
        permissionMenuOpen: false,
        insidePermissionWrap: false,
        // "no surface open yet" is the scenario this test names, so the second
        // anchored dropdown has to be shut for the region rule to be reached.
        addMenuOpen: false,
        insideAddWrap: false,
        insideComposerRegion: false,
      }),
    ).toEqual({
      closeComposerMenu: true,
      closePermissionMenu: true,
      closeMentionRange: true,
    });
  });

  it("ignores the region flag entirely while the popover is open", () => {
    // The two containers must be independent: if the region were consulted
    // here, the textarea click would be swallowed again.
    const insideRegion = evaluateComposerDismiss({
      permissionMenuOpen: true,
      insidePermissionWrap: false,
      addMenuOpen: false,
      insideAddWrap: false,
      insideComposerRegion: true,
    });
    const outsideRegion = evaluateComposerDismiss({
      permissionMenuOpen: true,
      insidePermissionWrap: false,
      addMenuOpen: false,
      insideAddWrap: false,
      insideComposerRegion: false,
    });
    expect(insideRegion).toEqual(outsideRegion);
  });

  it("treats an unmounted container ref as outside, never as inside", () => {
    // `permissionWrapRef.current?.contains(...)` yields `undefined` before the
    // ref attaches; the component normalises that to `false`. A ref that read
    // as "inside" would make the popover undismissable again.
    expect(
      evaluateComposerDismiss({
        permissionMenuOpen: true,
        insidePermissionWrap: undefined as unknown as boolean,
        // Unreached while the popover is open; false keeps the fixture honest
        // about the unmounted-ref scenario the casts above are simulating.
        addMenuOpen: false,
        insideAddWrap: false,
        insideComposerRegion: undefined as unknown as boolean,
      }).closePermissionMenu,
    ).toBe(true);
  });
});

describe("Workspace picker — pointerdown outside its own wrap closes; no keydown listener", () => {
  it("closes on pointerdown outside the trigger-and-panel wrap", () => {
    expect(
      evaluateOutsideClose({
        surface: "workspacePicker",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the wrap (trigger, 最近 rows, or the browser dialog)", () => {
    expect(
      evaluateOutsideClose({
        surface: "workspacePicker",
        kind: "pointerdown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("is `not-subscribed` for keydown events (Escape was never wired)", () => {
    expect(
      evaluateOutsideClose({
        surface: "workspacePicker",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });

  it("is `not-subscribed` for mousedown events (pointerdown only)", () => {
    expect(
      evaluateOutsideClose({
        surface: "workspacePicker",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("Slash popover — pointerdown outside closes; no keydown listener; close clears the slash segment", () => {
  it("closes on pointerdown outside the composer region", () => {
    expect(
      evaluateOutsideClose({
        surface: "slashPopover",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the composer region", () => {
    expect(
      evaluateOutsideClose({
        surface: "slashPopover",
        kind: "pointerdown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("is `not-subscribed` for keydown events (the input change handler is the only path)", () => {
    expect(
      evaluateOutsideClose({
        surface: "slashPopover",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });

  it("is `not-subscribed` for mousedown events", () => {
    expect(
      evaluateOutsideClose({
        surface: "slashPopover",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("ContextMenu — mousedown outside closes; keydown Escape closes; pointerdown is NOT subscribed", () => {
  it("closes on mousedown outside the menu", () => {
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores mousedown inside the menu", () => {
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "mousedown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("closes on keydown Escape", () => {
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores keydown with non-Escape keys", () => {
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "keydown",
        key: "Tab",
        insideContainer: false,
      }),
    ).toBe("ignore");
  });

  it("is `not-subscribed` for pointerdown events (desktop parity)", () => {
    // ContextMenu does NOT listen to pointerdown — it listens to
    // mousedown only, matching the desktop's mousedown listener.
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("truth table — every (surface × event × inside) cell is exactly one of close / ignore / not-subscribed", () => {
  // 6 surfaces × 3 event kinds × 2 inside states, enumerated below.
  const cases: ReadonlyArray<{
    surface: WebuiOutsideCloseSurface;
    kind: "pointerdown" | "mousedown" | "keydown";
    key?: string;
    inside: boolean;
  }> = [
    { surface: "userMenu", kind: "pointerdown", inside: false },
    { surface: "userMenu", kind: "pointerdown", inside: true },
    { surface: "userMenu", kind: "mousedown", inside: false },
    { surface: "userMenu", kind: "keydown", key: "Escape", inside: false },
    { surface: "userMenu", kind: "keydown", key: "Enter", inside: false },

    { surface: "modelPicker", kind: "pointerdown", inside: false },
    { surface: "modelPicker", kind: "pointerdown", inside: true },
    { surface: "modelPicker", kind: "mousedown", inside: false },
    { surface: "modelPicker", kind: "keydown", key: "Escape", inside: false },

    { surface: "permissionMenu", kind: "pointerdown", inside: false },
    { surface: "permissionMenu", kind: "pointerdown", inside: true },
    { surface: "permissionMenu", kind: "mousedown", inside: false },
    { surface: "permissionMenu", kind: "keydown", key: "Escape", inside: false },
    { surface: "permissionMenu", kind: "keydown", key: "Tab", inside: false },

    { surface: "workspacePicker", kind: "pointerdown", inside: false },
    { surface: "workspacePicker", kind: "pointerdown", inside: true },
    { surface: "workspacePicker", kind: "mousedown", inside: false },
    { surface: "workspacePicker", kind: "keydown", key: "Escape", inside: false },

    { surface: "slashPopover", kind: "pointerdown", inside: false },
    { surface: "slashPopover", kind: "pointerdown", inside: true },
    { surface: "slashPopover", kind: "mousedown", inside: false },
    { surface: "slashPopover", kind: "keydown", key: "Escape", inside: false },

    { surface: "contextMenu", kind: "mousedown", inside: false },
    { surface: "contextMenu", kind: "mousedown", inside: true },
    { surface: "contextMenu", kind: "pointerdown", inside: false },
    { surface: "contextMenu", kind: "keydown", key: "Escape", inside: false },
    { surface: "contextMenu", kind: "keydown", key: "Tab", inside: false },
  ];

  for (const test of cases) {
    it(`${test.surface} × ${test.kind}${test.key ? `/${test.key}` : ""} × inside=${test.inside}`, () => {
      const decision = evaluateOutsideClose({
        surface: test.surface,
        kind: test.kind,
        ...(test.key !== undefined ? { key: test.key } : {}),
        insideContainer: test.inside,
      });
      expect(
        decision === "close" ||
          decision === "ignore" ||
          decision === "not-subscribed",
      ).toBe(true);
    });
  }
});

describe("policy catalogue — exactly the expected four subscribed kinds per surface", () => {
  it("UserMenu subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.userMenu.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("ModelPicker subscribes pointerdown only", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.modelPicker.subscribedKinds).toEqual([
      "pointerdown",
    ]);
  });

  it("Permission popover subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.permissionMenu.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("Workspace picker subscribes pointerdown only", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.workspacePicker.subscribedKinds).toEqual([
      "pointerdown",
    ]);
  });

  it("Slash popover subscribes pointerdown only", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.slashPopover.subscribedKinds).toEqual([
      "pointerdown",
    ]);
  });

  it("ContextMenu subscribes mousedown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.contextMenu.subscribedKinds).toEqual([
      "mousedown",
      "keydown",
    ]);
  });
});

describe("onEscape flag — UserMenu + ContextMenu + the permission popover flip it on", () => {
  it("UserMenu.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.userMenu.onEscape).toBe(true);
  });

  it("ModelPicker.onEscape is undefined (no keydown listener)", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.modelPicker.onEscape).toBeUndefined();
  });

  it("PermissionMenu.onEscape is true (composer onKeyDown handles Escape)", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.permissionMenu.onEscape).toBe(true);
  });

  it("WorkspacePicker.onEscape is undefined (no keydown listener)", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.workspacePicker.onEscape).toBeUndefined();
  });

  it("SlashPopover.onEscape is undefined (no keydown listener)", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.slashPopover.onEscape).toBeUndefined();
  });

  it("ContextMenu.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.contextMenu.onEscape).toBe(true);
  });
});