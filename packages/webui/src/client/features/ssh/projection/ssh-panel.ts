// The SSH panel's projection: wire DTOs in, display rows out.
//
// Pure functions, so the wording of every row is testable without a DOM. The panel renders what
// this module returns and decides nothing itself.
//
// Three honesty rules live here:
//
//   * **The two empty states stay apart.** "No host was found in `~/.ssh/config`" and "no host has
//     been added and enabled yet" are different answers, and they are the two Desktop states
//     `no_hosts` and `no_connections`. One of them asks for a config file, the other asks for a
//     host in the settings.
//   * **A host that could not be reached says so.** The status word is printed as it is; a host
//     in `probe_failed` is never dressed up as a working one.
//   * **A failure names the reason.** The runtime's error codes are mapped to one sentence each,
//     so a person is told what to do rather than shown a code.
import type {
  WebuiSshConnection,
  WebuiSshDiscoveredHost,
  WebuiSshDiscovery,
  WebuiSshEndpoint,
  WebuiSshProject,
  WebuiSshStatus,
} from "../../../../shared/contracts/ssh.js";

/** No host has been added and enabled yet. Desktop's `no_connections`. */
export const WEBUI_SSH_NO_CONNECTIONS_TEXT =
  "还没有已添加并启用的 SSH 主机。请先在「设置 > 连接 > SSH」中添加并启用一个主机。";
/** The config file holds no host. Desktop's `no_hosts`. */
export const WEBUI_SSH_NO_HOSTS_TEXT =
  "没有找到主机。请先在 ~/.ssh/config 中添加 SSH 主机。";
/** There is no config file at all. */
export const WEBUI_SSH_NO_CONFIG_TEXT = "没有找到 ~/.ssh/config 文件。";
/** The config file exists but could not be read. */
export const WEBUI_SSH_CONFIG_UNREADABLE_TEXT = "无法读取 ~/.ssh/config 文件。";
/** No project is rooted on a host yet. */
export const WEBUI_SSH_NO_PROJECTS_TEXT = "还没有 SSH 项目。";
/** The terminal is not open. */
export const WEBUI_SSH_NO_TERMINAL_TEXT = "还没有打开远程终端。";
/** The host list is being read. */
export const WEBUI_SSH_LOADING_TEXT = "正在读取 SSH 主机…";

/** The refusal a host without the SSH capability gets. */
export const WEBUI_SSH_UNAVAILABLE = "这个运行时无法管理 SSH 主机（宿主没有 SSH 服务）。";
export const WEBUI_SSH_READ_FAILED = "读取 SSH 主机失败。";
export const WEBUI_SSH_FAILED = "操作 SSH 主机失败。";
export const WEBUI_SSH_DISCOVERY_FAILED = "读取 ~/.ssh/config 失败。";
export const WEBUI_SSH_TERMINAL_FAILED = "打开远程终端失败。";

export interface WebuiSshHostRow {
  readonly alias: string;
  readonly displayName: string;
  readonly endpointLabel: string;
  readonly statusLabel: string;
  readonly status: WebuiSshStatus;
  readonly enabled: boolean;
  readonly errorLabel?: string;
}

export interface WebuiSshProjectRow {
  readonly id: string;
  readonly alias: string;
  readonly path: string;
  readonly displayName: string;
}

export interface WebuiSshDiscoveredHostRow {
  readonly alias: string;
  readonly endpointLabel: string;
}

/** The status word, as the panel shows it. */
export function webuiSshStatusLabel(status: WebuiSshStatus): string {
  switch (status) {
    case "idle":
      return "未连接";
    case "connecting":
      return "连接中";
    case "connected":
      return "已连接";
    case "disconnected":
      return "已断开";
    case "reconnecting":
      return "重连中";
    case "failed":
      return "失败";
    case "probe_failed":
      return "探测失败";
    case "ready":
      return "就绪";
    case "disabled":
      return "已停用";
    default:
      return "未知";
  }
}

