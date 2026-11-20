// Derived from AI Node Canvas 1.22.9, Copyright (c) 2026 antianqi. MIT; see shared/design/LICENSE.
import { previewAction } from "../../../../shared/design/node-ui.mjs";

/**
 * The preview's loop.
 *
 * The preview plays the range that is about to be cut, over and over. It
 * stays inside the range, and when the material runs out before the range
 * does — the range is often the whole material — the browser stops the
 * playback there, so the preview starts over by itself.
 *
 * The rule itself lives in previewAction; this only wires it to the element,
 * so the wiring can be exercised on its own.
 */
export function wirePreviewLoop(
  preview,
  { fromSec, toSec, isPlaying, playAt },
) {
  const decide = (extra) =>
    previewAction({
      currentSec: preview.currentTime,
      fromSec: fromSec(),
      toSec: toSec(),
      playing: isPlaying(),
      ...extra,
    });

  // Inside the range the preview keeps playing; outside it, back to the start.
  const timeupdate = () => {
    const action = decide();
    if (
      action.type === "seek" &&
      Math.abs(action.at - preview.currentTime) > 0.02
    ) {
      preview.currentTime = action.at;
    }
  };

  // The material ran out: the range starts over, so it plays over and over.
  const ended = () => {
    const action = decide({ ended: true });
    if (action.type === "restart") playAt(action.at);
  };
  preview.addEventListener("timeupdate", timeupdate);
  preview.addEventListener("ended", ended);
  return () => {
    preview.removeEventListener("timeupdate", timeupdate);
    preview.removeEventListener("ended", ended);
  };
}
