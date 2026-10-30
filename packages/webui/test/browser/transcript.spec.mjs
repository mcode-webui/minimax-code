import { expect } from "@playwright/test";

import { configureFixture, openApp, switchSession, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

test("assistant copy and feedback controls update the selected message", async ({ page }) => {
  await configureFixture(page, () => window.__fixture.setPage("A", {
    messages: [{
      msgId: "assistant-actions-synthetic",
      role: "assistant",
      msgContent: "Synthetic assistant copy payload",
      timestamp: 1_700_000_000_003,
    }],
    hasMore: false,
  }));
  await page.goto("/#session=A");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });

  const actions = page.locator('[data-testid="message-actions"][data-message-id="assistant-actions-synthetic"]');
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "复制" }).click();
  await expect(actions.getByRole("button", { name: "已复制" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Synthetic assistant copy payload",
  );

  const like = actions.getByRole("button", { name: "赞" });
  const dislike = actions.getByRole("button", { name: "踩" });
  await like.click();
  await expect(like).toHaveAttribute("aria-pressed", "true");
  await dislike.click();
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await expect(dislike).toHaveAttribute("aria-pressed", "true");
  await dislike.click();
  await expect(dislike).toHaveAttribute("aria-pressed", "false");
  await expect(like).toHaveAttribute("aria-pressed", "true");
});

test("assistant message fork requests the selected reply and enters the returned session", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [{
        msgId: "assistant-fork-synthetic",
        role: "assistant",
        msgContent: "Synthetic fork source answer",
        actions: { fork: true },
        timestamp: 1_700_000_000_004,
      }],
      hasMore: false,
    });
    window.__fixture.setPage("synthetic-forked-session", {
      messages: [{
        msgId: "forked-assistant-restored",
        role: "assistant",
        msgContent: "Synthetic restored fork transcript",
        timestamp: 1_700_000_000_005,
      }],
      hasMore: false,
    });
    window.__fixture.setResponse("getSessionForkOptions", {
      canFork: true,
      suggestedTitle: "Synthetic fork title",
      nextForkOrdinal: 1,
      sourceTitle: "Synthetic source",
      worktreeVisible: false,
      worktreeEligible: false,
    });
    window.__fixture.setResponse("forkSession", {
      session: {
        sessionId: "synthetic-forked-session",
        agentName: "synthetic-A",
        title: "Synthetic fork title",
        workspaceDir: "/synthetic/workspace",
      },
    });
  });
  await page.goto("/#session=A");

  const actions = page.locator('[data-testid="message-actions"][data-message-id="assistant-fork-synthetic"]');
  await actions.getByRole("button", { name: "复制为新会话" }).click();
  const dialog = page.getByTestId("fork-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("会话名称")).toHaveValue("Synthetic fork title");
  await dialog.getByLabel("会话名称").fill("Forked from selected answer");
  await dialog.getByRole("button", { name: "复制并进入" }).click();

  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "forkSession"))).toHaveLength(1);
  const request = await page.evaluate(() => window.__fixture.requests.find((item) => item.operation === "forkSession"));
  const reply = await page.evaluate(() => window.__fixture.replies.find((item) => item.operation === "forkSession"));
  expect(reply.body.session.sessionId).toBe("synthetic-forked-session");
  expect(request.body).toMatchObject({
    id: "A",
    assistantMessageId: "assistant-fork-synthetic",
    title: "Forked from selected answer",
    useSuggestedTitle: false,
    createIsolatedWorktree: false,
  });
  await expect(page).toHaveURL(/#session=synthetic-forked-session/);
  const forkedTranscript = page.locator('[data-webui-transcript="synthetic-forked-session"]');
  await expect(forkedTranscript).toBeVisible();
  await expect(forkedTranscript.getByText("Synthetic restored fork transcript")).toBeVisible();
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
  const bViewport = page.locator('[data-webui-session-scroll="true"]');
  await bViewport.evaluate((element) => { element.scrollTop = 700; });
  const bScrollTop = await bViewport.evaluate((element) => element.scrollTop);
  await page.evaluate(() => window.__fixture.resolve("getMessages", { id: "A", before: "cursor-A" }, { messages: [{ msgId: "late-A-page", role: "user", msgContent: "Late A page synthetic", timestamp: 1_699_999_999_999 }], hasMore: false }));

  await expect(page.getByText("History B synthetic")).toBeVisible();
  await expect.poll(() => bViewport.evaluate((element) => element.scrollTop)).toBe(bScrollTop);
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
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.replace(/^#/u, "")).get("session"))).toBe("created-C");
  await expect(page.getByText("思考中…")).toBeVisible();
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

test("New Task fences a pending home creation without stealing the new draft or navigation", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setModels([{
      providerId: "fixture-provider",
      providerName: "Fixture Provider",
      modelId: "fixture-model",
      displayName: "Fixture Model",
    }]);
    window.__fixture.delayNext("createSession", { name: "main" });
  });
  await openApp(page, "");
  await page.locator(".webui-brand-create-button").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  const input = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await input.fill("Pending home submission");
  await expect(page.getByRole("button", { name: "发送" })).toBeEnabled();
  await page.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.some(
    (request) => request.operation === "createSession" && request.body.name === "main",
  ))).toBe(true);

  await page.locator(".webui-brand-create-button").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await input.fill("Draft for the replacement home");

  await page.evaluate(() => window.__fixture.resolve("createSession", { name: "main" }, { sessionId: "late-created" }));
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "sendMessage" && request.body.id === "late-created",
  ))).toBe(true);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect(input).toHaveValue("Draft for the replacement home");
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

