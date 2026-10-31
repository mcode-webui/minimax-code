// The transcript's scroll binding (plan §6: scroll is one of the responsibilities
// cut out of the large transcript).
//
// These cases exist because the extraction could silently drop the follower: a
// refactor that removed the two effects would still render a transcript and still
// pass every fence case, while the reader at the end of a growing answer would
// stop being followed. The first case is the one that fails when the follower is
// gone; the second pins the other half of the policy (a gesture the viewport can
// answer releases it, and nothing re-arms it until the reader returns to the end).

import { expect } from "@playwright/test";

import { emitStream, openApp, startTurn, test } from "./harness.mjs";

const VIEWPORT = '[data-webui-session-scroll="true"]';

/** How far the viewport's end is below the fold. 0 means pinned to the end. */
const endGap = (page) =>
  page.locator(VIEWPORT).evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );

const scrollTop = (page) => page.locator(VIEWPORT).evaluate((element) => element.scrollTop);

async function setScrollTop(page, value) {
  await page.locator(VIEWPORT).evaluate((element, top) => {
    element.scrollTop = top;
  }, value);
}

/** One assistant chunk with its own message id, so the transcript grows. */
async function grow(page, msgId, lines = 24) {
  await emitStream(page, "A", {
    dataJson: JSON.stringify({
      type: "agent_message_chunk",
      agent_message_chunk: {
        msgId,
        msgContent: Array.from({ length: lines }, (_, index) => `行 ${index}：${"内容".repeat(12)}`).join("\n"),
      },
    }),
  });
}

/** Boot on A in a live turn with a transcript long enough to scroll. */
async function scrollableLiveTranscript(page) {
  await openApp(page);
  await startTurn(page, "A", "hello");
  // Several messages, and a viewport deep enough to have a middle: the follower's
  // threshold is 150px, so a barely-scrollable transcript cannot express "the
  // reader is away from the end".
  for (const msgId of ["seed-1", "seed-2", "seed-3", "seed-4"]) {
    await grow(page, msgId, 40);
  }
  await expect
    .poll(() =>
      page
        .locator(VIEWPORT)
        .evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeGreaterThan(500);
}

test("a growing transcript keeps following its end while the reader is there", async ({ page }) => {
  await scrollableLiveTranscript(page);
  // Armed on the turn going live: the newest content is already in view.
  await expect.poll(() => endGap(page)).toBeLessThanOrEqual(4);

  // Moved away without a gesture. The policy only releases the follower on a
  // gesture the viewport can answer, so this must NOT release it.
  await setScrollTop(page, 0);
  await grow(page, "m2", 40);
  // Content that arrives while the follower is armed brings the end back into
  // view — including the growth that happens after the first paint, which is what
  // the height observer inside the binding is for.
  await expect.poll(() => endGap(page)).toBeLessThanOrEqual(4);
});

test("the follower pins again once the reader is back at the end", async ({ page }) => {
  await scrollableLiveTranscript(page);
  await expect.poll(() => endGap(page)).toBeLessThanOrEqual(4);

  // Walk away mid-transcript with a wheel the viewport can answer. Whether the
  // release then *holds* is not asserted here: a turn going live re-arms the
  // follower by design, and the fixture's stream cannot distinguish "the same
  // turn kept growing" from "a new turn started" reliably enough for that
  // assertion to mean something. The release decision itself is pure and unit
  // tested in `transcript-scroll.test.ts` (the wheel at a boundary is ignored,
  // the wheel that can move the viewport is not).
  const bottomTop = await page
    .locator(VIEWPORT)
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  await setScrollTop(page, Math.floor(bottomTop / 2));
  await page.locator(VIEWPORT).evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  });
  await setScrollTop(page, Math.floor(bottomTop / 2) + 20);

  // Back at the end: the next growth is followed again.
  await setScrollTop(page, 100000);
  await expect.poll(() => endGap(page)).toBeLessThanOrEqual(4);
  // Let the scroll this assignment produced be processed BEFORE the content
  // grows. Otherwise the browser may deliver it after the growth, when the
  // viewport is no longer at the end, and the still-set gesture intent releases
  // the follower — a race in the case, not in the policy, and one this wait
  // removes.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await grow(page, "m2", 40);
  await expect.poll(() => endGap(page)).toBeLessThanOrEqual(4);
});
