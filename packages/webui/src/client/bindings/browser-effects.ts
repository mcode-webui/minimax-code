// Browser interaction effects (plan §7.2 `client/bindings/browser-effects.ts`):
// moving focus and the scroll position, and the element id a source line is
// rendered under. Split out of `projection/file-line-navigation.ts`, which was
// classified `bindings` because it touches the DOM rather than reducing data.
//
// It issues no business request: the callers decide which line to reveal, and
// these functions only move the viewport and the keyboard focus.
//
// Boundary: this file holds the focus/scroll effects that already existed in one
// place. A further sweep for DOM effects still living inside components is not
// part of this change.

export interface WebuiFileLineTarget {
  focus(options?: FocusOptions): void;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

/** Move keyboard focus and the scroll position to the requested source line. */
export function focusWebuiFileLine(target: WebuiFileLineTarget): void {
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.focus({ preventScroll: true });
}

export function webuiFileLineTargetId(tabId: string, line: number): string {
  return `webui-file-line-${encodeURIComponent(tabId)}-${line}`;
}
