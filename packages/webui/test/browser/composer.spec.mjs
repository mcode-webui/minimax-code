// Composer module (roadmap Module B) — slash palette trigger, input history
// recall, per-session drafts, attachments, and the @ mention picker, driven
// end to end against the built client and the in-page fixture transport.
//
//   B-1 输入历史/草稿   — ↑ recall, edit-exit, per-session drafts surviving
//                          a switch and a reload, home→session carry-over
//   B-2 斜杠命令面板    — typing "/" opens the palette; filtering; Escape
//   B-3 上传预览        — attach a file + an image, chips render, removal
//   B-4 文件夹上传/@    — @ menu offers the local file/folder pickers and
//                          choosing one opens the OS file chooser
//
// The composer's field contract is in packages/webui/docs/client/composer.md.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";

import {
  configureFixture,
  emitStream,
  openApp,
  requestCount,
  startTurn,
  switchSession,
  test,
} from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

test("shared text fields use the shared feedback transition contract", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openApp(page, "#session=A");

  const field = page.locator('textarea[name="content"]');
  await expect(field).toHaveClass(/webui-motion-feedback/u);
  expect(await field.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.12s");
  const properties = await field.evaluate((element) => getComputedStyle(element).transitionProperty);
  expect(properties).toContain("border-color");
  expect(properties).toContain("outline-color");
});

test("composer mascot keeps its corners transparent without video alpha support", async ({ page }, testInfo) => {
  // This opaque response models a decoder dropping WebM alpha; it does not
  // claim to replace Safari or Quark device coverage.
  await page.route("**/assets/img/minimax-octopus-composer.webm", (route) => route.fulfill({
    path: fileURLToPath(new URL("./support/composer-mascot-opaque.webm", import.meta.url)),
    contentType: "video/webm",
  }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "#session=A");
  const mascot = page.locator(".webui-composer-mascot");
  await expect.poll(() => mascot.evaluate((element) => {
    const media = element instanceof HTMLVideoElement ? element : element.querySelector("img");
    return media instanceof HTMLVideoElement ? media.readyState >= 2 : media?.complete && media.naturalWidth > 0;
  })).toBe(true);
  const alpha = await mascot.evaluate((element) => {
    const media = element instanceof HTMLVideoElement ? element : element.querySelector("img");
    const canvas = document.createElement("canvas");
    canvas.width = 180;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context || !media) throw new Error("Mascot media is unavailable");
    context.drawImage(media, 0, 0, 180, 320);
    return [[0, 0], [179, 0], [0, 319], [179, 319]].map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]);
  });
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: testInfo.outputPath("mascot-without-video-alpha.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: testInfo.outputPath("mascot-without-video-alpha-dark.png") });
  expect(alpha).toEqual([0, 0, 0, 0]);
});

