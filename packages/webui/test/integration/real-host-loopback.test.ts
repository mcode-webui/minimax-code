// The real-host loopback path: the production WebUI chain, end to end, in one
// process and against a real runtime host in an isolated data directory.
//
// `loopback-harness-path.test.ts` proves the network entrance, the registry, the
// dispatcher, the envelope and shutdown — but with a scripted stand-in behind the
// port, so it cannot say whether the real host answers. This file closes that
// half for everything that does not need a model: it boots the production
// assembly (`createWebuiRuntimeHost`, whose default factory is the real
// `createLocalRuntimeHostV2`), derives the port with the real
// `createHarnessPortFromHost`, registers the real operation registry, starts a
// real `WebuiService` on a real loopback socket, and drives it with a real `ws`
// client. No service, adapter, host or result in this path is replaced.
//
// What this file does NOT establish, and must not be read as establishing: a
// model turn. A fresh data directory carries no provider credential, and driving
// a turn to a repeatable model response needs a controlled model transport,
// which is the next slice. The boundary is stated here rather than implied by a
// green run.
//
// The data directory is a temporary one. The `version` assertion pins that the
// isolated path reached the host, so a run can never fall back to the operator's
// own `~/.minimax` without failing.
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import { createWebuiRuntimeHost } from "../../src/runtime/assembly.js";
import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import { WebuiTerminalManager } from "../../src/runtime/index.js";
import {
  WebuiService,
  createOperationRegistry,
} from "../../src/server/index.js";
import { WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";
import { decodeWebuiOperationResult } from "../../src/shared/operation-codecs.js";
import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";

const CREDENTIAL_TOKEN = "real-host-loopback-token";

/**
 * The isolated data directory's config file, written before boot so the harness
 * does not copy the developer's own config in (see `bootRealHost`). Its content is
 * asserted after boot, so "the operator's config was not read" is a checked
 * property of the run rather than a comment.
 */
const CONFIG_MARKER_TEXT =
  "# webui real-host-loopback fixture — no provider entry, no credential.\n";

interface Booted {
  readonly service: WebuiService;
  readonly url: string;
  readonly tcpPort: number;
  readonly dataDir: string;
  readonly workspaceDir: string;
  readonly port: ReturnType<typeof createHarnessPortFromHost>;
  close(): Promise<void>;
}

const booted: Booted[] = [];
const previousDataDir = process.env.MINIMAX_DATA_DIR;

afterEach(async () => {
  for (const entry of booted.splice(0)) await entry.close();
  if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = previousDataDir;
});

/**
 * The production wiring of `scripts/run-webui-server.mjs`, with two deliberate
 * differences: the data directory is temporary, and `mcodeTools.prepare` is
 * stubbed — mcode-tools is a side capability the harness acquires alongside the
 * host, not part of the request path under test, and leaving it real would try
 * to install and launch a broker.
 */
async function bootRealHost(options: { readonly dev?: boolean; readonly serveBuiltClient?: boolean } = {}): Promise<Booted> {
  const dataDir = await mkdtemp(join(tmpdir(), "webui-real-host-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  // Write the config file before the host boots. `ensureConfigFile()`
  // (`packages/config/src/config.ts:1799-1805`) copies the developer's own
  // `<home>/.minimax/config.yaml` into a derived data directory that has none —
  // deliberately, so a worktree daemon inherits the developer's keys — which is
  // the one path that would pull an operator's provider entries and api key into
  // this run. A file that already exists skips the copy, and the assertion in the
  // first case checks the file is still this one.
  await writeFile(join(dataDir, "config.yaml"), CONFIG_MARKER_TEXT, {
    mode: 0o600,
  });
  // Point the config resolution at this directory too — `MINIMAX_DATA_DIR` is what
  // `getDataDir()`/`getConfigPath()` read, and `@mavis/config` caches its snapshot
  // per process, so it has to be reset for each case.
  process.env.MINIMAX_DATA_DIR = dataDir;
  (await import("@mavis/config")).resetConfig();

  const assembled = await createWebuiRuntimeHost({
    dataDir,
    appVersion: "real-host-loopback",
    mcodeTools: {
      prepare: async () => ({
        requested: false,
        ready: false,
        category: "disabled" as const,
        ensureCommandPath: () => undefined,
        dispose: async () => undefined,
      }),
    },
  });
  const port = createHarnessPortFromHost(assembled.host);
  const terminal = new WebuiTerminalManager();
  const service = new WebuiService({
    port,
    operations: createOperationRegistry(port, terminal),
    terminal,
    tcpPort: 0,
    credential: { token: CREDENTIAL_TOKEN },
    ...(options.dev ? { dev: true } : {}),
    ...(options.serveBuiltClient ? { clientDir: resolve("dist-webui/client") } : {}),
  });
  const info = await service.start();
  const entry: Booted = {
    service,
    url: `ws://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}`,
    tcpPort: info.tcpPort,
    dataDir,
    workspaceDir,
    port,
    close: async () => {
      await service.close().catch(() => undefined);
      await assembled.host.apiHost.close().catch(() => undefined);
      await removeRealHostDataDir(dataDir);
    },
  };
  booted.push(entry);
  return entry;
}

interface Client {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number }>;
  call(operation: string, body?: unknown): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  ws.on("error", () => undefined);
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.once("close", (code) => resolve({ code }));
  });
  let counter = 0;
  const call = (operation: string, body?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = `r${(counter += 1)}`;
      const onMessage = (raw: RawData) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch (error) {
          reject(error);
          return;
        }
        if (frame.requestId !== requestId) return;
        ws.off("message", onMessage);
        resolve(frame);
      };
      ws.on("message", onMessage);
      const frame: Record<string, unknown> = {
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        operation,
      };
      if (body !== undefined) frame.body = body;
      ws.send(JSON.stringify(frame));
    });
  return once(ws, "open").then(() => ({
    ws,
    closed,
    call,
    close: () => ws.close(),
  }));
}

