// One nested path answers one dismissal at a time (#289, ADR 0028 § Overlay
// coordination).
//
// The memory manager dialog, the menu inside it and the deletion confirmation
// inside that menu are registered with the coordinator as a nested path. This
// file asserts the consequence of that registration: one Escape sheds exactly the
// topmost layer, a press outside dismisses exactly the layer it landed outside
// of, the popup draws above the dialog, and the click that follows a dismissal
// reaches what is underneath instead of the surface that is already leaving.
//
// The decision itself is tested without a browser in `overlay-order.test.ts`.
//
// Locator note: the dropdown's `testId` lands on its wrapper and the popup is
// portalled to `document.body`, so a popup is found by its layer attribute — not
// by descending from the wrapper's test id.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  await configureFixture(page, () => {
    // The two providers the model picker's ladder walks through.
    window.__fixture.setModels([
      {
        providerId: "fixture-provider",
        providerName: "Fixture Provider",
        modelId: "fixture-configurable",
        displayName: "Fixture Configurable",
        selected: true,
        effortOptions: ["default", "low", "high"],
        thinking: { effort: "high" },
        contextWindowOptions: [128_000, 1_000_000],
      },
      {
        providerId: "other-provider",
        providerName: "Other Provider",
        modelId: "other-model",
        displayName: "Other Model",
      },
    ]);
    window.__fixture.setResponse("getMemorySettings", { enabled: true, proactive: false });
    window.__fixture.setResponse("getAgentMemory", {
      agentName: "main",
      path: "memory.md",
      exists: true,
      sizeBytes: 11,
      content: "server body",
    });
  });
  await openApp(page, "#session=A");
});

const dialog = (page) => page.getByTestId("agent-memory-manager");
const menu = (page) => page.locator('[data-overlay-layer="memory-manager-menu"]');
const confirm = (page) => page.locator('[data-overlay-layer="memory-manager-confirm"]');

/** Opens settings › 自定义指令 › 管理, and returns that opener. */
async function openManager(page) {
  await page.getByTestId("sidebar-user-menu-trigger").click();
  await page.getByTestId("user-menu-settings").click();
  await page.locator('[data-menu-key="custom-instructions"]').click();
  const opener = page.getByTestId("memory-section").getByRole("button", { name: "管理" });
  await opener.click();
  await expect(dialog(page)).toBeVisible();
  return opener;
}

/** Opens the ⋯ menu and returns its items once they are there. */
async function openMenu(page) {
  await page.getByTestId("agent-memory-menu").click();
  await expect(menu(page)).toHaveCount(1);
  const items = menu(page).getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  return items;
}