test("a session switch reads the page once per need, not once per reader", async ({ page }) => {
  // The composer used to load the page itself, only to read `contextSnapshot`
  // from it: with the transcript's own read and the workspace history progress
  // read, a switch cost three `getMessages` for one session. Context inspection
  // now joins the transcript history owner's keyed read (plan §4.5).
  //
  // The count is settled before it is asserted: a poll for "at most two" is
  // satisfied by zero reads, which is how an earlier version of this case passed
  // with the composer's read still in place. What this case holds is the settled
  // count — a switch reads the page twice, and a third reader would fail it. That
  // the composer's own read is gone is proven at the unit seam instead
  // (`transcript-fences.test.ts`: the inspection answers from the cached page and
  // reads nothing), because in this fixture the composer's read never fires.
  await configureFixture(page, () => undefined);
  await openApp(page);

  await switchSession(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();

  const reads = () =>
    page.evaluate(() =>
      window.__fixture.requests.filter(
        (request) => request.operation === "getMessages" && request.body?.id === "B",
      ).length,
    );
  // ONE read for the page, shared by every reader that needs it: the transcript,
  // the composer's context inspection and the workspace history progress all
  // reach it through the history owner's keyed resource. The join is why the count
  // did not grow when the context read started going through the owner, and a
  // reader that stopped joining (or a new one that issues its own request) makes
  // this 2.
  await expect.poll(reads).toBe(1);
  // Settled: nothing else may read the same page afterwards.
  await page.waitForTimeout(400);
  expect(await reads()).toBe(1);
});

/* Mermaid fences in the transcript, against the real library.
 *
 * The unit suite mocks `mermaid` (the Node environment has no DOM for it), so
 * this is where the library actually runs: the diagram renders to SVG, the
 * chunk loads on demand, and the failure path falls back to the plain fence.
 * The theme case matters because Mermaid bakes its palette into the SVG — a
 * diagram drawn with the light palette is a light diagram even on a dark
 * page, so the renderer has to follow the app's theme. */
const MERMAID_DIAGRAM = "graph TD;\n  A[开始] --> B[结束];";

async function stageTranscript(page, messages) {
  // `addInitScript` with an argument, not `configureFixture`: the fixture
  // setup is serialized with `toString()`, so it cannot close over the
  // messages.
  await page.addInitScript((value) => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => window.__fixture.setPage("A", { messages: value, hasMore: false }));
  }, messages);
}

test("a mermaid fence renders as a diagram, not as text", async ({ page }) => {
  await stageTranscript(page, [
    { msgId: "m-1", role: "assistant", msgContent: "```mermaid\n" + MERMAID_DIAGRAM + "\n```", timestamp: 1_700_000_000_001 },
  ]);
  await openApp(page, "#session=A");

  // The real library, in a real browser: the fence becomes an SVG.
  const diagram = page.locator(".webui-mermaid svg");
  await expect(diagram).toBeVisible({ timeout: 20_000 });
  // …and the diagram is the fence's own content, not the source text.
  await expect(page.locator(".webui-mermaid pre")).toHaveCount(0);
  await expect(diagram.locator("text").first()).toContainText("开始");
});

test("an invalid diagram falls back to the plain fence", async ({ page }) => {
  await stageTranscript(page, [
    { msgId: "m-2", role: "assistant", msgContent: "```mermaid\nthis is not a diagram at all {{{\n```", timestamp: 1_700_000_000_001 },
  ]);
  await openApp(page, "#session=A");

  // The failure path: no SVG, and the original text back in a plain fence —
  // the markup the fence had before Mermaid existed.
  await expect(page.locator(".webui-mermaid svg")).toHaveCount(0);
  const fallback = page.locator(".webui-code-block code");
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("this is not a diagram at all");
});

