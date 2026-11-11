import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./harness.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
/**
 * How long the case waits for a terminal's shell to become ready.
 *
 * The shell is not ready when the terminal is: on the Windows runner the
 * PowerShell process needed about four seconds before it printed its first
 * prompt, and bytes written into the pty before that wait in the pty's
 * input buffer. A command written into that window spends the assertion's
 * five seconds on the shell's start-up instead of on the command's echo,
 * and the assertion then fails on a command that was never wrong.
 *
 * This budget is for the start-up alone. It is a precondition on the
 * write, not a longer allowance for the assertion: the assertion still
 * gets the five seconds it always had.
 */
const SHELL_READY_TIMEOUT_MS = 20_000;
/**
 * How much of that budget the shell gets to say something before it is
 * asked to run the probe. The rest is kept for the probe, so a shell that
 * has greeted us but is not reading yet is still asked with time to spare.
 */
const SHELL_SPEAK_BUDGET_MS = 10_000;
let child;
let ready;
let logs = "";
test.beforeAll(async () => {
  child = fork(path.join(root, "packages/webui/test/browser/support/native-browser-host.ts"), [], {
    execArgv: ["--import", pathToFileURL(path.join(root, "packages/webui/node_modules/tsx/dist/loader.mjs")).href],
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.standalone.json"), SHELL: process.platform === "win32" ? "powershell.exe" : "/bin/sh" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", (data) => { logs += data; });
  child.stderr.on("data", (data) => { logs += data; });
  ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => { throw new Error(`Native host exited ${code}: ${logs}`); }),
  ]);
});
/**
 * Waits for a promise, and says what the host was doing when it does not
 * arrive.
 */
