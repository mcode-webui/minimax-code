// The apps area combines the installed plugin catalogue with Mini App runtime
// state. Plugin metadata owns identity and icon projection; Mini App workflows
// own lifecycle state and actions, the same runtime rows the launcher reads.

import { useEffect, type ReactElement } from "react";

import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  useWebuiMiniAppWorkflows,
  useWebuiMiniAppWorkflowsState,
} from "../bindings/use-miniapp-workflows.js";
import {
  webuiMiniAppFailureCodeText,
  webuiMiniAppRefusalText,
  webuiMiniAppWindowName,
  type WebuiMiniAppRow,
} from "../projection/miniapp-view.js";
import { readWebuiPluginRow } from "../../plugins/contracts/plugin-rows.js";
import { FeedbackBusy, FeedbackError } from "../../../ui/feedback.js";

export interface MiniAppInstalledPluginRow {
  readonly source: Record<string, unknown>;
  readonly name: string;
  readonly description: string;
  readonly iconUrl: string;
  readonly enabled: boolean;
}

export interface MiniAppAppsListProps {
  /** Installed plugin rows carrying the marketplace's category and icon metadata. */
  readonly installedPlugins?: readonly MiniAppInstalledPluginRow[];
  /** The catalogue query, also applied to runtime-only local Mini Apps. */
  readonly query?: string;
  /** The session the standalone Mini App page should present. */
  readonly selectedSessionId?: string;
}