test("composer mascot plays the transparent octopus and respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openApp(page, "#session=A");

  const mascot = page.locator(".webui-composer-mascot img");
  await expect(mascot).toBeVisible();
  await expect.poll(() => mascot.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await mascot.evaluate((image) => image.currentSrc)).toMatch(/minimax-octopus-composer\.webp$/u);
  const firstFrame = await mascot.screenshot();
  await expect.poll(async () => (await mascot.screenshot()).equals(firstFrame), { message: "the mascot animation advances" }).toBe(false);
  // The octopus lies on the input: it is anchored to the card's right edge at the
  // shared spacing, and its tentacles reach the input's top edge. That is the
  // placement the design asks for, and neither relation depends on the viewport —
  // a mascot centred on the input would be a different design, so this measures
  // the anchor rather than an equality of centres. Both are recorded as the whole
  // set so a width-dependent drift (a centred or padded card) fails here.
  const viewports = [{ width: 390, height: 844 }, { width: 760, height: 900 }, { width: 1000, height: 700 }, { width: 1440, height: 900 }];
  const rightGaps = [];
  const tentacleGaps = [];
  for (const size of viewports) {
    await page.setViewportSize(size);
    // Read one layout frame: separate protocol calls can straddle the rail's
    // responsive transition and compare positions from different frames.
    const geometry = await mascot.evaluate((image) => {
      const card = image.closest(".webui-composer-card");
      const input = card?.querySelector('textarea[name="content"]');
      if (!card || !input) throw new Error("Composer geometry is unavailable");
      const mascotBox = image.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      return { rightGap: cardBox.right - mascotBox.right, tentacleGap: inputBox.top - mascotBox.bottom };
    });
    rightGaps.push(Math.round(geometry.rightGap));
    tentacleGaps.push(Math.round(geometry.tentacleGap));
  }
  // Anchored to the right edge: the gap is the same at every width, and it is the
  // shared 24px spacing plus the card's own border. A mascot placed relative to the
  // input's centre moves with the card and fails the spread.
  expect(Math.max(...rightGaps) - Math.min(...rightGaps), JSON.stringify(rightGaps)).toBeLessThanOrEqual(1);
  expect(rightGaps[0], JSON.stringify(rightGaps)).toBeGreaterThanOrEqual(20);
  expect(rightGaps[0], JSON.stringify(rightGaps)).toBeLessThanOrEqual(32);
  // The tentacles rest on the input's top edge: a few pixels onto it, not floating
  // above the card and not sitting over the text.
  expect(Math.max(...tentacleGaps) - Math.min(...tentacleGaps), JSON.stringify(tentacleGaps)).toBeLessThanOrEqual(1);
  expect(tentacleGaps[0], JSON.stringify(tentacleGaps)).toBeGreaterThanOrEqual(-12);
  expect(tentacleGaps[0], JSON.stringify(tentacleGaps)).toBeLessThanOrEqual(0);
  const alpha = await mascot.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  expect(alpha).toBe(0);
  if (process.env.WEBUI_COMPOSER_MASCOT_SCREENSHOT) {
    await page.screenshot({ path: process.env.WEBUI_COMPOSER_MASCOT_SCREENSHOT, fullPage: true });
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => mascot.evaluate((image) => image.currentSrc)).toMatch(/minimax-octopus-composer-poster\.png$/u);
  await expect.poll(() => mascot.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  const reducedAlpha = await mascot.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  expect(reducedAlpha).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => mascot.evaluate((image) => image.currentSrc)).toMatch(/minimax-octopus-composer\.webp$/u);
});

function composer(page) {
  return page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
}

function commandMenu(page) {
  return page.locator('[data-webui-command-menu="true"]');
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("typing / opens the slash palette; filtering and Escape behave", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.pressSequentially("/");
  const menu = commandMenu(page);
  await expect(menu).toBeVisible();
  // The fixture's roster answers with one skill, so the palette shows it
  // beside the two runnable built-ins. The roster is the runtime's own list of
  // what the agent can run — the palette used to read the management
  // catalogue instead, which is why it showed a fraction of the skills.
  await expect(menu.getByRole("option", { name: /目标/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /计划/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /fixture-skill/ })).toBeVisible();

  await input.pressSequentially("go");
  await expect(menu.getByRole("option", { name: /目标/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /计划/ })).toHaveCount(0);

  // Escape drops the slash token under the caret (desktop behavior) and the
  // popover with it.
  await input.press("Escape");
  await expect(commandMenu(page)).toHaveCount(0);
  await expect(input).toHaveValue("");
});

test("the slash palette answers a shortened query no row contains literally", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.pressSequentially("/mdl");

  // Not one palette row contains "mdl", so before the subsequence pass this
  // query drew an empty popover — what "模糊搜索无效" looked like. The typed
  // characters are matched in order with gaps allowed, and only the row they
  // name comes back: 计划 has no `m` at all and must stay out.
  const menu = commandMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option", { name: /模型/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /计划/ })).toHaveCount(0);
});

test("Tab completes the slash palette's highlighted suggestion", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.pressSequentially("/mdl");
  // The fuzzy hit is what Tab completes: "mdl" is not a prefix of any command,
  // so this only reaches /model through the subsequence rank.
  await expect(commandMenu(page).getByRole("option", { name: /模型/ })).toBeVisible();

  await input.press("Tab");

  // Completion rewrites the token to the full name and leaves the caret after
  // the trailing space — anything less and the palette pops straight back open
  // on "/model", which is the failure this asserts against.
  await expect(input).toHaveValue("/model ");
  await expect(commandMenu(page)).toHaveCount(0);
  // Tab is a completion here, not a focus move: the caret stays in the field.
  await expect(input).toBeFocused();
});

