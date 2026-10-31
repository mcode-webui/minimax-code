// V08 — one zone's failure is recoverable, and it takes nothing else with it.
//
// The root error boundary existed before the zone boundaries, and it was the
// only one: a Workspace, Settings, Plugins or Transcript render failure replaced
// the whole application with the recovery copy. An unsent draft died because a
// file tree failed to render. `WebuiZoneBoundary` now holds the throw at the
// zone that caused it and forwards the *same* recovery contract, so a zone retry
// and an app retry mean the same thing in one place.
//
// This row can only be discharged in the built client. The unit test mounts the
// zone boundary directly; only here are the zone, the composer, the rail and the
// workspace panel all live at once, so "the rest of the app keeps working" is an
// observation rather than an assertion about one component in isolation.
//
// Invalid history rows are discarded by transcript projection. This malformed
// tool record remains a valid message identity and faults while its transcript
// activity is rendered, inside the transcript zone boundary.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

// Inject only a throwing child below each production zone boundary. This keeps
// the built application/owners intact and requires no product debug switches.
async function installRenderFault(page, zone) {
  await page.addInitScript((name) => { window.__syntheticZoneFault = name; }, zone);
  await page.route("**/client.js", async (route) => {
    const response = await route.fetch();
    const bundle = await response.text();
    const start = bundle.indexOf("function WebuiZoneBoundary({");
    expect(start).toBeGreaterThan(0);
    const end = bundle.indexOf("\n// src/", start);
    const original = bundle.slice(start, end);
    const runtime = original.match(/(import_jsx_runtime\d+)\.jsx/u)?.[1];
    expect(runtime).toBeTruthy();
    expect(original.match(/\n      children\n/gu)).toHaveLength(1);
    const changed = original.replace("\n      children\n", `\n      children: [(0, ${runtime}.jsx)(WebuiSyntheticZoneFault, { zone }), children]\n`);
    const fault = `function WebuiSyntheticZoneFault({zone}) { if (window.__syntheticZoneFault === zone) throw new Error("synthetic zone render failure"); return null; }\n`;
    await route.fulfill({ response, body: bundle.slice(0, start) + fault + changed + bundle.slice(end) });
  });
}

for (const zone of ["workspace", "settings", "plugins"]) {
  test(`V08 ${zone} render failure retries only its own presentation`, async ({ page }) => {
    await installRenderFault(page, zone);
    await openApp(page);
    const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
    await composer.fill("retained draft across zone failure");
    const watchBefore = await page.evaluate(() => window.__fixture.requests.filter(r => r.operation === "watchEvents").length);
    if (zone === "workspace") {
      await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" }).click();
    } else if (zone === "settings") {
      await page.getByTestId("sidebar-user-menu-trigger").click();
      await page.getByTestId("user-menu-settings").click();
    } else {
      await page.getByRole("button", { name: "插件", exact: true }).first().click();
    }
    const retry = page.getByTestId("webui-error-boundary-retry");
    await expect(retry).toBeVisible();
    await expect(page.locator("body")).not.toContainText("页面的一部分未能正常显示");
    await page.evaluate(() => { window.__syntheticZoneFault = undefined; });
    await retry.click();
    await expect(retry).toHaveCount(0);
    if (zone === "settings") await page.getByRole("button", { name: "返回" , exact: true }).click();
    if (zone === "plugins") {
      await page.locator('[data-webui-session-link="B"]').click({ position: { x: 20, y: 15 } });
      await expect(composer).toBeVisible();
      await page.locator('[data-webui-session-link="A"]').click({ position: { x: 20, y: 15 } });
    }
    await expect(composer).toHaveValue("retained draft across zone failure");
    expect(await page.evaluate(() => window.__fixture.requests.filter(r => r.operation === "watchEvents").length)).toBe(watchBefore);
  });
}

test("a zone failure is recoverable without losing the app", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);

  // The healthy baseline, so every "still there" assertion afterwards has
  // something to have been true of.
  await expect(page.locator("[data-webui-transcript]")).toHaveCount(1);
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await expect(composer).toBeVisible();

  // Fault the transcript zone after projection has accepted the message row.
  await page.evaluate(() => {
    window.__fixture.setPage("A", {
      messages: [{ msgId: "broken-tool-call", role: "assistant", toolCalls: [null] }],
      hasMore: false,
    });
  });
  // Re-open the session so the transcript re-reads the poisoned page.
  await page.evaluate(() => {
    window.location.hash = "session=B";
  });
  await page.evaluate(() => {
    window.location.hash = "session=A";
  });

  // The zone caught it. This is the zone copy, not the root one: the title
  // names the transcript, and the root recovery copy is titled differently.
  const zoneError = page.getByTestId("webui-error-boundary-retry");
  await expect(zoneError).toBeVisible();
  await expect(page.locator("body")).not.toContainText("页面的一部分未能正常显示");

  // The point of the row: everything else is still mounted and still usable.
  await expect(page.locator("[data-webui-transcript]")).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();

  // The composer still takes input, so the draft that motivated the boundary
  // is not the thing that was lost.
  await composer.fill("分区出错时仍可输入");
  await expect(composer).toHaveValue("分区出错时仍可输入");

  // Recovery: answer the read honestly and retry the zone. The retry button is
  // the boundary's own, and it remounts the zone's children, which is what
  // re-establishes their reads.
  await page.evaluate(() => {
    window.__fixture.setPage("A", {
      messages: [
        {
          msgId: "recovered-A",
          role: "user",
          msgContent: "Recovered history A",
          timestamp: 1_700_000_000_001,
        },
      ],
      hasMore: false,
    });
  });
  const readsBeforeRetry = await page.evaluate(
    () => window.__fixture.requests.filter((request) => request.operation === "getMessages" && request.body.id === "A").length,
  );
  await zoneError.click();

  await expect.poll(() => page.evaluate(
    () => window.__fixture.requests.filter((request) => request.operation === "getMessages" && request.body.id === "A").length,
  )).toBeGreaterThan(readsBeforeRetry);

  await expect(page.locator("body")).toContainText("Recovered history A");
  await expect(page.getByTestId("webui-error-boundary-retry")).toHaveCount(0);
  // And the draft typed while the zone was down survived the recovery.
  await expect(composer).toHaveValue("分区出错时仍可输入");
});
