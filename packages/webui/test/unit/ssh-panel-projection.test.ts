/**
 * The SSH panel's projection and its rendered branches.
 *
 * The claims are about what the panel says:
 *
 *   * the two Desktop empty states stay apart — "no host in `~/.ssh/config`" and "no host added
 *     and enabled yet" are different answers, and a panel that merges them sends the person to
 *     the wrong place;
 *   * a host's status word is printed as it is, so a host in `probe_failed` never reads as a
 *     working one;
 *   * the rendered branches are pinned through `renderToStaticMarkup` — this package has no jsdom.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  webuiSshDiscoveredHostRows,
  webuiSshDiscoveryEmptyText,
  webuiSshErrorMessage,
  webuiSshHostRows,
  webuiSshProjectRows,
  webuiSshStatusLabel,
  WEBUI_SSH_CONFIG_UNREADABLE_TEXT,
  WEBUI_SSH_NO_CONFIG_TEXT,
  WEBUI_SSH_NO_CONNECTIONS_TEXT,
  WEBUI_SSH_NO_HOSTS_TEXT,
} from "../../src/client/features/ssh/projection/ssh-panel.js";
import { SshPanelView } from "../../src/client/features/ssh/ui/SshPanel.public.js";
import type {
  WebuiSshConnection,
  WebuiSshDiscovery,
  WebuiSshProject,
} from "../../src/shared/contracts/ssh.js";

function connection(overrides: Partial<WebuiSshConnection> = {}): WebuiSshConnection {
  return {
    alias: "build",
    displayName: "Build machine",
    endpoint: { kind: "manual", host: "example.com", port: 2222, username: "builder" },
    enabled: true,
    status: "connected",
    ...overrides,
  };
}

describe("the SSH projection", () => {
  it("keeps the two empty states apart", () => {
    expect(WEBUI_SSH_NO_HOSTS_TEXT).not.toBe(WEBUI_SSH_NO_CONNECTIONS_TEXT);
    expect(WEBUI_SSH_NO_HOSTS_TEXT).toContain("~/.ssh/config");
    expect(WEBUI_SSH_NO_CONNECTIONS_TEXT).toContain("设置");
  });

  it("tells the three discovery outcomes apart", () => {
    const noConfig: WebuiSshDiscovery = { configFound: false, hosts: [] };
    const noHosts: WebuiSshDiscovery = { configFound: true, hosts: [] };
    const unreadable: WebuiSshDiscovery = { configFound: false, hosts: [], error: "config_unreadable" };
    const withHosts: WebuiSshDiscovery = {
      configFound: true,
      hosts: [{ alias: "build", hostname: "build.example.com" }],
    };

    expect(webuiSshDiscoveryEmptyText(noConfig)).toBe(WEBUI_SSH_NO_CONFIG_TEXT);
    expect(webuiSshDiscoveryEmptyText(noHosts)).toBe(WEBUI_SSH_NO_HOSTS_TEXT);
    expect(webuiSshDiscoveryEmptyText(unreadable)).toBe(WEBUI_SSH_CONFIG_UNREADABLE_TEXT);
    expect(webuiSshDiscoveryEmptyText(withHosts)).toBeUndefined();
  });

  it("prints the status word as it is", () => {
    expect(webuiSshStatusLabel("probe_failed")).toBe("探测失败");
    expect(webuiSshStatusLabel("connected")).toBe("已连接");
    expect(webuiSshStatusLabel("disabled")).toBe("已停用");
  });

  it("reads a host's endpoint in one line", () => {
    const [row] = webuiSshHostRows([connection()]);
    expect(row?.endpointLabel).toBe("builder@example.com:2222");
    expect(row?.statusLabel).toBe("已连接");
  });

  it("keeps the failure reason next to the host", () => {
    const [row] = webuiSshHostRows([
      connection({ status: "probe_failed", lastError: "连接被拒绝。" }),
    ]);
    expect(row?.statusLabel).toBe("探测失败");
    expect(row?.errorLabel).toBe("连接被拒绝。");
  });

  it("names a failure in one sentence", () => {
    expect(webuiSshErrorMessage("connection_not_found")).toContain("没有找到");
    expect(webuiSshErrorMessage("invalid_input")).toContain("不合法");
    expect(webuiSshErrorMessage("something-else")).toBeTruthy();
  });

  it("lists the discovered hosts and the projects", () => {
    const discovery: WebuiSshDiscovery = {
      configFound: true,
      hosts: [{ alias: "build", hostname: "build.example.com", user: "builder", port: 2222 }],
    };
    expect(webuiSshDiscoveredHostRows(discovery)).toEqual([
      { alias: "build", endpointLabel: "builder@build.example.com:2222" },
    ]);

    const projects: WebuiSshProject[] = [
      { id: "p1", alias: "build", path: "/srv/app", displayName: "app" },
    ];
    expect(webuiSshProjectRows(projects)).toEqual([
      { id: "p1", alias: "build", path: "/srv/app", displayName: "app" },
    ]);
  });
});

describe("the SSH panel", () => {
  // The view is called as a function rather than written as JSX: this file is a `.ts`, and the
  // rendered result is the same.
  const view = (overrides: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      SshPanelView({
        snapshot: { status: "ready", connections: [], projects: [] },
        terminal: { status: "closed", output: "" },
        onRefresh: () => undefined,
        onAddHost: () => undefined,
        onToggleHost: () => undefined,
        onProbeHost: () => undefined,
        onRemoveHost: () => undefined,
        onDiscoverHosts: () => undefined,
        onAddProject: () => undefined,
        onRemoveProject: () => undefined,
        onOpenTerminal: () => undefined,
        onCloseTerminal: () => undefined,
        onTerminalInput: () => undefined,
        onRequestRemove: () => undefined,
        onCancelRemove: () => undefined,
        ...overrides,
      }),
    );

  it("shows the empty state when there is no host at all", () => {
    const markup = view();
    // The rendered markup escapes the angle brackets of "设置 > 连接 > SSH".
    expect(markup).toContain(WEBUI_SSH_NO_CONNECTIONS_TEXT.replaceAll(">", "&gt;"));
    expect(markup).toContain("data-webui-ssh-empty");
  });

  it("does not show the empty state when the read failed", () => {
    const markup = view({
      snapshot: { status: "error", connections: [], projects: [], error: "读取 SSH 主机失败。" },
    });
    expect(markup).not.toContain("data-webui-ssh-empty");
    expect(markup).toContain("读取 SSH 主机失败。");
  });

  it("shows a host with its status and its actions", () => {
    const markup = view({
      snapshot: {
        status: "ready",
        connections: [connection({ status: "probe_failed", lastError: "连接被拒绝。" })],
        projects: [],
      },
    });
    expect(markup).toContain("Build machine");
    expect(markup).toContain("探测失败");
    expect(markup).toContain("连接被拒绝。");
    expect(markup).toContain("data-webui-ssh-toggle=\"build\"");
    expect(markup).toContain("data-webui-ssh-terminal=\"build\"");
  });

  it("shows the terminal's output", () => {
    const markup = view({
      terminal: { status: "running", output: "hello from the remote shell", terminalId: "t1" },
    });
    expect(markup).toContain("hello from the remote shell");
  });
});
