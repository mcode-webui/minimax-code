// Motion, measured on its own evidence (#284, ADR 0028 § Shared contracts).
//
// The static appearance of these surfaces is pinned by `rendering-integrity.spec.mjs`
// and by the screenshot baselines; neither can say anything about timing, because
// a screenshot is taken with `animations: "disabled"` and a pixel comparison is
// identical whether a surface fades for 120ms or 400ms. So the timing is measured
// here, off the live cascade: `getComputedStyle` on the popup after it opens is the
// duration the browser will actually animate for, which is the thing a reader sees.
//
// Two claims:
//   1. the shared popup enters on the surface family (180ms) and leaves on the one
//      number the mount timer also waits for (120ms, `WEBUI_DROPDOWN_EXIT_MS`);
//   2. the reduced-motion policy reaches the surface without that surface writing
//      its own media query — the token collapses and the animation follows.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

const CHIP = "[data-webui-model-selector] button";
const POPUP = ".webui-dropdown-popup";

async function setPickerModels(page) {
  await configureFixture(page, () => undefined);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  await setPickerModels(page);
  await openApp(page, "#session=A");
});

/**
 * The suite pins `reducedMotion: "reduce"` globally so screenshots are
 * deterministic, and under that policy every token is 0.01ms. A test that
 * measures timing therefore has to ask for the motion it wants to measure;
 * asserting on the pinned default would only ever prove the policy works.
 */
async function enableMotion(page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

/** Opens the model picker and returns the popup's computed animation timing. */
async function openPopupTiming(page) {
  await page.locator(CHIP).click();
  const popup = page.locator(POPUP);
  await expect(popup).toBeVisible();
  return popup.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      timingFunction: style.animationTimingFunction,
      exitVariable: style.getPropertyValue("--webui-dropdown-exit-duration").trim(),
      surfaceToken: style.getPropertyValue("--webui-motion-duration-surface").trim(),
      rootToken: getComputedStyle(document.documentElement).getPropertyValue("--webui-motion-duration-surface").trim(),
      cls: element.className,
    };
  });
}

test("the shared popup enters on the surface family", async ({ page }) => {
  await enableMotion(page);
  const timing = await openPopupTiming(page);

  // 180ms is `--webui-motion-duration-surface`; the family's easing is
  // `--webui-motion-ease-enter`, not the browser default. A popup that opened
  // upward carries the reversed keyframes and the same timing.
  expect(timing.name).toMatch(/webui-dropdown-in(-reverse)?$/u);
  expect(timing.duration).toBe("0.18s");
  expect(timing.timingFunction).toContain("cubic-bezier(0.16, 1, 0.3, 1)");
  expect(timing.rootToken).toBe("180ms");
});

test("the popup leaves on the same number the mount timer waits for", async ({ page }) => {
  await enableMotion(page);
  await openPopupTiming(page);
  const leaving = await page.locator(POPUP).evaluate((element) => {
    // The class the skeleton applies while it keeps the surface mounted.
    element.classList.add("is-leaving");
    const style = getComputedStyle(element);
    const result = {
      name: style.animationName,
      duration: style.animationDuration,
      pointerEvents: style.pointerEvents,
      exitVariable: style.getPropertyValue("--webui-dropdown-exit-duration").trim(),
    };
    element.classList.remove("is-leaving");
    return result;
  });

  expect(leaving.name).toContain("webui-dropdown-out");
  expect(leaving.duration).toBe("0.12s");
  // The skeleton writes its constant into this property; the stylesheet's fallback
  // token is the same number, which the gate test compares against the constant.
  expect(leaving.exitVariable).toBe("120ms");
  // A surface that is still on screen while it fades must not catch the press
  // that was aimed at what is underneath it.
  expect(leaving.pointerEvents).toBe("none");
});

test("reduced motion reaches the surface through the tokens alone", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const timing = await openPopupTiming(page);

  // No rule on this surface mentions the preference; the token collapses and the
  // animation follows it. Chrome serialises the collapsed value as `0.01ms`
  // ("1e-05s") and, on some builds, as `0s`; either way it is under one frame.
  expect(timing.rootToken).toBe("0.01ms");
  expect(Number.parseFloat(timing.duration)).toBeLessThanOrEqual(0.00001);
});
