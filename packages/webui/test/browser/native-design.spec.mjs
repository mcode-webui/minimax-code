import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test, attachJsonEvidence } from "./harness.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
let host,
  ready,
  logs = "";
test.beforeAll(async () => {
  host = fork(
    path.join(
      root,
      "packages/webui/test/browser/support/native-design-browser-host.ts",
    ),
    [],
    {
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.join(root, "tsconfig.standalone.json"),
        WEBUI_DESIGN_BROWSER_DATA_DIR:
          process.env.WEBUI_DESIGN_BROWSER_DATA_DIR ??
          path.join(test.info().project.outputDir, "native-design-host"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  host.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  host.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  ready = await Promise.race([
    once(host, "message").then(([message]) => message),
    once(host, "exit").then(([code]) => {
      throw new Error(`Native Design host exited ${code}: ${logs}`);
    }),
  ]);
});
test.afterAll(async () => {
  if (!host?.connected || host.exitCode !== null) return;
  const stopped = once(host, "message");
  host.send("close");
  expect((await stopped)[0], logs).toEqual({ closed: true });
});
async function authority(input) {
  const requestId = crypto.randomUUID();
  const response = new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.requestId !== requestId) return;
      host.off("message", listener);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    host.on("message", listener);
  });
  host.send({ requestId, input });
  return response;
}
async function rpc(page, operation, body) {
  return page.evaluate(
    ({ operation, body }) =>
      new Promise((resolve, reject) => {
        const config = window.__WEBUI_CONFIG__,
          url = new URL(config.websocketUrl);
        url.searchParams.set("token", config.token);
        const socket = new WebSocket(url),
          requestId = crypto.randomUUID(),
          timer = setTimeout(() => {
            socket.close();
            reject(new Error(`Timeout: ${operation}`));
          }, 15_000);
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`Socket error: ${operation}`));
        };
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              protocolVersion: 1,
              kind: "request",
              requestId,
              operation,
              body,
            }),
          );
        socket.onmessage = ({ data }) => {
          const frame = JSON.parse(data);
          if (frame.requestId !== requestId) return;
          clearTimeout(timer);
          socket.close();
          if (frame.kind === "error")
            reject(new Error(`${frame.code}: ${frame.message}`));
          else resolve(frame.body);
        };
      }),
    { operation, body },
  );
}
async function read(page) {
  const documentId = await page
    .getByTestId("design-surface")
    .getAttribute("data-design-document");
  return rpc(page, "getDesignState", {
    sessionId: ready.sessionId,
    ...(documentId ? { documentId } : {}),
  });
}
async function saved(page, predicate) {
  // A design write crosses the runtime and comes back, and a loaded runner
  // can take longer than the default poll allows. The wait is for the write
  // to land, not for it to be quick.
  await expect
    .poll(async () => predicate(await read(page)), { timeout: 30_000 })
    .toBe(true);
  return read(page);
}
async function choose(page, name, label) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
async function add(page, label) {
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page
    .getByRole("menuitem", {
      name: label.replace(/^(输入|生成)/u, "$1 · "),
      exact: true,
    })
    .click();
}
async function photograph(page, name) {
  await expect(page.locator(".webui-design .webui-skeleton")).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.load('14px "HarmonyOS Sans"');
    await document.fonts.ready;
  });
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
async function dark(page, enabled) {
  await expect(page.getByTestId("design-surface").first()).toBeVisible();
  for (let index = 0; index < 3; index += 1) {
    if (
      await page
        .getByRole("button", {
          name: `主题：${enabled ? "暗色" : "亮色"}`,
          exact: true,
        })
        .count()
    )
      break;
    await page.getByRole("button", { name: /^主题：/ }).click();
  }
  await expect(page.locator("html")).toHaveClass(
    new RegExp(enabled ? "dark" : "light"),
  );
}
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
const center = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