test("the mode pill keeps its mode mark and shows a close mark on hover", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.fill("/plan ");
  await input.press("Enter");

  const pill = page.locator('[data-testid="composer-plan-mode"]');
  await expect(pill).toBeVisible();
  // At rest the leading glyph says which mode is running.
  await expect(pill.locator("svg.tabler-icon-calendar-event")).toBeVisible();
  await expect(pill.locator("svg.tabler-icon-x")).toBeHidden();
  await expect(pill.locator("> span").last()).toHaveText("计划");

  await pill.hover();
  // Under the pointer that same slot becomes the close mark — leaving the mode
  // is the pill's only action — and both glyphs share one box, so the label
  // does not move. (The goal pill renders from the same component.)
  await expect(pill.locator("svg.tabler-icon-x")).toBeVisible();
  await expect(pill.locator("svg.tabler-icon-calendar-event")).toBeHidden();

  await pill.click();
  await expect(page.locator('[data-testid="composer-plan-mode"]')).toHaveCount(0);
});

test("the skill row under the 技能 divider carries the shared skill glyph", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.pressSequentially("/");

  const menu = commandMenu(page);
  await expect(menu).toBeVisible();
  // One glyph for skills: a per-name icon table used to give four names a
  // bespoke mark and every other skill the generic one, which read as "this
  // one is special" for a reason the reader cannot see. The fixture's roster
  // has a single skill, so one puzzle glyph is the whole section.
  const skillRows = menu.locator('[data-webui-command-section="skills"] ~ [role="option"]');
  await expect(skillRows).toHaveCount(1);
  await expect(skillRows.locator("svg.tabler-icon-puzzle")).toHaveCount(1);
  // And no row above the divider borrows the skill glyph.
  await expect(
    menu.locator('[role="option"]').filter({ has: page.locator("svg.tabler-icon-puzzle") }),
  ).toHaveCount(1);
});

test("/compact from the slash palette reaches the runtime with its instruction", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.fill("/comp");
  const compact = commandMenu(page).getByRole("option", { name: /压缩/ });
  await expect(compact).toBeVisible();
  await compact.click();
  await input.pressSequentially(" preserve code changes");
  await input.press("Enter");

  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter(
    (request) => request.operation === "runCommand",
  ))).toHaveLength(1);
  const run = await page.evaluate(() => window.__fixture.requests.find(
    (request) => request.operation === "runCommand",
  ));
  expect(run.body).toMatchObject({
    command: "compact",
    input: "preserve code changes",
    sessionId: "A",
  });
});

test("pressing Enter sends an exact /compact command", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.delayNext("runCommand", { command: "compact" });
  });
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.fill("/compact");
  await input.press("Enter");

  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter(
    (request) => request.operation === "runCommand" && request.body.command === "compact",
  ))).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some(
    (request) => request.operation === "runCommand" && request.body.command === "compact",
  ))).toBe(true);
  await expect(input).toHaveValue("");
  await expect(page.locator('[data-webui-transcript="A"] [data-webui-command-running]')).toContainText("正在压缩会话");
  await page.evaluate(() => window.__fixture.resolve(
    "runCommand",
    { command: "compact" },
    { handled: true, output: "Compaction completed. Messages: 2 → 1" },
  ));
  const run = await page.evaluate(() => window.__fixture.requests.find(
    (request) => request.operation === "runCommand" && request.body.command === "compact",
  ));
  expect(run.body.sessionId).toBe("A");
});

test("a completed /compact result stays with its original session after New Task", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.delayNext("runCommand", { command: "compact" });
  });
  await openApp(page, "#session=A");

  await composer(page).fill("/compact");
  await page.getByTestId("composer-send").click();
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some(
    (request) => request.operation === "runCommand" && request.body.command === "compact" && request.body.sessionId === "A",
  ))).toBe(true);

  await page.locator(".webui-brand-create-button").click();
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.replace(/^#/u, "")).get("session"))).toBeNull();
  await expect(page.locator("[data-webui-command-running]")).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  await page.evaluate(() => window.__fixture.resolve(
    "runCommand",
    { command: "compact" },
    { handled: true, output: "Compaction completed. Messages: 2 → 1" },
  ));

  await expect(page.locator("[data-webui-command-output]")).toHaveCount(0);
  await switchSession(page, "A");
  await expect(page.locator('[data-webui-transcript="A"] [data-webui-command-output]')).toHaveText("Compaction completed. Messages: 2 → 1");
});

