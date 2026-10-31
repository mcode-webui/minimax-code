// The live image stream for the panel.
//
// `chrome.debugger` is not a screenshot path. The Debugger API exposes a
// restricted subset of CDP that does **not** include `Page.captureScreenshot`, so
// an attached debugger cannot produce an image frame at all. The only API that
// can is `chrome.tabs.captureVisibleTab`.
//
// That has a consequence worth stating plainly rather than hiding behind an
// error path: **only the tab the person is currently looking at, in a window
// that is in front, can be captured.** The stream is therefore the extension's
// answer to "show the tab they are on", not a way to observe any tab on demand.
// A background tab yields no frame, and the extension reports that rather than
// substituting another tab's page — a stream of the wrong page is exactly the
// failure the programme exists to prevent.

import type { WebuiBrowserBridgeImageFrame } from "./protocol.js";

export type WebuiBrowserBridgeImageFormat = "png" | "jpeg";

export interface WebuiBrowserBridgeCaptureApi {
  query(queryInfo: Record<string, unknown>): Promise<{ readonly id?: number; readonly windowId?: number }[]>;
  captureVisibleTab(
    windowId?: number,
    options?: { format?: WebuiBrowserBridgeImageFormat; quality?: number },
  ): Promise<string>;
}

export interface WebuiBrowserBridgeImageStreamOptions {
  readonly browserId: string;
  readonly capture: WebuiBrowserBridgeCaptureApi;
  readonly format?: WebuiBrowserBridgeImageFormat;
  /**
   * The registry's view of a target.
   *
   * Capture and target lookup are separate facts, so the frame is stamped with
   * the generation the registry reports *now*: a frame carrying the generation
   * the tab had when the capture started would let the panel display a page that
   * has already moved on.
   */
  readonly resolveGeneration: (targetId: string) => Promise<number | undefined>;
}

export interface WebuiBrowserBridgeImageStream {
  /**
   * Captures the visible tab once.
   *
   * Rejects when there is no visible tab to capture — the one limitation above —
   * so the caller surfaces "no frame" instead of showing a stale one.
   */
  captureVisibleFrame(): Promise<WebuiBrowserBridgeImageFrame>;
  /** Frames delivered on this stream so far. Monotonic within one stream. */
  readonly sequence: number;
}

/** The data-URL prefix the capture API wraps base64 bytes in. */
const DATA_URL_PREFIX = /^data:image\/(?:png|jpeg);base64,/u;

export function createWebuiBrowserBridgeImageStream(
  options: WebuiBrowserBridgeImageStreamOptions,
): WebuiBrowserBridgeImageStream {
  const format = options.format ?? "png";
  let sequence = 0;
  return {
    get sequence() {
      return sequence;
    },
    async captureVisibleFrame() {
      const tabs = await options.capture.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || tab.id === undefined) {
        throw new Error("browser bridge: no visible tab to capture");
      }
      const targetId = `tab-${tab.id}`;
      const generation = await options.resolveGeneration(targetId);
      if (generation === undefined) {
        throw new Error(`browser bridge: visible tab ${targetId} is not a known target`);
      }
      const captured = await options.capture.captureVisibleTab(tab.windowId, { format });
      const prefix = DATA_URL_PREFIX.exec(captured);
      sequence += 1;
      return {
        browserId: options.browserId,
        targetId,
        generation,
        data: prefix ? captured.slice(prefix[0].length) : captured,
        format,
        sequence,
      };
    },
  };
}