test("native Design preserves original menus, selected operations, graph gestures and production tool presentation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(ready.url);
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "MiniMax Design", exact: true }).click();
  const design = await opened;
  design.on("pageerror", (error) => errors.push(error.message));
  await expect(design).toHaveURL(/\/design\?/);
  await dark(design, false);
  await photograph(design, "design-empty-light");
  await dark(design, true);
  await photograph(design, "design-empty-dark");
  await dark(design, false);
  await add(design, "输入文本");
  let state = await saved(
    design,
    (value) => value.document?.nodes.length === 1,
  );
  const inputId = state.document.nodes[0].id,
    documentId = state.document.id;
  const input = design.locator(`[data-design-node="${inputId}"]`);
  await expect(input).toHaveAttribute("data-selected", "true");
  await input
    .getByRole("textbox", { name: "输入文本", exact: true })
    .fill("一只在花园喝茶的小章鱼，柔和的晨光。");
  await design.locator(".webui-design-brand").click();
  await saved(design, (value) =>
    value.document.nodes[0].metadata.prompt.includes("柔和的晨光"),
  );
  await input.click({ button: "right", position: { x: 30, y: 30 } });
  await design.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await input.getByRole("textbox", { name: "节点名称" }).fill("创作想法");
  await design.keyboard.press("Enter");
  await saved(design, (value) => value.document.nodes[0].title === "创作想法");
  await add(design, "生成图片");
  state = await saved(design, (value) => value.document.nodes.length === 2);
  const imageId = state.document.nodes.find((node) => node.type === "image").id;
  const image = design.locator(`[data-design-node="${imageId}"]`);
  await expect(image).toHaveAttribute("data-selected", "true");
  await expect(image.locator(".webui-design-node-ops")).toBeVisible();
  await design.getByRole("button", { name: "工具", exact: true }).click();
  await expect(
    design.getByText("这个节点类型没有工具。", { exact: true }),
  ).toBeVisible();
  await design.keyboard.press("Escape");
  // Runtime positioning separates cards; the actual pointer still creates the connection.
  await rpc(design, "applyDesignAction", {
    sessionId: ready.sessionId,
    documentId,
    action: {
      type: "update_node",
      nodeId: inputId,
      patch: { position: { x: 80, y: 100 } },
    },
  });
  await rpc(design, "applyDesignAction", {
    sessionId: ready.sessionId,
    documentId,
    action: {
      type: "update_node",
      nodeId: imageId,
      patch: { position: { x: 650, y: 100 } },
    },
  });
  await saved(
    design,
    (value) =>
      value.document.nodes.find((node) => node.id === imageId).position.x ===
      650,
  );
  await expect
    .poll(() => image.evaluate((element) => parseFloat(element.style.left)))
    .toBe(650);
  await drag(
    design,
    center(await input.locator('[data-design-port="output"]').boundingBox()),
    center(
      await image
        .locator('[data-design-port="input"][data-port-kind="text"]')
        .boundingBox(),
    ),
  );
  state = await saved(design, (value) =>
    value.document.connections.some(
      (line) => line.fromNodeId === inputId && line.toNodeId === imageId,
    ),
  );
  await image.click({ position: { x: 70, y: 70 } });
  await expect(
    image.getByRole("textbox", { name: "提示词 · 来自上游" }),
  ).toContainText("柔和的晨光");
  await design.getByRole("button", { name: "重置视图", exact: true }).click();
  const normalView = await design.getByTestId("design-viewport").boundingBox();
  await design.mouse.move(normalView.x + 20, normalView.y + 20);
  await design.mouse.wheel(0, 350);
  await expect
    .poll(async () => {
      const card = await image.boundingBox(),
        ops = await image.locator(".webui-design-node-ops").boundingBox(),
        view = await design.getByTestId("design-viewport").boundingBox();
      return card.y >= view.y && ops.y + ops.height <= view.y + view.height;
    })
    .toBe(true);
  await photograph(design, "design-graph-light");
  const before = await image.boundingBox();
  await design.getByRole("button", { name: "主题：亮色", exact: true }).click();
  await expect(design.getByTestId("design-viewport")).toHaveJSProperty(
    "scrollTop",
    0,
  );
  expect(await image.boundingBox()).toEqual(before);
  await photograph(design, "design-graph-dark");
  await design.setViewportSize({ width: 480, height: 900 });
  await expect
    .poll(async () => {
      const ops = await image.locator(".webui-design-node-ops").boundingBox(),
        view = await design.getByTestId("design-viewport").boundingBox();
      return ops.x >= view.x && ops.x + ops.width <= view.x + view.width;
    })
    .toBe(true);
  await photograph(design, "design-narrow-dark");
  await design.setViewportSize({ width: 1440, height: 1000 });
  await design.getByRole("button", { name: "小地图", exact: true }).click();
  await expect(design.locator("[data-design-minimap-viewport]")).toBeVisible();
  await design.getByRole("button", { name: "模板", exact: true }).click();
  await expect(
    design.getByRole("dialog", { name: "模板", exact: true }),
  ).toBeVisible();
  await expect(design.locator(".webui-modal-scrim")).toHaveCount(0);
  await photograph(design, "design-template-dropdown-dark");
  await design
    .getByRole("button", { name: "保存为我的模板", exact: false })
    .click();
  await design
    .getByRole("textbox", { name: "这个模板叫什么" })
    .fill("晨光创作链");
  await design.keyboard.press("Enter");
  await saved(design, (value) =>
    value.templates.some((template) => template.title === "晨光创作链"),
  );
  await design.keyboard.press("Escape");
  for (const dismissal of ["cancel", "escape", "backdrop"]) {
    await design.getByRole("button", { name: "模板", exact: true }).click();
    await expect(
      design.getByRole("dialog", { name: "删除模板", exact: true }),
    ).toHaveCount(0);
    await design
      .getByRole("button", { name: "删除模板 晨光创作链", exact: true })
      .click();
    const confirmation = design.getByRole("dialog", {
      name: "删除模板",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    if (dismissal === "cancel")
      await confirmation
        .getByRole("button", { name: "取消", exact: true })
        .click();
    else if (dismissal === "escape") await design.keyboard.press("Escape");
    else
      await design
        .locator("[data-webui-dialog-scrim]")
        .click({ position: { x: 4, y: 4 } });
    await expect(confirmation).toBeHidden();
    expect(
      (await read(design)).templates.some(
        (template) => template.title === "晨光创作链",
      ),
    ).toBe(true);
  }
  await design.getByRole("button", { name: "模板", exact: true }).click();
  await expect(
    design.getByRole("dialog", { name: "删除模板", exact: true }),
  ).toHaveCount(0);
  await design
    .getByRole("button", { name: "删除模板 晨光创作链", exact: true })
    .click();
  await design
    .getByRole("button", { name: "确认删除模板", exact: true })
    .click();
  await saved(
    design,
    (value) =>
      !value.templates.some((template) => template.title === "晨光创作链"),
  );
  await design.getByRole("button", { name: "模板", exact: true }).click();
  await expect(
    design.getByRole("dialog", { name: "删除模板", exact: true }),
  ).toHaveCount(0);
  await design.keyboard.press("Escape");
  // Return to the conversation before exercising the tool's presentation.
  // A headed browser may throttle the conversation while the Design popup is active.
  await page.bringToFront();
  const turn = await authority({ action: "open", documentId });
  expect(turn.acceptance).toEqual({
    registeredTool: true,
    productionTurn: true,
  });
  expect(turn.openIntent).toMatchObject({ sessionId: ready.sessionId, documentId });
  const panel = page.getByTestId("workspace-panel");
  await expect(panel.getByTestId("design-surface")).toHaveAttribute(
    "data-design-document",
    documentId,
  );
  await dark(page, false);
  await photograph(page, "design-right-panel-light");
  await dark(page, true);
  await panel.getByRole("button", { name: "重置视图", exact: true }).click();
  const rightImage = panel.locator(`[data-design-node="${imageId}"]`);
  await rightImage.click({ position: { x: 30, y: 30 } });
  await photograph(page, "design-right-panel-dark");
  await design.bringToFront();
  await design.reload();
  await expect(design.locator("[data-design-edge]")).toHaveCount(1);
  state = await read(design);
  expect(state.document.nodes.find((node) => node.id === inputId).title).toBe(
    "创作想法",
  );
  // Synthetic runtime error setup; the recovery actions themselves use real pointer/clipboard paths.
  await rpc(design, "applyDesignAction", {
    documentId,
    sessionId: ready.sessionId,
    action: {
      type: "update_node",
      nodeId: imageId,
      patch: {
        metadata: {
          output: {
            status: "error",
            error: "Synthetic error for real recovery controls",
          },
        },
      },
    },
  });
  await expect(image.locator(".webui-design-node-error")).toContainText(
    "Synthetic error for real recovery controls",
  );
  await image.click({ position: { x: 30, y: 30 } });
  await design
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(design.url()).origin,
    });
  await image
    .locator(".webui-design-node-error")
    .getByRole("button", { name: "上报", exact: true })
    .click();
  // The report itself is written with LF. The Windows clipboard answers
  // with CRLF, so the two are compared as the same text.
  const reported = await design.evaluate(() => navigator.clipboard.readText());
  expect(reported.replace(/\r\n/g, "\n")).toBe(
    `节点：图片\nID：${imageId}\n错误：Synthetic error for real recovery controls`,
  );
  await photograph(design, "design-error-controls-dark");
  await image
    .locator(".webui-design-node-error")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await saved(
    design,
    (value) =>
      value.document.nodes.find((node) => node.id === imageId).metadata.output
        .error === "",
  );
  // Ordinary board navigation flushes the last keystroke before changing scope.
  await input.click({ position: { x: 30, y: 30 } });
  await input
    .getByRole("textbox", { name: "输入文本", exact: true })
    .fill("切换画布前的最后输入");
  await design.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await rpc(design, "getDesignState", {
            documentId,
            sessionId: ready.sessionId,
          })
        ).document.nodes.find((node) => node.id === inputId).metadata.prompt,
    )
    .toBe("切换画布前的最后输入");
  // A real browser departure before the debounce persists a compact native draft.
  const closing = await design.context().newPage(),
    closeUrl = new URL(design.url());
  closeUrl.searchParams.set("document", documentId);
  await closing.goto(closeUrl.href);
  await closing
    .locator(`[data-design-node="${inputId}"]`)
    .click({ position: { x: 30, y: 30 } });
  await closing
    .getByRole("textbox", { name: "输入文本", exact: true })
    .fill("离开页面前的最后输入");
  closing.on("dialog", (dialog) => dialog.accept());
  await closing.goto("about:blank");
  await expect
    .poll(
      async () =>
        (
          await rpc(design, "getDesignState", {
            documentId,
            sessionId: ready.sessionId,
          })
        ).draft?.document.nodes.find((node) => node.id === inputId)?.metadata
          .prompt,
    )
    .toBe("离开页面前的最后输入");
  await closing.close();
  await attachJsonEvidence("design-parity-graph.json", {
    state,
    toolAcceptance: turn.acceptance,
    errors,
  });
  expect(errors).toEqual([]);
});

