// The transcript's scroll binding: the one auto-follow policy, its viewport, and
// the pin that keeps the last message in view.
//
// This was two `useLayoutEffect`s and three module helpers inside
// `SessionTranscript.tsx`. The component renders; this owns the viewport.
//
// The policy, which the component's comments used to carry:
//
// One follower for the whole transcript, not one per way of arriving at it.
// Auto-follow is armed on a session change and when a turn goes live; a gesture
// releases it only when the viewport can answer that gesture; and being back at
// the bottom re-arms it. A non-live session used to have a second follower that
// released on any wheel or touchmove wherever the viewport sat and then never
// re-armed, so content arriving after such a gesture stayed below the fold — and
// a wheel at the bottom, which is recorded as `wheel-intent:ignored-boundary`,
// was enough to trigger it.
//
// Pinning cannot be a one-off either: after the first paint the content keeps
// growing (highlighting, images, markdown tables), and a single jump lands on the
// bottom of that frame's height, short of the real end by nearly a screen. The
// `ResizeObserver` here is what keeps it pinned.

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import {
  webuiScrollBottomTop,
  webuiScrollFollowsBottom,
  webuiScrollIntent,
} from "../projection/transcript-scroll.js";

const TRANSCRIPT_VIEWPORT_SELECTOR = '[data-webui-session-scroll="true"]';

/**
 * The scroll viewport that carries the transcript.
 *
 * It is an ancestor rather than the transcript element itself, and both this
 * binding and the transcript's older-page restore need it, so the selector lives
 * here instead of being spelled out each time.
 */
export function transcriptViewport(element: Element | null): HTMLElement | undefined {
  return element?.closest<HTMLElement>(TRANSCRIPT_VIEWPORT_SELECTOR) ?? undefined;
}

/** Pin the viewport to the last message, when this follower is armed. */
function pinTranscriptToBottom(viewport: HTMLElement, armed: boolean): void {
  if (armed) viewport.scrollTop = webuiScrollBottomTop(viewport);
}

/**
 * Watch the transcript's own height, so content that grows after the first paint
 * (highlighting, images, tables) keeps being followed. Returns `undefined` where
 * the environment has no `ResizeObserver`; the caller has nothing to disconnect.
 */
function observeTranscriptHeight(
  element: Element,
  onResize: () => void,
): (() => void) | undefined {
  if (typeof ResizeObserver === "undefined") return undefined;
  const observer = new ResizeObserver(onResize);
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * Follow the transcript's end while the reader stays at it.
 *
 * The follower re-arms on a session change and when a turn goes live. That
 * transition is tracked here rather than passed in: this hook is the only reader
 * that needs it in a layout effect, and the transcript's own history reload
 * tracks the same pair for its own purpose (a turn settling). Each keeps its own
 * two-field ref so neither depends on the other's effect ordering.
 *
 * `contentKey` is whatever changes when the rendered content does (the projected
 * items); it re-pins after a paint.
 */
export function useWebuiTranscriptScroll(input: {
  readonly transcriptRef: RefObject<HTMLElement | null>;
  readonly sessionId: string;
  readonly turnLive: boolean;
  readonly contentKey: unknown;
}): { readonly releaseAutoFollow: () => void } {
  const { transcriptRef, sessionId, turnLive, contentKey } = input;
  const autoFollowRef = useRef(true);
  const manualScrollIntentRef = useRef(false);
  const previousTurnStateRef = useRef({ sessionId, turnLive });

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const viewport = transcriptViewport(transcript);
    if (!transcript || !viewport) return undefined;
    const previous = previousTurnStateRef.current;
    previousTurnStateRef.current = { sessionId, turnLive };
    if (previous.sessionId !== sessionId || (turnLive && !previous.turnLive)) {
      autoFollowRef.current = true;
      manualScrollIntentRef.current = false;
    }
    const followBottom = () => pinTranscriptToBottom(viewport, autoFollowRef.current);
    const onScroll = () => {
      if (webuiScrollFollowsBottom(viewport)) {
        autoFollowRef.current = true;
        manualScrollIntentRef.current = false;
      } else if (manualScrollIntentRef.current) {
        autoFollowRef.current = false;
      }
    };
    const onIntent = (event: "wheel" | "touchmove", deltaY: number) => {
      if (webuiScrollIntent({ event, deltaY, metrics: viewport }) === "ignore") return;
      manualScrollIntentRef.current = true;
    };
    const onWheel = (event: WheelEvent) => {
      onIntent("wheel", event.deltaY);
    };
    let lastTouchY: number | undefined;
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (lastTouchY === undefined || y === undefined) return;
      const deltaY = lastTouchY - y;
      lastTouchY = y;
      onIntent("touchmove", deltaY);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    const stopObserving = observeTranscriptHeight(transcript, followBottom);
    followBottom();
    return () => {
      stopObserving?.();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
    };
  }, [sessionId, transcriptRef, turnLive]);

  useLayoutEffect(() => {
    const viewport = transcriptViewport(transcriptRef.current);
    if (viewport) pinTranscriptToBottom(viewport, autoFollowRef.current);
  }, [contentKey, transcriptRef]);

  /** Paging up is the reader walking away from the end: hand control back, or
   *  the older messages arriving would drag the viewport to the bottom. */
  const releaseAutoFollow = useCallback(() => {
    autoFollowRef.current = false;
  }, []);

  return { releaseAutoFollow };
}