test("/compact shows progress while running and confirms the result", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.delayNext("runCommand", { command: "compact" });
  });
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.fill("/compact");
  const send = page.getByTestId("composer-send");
  await expect(send).toBeEnabled();
  await send.click();

  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some(
    (request) => request.operation === "runCommand" && request.body.command === "compact",
  ))).toBe(true);
  const progress = page.locator('[data-webui-transcript="A"] [data-webui-command-running]');
  await expect(progress).toContainText("正在压缩会话");
  await expect(progress.locator(".webui-feedback-spinner")).toBeVisible();
  await expect(page.locator("[data-webui-command-running]")).toHaveCount(1);
  await expect(
    page.locator('[data-webui-message-list="true"]').locator(":scope > *").last(),
  ).toHaveAttribute("data-webui-command-running", "true");

  await page.evaluate(() => window.__fixture.resolve(
    "runCommand",
    { command: "compact" },
    { handled: true, output: "Compaction completed.\nMessages: 2 → 1\nTokens: 41557 → 41032" },
  ));
  const result = page.locator('[data-webui-transcript="A"] [data-webui-command-output]');
  const summary = "Compaction completed. · Messages: 2 → 1 · Tokens: 41557 → 41032";
  await expect(result).toHaveText(summary);
  await expect(result).toHaveAttribute("title", summary);
  await expect(result).toHaveCSS("white-space", "nowrap");
  await expect(page.locator('[data-webui-transcript="A"] [role="separator"]')).toBeVisible();
  await expect(result).toBeVisible();
  await expect(input).toHaveValue("");
});

