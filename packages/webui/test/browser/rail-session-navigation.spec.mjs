// The rail's session links, end to end against the built client.
//
// A rail session row is a plain `#session=<id>` anchor, so selecting a session
// runs through the hash subscription inside `useSelectedSessionId` rather than
// through a setter the shell holds. Clicking the link of the session that is
// *already* selected changes nothing that subscription can observe: the hash
// stays the same, so no `hashchange` fires, the selection does not change, and
// the shell never hears that the user asked for the conversation -- it keeps
// the surface it was showing.
//
// The symptom is the 远程 page: open it, click the session you are already in,
// and the page stays put.
//
// The session link is clicked by dispatching the event rather than by moving
// the pointer. The rail row carries its own action buttons (置顶, 归档, 更多) on
// the right, and they intercept the pointer at the link's centre -- the same
// spot a user has to aim around.

import { expect } from "@playwright/test";

import { openApp, test, waitForLocalImages } from "./harness.mjs";

function sessionLink(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`);
}

function conversation(page) {
  return page.locator('[data-webui-session-layout="true"]');
}

function remotePage(page) {
  return page.locator('[data-webui-component="remote-page"]');
}

for (const scenario of [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "mobile-light", width: 390, height: 844, theme: "light" },
]) {
  test(`Design pill and workspace import stay usable in ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript((theme) => localStorage.setItem("webui-theme", theme), scenario.theme);
    await openApp(page);
    if (scenario.width < 640) await page.getByRole("button", { name: "展开导航栏" }).click();
    await waitForLocalImages(page);
    const rail = page.locator('[data-webui-shell-region="rail"]:visible');
    const create = rail.locator('[data-webui-nav-item="新建任务"]');
    const design = rail.getByRole("button", { name: "Design", exact: true });
    const imported = rail.locator('[data-webui-nav-item="导入会话"]');
    await expect(design).toBeVisible();
    await expect(rail.locator(".webui-rail-navigation-group").getByRole("button", { name: "Design", exact: true })).toHaveCount(0);
    await expect(rail.locator(".webui-rail-navigation-group [data-webui-nav-item]").first()).toHaveAttribute("data-webui-nav-item", "导入会话");
    const geometry = await rail.evaluate((element) => {
      const box = (selector) => element.querySelector(selector).getBoundingClientRect().toJSON();
      const button = element.querySelector('[data-webui-nav-item="Design"]');
      return {
        create: box('[data-webui-nav-item="新建任务"]'),
        design: box('[data-webui-nav-item="Design"]'),
        createMark: box('[data-webui-nav-item="新建任务"] .webui-brand-create-mark'),
        designMark: box('[data-webui-nav-item="Design"] .webui-brand-create-mark'),
        wordmark: box(".webui-brand-design-wordmark"),
        mascot: box(".webui-brand-design-mascot"),
        createMascot: box(".webui-brand-create-mascot"),
        workspace: box(".webui-rail-navigation-group"),
        radius: getComputedStyle(button).borderRadius,
        background: getComputedStyle(button).backgroundColor,
        overflow: getComputedStyle(button).overflow,
        mascotFilter: getComputedStyle(element.querySelector(".webui-brand-design-mascot")).filter,
      };
    });
    expect(geometry.design.width).toBe(geometry.create.width);
    expect(geometry.design.height).toBe(geometry.create.height);
    expect(geometry.designMark.width).toBe(geometry.createMark.width);
    expect(geometry.designMark.height).toBe(geometry.createMark.height);
    expect(geometry.design.top).toBeGreaterThanOrEqual(geometry.create.bottom + 8);
    expect(parseFloat(geometry.radius)).toBeGreaterThanOrEqual(geometry.design.height / 2);
    expect(geometry.mascot.left).toBeGreaterThanOrEqual(geometry.wordmark.right);
    expect(geometry.overflow).toBe("hidden");
    expect(geometry.mascotFilter).toBe("none");
    expect(geometry.mascot.right).toBeLessThan(geometry.design.right);
    expect(geometry.mascot.top).toBeGreaterThan(geometry.design.top);
    expect(geometry.mascot.bottom).toBeGreaterThan(geometry.design.bottom);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}.png`), animations: "disabled" });
    await rail.screenshot({ path: testInfo.outputPath(`${scenario.name}-rail.png`), animations: "disabled" });
    await rail.locator('[data-webui-rail-brand="true"]').screenshot({ path: testInfo.outputPath(`${scenario.name}-buttons.png`), animations: "disabled" });
    await design.focus();
    await expect(design).toBeFocused();

    const chooserPromise = page.waitForEvent("filechooser");
    await imported.click();
    await chooserPromise;
    const popupPromise = page.waitForEvent("popup");
    await design.click();
    const popup = await popupPromise;
    await expect.poll(() => new URL(popup.url()).pathname).toBe("/design");
    await popup.close();
    await create.click();
    await expect(page.locator('[data-webui-composer="true"]')).toBeVisible();
  });
}

test("clicking the selected session's rail link returns to the conversation", async ({ page }) => {
  await openApp(page, "#session=A");

  await expect(sessionLink(page, "A")).toBeVisible();
  await expect(conversation(page)).toBeVisible();

  await page.locator('[data-webui-nav-item="远程"]').click();
  await expect(remotePage(page)).toBeVisible();
  await expect(conversation(page)).toHaveCount(0);

  // The same session, clicked again. The hash does not change, so this click
  // is the only signal the shell gets.
  await sessionLink(page, "A").dispatchEvent("click");

  await expect(remotePage(page)).toHaveCount(0);
  await expect(conversation(page)).toBeVisible();
});
