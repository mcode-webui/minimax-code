// The goal's retained truth across a session switch (T05's
// `retained-goal-view-reconciliation`; T01 ledger C4).
//
// The goal selection effect cleared the canonical goal while it reset the view
// mode, so opening a session briefly destroyed the goal that session already had
// and only the re-read put it back. The switch now resets only the presentation.
//
// The last step opens a session whose goal re-read is HELD, so the banner can only
// be showing what that session's record already retained. With the old clear the
// record would have been wiped on the way in and the held read could never fill
// it back in — which is what makes this a regression pin for the correction and
// not just a description of the current behaviour.

import { expect } from "@playwright/test";
import { configureFixture, openApp, test } from "./harness.mjs";

/** Answer `isGoalEnabled` with `true` and `getGoal` from a PER-SESSION value the
 *  test controls, so one session's read can never answer with another's goal. A
 *  session the test holds is never answered at all. */
function controlGoalCapability() {
  // Seeded at install time: the app's first `getGoal` for A happens during boot,
  // before any test body could set this.
  window.__testGoals = {
    A: { sessionId: "A", goalId: "g-A", objective: "A 的目标", status: "active", tokensUsed: 1, turnsUsed: 1, timeUsedSeconds: 1, updatedAt: 1 },
    B: { sessionId: "B", goalId: "g-B", objective: "B 的保留目标", status: "active", tokensUsed: 10, turnsUsed: 2, timeUsedSeconds: 30, updatedAt: 1_700_000_100_000 },
  };
  const Base = window.WebSocket;
  window.WebSocket = class extends Base {
    send(serialized) {
      let frame;
      try { frame = JSON.parse(serialized); } catch { return super.send(serialized); }
      if (frame?.operation === "isGoalEnabled") {
        this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "response", requestId: frame.requestId, body: { enabled: true } }) });
        return undefined;
      }
      if (frame?.operation === "getGoal") {
        const sessionId = frame.body?.sessionId;
        if (window.__goalHoldSession === sessionId) return undefined;
        const answer = (window.__testGoals ?? {})[sessionId];
        this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "response", requestId: frame.requestId, body: answer }) });
        return undefined;
      }
      return super.send(serialized);
    }
  };
}

const goal = (objective, sessionId) => ({
  sessionId,
  goalId: `g-${sessionId}`,
  objective,
  status: "active",
  tokensUsed: 10,
  turnsUsed: 2,
  timeUsedSeconds: 30,
  updatedAt: 1_700_000_100_000,
});

const bannerText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="thread-goal-banner"]');
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
  });

/** Switch by clicking the rail row, and wait until the app agrees it moved. */
async function openSession(page, sessionId) {
  await page
    .locator(`[data-webui-session-link="${sessionId}"]`)
    .click({ position: { x: 40, y: 16 } });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          document
            .querySelector(`[data-webui-session-link="${id}"]`)
            ?.getAttribute("data-webui-session-active"),
        sessionId,
      ),
    )
    .toBe("true");
}

test("a session switch keeps the retained goal while its re-read is unanswered", async ({ page }) => {
  await configureFixture(page, controlGoalCapability);
  await openApp(page);
  await expect.poll(() => bannerText(page)).toContain("A 的目标");

  // B's goal reaches its record through its own read, which proves the record
  // holds it before the held visit below.
  await openSession(page, "B");
  await expect.poll(() => bannerText(page)).toContain("B 的保留目标");

  await openSession(page, "A");
  await expect.poll(() => bannerText(page)).toContain("A 的目标");

  // Now hold B's re-read and open B again: the banner can only show what B's
  // record retained, and nothing may have cleared it on the way in.
  await page.evaluate(() => {
    window.__goalHoldSession = "B";
  });
  await openSession(page, "B");
  await expect.poll(() => bannerText(page)).toContain("B 的保留目标");
});
