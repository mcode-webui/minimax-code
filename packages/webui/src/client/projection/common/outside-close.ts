/**
 * Outside-close policy catalogue.
 *
 * Seven WebUI surfaces close themselves when an interaction happens outside
 * the surface's container. The implementations vary across components
 * today; this module captures the seven existing behaviours as data so the
 * truth table lives in one place and a future refactor (e.g. unifying
 * pointerdown + mousedown into a single hook) can read from it without
 * rebuilding the matrix.
 *
 * No runtime change for most of them: this module is documentation + a pure
 * evaluation function. The policy table pins the contract, whoever implements
 * it.
 *
 * Most of the surfaces below are `WebuiDropdown`s
 * (`client/ui/Dropdown.tsx`), and the shared skeleton is what implements their
 * row: it listens to pointerdown and to Escape, and closes the popup when the
 * press lands outside the trigger and the popup. The one surface that is not
 * a dropdown — the directory browser under the workspace picker — still
 * attaches its own listener, and its row says so.
 *
 * Pointer-event vocabulary:
 *
 *   `pointerdown` — the modern, fire-and-forget pointer event. Fires for
 *                    mouse, touch, pen. Used by every dropdown in the client.
 *   `mousedown`    — the legacy mouse-only event. No surface subscribes to it
 *                    any more: the context menu used to, and it is a dropdown
 *                    now.
 *   `keydown`      — keyboard event. Every dropdown in the client listens for
 *                    Escape, at the document level, so it closes wherever the
 *                    focus is.
 *
 * Truth table — every (event, target-relationship-to-container) cell:
 *
 *   | surface        | pointerdown outside | pointerdown inside | Escape |
 *   |----------------|---------------------|--------------------|--------|
 *   | userMenu       | close               | ignore             | close  |
 *   | modelPicker    | close               | ignore             | close  |
 *   | permissionMenu | close               | ignore             | close  |
 *   | composerMenu   | close               | ignore             | close  |
 *   | mentionList    | close               | ignore             | close  |
 *   | slashPopover   | close (clear draft) | ignore             | close  |
 *   | contextMenu    | close               | ignore             | close  |
 *
 * Every cell maps to `evaluateOutsideClose(...) === true | false | null`
 * (null = event not subscribed by this surface; the component never
 * attaches a listener for it, so the value is purely documentation).
 *
 * "Container" is per-surface and the difference is load-bearing:
 * `permissionMenu`'s and `workspacePicker`'s containers are their own
 * trigger-and-body wraps, while `mentionList`'s and `slashPopover`'s are the
 * whole composer region. All of them therefore answer "ignore" for an inside
 * click, but they answer it for DIFFERENT clicks — the permission popover
 * dismisses on a textarea click, the mention list and the command palette do
 * not. Reusing one ref for both shapes is what made those panels stick.
 */

export type WebuiOutsideCloseSurface =
  | "userMenu"
  | "modelPicker"
  | "permissionMenu"
  | "composerMenu"
  | "mentionList"
  | "workspacePicker"
  | "slashPopover"
  | "contextMenu";

export type WebuiOutsideCloseEventKind = "pointerdown" | "mousedown" | "keydown";

/**
 * One row of the policy table. `subscribedKinds` lists the events the
 * surface attaches listeners for; the `kind` value the listener cares
 * about for `keydown` is the `key` field, all other surfaces close on any
 * event of the subscribed kind. `usesContainerContains` is always true
 * today (every implementation uses `Node.contains` to test inside-ness);
 * the flag exists so a future portal-rendered surface can flip it off
 * without rewriting the table.
 */
export interface WebuiOutsideClosePolicy {
  readonly surface: WebuiOutsideCloseSurface;
  readonly subscribedKinds: readonly WebuiOutsideCloseEventKind[];
  readonly usesContainerContains: true;
  readonly onEscape?: boolean;
  readonly notes: string;
}