test("native Design uploads a real >256KiB image through the browser file input and reads it back", async ({ page }) => {
  const created = await authority({ action: "create", title: "大图上传验收" });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  await add(page, "输入图片");
  const state = await saved(page, (value) => value.document.nodes.length === 1);
  const nodeId = state.document.nodes[0].id;
  const card = page.locator(`[data-design-node="${nodeId}"]`);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 700;
    const paint = canvas.getContext("2d");
    const pixels = paint.createImageData(canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      pixels.data[index] = (index * 31) % 255;
      pixels.data[index + 1] = (index * 17) % 255;
      pixels.data[index + 2] = (index * 7) % 255;
      pixels.data[index + 3] = 255;
    }
    paint.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  expect(Buffer.byteLength(base64, "base64")).toBeGreaterThan(256 * 1024);
  await card.locator('input[type="file"]').setInputFiles({
    name: "design-large-upload.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  const uploaded = await saved(page, (value) => value.document.nodes[0].metadata.output.media.length === 1);
  const media = uploaded.document.nodes[0].metadata.output.media[0];
  const token = new URL(ready.url).searchParams.get("token");
  const response = await fetch(new URL(`${media.url}?token=${encodeURIComponent(token)}`, ready.url));
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(256 * 1024);
  await page.screenshot({ path: test.info().outputPath("native-large-upload.png"), animations: "disabled" });
});

test("native Design capability panel reports real connector discovery instead of a blanket not-granted state", async ({ page }) => {
  const created = await authority({ action: "create", title: "能力清单验收" });
  const documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  url.hash = "";
  await page.goto(url.href);
  await expect(page.getByTestId("design-surface")).toBeVisible();
  await page.getByRole("button", { name: "能力清单", exact: true }).click();
  const cloud = page
    .locator(".webui-design-panel-section")
    .filter({ hasText: "云 provider 连接器（按账户连接发现）" });
  await expect(cloud).toBeVisible();
  await expect(cloud).not.toContainText("宿主按安装授予");
  await expect(cloud.locator("p").first()).toContainText(
    /未连接账户|登录已失效|连接器发现失败|账户连接器/,
  );
  await expect(
    page
      .locator(".webui-design-panel-section")
      .filter({ hasText: "本机媒体能力（不依赖云 provider）" }),
  ).toBeVisible();
  await cloud.locator("h3").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("native-capability-discovery.png"),
    animations: "disabled",
  });
});