describe("real host over the loopback service", () => {
  it("answers a session round trip from the real host in an isolated data directory", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);

    // The isolated data directory reached the real host: a run that fell back
    // to the operator's own `~/.minimax` fails right here.
    const version = await client.call("version");
    expect(version.kind).toBe("response");
    expect(version.body).toMatchObject({
        version: "real-host-loopback",
        dataDir: host.dataDir,
      });

    // The config file the host booted with is still this file: the harness did
    // not copy the developer's own `<home>/.minimax/config.yaml` into the
    // isolated directory (which is what would bring an operator's providers and
    // api key into the run).
    expect(await readFile(join(host.dataDir, "config.yaml"), "utf8")).toBe(
        CONFIG_MARKER_TEXT,
      );

    const created = await client.call("createSession", {
        name: "main",
        workspaceDir: host.workspaceDir,
      });
    expect(created.kind).toBe("response");
    const session = (
      created.body as {
        session?: { sessionId?: string; workspaceDir?: string };
      }
    ).session;
    expect(typeof session?.sessionId).toBe("string");
    expect(session?.workspaceDir).toBe(host.workspaceDir);

    // Read back through a second operation: the session really landed in the
    // host's store, rather than being a value the first response carried.
    const listed = await client.call("listSessions", { name: "main" });
    const sessions = (listed.body as { sessions?: readonly { sessionId?: string }[] }).sessions;
    expect(sessions?.map((entry) => entry.sessionId)).toContain(
      session?.sessionId,
    );

    const messages = await client.call("getMessages", {
      id: session?.sessionId,
    });
    expect(messages.kind).toBe("response");
    expect(
      (messages.body as { messages?: readonly unknown[] }).messages,
    ).toEqual([]);

    await writeFile(
      join(host.workspaceDir, "canvas-input.txt"),
      "synthetic canvas input\n",
    );
    const canvas = await client.call("applyCanvas", {
      sessionId: session?.sessionId,
      operation: {
        schemaVersion: 1,
        operationId: "webui-canvas-add",
        mutations: [
          {
            kind: "add_file",
            nodeId: "webui-file",
            relativePath: "canvas-input.txt",
            layout: { x: 0, y: 0, width: 100, height: 100, zIndex: 0 },
          },
        ],
      },
    });
    expect(canvas.kind).toBe("response");
    expect(canvas.body).toMatchObject({
      operationId: "webui-canvas-add",
      document: {
        sessionId: session?.sessionId,
        nodes: [{ id: "webui-file" }],
      },
    });
    const persistedCanvas = await client.call("readCanvas", {
      sessionId: session?.sessionId,
    });
    expect(persistedCanvas.kind).toBe("response");
    expect(persistedCanvas.body).toMatchObject({
      nodes: [{ id: "webui-file" }],
    });

    // Exercise the production MCP service through the host adapter, operation
    // registry, WebuiService and a real loopback WebSocket. The client boundary
    // decoder is the same production codec used by the mounted WebUI client.
    const mcpList = await client.call("pluginManagement", {
      action: "listMcpServers",
    });
    expect(mcpList.kind).toBe("response");
    expect(
      decodeWebuiOperationResult("pluginManagement", mcpList.body),
    ).toEqual({ servers: [] });
    client.close();
    await client.closed;
  }, 120_000);

  it("renders and submits MCP management through the built client and production runtime", async () => {
    const host = await bootRealHost({ dev: true, serveBuiltClient: true });
    const created = await host.port.createSession({ name: "main", workspaceDir: host.workspaceDir });
    const sessionId = created.session?.sessionId;
    expect(sessionId).toBeTruthy();

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
      });
      const requests: Record<string, unknown>[] = [];
      const responses: Record<string, unknown>[] = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          try {
            const frame = JSON.parse(String(payload)) as Record<string, unknown>;
            if (frame.kind === "request") requests.push(frame);
          } catch { /* Non-JSON protocol frames are not operation requests. */ }
        });
        socket.on("framereceived", ({ payload }) => {
          try {
            responses.push(JSON.parse(String(payload)) as Record<string, unknown>);
          } catch { /* Non-JSON protocol frames are not operation responses. */ }
        });
      });
      await page.goto(`http://127.0.0.1:${host.tcpPort}/?token=${CREDENTIAL_TOKEN}#session=${sessionId}`);
      const root = page.locator("#webui-root");
      const startupFallback = page.getByTestId("webui-startup-fallback");
      await browserExpect.poll(async () => await root.isVisible() || await startupFallback.isVisible())
        .toBe(true);
      if (await startupFallback.isVisible()) {
        throw new Error(`Built WebUI startup failed: ${await startupFallback.innerText()}`);
      }
      await page.getByRole("button", { name: "插件" }).first().click();
      await page.locator(".webui-plugin-manage-trigger").click();
      await page.locator('.webui-plugin-category-filter button', { hasText: "MCP" }).click();
      await browserExpect(page.getByPlaceholder("搜索MCP...")).toBeVisible();
      await browserExpect(page.getByText("暂无内容")).toBeVisible();
      await browserExpect(page.getByText(/pluginManagement returned a body/u)).toHaveCount(0);

      const listRequest = requests.find((frame) =>
        frame.operation === "pluginManagement" &&
        (frame.body as { action?: string } | undefined)?.action === "listMcpServers",
      );
      expect(listRequest).toBeDefined();
      await browserExpect.poll(() => responses.some((frame) =>
        frame.requestId === listRequest?.requestId && frame.kind === "response" &&
        JSON.stringify(frame.body).includes('"servers":[]'),
      )).toBe(true);

      await page.locator(".webui-plugin-create-trigger").click();
      await page.getByRole("menuitem", { name: "添加 MCP server" }).click();
      const dialog = page.getByRole("dialog", { name: "MCP Server" });
      await browserExpect(dialog).toBeVisible();
      const geometry = await dialog.evaluate((node) => {
        const backdrop = node.parentElement!;
        const backdropRect = backdrop.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        const fields = node.querySelector(".webui-mcp-form-fields")!;
        const controls = [...fields.querySelectorAll("input:not([type=checkbox]), select")];
        return {
          backdropFixed: getComputedStyle(backdrop).position === "fixed",
          backdropCoversViewport: backdropRect.left <= 0 && backdropRect.top <= 0 &&
            backdropRect.right >= innerWidth && backdropRect.bottom >= innerHeight,
          centered: Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 3 &&
            Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 3,
          insideViewport: rect.left >= 0 && rect.top >= 0 &&
            rect.right <= innerWidth && rect.bottom <= innerHeight,
          fieldsGrid: getComputedStyle(fields).display === "grid",
          controlsAligned: controls.length >= 3 && controls.every((control) => {
            const input = control.getBoundingClientRect();
            // The field contract owns the label, so the label is the control's
            // sibling rather than its ancestor: the field block holds both.
            const field = control.closest(".webui-field")!;
            const label = field.querySelector(".webui-field-label")!.getBoundingClientRect();
            return Math.abs(input.left - label.left) < 3 && Math.abs(input.width - label.width) < 3;
          }),
        };
      });
      expect(geometry).toEqual({
        backdropFixed: true,
        backdropCoversViewport: true,
        centered: true,
        insideViewport: true,
        fieldsGrid: true,
        controlsAligned: true,
      });
      await dialog.getByLabel("名称").fill("synthetic-disabled-mcp");
      await dialog.getByLabel("命令").fill("synthetic-mcp-command");
      await dialog.getByLabel("启用").uncheck();
      await dialog.getByRole("button", { name: "添加服务器" }).click();
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(page.locator(".webui-plugin-row").filter({ hasText: "synthetic-disabled-mcp" }))
        .toBeVisible();
      await browserExpect(page.getByText(/pluginManagement returned a body/u)).toHaveCount(0);

      const createRequest = requests.find((frame) =>
        frame.operation === "pluginManagement" &&
        (frame.body as { action?: string } | undefined)?.action === "createMcpServer",
      );
      expect(createRequest?.body).toMatchObject({
        action: "createMcpServer",
        input: {
          name: "synthetic-disabled-mcp",
          enabled: false,
          config: { transport: "stdio", command: "synthetic-mcp-command" },
        },
      });
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("answers with the registry's own error frame for a body the validator rejects", async () => {
      const host = await bootRealHost();
      const client = await connect(host.url);

      // `isGoalEnabled` takes no body; a body is refused by its descriptor
      // before any host call. The frame the service writes is the registry's,
      // not a stub's.
      const refused = await client.call("isGoalEnabled", {});
      expect(refused.kind).toBe("error");
      expect(refused.code).toBe("invalid_body");
      expect(String(refused.message)).toContain("isGoalEnabled");

      client.close();
      await client.closed;
    }, 120_000);

  it("refuses a fresh connection once the service is closed", async () => {
      const host = await bootRealHost();
      const client = await connect(host.url);
      await client.call("version");
      client.close();
      await client.closed;

      await host.service.close();

      // `events.once` rejects when the socket errors while waiting for `open`,
      // which is the refusal ECONNREFUSED this asserts — same idiom as
      // `loopback-harness-path.test.ts`.
      const refused = new WebSocket(host.url);
      refused.on("error", () => undefined);
      await expect(once(refused, "open")).rejects.toThrow();
    }, 120_000);
});
