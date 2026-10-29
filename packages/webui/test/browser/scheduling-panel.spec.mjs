// The scheduled-task panel in the built client (ADR 0027, #276).
//
// What this spec proves that the unit tests cannot: the rail row is really there and really opens
// the panel, the rows the transport answers with really render with their labels, and the panel's
// own surface really replaces the conversation rather than stacking on it. The screenshot baseline
// is the reviewable part — the three rows carry three different states on purpose, so a change to
// any of the three labels changes the picture.
//
// The panel is not session-scoped, so `openApp` lands on a session first: that is the state a person
// is in when they click the rail.
import { expect } from "@playwright/test";

import { openApp, screenshotOptions, test } from "./harness.mjs";

test.describe("the scheduled-task panel", () => {
  test("opens from the rail and lists what is scheduled", async ({ page }) => {
    await openApp(page);

    // The rail row exists and is operable before anything is clicked — the surface has no other
    // entrance, so an inert row is an unreachable feature.
    const railEntry = page.locator('[data-webui-nav-item="定时任务"]');
    await expect(railEntry).toBeVisible();
    await railEntry.click();

    const panel = page.locator('[data-webui-component="scheduling-panel"]');
    await expect(panel).toBeVisible();

    // One row per definition the transport answered with, each with its own labels.
    await expect(panel.locator("[data-webui-scheduling-task]")).toHaveCount(3);
    const held = panel.locator('[data-webui-scheduling-task="cron-fixture-held"]');
    await expect(held).toContainText("队列摘要");
    await expect(held).toContainText("每天 09:00");
    await expect(held.locator('[data-webui-scheduling-hold="held"]')).toContainText("本客户端已接管");

    const unheld = panel.locator('[data-webui-scheduling-task="cron-fixture-unheld"]');
    await expect(unheld).toContainText("每 30 分钟");
    await expect(unheld.locator('[data-webui-scheduling-hold="unheld"]')).toContainText("本客户端未接管");

    const paused = panel.locator('[data-webui-scheduling-task="cron-fixture-paused"]');
    await expect(paused.locator('[data-webui-scheduling-enabled="false"]')).toContainText("已停用");

    // The panel is a surface, not an overlay: the transcript is gone while it is open.
    await expect(page.locator('[data-webui-component="composer"]')).toHaveCount(0);

    await expect(panel).toHaveScreenshot("scheduling-panel.png", screenshotOptions);

    // Closing returns to the conversation, and the panel's own control is what does it — the rail
    // row re-opens the surface it already shows, the same way the plugin row does.
    await panel.locator('[data-webui-scheduling-close="true"]').click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('[data-webui-component="composer"]')).toHaveCount(1);
  });

  test("creates a task from a preset, turns one off, and deletes one", async ({ page }) => {
    await openApp(page);
    await page.locator('[data-webui-nav-item="定时任务"]').click();
    const panel = page.locator('[data-webui-component="scheduling-panel"]');
    await expect(panel).toBeVisible();

    // Create, from the daily preset the form opens on.
    await panel.locator('[data-webui-scheduling-new="true"]').click();
    const editor = panel.locator('[data-webui-component="scheduling-editor"]');
    await expect(editor).toBeVisible();
    await editor.locator('[data-webui-scheduling-field="name"]').fill("每日摘要");
    await editor.locator('[data-webui-scheduling-field="prompt"]').fill("Summarize the day.");
    await expect(editor).toHaveScreenshot("scheduling-editor.png", screenshotOptions);
    await editor.locator('[data-webui-scheduling-submit="true"]').click();
    await expect(editor).toHaveCount(0);
    const created = panel.locator('[data-webui-scheduling-task="cron-fixture-new-1"]');
    await expect(created).toContainText("每日摘要");
    // What the preset means reached the runtime: daily at 09:00 is `0 9 * * *`.
    await expect(created).toContainText("每天 09:00");

    // Turn one off: the row's own switch, and the label follows the runtime's answer.
    const heldRow = panel.locator('[data-webui-scheduling-task="cron-fixture-held"]');
    await heldRow.locator('[data-webui-scheduling-toggle="cron-fixture-held"]').click();
    await expect(heldRow.locator('[data-webui-scheduling-enabled="false"]')).toContainText("已停用");
    // And back on again.
    await heldRow.locator('[data-webui-scheduling-toggle="cron-fixture-held"]').click();
    await expect(heldRow.locator('[data-webui-scheduling-enabled="true"]')).toContainText("已启用");

    // Delete takes two clicks, and the row goes.
    const doomed = panel.locator('[data-webui-scheduling-task="cron-fixture-paused"]');
    await doomed.locator('[data-webui-scheduling-delete="cron-fixture-paused"]').click();
    await doomed.locator('[data-webui-scheduling-delete-confirm="cron-fixture-paused"]').click();
    await expect(doomed).toHaveCount(0);
  });

  test("runs a task now and shows the run, with a way into its session", async ({ page }) => {
    await openApp(page);
    await page.locator('[data-webui-nav-item="定时任务"]').click();
    const panel = page.locator('[data-webui-component="scheduling-panel"]');
    await expect(panel).toBeVisible();

    // An empty history says so rather than showing nothing at all.
    const heldRow = panel.locator('[data-webui-scheduling-task="cron-fixture-held"]');
    await heldRow.locator('[data-webui-scheduling-history="cron-fixture-held"]').click();
    await expect(heldRow.locator('[data-webui-scheduling-runs="cron-fixture-held"]')).toContainText(
      "还没有运行记录。",
    );

    // Run now: the run appears in the history with its source, its outcome and its session.
    await heldRow.locator('[data-webui-scheduling-run="cron-fixture-held"]').click();
    const runs = heldRow.locator('[data-webui-scheduling-runs="cron-fixture-held"]');
    await expect(runs).toContainText("手动");
    await expect(runs).toContainText("已完成");
    await expect(runs.locator('[data-webui-scheduling-run-session="A"]')).toContainText("打开会话");

    await expect(panel).toHaveScreenshot("scheduling-panel-runs.png", screenshotOptions);

    // Opening the session a run produced leaves the panel and lands on that session.
    await runs.locator('[data-webui-scheduling-run-session="A"]').click();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/#session=A/u);
  });
});
