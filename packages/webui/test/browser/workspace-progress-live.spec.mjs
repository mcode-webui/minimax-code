// Live-update coverage for the goal banner and the workspace progress panel.
//
// Every test here pins state that must change WHILE a turn is running. The
// pre-existing suites only ever asserted the state a session opens with, which
// is why goal and todo progress stayed frozen until the page was reloaded.

import { expect } from "@playwright/test";
import { configureFixture, emitAgentMessage, openApp, requestCount, test } from "./harness.mjs";

/** Answer `isGoalEnabled` with `true` and `getGoal` from a value the test
 *  controls, so a goal re-read is observable. */
function controlGoalCapability() {
  const Base = window.WebSocket;
  window.WebSocket = class extends Base {
    send(serialized) {
      let frame;
      try { frame = JSON.parse(serialized); } catch { return super.send(serialized); }
      if (frame?.operation === "isGoalEnabled") {
        window.__fixture.requests.push({ operation: "isGoalEnabled", body: {} });
        this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "response", requestId: frame.requestId, body: { enabled: true } }) });
        return undefined;
      }
      if (frame?.operation === "getGoal") {
        window.__fixture.requests.push({ operation: "getGoal", body: frame.body });
        // The fallback matters: `openApp` performs a real navigation, so a
        // `window.__testGoal` set on the previous document is gone by the time
        // the app boots and issues its first `getGoal`. Without it the boot
        // read answers `undefined`, no goal reaches the store, and the banner
        // never renders -- which is what the production-shape test was seeing,
        // not a defect in the goal update path.
        const seeded = window.__testGoal ?? {
          sessionId: "A", goalId: "g1", objective: "初始目标", status: "active",
          tokensUsed: 1, turnsUsed: 1, timeUsedSeconds: 1, updatedAt: 1,
        };
        this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "response", requestId: frame.requestId, body: seeded }) });
        return undefined;
      }
      return super.send(serialized);
    }
  };
}

const goal = (objective, status) => ({
  sessionId: "A",
  goalId: "g1",
  objective,
  status,
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

const panelText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="progress-overview-card"]');
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
  });

/** Start a turn the way the runtime does, so the client attaches a stream
 *  without going through the composer. */
async function attachLiveTurn(page) {
  await page.evaluate(() => window.__fixture.emitEvent({
    type: "session.start",
    payload: { sessionId: "A", turnId: "live-progress-turn" },
    timestamp: 1_700_000_000_300,
    source: "synthetic",
  }));
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "resumeSession" && request.body.id === "A",
  ))).toBe(true);
}

async function startGoalTurn(page) {
  await configureFixture(page, controlGoalCapability);
  await openApp(page);
  // Seeded after the navigation: `openApp` performs a real `goto`, so a value
  // written to the previous document would not be there when the app boots.
  await page.evaluate(() => {
    window.__testGoal = {
      sessionId: "A", goalId: "g1", objective: "初始目标", status: "active",
      tokensUsed: 1, turnsUsed: 1, timeUsedSeconds: 1, updatedAt: 1,
    };
  });
  await attachLiveTurn(page);
}

test("a goal update in the production payload shape reaches the banner live", async ({ page }) => {
  await startGoalTurn(page);

  // Production shape: `thread_goal.updated` nests the session id inside
  // `goal` instead of declaring it at the payload top level. A top-level-only
  // read made the effect guard drop every update, so the banner kept whatever
  // `getGoal()` returned when the session opened.
  await page.evaluate(
    (next) => window.__fixture.emitEvent({
      type: "thread_goal.updated",
      payload: { goal: next },
      timestamp: 1,
      source: "synthetic",
    }),
    goal("生产形态目标", "complete"),
  );
  await expect.poll(() => bannerText(page)).toContain("已完成");
  await expect.poll(() => bannerText(page)).toContain("生产形态目标");

  // A status change on the same shape must flip the live banner.
  await page.evaluate(
    (next) => window.__fixture.emitEvent({
      type: "thread_goal.updated",
      payload: { goal: next },
      timestamp: 2,
      source: "synthetic",
    }),
    goal("生产形态目标", "active"),
  );
  await expect.poll(() => bannerText(page)).toContain("进行中");
});