export const WEBUI_OUTSIDE_CLOSE_POLICIES: {
  readonly [K in WebuiOutsideCloseSurface]: WebuiOutsideClosePolicy;
} = {
  userMenu: {
    surface: "userMenu",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "UserMenu is a WebuiDropdown: the shared skeleton listens to pointerdown + keydown; Escape closes; the keydown does not check inside-ness (Escape is a global key).",
  },
  modelPicker: {
    surface: "modelPicker",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "The model picker is a WebuiDropdown: the shared skeleton listens to pointerdown + keydown. Its own container is the trigger's wrapper, and the picker is placed against the trigger in viewport coordinates. Escape does not simply close it: the panel steps DOWN one level (settings → list → closed), and the picker's settings FLY-OUT is a second dropdown of its own whose dismissal RETRACTS the fly-out rather than closing the panel. The two share one Escape keypress, so the first handler to claim it answers and the other stays quiet — the panel is the one that registered first, because the fly-out can only exist while the panel does. A press inside the panel is NOT 'ignore' for the fly-out: it retracts the fly-out, which is why the fly-out answers 'close' there and the panel answers 'ignore'.",
  },
  permissionMenu: {
    surface: "permissionMenu",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "Permission popover is a WebuiDropdown: the shared skeleton listens to pointerdown at the document level and closes when the press lands outside the trigger and the popup — so a click on the textarea or any other footer control dismisses it. Escape is handled by the skeleton at the document level, so it closes wherever the focus is.",
  },
  composerMenu: {
    surface: "composerMenu",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "The composer's `+` menu (attach / skills / plugins / goal / plan) is a WebuiDropdown: the shared skeleton listens to pointerdown and closes when the press lands outside the trigger and the panel — so a click on the textarea or any other footer control dismisses it. Escape is handled by the skeleton.",
  },
  mentionList: {
    surface: "mentionList",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "The mention list is a WebuiDropdown in its triggerless shape: a keystroke in the textarea opens it, so it has no trigger to hang from. It names the composer's region as the place a press inside is NOT a dismissal — a press in the text, in the attachments or on the send button is the user still working — and closes when the press lands clear of that region. Escape closes it and the caret keeps the focus, because the caret is where the user already was.",
  },
  workspacePicker: {
    surface: "workspacePicker",
    subscribedKinds: ["pointerdown"],
    usesContainerContains: true,
    notes:
      "The workspace picker's DIRECTORY BROWSER listens to pointerdown only; its container is its own wrap — the trigger pill plus the browser dialog — so any other click dismisses it. It had no Escape handler of its own: Escape was never wired for this surface. It is wired now, but not here — the browser is a managed layer, so the coordinator answers the Escape for it. This table records what each surface did while it answered its own events; it has no production caller left.",
  },
  slashPopover: {
    surface: "slashPopover",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "The command palette is a WebuiDropdown in its triggerless shape: a `/` in the textarea opens it. It names the composer's region as the place a press inside is NOT a dismissal, and closing it cancels the invocation — the `/xxx` token is dropped from the draft, exactly as Escape drops it.",
  },
  contextMenu: {
    surface: "contextMenu",
    subscribedKinds: ["pointerdown", "keydown"],
    usesContainerContains: true,
    onEscape: true,
    notes:
      "The context menu is a WebuiDropdown in its triggerless shape: the anchor is the point the menu opens at, not a trigger. The shared skeleton listens to pointerdown and to keydown; Escape closes it. It used to listen to `mousedown` for desktop parity — the skeleton reads `pointerdown`, which fires for mouse, touch and pen alike and always before the click does.",
  },
} as const;

/**
 * Pure evaluation: given a surface policy, an event kind, an event key (for
 * keydown), and whether the target is inside the container, return whether
 * the close should fire.
 *
 * Behaviour table:
 *
 *   | surface        | event       | key     | inside | result     |
 *   |----------------|-------------|---------|--------|------------|
 *   | userMenu       | pointerdown | (any)   | true   | ignore     |
 *   | userMenu       | pointerdown | (any)   | false  | close      |
 *   | userMenu       | keydown     | Escape  | (any)  | close      |
 *   | userMenu       | keydown     | other   | (any)  | ignore     |
 *   | modelPicker    | pointerdown | (any)   | true   | ignore     |
 *   | modelPicker    | pointerdown | (any)   | false  | close      |
 *   | modelPicker    | keydown     | Escape  | (any)  | close      |
 *   | permissionMenu | pointerdown | (any)   | true   | ignore     |
 *   | permissionMenu | pointerdown | (any)   | false  | close      |
 *   | permissionMenu | keydown     | Escape  | (any)  | close      |
 *   | permissionMenu | keydown     | other   | (any)  | ignore     |
 *   | composerMenu   | pointerdown | (any)   | true   | ignore     |
 *   | composerMenu   | pointerdown | (any)   | false  | close      |
 *   | mentionList    | pointerdown | (any)   | true   | ignore     |
 *   | mentionList    | pointerdown | (any)   | false  | close      |
 *   | workspacePicker| pointerdown | (any)  | true   | ignore     |
 *   | workspacePicker| pointerdown | (any)  | false  | close      |
 *   | slashPopover   | pointerdown | (any)   | true   | ignore     |
 *   | slashPopover   | pointerdown | (any)   | false  | close      |
 *   | contextMenu    | pointerdown | (any)   | true   | ignore     |
 *   | contextMenu    | pointerdown | (any)   | false  | close      |
 *   | contextMenu    | keydown     | Escape  | (any)  | close      |
 *
 * Events the surface does NOT subscribe to return `null` (the component
 * would never attach a listener for that kind, so the value is purely
 * documentation).
 */
export type WebuiOutsideCloseDecision = "close" | "ignore" | "not-subscribed";

export function evaluateOutsideClose(args: {
  readonly surface: WebuiOutsideCloseSurface;
  readonly kind: WebuiOutsideCloseEventKind;
  readonly key?: string;
  readonly insideContainer: boolean;
}): WebuiOutsideCloseDecision {
  const policy = WEBUI_OUTSIDE_CLOSE_POLICIES[args.surface];
  if (!policy.subscribedKinds.includes(args.kind)) {
    return "not-subscribed";
  }
  if (args.kind === "keydown") {
    if (args.key === "Escape" && policy.onEscape === true) return "close";
    return "ignore";
  }
  // pointerdown / mousedown — close when the event target is outside
  // the surface container; ignore when the user clicked inside.
  if (args.insideContainer) return "ignore";
  return "close";
}