test("native Design processes real local media through in-card crop, grid, clip and reference-aware library", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = await authority({
      action: "create",
      title: "本机素材交互验收",
    }),
    documentId = created.document.id;
  const url = new URL(ready.url);
  url.pathname = "/design";
  url.searchParams.set("session", ready.sessionId);
  url.searchParams.set("document", documentId);
  await page.goto(url.href);
  await dark(page, true);
  await add(page, "输入图片");
  let state = await saved(page, (value) => value.document.nodes.length === 1);
  const sourceId = state.document.nodes[0].id,
    card = page.locator(`[data-design-node="${sourceId}"]`);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const paint = canvas.getContext("2d");
    paint.fillStyle = "#c4ded4";
    paint.fillRect(0, 0, 160, 120);
    paint.fillStyle = "#955f94";
    paint.fillRect(35, 25, 75, 65);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await card.locator('input[type="file"]').setInputFiles({
    name: "design-synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await saved(
    page,
    (value) => value.document.nodes[0].metadata.output.media.length === 1,
  );
  await card.locator('[data-design-tool="crop"]').click();
  const crop = page.getByLabel("剪裁区域"),
    bounds = await crop.boundingBox();
  await drag(
    page,
    { x: bounds.x + bounds.width * 0.2, y: bounds.y + bounds.height * 0.2 },
    { x: bounds.x + bounds.width * 0.8, y: bounds.y + bounds.height * 0.8 },
  );
  await photograph(page, "design-crop-selection-dark");
  await page.getByRole("button", { name: "完成裁剪", exact: true }).click();
  state = await saved(page, (value) =>
    value.document.nodes.some((node) => node.type === "result"),
  );
  expect(
    state.document.nodes.filter((node) => node.type === "result"),
  ).toHaveLength(1);
  await card.click({ position: { x: 30, y: 30 } });
  await card.locator('[data-design-tool="gridSplit"]').click();
  await page.getByRole("spinbutton", { name: "行", exact: true }).fill("2");
  await page.getByRole("spinbutton", { name: "列", exact: true }).fill("2");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  state = await saved(
    page,
    (value) =>
      value.document.nodes.filter((node) => node.type === "result").length ===
        5 &&
      value.document.nodes.filter((node) => node.width === 240).length === 4,
  );
  const firstGridIds = state.document.nodes
    .filter((node) => node.type === "result" && node.width === 240)
    .map((node) => node.id);
  await expect
    .poll(async () => {
      const current = await read(page),
        tiles = current.document.nodes.filter((node) =>
          firstGridIds.includes(node.id),
        );
      return [
        new Set(tiles.map((node) => node.position.x)).size,
        new Set(tiles.map((node) => node.position.y)).size,
      ];
    })
    .toEqual([2, 2]);
  await expect(
    page.locator('[data-design-node][data-selected="true"]'),
  ).toHaveCount(4);
  await page.getByRole("button", { name: "重置视图", exact: true }).click();
  await photograph(page, "design-grid-2x2-dark");
  await card.click({ position: { x: 30, y: 30 } });
  await card.locator('[data-design-tool="gridSplit"]').click();
  await page.getByRole("spinbutton", { name: "行", exact: true }).fill("3");
  await page.getByRole("spinbutton", { name: "列", exact: true }).fill("3");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  state = await saved(
    page,
    (value) =>
      value.document.nodes.filter((node) => node.type === "result").length ===
      14,
  );
  await expect(
    page.locator('[data-design-node][data-selected="true"]'),
  ).toHaveCount(9);
  const gridIds = await page
    .locator('[data-design-node][data-selected="true"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-design-node")),
    );
  await expect
    .poll(async () => {
      const current = await read(page),
        tiles = current.document.nodes.filter((node) =>
          gridIds.includes(node.id),
        );
      return [
        new Set(tiles.map((node) => node.position.x)).size,
        new Set(tiles.map((node) => node.position.y)).size,
        tiles.every((node) => node.width === 240),
      ];
    })
    .toEqual([3, 3, true]);
  const products = state.document.nodes.filter(
    (node) => node.type === "result",
  );
  expect(
    new Set(products.map((node) => `${node.position.x},${node.position.y}`))
      .size,
  ).toBe(14);
  await page.getByRole("button", { name: "重置视图", exact: true }).click();
  await photograph(page, "design-media-overview-dark");
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  await expect(
    page.getByText("画布在用", { exact: false }).first(),
  ).toBeVisible();
  await photograph(page, "design-library-dark");
  // The pane's own transform says where the pane's centre is, and the
  // pane places an inserted node there. The rounding is the pane's own
  // rounding, so the two agree on the pixel and not on its neighbourhood.
  const insertPosition = await page
    .getByTestId("design-viewport")
    .evaluate((element) => {
      const matrix = new DOMMatrix(
        getComputedStyle(element.querySelector(".webui-design-world"))
          .transform,
      );
      return {
        x: Math.round((element.clientWidth / 2 - matrix.e) / matrix.a) - 150,
        y: Math.round((element.clientHeight / 2 - matrix.f) / matrix.a) - 90,
      };
    });
  const libraryItem = page
    .locator(".webui-design-library-item")
    .filter({ has: page.locator("img") })
    .first();
  const assetSource = await libraryItem.locator("img").getAttribute("src");
  const assetName =
    new URL(assetSource ?? "/", "http://library.invalid").pathname.split("/").pop() ?? "";
  await libraryItem.getByRole("button", { name: "插入", exact: true }).click();
  // The inserted node is the one the insert selected. "The node that is
  // new" is not the same node: the media tool's tiles keep arriving after
  // the split, and a tile that lands after this point is new too, and it
  // carries the very file the library item names.
  let insertedId = "";
  await expect
    .poll(
      async () => {
        const selected = page.locator('[data-design-node][data-selected="true"]');
        if ((await selected.count()) !== 1) return "";
        insertedId = (await selected.getAttribute("data-design-node")) ?? "";
        return insertedId;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  state = await saved(
    page,
    (value) => value.document.nodes.some((node) => node.id === insertedId),
  );
  const inserted = state.document.nodes.find((node) => node.id === insertedId);
  expect(inserted.metadata.output.media ?? []).toHaveLength(1);
  expect(String(inserted.metadata.output.media[0].url ?? "")).toContain(assetName);
  expect(inserted.position.x).toBeCloseTo(insertPosition.x, 0);
  expect(inserted.position.y).toBeCloseTo(insertPosition.y, 0);
  await expect(
    page.locator(`[data-design-node="${inserted.id}"]`),
  ).toHaveAttribute("data-selected", "true");
  const videoPath = test.info().outputPath("synthetic-source.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:r=10:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      videoPath,
    ],
    { stdio: "pipe" },
  );
  await add(page, "输入视频");
  state = await saved(page, (value) =>
    value.document.nodes.some(
      (node) => node.type === "input" && node.metadata.kind === "video",
    ),
  );
  const videoId = state.document.nodes.find(
      (node) => node.type === "input" && node.metadata.kind === "video",
    ).id,
    video = page.locator(`[data-design-node="${videoId}"]`);
  await video.locator('input[type="file"]').setInputFiles({
    name: "synthetic-source.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(videoPath),
  });
  await saved(
    page,
    (value) =>
      value.document.nodes.find((node) => node.id === videoId).metadata.output
        .media.length === 1,
  );
  await video.locator('[data-design-tool="trim"]').click();
  await expect(page.getByRole("dialog", { name: /剪|截/ })).toBeVisible();
  await photograph(page, "design-clip-strip-dark");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  state = await saved(
    page,
    (value) =>
      value.document.nodes.filter(
        (node) => node.type === "result" && node.metadata.kind === "video",
      ).length === 1,
  );
  await photograph(page, "design-media-results-dark");
  await attachJsonEvidence("design-parity-media.json", { state, errors });
  expect(errors).toEqual([]);
});