test("goal steering re-reads the goal because its payload carries no goal", async ({ page }) => {
  await startGoalTurn(page);

  await page.evaluate(() => {
    window.__testGoal = {
      sessionId: "A", goalId: "g1", objective: "改向后的新目标", status: "active",
      tokensUsed: 5, turnsUsed: 3, timeUsedSeconds: 9, updatedAt: 2,
    };
  });

  // `thread_goal.objective_updated_steering` carries only `{ sessionId, goalId }`
  // and its published name matched no reducer case, so the objective the banner
  // showed never moved. The handler now re-reads the goal instead.
  const goalReadsBefore = await requestCount(page, "getGoal");
  await page.evaluate(() => window.__fixture.emitEvent({
    type: "thread_goal.objective_updated_steering",
    payload: { sessionId: "A", goalId: "g1" },
    timestamp: 3,
    source: "synthetic",
  }));

  await expect.poll(() => bannerText(page)).toContain("改向后的新目标");
  // A delta, not "> 0": the initial load already issues a getGoal, so a bare
  // positive count would pass even if steering never re-read anything.
  expect(await requestCount(page, "getGoal")).toBeGreaterThan(goalReadsBefore);
});

test("an ordinary reply that merely looks like a system event cannot move the panel", async ({ page }) => {
  await openApp(page);
  await attachLiveTurn(page);

  // Establish a real todo so the panel has something to be corrupted from.
  await emitAgentMessage(page, "A", {
    msg_id: "a-real-todo",
    msg_content: JSON.stringify({
      eventType: "todo_updated",
      todos: [{ content: "真实待办", status: "in_progress", priority: "high" }],
    }),
  });
  await expect.poll(() => panelText(page)).toContain("真实待办");

  // Assistant prose that happens to be valid JSON carrying an `eventType` and
  // a todo list. Content is free-form, so a looser "parses and has eventType"
  // rule would let the model rewrite the user's panel by answering.
  await emitAgentMessage(page, "A", {
    msg_id: "a-prose",
    msg_content: "这是示例：\n" + JSON.stringify({
      eventType: "todo_updated",
      todos: [{ content: "注入的假待办", status: "pending", priority: "low" }],
    }),
  });
  await expect(page.getByText("这是示例：")).toBeVisible();
  await page.waitForTimeout(400);

  expect(await panelText(page)).toContain("真实待办");
  expect(await panelText(page)).not.toContain("注入的假待办");
});

test("a subagent spawn embedded in a stream message lands live", async ({ page }) => {
  await openApp(page);
  await attachLiveTurn(page);

  // `session.spawned` also rides in the message rather than on the global bus.
  await emitAgentMessage(page, "A", {
    msg_id: "a-spawn",
    msg_content: JSON.stringify({
      eventType: "session.spawned",
      sessionId: "child-1",
      agentName: "explorer",
      parentSessionId: "A",
      status: "running",
      createdAt: 1_700_000_100_000,
    }),
  });
  await expect.poll(() => page.locator('[data-testid="progress-overview-card"]').textContent(), { timeout: 5000 })
    .toContain("explorer");
});

