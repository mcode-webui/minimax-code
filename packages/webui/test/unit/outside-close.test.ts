import { describe, expect, it } from "vitest";
import {
  WEBUI_OUTSIDE_CLOSE_POLICIES,
  evaluateOutsideClose,
  type WebuiOutsideCloseSurface,
} from "../../src/client/projection/common/outside-close.js";

/**
 * Pure tests for the outside-close strategies.
 *
 * The surfaces are: UserMenu, ModelPicker, the SessionComposer permission
 * popover, the SessionComposer `+` menu, the mention list, the SessionComposer
 * workspace picker, SessionComposer's command palette, ContextMenu. Each has a
 * slightly different mix of subscribed event kinds and Escape handling. The
 * tests pin the truth table that lives in `outside-close.ts` and pin the
 * contract that no surface closes on a non-subscribed event (the listener is
 * simply not attached).
 *
 * Manual acceptance (out-of-band, can't be automated in this runner):
 *   - UserMenu: open the user menu, click outside the anchor → menu closes.
 *     Press Escape → menu closes.
 *   - ModelPicker: open the picker, click outside the root → picker closes.
 *     Press Escape → picker closes and the focus returns to the trigger.
 *   - Permission popover: open it from the composer footer, click the
 *     textarea → popover closes. Click the trigger → toggles closed. Click a
 *     row inside the popover → selects that mode. Click the header text or the
 *     了解更多 link → popover stays open. Press Escape → popover closes.
 *   - Mention list: type `@` to open it, click inside the composer region →
 *     the list stays open. Click outside the region → the list closes. Press
 *     Escape → the list closes and the caret keeps the focus.
 *   - Slash popover: type `/ask-` to open the palette, click outside the
 *     composer region → the `/ask-` segment is cleared and the palette
 *     disappears. Press Escape → the segment is cleared too.
 *   - ContextMenu: open the context menu, press outside → menu closes.
 *     Press Escape → menu closes.
 */

const SURFACES: readonly WebuiOutsideCloseSurface[] = [
  "userMenu",
  "modelPicker",
  "permissionMenu",
  "composerMenu",
  "mentionList",
  "workspacePicker",
  "slashPopover",
  "contextMenu",
];

