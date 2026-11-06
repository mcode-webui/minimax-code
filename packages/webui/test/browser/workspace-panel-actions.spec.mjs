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
import AxeBuilder from "@axe-core/playwright";

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

test("the file tree names each row with its own type glyph", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  const tree = await openFilePanel(page);

  // The tree used to draw one generic file for every row. The fixture's a.ts is
  // a TypeScript file, so its row carries the TS mark — read from the row's own
  // glyph, not from the tree's markup in general.
  const row = tree.getByRole("button", { name: /a\.ts/u });
  await expect(row.locator("svg.tabler-icon-file-type-ts")).toHaveCount(1);
  await expect(row.locator("svg.tabler-icon-file")).toHaveCount(0);
});

test("the tablist owns only tabs while new and close actions remain keyboard reachable", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openFilePanel(page);
  const strip = page.getByTestId("workspace-tab-strip");
  const tabs = strip.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
  const ownership = await strip.getByRole("tablist").getAttribute("aria-owns");
  expect(ownership?.split(" ")).toEqual(await tabs.evaluateAll((elements) => elements.map((element) => element.id)));
  const scan = await new AxeBuilder({ page })
    .include('[data-testid="workspace-tab-strip"]')
    .withRules(["aria-required-children", "aria-required-parent", "nested-interactive"])
    .analyze();
  expect(scan.violations).toEqual([]);
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const list = nodes.find((node) => node.name?.value === "工作区面板标签" && /^tablist$/iu.test(node.role?.value ?? ""));
    expect(list).toBeDefined();
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    expect(list.childIds.map((id) => byId.get(id)?.role?.value)).toEqual(Array(count).fill("tab"));
  } finally {
    await cdp.detach();
  }

  await page.getByTestId("workspace-add-tab").focus();
  await page.keyboard.press("Enter");
  await expect(tabs).toHaveCount(count + 1);
  await strip.locator(".webui-workspace-tab.is-active .webui-workspace-tab-close").focus();
  await page.keyboard.press("Enter");
  await expect(tabs).toHaveCount(count);
});

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

test("the workspace review stays responsive with 70 expanded diff files", async ({ page }) => {
  const files = Array.from({ length: 70 }, (_, index) => ({
    fileId: `src/file-${String(index).padStart(2, "0")}.ts`,
    path: `src/file-${String(index).padStart(2, "0")}.ts`,
    additions: 80,
    deletions: 0,
    status: "modified",
  }));
  const summary = {
    repositoryId: "repo-1",
    reviewSnapshotId: "perf-snapshot",
    files,
    totals: { files: files.length, additions: files.length * 80, deletions: 0 },
  };
  const diffs = files.map((file) => ({
    fileId: file.fileId,
    diff: {
      type: "text",
      diff: [
        `diff --git a/${file.path} b/${file.path}`,
        `--- a/${file.path}`,
        `+++ b/${file.path}`,
        "@@ -0,0 +1,80 @@",
        ...Array.from({ length: 80 }, (_, line) => `+export const value${line} = ${line};`),
      ].join("\n"),
    },
  }));
  await page.addInitScript((value) => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => window.__fixture.setWorkspaceReview(value.summary, value.diffs));
  }, { summary, diffs });
  await openApp(page);
  await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" }).click();
  await page.getByTestId("workspace-launcher-tile-review").click();
  const review = page.getByTestId("workspace-review");
  await expect(review.locator('[data-testid="turn-review-diff-file"]')).toHaveCount(70);
  await expect(review.locator(".webui-turn-review-code")).toHaveCount(70);

  const elapsed = await page.evaluate(async () => {
    const button = document.querySelector('[data-testid="workspace-review-toolbar-context"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("review context control missing");
    const start = performance.now();
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  });
  console.info(`70-file review interaction: ${elapsed.toFixed(1)} ms`);
  expect(elapsed, `70-file review interaction took ${elapsed.toFixed(1)} ms`).toBeLessThan(100);

  await page.evaluate(() => {
    window.__reviewLongTasks = [];
    window.__reviewLongTaskObserver = new PerformanceObserver((entries) => {
      window.__reviewLongTasks.push(...entries.getEntries().map((entry) => entry.duration));
    });
    window.__reviewLongTaskObserver.observe({ type: "longtask" });
  });
  const handle = page.getByRole("separator", { name: "调整工作区面板宽度" });
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("workspace panel resize handle is not laid out");
  const panelWidthBefore = await page.getByTestId("workspace-panel").evaluate((element) => element.getBoundingClientRect().width);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 96, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.getByTestId("workspace-panel").evaluate((element) => element.getBoundingClientRect().width)).not.toBe(panelWidthBefore);
  const dragLongTasks = await page.evaluate(() => {
    window.__reviewLongTaskObserver.disconnect();
    return [...window.__reviewLongTasks, ...window.__reviewLongTaskObserver.takeRecords().map((entry) => entry.duration)];
  });
  expect(dragLongTasks.filter((duration) => duration >= 50), `workspace panel drag produced ${dragLongTasks} ms long tasks`).toEqual([]);
  const lastFile = review.locator('[data-testid="turn-review-diff-file"]').last();
  await lastFile.scrollIntoViewIfNeeded();
  await expect(lastFile.locator(".webui-turn-review-line")).toHaveCount(81);
  expect(await lastFile.locator(".webui-turn-review-code").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(1000);
});

