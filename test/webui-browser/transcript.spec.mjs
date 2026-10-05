import { expect } from "@playwright/test";

import { configureFixture, openApp, switchSession, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

test("A history is never rendered during B's delayed first page", async ({ page }) => {
  // A session switch fans out into three concurrent `getMessages` for B
  // (transcript first page, context usage, workspace history progress).
  // `delayNext` would only hold whichever goes out first — which is the
  // composer's context-usage call, not the transcript's — so the transcript
  // page would land anyway and the assertion below would prove nothing.
  await configureFixture(page, () => window.__fixture.delayEvery("getMessages", { id: "B" }));
  await page.goto("/#session=A");
  await expect(page.getByText("History A synthetic")).toBeVisible();

  await switchSession(page, "B");
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some((item) => item.operation === "getMessages" && item.body.id === "B"))).toBe(true);
  await expect(page.getByText("History A synthetic")).toHaveCount(0);
  await expect(page.getByText("History B synthetic")).toHaveCount(0);

  const released = await page.evaluate(() => window.__fixture.resolveAllPending("getMessages", { id: "B" }, { messages: [{ msgId: "history-B", role: "user", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 }], hasMore: false }));
  expect(released).toBeGreaterThan(0);
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await expect(page.getByText("History A synthetic")).toHaveCount(0);
});

test("late A loadOlder completion leaves B messages, loading, and errors untouched", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setPage("A", { messages: [{ msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 }], hasMore: true, nextCursor: "cursor-A" });
    window.__fixture.setPage("B", { messages: [{ msgId: "history-B", role: "user", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 }], hasMore: true, nextCursor: "cursor-B" });
    window.__fixture.delayNext("getMessages", { id: "A", before: "cursor-A" });
  });
  await page.goto("/#session=A");
  await expect(page.getByText("History A synthetic")).toBeVisible();
  await page.getByRole("button", { name: "加载更早消息" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some((item) => item.operation === "getMessages" && item.body.before === "cursor-A"))).toBe(true);

  await switchSession(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await page.evaluate(() => window.__fixture.resolve("getMessages", { id: "A", before: "cursor-A" }, { messages: [{ msgId: "late-A-page", role: "user", msgContent: "Late A page synthetic", timestamp: 1_699_999_999_999 }], hasMore: false }));

  await expect(page.getByText("History B synthetic")).toBeVisible();
  await expect(page.getByText("Late A page synthetic")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "正在加载更早消息" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "加载更早消息" })).toBeEnabled();
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
  const bHistoryCount = await page.getByText("History B synthetic").count();
  await page.evaluate(() => window.__fixture.emitStream("A", { dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "late-live-A", msg_content: "Late live A synthetic" } }) }));
  await expect(page.getByText("Late live A synthetic")).toHaveCount(0);
  await page.evaluate(() => window.__fixture.emitStream("A", { dataJson: "[DONE]" }));
  await page.evaluate(() => window.__fixture.emitStream("A", { dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "post-done-live-A", msg_content: "Post DONE A synthetic" } }) }));
  await expect(page.getByText("Post DONE A synthetic")).toHaveCount(0);
  await expect(page.getByText("History B synthetic")).toHaveCount(bHistoryCount);

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
  await expect.poll(() => page.evaluate(() => window.__fixture.activeStreamSessionIds())).toContain("created-C");
  await expect.poll(() => page.evaluate(() => window.__fixture.activeStreamSessionIds())).not.toContain("__webui-home__");
  await expect(page.getByText("思考中…")).toBeVisible();
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.replace(/^#/u, "")).get("session"))).toBe("created-C");
  const createdTranscript = page.locator('[data-webui-transcript="created-C"]');
  await expect(createdTranscript).toBeVisible();
  await page.evaluate(() => window.__fixture.emitStream("created-C", { dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: "created-live-C", msg_content: "Transferred stream C synthetic" } }) }));
  await expect(createdTranscript.getByText("Transferred stream C synthetic")).toBeVisible();
  await page.evaluate(() => { window.location.hash = ""; });
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
  await expect(page.getByText("Transferred stream C synthetic")).toHaveCount(0);
  await expect(page.getByText("思考中…")).toHaveCount(0);
  await switchSession(page, "created-C");
  await expect(createdTranscript.getByText("Transferred stream C synthetic")).toBeVisible();
  await page.evaluate(() => window.__fixture.emitStream("created-C", { dataJson: "[DONE]" }));
  await expect(page.getByText("思考中…")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.replace(/^#/u, "")).get("session"))).toBe("created-C");
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "createSession").length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "sendMessage" && request.body.id === "created-C").length)).toBe(1);
});

test("a late questionnaire.dismiss cannot revive the turn after a local skip", async ({ page }) => {
  await openApp(page, "#session=A");
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await composer.fill("Synthetic plan turn");
  await page.getByRole("button", { name: "发送" }).click();
  // Anchors the assertion below: the live indicator is genuinely on in this
  // state, so its disappearance is a real observation rather than a phase
  // that was never entered.
  await expect(page.getByText("思考中…")).toBeVisible();

  const requestId = "synthetic-questionnaire-1";
  await page.evaluate((id) => window.__fixture.emitEvent({
    type: "questionnaire.ask",
    payload: {
      sessionId: "A",
      request: {
        schemaVersion: 2,
        id,
        title: "Synthetic questionnaire",
        presentation: { replaceComposer: true, showProgress: false, allowBackNavigation: false },
        steps: [{
          id: "step-1",
          question: "Proceed with the synthetic plan?",
          selectionMode: 1,
          allowOther: false,
          otherPlaceholder: "",
          required: true,
          options: [{ id: "yes", label: "Yes" }],
        }],
      },
    },
    timestamp: 1_700_000_000_200,
    source: "synthetic",
  }), requestId);
  await expect(page.getByTestId("questionnaire-composer")).toBeVisible();

  await page.getByRole("button", { name: "跳过" }).click();
  await expect(page.getByTestId("questionnaire-composer")).toHaveCount(0);
  await expect(page.getByText("思考中…")).toHaveCount(0);

  // The runtime's late echo of the same resolution. A skip is reported as
  // `answered`, so this payload gives the client no way to tell it apart from
  // a normal answer — only "is it still the request I am showing?" does.
  await page.evaluate((id) => window.__fixture.emitEvent({
    type: "questionnaire.dismiss",
    payload: { sessionId: "A", requestId: id, status: "answered" },
    timestamp: 1_700_000_000_201,
    source: "synthetic",
  }), requestId);

  await expect(page.getByTestId("questionnaire-composer")).toHaveCount(0);
  await expect(page.getByText("思考中…")).toHaveCount(0);
});