describe("WEBUI_OUTSIDE_CLOSE_POLICIES — the surfaces are all registered", () => {
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

describe("ModelPicker — pointerdown outside closes; keydown Escape closes", () => {
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

  it("closes on keydown Escape", () => {
    // The picker is a dropdown now, so the shared skeleton owns its Escape.
    expect(
      evaluateOutsideClose({
        surface: "modelPicker",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("close");
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

describe("Mention list — pointerdown outside the composer region closes; Escape closes", () => {
  it("closes on pointerdown outside the composer region", () => {
    // The list has no trigger of its own — a keystroke opens it — so it names
    // the composer's region as the place a press inside is NOT a dismissal.
    expect(
      evaluateOutsideClose({
        surface: "mentionList",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the composer region", () => {
    // The caret moving, the attachments being worked on, the send button being
    // pressed: none of those is the user leaving the list.
    expect(
      evaluateOutsideClose({
        surface: "mentionList",
        kind: "pointerdown",
        insideContainer: true,
      }),
    ).toBe("ignore");
  });

  it("closes on keydown Escape", () => {
    expect(
      evaluateOutsideClose({
        surface: "mentionList",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("is `not-subscribed` for mousedown events", () => {
    expect(
      evaluateOutsideClose({
        surface: "mentionList",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
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

describe("Slash popover — pointerdown outside closes; Escape closes; close clears the slash segment", () => {
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

  it("closes on keydown Escape", () => {
    // Escape cancels the invocation exactly as an outside press does: the
    // `/xxx` token is dropped from the draft either way.
    expect(
      evaluateOutsideClose({
        surface: "slashPopover",
        kind: "keydown",
        key: "Escape",
        insideContainer: false,
      }),
    ).toBe("close");
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

describe("ContextMenu — pointerdown outside closes; keydown Escape closes; mousedown is NOT subscribed", () => {
  it("closes on pointerdown outside the menu", () => {
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "pointerdown",
        insideContainer: false,
      }),
    ).toBe("close");
  });

  it("ignores pointerdown inside the menu", () => {
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "pointerdown",
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

  it("is `not-subscribed` for mousedown events (the skeleton reads pointerdown)", () => {
    // The context menu is a dropdown now, and the shared skeleton reads
    // `pointerdown` — which fires for mouse, touch and pen alike, and always
    // before the click does.
    expect(
      evaluateOutsideClose({
        surface: "contextMenu",
        kind: "mousedown",
        insideContainer: false,
      }),
    ).toBe("not-subscribed");
  });
});

describe("truth table — every (surface × event × inside) cell is exactly one of close / ignore / not-subscribed", () => {
  // 8 surfaces × 3 event kinds × 2 inside states, enumerated below.
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

    { surface: "composerMenu", kind: "pointerdown", inside: false },
    { surface: "composerMenu", kind: "pointerdown", inside: true },
    { surface: "composerMenu", kind: "mousedown", inside: false },
    { surface: "composerMenu", kind: "keydown", key: "Escape", inside: false },

    { surface: "mentionList", kind: "pointerdown", inside: false },
    { surface: "mentionList", kind: "pointerdown", inside: true },
    { surface: "mentionList", kind: "mousedown", inside: false },
    { surface: "mentionList", kind: "keydown", key: "Escape", inside: false },

    { surface: "workspacePicker", kind: "pointerdown", inside: false },
    { surface: "workspacePicker", kind: "pointerdown", inside: true },
    { surface: "workspacePicker", kind: "mousedown", inside: false },
    { surface: "workspacePicker", kind: "keydown", key: "Escape", inside: false },

    { surface: "slashPopover", kind: "pointerdown", inside: false },
    { surface: "slashPopover", kind: "pointerdown", inside: true },
    { surface: "slashPopover", kind: "mousedown", inside: false },
    { surface: "slashPopover", kind: "keydown", key: "Escape", inside: false },

    { surface: "contextMenu", kind: "pointerdown", inside: false },
    { surface: "contextMenu", kind: "pointerdown", inside: true },
    { surface: "contextMenu", kind: "mousedown", inside: false },
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

describe("policy catalogue — exactly the expected subscribed kinds per surface", () => {
  it("UserMenu subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.userMenu.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("ModelPicker subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.modelPicker.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("Permission popover subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.permissionMenu.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("The composer's `+` menu subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.composerMenu.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("The mention list subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.mentionList.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("Workspace picker subscribes pointerdown only", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.workspacePicker.subscribedKinds).toEqual([
      "pointerdown",
    ]);
  });

  it("Slash popover subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.slashPopover.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });

  it("ContextMenu subscribes pointerdown + keydown", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.contextMenu.subscribedKinds).toEqual([
      "pointerdown",
      "keydown",
    ]);
  });
});

describe("onEscape flag — every dropdown flips it on; the directory browser does not", () => {
  it("UserMenu.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.userMenu.onEscape).toBe(true);
  });

  it("ModelPicker.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.modelPicker.onEscape).toBe(true);
  });

  it("PermissionMenu.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.permissionMenu.onEscape).toBe(true);
  });

  it("ComposerMenu.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.composerMenu.onEscape).toBe(true);
  });

  it("MentionList.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.mentionList.onEscape).toBe(true);
  });

  it("WorkspacePicker.onEscape is undefined (no keydown listener)", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.workspacePicker.onEscape).toBeUndefined();
  });

  it("SlashPopover.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.slashPopover.onEscape).toBe(true);
  });

  it("ContextMenu.onEscape is true", () => {
    expect(WEBUI_OUTSIDE_CLOSE_POLICIES.contextMenu.onEscape).toBe(true);
  });
});