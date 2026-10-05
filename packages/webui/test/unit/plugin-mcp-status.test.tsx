// Unit tests for the MCP server status the plugin panel puts on each row.
//
// Roadmap D-3 (as transcribed): 「MCP 插件连不上时，界面上要看得见」. The row
// markup, the six-state mapping and the browser spec all landed with #27.
//
// Read the premise carefully, because it is not what it looks like. The
// runtime's `LocalMcpPublicServerStatus` does classify every server
// (available / configured / disabled / error / unavailable) — but that is the
// *MCP tool surface* (`LocalMcpPublicFacade`). The plugin page calls
// `listMcpServers` → `listConfiguredServers` → `configuredSummary`, which
// returns only `name / enabled / transport / description / endpoint /
// configJson`, with `configJson` hardcoded to `"{}"`. No `status`, no `error`,
// not even `available`. So on the real wire **every row reads 未知状态** and the
// badge will stay inert until that path carries the field. The mapping below is
// correct and the UI is in place; what is missing is upstream. The contract test
// at the end pins today's honest answer so the day the field arrives is a
// visible change rather than a silent one.
//
// The row wiring is pinned as a source-level assertion: the rows load through
// an async effect, so no static render exercises them. That assertion only
// proves the markup is still there — it cannot prove the badge works, which is
// why the browser spec exists, and why the contract test below matters more
// than either.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { describeWebuiMcpServerStatus } from "../../src/client/components/PluginManagement.js";

const SOURCE = readFileSync(
  new URL("../../src/client/components/PluginManagement.tsx", import.meta.url),
  "utf8",
);

describe("describeWebuiMcpServerStatus", () => {
  it("labels each runtime state a user can act on", () => {
    expect(describeWebuiMcpServerStatus({ status: "available" })).toMatchObject({
      key: "available",
      label: "已连接",
    });
    expect(describeWebuiMcpServerStatus({ status: "configured" })).toMatchObject({
      key: "configured",
      label: "未连接",
    });
    expect(describeWebuiMcpServerStatus({ status: "disabled" })).toMatchObject({
      key: "disabled",
      label: "已停用",
    });
    expect(describeWebuiMcpServerStatus({ status: "error" })).toMatchObject({
      key: "error",
      label: "连接失败",
    });
    expect(describeWebuiMcpServerStatus({ status: "unavailable" })).toMatchObject({
      key: "unavailable",
      label: "不可用",
    });
  });

  it("carries the failure's own reason on the two trouble states", () => {
    // The reason is the point of D-3: 连接失败 alone does not tell the user
    // whether to fix a URL, a command, or a credential. The runtime's own
    // string arrives verbatim.
    expect(
      describeWebuiMcpServerStatus({
        status: "error",
        error: "MCP_HANDSHAKE_FAILED: server sent no initialize response",
      }).reason,
    ).toBe("MCP_HANDSHAKE_FAILED: server sent no initialize response");
    expect(
      describeWebuiMcpServerStatus({
        status: "unavailable",
        errorMessage: "MCP_COMMAND_NOT_FOUND: ./missing-bin",
      }).reason,
    ).toBe("MCP_COMMAND_NOT_FOUND: ./missing-bin");
  });

  it("keeps the calm states calm and the trouble states coloured", () => {
    // The two trouble states must not share the neutral tone, or the row
    // reads as healthy at a glance — the exact failure D-3 describes.
    const neutral = describeWebuiMcpServerStatus({ status: "available" }).tone;
    expect(describeWebuiMcpServerStatus({ status: "configured" }).tone).toBe(
      describeWebuiMcpServerStatus({ status: "disabled" }).tone,
    );
    expect(describeWebuiMcpServerStatus({ status: "error" }).tone).not.toBe(neutral);
    expect(describeWebuiMcpServerStatus({ status: "unavailable" }).tone).not.toBe(neutral);
  });

  it("treats a missing or unrecognized status as unknown, without inventing a reason", () => {
    expect(describeWebuiMcpServerStatus({})).toMatchObject({
      key: "unknown",
      label: "未知状态",
    });
    // An unknown status with an error string still shows no reason: the
    // label 未知状态 claims nothing, and a reason under it would claim
    // something the reader cannot verify.
    expect(describeWebuiMcpServerStatus({ status: 7, error: "x" }).reason).toBeUndefined();
  });
});

describe("the MCP row wiring", () => {
  it("claims nothing when handed the shape the server actually returns", () => {
    // `listConfiguredServers` → `configuredSummary` produces exactly this and
    // nothing more. A row fed it must say 未知状态: any other label would be
    // claiming a state the server never sent. When `configuredSummary` starts
    // carrying the real status this test goes red, which is the point — the
    // badge is inert until then, and this is the line that says so.
    const rowAsTheServerSendsIt = {
      name: "real-shaped-stdio",
      enabled: true,
      transport: "stdio",
      description: "",
      endpoint: "",
      configJson: "{}",
    };
    expect(describeWebuiMcpServerStatus(rowAsTheServerSendsIt)).toMatchObject({
      key: "unknown",
      label: "未知状态",
    });
  });

  it("renders the status view on the row, reason included", () => {
    const statusAt = SOURCE.indexOf('data-webui-mcp-status={mcpStatus.key}');
    expect(statusAt, "the mcp row no longer renders the status chip").toBeGreaterThanOrEqual(0);
    const row = SOURCE.slice(statusAt - 600, statusAt + 900);
    expect(row).toContain('{mcpStatus.label}');
    expect(row).toContain('{mcpStatus.reason}');
    expect(row).toContain('data-webui-mcp-status-reason={mcpStatus.key}');
  });

  it("derives the view from the row item the list loads", () => {
    const deriveAt = SOURCE.indexOf("describeWebuiMcpServerStatus(item)");
    expect(deriveAt).toBeGreaterThanOrEqual(0);
    // …and inside the row map, not somewhere orphaned from rendering.
    const mapAt = SOURCE.indexOf(".map((item, index) => {");
    expect(mapAt).toBeGreaterThan(0);
    expect(deriveAt).toBeGreaterThan(mapAt);
    expect(deriveAt - mapAt).toBeLessThan(2_000);
  });
});
