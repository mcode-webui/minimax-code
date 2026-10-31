import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./harness.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
let child;
let ready;
let logs = "";
test.beforeAll(async () => {
  child = fork(path.join(root, "packages/webui/test/browser/support/native-browser-host.ts"), [], {
    execArgv: ["--import", path.join(root, "packages/webui/node_modules/tsx/dist/loader.mjs")],
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.standalone.json"), SHELL: "/bin/sh" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", (data) => { logs += data; });
  child.stderr.on("data", (data) => { logs += data; });
  ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => { throw new Error(`Native host exited ${code}: ${logs}`); }),
  ]);
});
test.afterAll(async () => {
  if (!child || child.exitCode !== null || !child.connected) return;
  const stopped = once(child, "message");
  child.send("close");
  const [message] = await stopped;
  expect(message).toMatchObject({ closed: true, terminals: 0 });
  expect(message.exited).toBeGreaterThanOrEqual(6);
  await once(child, "exit");
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
  await rpc(page, "writeTerminal", { terminalId: terminal.terminalId, data: "printf 'WEBUI_NATIVE_%s\\n' ALIVE\r" });
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
  await rpc(page, "writeTerminal", { terminalId: latest.terminalId, data: "printf 'WEBUI_LATE_%s\\n' ALIVE\r" });
  await expect.poll(async () => (await rpc(page, "listTerminals")).find((entry) => entry.terminalId === latest.terminalId).output)
    .toContain("WEBUI_LATE_ALIVE");
  await rpc(page, "disposeTerminal", { terminalId: latest.terminalId });
  expect(await rpc(page, "listTerminals")).toHaveLength(4);
});