export function MiniAppAppsList({ installedPlugins = [], query = "", selectedSessionId }: MiniAppAppsListProps): ReactElement {
  const workflows = useWebuiMiniAppWorkflows();
  const state = useWebuiMiniAppWorkflowsState();
  const { rows, loading, error } = state.listing;
  // The page's visibility is the platform's fact, not this component's: the
  // dependency rules keep `document` out of the bindings, and the browser port
  // already answers both questions this surface asks of it.
  const { dom } = useWebuiBrowserCapabilities();

  useEffect(() => {
    void workflows?.loadListing();
    const refresh = () => {
      if (!dom.isPageHidden()) void workflows?.loadListing();
    };
    window.addEventListener("focus", refresh);
    const stopVisibility = dom.listenForVisibilityChange(refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      stopVisibility();
    };
  }, [workflows, dom]);

  if (loading && rows.length === 0 && installedPlugins.length === 0) {
    return (
      <FeedbackBusy label="加载中…" />
    );
  }

  const items = new Map<string, {
    readonly pluginId: string;
    readonly name: string;
    readonly description: string;
    readonly iconUrl?: string;
    readonly enabled: boolean;
    readonly runtime?: WebuiMiniAppRow;
  }>();
  for (const plugin of installedPlugins) {
    const item = plugin.source;
    const pluginId = readWebuiPluginRow(item, "name", "pluginName", "plugin_name", "pluginId");
    if (!pluginId) continue;
    const key = pluginId.toLocaleLowerCase();
    const runtime = rows.find((row) => row.pluginId.toLocaleLowerCase() === key);
    items.set(key, {
      pluginId,
      name: readWebuiPluginRow(item, "displayName", "display_name") || plugin.name || pluginId,
      description: plugin.description,
      enabled: plugin.enabled,
      ...(plugin.iconUrl || runtime?.iconUrl ? { iconUrl: plugin.iconUrl || runtime?.iconUrl } : {}),
      ...(runtime ? { runtime } : {}),
    });
  }
  for (const runtime of rows) {
    const key = runtime.pluginId.toLocaleLowerCase();
    if (!items.has(key) && (!query || `${runtime.name} ${runtime.description} ${runtime.pluginId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) {
      items.set(key, {
        pluginId: runtime.pluginId,
        name: runtime.name,
        description: runtime.description,
        enabled: runtime.enabled,
        ...(runtime.iconUrl ? { iconUrl: runtime.iconUrl } : {}),
        runtime,
      });
    }
  }
  const listingRows = [...items.values()];

  return (
    <div className="webui-miniapp-apps" data-testid="miniapp-apps">
      {error ? (
        <FeedbackError message={error} className="webui-plugin-error" />
      ) : null}
      {state.unavailable ? <FeedbackError message={state.unavailable} className="webui-plugin-error" /> : null}
      {listingRows.length === 0 ? <p className="webui-plugin-empty">暂无已安装的 Mini App</p> : null}
      <div className="webui-plugin-list">
        {listingRows.map((item) => {
          const row = item.runtime;
          const refusal = row ? state.refusals[row.pluginId] : undefined;
          const opened = row ? state.presentations[row.pluginId] : undefined;
          const standaloneHref =
            row && opened?.kind === "open" && selectedSessionId
              ? workflows?.standaloneUrl({ pluginId: row.pluginId, sessionId: selectedSessionId })
              : undefined;
          return (
            <article className="webui-plugin-row" key={`apps-${item.pluginId}`} data-testid={`miniapp-app-${item.pluginId}`}>
              <div className="webui-plugin-icon" aria-hidden="true">
                {item.iconUrl ? (
                  <>
                    <img src={item.iconUrl} alt="" loading="lazy" onError={(event) => {
                      event.currentTarget.hidden = true;
                      event.currentTarget.nextElementSibling?.removeAttribute("hidden");
                    }} />
                    <span hidden>◇</span>
                  </>
                ) : "◇"}
              </div>
              <div className="webui-plugin-copy">
                <h2>{item.name}</h2>
                <p>{item.description || item.pluginId}</p>
                {refusal ? (
                  <FeedbackError
                    className="webui-plugin-error"
                    testId={`miniapp-app-refusal-${item.pluginId}`}
                    message={webuiMiniAppRefusalText({
                      code: refusal.code,
                      message: refusal.message,
                      rows,
                    })}
                  />
                ) : null}
              </div>
              <span
                className="text-text_default_tertiary"
                data-testid={`miniapp-app-status-${item.pluginId}`}
                data-status={row?.status ?? (item.enabled ? "unavailable" : "disabled")}
              >
                {row?.statusLabel ?? (!item.enabled ? "已停用" : loading ? "加载中…" : "运行时不可用")}
                {row?.errorCode ? `（${webuiMiniAppFailureCodeText(row.errorCode)}）` : ""}
              </span>
              <div className="webui-plugin-actions">
                {row?.enabled ? (<>
                <button
                  type="button"
                  data-testid={`miniapp-app-open-${row.pluginId}`}
                  disabled={state.opening === row.pluginId || row.ownedElsewhere}
                  title={row.ownedElsewhere ? `另一个客户端${row.ownerClient ? `（${row.ownerClient}）` : ""}正在运行此 Mini App` : undefined}
                  onClick={() => void workflows?.open(row.pluginId)}
                >
                  {row.ownedElsewhere ? `其他客户端运行中${row.ownerClient ? `（${row.ownerClient}）` : ""}` : "打开"}
                </button>
                {opened?.kind === "open" && standaloneHref !== undefined ? (
                  <button
                    type="button"
                    aria-label="查看"
                    title="在独立标签页中查看 Mini App"
                    onClick={() => {
                      window.open(standaloneHref, webuiMiniAppWindowName(row.pluginId));
                    }}
                  >
                    查看
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!row.running && row.status !== "starting"}
                  onClick={() => void workflows?.stop(row.pluginId)}
                >
                  停止
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`确定卸载 ${item.name}？`)) void workflows?.uninstall(row.pluginId);
                  }}
                >
                  卸载
                </button>
                <button type="button" onClick={() => void workflows?.setPluginEnabled(row.pluginId, false)}>
                  停用
                </button>
                </>) : !item.enabled ? (
                  <button type="button" onClick={() => void workflows?.setPluginEnabled(item.pluginId, true)}>
                    启用
                  </button>
                ) : row ? (
                  // A disabled package has nothing to start or stop; the one
                  // action it has is the one that makes it startable again.
                  <button type="button" onClick={() => void workflows?.setPluginEnabled(row.pluginId, true)}>
                    启用
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
