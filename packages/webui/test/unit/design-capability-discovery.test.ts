import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeDesignExecution } from "@mavis/local-runtime-v2/process-local";
import { createNativeDesignExecution } from "../../../local-runtime-v2/src/application/agent/native-design-execution.js";
import { ConnectorCloudClient } from "../../../local-runtime-v2/src/service/plugin-system/app/cloud-client.js";
import { HostConnectorGateway } from "../../../local-runtime-v2/src/service/host-connector-system/gateway.js";
import { createConnectorRunner } from "../../src/runtime/design/connector-runner.mjs";
import { createAgentRunner } from "../../src/runtime/design/agent-runner.mjs";
import {
  connectorDiscoverySummary,
  connectorToolStateLabel,
} from "../../src/client/features/design/projection/design-view.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Inventory = Awaited<ReturnType<NativeDesignExecution["hostConnector"]["list"]>>;

function context(list: () => Promise<Inventory>) {
  return {
    dataDir: "/synthetic/design-discovery",
    signal: new AbortController().signal,
    hostConnector: { list: vi.fn(list), call: vi.fn(async () => ({ value: {} })) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("native Design connector discovery", () => {
  it("keeps not-connected, auth-failed and discovery-failed apart from an empty account", async () => {
    const noCredential = createConnectorRunner(
      context(async () => {
        throw Object.assign(new Error("login required"), { code: "AUTH_REQUIRED" });
      }),
    );
    await expect(noCredential.discover()).resolves.toMatchObject({
      tools: [],
      status: "not-connected",
    });

    const expired = createConnectorRunner(
      context(async () => {
        throw Object.assign(new Error("HTTP 401"), { code: "HTTP_ERROR", status: 401 });
      }),
    );
    await expect(expired.discover()).resolves.toMatchObject({
      tools: [],
      status: "auth-failed",
    });

    const failed = createConnectorRunner(
      context(async () => {
        throw Object.assign(new Error("network down"), { code: "TRANSPORT_ERROR" });
      }),
    );
    await expect(failed.discover()).resolves.toMatchObject({
      tools: [],
      status: "discovery-failed",
      message: "network down",
    });

    const empty = createConnectorRunner(context(async () => ({ tools: [], providerFailures: [], partial: false })));
    await expect(empty.discover()).resolves.toMatchObject({ tools: [], status: "ready" });
  });

  it("reports partial availability with the provider failures it was given", async () => {
    const runner = createConnectorRunner(
      context(async () => ({
        tools: [{ toolRef: "ref", name: "matrix_generate_image", inputSchema: {} }],
        providerFailures: [{ provider: "other", code: "PROVIDER_UNAVAILABLE", retryable: true }],
        partial: true,
      })),
    );
    const result = await runner.discover();
    expect(result.status).toBe("partial");
    expect(result.partial).toBe(true);
    expect(result.providerFailures).toEqual([
      { provider: "other", code: "PROVIDER_UNAVAILABLE", retryable: true },
    ]);
    expect(result.tools).toHaveLength(1);
  });

  it("surfaces the discovery state through the agent runner's per-tool catalog", async () => {
    const base = join(homedir(), ".cache/minimax-code-test-artifacts/design-discovery");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "run-"));
    cleanup.push(directory);
    const runner = createAgentRunner({
      dataDir: directory,
      signal: new AbortController().signal,
      hostConnector: {
        list: async () => ({
          tools: [{ toolRef: "ref", name: "matrix_generate_image", inputSchema: {} }],
          providerFailures: [{ provider: "other", code: "PROVIDER_UNAVAILABLE" }],
          partial: true,
        }),
        call: async () => ({ value: {} }),
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    const catalog = await runner.connectorTools();
    expect(catalog.discovery).toMatchObject({
      status: "partial",
      partial: true,
      providerFailures: [{ provider: "other", code: "PROVIDER_UNAVAILABLE" }],
    });
    const generate = catalog.tools.find((tool) => String(tool.tool).endsWith("generate_image"));
    expect(generate).toMatchObject({ granted: true, state: "granted" });
    const video = catalog.tools.find((tool) => String(tool.tool).endsWith("submit_video_generation"));
    expect(video).toMatchObject({ granted: false, state: "partial" });
  });

  it("matches the real authenticated cloud parser's tool names to the UI rows", async () => {
    const cloud = new ConnectorCloudClient({
      request: async () => ({
        tools: [
          {
            provider: "matrix",
            provider_display_name: "Matrix",
            provider_tool_name: "generate_image",
            runtime_tool_name: "matrix_generate_image",
            input_schema_json: '{"type":"object"}',
          },
        ],
        provider_failures: [
          {
            provider: "other",
            code: "PROVIDER_UNAVAILABLE",
            message: "synthetic provider failure",
            retryable: true,
          },
        ],
        partial: true,
      }),
    } as never);
    const gateway = new HostConnectorGateway({
      credentialGetter: () => ({
        accessToken: "synthetic-access",
        realUserID: "synthetic-user",
        authState: "authenticated" as const,
      }),
      client: cloud.asHostProcessClient(),
    });
    const native = createNativeDesignExecution(
      {} as NativeDesignExecution["agent"],
      gateway,
      "synthetic-authenticated",
    );
    try {
      const inventory = await native.hostConnector.list();
      expect(inventory.tools[0]?.name).toBe("matrix_generate_image");
      expect(inventory.partial).toBe(true);
      expect(inventory.providerFailures[0]).toMatchObject({
        provider: "other",
        code: "PROVIDER_UNAVAILABLE",
      });
      const base = join(homedir(), ".cache/minimax-code-test-artifacts/design-authenticated");
      await mkdir(base, { recursive: true });
      const directory = await mkdtemp(join(base, "run-"));
      cleanup.push(directory);
      const runner = createAgentRunner({
        dataDir: directory,
        signal: new AbortController().signal,
        hostConnector: native.hostConnector,
        logger: { info() {}, warn() {}, error() {} },
      });
      const catalog = await runner.connectorTools();
      expect(
        catalog.tools.find((tool) => String(tool.tool).endsWith("generate_image")),
      ).toMatchObject({ granted: true, state: "granted" });
      expect(catalog.discovery).toMatchObject({
        status: "partial",
        providerFailures: [{ provider: "other", code: "PROVIDER_UNAVAILABLE" }],
      });
    } finally {
      await native.close();
      await gateway.close();
    }
  });

  it("renders a real state instead of a blanket 'not granted' and keeps local media separate", () => {
    expect(connectorToolStateLabel({ granted: true })).toBe("可用");
    expect(connectorToolStateLabel({ granted: false, state: "not-connected" })).toBe("未连接账户");
    expect(connectorToolStateLabel({ granted: false, state: "auth-failed" })).toBe("登录已失效");
    expect(connectorToolStateLabel({ granted: false, state: "discovery-failed" })).toBe("发现失败");
    expect(connectorToolStateLabel({ granted: false, state: "partial" })).toBe("部分可用");
    expect(connectorToolStateLabel({ granted: false, state: "unsupported" })).toBe("账户未提供");
    expect(connectorDiscoverySummary({ status: "not-connected" })).toContain("未连接账户");
    expect(
      connectorDiscoverySummary({
        status: "partial",
        providerFailures: [{ provider: "other", code: "PROVIDER_UNAVAILABLE" }],
      }),
    ).toContain("other: PROVIDER_UNAVAILABLE");
  });
});
