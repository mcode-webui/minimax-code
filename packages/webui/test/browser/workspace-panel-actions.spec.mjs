// The public panel actions, end to end in the built client (T11 acceptance 6).
//
// The panel's own state — which panel is open, which tab is active — moved out of
// the shell's component state and into `WebuiWorkspacePanelOwner`, keyed by
// session. That is the change most likely to break silently: a store that never
// notifies renders the first screen and nothing after it, and the panel still
// looks fine until you click something.
//
// So this drives the actions a user actually performs against the assembled
// application: open the panel, open a file from the tree, read it, close that
// tab, and switch sessions and back. The last one is the claim the owner exists
// to make — the panel is where you left it, because the state outlives the
// shell's render.

import { expect } from "@playwright/test";

import { configureFixture, openApp, openLauncherTile, switchSession, test } from "./harness.mjs";

/** Open the browser panel, choose 查看文件, and wait for the tree it loads. */
async function openFilePanel(page) {
  await page
    .getByTestId("workspace-panel-controls")
    .getByRole("button", { name: "浏览器" })
    .click();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await openLauncherTile(page, "files");
  const tree = page.getByRole("complementary", { name: "工作区文件树" });
  await expect(tree).toBeVisible();
  return tree;
}

test("the panel opens a file, closes the tab, and keeps its place across a session switch", async ({
  page,
}) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  const tree = await openFilePanel(page);

  // 1. Open a file from the tree. The panel switches to the preview tab and
  //    reads the bytes through the workspace owner.
  await tree.getByRole("button", { name: /a\.ts/u }).click();
  const preview = page.getByTestId("workspace-file-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("export const answer = 42;");
  await expect(page.getByTestId("workspace-panel")).toHaveAttribute(
    "data-active-tab",
    "file-preview",
  );
  // The row that is showing is the one marked as current.
  await expect(tree.getByRole("button", { name: /a\.ts/u })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // The read went to the runtime exactly once, for the tab that is showing.
  expect(
    await page.evaluate(
      () =>
        window.__fixture.requests.filter(
          (request) => request.operation === "readWorkspaceFile",
        ).length,
    ),
  ).toBe(1);

  // 2. Close that tab. A closed tab has no reader left, so its content is
  //    released and the panel falls back to the file list rather than keeping a
  //    preview nothing is looking at.
  await page.getByRole("button", { name: "a.ts 关闭" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId("workspace-files-empty")).toBeVisible();
  await expect(page.getByTestId("workspace-panel")).toHaveAttribute(
    "data-active-tab",
    "files",
  );

  // 3. The panel state is keyed by session. Session B has its own, untouched
  //    state, so the panel is closed there.
  await switchSession(page, "B");
  await expect(page.getByTestId("workspace-panel")).toHaveCount(0);

  // 4. Coming back to A finds the panel exactly where it was left, which is the
  //    claim the owner makes and the shell cannot: the state outlived the
  //    render that would otherwise have discarded it.
  await switchSession(page, "A");
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await expect(page.getByTestId("workspace-files-empty")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("界面出现错误");
});

test("an open preview tab survives leaving the session and coming back", async ({
  page,
}) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  const tree = await openFilePanel(page);

  await tree.getByRole("button", { name: /a\.ts/u }).click();
  const preview = page.getByTestId("workspace-file-preview");
  await expect(preview).toBeVisible();
  const readsBefore = await page.evaluate(
    () =>
      window.__fixture.requests.filter(
        (request) => request.operation === "readWorkspaceFile",
      ).length,
  );

  await switchSession(page, "B");
  await switchSession(page, "A");

  // The tab is still open and still showing the same file: the owner kept it,
  // so the panel re-renders from a store that never asked the runtime again.
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("export const answer = 42;");
  await expect(page.getByRole("tab", { name: /a\.ts/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    await page.evaluate(
      () =>
        window.__fixture.requests.filter(
          (request) => request.operation === "readWorkspaceFile",
        ).length,
    ),
  ).toBe(readsBefore);
  await expect(page.locator("body")).not.toContainText("界面出现错误");
});
