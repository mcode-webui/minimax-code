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
// See docs/webui/webui-composer-module-b-spec.md for the behavior spec.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  assertHarnessServer,
  configureFixture,
  emitStream,
  openApp,
  startTurn,
  switchSession,
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
  await assertHarnessServer(page);

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

test("↑ recalls committed inputs; a manual edit exits the browse", async ({ page }) => {
  await openApp(page, "#session=A");
  await assertHarnessServer(page);

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
  await assertHarnessServer(page);

  const input = composer(page);
  await input.click();
  await input.fill("draft for A");
  await switchSession(page, "B");
  await expect(input).toHaveValue("");
  await input.fill("draft for B");
  await switchSession(page, "A");
  await expect(input).toHaveValue("draft for A");

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
  await assertHarnessServer(page);

  await startTurn(page, "B", "message in B");
  await emitStream(page, "B", { dataJson: "[DONE]" });
  await switchSession(page, "A");
  const input = composer(page);
  await input.click();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("");
});

test("attaching a file and an image renders chips that can be removed", async ({ page }) => {
  await openApp(page, "#session=A");
  await assertHarnessServer(page);

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
  await assertHarnessServer(page);

  // B-4's folder half: the hidden webkitdirectory input needs a real
  // directory (Playwright enforces that for directory inputs), so build one
  // in tmp. Chips are named by webkitRelativePath, which prefixes the chosen
  // directory's own name — hence substring assertions.
  const folder = mkdtempSync(path.join(tmpdir(), "webui-folder-"));
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
});

test("@ opens the mention menu and the local-file picker entry drives the OS chooser", async ({ page }) => {
  await openApp(page, "#session=A");
  await assertHarnessServer(page);

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
