// The plugin catalogue's apps area, as the Mini App business publishes it.
//
// ADR 0020 gives this surface the list and the lifecycle and gives the Mini App
// business the state: the catalogue mounts this component and holds nothing of
// its own. That is why the component takes no rows, no loading flag and no error
// — it reads them from its own owner, and a row's runtime state is the same read
// the launcher's picker makes.
//
// "Install" is the one action a row cannot carry: a Mini App *is* a plugin, and
// installing one is installing its package from the marketplace. The area keeps
// the affordance and hands it to the catalogue, which owns switching to that
// view; what this component does not do is invent an install that installs
// something already installed.

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
} from "../projection/miniapp-view.js";

export interface MiniAppAppsListProps {
  /** Offered when the catalogue can switch to the plugin marketplace. */
  readonly onInstallRequest?: () => void;
  /** The session the standalone Mini App page should present. */
  readonly selectedSessionId?: string;
}

export function MiniAppAppsList({ onInstallRequest, selectedSessionId }: MiniAppAppsListProps): ReactElement {
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

  if (state.unavailable) return <p className="webui-plugin-empty">{state.unavailable}</p>;
  if (loading && rows.length === 0) {
    return (
      <p className="webui-plugin-empty" role="status">
        加载中…
      </p>
    );
  }

  return (
    <div className="webui-miniapp-apps" data-testid="miniapp-apps">
      {onInstallRequest ? (
        <div className="webui-miniapp-apps-toolbar">
          <button type="button" onClick={onInstallRequest}>
            安装 Mini App
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="webui-plugin-error" role="alert">
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="webui-plugin-empty">暂无已安装的 Mini App</p> : null}
      <div className="webui-plugin-list">
        {rows.map((row) => {
          const refusal = state.refusals[row.pluginId];
          const opened = state.presentations[row.pluginId];
          const standaloneHref =
            opened?.kind === "open" && selectedSessionId
              ? workflows?.standaloneUrl({ pluginId: row.pluginId, sessionId: selectedSessionId })
              : undefined;
          return (
            <article className="webui-plugin-row" key={`apps-${row.pluginId}`} data-testid={`miniapp-app-${row.pluginId}`}>
              <div className="webui-plugin-icon" aria-hidden="true">
                {row.iconUrl ? <img src={row.iconUrl} alt="" loading="lazy" /> : "◇"}
              </div>
              <div className="webui-plugin-copy">
                <h2>{row.name}</h2>
                <p>{row.description || row.pluginId}</p>
                {refusal ? (
                  <p className="webui-plugin-error" role="alert" data-testid={`miniapp-app-refusal-${row.pluginId}`}>
                    {webuiMiniAppRefusalText({
                      code: refusal.code,
                      message: refusal.message,
                      rows,
                    })}
                  </p>
                ) : null}
              </div>
              <span
                className="text-text_default_tertiary"
                data-testid={`miniapp-app-status-${row.pluginId}`}
                data-status={row.status}
              >
                {row.statusLabel}
                {row.errorCode ? `（${webuiMiniAppFailureCodeText(row.errorCode)}）` : ""}
              </span>
              <div className="webui-plugin-actions">
                {row.enabled ? (<>
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
                    if (window.confirm(`确定卸载 ${row.name}？`)) void workflows?.uninstall(row.pluginId);
                  }}
                >
                  卸载
                </button>
                <button type="button" onClick={() => void workflows?.setPluginEnabled(row.pluginId, false)}>
                  停用
                </button>
                </>) : (
                  // A disabled package has nothing to start or stop; the one
                  // action it has is the one that makes it startable again.
                  <button type="button" onClick={() => void workflows?.setPluginEnabled(row.pluginId, true)}>
                    启用
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
