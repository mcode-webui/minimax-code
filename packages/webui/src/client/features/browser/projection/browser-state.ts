// The browser panel's state transitions.
//
// Pure: state in, state out. No effects, no timers, no port, no `fetch`. The
// panel's view and the owner that drives the port both reduce through here, so
// "what the panel shows" is one function that can be asserted without a DOM.
//
// Two decisions carry most of the weight.
//
// **Two cells, one writer each.** `viewedPage` is the client's: the person writes
// it by choosing a tab, and everything this panel *shows* or *forwards input to*
// reads it. `runSelection` is the runtime's: the Agent writes it, the client only
// mirrors the mark the runtime puts on the target list, and it decides which page
// the panel reports as the Agent's. No branch below writes one from the other's
// facts — the bootstrap that hands a run the page a person opened is decided by the
// runtime at the moment the page appears, not here.
//
// **The frame buffer is a record, keyed by tab.** A live stream pushes a frame
// per visual change; an append-only list would grow for as long as the session
// ran. Keeping one entry per key makes the bound structural rather than a
// trimming policy someone has to remember.
//
// **A frame that is older than what the panel is showing is dropped.** The frame
// carries its target's generation, and a page that navigated keeps its tab id but
// gets a new generation — so a frame from the previous page is a picture of
// something the person has already moved away from. Displaying it would show one
// page while the Agent drives another, which is the failure this whole business
// exists to prevent (ADR 0019). Dropping is counted rather than silent, because a
// panel that quietly stops updating and a panel that is dropping frames look
// identical from the outside.

import {
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  isSameWebuiBrowserTarget,
  isWebuiBrowserSurfaceAuthorized,
  type WebuiBrowserImageFrame,
  type WebuiBrowserSurface,
  type WebuiBrowserTargetId,
  type WebuiBrowserTargetList,
  type WebuiBrowserTargetState,
} from "../../../../shared/contracts/browser.js";
import {
  isSameWebuiBrowserTargetSlot,
  isUsableWebuiBrowserTargetId,
  webuiBrowserFrameKey,
  type WebuiBrowserPanelEvent,
  type WebuiBrowserPanelState,
  type WebuiBrowserPanelStatus,
  type WebuiBrowserTargetChange,
} from "../contracts/browser-panel.js";

export const initialWebuiBrowserPanelState: WebuiBrowserPanelState = {
  authorization: WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  surface: "isolated-chromium",
  targets: [],
  frames: {},
  status: "idle",
  droppedFrameCount: 0,
};

function frameHeld(state: WebuiBrowserPanelState, key: string): boolean {
  return Object.hasOwn(state.frames, key);
}

/**
 * Drops one buffered frame, by identity rather than by value.
 *
 * A no-op when the key is absent, so the reducers can call it unconditionally
 * instead of branching on whether the move they are reacting to dropped anything.
 */
function withoutFrame(
  state: WebuiBrowserPanelState,
  target: WebuiBrowserTargetId,
): WebuiBrowserPanelState["frames"] {
  const key = webuiBrowserFrameKey(target);
  if (!Object.hasOwn(state.frames, key)) return state.frames;
  const frames: Record<string, WebuiBrowserImageFrame> = { ...state.frames };
  delete frames[key];
  return frames;
}

/**
 * The status the state implies.
 *
 * Derived rather than stored on each branch so "ready" means one thing: the page
 * the person is looking at currently has a frame that belongs to the generation
 * being shown. Anything else that claims `ready` is a panel displaying a stale
 * page. The run's selection does not enter into it — it says which page the Agent
 * is on, and the Agent's page is not what this panel is showing.
 */
function deriveStatus(state: WebuiBrowserPanelState): WebuiBrowserPanelStatus {
  if (state.error) return "error";
  const viewed = state.viewedPage;
  if (!viewed) {
    if (state.status === "loading") return "loading";
    return state.targets.length === 0 ? state.status : "empty";
  }
  return frameHeld(state, webuiBrowserFrameKey(viewed)) ? "ready" : "loading";
}

