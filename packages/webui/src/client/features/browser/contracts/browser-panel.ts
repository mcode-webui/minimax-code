// The browser panel's own vocabulary: its state shape, its events, and the
// intents a pointer / keyboard / text gesture becomes before it is validated.
//
// This module is a leaf. It declares shapes and the one pure derivation every
// other browser module needs — the key that says "which tab is this" — and it
// imports nothing but the shared contracts. The reducers that move the state
// live in `../projection/browser-state.ts` and the validation lives in
// `../application/browser-commands.ts`; keeping the shapes here is what lets both
// of those stay free of the other's concerns, and lets the Settings surface name
// the same state without importing a reducer.
//
// The generation is the load-bearing part. A target id carries the generation of
// the page behind it, so `webuiBrowserFrameKey` deliberately *excludes* it: the
// key answers "which tab", while the generation answers "which page of that tab".
// A generation that moves forward therefore replaces the entry under the same key
// rather than adding a second one, which is what keeps the frame buffer bounded
// to one frame per tab however long a session runs.
//
// Two cells live here, one writer each (ADR 0022): `runSelection` is the runtime's
// and the Agent writes it, `viewedPage` is the client's and the person writes it.
// Anything in this module that answers "what is the panel showing" or "what does a
// gesture land on" reads `viewedPage`, and anything that answers "what is the Agent
// working on" reads `runSelection`. The bootstrap is the one write that crosses, and
// it is the runtime's to make.

import type {
  WebuiBrowserAuthorization,
  WebuiBrowserCapabilityEntry,
  WebuiBrowserError,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserInputModifier,
  WebuiBrowserSurface,
  WebuiBrowserTargetGeneration,
  WebuiBrowserTargetId,
  WebuiBrowserTargetList,
  WebuiBrowserTargetState,
} from "../../../../shared/contracts/browser.js";
import { WEBUI_BROWSER_TARGET_GENERATION_UNSET } from "../../../../shared/contracts/browser.js";

/**
 * The capability family this business reports under.
 *
 * The manifest is a name-keyed record, so the panel reads its own family's state
 * rather than inferring support from the presence of a port method. A host that
 * sends no manifest at all is `unknown`, which is not `supported`: the panel has
 * to be able to say "this build does not tell me" separately from "this host does
 * not have it".
 */
export const WEBUI_BROWSER_CAPABILITY_NAME = "browser";

/** The panel's own state. Read by the view, moved only by the reducers. */
export type WebuiBrowserPanelStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error";

/**
 * A target that moved on under the panel.
 *
 * Kept rather than resolved silently: the user's previous input is no longer
 * valid against whatever replaced the page, and the only honest way to say so is
 * to say it.
 */
export interface WebuiBrowserTargetChange {
  readonly target: WebuiBrowserTargetId;
  /** The generation the panel was showing before the move. */
  readonly previousGeneration: WebuiBrowserTargetGeneration;
}

/**
 * The run's selection — the runtime's cell.
 *
 * The page one run acts on, and the runtime owns it: the Agent writes it through
 * its own `open_tab` and its own selection operation, and the client only ever
 * *reads* it, out of the target list the runtime publishes, to be able to say which
 * page the Agent is working on. Nothing a person does writes this cell — not a
 * click, not a tab, not a gesture. The one exception is the bootstrap, and it is
 * decided by the runtime at the moment a person opens a web tab (ADR 0022).
 */
export type WebuiBrowserRunSelectionTarget = WebuiBrowserTargetId;

/**
 * The tab the person is looking at — the client's cell.
 *
 * This is the page a web tab holds, and the person writes it by choosing a tab; the
 * Agent never writes it. It is what the panel shows and what a pointer, key or text
 * gesture is bound to, which is the whole reason it is not the run's selection: an
 * input aimed at the page in front must never be delivered to the page the Agent is
 * working on.
 */
export type WebuiBrowserViewedPage = WebuiBrowserTargetId;

export interface WebuiBrowserPanelState {
  /** The four switches. Off until a read says otherwise. */
  readonly authorization: WebuiBrowserAuthorization;
  /** The surface whose targets are listed. */
  readonly surface: WebuiBrowserSurface;
  readonly targets: readonly WebuiBrowserTargetState[];
  /** The runtime's cell: which page this run acts on. Read-only for the client. */
  readonly runSelection?: WebuiBrowserRunSelectionTarget;
  /** The client's cell: which page the person is looking at, and what is shown. */
  readonly viewedPage?: WebuiBrowserViewedPage;
  /**
   * The newest frame per target, keyed by `webuiBrowserFrameKey`.
   *
   * A record rather than a list on purpose: a live stream pushes a frame per
   * change, so an append-only buffer is a leak with a UI attached. One entry per
   * key is the whole bound.
   */
  readonly frames: Readonly<Record<string, WebuiBrowserImageFrame>>;
  readonly status: WebuiBrowserPanelStatus;
  readonly error?: WebuiBrowserError;
  readonly capabilities?: readonly WebuiBrowserCapabilityEntry[];
  /** Set while the viewed page's generation has moved past what was shown. */
  readonly targetChange?: WebuiBrowserTargetChange;
  /** How many frames were dropped as stale, so the panel can say so. */
  readonly droppedFrameCount: number;
}

/**
 * The panel's inputs.
 *
 * These are *intents*, not commands: they carry what the gesture said and
 * nothing about which page it was aimed at. The target is supplied separately at
 * send time, so a command can never be built against a page the panel has since
 * stopped showing — that binding is the whole reason the two are separate types.
 */