test("the composer's popups are placed by the shared layer, inside the viewport", async ({ page }) => {
  // A popup that is not placed is a popup that is somewhere else: the shared
  // layer places it against the composer, and a class of its own that claims a
  // `position` takes the placement away. It then falls into the page flow —
  // a viewport below the reader, where the `+` button's menu used to go, so
  // that the button did nothing at all and the palette ran off the bottom of
  // the screen with its last rows out of reach.
  const placement = async (label, selector) => {
    const popup = page.locator(selector);
    await expect(popup, label).toBeVisible();
    const box = await popup.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        position: getComputedStyle(node).position,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: window.innerHeight,
        width: window.innerWidth,
      };
    });
    // Placed by the shared layer, in the viewport's coordinates.
    expect(box.position, `${label} is positioned by the shared layer`).toBe("fixed");
    expect(box.top, `${label} is inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.bottom, `${label} is inside the viewport`).toBeLessThanOrEqual(box.height);
    expect(box.left, `${label} is inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${label} is inside the viewport`).toBeLessThanOrEqual(box.width);
  };

  await openApp(page, "#session=A");

  // The `+` menu: it opens above the button it belongs to. The popup and the
  // menu's own content wrapper share a class, so the popup is named by both.
  await page.locator('[data-testid="composer-add-menu"]').click();
  await placement("the + menu", ".webui-dropdown-popup.webui-composer-menu-stack");
  await page.keyboard.press("Escape");

  // The slash palette: it opens above the input box, in the room there is.
  const input = composer(page);
  await input.click();
  await input.pressSequentially("/");
  await placement("the slash palette", '[data-webui-command-menu="true"]');
  await input.press("Escape");
});

test("the composer's second-level menu has an opaque shared surface", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.locator('[data-testid="composer-add-menu"]').click();
  const root = page.locator(".webui-dropdown-popup.webui-composer-menu-stack");
  for (const name of ["skills", "plugins"]) {
    const submenu = page.locator(`[data-webui-composer-submenu="${name}"]`);
    await page.locator(`[data-webui-composer-submenu-trigger="${name}"]`).hover();
    await expect(submenu).toBeVisible();
    await expect(submenu).toHaveAttribute("data-webui-motion", "surface");
    await expect(submenu).toHaveAttribute("data-webui-motion-state", "enter");

    const [rootBackground, submenuBackground] = await Promise.all([
      root.evaluate((node) => getComputedStyle(node).backgroundColor),
      submenu.evaluate((node) => getComputedStyle(node).backgroundColor),
    ]);
    expect(submenuBackground, `${name} submenu has an opaque surface`).not.toBe("rgba(0, 0, 0, 0)");
    expect(submenuBackground, `${name} submenu matches the root menu surface`).toBe(rootBackground);

    await root.getByRole("menuitem", { name: "添加文件或图片" }).hover();
    await expect(submenu).toHaveAttribute("data-webui-motion-state", "exit");
    expect(await submenu.evaluate((node) => getComputedStyle(node).animationName)).toBe("webui-motion-surface-exit");
    await expect(submenu).toHaveCount(0, { timeout: 500 });
  }
});

test("the workspace picker opens above its row, inside the viewport", async ({ page }) => {
  // The project row lives on the home surface, and its list is the tallest
  // popup in the composer: opened downwards on a short window it ran off the
  // bottom of the screen with its last rows out of reach.
  await openApp(page, "#");
  const row = page.locator('[data-webui-workspace-picker="true"]').first();
  await expect(row).toBeVisible();
  await row.click();

  const popup = page.locator(".webui-dropdown-popup.webui-workspace-picker-menu");
  await expect(popup).toBeVisible();
  const box = await popup.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      position: getComputedStyle(node).position,
      top: rect.top,
      bottom: rect.bottom,
      height: window.innerHeight,
    };
  });
  expect(box.position).toBe("fixed");
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(box.height);
});

test("↑ recalls committed inputs; a manual edit exits the browse", async ({ page }) => {
  await openApp(page, "#session=A");

  await startTurn(page, "A", "first submitted message");
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await startTurn(page, "A", "second submitted message");
  await emitStream(page, "A", { dataJson: "[DONE]" });

  const input = composer(page);
  await input.click();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second submitted message");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first submitted message");
  // Clamped at the oldest entry: a third ↑ stays put rather than exiting.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first submitted message");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("second submitted message");
  // Stepping past the newest exits and restores the (empty) pre-browse draft.
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");

  // Browsing again, then editing by hand, exits the browse: the next ↑ starts
  // a fresh browse from the newest entry, not from where the cursor was.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second submitted message");
  await input.pressSequentially("!");
  await expect(input).toHaveValue("second submitted message!");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second submitted message");
});

test("drafts are per session and survive a switch and a reload", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.fill("draft for A");
  await switchSession(page, "B");
  await expect(input).toHaveValue("");
  await input.fill("draft for B");
  await switchSession(page, "A");
  await expect(input).toHaveValue("draft for A");
  const persistedBeforeReload = await page.evaluate(() =>
    window.localStorage.getItem("webui.composer.state.v1"),
  );
  expect(persistedBeforeReload).toContain("draft for A");
  expect(persistedBeforeReload).toContain("draft for B");

  await page.reload();
  await expect(page.locator("#webui-root")).toBeVisible();
  await expect(input).toHaveValue("draft for A");
  const persisted = await page.evaluate(() =>
    window.localStorage.getItem("webui.composer.state.v1"),
  );
  expect(persisted).toContain("draft for A");
  expect(persisted).toContain("draft for B");
});

test("history is per session — B's submissions do not leak into A", async ({ page }) => {
  await openApp(page, "#session=B");

  await startTurn(page, "B", "message in B");
  await emitStream(page, "B", { dataJson: "[DONE]" });
  await switchSession(page, "A");
  const input = composer(page);
  await input.click();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("");

  // The negative result is meaningful only if the owning session still has
  // its own entry to recall.
  await switchSession(page, "B");
  await input.click();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("message in B");
});

test("attaching a file and an image renders chips that can be removed", async ({ page }) => {
  await openApp(page, "#session=A");

  // The shared `WebuiFileInput` owns the class now; the accessible label is the
  // composer's, and it is what identifies the control.
  const fileInput = page.locator('input.webui-file-input[aria-label="添加文件或图片"]');
  await fileInput.setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachment") },
    { name: "pixel.png", mimeType: "image/png", buffer: TINY_PNG },
  ]);

  const chips = page.locator('[data-webui-composer-attachments="true"]');
  await expect(chips).toBeVisible();
  await expect(chips.getByText("notes.txt")).toBeVisible();
  await expect(chips.getByText("pixel.png")).toBeVisible();
  // Image attachments render a thumbnail, not just the extension badge.
  await expect(chips.locator("img")).toHaveCount(1);

  await chips.getByRole("button", { name: "移除 notes.txt" }).click();
  await expect(chips.getByText("notes.txt")).toHaveCount(0);
  await expect(chips.getByText("pixel.png")).toBeVisible();
});

test("the directory input accepts a folder selection and renders its chips", async ({ page }) => {
  await openApp(page, "#session=A");

  // B-4's folder half: the hidden webkitdirectory input needs a real
  // directory (Playwright enforces that for directory inputs), so build one
  // in tmp. Chips are named by webkitRelativePath, which prefixes the chosen
  // directory's own name — hence substring assertions.
  const folder = mkdtempSync(path.join(tmpdir(), "webui-folder-"));
  try {
    mkdirSync(path.join(folder, "src"));
    writeFileSync(path.join(folder, "root.txt"), "root");
    writeFileSync(path.join(folder, "src", "main.ts"), "export {};\n");
    const folderInput = page.locator('input.webui-file-input[aria-label="添加本地文件夹"]');
    await folderInput.setInputFiles(folder);
    const chips = page.locator('[data-webui-composer-attachments="true"]');
    await expect(chips).toBeVisible();
    await expect(chips.getByText("root.txt")).toBeVisible();
    await expect(chips.getByText("main.ts")).toBeVisible();
    await chips.getByRole("button", { name: /移除/ }).first().click();
    await expect(chips.getByText("root.txt")).toHaveCount(0);
    await expect(chips.getByText("main.ts")).toBeVisible();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("@ opens the mention menu and the local-file picker entry drives the OS chooser", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.pressSequentially("@");
  const menu = page.locator('[data-webui-mention-menu="true"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByText("添加本地文件", { exact: true })).toBeVisible();
  await expect(menu.getByText("添加本地文件夹", { exact: true })).toBeVisible();

  // Choosing 添加本地文件 opens the hidden file input's chooser; Playwright
  // intercepts it and hands back a real file, which must land as a chip.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    menu.getByText("添加本地文件", { exact: true }).click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles({ name: "via-mention.md", mimeType: "text/markdown", buffer: Buffer.from("# picked") });
  const chips = page.locator('[data-webui-composer-attachments="true"]');
  await expect(chips.getByText("via-mention.md")).toBeVisible();
  await expect(menu).toHaveCount(0);
});

// The one rule criterion 6 names as the "current button/Enter shared gate",
// observed on the built client rather than inside a unit: with nothing to
// submit the button is disabled AND Enter starts nothing, and a draft opens both
// paths at once. The gate itself is pinned by the unit test; this is the
// browser-side check that the two consumers really read the same value.
test("the send button and Enter share one gate: empty refuses, a draft submits", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  const submit = page.getByRole("button", { name: "发送" });

  await expect(submit).toBeDisabled();
  await input.click();
  await input.press("Enter");
  await expect.poll(() => requestCount(page, "sendMessage")).toBe(0);

  await input.pressSequentially("共享闸门");
  await expect(submit).toBeEnabled();
  await input.press("Enter");
  await expect.poll(() => requestCount(page, "sendMessage")).toBe(1);
  await expect(input).toHaveValue("");
});

// Criterion 7's input-to-owner-to-transport path, asserted on the request the
// fixture actually received: the text typed into the composer is what reaches
// the wire, and the editor is clear afterwards.
test("a submission carries the typed text to the transport", async ({ page }) => {
  await openApp(page, "#session=A");

  const input = composer(page);
  await input.click();
  await input.pressSequentially("input-to-owner-to-transport");
  await input.press("Enter");

  await expect.poll(() =>
    page.evaluate(() =>
      window.__fixture.requests.find((entry) => entry.operation === "sendMessage")?.body,
    ),
  ).toEqual({ id: "A", content: "input-to-owner-to-transport" });
  await expect(input).toHaveValue("");
});
