// The connection banner, end to end against the built client.
//
// The unit suite covers the projection and the region's own markup; what only
// a real browser proves is the chain the Q-1 fix assembled:
//
//   1. The shell actually mounts the region — before the fix the component
//      existed with zero consumers, so no phase ever reached the page.
//   2. A dropped stream socket shows 正在重连 while the loop's automatic
//      resume attempt is in flight, and disappears when it lands.
//   3. A failure with nothing to resume from shows 连接失败 with the real
//      reason, and the 重试连接 button reopens the stream — the recovered
//      loop then delivers frames, which is the "actually recovers" half a
//      banner that only repaints cannot prove.
//
// Mechanism: the fixture's `delayEvery` holds the automatic resume request
// pending, which is what makes the transient `reconnecting` window observable
// instead of racing past between two Playwright calls.

import { expect } from "@playwright/test";

import { openApp, test, startTurn, emitStream, dropStream } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

function banner(page) {
  return page.locator('[data-testid="webui-connection-status"]');
}

test("a dropped stream shows 正在重连 on the page and clears when the resume lands", async ({ page }) => {
  await openApp(page, "#session=A");

  // Healthy first: no banner for a working connection — 已连接 earns zero
  // pixels in the shell's layout, and this is the negative that makes the
  // assertions below mean "appeared", not "was always there".
  await startTurn(page, "A", "hello");
  await expect(banner(page)).toHaveCount(0);

  // Record a cursor, so the drop has something to resume from.
  await emitStream(page, "A", {
    cursor: "c1",
    dataJson: JSON.stringify({
      type: "agent_message_chunk",
      agent_message_chunk: { msgId: "m1", msgContent: "部分回答" },
    }),
  });

  // Hold the automatic resume so `reconnecting` is a stable observable state
  // rather than a microtask the assertion has to win a race against.
  await page.evaluate(() => window.__fixture.delayEvery("resumeSession", { id: "A" }));
  await dropStream(page, "A");

  const region = banner(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute("data-connection-state", "reconnecting");
  await expect(region).toContainText("正在重连");

  // Release the resume; finish the recovered stream. The banner leaves with
  // the failure, not with a timeout.
  await page.evaluate(() => window.__fixture.resolve("resumeSession", { id: "A" }, { stream: true }));
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(banner(page)).toHaveCount(0);
});

test("an unresumable drop shows 连接失败 with its reason, and 重试连接 delivers again", async ({ page }) => {
  await openApp(page, "#session=A");

  // No cursor is recorded before the drop, so the loop has nothing to resume
  // from: it commits `refused` — the terminal state the retry button exists
  // for. This is the drop-a-dead-server shape.
  await startTurn(page, "A", "hello");
  await dropStream(page, "A");

  const region = banner(page);
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute("data-connection-state", "failed");
  await expect(region).toContainText("连接失败");
  // The real reason, not the generic detail: the transport's own message for
  // a socket that died mid-stream.
  await expect(region).toContainText("WebUI connection closed before [DONE]");

  // The manual arm. One click reopens the stream from persisted history…
  const retry = page.locator('[data-testid="webui-connection-status-retry"]');
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(banner(page)).toHaveCount(0);

  // …and the recovered subscription actually delivers: a frame emitted on the
  // reopened stream lands in the transcript. A banner that only repaints
  // would pass everything above.
  await emitStream(page, "A", {
    cursor: "c2",
    dataJson: JSON.stringify({
      type: "agent_message",
      agent_message: { msgId: "m-recovered", msgContent: "重试后恢复的回复" },
    }),
  });
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(page.getByText("重试后恢复的回复")).toBeVisible();
});
