// How one MCP server's status reads in the plugin row.
//
// Carved out of `components/plugins/PluginCatalogue.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **2 declarations**, 1 function, 1 type and constant they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

import { readWebuiPluginRow as read, type WebuiPluginRow as Row } from "../contracts/plugin-rows.js";

/**
 * One MCP server's connection state, as the row shows it.
 *
 * The runtime already classifies every server
 * (`LocalMcpPublicServerStatus`: `available` / `configured` / `disabled` /
 * `error` / `unavailable`) and attaches the failure's own reason to the two
 * trouble states — the D-3 gap was that the row rendered none of it, so a
 * server that could not connect was indistinguishable from a healthy one
 * unless you already knew to look elsewhere. `configured` is deliberately
 * NOT trouble: it means enabled and not currently connected, which is the
 * resting state of a server that connects on use.
 */
export interface WebuiMcpServerStatusView {
  readonly key:
    | "available"
    | "configured"
    | "disabled"
    | "error"
    | "unavailable"
    | "unknown";
  readonly label: string;
  readonly tone: string;
  readonly reason?: string;
}

export function describeWebuiMcpServerStatus(item: Row): WebuiMcpServerStatusView {
  const status = read(item, "status");
  const reason = read(item, "error", "errorMessage") || undefined;
  switch (status) {
    case "available":
      return { key: "available", label: "已连接", tone: "text-text_default_secondary" };
    case "configured":
      return { key: "configured", label: "未连接", tone: "text-text_default_tertiary" };
    case "disabled":
      return { key: "disabled", label: "已停用", tone: "text-text_default_tertiary" };
    case "error":
      return { key: "error", label: "连接失败", tone: "text-text_label_danger_secondary_default", reason };
    case "unavailable":
      return { key: "unavailable", label: "不可用", tone: "text-text_label_warning_secondary_default", reason };
    default:
      return { key: "unknown", label: "未知状态", tone: "text-text_default_tertiary" };
  }
}
