/**
 * `terminalResizeRequest` — when a measured terminal size is worth a request.
 *
 * The defect this exists for: the terminal was fitted to its element on every
 * observer callback and nothing ever told the runtime, so the pseudo-terminal
 * behind the tab stayed 80x24 for the life of the session while the browser
 * rendered a different grid. Full-screen programs drew into the wrong one.
 *
 * The cases worth pinning are the ones that must NOT send: a panel drag
 * measures per frame, a re-mounted pane measures a fresh pseudo-terminal, and a
 * host that is hidden or on its way out measures nothing at all.
 */
import { describe, expect, it } from "vitest";

import {
  TERMINAL_RESIZE_DEBOUNCE_MS,
  terminalResizeRequest,
} from "../../src/client/features/terminal/projection/terminal-size.public.js";

const MEASURED = { terminalId: "t1", cols: 120, rows: 40 } as const;

describe("what the shell reports about a terminal's size", () => {
  it("reports an unmeasured terminal's size", () => {
    // Nothing is cached yet, which is the state the whole defect lived in.
    expect(terminalResizeRequest({ ...MEASURED, reported: undefined })).toEqual(MEASURED);
  });

  it("says nothing when the runtime already holds this size", () => {
    // The observer fires for reasons other than a size change — a re-fit that
    // lands on the same grid, a sibling panel that moved without changing this
    // one — and a request per callback is what the delay is there to avoid
    // compounding.
    expect(terminalResizeRequest({ ...MEASURED, reported: MEASURED })).toBeUndefined();
  });

  it("reports a changed size", () => {
    expect(terminalResizeRequest({ ...MEASURED, cols: 121, reported: MEASURED })).toEqual({
      terminalId: "t1",
      cols: 121,
      rows: 40,
    });
  });

  it("does not read another terminal's report as its own", () => {
    // Changing the active tab re-mounts the terminal, and a fresh
    // pseudo-terminal starts back at 80x24. A cache keyed on the grid alone
    // would recognise the previous terminal's size as already reported and
    // leave the new one at the default, which is the defect with extra steps.
    expect(
      terminalResizeRequest({ terminalId: "t2", cols: 120, rows: 40, reported: MEASURED }),
    ).toEqual({ terminalId: "t2", cols: 120, rows: 40 });
  });

  it("refuses a measurement a pseudo-terminal cannot take", () => {
    // A panel that is hidden or mid-unmount measures zero, and `pty.resize(0, 0)`
    // is not a grid any renderer can honour.
    const impossible = [
      [0, 40],
      [120, 0],
      [-1, 40],
    ] as const;
    for (const [cols, rows] of impossible) {
      expect(
        terminalResizeRequest({ terminalId: "t1", cols, rows, reported: undefined }),
      ).toBeUndefined();
    }
  });

  it("refuses a measurement that is not a whole number of cells", () => {
    // `Number.isInteger` is what rejects NaN and the infinities alongside the
    // fractional case, so a renderer that measured nothing cannot resize a
    // pseudo-terminal to nothing.
    const unmeasurable = [
      [Number.NaN, 40],
      [120, Number.POSITIVE_INFINITY],
      [120.5, 40],
    ] as const;
    for (const [cols, rows] of unmeasurable) {
      expect(
        terminalResizeRequest({ terminalId: "t1", cols, rows, reported: undefined }),
      ).toBeUndefined();
    }
  });

  it("keeps the delay inside the range where a settled terminal still feels immediate", () => {
    // Paid after the last measurement of a drag. Zero would restore the
    // per-frame flood the delay exists to prevent; a value that drifted into
    // seconds would be felt on every panel resize and nothing else would fail.
    expect(TERMINAL_RESIZE_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(TERMINAL_RESIZE_DEBOUNCE_MS).toBeLessThanOrEqual(400);
  });
});
