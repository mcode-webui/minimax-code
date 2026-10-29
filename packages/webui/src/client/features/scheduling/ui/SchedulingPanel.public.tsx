// The published surface of the scheduled-task panel.
//
// The shell is a peer of this business and may only import what the business publishes, and a
// published module may not re-export another module's symbol — so the panel lives here and is
// published as itself rather than through a forwarding file. The owner it subscribes to and the
// projection it renders stay private to the business.
// The scheduled-task panel.
//
// Split in two on purpose. `SchedulingPanelView` is a pure render of a snapshot, so a test can pin
// every branch — rows, empty state, load failure, the not-held hint — through
// `renderToStaticMarkup` without a DOM (there is no jsdom in this package). `SchedulingPanel` is the
// thin part that subscribes to the owner, reads once when it opens, and re-reads on an interval
// while it stays open, which is what makes a task created in another client appear without a manual
// reload.
//
// The panel is a surface of its own, not a section of the settings modal and not a tab of the
// session-scoped workspace panel: scheduled tasks are not session-scoped (ADR 0027).
import { useEffect, useSyncExternalStore, type ReactElement } from "react";

import type { WebuiSchedulingSnapshot } from "../application/scheduling-owner.js";
import type { WebuiSchedulingOwner } from "../application/scheduling-owner.js";
import {
  WEBUI_SCHEDULING_EMPTY_TEXT,
  WEBUI_SCHEDULING_LOADING_TEXT,
  WEBUI_SCHEDULING_OTHER_HOST_HINT,
  webuiSchedulingRows,
} from "../projection/scheduling-panel.js";

export interface SchedulingPanelViewProps {
  readonly snapshot: WebuiSchedulingSnapshot;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

export function SchedulingPanelView(props: SchedulingPanelViewProps): ReactElement {
  const rows = webuiSchedulingRows(props.snapshot.tasks, props.nowMs);
  // "No task exists yet" is only true of a *successful* empty read: a failed one is not empty, and
  // saying so would invite the person to create a task they may already have.
  const showEmpty = rows.length === 0 && props.snapshot.status === "ready";
  return (
    <section
      aria-label="定时任务"
      data-webui-component="scheduling-panel"
      className="flex h-full min-h-0 flex-col bg-bg_default_primary"
    >
      <header className="flex flex-shrink-0 items-center justify-between border-b-[0.5px] border-border_default px-5 py-3">
        <h1 className="text-base font-medium text-text_default_primary">定时任务</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-webui-scheduling-refresh="true"
            onClick={props.onRefresh}
            className="rounded-[6px] border border-stroke_default px-2 py-1 text-sm text-text_default_secondary hover:text-text_default_primary"
          >
            刷新
          </button>
          <button
            type="button"
            data-webui-scheduling-close="true"
            aria-label="关闭定时任务"
            onClick={props.onClose}
            className="rounded-[6px] px-2 py-1 text-sm text-text_default_secondary hover:text-text_default_primary"
          >
            关闭
          </button>
        </div>
      </header>
      <div className="webui-rail-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <p className="mb-3 text-sm text-text_default_tertiary">{WEBUI_SCHEDULING_OTHER_HOST_HINT}</p>
        {props.snapshot.status === "error" && props.snapshot.error
          ? <p data-webui-scheduling-error="true" className="mb-3 text-sm text-text_default_secondary">
            {props.snapshot.error}
          </p>
          : null}
        {props.snapshot.status === "loading" && rows.length === 0
          ? <p data-webui-scheduling-loading="true" className="text-sm text-text_default_tertiary">
            {WEBUI_SCHEDULING_LOADING_TEXT}
          </p>
          : null}
        {showEmpty
          ? <p data-webui-scheduling-empty="true" className="text-sm text-text_default_tertiary">
            {WEBUI_SCHEDULING_EMPTY_TEXT}
          </p>
          : null}
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.cronId}
              data-webui-scheduling-task={row.cronId}
              className="rounded-[8px] border border-border_default px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-text_default_primary">{row.name}</span>
                <span
                  data-webui-scheduling-enabled={row.enabled ? "true" : "false"}
                  className="text-xs text-text_default_tertiary"
                >
                  {row.enabledLabel}
                </span>
              </div>
              <p className="mt-1 text-sm text-text_default_secondary">{row.scheduleLabel}</p>
              <p className="mt-0.5 text-xs text-text_default_tertiary">{row.nextRunLabel}</p>
              <p
                data-webui-scheduling-hold={row.heldByThisClient ? "held" : "unheld"}
                className="mt-1 text-xs text-text_default_tertiary"
              >
                {row.holdLabel}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function SchedulingPanel(props: {
  readonly owner: WebuiSchedulingOwner;
  readonly nowMs: number;
  readonly onClose: () => void;
}): ReactElement {
  const snapshot = useSyncExternalStore(
    props.owner.subscribe,
    props.owner.getSnapshot,
    props.owner.getSnapshot,
  );

  useEffect(() => {
    void props.owner.load();
    return props.owner.startRefreshing();
  }, [props.owner]);

  return (
    <SchedulingPanelView
      snapshot={snapshot}
      nowMs={props.nowMs}
      onClose={props.onClose}
      onRefresh={() => void props.owner.load()}
    />
  );
}
