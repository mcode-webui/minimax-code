/**
 * What the shell reports about a terminal's size, and when a report is worth
 * sending, published as a public module.
 *
 * A new terminal is measured before its PTY is created, so its first prompt is
 * rendered at the visible grid size. Restored terminals and later pane resizes
 * still need a report because the runtime may hold a different size than the
 * browser viewport.
 *
 * Two rules keep the report from turning into chatter.
 *
 *   - A fit runs on every observer callback, and the observer fires throughout
 *     a drag that changes the panel's width. Reporting each one would put a
 *     request per frame on the wire for a grid nobody reads until the drag
 *     stops, so the caller waits out `TERMINAL_RESIZE_DEBOUNCE_MS` after the
 *     last measurement before sending.
 *   - Only a size the runtime does not already hold is worth a request. The
 *     cache is keyed by terminal because changing the active tab re-mounts the
 *     terminal, and a new PTY can have a different initial grid from an older
 *     one.
 *
 * The observer and the timers that feed these rules live in
 * `components/workspace/WorkspacePanels.tsx`, in the same split the model
 * picker's scale used: the decision is data, the scheduling belongs to the
 * surface that owns the clock. The workspace panel reads both the
 * debounce window and the report-decision rule through this module so the
 * terminals business owns the rule for "what counts as a worth-sending
 * report", even though the panel is the one dragging the slider.
 *
 * This module is `.public` because the workspace business's terminal-survey
 * surface needs both the debounce window and the report decision to know
 * when to send a size to the runtime. The `.public` suffix is a publication
 * marker; the debounce window and the report-decision filter are unchanged.
 */
import type { WebuiTerminalSize } from "../contracts/terminal-port.js";

/**
 * How long a measured size must hold still before the runtime hears about it.
 *
 * A panel drag measures per frame, so without a delay a drag would spend tens
 * of requests a second on a size that is still moving. Short enough that a
 * settled terminal feels immediate, long enough to collapse one drag into one
 * report.
 */
export const TERMINAL_RESIZE_DEBOUNCE_MS = 150;

/**
 * The request to send for a fresh measurement, or `undefined` when the runtime
 * has nothing to learn.
 *
 * `undefined` covers three cases, and they are one value because the caller's
 * action is the same for all three:
 *
 *   - the runtime already holds this size for this terminal;
 *   - the measurement is zero or negative, which is what a host that is hidden,
 *     detached or mid-unmount measures and is not a size a pseudo-terminal can
 *     take;
 *   - the measurement is not a whole number of cells. `Number.isInteger`
 *     rejects `NaN` and the infinities in the same breath, so a terminal that
 *     managed to measure nothing cannot resize a pseudo-terminal to nothing.
 */
export function terminalResizeRequest(params: {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly reported: WebuiTerminalSize | undefined;
}): WebuiTerminalSize | undefined {
  if (!Number.isInteger(params.cols) || !Number.isInteger(params.rows)) return undefined;
  if (params.cols <= 0 || params.rows <= 0) return undefined;
  const { reported } = params;
  if (
    reported !== undefined &&
    reported.terminalId === params.terminalId &&
    reported.cols === params.cols &&
    reported.rows === params.rows
  ) {
    return undefined;
  }
  return { terminalId: params.terminalId, cols: params.cols, rows: params.rows };
}
