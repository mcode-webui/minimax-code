// The Mini App catalogue, projected for the two surfaces that render it.
//
// Pure functions: a row list in, what a row says out. The picker and the plugin
// catalogue's apps area read the same projection, which is what makes them the
// same rows rather than two readings of the runtime that can disagree
// (ADR 0020, "Its rows and the plugin catalogue's apps area are the same rows").
//
// The runtime names five states and the row offers a different action for each,
// so the decision lives here rather than being re-derived in two components.

import { InstalledPluginSource } from "@mavis/protocol/local";

import type {
  WebuiMiniAppCatalogueRow,
  WebuiMiniAppRuntimeStatus,
} from "../../../../shared/contracts/miniapp.js";

/**
 * How many Mini Apps run at once.
 *
 * The runtime enforces it (`at most three run at once`, ADR 0020) and refuses a
 * fourth with `BUSY`. The number is repeated here only to say so in words before
 * the refusal arrives; it is not this client's rule to enforce.
 */
export const WEBUI_MINIAPP_CAPACITY = 3;

export interface WebuiMiniAppRow {
  readonly pluginId: string;
  /** The catalogue's display name, or the plugin id when it has none. */
  readonly name: string;
  readonly description: string;
  readonly iconUrl?: string;
  readonly status: WebuiMiniAppRuntimeStatus;
  /** The runtime's own failure code, when the row failed. */
  readonly errorCode?: string;
  /** The state in words, for the row. */
  readonly statusLabel: string;
  /** True while the runtime is up, which is when the row offers "stop". */
  readonly running: boolean;
  /**
   * False for a package that is installed but disabled.
   *
   * Such a row can be enabled but not started: the runtime refuses to launch a
   * disabled package, so offering "open" on it would be an action that always
   * fails.
   */
  readonly enabled: boolean;
  /**
   * Where the package came from, as the runtime says it.
   *
   * A local package and an official one are changed by different paths, so the
   * row's own buttons need this to choose: the runtime is the only party that
   * knows which one a package is.
   */
  readonly source?: "official" | "local";
  /** The runtime guard confirms another client owns this plugin's process. */
  readonly ownedElsewhere: boolean;
  /** Owner's client label, when the live process lease exposes it. */
  readonly ownerClient?: string;
  /**
   * True while a standalone presentation of this Mini App is live (ADR 0020).
   *
   * The inline view reports it and offers to switch; it does not start a second
   * presentation of the same app while this is true.
   */
  readonly detached: boolean;
  /** How many times a standalone presentation has been acquired. Moves on each. */
  readonly presentationRevision: number;
}

/** The state in words. A closed union in, a label out — never "unknown". */
export function webuiMiniAppStatusLabel(status: WebuiMiniAppRuntimeStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "starting":
      return "启动中";
    case "stopping":
      return "停止中";
    case "failed":
      return "启动失败";
    case "stopped":
      return "已停止";
  }
}

/** One catalogue answer, as the surfaces render it. */
export function webuiMiniAppRows(
  miniApps: readonly WebuiMiniAppCatalogueRow[],
): readonly WebuiMiniAppRow[] {
  return miniApps.map((miniApp) => {
    // A disabled package has no runtime state to report: it is installed and not
    // startable, which is a fact about the package rather than about a process.
    const enabled = miniApp.enabled !== false;
    return {
      pluginId: miniApp.pluginId,
      name: miniApp.displayName || miniApp.pluginId,
      description: miniApp.description ?? "",
      ...(miniApp.iconUrl !== undefined ? { iconUrl: miniApp.iconUrl } : {}),
      status: miniApp.runtime.status,
      ...(miniApp.runtime.errorCode !== undefined ? { errorCode: miniApp.runtime.errorCode } : {}),
      ...(miniApp.source !== undefined ? { source: miniApp.source } : {}),
      statusLabel: !enabled
        ? "已停用"
        : miniApp.runtime.ownership === "other-client"
          ? miniApp.runtime.ownerClient
          ? `其他客户端运行中（${miniApp.runtime.ownerClient}）`
            : "其他客户端运行中"
          : webuiMiniAppStatusLabel(miniApp.runtime.status),
      running: enabled && miniApp.runtime.status === "running",
      enabled,
      ownedElsewhere: miniApp.runtime.ownership === "other-client",
      ...(miniApp.runtime.ownerClient ? { ownerClient: miniApp.runtime.ownerClient } : {}),
      detached: miniApp.detached,
      presentationRevision: miniApp.presentationRevision,
    };
  });
}

/**
 * The browsing-context name a Mini App's standalone tab claims.
 *
 * `window.open` with a name either creates that context or focuses the one that
 * already has it, so this is the whole mechanism behind "switch to the tab
 * instead of opening a second document": the standalone surface sets its
 * `window.name` to this on mount, and the inline view opens or focuses the same
 * name. Deterministic from the plugin id because the two documents share nothing
 * but the service and this convention.
 */
