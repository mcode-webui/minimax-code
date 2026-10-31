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
  // The fixture's listSkills answers empty, so the palette shows the two
  // runnable built-ins plus the inert deploy-website row.
  await expect(menu.getByRole("option", { name: /目标/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /计划/ })).toBeVisible();

  await input.pressSequentially("go");
  await expect(menu.getByRole("option", { name: /目标/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /计划/ })).toHaveCount(0);

  // Escape drops the slash token under the caret (desktop behavior) and the
  // popover with it.
  await input.press("Escape");
  await expect(commandMenu(page)).toHaveCount(0);
  await expect(input).toHaveValue("");
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

  await page.locator('[data-testid="composer-add-menu"]').click();
  const root = page.locator(".webui-dropdown-popup.webui-composer-menu-stack");
  for (const name of ["skills", "plugins"]) {
    const submenu = page.locator(`[data-webui-composer-submenu="${name}"]`);
    await page.locator(`[data-webui-composer-submenu-trigger="${name}"]`).hover();
    await expect(submenu).toBeVisible();

    const [rootBackground, submenuBackground] = await Promise.all([
      root.evaluate((node) => getComputedStyle(node).backgroundColor),
      submenu.evaluate((node) => getComputedStyle(node).backgroundColor),
    ]);
    expect(submenuBackground, `${name} submenu has an opaque surface`).not.toBe("rgba(0, 0, 0, 0)");
    expect(submenuBackground, `${name} submenu matches the root menu surface`).toBe(rootBackground);
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

  const fileInput = page.locator('input.webui-composer-hidden-file-input[aria-label="添加文件或图片"]');
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
    const folderInput = page.locator('input.webui-composer-hidden-file-input[aria-label="添加本地文件夹"]');
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