test("a diagram follows the app's theme", async ({ page }) => {
  await stageTranscript(page, [
    { msgId: "m-3", role: "assistant", msgContent: "```mermaid\n" + MERMAID_DIAGRAM + "\n```", timestamp: 1_700_000_000_001 },
  ]);
  await openApp(page, "#session=A");
  await expect(page.locator(".webui-mermaid svg")).toBeVisible({ timeout: 20_000 });

  // Mermaid bakes its palette into the SVG it returns, so a diagram drawn
  // with the light palette is a light diagram even on a dark page. The
  // comparison is between two runs rather than against a literal colour, so
  // it survives a palette change in the library.
  const readPalette = () =>
    page.locator(".webui-mermaid svg").evaluate((node) => node.querySelector("style")?.textContent ?? "");
  const lightPalette = await readPalette();

  // The app's own preference — not a hand-set class: the app applies the
  // stored theme to `<html>` at boot, and the renderer reads that class when
  // it draws.
  await page.addInitScript(() => {
    window.localStorage.setItem("webui-theme", "dark");
  });
  await page.reload();
  await expect(page.locator(".webui-mermaid svg")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);

  expect(await readPalette()).not.toBe(lightPalette);
});

test("a drawn diagram repaints when the theme switches, without a reload", async ({ page }) => {
  await stageTranscript(page, [
    { msgId: "m-6", role: "assistant", msgContent: "```mermaid\n" + MERMAID_DIAGRAM + "\n```", timestamp: 1_700_000_000_001 },
  ]);
  await openApp(page, "#session=A");
  await expect(page.locator(".webui-mermaid svg")).toBeVisible({ timeout: 20_000 });
  const readPalette = () =>
    page.locator(".webui-mermaid svg").evaluate((node) => node.querySelector("style")?.textContent ?? "");
  const lightPalette = await readPalette();

  // No reload happens anywhere below this marker — a reload would wipe it, so
  // reading it back at the end is the proof that the repaint came from the
  // renderer hearing the theme change, not from the page coming back.
  await page.evaluate(() => {
    window.__webuiNoReloadWitness = true;
  });

  // The app's own control, driven the way a user drives it (the same flow
  // `settings-theme.spec.mjs` uses): user menu, 设置, 深色模式. That click
  // flips the `dark` class on `<html>`, and the diagram must redraw — the
  // palette is baked into the SVG, so a theme switch that does not redraw
  // leaves a light diagram sitting on a dark page until the next navigation.
  // This is the path the reload-based case above cannot see.
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(page.locator('[role="dialog"][aria-label="设置"]')).toBeVisible();
  await page.locator('[data-testid="mavis-settings-appearance-row"] .mavis-settings-theme-option', { hasText: "深色模式" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await expect
    .poll(async () => readPalette(), { timeout: 20_000 })
    .not.toBe(lightPalette);
  expect(await page.evaluate(() => window.__webuiNoReloadWitness)).toBe(true);
  // The repaint produced a rendered diagram again — not a fallback.
  await expect(page.locator(".webui-mermaid svg")).toBeVisible();
  await expect(page.locator(".webui-code-block")).toHaveCount(0);
});

test("a wide diagram fits its container", async ({ page }) => {
  // A wide diagram must not push the transcript sideways: the SVG scales with
  // the container (`max-width: 100%`, `height: auto`).
  await stageTranscript(page, [
    {
      msgId: "m-4",
      role: "assistant",
      msgContent: "```mermaid\ngraph LR;\n" + Array.from({ length: 12 }, (_, index) => `  N${index}[节点${index}]`).join("\n") + ";\n```",
      timestamp: 1_700_000_000_001,
    },
  ]);
  await openApp(page, "#session=A");
  const diagram = page.locator(".webui-mermaid svg");
  await expect(diagram).toBeVisible({ timeout: 20_000 });
  const sizes = await diagram.evaluate((node) => ({
    svg: node.getBoundingClientRect().width,
    container: node.parentElement?.getBoundingClientRect().width ?? 0,
  }));
  expect(sizes.svg).toBeLessThanOrEqual(sizes.container + 1);
});

test("a half-streamed fence falls back instead of breaking the transcript", async ({ page }) => {
  // A fence that has not finished arriving (the model is still streaming) is
  // an incomplete code block: the diagram cannot render, and the fence must
  // fall back to the plain source rather than leave the transcript broken.
  await stageTranscript(page, [
    { msgId: "m-5", role: "assistant", msgContent: "```mermaid\ngraph TD;\n  A[开始] --> B[结", timestamp: 1_700_000_000_001 },
  ]);
  await openApp(page, "#session=A");

  await expect(page.locator(".webui-mermaid svg")).toHaveCount(0);
  await expect(page.locator(".webui-code-block code")).toBeVisible();
  // The transcript is still alive: the rest of the message is on screen.
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
});
