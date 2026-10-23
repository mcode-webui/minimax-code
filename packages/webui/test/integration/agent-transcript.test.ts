// End-to-end transcript recovery through the built browser client, loopback
// service, production runtime host, session store and a controlled model server.
// The model endpoint is the only controlled edge; messages are created by a real
// UI send and flow through the runtime instead of being injected as demo frames.
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { expect, it } from "vitest";
import type { WebuiBrowserAdapterBinding } from "../../src/runtime/harness/browser.js";

const MODEL_ID = "stub-model";
const PROVIDER_NAME = "stub";
const PROVIDER_ID = `custom_provider:${PROVIDER_NAME}`;

/**
 * The deadline for a wait whose completion depends on the browser client
 * booting and rendering the page, not on the runtime's own work.
 *
 * The client boots by asking the host for its version and rendering the shell
 * when the answer arrives, and that request carries the wire's own 30s
 * deadline (`DEFAULT_REQUEST_TIMEOUT_MS` in `platform/wire.ts`): past it the
 * client renders the startup fallback instead of the shell, so no shell can
 * arrive later than this. The deadline is therefore the product's own
 * tolerance — a case that waits to it and still sees no composer has learned
 * that the client did not boot, which is the product's failure to report and
 * not this gate's to paper over.
 *
 * The default 5s is shorter than that on a loaded runner. The macOS CI run of
 * the whole 213-file webui group measured this file's case at 26.7s with the
 * shell still not up when the default deadline expired, against 12.0s for the
 * same case on ubuntu; the group itself measured 160.9s on macOS against
 * 76.9s on ubuntu. 30s is also the budget the sibling real-browser gates in
 * this directory already give (`browser-panel-live-navigation.test.ts`,
 * `workspace-browser-tab-acceptance.test.ts`), and it leaves this case's own
 * 120s budget enough for the rest of the case: about 21.6s of setup ran
 * before this wait on that macOS run and the rest of the case needs about 25s
 * at the same ratio, so a wait that runs to its deadline still ends the case
 * around 77s — the budget is never the thing that catches the failure.
 */
const FIRST_SCREEN_TIMEOUT_MS = 30_000;

function frame(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-agent-transcript",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function isWorkspaceChangedEvent(event: unknown, workspaceDir: string): boolean {
  if (!event || typeof event !== "object") return false;
  const candidate = event as { type?: unknown; payload?: { workspace?: unknown; aliases?: unknown } };
  if (candidate.type !== "workspace.git.changed") return false;
  // The Runtime owns the canonical realpath and reports the caller's own
  // spelling alongside it as an alias. On macOS the two differ (`/var` is a
  // symlink to `/private/var`), so the event names this workspace either by
  // its canonical path or by one of its aliases.
  if (candidate.payload?.workspace === workspaceDir) return true;
  const aliases = candidate.payload?.aliases;
  return Array.isArray(aliases) && aliases.includes(workspaceDir);
}

async function waitForSignal(signal: Promise<void>, label: string, timeoutMs = 20_000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * The browser this case drives.
 *
 * This file belongs to the `test:webui` Vitest gate, which runs before the
 * `test:webui-browser` gate installs playwright's own chromium — so on CI the
 * pinned browser is not on disk yet. The runner's own Chrome is, and playwright
 * drives it through the `chrome` channel. A launch that fails for any other
 * reason is the failure it looks like, and is not retried.
 */
async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const missingBrowser = error instanceof Error && error.message.includes("Executable doesn't exist");
    if (!missingBrowser) throw error;
    return await chromium.launch({ headless: true, channel: "chrome" });
  }
}