function markSelection(
  targets: readonly WebuiBrowserTargetState[],
  selected: WebuiBrowserTargetId | undefined,
): readonly WebuiBrowserTargetState[] {
  return targets.map((target) => ({
    ...target,
    selected: selected ? isSameWebuiBrowserTarget(target.id, selected) : false,
  }));
}

/**
 * Adopts the newer generation the list reports for the page in front.
 *
 * The list is where a page that navigated shows up first: the tab keeps its id and
 * gains a generation, so a buffered picture of the previous page is a picture of
 * something the person has already moved away from. The move is reported rather
 * than applied quietly, because a panel that silently keeps showing the old page
 * and a panel that is waiting for the new one look identical from the outside.
 */
function adoptNewerGeneration(
  state: WebuiBrowserPanelState,
  page: WebuiBrowserTargetId | undefined,
): {
  readonly page?: WebuiBrowserTargetId;
  readonly frames: WebuiBrowserPanelState["frames"];
  readonly targetChange?: WebuiBrowserTargetChange;
} {
  if (!page) return { page, frames: state.frames };
  const listed = state.targets.find(
    (candidate) => webuiBrowserFrameKey(candidate.id) === webuiBrowserFrameKey(page),
  );
  if (!listed) {
    // The page is no longer in the list. It is cleared rather than moved: a
    // fallback to another page is exactly the substitution the ADR forbids, and an
    // empty panel says what happened where a different page would not.
    return { frames: withoutFrame(state, page), targetChange: undefined };
  }
  if (listed.id.generation > page.generation) {
    return {
      page: listed.id,
      frames: withoutFrame(state, listed.id),
      targetChange: { target: listed.id, previousGeneration: page.generation },
    };
  }
  return { page, frames: state.frames };
}