export function webuiMiniAppWindowName(pluginId: string): string {
  return `webui-miniapp:${pluginId}`;
}

/** The rows that are up, in catalogue order. */
export function webuiMiniAppRunningRows(
  rows: readonly WebuiMiniAppRow[],
): readonly WebuiMiniAppRow[] {
  return rows.filter((row) => row.running);
}

/**
 * What a capacity refusal says: the limit, and which applications are using it.
 *
 * The person's next action is to stop one of them, so the refusal names them
 * rather than reporting a count — "3 running" is not something anyone can act on.
 */
export function webuiMiniAppCapacityText(rows: readonly WebuiMiniAppRow[]): string {
  const names = webuiMiniAppRunningRows(rows).map((row) => row.name);
  const running = names.length > 0 ? names.join("、") : "其他应用";
  return `同时最多运行 ${WEBUI_MINIAPP_CAPACITY} 个 Mini App，正在运行：${running}。请先停止一个再打开。`;
}

/**
 * What a refusal says, in words the person can act on.
 *
 * `OWNED_ELSEWHERE` is the runtime's answer when another client holds the app —
 * the message it carries names that client and its pid, and this client cannot
 * discover either on its own: the credential that reaches the app never leaves
 * the process that minted it, so "is it running elsewhere?" is answered by
 * trying to start it. The message is kept rather than replaced, because the
 * runtime is the only party that knows who the other client is.
 */
export function webuiMiniAppRefusalText(input: {
  readonly code: string;
  readonly message: string;
  readonly rows: readonly WebuiMiniAppRow[];
}): string {
  if (input.code === "BUSY") return webuiMiniAppCapacityText(input.rows);
  if (input.code === "OWNED_ELSEWHERE") return `已在其他客户端运行：${input.message}`;
  return input.message;
}

/**
 * The wire source a row's package is changed through.
 *
 * The runtime reads the source to pick the path: a local package is changed on
 * disk and an official one through the marketplace account. A row the runtime
 * did not give a source to keeps the old behaviour, which is the official
 * path — the runtime's own default, unchanged here.
 */
export function webuiMiniAppPluginSource(row: WebuiMiniAppRow | undefined): number | undefined {
  if (row?.source === "local") return InstalledPluginSource.LOCAL;
  if (row?.source === "official") return InstalledPluginSource.OFFICIAL;
  return undefined;
}

/**
 * What a runtime failure code says, in words.
 *
 * The runtime's codes name the failure for other programs; a person needs the
 * consequence. A code this client does not know keeps its own text, because a
 * code is still more useful than nothing.
 */
export function webuiMiniAppFailureCodeText(code: string): string {
  switch (code) {
    case "RUNNER_START_FAILED":
      return "进程启动失败";
    case "RUNTIME_START_FAILED":
      return "启动失败";
    case "RUNTIME_EXITED":
      return "进程已退出";
    case "READINESS_TIMEOUT":
      return "就绪检查超时";
    case "READINESS_PROBE_TIMEOUT":
      return "就绪探测超时";
    case "READINESS_PROBE_REJECTED":
      return "就绪探测被拒绝";
    case "TCP_CONNECT_TIMEOUT":
      return "连接超时";
    case "NO_CANDIDATE_PORT":
      return "没有可用端口";
    case "START_EXPORT_MISSING":
      return "入口没有导出启动函数";
    case "ENTRY_OUTSIDE_ARTIFACT":
      return "入口不在产物内";
    case "HOST_CONNECTOR_UNAVAILABLE":
      return "宿主连接不可用";
    case "HOST_CONNECTOR_PROTOCOL_VIOLATION":
      return "宿主连接协议不符";
    case "RUNNER_LIFECYCLE_INVALID":
      return "运行进程生命周期异常";
    case "OWNED_ELSEWHERE":
      return "已在其他客户端运行";
    case "CANDIDATE_CHANGED":
      return "候选产物已变更";
    case "ACTIVATION_FAILED":
      return "激活失败";
    case "QUARANTINED":
      return "清理未完成，已隔离";
    default:
      return code;
  }
}

/** Why a view was cleared, in words. `undefined` means "still up". */
export function webuiMiniAppStopReason(row: WebuiMiniAppRow | undefined): string | undefined {
  if (!row) return "该应用已不在应用列表中。";
  if (row.status === "failed") {
    return row.errorCode ? `运行失败（${webuiMiniAppFailureCodeText(row.errorCode)}）。` : "运行失败。";
  }
  if (row.status === "stopped") return "运行已停止。";
  return undefined;
}
