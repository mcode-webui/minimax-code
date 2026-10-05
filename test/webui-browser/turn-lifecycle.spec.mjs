// Agent turn lifecycle, page reload, session switching, and streaming resume.
//
// The existing transcript spec covers message paging and live-view ownership.
// This file covers the *transport* half of a turn: what the client does from
// `sendMessage` through the first frames, through a mid-turn socket drop or a
// `resume_overflow`, to `[DONE]` — and what survives a reload or a session
// round trip in between. Every assertion runs against the built client driven
// by the in-page fixture, so the wire shapes here are the real ones.

import { expect } from "@playwright/test";

import {
  assistantBody,
  configureFixture,
  dropStream,
  emitAgentMessage,
  emitStream,
  liveIndicator,
  livePulse,
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

test("an agent turn streams thinking and answer, then settles on DONE", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Run the synthetic turn");
  await expect(liveIndicator(page)).toBeVisible();

  await emitAgentMessage(page, "A", {
    msg_id: "a-turn-1",
    thinking_content: "Synthetic reasoning",
    msg_content: "Synthetic answer one",
  });
  const body = assistantBody(page, "a-turn-1");
  await expect(body).toBeVisible();
  await expect(body.getByText("Synthetic answer one")).toBeVisible();

  // A tool call landing on the same message must not displace the answer.
  await emitAgentMessage(page, "A", {
    msg_id: "a-turn-1",
    tool_calls: [{ id: "call-1", function: { name: "bash", arguments: JSON.stringify({ command: "ls -la" }) } }],
  });
  await expect(body.getByText("Synthetic answer one")).toBeVisible();

  // The per-turn pulse is the element the stranded-animation bug lived on:
  // while the turn streams it is present exactly once, and `[DONE]` must
  // clear it.
  await expect(livePulse(page)).toHaveCount(1);
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
  await expect(livePulse(page)).toHaveCount(0);
  await expect(body.getByText("Synthetic answer one")).toHaveCount(1);
  // The answer landed once, not once per frame the turn delivered.
  await expect(page.locator('[data-webui-transcript="A"]')).toBeVisible();
  await expect(page.locator('[data-webui-message-kind="assistant"]')).toHaveCount(1);
});

test("a server-initiated turn attaches a stream instead of hanging on 思考中", async ({ page }) => {
  await openApp(page, "#session=A");
  // The goal flow posts a hidden continuation prompt, a queued message
  // drains, another client sends — all of them start a turn without this
  // client calling sendMessage. The runtime still publishes `session.start`,
  // and that event is the only notice the client gets.
  await page.evaluate(() => window.__fixture.emitEvent({
    type: "session.start",
    payload: { sessionId: "A", turnId: "external-turn-1" },
    timestamp: 1_700_000_000_300,
    source: "synthetic",
  }));

  // Without a stream the transcript stays empty for the whole turn: the
  // composer shows 思考中 and nothing ever renders.
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "resumeSession" && request.body.id === "A",
  ))).toBe(true);

  await emitAgentMessage(page, "A", { msg_id: "external-1", msg_content: "Externally started answer" });
  await expect(page.getByText("Externally started answer")).toBeVisible();

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
});

test("a turn whose session.start was missed is recovered through the active-turn probe", async ({ page }) => {
  // The event can land before the client finished subscribing, or be lost
  // across a watchEvents reconnect. The session list cannot cover the gap —
  // its status carries no turn id — so the client asks the server instead.
  await configureFixture(page, () => window.__fixture.setActiveTurn({ turnId: "missed-turn", busyReason: "turn", locallyOwned: false }));
  await openApp(page, "#session=A");

  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "getActiveTurn" && request.body.id === "A",
  ))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "resumeSession" && request.body.id === "A",
  ))).toBe(true);

  await emitAgentMessage(page, "A", { msg_id: "missed-1", msg_content: "Recovered answer" });
  await expect(page.getByText("Recovered answer")).toBeVisible();
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
});