export function reduceWebuiBrowserPanelState(
  state: WebuiBrowserPanelState,
  event: WebuiBrowserPanelEvent,
): WebuiBrowserPanelState {
  switch (event.type) {
    case "authorization-loaded":
      return { ...state, authorization: event.authorization };

    case "capabilities-loaded":
      return { ...state, capabilities: event.entries };

    case "surface-changed":
      return state.surface === event.surface
        ? state
        : { ...state, surface: event.surface, targets: [], runSelection: undefined, viewedPage: undefined, frames: {}, status: "idle" };

    case "targets-requested":
      return { ...state, status: "loading", error: undefined };

    case "targets-loaded": {
      const surfaceChanged = event.list.surface !== state.surface;
      // The runtime's cell, mirrored. A new list for the same surface keeps the
      // run's selection across refreshes; a list for a different surface starts
      // over, because a target id from one surface means nothing in another.
      const runSelection = surfaceChanged ? event.selected : (event.selected ?? state.runSelection);
      // The client's cell only survives a list for the same surface, and the
      // comparison is made against the list that just arrived rather than the one
      // held before: that list is where a replaced page first shows up.
      const base: WebuiBrowserPanelState = surfaceChanged
        ? { ...state, targets: event.list.targets, viewedPage: undefined, frames: {} }
        : { ...state, targets: event.list.targets };
      const viewed = adoptNewerGeneration(base, base.viewedPage);
      const next: WebuiBrowserPanelState = {
        ...state,
        surface: event.list.surface,
        // The marked list is the runtime's answer about its own cell, so it is
        // taken as it arrives rather than recomputed here.
        targets: markSelection(event.list.targets, runSelection),
        runSelection,
        viewedPage: viewed.page,
        frames: viewed.frames,
        status: event.list.targets.length === 0 ? "empty" : state.status,
        error: undefined,
        targetChange: viewed.targetChange,
      };
      return { ...next, status: deriveStatus(next) };
    }

    case "page-viewed": {
      // The client's cell, written by the person choosing a tab. It moves
      // nothing else: the run's selection is the runtime's, and the picture and
      // the input both follow this page instead.
      if (!isUsableWebuiBrowserTargetId(event.target)) return state;
      const previous = state.viewedPage;
      if (previous && isSameWebuiBrowserTarget(previous, event.target)) return state;
      const moved = previous
        ? {
            targetChange: {
              target: event.target,
              previousGeneration: previous.generation,
            },
            // A different tab keeps its own buffered frame — the buffer is one
            // frame per tab. The same tab on a newer generation does not: that
            // picture is of the page that is gone.
            frames: isSameWebuiBrowserTargetSlot(previous, event.target)
              ? withoutFrame(state, event.target)
              : state.frames,
          }
        : {};
      const next: WebuiBrowserPanelState = {
        ...state,
        surface: event.target.surface,
        viewedPage: event.target,
        error: undefined,
        ...(previous ? moved : { targetChange: undefined }),
      };
      // Derived rather than set, so a tab the panel has no frame for yet reads as
      // "waiting for the first frame" rather than as "ready".
      return { ...next, status: deriveStatus(next) };
    }

    case "target-changed": {
      // The runtime's cell: the run's own page moved on. It moves the run's
      // selection and nothing else — the page the person is looking at is not the
      // run's, so a move here must not disturb the picture or the input binding.
      // A different tab is not "this page moved on" and is ignored rather than
      // adopted: the run's selection is the runtime's to report, and the list it
      // publishes on the next read is the authoritative answer anyway.
      const target = event.target;
      if (!isUsableWebuiBrowserTargetId(target)) return state;
      const previous = state.runSelection;
      if (!previous || !isSameWebuiBrowserTargetSlot(previous, target)) return state;
      return { ...state, surface: target.surface, runSelection: target, error: undefined };
    }

    case "run-changed": {
      // A run's selection is that run's. When the active run changes, the panel
      // stops reporting the previous run's selection: the marked tabs are cleared
      // and wait for the new run's own answer. What is *not* cleared is the
      // page the person is looking at and the frames buffered for it — neither
      // belongs to the run that just left.
      if (state.runSelection === undefined) return state;
      const next: WebuiBrowserPanelState = {
        ...state,
        runSelection: undefined,
        targets: markSelection(state.targets, undefined),
      };
      return { ...next, status: deriveStatus(next) };
    }

    case "frame": {
      const frame = event.frame;
      if (!isUsableWebuiBrowserTargetId(frame.target)) return dropped(state);
      const key = webuiBrowserFrameKey(frame.target);
      const shown = state.viewedPage;
      // The panel is showing a newer generation of this very tab: the frame is a
      // picture of a page that no longer exists.
      if (shown && webuiBrowserFrameKey(shown) === key && frame.target.generation < shown.generation) {
        return dropped(state);
      }
      const held = frameHeld(state, key) ? state.frames[key] : undefined;
      if (held && held.target.generation > frame.target.generation) return dropped(state);
      // Sequence is monotonic per stream, so a lower one is a reordered frame
      // rather than a newer picture.
      if (held && held.target.generation === frame.target.generation && held.sequence > frame.sequence) {
        return dropped(state);
      }
      const next: WebuiBrowserPanelState = { ...state, frames: { ...state.frames, [key]: frame } };
      return { ...next, status: deriveStatus(next) };
    }

    case "failed":
      return { ...state, error: event.error, status: "error" };

    case "error-dismissed":
      return state.error ? { ...state, error: undefined, status: deriveStatus({ ...state, error: undefined }) } : state;

    case "closed":
      return initialWebuiBrowserPanelState;
  }
}

function dropped(state: WebuiBrowserPanelState): WebuiBrowserPanelState {
  return { ...state, droppedFrameCount: state.droppedFrameCount + 1 };
}

// ---------------------------------------------------------------------------
// Selectors. Derived from the state, so a view never recomputes them inline.
// ---------------------------------------------------------------------------