test("the workspace file tree uses the shared disclosure transition when a directory opens and closes", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  const tree = await openFilePanel(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const directory = tree.getByRole("button", { name: "src" });
  const chevron = directory.locator(".webui-motion-disclosure-transform");
  const disclosure = tree.locator(".webui-file-tree-disclosure");
  expect(await chevron.evaluate((element) => getComputedStyle(element).transitionProperty)).toContain("transform");
  expect(await chevron.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.16s");
  expect(await chevron.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  expect(await disclosure.getAttribute("data-webui-motion")).toBe("disclosure");
  expect(await disclosure.getAttribute("data-webui-motion-state")).toBe("collapse");
  expect(await disclosure.getAttribute("aria-hidden")).toBe("true");
  expect(await disclosure.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.16s");

  await directory.click();
  await expect(chevron).toHaveClass(/is-rotated-90/u);
  expect(await chevron.evaluate((element) => getComputedStyle(element).transform)).not.toBe("none");
  await expect(disclosure).toHaveAttribute("data-webui-motion-state", "expand");
  await expect(disclosure).not.toHaveAttribute("aria-hidden", "true");
  await page.waitForTimeout(70);
  expect(await disclosure.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(0);

  await directory.click();
  await expect(chevron).not.toHaveClass(/is-rotated-90/u);
  expect(await chevron.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.16s");
  await expect(disclosure).toHaveAttribute("data-webui-motion-state", "collapse");
  await expect(disclosure).toHaveAttribute("aria-hidden", "true");
  await page.waitForTimeout(70);
  expect(await disclosure.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(0);
  await page.waitForTimeout(130);
  expect(await disclosure.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
});

test("a page the Agent starts opens the closed panel, when 自动打开浏览器面板 is on", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page, "#session=A");
  // A fresh session has the workspace panel closed; the switch defaults to off,
  // so the first page the Agent starts must leave it closed.
  await expect(page.getByTestId("workspace-panel")).toHaveCount(0);
  await page.evaluate(() =>
    window.__fixture.setBrowserTabs([{ id: "agent-page-1", title: "Agent Page", url: "https://example.test/agent" }]),
  );
  await page.waitForTimeout(150);
  await expect(page.getByTestId("workspace-panel")).toHaveCount(0);

  // 设置 › 通用 › Agent 控制权限 › 自动打开浏览器面板 turned on: the next page the
  // Agent starts brings the panel up with it, which is the Desktop's rule.
  await page.evaluate(() => window.localStorage.setItem("webui-browser-auto-open", "true"));
  await page.evaluate(() =>
    window.__fixture.setBrowserTabs([
      { id: "agent-page-1", title: "Agent Page", url: "https://example.test/agent" },
      { id: "agent-page-2", title: "Second Page", url: "https://example.test/second" },
    ]),
  );
  await expect(page.getByTestId("workspace-panel")).toHaveCount(1);
  // The panel comes up on the page the Agent just started, named as the page is
  // named: the tab row is the panel's own evidence that the page arrived.
  await expect(page.getByTestId("workspace-panel").getByRole("tab", { name: /Second Page/ })).toBeVisible();
});

test("the file tree's search field stays inside the panel on both sides", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  const tree = await openFilePanel(page);

  // The shared search field is `width: 100%`; inside a column with side margins
  // that percentage used to be the panel's content width plus those margins, so
  // the field ran 12px past the panel's right edge and lost its right border to
  // the clip. The row below it is the reference: the field aligns with it on the
  // left and never reaches further right than the panel's own content box.
  const geometry = await tree.evaluate((panel) => {
    const field = panel.querySelector(".webui-workspace-file-search").getBoundingClientRect();
    const row = panel.querySelector(".webui-file-tree-row").getBoundingClientRect();
    const content = panel.querySelector(".webui-disclosure-content").getBoundingClientRect();
    return {
      fieldLeft: field.left,
      fieldRight: field.right,
      rowLeft: row.left,
      contentRight: content.right,
      panelLeft: panel.getBoundingClientRect().left,
      panelRight: panel.getBoundingClientRect().right,
    };
  });

  expect(geometry.fieldLeft).toBeCloseTo(geometry.rowLeft, 1);
  // 12px of side margin inside the panel's own 1px left border.
  expect(geometry.fieldLeft).toBeCloseTo(geometry.panelLeft + 13, 1);
  expect(geometry.fieldRight).toBeLessThanOrEqual(geometry.contentRight);
  expect(geometry.fieldRight).toBeLessThanOrEqual(geometry.panelRight - 12);
});

test("the file tree uses the shared horizontal disclosure while its workspace panel uses panel exit", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openFilePanel(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const fileTreePanel = page.locator(".webui-workspace-file-tree-panel");
  const workspacePanel = page.getByTestId("workspace-panel");
  await expect(fileTreePanel).toHaveAttribute("data-webui-motion", "disclosure");
  await expect(fileTreePanel).toHaveAttribute("data-webui-motion-state", "expand");
  expect(await fileTreePanel.evaluate((element) => getComputedStyle(element).transitionProperty)).toContain("width");
  expect(await fileTreePanel.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.16s");
  const fileTreeWidth = await fileTreePanel.evaluate((element) => element.getBoundingClientRect().width);

  await page.getByRole("button", { name: "隐藏文件树" }).click();
  await expect(fileTreePanel).toHaveAttribute("data-webui-motion-state", "collapse");
  await expect(fileTreePanel).toHaveAttribute("aria-hidden", "true");
  await page.waitForTimeout(70);
  const fileTreeWidthDuringCollapse = await fileTreePanel.evaluate((element) => element.getBoundingClientRect().width);
  expect(fileTreeWidthDuringCollapse).toBeGreaterThan(0);
  expect(fileTreeWidthDuringCollapse).toBeLessThan(fileTreeWidth);
  await page.waitForTimeout(130);
  expect(await fileTreePanel.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);

  await page.getByRole("button", { name: "显示文件树" }).click();
  await expect(fileTreePanel).toHaveAttribute("data-webui-motion-state", "expand");
  await page.waitForTimeout(200);
  expect(await fileTreePanel.evaluate((element) => element.getBoundingClientRect().width)).toBe(fileTreeWidth);

  await page.getByRole("button", { name: "关闭面板" }).click();
  await expect(workspacePanel).toHaveAttribute("data-webui-motion-state", "exit");
  const workspacePanelExit = await workspacePanel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  await expect(workspacePanel).toHaveCount(0);

  expect(workspacePanelExit).toEqual({ name: "webui-motion-panel-exit", duration: "0.18s" });
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