test("a compaction does not pull the transcript into a stream", async ({ page }) => {
  // `busyReason: "compaction"` means the session is busy without producing an
  // assistant transcript; attaching would leave a stream with nothing to show.
  await configureFixture(page, () => window.__fixture.setActiveTurn({ turnId: "compacting-turn", busyReason: "compaction", locallyOwned: false }));
  await openApp(page, "#session=A");
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "getActiveTurn",
  ))).toBe(true);
  expect(await page.evaluate(() => window.__fixture.requests.filter(
    (request) => request.operation === "resumeSession",
  ).length)).toBe(0);
});

test("a mid-turn socket drop resumes from the last cursor and keeps the turn", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Synthetic resume turn");
  await emitAgentMessage(page, "A", { msg_id: "a-turn-1", msg_content: "Before the drop" }, "cursor-1");
  await expect(page.getByText("Before the drop")).toBeVisible();

  await dropStream(page, "A");
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "resumeSession" && request.body.afterCursor === "cursor-1",
  ))).toBe(true);

  // The replacement subscription keeps delivering into the same turn.
  await emitAgentMessage(page, "A", { msg_id: "a-turn-2", msg_content: "After the drop" }, "cursor-2");
  await expect(page.getByText("After the drop")).toBeVisible();
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
  await expect(page.getByText("Before the drop")).toBeVisible();
  await expect(page.getByText("After the drop")).toBeVisible();
});

test("resume_overflow reloads authoritative history and resubscribes without a cursor", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [{ msgId: "history-a-authoritative", role: "user", msgContent: "Authoritative history A", timestamp: 1_700_000_000_050 }],
      hasMore: false,
    });
  });
  await openApp(page, "#session=A");
  const beforeOverflow = await requestCount(page, "getMessages");
  await startTurn(page, "A", "Synthetic overflow turn");
  await emitAgentMessage(page, "A", { msg_id: "a-turn-1", msg_content: "Live only message" }, "cursor-1");
  await expect(page.getByText("Live only message")).toBeVisible();

  await emitStream(page, "A", { dataJson: JSON.stringify({ type: "resume_overflow" }) });
  // The loop only inspects `nextAction` once the current subscription
  // settles, so the server ending the stream is what hands control to the
  // resync branch. Without this `[DONE]` the test would pass vacuously.
  await emitStream(page, "A", { dataJson: "[DONE]" });

  // The resync path reloads history, so the live-only message is replaced by
  // the server's authoritative view rather than kept alongside it.
  await expect.poll(() => requestCount(page, "getMessages")).toBeGreaterThan(beforeOverflow);
  await expect(page.getByText("Authoritative history A")).toBeVisible();
  await expect(page.getByText("Live only message")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "resumeSession" && request.body.afterCursor === undefined,
  ))).toBe(true);

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
});

test("a page reload restores history and never revives a finished turn", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [
        { msgId: "history-user", role: "user", msgContent: "Persisted question", timestamp: 1_700_000_000_060 },
        { msgId: "history-assistant", role: "assistant", msgContent: "Persisted answer", timestamp: 1_700_000_000_061 },
      ],
      hasMore: false,
    });
  });
  await openApp(page, "#session=A");
  await expect(page.getByText("Persisted answer")).toBeVisible();
  await expect(liveIndicator(page)).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#webui-root")).toBeVisible();
  await expect(page.getByText("Persisted question")).toHaveCount(1);
  await expect(page.getByText("Persisted answer")).toHaveCount(1);
  // A reloaded client has no live turn: neither the bottom indicator nor the
  // per-turn pulse may reappear from reloaded history alone.
  await expect(liveIndicator(page)).toHaveCount(0);
  await expect(livePulse(page)).toHaveCount(0);
});