test("a todo update inside a stream message reaches the progress panel live", async ({ page }) => {
  await openApp(page);
  await attachLiveTurn(page);

  // `todo_updated` is not a global event: the runtime ships it as a system
  // event inside the message. The live reducer used to be handed the whole
  // frame, whose type is `agent_message`, so the panel only ever saw the
  // snapshot built when the session opened.
  await emitAgentMessage(page, "A", {
    msg_id: "a-todo-1",
    thinking_content: "planning",
    msg_content: JSON.stringify({
      eventType: "todo_updated",
      todos: [{ content: "第一步：调研", status: "in_progress", priority: "high" }],
    }),
  });
  await expect.poll(() => panelText(page)).toContain("第一步：调研");
  // One in-progress todo, nothing completed yet: the header summary tracks the
  // live list, not the snapshot from session open.
  await expect.poll(() => panelText(page)).toContain("0/1 已完成 · 0%");

  // A `todowrite` call in the same live turn carries the full list too, in the
  // raw wire shape where the name and arguments sit under `function`.
  await emitAgentMessage(page, "A", {
    msg_id: "a-todo-2",
    tool_calls: [{
      id: "call-1",
      function: {
        name: "todowrite",
        arguments: JSON.stringify({
          todos: [{ content: "第二步：收尾", status: "pending", priority: "low" }],
        }),
      },
    }],
  });
  await expect.poll(() => panelText(page)).toContain("第二步：收尾");
});

test("collapsing Todo releases the overview space and moves Subagents upward", async ({ page }) => {
  await openApp(page);
  await attachLiveTurn(page);
  await emitAgentMessage(page, "A", {
    msg_id: "collapse-layout-todo",
    msg_content: JSON.stringify({
      eventType: "todo_updated",
      todos: [{ content: "可折叠步骤", status: "in_progress" }],
    }),
  });
  await emitAgentMessage(page, "A", {
    msg_id: "collapse-layout-subagent",
    msg_content: JSON.stringify({
      eventType: "session.spawned",
      sessionId: "collapse-layout-child",
      agentName: "layout-worker",
      parentSessionId: "A",
      status: "running",
      createdAt: 1_700_000_100_000,
    }),
  });

  // The Todo section's accessible name carries the completion summary
  // ("进度 0/1 已完成 · 0%"), so match on the title prefix rather than the
  // exact name. The panel toggle control is labelled "环境信息与进度" and does
  // not start with "进度", so the anchored pattern stays unambiguous.
  const todoHeading = page.getByRole("button", { name: /^进度/ });
  await expect(todoHeading).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "layout-worker running" })).toBeVisible();
  const expanded = await page.evaluate(() => {
    const main = document.querySelector(".webui-progress-overview-main");
    const subagents = document.querySelector(".webui-subagents-panel");
    const card = document.querySelector(".webui-progress-overview-card");
    return {
      mainHeight: main.getBoundingClientRect().height,
      subagentsTop: subagents.getBoundingClientRect().top,
      cardHeight: card.getBoundingClientRect().height,
    };
  });

  await todoHeading.click();
  await expect(todoHeading).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.locator(".webui-progress-overview-card").evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(expanded.cardHeight - 20);
  await expect.poll(() => page.locator(".webui-progress-overview-main").evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(expanded.mainHeight - 20);
  await expect.poll(() => page.locator(".webui-subagents-panel").evaluate((element) => element.getBoundingClientRect().top))
    .toBeLessThan(expanded.subagentsTop - 20);
  const collapsed = await page.evaluate(() => {
    const main = document.querySelector(".webui-progress-overview-main");
    const subagents = document.querySelector(".webui-subagents-panel");
    const card = document.querySelector(".webui-progress-overview-card");
    return {
      mainHeight: main.getBoundingClientRect().height,
      subagentsTop: subagents.getBoundingClientRect().top,
      cardHeight: card.getBoundingClientRect().height,
    };
  });
  expect(collapsed.mainHeight).toBeLessThan(expanded.mainHeight - 20);
  expect(collapsed.subagentsTop).toBeLessThan(expanded.subagentsTop - 20);
  expect(collapsed.cardHeight).toBeLessThan(expanded.cardHeight - 20);
});