async function within(promise, ms, makeError) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(makeError()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.afterAll(async () => {
  if (!child || child.exitCode !== null || !child.connected) return;
  const stopped = once(child, "message");
  child.send("close");
  // The host's own trace of where it is in the shutdown is the only thing
  // that says which step stopped answering, so a shutdown that does not
  // finish has to carry it.
  // The budget is below Playwright's own hook timeout on purpose: this
  // hook's message carries the host's trace, and a tie would leave
  // Playwright's bare "afterAll hook timeout" as the only thing said.
  const [message] = await within(
    stopped,
    25_000,
    () => new Error(`the native host did not finish closing\n${logs}`),
  );
  // The host reports the step it stopped at when its own shutdown does not
  // finish, so a stall says which step it was instead of leaving the hook
  // with a bare timeout and no way to tell what is stuck.
  expect(
    message,
    `the native host did not close${message?.stalledAt ? ` (stalled at ${message.stalledAt})` : ""}\n${logs}`,
  ).toMatchObject({ closed: true, terminals: 0 });
  // The case creates six terminals before the shutdown, so a smaller count
  // means the body failed before it got that far. Saying so keeps the
  // teardown's second complaint from reading like a second defect.
  expect(
    message.exited,
    `the host closed ${message.exited} terminals; the case creates six before the shutdown, so fewer means the body failed earlier\n${logs}`,
  ).toBeGreaterThanOrEqual(6);
  // Once the host has said it closed, it has nothing left to do and it must
  // be gone. Node-pty's Windows console-list helper cannot attach to a
  // ConPTY shell, so every terminal it kills leaves a five-second fallback
  // timer behind, and that timer used to keep the host alive long after the
  // acceptance was over — long enough for this hook to miss its deadline on a
  // loaded machine.
  await within(
    once(child, "exit"),
    2_000,
    () => new Error(`the native host did not exit\n${logs}`),
  );
});

async function rpc(page, operation, body = operation === "listTerminals" ? {} : undefined) {
  return page.evaluate(({ operation, body }) => new Promise((resolve, reject) => {
    const config = window.__WEBUI_CONFIG__;
    const url = new URL(config.websocketUrl);
    url.searchParams.set("token", config.token);
    const socket = new WebSocket(url);
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Timeout: ${operation}`)); }, 10_000);
    socket.onerror = () => { clearTimeout(timer); reject(new Error(`Socket error: ${operation}`)); };
    socket.onopen = () => socket.send(JSON.stringify({ protocolVersion: 1, kind: "request", requestId, operation, body }));
    socket.onmessage = ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.requestId !== requestId) return;
      clearTimeout(timer); socket.close();
      if (frame.kind === "error") reject(new Error(`${frame.code}: ${frame.message}`));
      else resolve(frame.body);
    };
  }), { operation, body });
}
async function openTerminal(page) {
  await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" }).click();
  await page.getByTestId("workspace-launcher-tile-terminal").click();
}
/**
 * Waits until a terminal's shell is ready to take a command.
 *
 * Two signals, because they answer two different questions.
 *
 * The first is the shell's own output, read before this case has written
 * anything into the terminal, so what it shows is the shell's greeting and
 * not this case's own echo. It needs no prompt text: a shell that has
 * printed something has started, and PowerShell's prompt and sh's prompt
 * differ, so a wait that matched prompt text would only ever hold for one
 * shell. A shell that greets late is not a failure on its own, so this
 * step only records what it saw.
 *
 * The second is a probe the shell executes, and it is the step that proves
 * the shell is ready, because "the shell has started" is not yet "the
 * shell is reading". On the Windows runner the prompt arrived about a
 * second before the shell rendered the line that had been typed into it, so
 * a wait that stopped at the prompt would still write into a shell that was
 * not reading yet.
 *
 * The probe's marker is split across the probe the same way the command's
 * marker is split below, so the shell's echo of the probe's own text
 * cannot pass for an answer: only the shell's execution of it can.
 *
 * The probe is the only platform-specific part of the wait, and both
 * branches carry the same marker, so the question the wait asks -- did
 * the shell run this and print the answer -- is the same question on every
 * platform. Only the syntax differs, because PowerShell and sh do not
 * take the same command; the probe splits its literal for the same reason
 * the command below splits its own.
 *
 * A wait that runs out says what it was waiting for and shows the output
 * the terminal did produce, because "the shell never answered" on its own
 * leaves nothing to go on.
 */
async function waitForShellReady(page, terminalId) {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  const readOutput = async () => (await rpc(page, "listTerminals"))
    .find((entry) => entry.terminalId === terminalId)?.output ?? "";
  let greetingFailure;
  let greeted = false;
  try {
    await expect
      .poll(readOutput, {
        timeout: Math.min(SHELL_SPEAK_BUDGET_MS, Math.max(1, deadline - Date.now())),
        message: `the shell of terminal ${terminalId} printed nothing`,
      })
      .not.toBe("");
    greeted = true;
  } catch (error) {
    // A shell that greets late is not a failure by itself: the probe below
    // is what decides, and it still has budget. The reason is kept so a
    // failure below can say which of the two signals went missing.
    greetingFailure = error;
  }
  const marker = "WEBUI_READY_PROBE";
  const probe = process.platform === "win32"
    ? "Write-Output ('WEBUI_READY_' + 'PROBE')\r"
    : "printf 'WEBUI_READY_%s\\n' PROBE\r";
  await rpc(page, "writeTerminal", { terminalId, data: probe });
  try {
    await expect
      .poll(readOutput, {
        timeout: Math.max(1, deadline - Date.now()),
        message: `the shell of terminal ${terminalId} never executed the readiness probe`,
      })
      .toContain(marker);
  } catch (error) {
    throw new Error(`the shell of terminal ${terminalId} was not ready within ${SHELL_READY_TIMEOUT_MS}ms, so the command would have been typed into a shell that was not reading yet; the shell ${greeted ? "had greeted us but" : "never greeted us, and"} the probe ${JSON.stringify(probe)} never produced ${marker}, and the terminal's output was ${JSON.stringify(await readOutput())}\n${greetingFailure ? `${greetingFailure.message}\n` : ""}${error.message}`);
  }
}

test("V04/V06: native PTYs survive another page, reload and a full five-slot roster", async ({ page, context }) => {
  test.setTimeout(90_000);
  const wire = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)); if (["listSessions", "getSessionTree"].includes(frame.operation)) wire.push(frame); });
    socket.on("framereceived", ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.kind === "error" || frame.body?.sessions) wire.push(frame); });
  });
  await page.goto(ready.url);
  await expect(page.locator("#webui-root")).toBeVisible();
  expect(await rpc(page, "version")).toMatchObject({ version: "webui-native-acceptance" });
  const created = { session: { sessionId: ready.sessionId } };
  const url = ready.url;
  await expect(page.locator(`[data-webui-session-link="${created.session.sessionId}"]`)).toHaveAttribute("data-webui-session-active", "true")
    .catch((error) => { throw new Error(`${error.message}\n${JSON.stringify(wire)}`); });
  await openTerminal(page);
  // The terminal tab asked the runtime for a terminal, and the runtime made
  // one: there is no separate "create" gesture any more.
  await expect.poll(async () => (await rpc(page, "listTerminals")).length).toBe(1)
    .catch(async (error) => { throw new Error(`${error.message}\n${await page.locator("body").innerText()}`); });
  const [terminal] = await rpc(page, "listTerminals");
  const second = await context.newPage();
  await second.goto(url);
  await expect(second.locator(`[data-webui-session-link="${created.session.sessionId}"]`)).toHaveAttribute("data-webui-session-active", "true");
  await openTerminal(second);
  await expect(second.locator(".webui-xterm-host")).toBeVisible();
  await second.getByRole("button", { name: "关闭面板" }).click();
  await second.close();
  // The shell behind a terminal is not ready when the terminal is, so the
  // command below is only worth writing once the shell has answered a
  // probe. Otherwise the command waits in the pty's input buffer for the
  // shell to finish starting up, and the five seconds the assertion has are
  // spent on the start-up instead of on the answer.
  await waitForShellReady(page, terminal.terminalId);
  await rpc(page, "writeTerminal", { terminalId: terminal.terminalId, data: process.platform === "win32" ? "Write-Output ('WEBUI_NATIVE_' + 'ALIVE')\r" : "printf 'WEBUI_NATIVE_%s\\n' ALIVE\r" });
  await expect.poll(async () => (await rpc(page, "listTerminals"))[0].output).toContain("WEBUI_NATIVE_ALIVE");
  for (let index = 1; index < 5; index += 1) await rpc(page, "createTerminal", { workspaceDir: ready.workspaceDir });
  await page.reload();
  expect(await rpc(page, "listTerminals")).toHaveLength(5);
  await expect(rpc(page, "createTerminal", { workspaceDir: ready.workspaceDir })).rejects.toThrow("最多可以打开 5 个终端");
  await rpc(page, "disposeTerminal", { terminalId: terminal.terminalId });
  expect(await rpc(page, "listTerminals")).toHaveLength(4);
  await rpc(page, "createTerminal", { workspaceDir: ready.workspaceDir });
  expect(await rpc(page, "listTerminals")).toHaveLength(5);

  // V05: pause only the response after the real native process exists. The
  // creating page goes away before it receives its operation result.
  const [free] = await rpc(page, "listTerminals");
  await rpc(page, "disposeTerminal", { terminalId: free.terminalId });
  const held = once(child, "message"); child.send("hold-create"); await held;
  const latePage = await context.newPage();
  await latePage.goto(url);
  await expect(latePage.locator(`[data-webui-session-link="${created.session.sessionId}"]`)).toHaveAttribute("data-webui-session-active", "true");
  const spawned = once(child, "message");
  // The terminal tab asks for its terminal as soon as it is open, so the hold
  // has to be armed before the tab is.
  await openTerminal(latePage);
  expect((await spawned)[0]).toEqual({ created: true });
  await latePage.close();
  const released = once(child, "message"); child.send("release-create"); await released;
  await page.reload();
  const survivors = await rpc(page, "listTerminals");
  expect(survivors).toHaveLength(5);
  const latest = survivors.at(-1);
  // This terminal came from the held create above, so it carries the same
  // start-up wait as the first one: the command goes in only once the shell
  // behind it has answered.
  await waitForShellReady(page, latest.terminalId);
  await rpc(page, "writeTerminal", { terminalId: latest.terminalId, data: process.platform === "win32" ? "Write-Output ('WEBUI_LATE_' + 'ALIVE')\r" : "printf 'WEBUI_LATE_%s\\n' ALIVE\r" });
  await expect.poll(async () => (await rpc(page, "listTerminals")).find((entry) => entry.terminalId === latest.terminalId).output)
    .toContain("WEBUI_LATE_ALIVE");
  await rpc(page, "disposeTerminal", { terminalId: latest.terminalId });
  expect(await rpc(page, "listTerminals")).toHaveLength(4);
});