test("one Escape sheds the topmost layer and never the one beneath it", async ({ page }) => {
  await openManager(page);

  // The confirmation replaces the menu, so the path below reads top down: the
  // confirmation, then the menu, then the dialog.
  const items = await openMenu(page);
  await items.filter({ hasText: "删除" }).first().click();
  await expect(confirm(page)).toBeVisible();
  await expect(menu(page)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(confirm(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();

  // The menu is the next layer down: one press sheds it and leaves the dialog.
  await openMenu(page);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();

  // Only when nothing sits above it does a press reach the dialog.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("a press outside dismisses only the layer it landed outside of", async ({ page }) => {
  await openManager(page);
  const items = await openMenu(page);
  await items.filter({ hasText: "删除" }).first().click();
  await expect(confirm(page)).toBeVisible();

  // A press on the confirmation's own scrim (outside its panel, inside the
  // viewport corner) dismisses the confirmation only.
  await page.mouse.click(6, 6);
  await expect(confirm(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
});

test("the menu draws above the dialog it belongs to", async ({ page }) => {
  await openManager(page);
  await openMenu(page);

  const stacking = await page.evaluate(() => {
    const popup = document.querySelector('[data-overlay-layer="memory-manager-menu"]');
    const surface = document.querySelector('[data-overlay-layer="memory-manager"]');
    if (!popup || !surface) return null;
    const box = popup.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const z = (node) => {
      const value = Number.parseInt(getComputedStyle(node).zIndex || "0", 10);
      return Number.isFinite(value) ? value : 0;
    };
    return { topIsPopup: popup.contains(hit), popupZ: z(popup), surfaceZ: z(surface) };
  });

  expect(stacking, "both layers rendered").not.toBeNull();
  expect(stacking?.topIsPopup, "the menu is the topmost element at its own centre").toBe(true);
  expect(stacking?.popupZ ?? 0).toBeGreaterThanOrEqual(stacking?.surfaceZ ?? 0);
});

test("the click after a dismissal reaches what is underneath", async ({ page }) => {
  await openManager(page);
  await openMenu(page);

  // A point inside the dialog but outside the popup: the press dismisses the
  // popup, and the click that follows must land on the dialog, not on the surface
  // that is already leaving.
  const target = await page.evaluate(() => {
    const surface = document.querySelector('[data-overlay-layer="memory-manager"]');
    const popup = document.querySelector('[data-overlay-layer="memory-manager-menu"]');
    if (!surface || !popup) return null;
    const dialogBox = surface.getBoundingClientRect();
    const popupBox = popup.getBoundingClientRect();
    // The dialog's top-left corner is outside the popup, which hangs off its right edge.
    const x = Math.round(dialogBox.left + 24);
    const y = Math.round(dialogBox.top + 24);
    const insidePopup = x >= popupBox.left && x <= popupBox.right && y >= popupBox.top && y <= popupBox.bottom;
    return { x, y, insidePopup };
  });
  expect(target, "both layers rendered").not.toBeNull();
  expect(target?.insidePopup, "the press point is outside the popup").toBe(false);

  await page.mouse.move(target?.x ?? 0, target?.y ?? 0);
  await page.mouse.down();
  await expect(menu(page)).toHaveCount(0);
  await page.mouse.up();

  const landedOn = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return {
        inLeavingPopup: Boolean(hit?.closest('[data-overlay-layer="memory-manager-menu"]')),
        inDialog: Boolean(hit?.closest('[data-overlay-layer="memory-manager"]')),
      };
    },
    { x: target?.x ?? 0, y: target?.y ?? 0 },
  );
  expect(landedOn.inLeavingPopup, "the leaving popup does not intercept the click").toBe(false);
  expect(landedOn.inDialog, "the click reaches the dialog underneath").toBe(true);
  await expect(dialog(page)).toBeVisible();
});

test("the model picker's Escape ladder steps from its list to its panel, then closes", async ({ page }) => {
  // The picker is one managed layer that answers a dismissal itself: the
  // coordinator hands it `request-close`, and the layer reads the event to tell
  // the Escape key (walk back one step) from a press outside (end the visit).
  const chip = page.locator("[data-webui-model-selector] button");
  await chip.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();

  // Into the list, by choosing the provider the fixture reports.
  await panel.getByRole("button", { name: /Fixture Configurable/u }).click();
  await expect(page.locator('[data-webui-model-view="list"]')).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator('[data-webui-model-view="list"]')).toHaveCount(0);
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("closing the dialog returns focus to the control that opened it", async ({ page }) => {
  const opener = await openManager(page);
  await expect.poll(() => page.getByTestId("agent-memory-manager").evaluate((surface) =>
    [...(surface.parentElement?.parentElement?.children ?? [])]
      .filter((element) => element !== surface.parentElement)
      .every((element) => element.inert),
  )).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect.poll(() => page.locator("#webui-root").evaluate((element) => element.inert)).toBe(true);
});

test("the shared modal frame keeps its header and actions fixed around a scrolling body", async ({ page }, testInfo) => {
  await page.evaluate(() => window.__fixture.setResponse("getAgentMemory", {
    agentName: "main",
    path: "memory.md",
    exists: true,
    sizeBytes: 20_000,
    content: Array.from({ length: 500 }, (_, index) => `记忆条目 ${index + 1}：用于验证长内容不会把标题和操作按钮推出弹窗。`).join("\n"),
  }));
  await openManager(page);
  await expect.poll(() => page.getByTestId("agent-memory-manager").evaluate((surface) => Math.round(surface.getBoundingClientRect().width))).toBe(640);

  const geometry = await page.getByTestId("agent-memory-manager").evaluate((surface) => {
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
    };
    const header = surface.querySelector(".webui-dialog-header");
    const body = surface.querySelector(".webui-dialog-body");
    const footer = surface.querySelector(".webui-dialog-footer");
    if (!header || !body || !footer) return null;
    return {
      surface: bounds(surface),
      header: bounds(header),
      body: bounds(body),
      footer: bounds(footer),
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      scrim: getComputedStyle(surface.parentElement).backgroundColor,
    };
  });
  expect(geometry, "the shared frame has all three regions").not.toBeNull();
  expect(geometry?.surface.width).toBeCloseTo(640, 0);
  expect(geometry?.surface.height ?? 0).toBeLessThanOrEqual(765);
  expect(geometry?.bodyOverflowY).toBe("auto");
  expect(geometry?.bodyScrollHeight ?? 0).toBeGreaterThan(geometry?.bodyClientHeight ?? 0);
  expect(geometry?.header.top).toBeGreaterThanOrEqual(geometry?.surface.top ?? 0);
  expect(Math.abs((geometry?.footer.bottom ?? 0) - (geometry?.surface.bottom ?? 0))).toBeLessThanOrEqual(2);
  // The scrim is the shared modal token, and the Desktop's colorBgMask binds it
  // to utility_overlay: black at 25% in the light palette.
  expect(geometry?.scrim).toBe("rgba(0, 0, 0, 0.25)");

  await page.getByTestId("agent-memory-manager").locator(".webui-dialog-body").evaluate((body) => {
    body.scrollTop = body.scrollHeight;
  });
  await expect(page.getByTestId("agent-memory-save")).toBeVisible();
  await testInfo.attach("shared-modal-desktop-long-content", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.getByTestId("agent-memory-manager").evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    const footer = surface.querySelector(".webui-dialog-footer")?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      footerBottom: footer?.bottom,
      scrim: getComputedStyle(surface.parentElement).backgroundColor,
    };
  });
  expect(narrow.left).toBeGreaterThanOrEqual(11);
  expect(narrow.right).toBeLessThanOrEqual(379);
  expect(Math.abs((narrow.footerBottom ?? 0) - narrow.bottom)).toBeLessThanOrEqual(2);
  // The dark palette binds utility_overlay to #0000003d, so the same token dims
  // the page a shade less than it does in the light theme.
  expect(narrow.scrim).toBe("rgba(0, 0, 0, 0.24)");
  await testInfo.attach("shared-modal-mobile-dark", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("closing a modal returns focus to the control that opened it, never the body", async ({ page }) => {
  // The settings sheet is opened from an entry inside the user menu. Focus has
  // to come back to that entry — a keyboard user who closes the sheet resumes
  // where they were, not at the top of the document. The platform keeps a short
  // history of what was focused outside a modal precisely because an opener that
  // lives in a popup is not guaranteed to survive the modal it opened.
  await page.getByTestId("sidebar-user-menu-trigger").click();
  await page.getByTestId("user-menu-settings").click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);

  const focused = await page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? "",
      testId: element?.getAttribute("data-testid") ?? "",
      isBody: element === document.body,
      connected: Boolean(element?.isConnected),
    };
  });
  expect(focused.isBody).toBe(false);
  expect(focused.connected).toBe(true);
  expect(focused.tag).toBe("BUTTON");
  expect(focused.testId).toBe("user-menu-settings");
});