test("switching away and back keeps a live turn attached to its own session", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Synthetic switch turn");
  await emitAgentMessage(page, "A", { msg_id: "a-turn-1", msg_content: "A first message" });
  await expect(page.getByText("A first message")).toBeVisible();

  await switchSession(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await emitAgentMessage(page, "A", { msg_id: "a-turn-2", msg_content: "A late message" });
  await expect(page.getByText("A late message")).toHaveCount(0);

  await switchSession(page, "A");
  await expect(page.getByText("A first message")).toBeVisible();
  await expect(page.getByText("A late message")).toBeVisible();
  await expect(page.getByText("History B synthetic")).toHaveCount(0);
  // The turn is still running, so coming back must restore the live state.
  await expect(liveIndicator(page)).toBeVisible();

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
  await expect(page.getByText("A late message")).toBeVisible();
});

test("a goal continuation keeps one activity indicator at the tail of the transcript", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Run the goal turn");

  await emitAgentMessage(page, "A", {
    msg_id: "a-round-1",
    thinking_content: "First round reasoning",
    msg_content: "First round answer",
  });
  const first = assistantBody(page, "a-round-1");
  await expect(first).toBeVisible();
  await expect(livePulse(page)).toHaveCount(1);

  // Goal mode auto-continuation arrives as a SYNTHETIC USER message. A user
  // item opens a new group inside the still-live turn, so from here on one turn
  // owns two assistant groups.
  await emitAgentMessage(page, "A", {
    msg_id: "msg-user-goal-continuation-1",
    msg_content: "Continue working toward the active thread goal.",
  });
  await expect(page.getByText("Continue working toward the active thread goal.")).toBeVisible();

  // The previous round has settled and no message body is left to host the
  // row, so the indicator must hand off to the transcript-level status instead
  // of stranding itself above the continuation bubble.
  await expect(livePulse(page)).toHaveCount(0);
  await expect(liveIndicator(page)).toHaveCount(1);
  await expect(first.getByText("First round reasoning")).toHaveCount(1);
  // The settled round must not carry the next round's streamed content.
  await expect(first.getByText("Second round reasoning")).toHaveCount(0);

  await emitAgentMessage(page, "A", {
    msg_id: "a-round-2",
    thinking_content: "Second round reasoning",
  });
  const second = assistantBody(page, "a-round-2");
  await expect(second).toBeVisible();

  // The invariant: exactly one activity row in the whole transcript, hosted by
  // the trailing group.
  await expect(livePulse(page)).toHaveCount(1);
  await expect(liveIndicator(page)).toHaveCount(0);
  await expect(second.locator('[data-webui-thinking-live-status="true"]')).toHaveCount(1);
  await expect(first.locator('[data-webui-thinking-live-status="true"]')).toHaveCount(0);

  // Each round shows its own content once — the turn-wide live view used to be
  // broadcast into every live group, duplicating the stream across the thread.
  await expect(first.getByText("First round reasoning")).toHaveCount(1);
  await expect(second.getByText("Second round reasoning")).toHaveCount(1);
  await expect(page.getByText("First round answer")).toHaveCount(1);

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(livePulse(page)).toHaveCount(0);
  await expect(liveIndicator(page)).toHaveCount(0);
});

test("assistant messages merged into one group keep a single activity indicator", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Run the merged turn");

  await emitAgentMessage(page, "A", {
    msg_id: "a-merged-1",
    thinking_content: "Alpha reasoning",
    msg_content: "Alpha answer",
  });
  await expect(livePulse(page)).toHaveCount(1);

  // Consecutive assistant messages merge into the same group, so the group tail
  // — not the transcript tail — is what hosts the row.
  await emitAgentMessage(page, "A", {
    msg_id: "a-merged-2",
    thinking_content: "Beta reasoning",
  });
  const body = assistantBody(page, "a-merged-1");
  await expect(body.getByText("Beta reasoning")).toBeVisible();

  await expect(page.locator('[data-webui-assistant-body]')).toHaveCount(1);
  await expect(livePulse(page)).toHaveCount(1);
  await expect(liveIndicator(page)).toHaveCount(0);
  await expect(body.locator('[data-webui-thinking-live-status="true"]')).toHaveCount(1);
  // The merged group keeps both of its own messages, each exactly once.
  await expect(body.getByText("Alpha reasoning")).toHaveCount(1);
  await expect(body.getByText("Alpha answer")).toHaveCount(1);
});

