// The standalone Mini App in the built client: inline tab → browser tab of its own.
//
// This is the acceptance #257 cannot get from a unit test. The unit suites prove
// the lease record, the catalogue overlay and each render branch; this drives the
// assembled client — the real panel, the real picker, the real view, the real
// route and the real standalone surface — against the suite's fixture transport,
// and asserts what a person sees: a control that opens the Mini App in its own
// tab, a tab that shows the Mini App and nothing else, an inline view that says
// where it went, and a switch that focuses that tab instead of opening a second
// one.
//
// The fixture stands in for the host, so what this does *not* prove is the
// service's lease lifetime (a socket close is not observable in-page; that is
// `miniapp-operations.test.ts`) or that the Mini App's own page renders inside the
// frame. The inline "elsewhere" half is driven by changing the fixture's catalogue
// answer, which is the same way the existing stopped-runtime case is driven.
//
// The fixture setup goes on the *context*, not the page, because the popup is a
// second document with its own fixture instance.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

const PLUGIN = "demo.miniapp";
const STANDALONE_STUB = "/__miniapp-stub";

/** The catalogue row the fixture answers with, in the presentation state asked for. */
function catalogueRow(detached, presentationRevision) {
  return {
    pluginId: PLUGIN,
    displayName: "演示应用",
    description: "一个用于浏览器验收的 Mini App",
    runtime: { kind: "process", status: "running" },
    detached,
    presentationRevision,
  };
}

/** Install the fixture answers in every document this test opens. */
async function configureDocuments(page) {
  await page.context().addInitScript({
    content: `
      window.__WEBUI_FIXTURE_SETUP__ ??= [];
      window.__WEBUI_FIXTURE_SETUP__.push(() => {
        window.__fixture.setResponse("listMiniApps", {
          miniApps: [${JSON.stringify(catalogueRow(false, 0))}],
        });
        window.__fixture.setResponse("openMiniApp", {
          pluginId: ${JSON.stringify(PLUGIN)},
          viewUrl: window.location.origin + ${JSON.stringify(STANDALONE_STUB)},
        });
      });
    `,
  });
}

/** Tell the inline document what the catalogue answers next. */
function setPresentation(page, row) {
  return page.evaluate(
    (next) => window.__fixture.setResponse("listMiniApps", { miniApps: [next] }),
    row,
  );
}

async function openWorkspacePanel(page) {
  await page
    .getByTestId("workspace-panel-controls")
    .getByRole("button", { name: "浏览器" })
    .click();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
}

test("the inline tab moves the Mini App into its own tab, which shows only the Mini App", async ({
  page,
  context,
}) => {
  await configureDocuments(page);
  await openApp(page);
  await openWorkspacePanel(page);
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();

  // The inline tab offers the move.
  const move = page.getByTestId("miniapp-open-standalone");
  await expect(move).toBeVisible();
  await expect(move).toContainText("在新标签页中打开");

  const [popup] = await Promise.all([page.waitForEvent("popup"), move.click()]);
  await popup.waitForLoadState("domcontentloaded");

  // The tab is the standalone presentation: this client, showing one Mini App.
  expect(popup.url()).toContain("/miniapp?");
  expect(popup.url()).toContain(`plugin=${PLUGIN}`);
  expect(popup.url()).toContain("session=A");
  await expect(popup.locator("#webui-root")).toBeVisible();
  const standalone = popup.getByTestId("miniapp-standalone");
  await expect(standalone).toBeVisible();
  await expect(standalone).toHaveAttribute("data-plugin-id", PLUGIN);
  await expect(popup.getByTestId("miniapp-view-frame")).toBeVisible();
  // Nothing else is in that document — no workspace, no rail.
  await expect(popup.getByTestId("workspace-panel")).toHaveCount(0);
  // And no in-page way back or out (criterion 6: closing the tab is the only one).
  await expect(popup.getByTestId("miniapp-open-standalone")).toHaveCount(0);
  await expect(popup.getByTestId("miniapp-switch-standalone")).toHaveCount(0);
  await expect(popup.getByTestId("miniapp-view-detached")).toHaveCount(0);
});

test("the inline view reports the live standalone tab, switches to it, and stops when it closes", async ({
  page,
  context,
}) => {
  await configureDocuments(page);
  await openApp(page);
  await openWorkspacePanel(page);
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByTestId("miniapp-open-standalone").click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");

  // The service now reports a live standalone presentation. The inline view reads
  // it on its poll, stops framing a second presentation, and says where it is.
  await setPresentation(page, catalogueRow(true, 1));
  const detached = page.getByTestId("miniapp-view-detached");
  await expect(detached).toBeVisible({ timeout: 10_000 });
  await expect(detached).toContainText("已在独立的浏览器标签页中打开");
  await expect(page.getByTestId("miniapp-view-frame")).toHaveCount(0);
  await expect(page.getByTestId("miniapp-open-standalone")).toHaveCount(0);

  // Switching focuses that tab: one document, not a second one.
  const openPages = context.pages().length;
  await page.getByTestId("miniapp-switch-standalone").click();
  await page.waitForTimeout(500);
  expect(context.pages().length).toBe(openPages);

  // Closing the tab releases the presentation, and the inline view stops reporting
  // it and frames the Mini App again.
  await popup.close();
  await setPresentation(page, catalogueRow(false, 1));
  await expect(page.getByTestId("miniapp-view-detached")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();
  await expect(page.getByTestId("miniapp-open-standalone")).toBeVisible();
});

test("a deep link naming a session that has ended still shows the Mini App", async ({ page }) => {
  // The standalone page's own document: the lease frame reports the session as
  // ended, which is a report rather than a gate.
  await page.context().addInitScript({
    content: `
      window.__WEBUI_FIXTURE_SETUP__ ??= [];
      window.__WEBUI_FIXTURE_SETUP__.push(() => {
        window.__fixture.setResponse("listMiniApps", {
          miniApps: [
            {
              pluginId: ${JSON.stringify(PLUGIN)},
              displayName: "演示应用",
              runtime: { kind: "process", status: "running" },
              detached: true,
              presentationRevision: 2,
            },
          ],
        });
        window.__fixture.setResponse("openMiniApp", {
          pluginId: ${JSON.stringify(PLUGIN)},
          viewUrl: window.location.origin + ${JSON.stringify(STANDALONE_STUB)},
        });
        window.__fixture.setResponse("watchMiniAppPresentation", {
          presentationRevision: 2,
          session: "ended",
        });
      });
    `,
  });

  await page.goto(`/miniapp?token=synthetic-token&plugin=${PLUGIN}&session=ended-session`);
  await expect(page.locator("#webui-root")).toBeVisible();

  const ended = page.getByTestId("miniapp-standalone-session-ended");
  await expect(ended).toBeVisible();
  await expect(ended).toContainText("该会话已结束");
  // Reported, not enforced: the Mini App is plugin-scoped and still renders.
  await expect(page.getByTestId("miniapp-standalone")).toBeVisible();
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();
  // Still no way back inline.
  await expect(page.getByTestId("miniapp-switch-standalone")).toHaveCount(0);
});