/** Where a host lives, in one line. */
export function webuiSshEndpointLabel(endpoint: WebuiSshEndpoint): string {
  if (endpoint.kind === "ssh_config") {
    const alias = endpoint.alias ?? "";
    const target = endpoint.host ? `${alias} (${endpoint.host})` : alias;
    return endpoint.port ? `${target}:${String(endpoint.port)}` : target;
  }
  const host = endpoint.host ?? "";
  const user = endpoint.username ? `${endpoint.username}@` : "";
  const port = endpoint.port ? `:${String(endpoint.port)}` : "";
  return `${user}${host}${port}`;
}

/** The saved hosts, as rows. */
export function webuiSshHostRows(
  connections: readonly WebuiSshConnection[],
): readonly WebuiSshHostRow[] {
  return connections.map((connection) => {
    const errorLabel = connection.lastError?.trim();
    return {
      alias: connection.alias,
      displayName: connection.displayName,
      endpointLabel: webuiSshEndpointLabel(connection.endpoint),
      statusLabel: webuiSshStatusLabel(connection.status),
      status: connection.status,
      enabled: connection.enabled,
      ...(errorLabel ? { errorLabel } : {}),
    };
  });
}

/** The projects, as rows. */
export function webuiSshProjectRows(
  projects: readonly WebuiSshProject[],
): readonly WebuiSshProjectRow[] {
  return projects.map((project) => ({
    id: project.id,
    alias: project.alias,
    path: project.path,
    displayName: project.displayName,
  }));
}

/** The hosts in `~/.ssh/config`, as rows. */
export function webuiSshDiscoveredHostRows(
  discovery: WebuiSshDiscovery | undefined,
): readonly WebuiSshDiscoveredHostRow[] {
  if (!discovery) return [];
  return discovery.hosts.map((host) => ({
    alias: host.alias,
    endpointLabel: webuiSshDiscoveredHostLabel(host),
  }));
}

/** Where a discovered host lives, in one line. */
export function webuiSshDiscoveredHostLabel(host: WebuiSshDiscoveredHost): string {
  const parts: string[] = [];
  if (host.user) parts.push(`${host.user}@`);
  parts.push(host.hostname ?? host.alias);
  if (host.port) parts.push(`:${String(host.port)}`);
  return parts.join("");
}

/**
 * What the discovery panel says when the list is empty.
 *
 * The three cases are different answers and the panel shows them apart: there is no config file,
 * the config file cannot be read, or the config file holds no host.
 */
export function webuiSshDiscoveryEmptyText(discovery: WebuiSshDiscovery | undefined): string | undefined {
  if (!discovery) return undefined;
  if (discovery.error === "config_unreadable") return WEBUI_SSH_CONFIG_UNREADABLE_TEXT;
  if (!discovery.configFound) return WEBUI_SSH_NO_CONFIG_TEXT;
  if (discovery.hosts.length === 0) return WEBUI_SSH_NO_HOSTS_TEXT;
  return undefined;
}

/**
 * The one sentence a failure gets.
 *
 * The runtime answers with a code (`invalid_input`, `connection_not_found`, …); the code is mapped
 * here so the panel never shows a bare identifier.
 */
export function webuiSshErrorMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "invalid_input":
      return "输入不合法，请检查主机地址、端口和路径。";
    case "connection_not_found":
      return "没有找到这个 SSH 主机。";
    case "project_not_found":
      return "没有找到这个 SSH 项目。";
    case "terminal_not_found":
      return "没有找到这个远程终端。";
    case "credential_unavailable":
      return "密码不可用：请重新提供一次密码。";
    case "operation_in_progress":
      return "这个主机上还有操作正在进行，请稍后重试。";
    case "ssh_not_found":
      return "系统里没有找到 ssh 命令。";
    case "storage_unavailable":
      return "SSH 配置存储不可用。";
    default:
      return fallback ?? WEBUI_SSH_FAILED;
  }
}
