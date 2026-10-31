import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

// The picker is ONE popup with two states, so its markers live in the portal
// at the end of the document: it hangs off the trigger in viewport coordinates
// rather than out of the selector's box. What still lives under the selector is
// the trigger that opens it.
function setPickerModels() {
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
      providerId: "fixture-provider",
      providerName: "Fixture Provider",
      modelId: "fixture-plain",
      displayName: "Fixture Plain",
    },
    {
      providerId: "other-provider",
      providerName: "Other Provider",
      modelId: "other-model",
      displayName: "Other Model",
    },
  ]);
}

test.beforeEach(async ({ page }) => {
  await configureFixture(page, setPickerModels);
});

const chip = (page) => page.locator("[data-webui-model-selector] button");

test("the chip names the model in use, and never falls back to the literal 'Model'", async ({ page }) => {
  // The bug this pins: the chip showed "Model" and the panel would not open,
  // and a reload was the only thing that brought the catalogue back. The chip
  // names the model the catalogue says is in use, whatever the catalogue is
  // doing underneath.
  await openApp(page, "#session=A");
  await expect(chip(page)).toContainText("Fixture Configurable");
  await expect(chip(page)).not.toContainText("Model");
  // The level rides the model name.
  await expect(chip(page)).toContainText("高");
});

test("clicking a model in the list selects it", async ({ page }) => {
  // The bug this pins: a row that did nothing when clicked. The panel is one
  // popup now, so there is no second dismissal to swallow the press.
  await openApp(page, "#session=A");
  await chip(page).click();

  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /Fixture Configurable/ }).click();

  // The list state, grouped by provider.
  await expect(page.locator('[data-webui-model-view="list"]')).toBeVisible();
  await expect(
    page.locator('[data-webui-model-list-group="other-provider"]'),
  ).toContainText("Other Model");

  await page
    .locator('[data-webui-model-list-row="other-provider/other-model/"]')
    .click();

  // The panel closed, and the choice reached the runtime as ONE write. The
  // fixture is a runtime that answers without re-reading the catalogue, so the
  // chip still names the model the runtime last reported — the write is what
  // this asserts.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const writes = await page.evaluate(() =>
    window.__fixture.requests.filter(
      (request) => request.operation === "selectModel",
    ),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].body.modelId).toBe("other-model");
  expect(writes[0].body.providerId).toBe("other-provider");
});

test("opening and closing the panel leaves the chip where it was", async ({ page }) => {
  // The bug this pins: the panel flickered and jumped as it opened. The chip is
  // the anchor, so it is the thing that must not move.
  await openApp(page, "#session=A");
  const before = await chip(page).boundingBox();

  await chip(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const opened = await chip(page).boundingBox();

  await page.mouse.click(8, 8);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const closed = await chip(page).boundingBox();

  expect(opened?.x).toBe(before?.x);
  expect(opened?.y).toBe(before?.y);
  expect(closed?.x).toBe(before?.x);
  expect(closed?.y).toBe(before?.y);
});

test("the slider sets the level, and the chip names it", async ({ page }) => {
  await openApp(page, "#session=A");
  await chip(page).click();

  const panel = page.getByRole("dialog");
  const slider = page.locator("[data-webui-model-effort-slider]");
  await expect(slider).toBeVisible();
  const selectorBox = await chip(page).boundingBox();
  const sendBox = await page.locator('[data-testid="composer-send"]').boundingBox();
  expect(selectorBox).toBeTruthy();
  expect(sendBox).toBeTruthy();
  expect(sendBox.x - (selectorBox.x + selectorBox.width)).toBeLessThan(16);
  // Three stops for this model: the levels the runtime lists for it. The
  // control is the model's own scale, not a fixed product scale.
  await expect(slider.locator(".webui-model-effort-dot")).toHaveCount(3);

  // Drag the thumb to the leftmost stop and release: one write, at the end of
  // the drag.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const rail = slider.locator(".webui-model-effort-rail");
  const chipBoxBefore = await chip(page).boundingBox();
  const box = await rail.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    window.__effortFillWidths = [];
    const fill = document.querySelector(".webui-model-effort-fill");
    if (!fill) throw new Error("model effort fill is missing");
    const sample = () => {
      window.__effortFillWidths.push(fill.getBoundingClientRect().width);
      if (window.__effortFillWidths.length < 30) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(180);
  const fillWidths = await page.evaluate(() => window.__effortFillWidths);
  expect(fillWidths.some((width) => width > 0 && width < 8)).toBe(false);
  await expect(page.locator('[data-webui-model-panel-level="true"]')).toHaveText(
    "默认",
  );
  await page.mouse.up();

  await expect(page.locator('[data-webui-model-panel-level="true"]')).toHaveText(
    "默认",
  );
  const chipBoxAfter = await chip(page).boundingBox();
  expect(chipBoxAfter?.width).toBe(chipBoxBefore?.width);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const thumbStyle = await slider.locator(".webui-model-effort-thumb").evaluate((thumb) => {
    const style = getComputedStyle(thumb);
    return {
      scale: new DOMMatrix(style.transform).a,
      transitionDuration: style.transitionDuration,
    };
  });
  const thumbScale = thumbStyle.scale;
  expect(thumbScale).toBeGreaterThan(1);
  expect(thumbStyle.transitionDuration).toContain("0.14s");
});
