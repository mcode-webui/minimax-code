import { expect, test } from "@playwright/test";
import { fixtureTransportInit } from "./fixture.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

async function openApp(page, hash = "#session=A") {
  await page.addInitScript({ content: fixtureTransportInit });
  await page.goto(`/${hash}`);
  await expect(page.locator("#webui-root")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "listSessions"))).toBe(true);
}

async function switchSession(page, sessionId) {
  await page.evaluate((id) => { window.location.hash = `session=${id}`; }, sessionId);
}

test("A history is never rendered during B's delayed first page", async ({ page }) => {
  await page.addInitScript({ content: fixtureTransportInit });
  await page.addInitScript(() => window.__fixture.delayNext("getMessages", { id: "B" }));
  await page.goto("/#session=A");
  await expect(page.getByText("History A synthetic")).toBeVisible();

  await switchSession(page, "B");
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some((item) => item.operation === "getMessages" && item.body.id === "B"))).toBe(true);
  await expect(page.getByText("History A synthetic")).toHaveCount(0);
  await expect(page.getByText("History B synthetic")).toHaveCount(0);

  await page.evaluate(() => window.__fixture.resolve("getMessages", { id: "B" }, { messages: [{ msgId: "history-B", role: "user", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 }], hasMore: false }));
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await expect(page.getByText("History A synthetic")).toHaveCount(0);
});

test("late A loadOlder completion leaves B messages, loading, and errors untouched", async ({ page }) => {
  await page.addInitScript({ content: fixtureTransportInit });
  await page.addInitScript(() => {
    window.__fixture.setPage("A", { messages: [{ msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 }], hasMore: true, nextCursor: "cursor-A" });
    window.__fixture.setPage("B", { messages: [{ msgId: "history-B", role: "user", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 }], hasMore: true, nextCursor: "cursor-B" });
    window.__fixture.delayNext("getMessages", { id: "A", before: "cursor-A" });
    window.__fixture.delayNext("getMessages", { id: "B", before: "cursor-B" });
  });
  await page.goto("/#session=A");
  await expect(page.getByText("History A synthetic")).toBeVisible();
  await page.getByRole("button", { name: "加载更早消息" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some((item) => item.operation === "getMessages" && item.body.before === "cursor-A"))).toBe(true);

  await switchSession(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await page.getByRole("button", { name: "加载更早消息" }).click();
  await expect(page.getByRole("button", { name: "正在加载更早消息" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some((item) => item.operation === "getMessages" && item.body.before === "cursor-B"))).toBe(true);
  await page.evaluate(() => window.__fixture.resolve("getMessages", { id: "A", before: "cursor-A" }, { messages: [{ msgId: "late-A-page", role: "user", msgContent: "Late A page synthetic", timestamp: 1_699_999_999_999 }], hasMore: false }));

  await expect(page.getByText("History B synthetic")).toBeVisible();
  await expect(page.getByText("Late A page synthetic")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "正在加载更早消息" })).toBeVisible();
  await page.evaluate(() => window.__fixture.resolve("getMessages", { id: "B", before: "cursor-B" }, { messages: [{ msgId: "older-B-page", role: "user", msgContent: "Older B page synthetic", timestamp: 1_699_999_999_998 }], hasMore: false }));
  await expect(page.getByText("Older B page synthetic")).toBeVisible();
  await expect(page.getByRole("button", { name: "正在加载更早消息" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("watchEvents keeps a spawned subagent through its next status event", async ({ page }) => {
  await openApp(page, "#session=A");
  await expect(page.getByTestId("progress-overview-panel")).toBeVisible();
  await page.evaluate(() => window.__fixture.emitEvent({ type: "session.spawned", payload: { sessionId: "A", generic: { eventType: "session.spawned", data: { sessionId: "child-A1", agentName: "synthetic-child", parentSessionId: "A", status: "running", title: "Synthetic child" } } }, timestamp: 1_700_000_000_100, source: "synthetic" }));
  await expect(page.getByText("Synthetic child")).toBeVisible();
  await page.evaluate(() => window.__fixture.emitEvent({ type: "session.status_updated", payload: { sessionId: "A", generic: { eventType: "session.status_updated", data: { sessionId: "child-A1", status: "running", title: "Synthetic child" } } }, timestamp: 1_700_000_000_101, source: "synthetic" }));
  await expect(page.getByText("Synthetic child")).toBeVisible();
});

test("stream DONE settles A after switching to B and A frames stay out of B", async ({ page }) => {
  await openApp(page, "#session=A");
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await composer.fill("Synthetic turn A");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("思考中…")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "sendMessage" && request.body.id === "A"))).toBe(true);

  await switchSession(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await page.evaluate(() => window.__fixture.emitStream("A", { dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "late-live-A", msg_content: "Late live A synthetic" } }) }));
  await expect(page.getByText("Late live A synthetic")).toHaveCount(0);
  await page.evaluate(() => window.__fixture.emitStream("A", { dataJson: "[DONE]" }));

  await switchSession(page, "A");
  await expect(page.getByText("思考中…")).toHaveCount(0);
});

test("home turn migrates its live writer once to the newly created session", async ({ page }) => {
  await openApp(page, "");
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await composer.fill("Synthetic home turn");
  await page.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "createSession"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "sendMessage" && request.body.id === "created-C"))).toBe(true);
  await expect(page.getByText("思考中…")).toBeVisible();
  await page.evaluate(() => window.__fixture.emitStream("created-C", { dataJson: "[DONE]" }));
  await expect(page.getByText("思考中…")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.replace(/^#/u, "")).get("session"))).toBe("created-C");
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "createSession").length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "sendMessage" && request.body.id === "created-C").length)).toBe(1);
});