test("a queued user message hands the activity indicator to the transcript tail", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Run the queued turn");

  await emitAgentMessage(page, "A", {
    msg_id: "a-queued-1",
    thinking_content: "Gamma reasoning",
    msg_content: "Gamma answer",
  });
  await expect(livePulse(page)).toHaveCount(1);
  await emitAgentMessage(page, "A", {
    msg_id: "a-queued-2",
    thinking_content: "Delta reasoning",
  });
  await expect(livePulse(page)).toHaveCount(1);

  // A queued follow-up opens a trailing USER group. The assistant group that
  // was hosting the row is no longer the transcript tail, so the row has to
  // move down rather than strand itself above the bubble.
  await emitAgentMessage(page, "A", {
    msg_id: "msg-user-queued-1",
    msg_content: "Queued follow-up",
  });
  await expect(page.getByText("Queued follow-up")).toBeVisible();

  await expect(livePulse(page)).toHaveCount(0);
  await expect(liveIndicator(page)).toHaveCount(1);
  await expect(page.getByText("Delta reasoning")).toHaveCount(1);

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(liveIndicator(page)).toHaveCount(0);
});

/** Ordered `ANSWER` / `PULSE` markers as rendered inside the assistant body. */
async function assistantRowOrder(page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-webui-assistant-body]");
    if (!body) return [];
    const kinds = [];
    const walk = (element) => {
      for (const child of element.children) {
        if (child.hasAttribute("data-webui-thinking-live-status")) kinds.push("PULSE");
        else if (child.classList.contains("webui-assistant-answer")) kinds.push("ANSWER");
        walk(child);
      }
    };
    walk(body);
    return kinds;
  });
}

test("a reply delivered as its own text-only message still renders above the pulse", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Run the split turn");

  // The tool round lands in its own message.
  await emitAgentMessage(page, "A", {
    msg_id: "a-split-1",
    thinking_content: "Let me check the goal first.",
    tool_calls: [{ id: "call-1", function: { name: "update_goal", arguments: JSON.stringify({ status: "waiting" }) } }],
  });
  await expect(livePulse(page)).toHaveCount(1);

  // The reply arrives as a SEPARATE message carrying text only. The live
  // projection used to drop that segment, so the answer lost its text part,
  // `primaryAnswerPart` went undefined, and the answer rendered AFTER the
  // whole process block — below the activity row instead of above it.
  await emitAgentMessage(page, "A", { msg_id: "a-split-2", msg_content: "Split reply" });
  await expect(page.getByText("Split reply")).toBeVisible();

  const order = await assistantRowOrder(page);
  expect(order).toContain("ANSWER");
  expect(order.indexOf("ANSWER")).toBeLessThan(order.indexOf("PULSE"));
  expect(order[order.length - 1]).toBe("PULSE");
  await expect(livePulse(page)).toHaveCount(1);

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(livePulse(page)).toHaveCount(0);
  await expect(page.getByText("Split reply")).toHaveCount(1);
});

test("a plain text-only turn keeps its reply free of any process disclosure", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Run the plain turn");

  // No thinking, no tool call: the per-view guard must keep the turn from
  // growing a disclosure just because text parts now survive the projection.
  await emitAgentMessage(page, "A", { msg_id: "a-plain-1", msg_content: "Plain reply" });
  await expect(page.getByText("Plain reply")).toBeVisible();
  await expect(livePulse(page)).toHaveCount(0);

  const body = page.locator("[data-webui-assistant-body]").first();
  await expect(body.locator("summary")).toHaveCount(0);
  await expect(body.locator("details")).toHaveCount(0);
  await expect(body.locator('[data-webui-message-kind="assistant"]')).toHaveCount(1);

  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(body.locator("summary")).toHaveCount(0);
  await expect(body.locator("details")).toHaveCount(0);
  await expect(page.getByText("Plain reply")).toHaveCount(1);
});
