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
import { useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";

import type { WebuiCronRun, WebuiCronTask } from "../../../../shared/contracts/cron.js";
import type {
  WebuiSchedulingOwner,
  WebuiSchedulingSnapshot,
} from "../application/scheduling-owner.js";
import {
  webuiCronRunRows,
  WEBUI_SCHEDULING_EMPTY_TEXT,
  WEBUI_SCHEDULING_LOADING_TEXT,
  WEBUI_SCHEDULING_OTHER_HOST_HINT,
  webuiSchedulingRows,
} from "../projection/scheduling-panel.js";
import { SchedulingEditor } from "./scheduling-editor.js";

export interface SchedulingPanelViewProps {
  readonly snapshot: WebuiSchedulingSnapshot;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  /** The open editor, if any. Rendered above the list so the form and the rows share one scroll. */
  readonly editor?: ReactNode;
  readonly onCreate: () => void;
  readonly onEdit: (task: WebuiCronTask) => void;
  readonly onToggle: (task: WebuiCronTask) => void;
  /** Deletes after a second click: a destructive action should not be one stray click away. */
  readonly onDelete: (task: WebuiCronTask) => void;
  /** The row whose delete button is asking for confirmation. */
  readonly confirmingDelete?: string;
  readonly onRequestDelete: (task: WebuiCronTask) => void;
  readonly onCancelDelete: () => void;
  /** Runs one task immediately. */
  readonly onRunNow: (task: WebuiCronTask) => void;
  /** The task whose history is open, and that history. */
  readonly expandedRuns?: string;
  readonly runs?: ReadonlyMap<string, readonly WebuiCronRun[]>;
  readonly onToggleRuns: (task: WebuiCronTask) => void;
  /** Opens the session a run produced. */
  readonly onOpenSession: (sessionId: string) => void;
  /** A run or history read that failed, shown above the list. */
  readonly runError?: string;
}

export function SchedulingPanelView(props: SchedulingPanelViewProps): ReactElement {
  const rows = webuiSchedulingRows(props.snapshot.tasks, props.nowMs);
  const tasksById = new Map(props.snapshot.tasks.map((task) => [task.cronId, task]));
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
            data-webui-scheduling-new="true"
            onClick={props.onCreate}
            className="rounded-[6px] border border-stroke_default px-2 py-1 text-sm text-text_default_primary"
          >
            新建
          </button>
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
        {props.editor}
        {props.runError === undefined
          ? null
          : <p data-webui-scheduling-run-error="true" className="mb-3 text-sm text-text_default_secondary">
            {props.runError}
          </p>}
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
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  data-webui-scheduling-edit={row.cronId}
                  onClick={() => {
                    const task = tasksById.get(row.cronId);
                    if (task) props.onEdit(task);
                  }}
                  className="rounded-[6px] border border-stroke_default px-2 py-0.5 text-xs text-text_default_secondary"
                >
                  编辑
                </button>
                <button
                  type="button"
                  data-webui-scheduling-toggle={row.cronId}
                  onClick={() => {
                    const task = tasksById.get(row.cronId);
                    if (task) props.onToggle(task);
                  }}
                  className="rounded-[6px] border border-stroke_default px-2 py-0.5 text-xs text-text_default_secondary"
                >
                  {row.enabled ? "停用" : "启用"}
                </button>
                <button
                  type="button"
                  data-webui-scheduling-run={row.cronId}
                  onClick={() => {
                    const task = tasksById.get(row.cronId);
                    if (task) props.onRunNow(task);
                  }}
                  className="rounded-[6px] border border-stroke_default px-2 py-0.5 text-xs text-text_default_secondary"
                >
                  立即执行
                </button>
                <button
                  type="button"
                  data-webui-scheduling-history={row.cronId}
                  onClick={() => {
                    const task = tasksById.get(row.cronId);
                    if (task) props.onToggleRuns(task);
                  }}
                  className="rounded-[6px] border border-stroke_default px-2 py-0.5 text-xs text-text_default_secondary"
                >
                  运行历史
                </button>
                {props.confirmingDelete === row.cronId
                  ? <>
                    <button
                      type="button"
                      data-webui-scheduling-delete-confirm={row.cronId}
                      onClick={() => {
                        const task = tasksById.get(row.cronId);
                        if (task) props.onDelete(task);
                      }}
                      className="rounded-[6px] border border-stroke_default px-2 py-0.5 text-xs text-text_default_primary"
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      data-webui-scheduling-delete-cancel={row.cronId}
                      onClick={props.onCancelDelete}
                      className="rounded-[6px] px-2 py-0.5 text-xs text-text_default_tertiary"
                    >
                      取消
                    </button>
                  </>
                  : <button
                    type="button"
                    data-webui-scheduling-delete={row.cronId}
                    onClick={() => {
                      const task = tasksById.get(row.cronId);
                      if (task) props.onRequestDelete(task);
                    }}
                    className="rounded-[6px] border border-stroke_default px-2 py-0.5 text-xs text-text_default_secondary"
                  >
                    删除
                  </button>}
              </div>
              {props.expandedRuns === row.cronId
                ? <ul data-webui-scheduling-runs={row.cronId} className="mt-2 space-y-1 border-t-[0.5px] border-border_default pt-1">
                  {(props.runs?.get(row.cronId) ?? []).length === 0
                    ? <li className="text-xs text-text_default_tertiary">还没有运行记录。</li>
                    : webuiCronRunRows(props.runs?.get(row.cronId) ?? []).map((run) => (
                      <li
                        key={run.runId}
                        data-webui-scheduling-run-row={run.runId}
                        className="flex items-center justify-between gap-2 text-xs text-text_default_secondary"
                      >
                        <span>
                          {run.whenLabel} · {run.sourceLabel} · {run.statusLabel}
                          {run.failureLabel === undefined ? "" : ` · ${run.failureLabel}`}
                        </span>
                        {run.sessionId === undefined
                          ? null
                          : <button
                            type="button"
                            data-webui-scheduling-run-session={run.sessionId}
                            onClick={() => props.onOpenSession(run.sessionId!)}
                            className="rounded-[6px] px-2 py-0.5 text-xs text-text_default_primary underline"
                          >
                            打开会话
                          </button>}
                      </li>
                    ))}
                </ul>
                : null}
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
  /** Opens the session a run produced; the shell owns navigation. */
  readonly onOpenSession: (sessionId: string) => void;
}): ReactElement {
  const snapshot = useSyncExternalStore(
    props.owner.subscribe,
    props.owner.getSnapshot,
    props.owner.getSnapshot,
  );
  const [editing, setEditing] = useState<{ readonly task?: WebuiCronTask } | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined);
  const [expandedRuns, setExpandedRuns] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<ReadonlyMap<string, readonly WebuiCronRun[]>>(new Map());
  const [runError, setRunError] = useState<string | undefined>(undefined);

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
      onCreate={() => setEditing({})}
      onEdit={(task) => setEditing({ task })}
      onToggle={(task) => void props.owner.setEnabled(task.cronId, !task.enabled)}
      onDelete={(task) => {
        setConfirmingDelete(undefined);
        void props.owner.deleteTask(task.cronId);
      }}
      {...(confirmingDelete === undefined ? {} : { confirmingDelete })}
      onRequestDelete={(task) => setConfirmingDelete(task.cronId)}
      onCancelDelete={() => setConfirmingDelete(undefined)}
      {...(runError === undefined ? {} : { runError })}
      onRunNow={(task) => {
        setRunError(undefined);
        void props.owner.runNow(task.cronId).then((result) => {
          // The history is what shows the run, so a run-now opens it.
          setExpandedRuns(task.cronId);
          void props.owner.loadRuns(task.cronId).then((history) => {
            if (history.ok) {
              setRuns((current) => new Map(current).set(task.cronId, history.runs));
            }
          });
          if (!result.ok) setRunError(result.message);
        });
      }}
      onToggleRuns={(task) => {
        if (expandedRuns === task.cronId) {
          setExpandedRuns(undefined);
          return;
        }
        setExpandedRuns(task.cronId);
        void props.owner.loadRuns(task.cronId).then((history) => {
          if (history.ok) {
            setRuns((current) => new Map(current).set(task.cronId, history.runs));
          } else {
            setRunError(history.message);
          }
        });
      }}
      {...(expandedRuns === undefined ? {} : { expandedRuns })}
      runs={runs}
      onOpenSession={(sessionId) => props.onOpenSession(sessionId)}
      editor={editing
        ? <SchedulingEditor
          key={editing.task?.cronId ?? "new"}
          owner={props.owner}
          {...(editing.task ? { task: editing.task } : {})}
          nowMs={() => props.nowMs}
          onDone={() => setEditing(undefined)}
        />
        : null}
    />
  );
}