test("extends a content-heavy progress panel within the viewport and keeps each section visible", async ({ page }) => {
  await configureFixture(page, () => window.__fixture.setResponse("getWorkspaceEnvironment", {
    isGitRepo: true,
    branch: "synthetic-progress-layout",
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    lineStatsStatus: "skipped",
  }));
  await openApp(page);
  await attachLiveTurn(page);
  await emitAgentMessage(page, "A", {
    msg_id: "extended-layout-todos",
    msg_content: JSON.stringify({
      eventType: "todo_updated",
      todos: Array.from({ length: 9 }, (_, index) => ({ content: `长任务步骤 ${index + 1}`, status: "pending" })),
    }),
  });
  for (let index = 0; index < 8; index += 1) {
    await emitAgentMessage(page, "A", {
      msg_id: `extended-layout-subagent-${index}`,
      msg_content: JSON.stringify({
        eventType: "session.spawned",
        sessionId: `extended-layout-child-${index}`,
        agentName: `worker-${index}`,
        parentSessionId: "A",
        status: "running",
        createdAt: 1_700_000_100_000 + index,
      }),
    });
  }
  await expect.poll(() => page.locator(".webui-progress-scroll").textContent()).toContain("长任务步骤 9");
  await expect.poll(() => page.locator(".webui-subagent-row").count()).toBeGreaterThanOrEqual(8);

  const metrics = await page.evaluate(() => {
    const card = document.querySelector(".webui-progress-overview-card");
    const environment = document.querySelector(".webui-environment-panel");
    const progress = document.querySelector(".webui-progress-panel");
    const subagents = document.querySelector(".webui-subagents-panel");
    const progressScroll = document.querySelector(".webui-progress-scroll");
    const subagentsScroll = document.querySelector(".webui-subagents-scroll");
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      card: bounds(card),
      environment: bounds(environment),
      progress: bounds(progress),
      subagents: bounds(subagents),
      progressScrollHeight: progressScroll.scrollHeight,
      progressClientHeight: progressScroll.clientHeight,
      subagentsScrollHeight: subagentsScroll.scrollHeight,
      subagentsClientHeight: subagentsScroll.clientHeight,
      viewportHeight: window.innerHeight,
    };
  });

  expect(metrics.card.height).toBeGreaterThan(400);
  expect(metrics.card.bottom).toBeLessThanOrEqual(metrics.viewportHeight - 12);
  expect(metrics.environment.height).toBeGreaterThan(0);
  expect(metrics.progress.height).toBeGreaterThanOrEqual(58);
  expect(metrics.subagents.height).toBeGreaterThan(28);
  expect(metrics.environment.top).toBeLessThan(metrics.progress.top);
  expect(metrics.progress.top).toBeLessThan(metrics.subagents.top);
  expect(metrics.progressScrollHeight).toBeGreaterThan(metrics.progressClientHeight);
  expect(metrics.subagentsScrollHeight).toBeGreaterThan(metrics.subagentsClientHeight);

  const titleGeometry = await page.locator(".webui-workspace-section-title").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const icon = button.querySelector("svg").getBoundingClientRect();
      return { title: button.textContent.trim(), iconRight: icon.right };
    }),
  );
  const titleIconRightEdges = titleGeometry.map(({ iconRight }) => iconRight);
  expect(Math.max(...titleIconRightEdges) - Math.min(...titleIconRightEdges), JSON.stringify(titleGeometry)).toBeLessThanOrEqual(1);

  const cardHeightBeforeCollapse = metrics.card.height;
  await page.getByRole("button", { name: "Subagents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Subagents", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.locator(".webui-progress-overview-card").evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(cardHeightBeforeCollapse - 20);
  const collapsedSubagentsGap = await page.evaluate(() => {
    const lastTodo = document.querySelector(".webui-progress-row:last-child");
    const subagentsTitle = [...document.querySelectorAll(".webui-workspace-section-title")]
      .find((button) => button.textContent.trim() === "Subagents");
    return subagentsTitle.getBoundingClientRect().top - lastTodo.getBoundingClientRect().bottom;
  });
  expect(collapsedSubagentsGap).toBeLessThanOrEqual(12);
});
