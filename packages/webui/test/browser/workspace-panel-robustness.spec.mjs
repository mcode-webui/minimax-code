// What the workspace panel does when the runtime answers something it does not
// understand (T11; the finding T10 handed over).
//
// Opening the workspace panel crashed the whole UI into its error boundary when
// the tree or the terminal list came back as something other than what the panel
// renders: `filterWorkspaceFiles(fileTree.files)` over a non-array, and
// `terminals.find` over an object. The panel now treats both as "no answer": the
// tree becomes an error state and the terminal list an empty one.

import { expect } from "@playwright/test";

import { configureFixture, openApp, openLauncherTile, test } from "./harness.mjs";

test("the panel reports an unexpected tree answer instead of crashing", async ({
  page,
}) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await page.evaluate(() => {
    window.__fixture.unanswer("listWorkspaceFileTree");
    window.__fixture.unanswer("listTerminals");
  });

  await page
    .getByTestId("workspace-panel-controls")
    .getByRole("button", { name: "浏览器" })
    .click();
  await openLauncherTile(page, "files");

  // The panel is there, and the application never fell into its error boundary.
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("界面出现错误");
  // The transcript is still mounted: a bad workspace answer does not take the
  // rest of the surface with it.
  await expect(page.locator("[data-webui-transcript]")).toHaveCount(1);
  // And the tree says what happened rather than rendering the answer.
  await expect(page.getByTestId("workspace-panel")).toContainText(
    "工作区文件列表返回了意外的结果。",
  );
});
