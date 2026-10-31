// Shared page helpers for the WebUI built-client browser suite.
//
// The fixtures are deterministic and in-page: every WebUI wire envelope the
// client sends lands on `window.__fixture` instead of a real server, so these
// helpers only ever talk to that fixture.
//
// Specs import `test` from here rather than from `@playwright/test`. That is
// what makes the harness-server guard below impossible to leave out: the guard
// is registered on the exported `test`, so every spec file that imports it
// inherits the guard for every test it declares, and a new spec gets it without
// restating anything. A per-test call that any test could forget is not a
// guarantee, and the suite runs against a built artifact served by whichever
// process happens to answer on the harness port.

import { expect, test as base } from "@playwright/test";

/** The suite's `test`, carrying the harness-server guard for every test. */
export const test = base;

/**
 * The pixel budget for a screenshot comparison, shared by every spec that
 * compares a baseline.
 *
 * The committed baselines are recorded under the pinned font environment in
 * `packages/webui/test/browser/fonts/`, so the glyphs are the same on every
 * machine. What remains is the rasterizer's own rounding at a rounded
 * corner: a bubble's right edge lands on a fractional pixel, and whether that
 * edge rounds up or down shifts a handful of antialiased pixels from run to
 * run. Measured over repeated runs of the browser suite, the widest such
 * shift is seven pixels on the transcript surface and one on the plugin
 * management list.
 *
 * The budget is therefore seven pixels plus a little headroom, on a capture
 * of well over a million pixels — under 0.001% of the image. A real layout
 * change moves orders of magnitude more than that: shifting one bubble edge
 * by a single pixel already changes nineteen pixels, so the budget cannot
 * hide a regression. Everything structural is asserted separately by DOM and
 * geometry checks, which are not subject to this budget.
 */
export const PIXEL_BUDGET = { maxDiffPixels: 8 };

/** Screenshot options shared by every baseline comparison. */
export const screenshotOptions = { animations: "disabled", ...PIXEL_BUDGET };

export async function configureFixture(page, setup) {
  await page.addInitScript({ content: `window.__WEBUI_FIXTURE_SETUP__ ??= []; window.__WEBUI_FIXTURE_SETUP__.push((${setup.toString()}));` });
}

function expectedServerId() {
  return test.info().config.metadata.webuiBrowserServerId;
}

/** The harness server must report this run's server id. Needs no document. */
async function assertHarnessServerHealth(page) {
  const health = await page.request.get("http://127.0.0.1:4179/health");
  expect(await health.json()).toEqual({ status: "ok", serverId: expectedServerId() });
}

/** The harness server and the page must both report this run's server id. */
async function assertHarnessServer(page) {
  await assertHarnessServerHealth(page);
  await expect.poll(() => page.evaluate(() => window.__WEBUI_TEST_SERVER_ID__)).toBe(expectedServerId());
}

// The server half runs before the test body, so a run aimed at the wrong server
// fails fast instead of after a full timeout. The page half only exists once a
// document has loaded, and specs load it at their own moment (some configure
// fixtures first, some call `page.goto` directly), so it runs after the body has
// navigated -- which is also what covers the tests that never reach `openApp`.
test.beforeEach(async ({ page }) => {
  await assertHarnessServerHealth(page);
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__WEBUI_TEST_SERVER_ID__)).toBe(expectedServerId());
});

export async function openApp(page, hash = "#session=A") {
  await page.goto(`/${hash}`);
  await assertHarnessServer(page);
  await expect(page.locator("#webui-root")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "listSessions"))).toBe(true);
}

export async function switchSession(page, sessionId) {
  await page.evaluate((id) => { window.location.hash = `session=${id}`; }, sessionId);
}

export async function startTurn(page, sessionId, text) {
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await composer.fill(text);
  await page.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => page.evaluate((id) => window.__fixture.requests.some((request) => request.operation === "sendMessage" && request.body.id === id), sessionId)).toBe(true);
}

/** Deliver one `WebuiStreamFrame` (cursor + dataJson) to a session's stream. */
export async function emitStream(page, sessionId, streamFrame) {
  await page.evaluate(
    ([id, frame]) => window.__fixture.emitStream(id, frame),
    [sessionId, streamFrame],
  );
}

/** Deliver one `agent_message` frame for a session's stream. */
export async function emitAgentMessage(page, sessionId, agentMessage, cursor) {
  await emitStream(page, sessionId, {
    ...(cursor === undefined ? {} : { cursor }),
    dataJson: JSON.stringify({ type: "agent_message", agent_message: agentMessage }),
  });
}

export async function dropStream(page, sessionId) {
  await page.evaluate((id) => window.__fixture.dropStream(id), sessionId);
}

export function livePulse(page) {
  return page.locator('[data-webui-thinking-live-status="true"]');
}

export function liveIndicator(page) {
  return page.getByText("思考中…");
}

export function assistantBody(page, messageId) {
  return page.locator(`[data-webui-assistant-body="${messageId}"]`);
}

/** Count of `operation` requests the fixture has recorded, optionally filtered. */
export function requestCount(page, operation) {
  return page.evaluate(
    (op) => window.__fixture.requests.filter((request) => request.operation === op).length,
    operation,
  );
}

/**
 * A launcher shortcut for a kind, opened wherever it currently is.
 *
 * The shortcut row holds as many shortcuts as it fits and moves the rest into
 * the overflow menu, so a shortcut that is top-level at one width is behind
 * the overflow at another. A test that names the shortcut it wants opens it
 * through whichever door it is behind, rather than pinning a width and
 * hoping the row still fits: the row capacity is a function of the panel
 * width, not of the shortcut.
 */
export async function openLauncherTile(page, kind) {
  const shortcut = page.getByTestId(`workspace-launcher-tile-${kind}`);
  if (await shortcut.isVisible()) {
    await shortcut.click();
    return;
  }
  await page.getByTestId("workspace-launcher-tile-more").click();
  await page.getByTestId(`workspace-launcher-overflow-${kind}`).click();
}