export interface WebuiBrowserPointerIntent {
  readonly kind: "pointer";
  /** Omitted means an atomic click for existing command callers. */
  readonly action?: "press" | "release" | "move" | "scroll";
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "middle" | "right";
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export interface WebuiBrowserKeyIntent {
  readonly kind: "key";
  readonly key: string;
  readonly code?: string;
  /** The character the key produces, when it produces one. */
  readonly text?: string;
  readonly modifiers: readonly WebuiBrowserInputModifier[];
}

export interface WebuiBrowserTextIntent {
  readonly kind: "text";
  readonly text: string;
}

export type WebuiBrowserInputIntent =
  | WebuiBrowserPointerIntent
  | WebuiBrowserKeyIntent
  | WebuiBrowserTextIntent;

/**
 * Why a command was refused, in terms the UI can act on.
 *
 * These are stable strings rather than prose because the panel's behaviour
 * differs per reason — a malformed payload is a bug in the panel, a stale
 * generation is a fact about the browser — and a caller that cannot tell them
 * apart will retry the wrong one.
 */
export type WebuiBrowserCommandRejectionReason =
  | "target_identity"
  | "target_unknown"
  | "target_generation_behind"
  | "target_generation_ahead"
  | "pointer_coordinate"
  | "pointer_button"
  | "pointer_click_count"
  | "key_name"
  | "key_modifier"
  | "text_empty"
  | "text_too_long";

/** Either a command the panel may forward, or the refusal that says why not. */
export type WebuiBrowserCommandResult =
  | { readonly ok: true; readonly command: WebuiBrowserInputCommand }
  | {
      readonly ok: false;
      readonly reason: WebuiBrowserCommandRejectionReason;
      readonly error: WebuiBrowserError;
    };

/** Everything the panel can be told. The reducers take one of these at a time. */
export type WebuiBrowserPanelEvent =
  | { readonly type: "authorization-loaded"; readonly authorization: WebuiBrowserAuthorization }
  | { readonly type: "capabilities-loaded"; readonly entries: readonly WebuiBrowserCapabilityEntry[] }
  | { readonly type: "surface-changed"; readonly surface: WebuiBrowserSurface }
  /**
   * The run whose selection the panel is showing changed.
   *
   * The panel follows the active run (ADR 0019), so a run taking over means the
   * previous run's selection stops being the panel's — the event carries no
   * target because the new run's answer arrives with the next target list.
   */
  | { readonly type: "run-changed" }
  | { readonly type: "targets-requested" }
  | {
      readonly type: "targets-loaded";
      readonly list: WebuiBrowserTargetList;
      /** The runtime's answer for this run's cell. Never written by the person. */
      readonly selected?: WebuiBrowserRunSelectionTarget;
    }
  /**
   * The page the person is looking at changed.
   *
   * This is the client's cell and the person's write: the strip holds the tabs and
   * hands the host the tab in front, so the host reports which page that is. It
   * moves the run's selection by nothing — the two cells are separate (ADR 0022).
   */
  | { readonly type: "page-viewed"; readonly target: WebuiBrowserViewedPage }
  /**
   * The run's page moved on.
   *
   * The runtime's cell only. It never moves the page in front: the Agent working
   * on its own tab is not a reason to change which tab the person is looking at.
   */
  | { readonly type: "target-changed"; readonly target: WebuiBrowserTargetId }
  | { readonly type: "frame"; readonly frame: WebuiBrowserImageFrame }
  | { readonly type: "failed"; readonly error: WebuiBrowserError }
  | { readonly type: "error-dismissed" }
  | { readonly type: "closed" };

/**
 * Which tab a target is, ignoring which page of it.
 *
 * The generation is excluded on purpose; see the module note. The parts are
 * encoded so that a `browserId` of `__proto__` cannot reach a prototype through
 * a plain object lookup, which the frame buffer does on every frame.
 */
export function webuiBrowserFrameKey(target: WebuiBrowserTargetId): string {
  return [
    target.surface,
    encodeURIComponent(target.browserId),
    encodeURIComponent(target.targetId),
  ].join("|");
}

/** The same identity check the shared contract provides, expressed on keys. */
export function isSameWebuiBrowserTargetSlot(
  left: WebuiBrowserTargetId | undefined,
  right: WebuiBrowserTargetId | undefined,
): boolean {
  if (!left || !right) return false;
  return webuiBrowserFrameKey(left) === webuiBrowserFrameKey(right);
}

/** A generation that has never been reported. */
export const WEBUI_BROWSER_UNSET_GENERATION: WebuiBrowserTargetGeneration =
  WEBUI_BROWSER_TARGET_GENERATION_UNSET;

/**
 * Whether a target id is internally usable at all.
 *
 * Checked before any command is built rather than trusted from the wire: an id
 * with an empty tab name or a `NaN` generation is not a page, and forwarding a
 * command that names one would push the failure to the provider.
 */
export function isUsableWebuiBrowserTargetId(
  target: WebuiBrowserTargetId | undefined,
): target is WebuiBrowserTargetId {
  if (!target) return false;
  if (!target.surface) return false;
  if (typeof target.browserId !== "string" || target.browserId.length === 0) return false;
  if (typeof target.targetId !== "string" || target.targetId.length === 0) return false;
  return (
    Number.isFinite(target.generation) &&
    Number.isInteger(target.generation) &&
    target.generation >= WEBUI_BROWSER_TARGET_GENERATION_UNSET
  );
}
