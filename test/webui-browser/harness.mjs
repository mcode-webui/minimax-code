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