it("a real agent turn resumes after refresh and drains a queued message in order", async () => {
  let releaseAnswer: () => void = () => undefined;
  const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  let releaseTodoAnswer: () => void = () => undefined;
  const todoAnswerGate = new Promise<void>((resolve) => { releaseTodoAnswer = resolve; });
  let releaseStoppedAnswer: () => void = () => undefined;
  const stoppedAnswerGate = new Promise<void>((resolve) => { releaseStoppedAnswer = resolve; });
  let stopResponseStarted: () => void = () => undefined;
  const stopResponseStartedGate = new Promise<void>((resolve) => { stopResponseStarted = resolve; });
  let todoContinuationReached = false;
  let reasoningSent: () => void = () => undefined;
  const reasoningGate = new Promise<void>((resolve) => { reasoningSent = resolve; });
  let queuedTurnStarted: () => void = () => undefined;
  const queuedTurnGate = new Promise<void>((resolve) => { queuedTurnStarted = resolve; });
  let retryModelAttempts = 0;
  let allowModelRetryRecovery = false;
  const modelRequests: { url: string | undefined; authorization: string | undefined; body: string }[] = [];
  const modelServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString("utf8"); });
    request.on("end", async () => {
      modelRequests.push({ url: request.url, authorization: request.headers.authorization, body });
      const parsed = JSON.parse(body) as { messages?: { role?: string; content?: unknown; toolCallId?: string; tool_call_id?: string }[] };
      const latestUserMessage = [...(parsed.messages ?? [])].reverse().find((message) => message.role === "user");
      const latestUserContent = JSON.stringify(latestUserMessage?.content ?? "");
      const serializedMessages = JSON.stringify(parsed.messages ?? []);
      if (latestUserContent.includes("Retry this synthetic turn after a model failure.")) {
        retryModelAttempts += 1;
        if (!allowModelRetryRecovery) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic model refusal for retry journey." } }));
          return;
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let completedWithToolCall = false;
      if (latestUserContent.includes("Message actions before refresh.")) {
        response.write(frame({ role: "assistant", content: "Unrefreshed action probe response." }));
      } else if (latestUserContent.includes("Persisted source action probe.")) {
        response.write(frame({ role: "assistant", content: "Persisted source action response." }));
      } else if (latestUserContent.includes("Summarize the referenced project file.")) {
        response.write(frame({ role: "assistant", content: "Reference and attachment reached the runtime." }));
      } else if (serializedMessages.includes("Ask User continuation.")) {
        const askUserCompleted = serializedMessages.includes("call-ask-user-e2e");
        if (askUserCompleted) {
          response.write(frame({ role: "assistant", content: "Same turn continued from the user's answer." }));
        } else {
          completedWithToolCall = true;
          response.write(frame({
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call-ask-user-e2e",
              type: "function",
              function: {
                name: "ask_user",
                arguments: JSON.stringify({
                  mode: "questionnaire",
                  title: "Choose a synthetic direction",
                  steps: [{
                    id: "direction",
                    question: "Which direction should this same turn use?",
                    options: [
                      { id: "scope-current", label: "Keep the current scope" },
                      { id: "scope-expanded", label: "Expand the scope" },
                    ],
                    selectionMode: "single",
                  }],
                }),
              },
            }],
          }, "tool_calls"));
        }
      } else if (latestUserContent.includes("Send this after the active answer.")) {
        queuedTurnStarted();
        response.write(frame({ role: "assistant", content: "Queued follow-up delivered." }));
      } else if (latestUserContent.includes("Plan this synthetic task.")) {
        response.write(frame({ role: "assistant", content: "Synthetic plan-entry turn completed." }));
      } else if (latestUserContent.includes("Fork isolation probe edited.")) {
        response.write(frame({ role: "assistant", content: "Edited fork message response." }));
      } else if (latestUserContent.includes("Fork isolation probe.")) {
        response.write(frame({ role: "assistant", content: "Fork-only response." }));
      } else if (latestUserContent.includes("Edited synthetic plan task.")) {
        response.write(frame({ role: "assistant", content: "Edited user message produced a fresh response." }));
      } else if (serializedMessages.includes("Keep this synthetic goal active.")) {
        response.write(frame({ role: "assistant", content: "Synthetic goal progress acknowledged." }));
      } else if (latestUserContent.includes("Stop this turn, then recover.")) {
        completedWithToolCall = true;
        response.write(frame({ role: "assistant", reasoning_content: "Cancelable local response is active." }));
        stopResponseStarted();
        await stoppedAnswerGate;
        if (!response.destroyed && !response.writableEnded)
          response.write(frame({ content: "Canceled response must not be rendered." }));
      } else if (latestUserContent.includes("Continue after stopping the prior turn.")) {
        response.write(frame({ role: "assistant", content: "The session recovered after stop." }));
      } else if (latestUserContent.includes("Retry this synthetic turn after a model failure.")) {
        response.write(frame({ role: "assistant", content: "The same turn recovered after retry." }));
      } else if (latestUserContent.includes("Write a synthetic workspace change.")) {
        const writeCompleted = parsed.messages?.some((message) =>
          message.role === "tool" &&
          (message.toolCallId === "call-write-workspace-e2e" || message.tool_call_id === "call-write-workspace-e2e"),
        ) === true;
        if (writeCompleted) {
          response.write(frame({ role: "assistant", content: "The workspace file was written by the runtime." }));
        } else {
          completedWithToolCall = true;
          response.write(frame({
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call-write-workspace-e2e",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "runtime-panel-change.txt",
                  content: "Created through the real local Agent write tool.\n",
                }),
              },
            }],
          }, "tool_calls"));
        }
      } else if (latestUserContent.includes("Create a task checklist.")) {
        const hasToolResult = parsed.messages?.some((message) => message.role === "tool") === true;
        if (hasToolResult) {
          todoContinuationReached = true;
          await todoAnswerGate;
          response.write(frame({ role: "assistant", content: "The runtime checklist is ready." }));
        } else {
          completedWithToolCall = true;
          response.write(frame({
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call-todowrite-e2e",
              type: "function",
              function: {
                name: "todowrite",
                arguments: JSON.stringify({ todos: [
                  { content: "Visible task from runtime tool", status: "in_progress", priority: "high" },
                ] }),
              },
            }],
          }, "tool_calls"));
        }
      } else if (latestUserContent.includes("Please reason, then answer.")) {
        response.write(frame({ role: "assistant", reasoning_content: "Reasoning before refresh." }));
        reasoningSent();
        await answerGate;
        response.write(frame({ content: "Final answer after refresh." }));
      } else {
        response.write(frame({ role: "assistant", content: "Unexpected request body." }));
      }
      if (!completedWithToolCall) response.write(frame({}, "stop"));
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => { modelServer.listen(0, "127.0.0.1", () => resolve()); });
  const modelAddress = modelServer.address();
  if (!modelAddress || typeof modelAddress === "string") throw new Error("model stub did not bind");

  const dataDir = await mkdtemp(path.join(tmpdir(), "webui-agent-transcript-e2e-"));
  const previousDataDir = process.env.MINIMAX_DATA_DIR;
  const workspaceDir = path.join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "reference-target.md"), "Synthetic workspace reference body.\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", workspaceDir]);
  execFileSync("git", ["config", "user.name", "WebUI integration"], { cwd: workspaceDir });
  execFileSync("git", ["config", "user.email", "webui-integration@example.invalid"], { cwd: workspaceDir });
  execFileSync("git", ["add", "reference-target.md"], { cwd: workspaceDir });
  execFileSync("git", ["commit", "--quiet", "-m", "synthetic workspace baseline"], { cwd: workspaceDir });
  await writeFile(path.join(dataDir, "config.yaml"), [
    `defaultModel: ${PROVIDER_ID}/${MODEL_ID}`,
    "permissionMode: acceptEdits",
    "custom_provider:",
    `  ${PROVIDER_NAME}:`,
    "    name: Transcript E2E Stub",
    "    api: openai-completions",
    "    options:",
    `      baseURL: http://127.0.0.1:${modelAddress.port}/v1`,
    "      apiKey: e2e-stub-key",
    "    models:",
    `      ${MODEL_ID}:`,
    `        id: ${MODEL_ID}`,
    "        name: Transcript E2E Model",
    "        tool_call: true",
    "        reasoning: true",
    "        interleaved: { field: reasoning_content }",
    "        limit:",
    "          context: 100000",
    "          output: 4096",
    "        modalities:",
    "          input: [text]",
    "          output: [text]",
    "",
  ].join("\n"), { mode: 0o600 });

  let assembled;
  let service;
  let browser;
  let browserAdapter: WebuiBrowserAdapterBinding | undefined;
  let pageServer: Server | undefined;
  const browserReportedValues: string[] = [];
  const runtimeEvents: unknown[] = [];
  let runtimeEventAbort: AbortController | undefined;
  try {
    process.env.MINIMAX_DATA_DIR = dataDir;
    (await import("@mavis/config")).resetConfig();
    const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
    const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");
    const { createBrowserAdapter } = await import("../../src/runtime/harness/browser.js");
    const { WebuiTerminalManager } = await import("../../src/runtime/index.js");
    const { WebuiService, createOperationRegistry } = await import("../../src/server/index.js");
    pageServer = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/report") {
        browserReportedValues.push(requestUrl.searchParams.get("value") ?? "");
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>todo-browser-idle</title><style>body{margin:0}input{position:absolute;left:48px;top:64px;width:320px;height:48px;font:20px sans-serif}</style><input id="field" aria-label="Synthetic browser input"><script>document.querySelector('#field').addEventListener('input',event=>{fetch('/report?value='+encodeURIComponent(event.target.value))})</script>`);
    });
    await new Promise<void>((resolve, reject) => {
      pageServer!.once("error", reject);
      pageServer!.listen(0, "127.0.0.1", resolve);
    });
    const pageAddress = pageServer.address();
    if (!pageAddress || typeof pageAddress === "string") throw new Error("browser page server did not bind");
    const testBrowserAdapter = createBrowserAdapter({ dataDir: path.join(dataDir, "browser") });
    browserAdapter = testBrowserAdapter;
    assembled = await createWebuiRuntimeHost({
      dataDir,
      appVersion: "agent-transcript-e2e",
      browserProvider: { adapter: testBrowserAdapter.toolAdapter, close: () => testBrowserAdapter.close() },
      mcodeTools: { prepare: async () => ({
        requested: false,
        ready: false,
        category: "disabled",
        ensureCommandPath: () => undefined,
        dispose: async () => undefined,
      }) },
    });
    testBrowserAdapter.attachHost(assembled.host);
    await testBrowserAdapter.initialize();
    if (!testBrowserAdapter.port) throw new Error("runtime host did not expose its browser operations");
    await testBrowserAdapter.port.setAuthorization({ isolatedChromium: true });
    const port = createHarnessPortFromHost(assembled.host);
    const created = await port.createSession({ name: "main", workspaceDir });
    const sessionId = created.session?.sessionId;
    if (!sessionId) throw new Error("runtime host did not create the test session");
    const terminal = new WebuiTerminalManager();
    service = new WebuiService({
      port,
      operations: createOperationRegistry(port, terminal, testBrowserAdapter.port),
      terminal,
      tcpPort: 0,
      credential: { token: "agent-transcript-e2e-token" },
      dev: true,
      clientDir: path.resolve("dist-webui/client"),
    });
    const info = await service.start();

    browser = await launchBrowser();
    const page = await browser.newPage({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await page.addInitScript(() => {
      const testWindow = window as Window & { __webuiTestEventSocket?: WebSocket };
      const nativeSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          try {
            if ((JSON.parse(data) as { operation?: unknown }).operation === "watchEvents")
              testWindow.__webuiTestEventSocket = this;
          } catch { /* Ignore non-JSON socket frames. */ }
        }
        return nativeSend.call(this, data);
      };
    });
    const requests: {
      requestId?: string;
      operation?: string;
      kind?: string;
      body?: Record<string, unknown>;
    }[] = [];
    const received: { requestId?: string; kind?: string; body?: unknown }[] = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        try {
          const request = JSON.parse(String(payload)) as {
            requestId?: string;
            operation?: string;
            kind?: string;
            body?: Record<string, unknown>;
          };
          if (request.kind === "request") requests.push(request);
        } catch { /* Ignore protocol frames that are not JSON requests. */ }
      });
      socket.on("framereceived", ({ payload }) => {
        try {
          const response = JSON.parse(String(payload)) as {
            requestId?: string;
            kind?: string;
            body?: unknown;
          };
          received.push(response);
        } catch { /* Ignore protocol frames that are not JSON responses. */ }
      });
    });
    const url = `http://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}#session=${sessionId}`;
    await page.goto(url);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(url).origin,
    });
    await browserExpect(page.locator("#webui-root")).toBeVisible();
    // The event channel opens as the client boots, so this wait is bounded by
    // the boot budget the file already documents — not by the default 5s, which
    // a loaded runner can pass without the client having started at all.
    await browserExpect.poll(() => requests.some((request) => request.operation === "watchEvents"),
      { timeout: FIRST_SCREEN_TIMEOUT_MS })
      .toBe(true);
    const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
    // The composer's own send button.
    //
    // `getByRole("button", { name: "发送" })` matches by substring, so it also
    // matches the inline message editor's 发送 button and the plan card's 发送
    // button. While a turn is live the composer shows 停止 instead of 发送, so
    // the role query can land on one of those other buttons and the message is
    // never dispatched at all. The composer marks its own button, and that
    // button is in the document exactly while the composer is ready to send,
    // so clicking it waits for the composer to settle instead of racing it.
    const sendComposerMessage = async (message: string): Promise<void> => {
      await composer.fill(message);
      await page.locator("[data-webui-composer-submit]").click();
    };
    // Wait for the product handshake deadline; a visible mount node alone does not prove React booted.
    await browserExpect(composer).toBeVisible({ timeout: FIRST_SCREEN_TIMEOUT_MS });

    // Exercise the latest user-message controls on a newly opened session,
    // before this page has ever been refreshed. Both actions are canceled so
    // the probe does not mutate the transcript used by the remaining journey.
    await sendComposerMessage("Message actions before refresh.");
    await browserExpect(page.getByText("Unrefreshed action probe response.")).toBeVisible({ timeout: 30_000 });
    await browserExpect.poll(() => port.getActiveTurn({ id: sessionId })).toBeUndefined();
    await expect.poll(async () => JSON.stringify((await port.getMessages({ id: sessionId })).messages ?? []))
      .toContain("Message actions before refresh.");
    const unrefreshedUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Message actions before refresh." });
    await browserExpect(unrefreshedUserMessage).toBeVisible();
    await unrefreshedUserMessage.hover();
    const unrefreshedActions = unrefreshedUserMessage.getByTestId("user-message-actions");
    await browserExpect(unrefreshedActions.getByRole("button", { name: "回退" })).toBeVisible();
    const unrefreshedMessageId = await unrefreshedUserMessage.getAttribute("data-message-id");
    expect(unrefreshedMessageId).toEqual(expect.any(String));
    await unrefreshedActions.getByRole("button", { name: "回退" }).click();
    const unrefreshedRewindDialog = page.getByTestId("rewind-preview-dialog");
    await browserExpect(unrefreshedRewindDialog).toBeVisible();
    await browserExpect.poll(() => requests.some((request) =>
      request.operation === "getSessionRewindPreview" && request.body?.id === sessionId &&
      request.body?.userMessageId === unrefreshedMessageId,
    )).toBe(true);
    const unrefreshedRewindRequest = requests.find((request) =>
      request.operation === "getSessionRewindPreview" && request.body?.id === sessionId &&
      request.body?.userMessageId === unrefreshedMessageId,
    );
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === unrefreshedRewindRequest?.requestId && response.kind === "response",
    )).toBe(true);
    await unrefreshedRewindDialog.getByRole("button", { name: "取消" }).click();
    await browserExpect(unrefreshedRewindDialog).toHaveCount(0);
    await browserExpect(unrefreshedUserMessage).toBeVisible();

    await unrefreshedActions.getByRole("button", { name: "编辑" }).click();
    const unrefreshedEditor = unrefreshedUserMessage.getByTestId("user-message-inline-editor");
    await browserExpect(unrefreshedEditor).toBeVisible();
    await browserExpect(unrefreshedEditor.getByRole("textbox", { name: "编辑" }))
      .toHaveValue("Message actions before refresh.");
    await unrefreshedEditor.getByRole("button", { name: "取消" }).click();
    await browserExpect(unrefreshedEditor).toHaveCount(0);

    // Keep the session and page mounted for a second completed turn, then use
    // the rewind action on that persisted row. Confirm the mutation and prove
    // both the mounted transcript and stored history update without navigation
    // or refresh.
    await composer.fill("Persisted source action probe.");
    await composer.press("Enter");
    await browserExpect(page.getByText("Persisted source action response."))
      .toBeVisible({ timeout: 30_000 });
    await browserExpect.poll(() => port.getActiveTurn({ id: sessionId })).toBeUndefined();
    const persistedSourceUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Persisted source action probe." });
    const persistedSourceUserMessageId = await persistedSourceUserMessage.getAttribute("data-message-id");
    expect(persistedSourceUserMessageId).toEqual(expect.any(String));
    await expect.poll(async () => JSON.stringify((await port.getMessages({ id: sessionId })).messages ?? []))
      .toContain("Persisted source action probe.");
    await browserExpect(persistedSourceUserMessage).toBeVisible();
    await persistedSourceUserMessage.hover();
    const persistedSourceActions = persistedSourceUserMessage.getByTestId("user-message-actions");
    await browserExpect(persistedSourceActions.getByRole("button", { name: "回退" })).toBeVisible();
    await persistedSourceActions.getByRole("button", { name: "回退" }).click();
    const persistedSourceRewindDialog = page.getByTestId("rewind-preview-dialog");
    await browserExpect(persistedSourceRewindDialog).toBeVisible();
    const rewindGeometry = await persistedSourceRewindDialog.evaluate((node) => {
      const viewportWidth = document.body.clientWidth;
      const viewportHeight = document.body.clientHeight;
      const dialog = node.getBoundingClientRect();
      const surface = node.querySelector(".webui-message-dialog-surface")!.getBoundingClientRect();
      const buttons = [...node.querySelectorAll<HTMLButtonElement>(".webui-message-dialog-actions button")];
      return {
        fixedBackdrop: getComputedStyle(node).position === "fixed",
        backdropCoversViewport: dialog.left <= 0 && dialog.top <= 0 &&
          dialog.right >= viewportWidth && dialog.bottom >= viewportHeight,
        centered: Math.abs(surface.left + surface.width / 2 - viewportWidth / 2) < 3 &&
          Math.abs(surface.top + surface.height / 2 - viewportHeight / 2) < 3,
        surfaceWithinViewport: surface.left >= 0 && surface.top >= 0 &&
          surface.right <= viewportWidth && surface.bottom <= viewportHeight,
        actionsReachable: buttons.length >= 2 && buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= viewportWidth &&
            rect.top >= 0 && rect.bottom <= viewportHeight && !button.disabled;
        }),
        portalClientBox: { width: viewportWidth, height: viewportHeight },
        backdropRect: { left: dialog.left, top: dialog.top, right: dialog.right, bottom: dialog.bottom },
        surfaceRect: { left: surface.left, top: surface.top, right: surface.right, bottom: surface.bottom },
        grid: { display: getComputedStyle(node).display, placeItems: getComputedStyle(node).placeItems },
      };
    });
    expect(rewindGeometry, JSON.stringify(rewindGeometry)).toMatchObject({
      fixedBackdrop: true,
      backdropCoversViewport: true,
      centered: true,
      surfaceWithinViewport: true,
      actionsReachable: true,
    });
    await browserExpect.poll(() => requests.some((request) =>
      request.operation === "getSessionRewindPreview" && request.body?.id === sessionId &&
      request.body?.userMessageId === persistedSourceUserMessageId,
    )).toBe(true);
    const persistedRewindRequest = requests.find((request) =>
      request.operation === "getSessionRewindPreview" && request.body?.id === sessionId &&
      request.body?.userMessageId === persistedSourceUserMessageId,
    );
    expect(persistedRewindRequest).toBeDefined();
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === persistedRewindRequest?.requestId && response.kind === "response",
    )).toBe(true);
    const sourceRouteBeforeRewind = await page.evaluate(() => location.hash);
    const beforeRewindRequestCount = requests.filter((request) => request.operation === "rewindSession").length;
    const beforeRewindHistoryReadCount = requests.filter((request) =>
      request.operation === "getMessages" && request.body?.id === sessionId,
    ).length;
    await persistedSourceRewindDialog.getByRole("button", { name: "仅回退对话" }).click();
    await browserExpect(persistedSourceRewindDialog).toHaveCount(0);
    await browserExpect.poll(() => requests.filter((request) => request.operation === "rewindSession").length)
      .toBe(beforeRewindRequestCount + 1);
    const sourceRewindRequest = requests.filter((request) => request.operation === "rewindSession").at(-1);
    expect(sourceRewindRequest?.body).toMatchObject({
      id: sessionId,
      userMessageId: persistedSourceUserMessageId,
      rewindTurnDiff: false,
    });
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === sourceRewindRequest?.requestId && response.kind === "response",
    )).toBe(true);
    const sourceRewindResponse = received.find((response) => response.requestId === sourceRewindRequest?.requestId);
    expect(sourceRewindResponse?.body).toMatchObject({ rewound: true });
    await browserExpect.poll(() => requests.filter((request) =>
      request.operation === "getMessages" && request.body?.id === sessionId,
    ).length).toBeGreaterThan(beforeRewindHistoryReadCount);
    await browserExpect.poll(async () => JSON.stringify((await port.getMessages({ id: sessionId })).messages ?? []))
      .not.toContain("Persisted source action probe.");
    const refreshMessagesRequest = requests.filter((request) =>
      request.operation === "getMessages" && request.body?.id === sessionId,
    ).at(-1);
    const refreshMessagesResponse = received.find((response) => response.requestId === refreshMessagesRequest?.requestId);
    const refreshMessages = (refreshMessagesResponse?.body as {
      messages?: { msgId?: string; role?: string; msgContent?: string }[];
    } | undefined)?.messages;
    expect(refreshMessages?.some((message) => message.msgId === persistedSourceUserMessageId)).toBe(false);
    expect(await persistedSourceUserMessage.count(), JSON.stringify({
      refreshMessagesRequest: refreshMessagesRequest && {
        requestId: refreshMessagesRequest.requestId,
        operation: refreshMessagesRequest.operation,
        body: refreshMessagesRequest.body,
      },
      refreshMessages: refreshMessages?.map((message) => ({
        id: message.msgId,
        role: message.role,
        content: message.msgContent,
      })),
      visibleMessageIds: await page.locator("[data-webui-message-role]").evaluateAll((nodes) =>
        nodes.map((node) => ({
          role: node.getAttribute("data-webui-message-role"),
          id: node.getAttribute("data-message-id"),
          text: node.textContent,
        })),
      ),
    })).toBe(0);
    const mountedTranscript = page.locator(`[data-webui-transcript="${sessionId}"]`);
    await browserExpect(mountedTranscript.getByText("Message actions before refresh.", { exact: true }))
      .toBeVisible();
    await browserExpect(mountedTranscript.getByText("Unrefreshed action probe response.", { exact: true }))
      .toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe(sourceRouteBeforeRewind);
    await browserExpect(page.locator(`[data-webui-session-link="${sessionId}"]`))
      .toHaveAttribute("data-webui-session-active", "true");

    // The same mounted session must keep its remaining row controls live after
    // a committed rewind, without relying on a page reload to rebind handlers.
    const survivingUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Message actions before refresh." });
    await browserExpect(survivingUserMessage).toBeVisible();
    await survivingUserMessage.hover();
    const survivingActions = survivingUserMessage.getByTestId("user-message-actions");
    await survivingActions.getByRole("button", { name: "编辑" }).click();
    const postRewindEditor = survivingUserMessage.getByTestId("user-message-inline-editor");
    await browserExpect(postRewindEditor).toBeVisible();
    await browserExpect(postRewindEditor.getByRole("textbox", { name: "编辑" }))
      .toHaveValue("Message actions before refresh.");
    await postRewindEditor.getByRole("button", { name: "取消" }).click();
    await browserExpect(postRewindEditor).toHaveCount(0);

    await sendComposerMessage("Please reason, then answer.");

    await waitForSignal(reasoningGate, "reasoning stream frame");
    await browserExpect(page.getByText("Reasoning before refresh.")).toBeVisible();
    await browserExpect(page.getByText("Please reason, then answer.")).toBeVisible({ timeout: FIRST_SCREEN_TIMEOUT_MS });
    await composer.fill("Send this after the active answer.");
    await composer.press("Enter");
    await browserExpect.poll(() => requests.some((request) => request.operation === "enqueueMessage" &&
      request.body?.content === "Send this after the active answer.")).toBe(true);
    await browserExpect(page.locator("[data-webui-queue-item]")).toHaveCount(1);
    const activeUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Please reason, then answer." });
    const activeUserMessageId = await activeUserMessage.getAttribute("data-message-id");
    expect(activeUserMessageId).toEqual(expect.any(String));
    const resumeCountBeforeReload = requests.filter((request) => request.operation === "resumeSession").length;
    await page.reload();
    // The reload is a second cold start of the same client, so it waits on the
    // same condition and with the same deadline. The transcript's first user
    // message is part of that condition: it can only be on screen once the
    // reloaded client has resumed the session and rendered what it read back.
    await browserExpect(composer).toBeVisible({ timeout: FIRST_SCREEN_TIMEOUT_MS });
    await browserExpect(page.locator("#webui-root")).toBeVisible();
    await browserExpect(page.getByText("Please reason, then answer.")).toBeVisible();
    await browserExpect.poll(() => requests.filter((request) => request.operation === "resumeSession").length)
      .toBeGreaterThan(resumeCountBeforeReload);
    const resumeRequest = requests.filter((request) => request.operation === "resumeSession").at(-1);
    expect(resumeRequest?.body?.afterMsgId).toBe(activeUserMessageId);
    await browserExpect(page.locator("[data-webui-queue-item]")).toHaveCount(1);
    try {
      await browserExpect.poll(() => received.some((response) =>
        response.requestId === resumeRequest?.requestId &&
        response.kind === "event" &&
        JSON.stringify(response.body).includes("Reasoning before refresh."),
      ), { timeout: 15_000 }).toBe(true);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
        resumeRequest: resumeRequest && {
          requestId: resumeRequest.requestId,
          operation: resumeRequest.operation,
          body: resumeRequest.body,
        },
        resumeFrames: received.filter((response) => response.requestId === resumeRequest?.requestId),
        sessionRequests: requests.filter((request) => ["getMessages", "watchEvents", "resumeSession"]
          .includes(request.operation ?? ""))
          .map((request) => ({ requestId: request.requestId, operation: request.operation, body: request.body })),
        visibleTranscript: ((await page.locator("body").textContent()) ?? "").slice(-1_200),
      })}`);
    }
    await page.waitForTimeout(1_000);
    const resumedThinkingVisible = await page.getByText("Reasoning before refresh.").isVisible();

    releaseAnswer();
    await browserExpect(page.getByText("Final answer after refresh.")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await page.locator("body").textContent()) ?? "")
      .toContain("Reasoning before refresh.");

    const originalUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Please reason, then answer." });
    await originalUserMessage.hover();
    const userActions = originalUserMessage.getByTestId("user-message-actions");
    await browserExpect(userActions).toBeVisible();
    await userActions.getByRole("button", { name: "复制", exact: true }).click();
    await browserExpect(userActions.getByRole("button", { name: "已复制" })).toBeVisible();
    await browserExpect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Please reason, then answer.");

    // Exercise the actual message-row fork control and check that its new
    // session is both selected and present in the visible session tree.
    const sourceAnswer = page.locator('[data-webui-message-role="assistant"]')
      .filter({ hasText: "Final answer after refresh." });
    await sourceAnswer.hover();
    const assistantActions = sourceAnswer.getByTestId("message-actions");
    await assistantActions.getByRole("button", { name: "复制", exact: true }).click();
    await browserExpect(assistantActions.getByRole("button", { name: "已复制" })).toBeVisible();
    await browserExpect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Final answer after refresh.");
    const likeButton = assistantActions.getByRole("button", { name: "赞" });
    const dislikeButton = assistantActions.getByRole("button", { name: "踩" });
    await likeButton.click();
    await browserExpect(likeButton).toHaveAttribute("aria-pressed", "true");
    await dislikeButton.click();
    await browserExpect(likeButton).toHaveAttribute("aria-pressed", "false");
    await browserExpect(dislikeButton).toHaveAttribute("aria-pressed", "true");
    await assistantActions.getByRole("button", { name: "复制为新会话" }).click();
    const forkDialog = page.getByTestId("fork-dialog");
    await browserExpect(forkDialog).toBeVisible();
    await browserExpect.poll(() => requests.some((request) => request.operation === "getSessionForkOptions"))
      .toBe(true);
    // The suggested title arrives with the fork options and is written into the
    // field. Wait for that write to land before typing. Playwright's fill
    // selects the field and then inserts the text in a second round trip, and
    // a suggestion landing between the two moves the caret to the end of the
    // suggestion, so the typed name would be appended to it instead of
    // replacing it.
    const forkOptionsRequest = requests.find((request) => request.operation === "getSessionForkOptions");
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === forkOptionsRequest?.requestId && response.kind === "response",
    )).toBe(true);
    await browserExpect.poll(() => forkDialog.getByLabel("会话名称").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await forkDialog.getByLabel("会话名称").fill("synthetic-message-fork");
    await forkDialog.getByRole("button", { name: "复制并进入" }).click();
    await browserExpect.poll(() => requests.some((request) => request.operation === "forkSession"))
      .toBe(true);
    const messageForkRequest = requests.find((request) => request.operation === "forkSession");
    expect(messageForkRequest?.body).toMatchObject({
      id: sessionId,
      title: "synthetic-message-fork",
      useSuggestedTitle: false,
      createIsolatedWorktree: false,
    });
    expect(messageForkRequest?.body?.assistantMessageId).toEqual(expect.any(String));
    // The reply travels on its own frame and can land after the request was
    // observed, so wait for the forked session's id itself rather than
    // reading the first response that happens to be there.
    await browserExpect.poll(() => {
      const response = received.find((candidate) => candidate.requestId === messageForkRequest?.requestId);
      const sessionId = (response?.body as { session?: { sessionId?: unknown } } | undefined)?.session?.sessionId;
      return typeof sessionId === "string";
    }).toBe(true);
    const messageForkResponse = received.find((response) => response.requestId === messageForkRequest?.requestId);
    const messageForkSessionId = (messageForkResponse?.body as { session?: { sessionId?: unknown } } | undefined)
      ?.session?.sessionId;
    expect(messageForkSessionId).toEqual(expect.any(String));
    await browserExpect(page).toHaveURL(new RegExp(`#session=${String(messageForkSessionId)}$`));
    const forkedSessionLink = page.locator(`[data-webui-session-link="${String(messageForkSessionId)}"]`);
    await browserExpect(forkedSessionLink).toHaveAttribute("data-webui-session-active", "true");
    await browserExpect(forkedSessionLink).toBeVisible();
    await browserExpect.poll(() => requests.filter((request) => request.operation === "getSessionTree").length)
      .toBeGreaterThan(1);
    await page.locator(`[data-webui-session-link="${sessionId}"]`)
      .getByText("Message actions before refresh.").click();
    await browserExpect(page).toHaveURL(new RegExp(`#session=${sessionId}$`));

    await waitForSignal(queuedTurnGate, "queued follow-up model request");
    await expect.poll(async () => {
      const history = await port.getMessages({ id: sessionId });
      return (history.messages ?? []).filter((message) => message.role === "assistant")
        .map((message) => message.msgContent);
    }, { timeout: 30_000 }).toContain("Queued follow-up delivered.");
    try {
      await browserExpect(page.getByText("Queued follow-up delivered.")).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
        requests: requests.slice(-30).map((request) => ({ operation: request.operation, body: request.body })),
        modelRequests: modelRequests.map((request) => request.body.slice(-1_500)),
        activeTurn: await port.getActiveTurn({ id: sessionId }),
        persistedQueue: await port.listQueueMessages({ id: sessionId }),
        receivedKindCounts: received.reduce<Record<string, number>>((counts, frame) => {
          const kind = frame.kind ?? "missing-kind";
          counts[kind] = (counts[kind] ?? 0) + 1;
          return counts;
        }, {}),
        receivedEventBodies: received.filter((frame) => frame.kind === "event").map((frame) => frame.body),
        received: received.slice(-20).map((response) => ({
          kind: response.kind,
          body: JSON.stringify(response.body ?? null).slice(-320),
        })),
        lifecycleEvents: received
          .map((response) => JSON.stringify(response))
          .filter((frame) => frame.includes("session.start") || frame.includes("queued-drain") ||
            frame.includes("session.queue.updated") || frame.includes("Queued follow-up delivered."))
          .map((frame) => frame.slice(-600)),
        visibleTail: ((await page.locator("body").textContent()) ?? "").slice(-1_000),
      })}`);
    }
    await expect.poll(async () => (await port.listQueueMessages({ id: sessionId })).items ?? [])
      .toEqual([]);
    try {
      await browserExpect(page.locator("[data-webui-queue-item]")).toHaveCount(0, { timeout: 5_000 });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
        queueReads: requests
          .filter((request) => request.operation === "listQueueMessages")
          .map((request) => request.body),
        queueEvents: received
          .map((response) => JSON.stringify(response))
          .filter((frame) => frame.includes("session.queue.updated"))
          .map((frame) => frame.slice(-500)),
        queueRows: await page.locator("[data-webui-queue-item]").allTextContents(),
      })}`);
    }

    await composer.fill("Create a task checklist.");
    await composer.press("Enter");
    await browserExpect(page.getByTestId("progress-overview-card").getByText("Visible task from runtime tool"))
      .toBeVisible({ timeout: 30_000 });
    const todoPanel = page.getByRole("button", { name: "进度", exact: true });
    await browserExpect(todoPanel).toBeVisible();
    await browserExpect(page.locator("span.webui-tool-label").filter({ hasText: "todowrite" }))
      .toHaveText("todowrite");
    await expect.poll(() => todoContinuationReached).toBe(true);
    await expect.poll(async () => (await port.getActiveTurn({ id: sessionId })) !== undefined).toBe(true);

    // The todo event has its own runtime -> progress-panel assertion above.
    // While that Agent turn remains open, exercise the separate person ->
    // mounted browser panel -> browser service -> isolated Chromium path.
    const browserControl = page.getByTestId("workspace-panel-controls")
      .getByRole("button", { name: "浏览器", exact: true });
    await browserControl.click();
    const browserLauncher = page.getByTestId("workspace-launcher");
    await browserExpect(browserLauncher).toBeVisible();
    const pageUrl = `http://127.0.0.1:${pageAddress.port}/`;
    await page.getByTestId("workspace-launcher-url").fill(pageUrl);
    await page.getByTestId("workspace-launcher-url-submit").click();
    const browserFrame = page.getByTestId("browser-panel-frame");
    await browserExpect(browserFrame).toBeVisible({ timeout: 30_000 });
    const browserGeometry = await browserFrame.evaluate((node) => {
      const frame = node.getBoundingClientRect();
      const panel = node.closest(".webui-browser-panel")?.getBoundingClientRect();
      return {
        frameVisible: frame.width > 0 && frame.height > 0,
        frameInsideViewport: frame.left >= 0 && frame.top >= 0 &&
          frame.right <= innerWidth && frame.bottom <= innerHeight,
        panelVisible: Boolean(panel && panel.width > 0 && panel.height > 0),
        panelInsideViewport: Boolean(panel && panel.left >= 0 && panel.top >= 0 &&
          panel.right <= innerWidth && panel.bottom <= innerHeight),
      };
    });
    expect(browserGeometry).toEqual({
      frameVisible: true,
      frameInsideViewport: true,
      panelVisible: true,
      panelInsideViewport: true,
    });
    const runtimeBrowserTarget = (await testBrowserAdapter.port!.listTargets("isolated-chromium", sessionId))
      .targets.find((target) => target.url === pageUrl);
    expect(runtimeBrowserTarget).toBeDefined();
    const pageBox = await browserFrame.boundingBox();
    if (!pageBox) throw new Error("embedded browser frame has no rendered geometry");
    const imageDimensions = await browserFrame.evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    expect(imageDimensions.width).toBeGreaterThan(0);
    expect(imageDimensions.height).toBeGreaterThan(0);
    await page.mouse.click(
      pageBox.x + pageBox.width * 208 / imageDimensions.width,
      pageBox.y + pageBox.height * 88 / imageDimensions.height,
    );
    await page.keyboard.type("browser-while-todo-active");
    await expect.poll(() => browserReportedValues).toContain("browser-while-todo-active");
    await browserExpect(page.getByTestId("progress-overview-card").getByText("Visible task from runtime tool"))
      .toBeVisible();
    const browserInputRequests = requests.filter((request) => request.operation === "sendBrowserInput");
    expect(browserInputRequests.length, JSON.stringify(browserInputRequests)).toBeGreaterThan(0);
    await expect.poll(async () => (await port.getActiveTurn({ id: sessionId })) !== undefined).toBe(true);
    releaseTodoAnswer();
    await browserExpect(page.getByText("The runtime checklist is ready.")).toBeVisible({ timeout: 30_000 });
    await browserExpect.poll(() => port.getActiveTurn({ id: sessionId })).toBeUndefined();
    const activeBrowserTab = page.locator('[data-testid^="workspace-tab-strip-item-"][data-tab-kind="web"]');
    await browserExpect(activeBrowserTab).toBeVisible();
    await activeBrowserTab.locator("button").last().click();
    await browserExpect(activeBrowserTab).toHaveCount(0);
    await browserExpect(page.getByTestId("workspace-panel")).toHaveCount(0);
    await expect.poll(async () => {
      const history = await port.getMessages({ id: sessionId });
      return JSON.stringify(history.messages ?? []);
    }).toContain("Visible task from runtime tool");
    await expect.poll(async () => {
      const history = await port.getMessages({ id: sessionId });
      const messages = history.messages ?? [];
      return messages.filter((message) => (message.role === "user" || message.role === "assistant") &&
        typeof message.msgContent === "string" && message.msgContent.length > 0)
        .map((message) => `${message.role}:${message.msgContent}`);
    }, { timeout: 30_000 }).toEqual([
      "user:Message actions before refresh.",
      "assistant:Unrefreshed action probe response.",
      "user:Please reason, then answer.",
      "assistant:Final answer after refresh.",
      "user:Send this after the active answer.",
      "assistant:Queued follow-up delivered.",
      "user:Create a task checklist.",
      "assistant:The runtime checklist is ready.",
    ]);

    const transcript = (await page.locator("body").textContent()) ?? "";
    const positions = [
      transcript.indexOf("Message actions before refresh."),
      transcript.indexOf("Unrefreshed action probe response."),
      transcript.indexOf("Please reason, then answer."),
      transcript.indexOf("Reasoning before refresh."),
      transcript.indexOf("Final answer after refresh."),
      transcript.indexOf("Send this after the active answer."),
      transcript.indexOf("Queued follow-up delivered."),
      transcript.indexOf("Create a task checklist."),
      transcript.indexOf("Visible task from runtime tool"),
      transcript.indexOf("The runtime checklist is ready."),
    ];
    const finalHistory = await port.getMessages({ id: sessionId });
    expect(positions.every((position) => position >= 0), JSON.stringify({
      missingIndexes: positions.map((position, index) => position < 0 ? index : undefined).filter((index) => index !== undefined),
      route: await page.evaluate(() => location.hash),
      outgoingTurns: requests
        .filter((request) => request.operation === "sendMessage" || request.operation === "enqueueMessage")
        .map((request) => ({ operation: request.operation, body: request.body })),
      persisted: (finalHistory.messages ?? []).map((message) => ({
        role: message.role,
        content: message.msgContent,
        attachmentNames: Array.isArray(message.attachments)
          ? (message.attachments as { meta?: { fileName?: string } }[])
            .map((attachment) => attachment.meta?.fileName)
          : [],
      })),
      visibleTail: transcript.slice(-2_000),
    })).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(resumedThinkingVisible).toBe(true);
    expect(modelRequests.length).toBeGreaterThanOrEqual(2);
    expect(modelRequests.every((request) => request.url === "/v1/chat/completions" &&
      request.authorization === "Bearer e2e-stub-key")).toBe(true);
    expect(modelRequests.some((request) => request.body.includes("Please reason, then answer."))).toBe(true);
    expect(modelRequests.some((request) => request.body.includes("Send this after the active answer."))).toBe(true);
    expect(modelRequests.some((request) => request.body.includes("Create a task checklist.") &&
      request.body.includes("todowrite"))).toBe(true);

    const attachmentInput = page.locator('input.webui-composer-hidden-file-input[aria-label="添加文件或图片"]');
    await attachmentInput.setInputFiles({
      name: "runtime-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic attachment body."),
    });
    await browserExpect(page.locator('[data-webui-composer-attachments="true"]')
      .getByText("runtime-note.txt")).toBeVisible();
    await composer.fill("Summarize the referenced project file. @reference-target");
    const mention = page.getByRole("option", { name: "reference-target.md", exact: true });
    await browserExpect(mention).toBeVisible();
    await mention.click();
    await browserExpect(composer).toHaveValue("Summarize the referenced project file. @reference-target.md ");
    await page.locator("[data-webui-composer-submit]").click();
    await browserExpect(page.getByText("Reference and attachment reached the runtime.")).toBeVisible({ timeout: 30_000 });
    await browserExpect.poll(async () => (await page.locator("body").textContent()) ?? "")
      .toContain("Summarize the referenced project file.");
    const referenceRequest = modelRequests.find((request) =>
      request.body.includes("Summarize the referenced project file."));
    const referenceSend = requests.find((request) => request.operation === "sendMessage" &&
      request.body?.content === "Summarize the referenced project file. @reference-target.md");
    expect(referenceSend).toBeDefined();
    expect(referenceRequest).toBeDefined();
    expect(referenceRequest?.body).toContain("@reference-target.md");
    expect(referenceRequest?.body).toContain("runtime-note.txt");
    const referencePayload = JSON.parse(referenceRequest?.body ?? "{}") as {
      messages?: readonly { content?: unknown }[];
    };
    const referencePrompt = (referencePayload.messages ?? [])
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n");
    const runtimeAttachmentPath = /<attachment name=\\?"runtime-note\.txt\\?"[^>]* path=\\?"([^"\\]+)\\?"/u
      .exec(referencePrompt)?.[1];
    expect(runtimeAttachmentPath).toBeDefined();
    expect(await readFile(runtimeAttachmentPath!, "utf8")).toBe("Synthetic attachment body.");
    await expect.poll(async () => {
      const history = await port.getMessages({ id: sessionId });
      return JSON.stringify(history.messages ?? []);
    }, { timeout: 15_000 }).toContain("runtime-note.txt");
    await expect.poll(async () => JSON.stringify((await port.getMessages({ id: sessionId })).messages ?? []))
      .toContain("Reference and attachment reached the runtime.");
    await expect.poll(async () => JSON.stringify((await port.getMessages({ id: sessionId })).messages ?? []))
      .toContain("@reference-target.md");
    await browserExpect.poll(() => port.getActiveTurn({ id: sessionId })).toBeUndefined();
    const completedReferenceUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Summarize the referenced project file." });
    await browserExpect(completedReferenceUserMessage).toBeVisible();
    const completedReferenceTranscript = (await page.locator("body").textContent()) ?? "";
    const referencePromptPosition = completedReferenceTranscript.indexOf("Summarize the referenced project file.");
    const referenceAnswerPosition = completedReferenceTranscript.indexOf("Reference and attachment reached the runtime.");
    expect(referencePromptPosition).toBeGreaterThanOrEqual(0);
    expect(referenceAnswerPosition).toBeGreaterThan(referencePromptPosition);

    // The plan-entry path runs before creating an active Goal because a Goal
    // intentionally starts automatic follow-up work in this same session.
    await composer.fill("/plan Plan this synthetic task.");
    await composer.press("Enter");
    await browserExpect(page.getByText("Synthetic plan-entry turn completed.")).toBeVisible({ timeout: 30_000 });
    // The captured frame and the rendered answer are two different writes, so
    // the capture is polled the way the history below is polled rather than
    // read once and raced.
    await expect.poll(() => requests.some((request) => request.operation === "sendMessage" &&
      request.body?.content === "Plan this synthetic task."), { timeout: 20_000 }).toBe(true);
    const planEntry = requests.find((request) => request.operation === "sendMessage" &&
      request.body?.content === "Plan this synthetic task.");
    expect(planEntry?.body).toMatchObject({ clientIntent: "plan-entry" });
    // The rendered answer and the persisted history are two different writes:
    // the transcript shows the frame as it arrives, while the history lands a
    // beat later. Poll the history the way the rest of this case does instead
    // of reading it once and racing the write.
    await expect.poll(async () => (await port.getMessages({ id: sessionId })).messages?.some((message) =>
      message.role === "assistant" && message.msgContent === "Synthetic plan-entry turn completed.") === true)
      .toBe(true);
    await page.getByRole("button", { name: "退出计划模式" }).click();
    await browserExpect(composer).toBeVisible();

    // Ask User must pause and resume the same production turn. The real
    // runtime creates the persisted questionnaire from the model tool call;
    // the mounted UI submits the answer through the WebUI service before the
    // local model stub returns the continuation.
    await composer.fill("Ask User continuation.");
    await composer.press("Enter");
    const questionnaire = page.getByTestId("questionnaire-composer");
    await browserExpect(questionnaire).toBeVisible({ timeout: 30_000 });
    const questionCard = questionnaire.getByText("Which direction should this same turn use?");
    await browserExpect(questionCard).toBeVisible();
    await questionnaire.getByText("Keep the current scope", { exact: true }).click();
    await questionnaire.getByRole("button", { name: "提交" }).click();
    await browserExpect(questionnaire).toHaveCount(0);
    await browserExpect(page.getByText("Same turn continued from the user's answer.")).toBeVisible({ timeout: 30_000 });
    const questionnaireReply = requests.find((request) => request.operation === "replyQuestionnaire");
    expect(questionnaireReply).toBeDefined();
    expect(questionnaireReply?.body).toMatchObject({
      requestId: expect.any(String),
      answers: [{ stepId: "direction", selectedOptionIds: ["scope-current"] }],
    });
    const askUserHistory = await port.getMessages({ id: sessionId });
    expect(JSON.stringify(askUserHistory.messages)).toContain("Which direction should this same turn use?");
    expect(JSON.stringify(askUserHistory.messages)).toContain("Same turn continued from the user's answer.");

    // Exercise the visible slash-command routes against production goal and
    // plan owners. Goal creation is persisted by the runtime; /plan reaches
    // the same send operation with the plan-entry intent before its answer is
    // streamed back into the transcript.
    await composer.fill("/goal Keep this synthetic goal active.");
    await composer.press("Enter");
    await browserExpect(page.getByTestId("thread-goal-banner")).toContainText("Keep this synthetic goal active.");
    await expect.poll(async () => await port.getGoal({ sessionId })).toMatchObject({
      objective: "Keep this synthetic goal active.",
      status: "active",
    });
    const goalCreate = requests.find((request) => request.operation === "createGoal");
    expect(goalCreate?.body).toMatchObject({ objective: "Keep this synthetic goal active." });

    const goalBanner = page.getByTestId("thread-goal-banner");
    await browserExpect.poll(() => goalBanner.getAttribute("data-goal-status"), { timeout: 30_000 })
      .toBe("paused");
    await page.getByRole("button", { name: "清除目标" }).click();
    const clearGoalDialog = page.getByTestId("goal-clear-confirm");
    await browserExpect(clearGoalDialog).toBeVisible();
    await clearGoalDialog.getByTestId("goal-clear-confirm-confirm").click();
    await browserExpect.poll(() => requests.some((request) => request.operation === "clearGoal"))
      .toBe(true);
    const clearGoalRequest = requests.find((request) => request.operation === "clearGoal");
    expect(clearGoalRequest?.body).toEqual({ sessionId });
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === clearGoalRequest?.requestId && response.kind === "response",
    )).toBe(true);
    const clearGoalResponse = received.find((response) => response.requestId === clearGoalRequest?.requestId);
    expect(clearGoalResponse?.body).toEqual({ success: true });
    await expect.poll(async () => await port.getGoal({ sessionId })).toBeUndefined();
    await browserExpect(goalBanner).toHaveCount(0);
    await browserExpect(composer).toBeVisible();

    // Open the actual management surface against the same isolated production
    // host. This covers the MCP operation shape through the mounted client,
    // beyond the raw WebSocket codec assertion in real-host-loopback.test.ts.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "插件" }).first().click();
    await page.locator(".webui-plugin-manage-trigger").click();
    await page.locator('.webui-plugin-category-filter button', { hasText: "MCP" }).click();
    await browserExpect(page.getByPlaceholder("搜索MCP...")).toBeVisible();
    await browserExpect(page.getByText("暂无内容")).toBeVisible();
    await browserExpect(page.getByText(/pluginManagement returned a body/u)).toHaveCount(0);
    const mcpListRequest = requests.find((request) => request.operation === "pluginManagement" &&
      request.body?.action === "listMcpServers");
    expect(mcpListRequest).toBeDefined();
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === mcpListRequest?.requestId && response.kind === "response" &&
      JSON.stringify(response.body).includes('"servers":[]'),
    )).toBe(true);
    const mcpListResponse = received.find((response) => response.requestId === mcpListRequest?.requestId);
    expect(mcpListResponse?.body).toEqual({ servers: [] });

    await page.locator(".webui-plugin-create-trigger").click();
    await page.getByRole("button", { name: "添加 MCP server" }).click();
    const mcpDialog = page.getByRole("dialog", { name: "MCP Server" });
    await browserExpect(mcpDialog).toBeVisible();
    const mcpGeometry = await mcpDialog.evaluate((node) => {
      const backdrop = node.parentElement;
      const rect = node.getBoundingClientRect();
      const backdropRect = backdrop!.getBoundingClientRect();
      const fields = node.querySelector(".webui-mcp-form-fields")!;
      const controls = [...fields.querySelectorAll("input:not([type=checkbox]), select")];
      return {
        backdropFixed: getComputedStyle(backdrop!).position === "fixed",
        backdropCoversViewport: backdropRect.left <= 0 && backdropRect.top <= 0 &&
          backdropRect.right >= innerWidth && backdropRect.bottom >= innerHeight,
        centered: Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 3 &&
          Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 3,
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        fieldsGrid: getComputedStyle(fields).display === "grid",
        controlsAligned: controls.length >= 3 && controls.every((control) => {
          const input = control.getBoundingClientRect();
          const label = control.closest("label")!.getBoundingClientRect();
          return Math.abs(input.left - label.left) < 3 && Math.abs(input.width - label.width) < 3;
        }),
      };
    });
    expect(mcpGeometry).toEqual({
      backdropFixed: true,
      backdropCoversViewport: true,
      centered: true,
      insideViewport: true,
      fieldsGrid: true,
      controlsAligned: true,
    });
    await mcpDialog.getByLabel("名称").fill("synthetic-disabled-mcp");
    await mcpDialog.getByLabel("命令").fill("synthetic-mcp-command");
    await mcpDialog.getByLabel("启用").uncheck();
    await mcpDialog.getByRole("button", { name: "添加服务器" }).click();
    await browserExpect(mcpDialog).toHaveCount(0);
    await browserExpect(page.locator(".webui-plugin-row").filter({ hasText: "synthetic-disabled-mcp" }))
      .toBeVisible();
    const mcpCreate = requests.find((request) => request.operation === "pluginManagement" &&
      request.body?.action === "createMcpServer");
    expect(mcpCreate?.body).toMatchObject({
      action: "createMcpServer",
      input: {
        name: "synthetic-disabled-mcp",
        enabled: false,
        config: { transport: "stdio", command: "synthetic-mcp-command" },
      },
    });

    await forkedSessionLink.getByText("synthetic-message-fork").click();
    await browserExpect(page).toHaveURL(new RegExp(`#session=${String(messageForkSessionId)}$`));
    await browserExpect(forkedSessionLink).toHaveAttribute("data-webui-session-active", "true");
    await browserExpect(page.locator(`[data-webui-transcript="${String(messageForkSessionId)}"]`))
      .toBeVisible();
    await browserExpect.poll(() => requests.some((request) => request.operation === "getMessages" &&
      request.body?.id === messageForkSessionId)).toBe(true);
    await composer.fill("Fork isolation probe.");
    await composer.press("Enter");
    await browserExpect.poll(() => requests.some((request) => request.operation === "sendMessage" &&
      request.body?.id === messageForkSessionId && request.body?.content === "Fork isolation probe."),
    { timeout: 15_000 }).toBe(true);
    await browserExpect.poll(() => modelRequests.some((request) =>
      request.body.includes("Fork isolation probe."),
    )).toBe(true);
    await browserExpect(page.getByText("Fork-only response.")).toBeVisible({ timeout: 30_000 });
    const forkSendRequest = requests.find((request) => request.operation === "sendMessage" &&
      request.body?.content === "Fork isolation probe.");
    expect(forkSendRequest?.body?.id).toBe(messageForkSessionId);
    const forkHistoryBeforeEdit = await port.getMessages({ id: String(messageForkSessionId) });
    expect(JSON.stringify(forkHistoryBeforeEdit.messages)).toContain("Fork isolation probe.");
    const sourceHistoryBeforeEdit = await port.getMessages({ id: sessionId });
    expect(JSON.stringify(sourceHistoryBeforeEdit.messages)).not.toContain("Fork isolation probe.");

    const forkUserMessage = page.locator('[data-webui-message-role="user"]')
      .filter({ hasText: "Fork isolation probe." });
    const forkUserMessageId = await forkUserMessage.getAttribute("data-message-id");
    expect(forkUserMessageId).toEqual(expect.any(String));
    const forkUserMessageById = page.locator(
      `[data-webui-message-role="user"][data-message-id="${forkUserMessageId}"]`,
    );
    await forkUserMessage.hover();
    const forkUserActions = forkUserMessage.getByTestId("user-message-actions");
    await forkUserActions.getByRole("button", { name: "复制", exact: true }).click();
    await browserExpect(forkUserActions.getByRole("button", { name: "已复制" })).toBeVisible();
    await browserExpect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Fork isolation probe.");
    await forkUserActions.getByRole("button", { name: "回退" }).click();
    const forkRewindDialog = page.getByTestId("rewind-preview-dialog");
    await browserExpect(forkRewindDialog).toBeVisible();
    await browserExpect.poll(() => requests.some((request) => request.operation === "getSessionRewindPreview" &&
      request.body?.id === messageForkSessionId)).toBe(true);
    await forkRewindDialog.getByRole("button", { name: "取消" }).click();
    await browserExpect(forkRewindDialog).toHaveCount(0);

    await forkUserActions.getByRole("button", { name: "编辑" }).click();
    const forkUserEditor = forkUserMessageById.getByTestId("user-message-inline-editor");
    await browserExpect(forkUserEditor).toBeVisible();
    await forkUserEditor.getByRole("textbox", { name: "编辑" }).fill("Fork isolation probe edited.");
    await forkUserEditor.getByRole("button", { name: "发送" }).click();
    await browserExpect.poll(() => requests.some((request) => request.operation === "editSessionMessage"))
      .toBe(true);
    const forkEditRequest = requests.find((request) => request.operation === "editSessionMessage");
    expect(forkEditRequest?.body).toMatchObject({
      id: messageForkSessionId,
      userMessageId: expect.any(String),
      content: "Fork isolation probe edited.",
    });
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === forkEditRequest?.requestId && response.kind === "response",
    )).toBe(true);
    const forkEditResponse = received.find((response) => response.requestId === forkEditRequest?.requestId);
    expect(forkEditResponse?.body).toMatchObject({ rewound: true, userMessageId: expect.any(String) });
    await browserExpect(page.getByText("Edited fork message response.")).toBeVisible({ timeout: 30_000 });
    // The rendered answer and the retired turn are two different moments: the
    // answer shows up when the model has answered, the turn is only over once
    // the runtime says so. Sending into a session whose turn has not been
    // retired yet does not start a turn — the message is queued instead, and
    // it never reaches the model, so the case waits for the turn to be over
    // the way the rest of this case does before it sends the next message.
    await browserExpect.poll(() => port.getActiveTurn({ id: String(messageForkSessionId) }), { timeout: 20_000 })
      .toBeUndefined();
    const editedForkHistory = await port.getMessages({ id: String(messageForkSessionId) });
    const forkUserMessages = (editedForkHistory.messages ?? []).filter((message) => message.role === "user");
    expect(forkUserMessages.some((message) => message.msgContent === "Fork isolation probe edited.")).toBe(true);
    expect(forkUserMessages.some((message) => message.msgContent === "Fork isolation probe.")).toBe(false);
    const unchangedSourceHistory = await port.getMessages({ id: sessionId });
    expect(JSON.stringify(unchangedSourceHistory.messages)).not.toContain("Fork isolation probe edited.");

    // Stop an actively streamed turn from the mounted composer, then send a
    // follow-up in the same persisted session to prove it recovered.
    await sendComposerMessage("Stop this turn, then recover.");
    // The gate is the model server seeing the request that a cancelable local
    // response is streaming. The wait is for that event, not for a fixed
    // pause; the ceiling only decides how long the case may look for it.
    await waitForSignal(stopResponseStartedGate, "held cancellation response");
    await browserExpect(page.getByText("Cancelable local response is active.")).toBeVisible();
    const activeStopButton = page.getByRole("button", { name: "停止" });
    await browserExpect(activeStopButton).toBeVisible();
    const abortRequestCount = requests.filter((request) => request.operation === "abortSession").length;
    await activeStopButton.click();
    await browserExpect.poll(() => requests.filter((request) => request.operation === "abortSession").length)
      .toBe(abortRequestCount + 1);
    const abortRequest = requests.filter((request) => request.operation === "abortSession").at(-1);
    expect(abortRequest?.body).toEqual({ id: messageForkSessionId });
    await browserExpect.poll(() => received.some((response) =>
      response.requestId === abortRequest?.requestId && response.kind === "response" &&
      JSON.stringify(response.body).includes('"success":true'),
    )).toBe(true);
    await browserExpect(page.locator("[data-webui-composer-submit]")).toBeVisible();
    await browserExpect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
    await browserExpect.poll(() => port.getActiveTurn({ id: String(messageForkSessionId) }))
      .toBeUndefined();
    releaseStoppedAnswer();
    await browserExpect(page.getByText("Canceled response must not be rendered.")).toHaveCount(0);
    const stoppedTurnHistory = await port.getMessages({ id: String(messageForkSessionId) });
    expect(JSON.stringify(stoppedTurnHistory.messages)).toContain("Stop this turn, then recover.");
    expect(JSON.stringify(stoppedTurnHistory.messages)).not.toContain("Canceled response must not be rendered.");

    await sendComposerMessage("Continue after stopping the prior turn.");
    await browserExpect(page.getByText("The session recovered after stop.")).toBeVisible({ timeout: 30_000 });
    await browserExpect.poll(() => port.getActiveTurn({ id: String(messageForkSessionId) }))
      .toBeUndefined();
    const recoveredTurnHistory = await port.getMessages({ id: String(messageForkSessionId) });
    expect(JSON.stringify(recoveredTurnHistory.messages)).toContain("The session recovered after stop.");

    // A model failure must render the production retry affordance. Clicking it
    // re-submits the recorded input through the ordinary WebUI/runtime path and
    // leaves the successful retry visible in persisted session history.
    const retryLifecycleAbort = new AbortController();
    const retryLifecycleEvents: { type?: unknown; payload?: unknown }[] = [];
    const retryLifecycleWatch = (async () => {
      for await (const event of port.watchEvents(retryLifecycleAbort.signal)) {
        if (event && typeof event === "object" && "type" in event) {
          const candidate = event as { type?: unknown; payload?: unknown };
          if (typeof candidate.type === "string" && candidate.type.startsWith("session."))
            retryLifecycleEvents.push(candidate);
        }
      }
    })();
    await sendComposerMessage("Retry this synthetic turn after a model failure.");
    const retryError = page.getByTestId("output-error-surface");
    await browserExpect.poll(() => retryModelAttempts, { timeout: 30_000 }).toBeGreaterThan(0);
    await browserExpect.poll(() => port.getActiveTurn({ id: String(messageForkSessionId) }), {
      timeout: 30_000,
    }).toBeUndefined();
    const observedLifecycleEvents = () => received.flatMap((frame) => {
      if (frame.kind !== "event" || !frame.body || typeof frame.body !== "object" || Array.isArray(frame.body)) return [];
      const event = frame.body as { type?: unknown; payload?: unknown };
      return typeof event.type === "string" && event.type.startsWith("session.") ? [event] : [];
    });
    const errorTurnId = (event: { type?: unknown; payload?: unknown }) =>
      (event.payload as { turnId?: unknown } | undefined)?.turnId;
    // The runtime's event stream and the client's are two deliveries of the
    // same event, and the runtime's watch used to be torn down the moment the
    // turn went inactive — which is exactly when the runtime reports the
    // failure. An event still in flight when the watch is aborted is lost, and
    // the comparison then has nothing on the runtime side to compare the
    // client's event against. The watch therefore stays open until both sides
    // carry the error.
    await browserExpect.poll(() => {
      const observed = observedLifecycleEvents().filter((event) => event.type === "session.error");
      const runtime = retryLifecycleEvents.filter((event) => event.type === "session.error");
      return { bothCarried: observed.length > 0 && runtime.length > 0, observed, runtime };
    }, { timeout: 20_000 }).toMatchObject({ bothCarried: true });
    retryLifecycleAbort.abort();
    await retryLifecycleWatch;
    // The turn retries the failing model call, so the runtime reports the
    // failure more than once and the first report is not necessarily the one
    // the client saw. The two views have to name the same turn, and the
    // pairing looks at every error each side reported.
    expect(observedLifecycleEvents().some((event) =>
      event.type === "session.error" &&
      retryLifecycleEvents.some((runtimeEvent) =>
        runtimeEvent.type === "session.error" && errorTurnId(runtimeEvent) === errorTurnId(event),
      ),
    ), JSON.stringify({
      observed: observedLifecycleEvents(),
      runtime: retryLifecycleEvents,
    })).toBe(true);
    const retryFailureVisible = await retryError.isVisible();
    expect(retryFailureVisible, JSON.stringify({
      retryModelAttempts,
      observedLifecycleEvents: observedLifecycleEvents(),
      runtimeLifecycleEvents: retryLifecycleEvents,
      renderedText: await page.locator("body").innerText(),
      failedHistory: (await port.getMessages({ id: String(messageForkSessionId) })).messages?.filter((message) =>
        message.msgContent?.includes("Retry this synthetic turn") || message.msgContent?.includes("[Error]"),
      ),
    })).toBe(true);
    const retryErrorText = await retryError.innerText();
    expect(retryErrorText, await retryError.evaluate((node) => node.outerHTML)).toContain(
      "Synthetic model refusal for retry journey.",
    );
    await page.locator(`[data-webui-session-link="${sessionId}"]`)
      .getByText("Message actions before refresh.").click();
    await browserExpect(page).toHaveURL(new RegExp(`#session=${sessionId}$`));
    await browserExpect(page.getByTestId("output-error-surface")).toHaveCount(0);
    await page.locator(`[data-webui-session-link="${String(messageForkSessionId)}"]`)
      .getByText("synthetic-message-fork", { exact: true }).click();
    await browserExpect(page).toHaveURL(new RegExp(`#session=${String(messageForkSessionId)}$`));
    await browserExpect(retryError).toBeVisible();
    await browserExpect(retryError).toContainText("Synthetic model refusal for retry journey.");
    const retryButton = retryError.getByRole("button", { name: "重试" });
    await browserExpect(retryButton).toBeVisible();
    const failedSendRequests = requests.filter((request) => request.operation === "sendMessage" &&
      request.body?.content === "Retry this synthetic turn after a model failure.");
    expect(failedSendRequests).toHaveLength(1);
    expect(failedSendRequests[0]?.body?.id).toBe(messageForkSessionId);
    const retryAttemptsBeforeClick = retryModelAttempts;
    allowModelRetryRecovery = true;
    await retryButton.click();
    await browserExpect(page.getByText("The same turn recovered after retry.")).toBeVisible({ timeout: 30_000 });
    await browserExpect(retryError).toHaveCount(0);
    await browserExpect.poll(() => retryModelAttempts).toBe(retryAttemptsBeforeClick + 1);
    const retrySendRequests = requests.filter((request) => request.operation === "sendMessage" &&
      request.body?.content === "Retry this synthetic turn after a model failure.");
    expect(retrySendRequests).toHaveLength(2);
    expect(retrySendRequests.map((request) => request.body?.id)).toEqual([
      messageForkSessionId,
      messageForkSessionId,
    ]);
    const retriedHistory = await port.getMessages({ id: String(messageForkSessionId) });
    expect(JSON.stringify(retriedHistory.messages)).toContain("Retry this synthetic turn after a model failure.");
    expect(JSON.stringify(retriedHistory.messages)).toContain("The same turn recovered after retry.");
    expect(JSON.stringify(retriedHistory.messages)).not.toContain("Synthetic model refusal for retry journey.");

    const watcherCountBeforeReconnect = requests.filter((request) => request.operation === "watchEvents").length;
    await page.evaluate(() => {
      const testWindow = window as Window & { __webuiTestEventSocket?: WebSocket };
      if (!testWindow.__webuiTestEventSocket || testWindow.__webuiTestEventSocket.readyState !== WebSocket.OPEN)
        throw new Error("the production event channel socket is not open");
      testWindow.__webuiTestEventSocket.close(1000, "controlled reconnect scenario");
    });
    await browserExpect.poll(() => requests.filter((request) => request.operation === "watchEvents").length, {
      timeout: 15_000,
    }).toBeGreaterThan(watcherCountBeforeReconnect);
    const reconnectedWatch = requests.filter((request) => request.operation === "watchEvents").at(-1);
    await browserExpect.poll(() => received.some((frame) =>
      frame.kind === "response" && frame.requestId === reconnectedWatch?.requestId,
    ), { timeout: 15_000 }).toBe(true);

    // Keep the environment path independent from the todo and embedded-browser
    // assertions: the local Agent write tool changes a temporary Git workspace,
    // then the mounted environment section observes the production result.
    const environmentPanel = page.locator(".webui-environment-panel");
    const environmentHeading = environmentPanel.getByRole("button", { name: "环境信息", exact: true });
    await browserExpect(environmentHeading).toBeVisible();
    if (await environmentHeading.getAttribute("aria-expanded") === "false") await environmentHeading.click();
    await browserExpect(environmentPanel.locator(".webui-environment-workspace")).toHaveText("main");
    const changeAction = environmentPanel.getByRole("button", { name: /变更/u });
    const environmentRequestCount = requests.filter((request) => request.operation === "getWorkspaceEnvironment").length;
    runtimeEventAbort = new AbortController();
    const runtimeEventReader = (async () => {
      for await (const event of port.watchEvents(runtimeEventAbort?.signal)) runtimeEvents.push(event);
    })();
    await sendComposerMessage("Write a synthetic workspace change.");
    await browserExpect.poll(() => requests.filter((request) => request.operation === "sendMessage" &&
      request.body?.id === messageForkSessionId && request.body?.content === "Write a synthetic workspace change.",
    ).length).toBeGreaterThan(0);
    await browserExpect(page.getByText("The workspace file was written by the runtime.")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => readFile(path.join(workspaceDir, "runtime-panel-change.txt"), "utf8")
      .catch(() => undefined)).toBe("Created through the real local Agent write tool.\n");
    try {
      await expect.poll(() => runtimeEvents.some((event) => isWorkspaceChangedEvent(event, workspaceDir)))
        .toBe(true);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
        runtimeEventTypes: runtimeEvents.map((event) => {
          if (!event || typeof event !== "object") return typeof event;
          const candidate = event as { type?: unknown; payload?: unknown };
          return { type: candidate.type, payload: candidate.payload };
        }),
        workspaceDir,
      })}`);
    }
    try {
      await browserExpect.poll(() => requests.filter((request) => request.operation === "getWorkspaceEnvironment").length)
        .toBeGreaterThan(environmentRequestCount);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
        workspaceEvents: received.filter((frame) => String(JSON.stringify(frame.body)).includes("workspace.git.changed")),
        directRuntimeWorkspaceEvents: runtimeEvents.filter((event) => String(JSON.stringify(event)).includes("workspace.git.changed")),
        recentEvents: received.filter((frame) => frame.kind === "event").slice(-20),
        environmentRequests: requests.filter((request) => request.operation === "getWorkspaceEnvironment"),
        renderedEnvironment: await environmentPanel.textContent(),
      })}`);
    }
    await browserExpect.poll(async () => changeAction.locator("small").getAttribute("aria-label"))
      .toContain("新增 1 行，删除 0 行");
    const finalEnvironment = await port.getWorkspaceEnvironment({ workspaceDir });
    expect(finalEnvironment).toMatchObject({ isGitRepo: true, changedFiles: 1, insertions: 1, deletions: 0 });
    runtimeEventAbort.abort();
    await runtimeEventReader;
  } finally {
    runtimeEventAbort?.abort();
    releaseAnswer();
    releaseTodoAnswer();
    releaseStoppedAnswer();
    await browser?.close();
    await service?.close().catch(() => undefined);
    await browserAdapter?.close().catch(() => undefined);
    await assembled?.host.apiHost.close().catch(() => undefined);
    await new Promise((resolve) => modelServer.close(resolve));
    if (pageServer) await new Promise<void>((resolve) => pageServer!.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
    else process.env.MINIMAX_DATA_DIR = previousDataDir;
    (await import("@mavis/config")).resetConfig();
  }
}, 120_000);
