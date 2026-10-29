// The Mini App picker the workspace panel's launcher opens.
//
// Same listing as the plugin catalogue's apps area — one owner, one read — so a
// row here and a row there cannot disagree about what is running. The picker's own
// job is small: show the rows with their state, start the one that was chosen, and
// name the running ones when the runtime refuses a fourth.
//
// It opens the view by asking its owner to start the Mini App and then telling the
// workspace which tab to open. That direction is ADR 0020's: the business issues
// the workspace panel's own command, it never reaches into the panel's state.

import { useEffect, type ReactElement } from "react";

import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  useWebuiMiniAppWorkflows,
  useWebuiMiniAppWorkflowsState,
} from "../bindings/use-miniapp-workflows.js";
import {
  webuiMiniAppCapacityText,
  webuiMiniAppFailureCodeText,
  webuiMiniAppRefusalText,
  webuiMiniAppRunningRows,
} from "../projection/miniapp-view.js";

export interface MiniAppPickerProps {
  /** The session the chosen Mini App's view belongs to. */
  readonly sessionId?: string;
  /** Called once a Mini App is started, with the plugin the tab is for. */
  readonly onOpened: (pluginId: string) => void;
  readonly onClose?: () => void;
}

export function MiniAppPicker({ sessionId, onOpened, onClose }: MiniAppPickerProps): ReactElement {
  const workflows = useWebuiMiniAppWorkflows();
  const state = useWebuiMiniAppWorkflowsState();
  const { loading } = state.listing;
  // The page's visibility is the platform's fact, not this component's: the
  // dependency rules keep `document` out of the bindings, and the browser port
  // already answers both questions this surface asks of it.
  const { dom } = useWebuiBrowserCapabilities();
  // Only a startable package belongs here: the picker exists to open one, and a
  // disabled Mini App cannot be opened — the catalogue's apps area is where it is
  // enabled, and this surface would otherwise offer an action that always fails.
  const rows = state.listing.rows.filter((row) => row.enabled);
  const running = webuiMiniAppRunningRows(rows);
  const refused = Object.values(state.refusals);
  const capacityRefused = refused.some((refusal) => refusal.code === "BUSY");

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

  return (
    <div className="webui-miniapp-picker" data-testid="miniapp-picker">
      <div className="webui-miniapp-picker-heading">
        <span>选择一个 Mini App</span>
        {onClose ? (
          <button type="button" onClick={onClose}>
            取消
          </button>
        ) : null}
      </div>
      {state.unavailable ? <p className="webui-plugin-empty">{state.unavailable}</p> : null}
      {loading && rows.length === 0 ? (
        <p className="webui-plugin-empty" role="status">
          加载中…
        </p>
      ) : null}
      {!state.unavailable && !loading && rows.length === 0 ? (
        <p className="webui-plugin-empty">暂无已安装的 Mini App</p>
      ) : null}
      {/* A refused fourth start says which applications are using the capacity,
          and each of them carries the stop button that frees one. */}
      {capacityRefused ? (
        <p className="webui-plugin-error" role="alert" data-testid="miniapp-picker-capacity">
          {webuiMiniAppCapacityText(rows)}
        </p>
      ) : null}
      <div className="webui-plugin-list">
        {rows.map((row) => {
          const refusal = state.refusals[row.pluginId];
          return (
            <article className="webui-plugin-row" key={`picker-${row.pluginId}`} data-testid={`miniapp-picker-row-${row.pluginId}`}>
              <div className="webui-plugin-copy">
                <h2>{row.name}</h2>
                <p>{row.description || row.pluginId}</p>
                {refusal ? (
                  <p
                    className="webui-plugin-error"
                    role="alert"
                    data-testid={`miniapp-picker-refusal-${row.pluginId}`}
                  >
                    {webuiMiniAppRefusalText({
                      code: refusal.code,
                      message: refusal.message,
                      rows,
                    })}
                  </p>
                ) : null}
              </div>
              <span className="text-text_default_tertiary" data-status={row.status}>
                {row.statusLabel}
                {row.errorCode ? `（${webuiMiniAppFailureCodeText(row.errorCode)}）` : ""}
              </span>
              <div className="webui-plugin-actions">
                <button
                  type="button"
                  data-testid={`miniapp-picker-open-${row.pluginId}`}
                  disabled={state.opening === row.pluginId || row.ownedElsewhere}
                  title={row.ownedElsewhere ? `另一个客户端${row.ownerClient ? `（${row.ownerClient}）` : ""}正在运行此 Mini App` : undefined}
                  onClick={() => {
                    void workflows?.open(row.pluginId).then((opened) => {
                      if (opened) onOpened(row.pluginId);
                    });
                  }}
                >
                  {row.ownedElsewhere ? `其他客户端运行中${row.ownerClient ? `（${row.ownerClient}）` : ""}` : "打开"}
                </button>
                <button
                  type="button"
                  disabled={!row.running && row.status !== "starting"}
                  onClick={() => void workflows?.stop(row.pluginId)}
                >
                  停止
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {sessionId ? null : (
        <p className="webui-plugin-empty">当前没有会话，Mini App 会打开在第一个标签页里。</p>
      )}
      {running.length > 0 ? (
        <p className="text-size_12 text-text_default_secondary" data-testid="miniapp-picker-running">
          正在运行：{running.map((row) => row.name).join("、")}
        </p>
      ) : null}
    </div>
  );
}