/** The frame the panel should display, or `undefined` when there is none to show. */
export function selectWebuiBrowserFrame(
  state: WebuiBrowserPanelState,
): WebuiBrowserPanelState["frames"][string] | undefined {
  const viewed = state.viewedPage;
  if (!viewed) return undefined;
  const key = webuiBrowserFrameKey(viewed);
  return frameHeld(state, key) ? state.frames[key] : undefined;
}

/**
 * The target the live image stream should be open for.
 *
 * It is the page the person is looking at and nothing else — the client's cell, not
 * the run's selection. A tab with no page in front has nothing to stream, so the
 * answer is `undefined` and the panel opens no subscription: a subscription for a
 * page the person is not looking at delivers a picture of somebody else's work,
 * and one that can never deliver a frame leaves the panel blank anyway.
 *
 * The decision is a pure function so it can be tested without a DOM renderer;
 * the client test environment has none.
 */
export function selectWebuiBrowserStreamTarget(
  state: WebuiBrowserPanelState,
): WebuiBrowserTargetId | undefined {
  return state.viewedPage;
}

/**
 * A stable key for the stream's target.
 *
 * The subscription is re-opened when this changes, so it has to name the
 * browser, the tab and the generation — a tab that was replaced is a
 * different page even though it is the same tab.
 */
export function webuiBrowserStreamTargetKey(
  target: WebuiBrowserTargetId | undefined,
): string | undefined {
  if (!target) return undefined;
  return `${target.browserId}:${target.targetId}:${target.generation}`;
}

/**
 * The page the person is looking at, as the target list knows it.
 *
 * The list is where the title and url come from, so this is what the view reads to
 * name the page it is showing and whether input may be forwarded to it.
 */
export function selectWebuiBrowserViewedTarget(
  state: WebuiBrowserPanelState,
): WebuiBrowserTargetState | undefined {
  const viewed = state.viewedPage;
  if (!viewed) return undefined;
  return state.targets.find((candidate) => isSameWebuiBrowserTarget(candidate.id, viewed));
}

/**
 * The run's selection, as the target list reports it.
 *
 * The service marks exactly one target per run, so this is how the client learns
 * which page the *active run* is driving without the run having to announce it —
 * and `undefined` when that run has selected nothing, which is the answer for a
 * panel that is showing a browser with no run behind it. It is the runtime's cell
 * being read, never written: the person cannot hand the Agent a page by clicking
 * one here, and the strip's tab choice does not move it either.
 */
export function selectedWebuiBrowserRunTarget(
  list: WebuiBrowserTargetList,
): WebuiBrowserTargetId | undefined {
  return list.targets.find((target) => target.selected)?.id;
}

/** Whether the surface the panel is showing is authorized to be shown at all. */
export function selectWebuiBrowserSurfaceAuthorized(state: WebuiBrowserPanelState): boolean {
  return isWebuiBrowserSurfaceAuthorized(state.authorization, state.surface);
}

/** Every surface with its switch, so the view renders the list from one derivation. */
export function selectWebuiBrowserSurfaceAuthorization(
  state: WebuiBrowserPanelState,
  surface: WebuiBrowserSurface,
): boolean {
  return isWebuiBrowserSurfaceAuthorized(state.authorization, surface);
}

/**
 * The `data:` URL a frame renders through, or `undefined` when it must not be
 * rendered at all.
 *
 * The panel is a live *image* stream, never an embedded document: an iframe,
 * `srcdoc` or a blob URL would give the target page the WebUI's own origin and
 * put its scripts next to the session token. An `<img>` over a `data:` URL cannot
 * execute anything, and the payload is checked against the base64 alphabet and
 * the two formats the contract allows before it reaches `src` — a host that sent
 * something else gets no element rather than an element that guesses.
 */
export function webuiBrowserFrameDataUrl(
  frame: WebuiBrowserPanelState["frames"][string] | undefined,
): string | undefined {
  if (!frame) return undefined;
  if (frame.format !== "png" && frame.format !== "jpeg") return undefined;
  if (typeof frame.data !== "string" || frame.data.length === 0) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)) return undefined;
  return `data:image/${frame.format};base64,${frame.data}`;
}
