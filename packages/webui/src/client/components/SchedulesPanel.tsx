// 定时任务 — the rail's 「定时」 destination.
//
// Every task is addressed by `taskId` and its schedule is the pair
// (`scheduleKind`, one of `runAtMs` / `intervalMs`) the merged WebUI store
// holds — see `packages/webui/src/server/port.ts`. There is no cron
// expression, no runs table, and no runtime cron service behind this: the
// backend that answered is the WebUI's own store plus a tick inside
// `WebuiService`.
//
// The list and its row are exported separately from the orchestrating panel so
// the shell's SSR tests can render the real markup without a DOM.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  WebuiClientSession,
  WebuiScheduledTask,
  WebuiScheduledTaskCapability,
  WebuiScheduledTaskListResult,
  WebuiScheduledTaskRunStatus,
  WebuiTransport,
  WebuiUpdateScheduledTaskRequest,
} from "../contracts.js";
import { WebuiIconSchedule } from "../icons.js";
import { ToggleSwitch } from "./ToggleSwitch.js";
import {
  DEFAULT_AGENT_NAME,
  WebuiCronCreateDialog,
  createScheduledTaskRequestFromDraft,
  deriveAgentNames,
  emptyScheduledTaskDraft,
  formatScheduledTaskTime,
  resolveDefaultAgentName,
  scheduledTaskDraftFromTask,
  updateScheduledTaskRequestFromDraft,
  type WebuiScheduledTaskDraft,
} from "./CronCreateDialog.js";
import {
  CHAT_CREATE_GUIDE_PROMPT,
  WebuiCronChatCreateFlow,
  buildChatScheduledTaskRequest,
} from "./CronChatCreateFlow.js";

/** Must stay in step with the dialog's counter: a row only needs enough of the
 *  instruction to tell two tasks apart. */
const PROMPT_SUMMARY_LENGTH = 90;

const EMPTY_VALUE = "—";

const RUN_STATUS_LABEL: Readonly<Record<WebuiScheduledTaskRunStatus, string>> = {
  succeeded: "成功",
  failed: "失败",
  missed: "已错过",
};

const PRIMARY_BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border-[0.5px] border-border_default bg-bg_interaction_primary_default px-3 text-sm text-text_default_inverted transition-colors hover:bg-bg_interaction_primary_hover disabled:opacity-50";
const GHOST_BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border-[0.5px] border-border_default px-3 text-sm text-text_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50";

/** The row's one-line schedule, in the words the dialog's two kinds use. */
export function describeScheduledTaskSchedule(task: WebuiScheduledTask): string {
  if (task.scheduleKind === "once") {
    const at = formatScheduledTaskTime(task.runAtMs);
    return at ? `仅一次 ${at}` : "仅一次（时间未知）";
  }
  if (typeof task.intervalMs === "number" && Number.isFinite(task.intervalMs)) {
    const minutes = task.intervalMs / 60_000;
    return Number.isInteger(minutes) ? `每 ${minutes} 分钟` : `每 ${task.intervalMs} 毫秒`;
  }
  return "每 N 分钟（间隔未知）";
}

export function groupScheduledTasksByAgent(
  tasks: readonly WebuiScheduledTask[],
): readonly (readonly [string, readonly WebuiScheduledTask[]])[] {
  const byAgent = new Map<string, WebuiScheduledTask[]>();
  for (const task of tasks) {
    const bucket = byAgent.get(task.agentName);
    if (bucket) bucket.push(task);
    else byAgent.set(task.agentName, [task]);
  }
  return [...byAgent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([agentName, items]) =>
        [agentName, [...items].sort((left, right) => left.name.localeCompare(right.name))] as const,
    );
}

const summarize = (prompt: string): string => {
  const flat = prompt.replace(/\s+/gu, " ").trim();
  if (!flat) return EMPTY_VALUE;
  return flat.length > PROMPT_SUMMARY_LENGTH ? `${flat.slice(0, PROMPT_SUMMARY_LENGTH)}…` : flat;
};

const keyOf = (taskId: string, action: string): string => `${taskId}:${action}`;

export function scheduledTaskToggleRequest(
  task: WebuiScheduledTask,
  enabled: boolean,
): WebuiUpdateScheduledTaskRequest {
  return { taskId: task.taskId, enabled };
}

export function scheduledTaskTriggerRequest(task: WebuiScheduledTask): { readonly taskId: string } {
  return { taskId: task.taskId };
}

/** `deleteScheduledTask` is idempotent by contract: `success: false` means the
 *  task was already gone, which is the outcome the user asked for. */
export function scheduledTaskDeleteRequest(task: WebuiScheduledTask): { readonly taskId: string } {
  return { taskId: task.taskId };
}

/* ------------------------------------------------------------------ presentational */

/** The 「创建」 split control: exactly two paths, no third. */
export function WebuiCronCreateMenu({
  open,
  disabled = false,
  onToggle,
  onManual,
  onChat,
}: {
  readonly open: boolean;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
  readonly onManual: () => void;
  readonly onChat: () => void;
}): ReactElement {
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        className={PRIMARY_BUTTON}
        data-testid="schedules-create"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        创建
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="创建定时任务"
          className="absolute right-0 top-9 z-20 flex min-w-[140px] flex-col rounded-lg border-[0.5px] border-border_default bg-bg_default_primary py-1"
          data-testid="schedules-create-menu"
        >
          <button
            type="button"
            role="menuitem"
            data-webui-scheduled-task-create-option="manual"
            className="px-3 py-1.5 text-left text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            onClick={onManual}
          >
            手动创建
          </button>
          <button
            type="button"
            role="menuitem"
            data-webui-scheduled-task-create-option="chat"
            className="px-3 py-1.5 text-left text-sm text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover"
            onClick={onChat}
          >
            在对话中创建
          </button>
        </div>
      ) : null}
    </span>
  );
}

/** The capability answer the panel shows before anything else. An unavailable
 *  backing store is a state to state, not an error on first interaction. */
export function WebuiScheduledTaskCapabilityNotice({
  capability,
}: {
  readonly capability: WebuiScheduledTaskCapability;
}): ReactElement {
  return (
    <p
      className="px-4 py-3 text-sm text-text_default_secondary"
      data-testid="schedules-capability"
      data-webui-schedules-capability={capability.source}
    >
      {capability.available
        ? "定时任务由本 Web 服务执行。创建按钮已就绪。"
        : `定时任务当前不可用（${capability.source}）：${capability.reason ?? "本 Web 服务未接入定时任务能力。"}`}
    </p>
  );
}

export function WebuiScheduledTaskRow({
  task,
  busyKey,
  onToggleEnabled,
  onTrigger,
  onEdit,
  onDelete,
}: {
  readonly task: WebuiScheduledTask;
  readonly busyKey: string;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onTrigger: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  const status = task.lastStatus ? RUN_STATUS_LABEL[task.lastStatus] : undefined;
  return (
    <article
      className="flex flex-col gap-2 border-b border-border_default px-4 py-3"
      data-testid="schedules-task"
      data-webui-scheduled-task-id={task.taskId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{task.name}</span>
        <code className="shrink-0 rounded bg-bg_default_tertiary px-1.5 py-0.5 text-xs text-text_default_secondary">
          {describeScheduledTaskSchedule(task)}
        </code>
        {!task.enabled ? (
          <span className="shrink-0 text-xs text-text_default_tertiary">已暂停</span>
        ) : null}
        <span className="flex-1" />
        <ToggleSwitch
          checked={task.enabled}
          label={`${task.name} 启用状态`}
          testId={`schedules-toggle-${task.taskId}`}
          disabled={busyKey === keyOf(task.taskId, "toggle")}
          onChange={onToggleEnabled}
        />
      </div>
      <p className="min-w-0 text-sm text-text_default_secondary">{summarize(task.prompt)}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text_default_tertiary">
        <span>上次执行：{formatScheduledTaskTime(task.lastRunAtMs) || EMPTY_VALUE}</span>
        <span>下次执行：{formatScheduledTaskTime(task.nextRunAtMs) || EMPTY_VALUE}</span>
        <span data-testid="schedules-task-status" data-webui-scheduled-task-status={task.lastStatus ?? "none"}>
          上次结果：
          {status
            ? `${status}${task.lastError ? ` · ${task.lastError}` : ""}`
            : EMPTY_VALUE}
        </span>
        <span>运行模式：{task.sessionTarget === "existing" ? "始终使用同一对话" : "每次新建对话"}</span>
      </div>
      {/* Missed slots are the backend's deliberate surfacing, so they are
          stated here rather than folded into a "nothing happened" row. */}
      {task.missedCount > 0 ? (
        <p
          className="text-xs text-text_default_tertiary"
          data-testid="schedules-task-missed"
          data-webui-scheduled-task-missed={String(task.missedCount)}
        >
          已错过 {task.missedCount} 次（webui 未运行时的时段不会补跑）
          {task.lastMissedAtMs ? `，最近一次 ${formatScheduledTaskTime(task.lastMissedAtMs)}` : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={GHOST_BUTTON}
          data-testid={`schedules-trigger-${task.taskId}`}
          disabled={busyKey === keyOf(task.taskId, "trigger")}
          onClick={onTrigger}
        >
          立即执行
        </button>
        <button
          type="button"
          className={GHOST_BUTTON}
          data-testid={`schedules-edit-${task.taskId}`}
          onClick={onEdit}
        >
          编辑
        </button>
        <button
          type="button"
          className={GHOST_BUTTON}
          data-testid={`schedules-delete-${task.taskId}`}
          disabled={busyKey === keyOf(task.taskId, "delete")}
          onClick={onDelete}
        >
          删除
        </button>
      </div>
    </article>
  );
}

export function WebuiScheduledTaskList({
  tasks,
  busyKey,
  onToggleEnabled,
  onTrigger,
  onEdit,
  onDelete,
}: {
  readonly tasks: readonly WebuiScheduledTask[];
  readonly busyKey: string;
  readonly onToggleEnabled: (task: WebuiScheduledTask, enabled: boolean) => void;
  readonly onTrigger: (task: WebuiScheduledTask) => void;
  readonly onEdit: (task: WebuiScheduledTask) => void;
  readonly onDelete: (task: WebuiScheduledTask) => void;
}): ReactElement {
  const groups = groupScheduledTasksByAgent(tasks);
  return (
    <>
      {groups.map(([agentName, items]) => (
        <div key={agentName} className="flex flex-col" data-webui-scheduled-task-group={agentName}>
          <h2 className="px-4 pb-1 pt-3 text-xs font-medium uppercase text-text_default_tertiary">
            {agentName}
          </h2>
          {items.map((task) => (
            <WebuiScheduledTaskRow
              key={task.taskId}
              task={task}
              busyKey={busyKey}
              onToggleEnabled={(enabled) => onToggleEnabled(task, enabled)}
              onTrigger={() => onTrigger(task)}
              onEdit={() => onEdit(task)}
              onDelete={() => onDelete(task)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ orchestration */

export interface SchedulesPanelProps {
  readonly transport?: WebuiTransport;
  readonly onClose?: () => void;
  /** The session 始终使用同一对话 may point at, and the pool the Agent
   *  dropdown's names are derived from. */
  readonly currentSessionId?: string;
  /** The conversation opened by 在对话中创建, owned by the shell so it survives
   *  the view switch into that conversation and back. */
  readonly chatSessionId?: string;
  readonly onChatSessionCreated?: (sessionId: string) => void;
  readonly onChatSessionFinished?: () => void;
}

export function SchedulesPanel({
  transport,
  onClose,
  currentSessionId,
  chatSessionId,
  onChatSessionCreated,
  onChatSessionFinished,
}: SchedulesPanelProps): ReactElement {
  const [tasks, setTasks] = useState<readonly WebuiScheduledTask[]>([]);
  const [sessions, setSessions] = useState<readonly WebuiClientSession[]>([]);
  const [capability, setCapability] = useState<WebuiScheduledTaskCapability | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** `taskId:action`, so a slow trigger on one row cannot disable the rest. */
  const [busyKey, setBusyKey] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "manual" | "chat">("list");
  const [editing, setEditing] = useState<WebuiScheduledTask | undefined>();
  const [draft, setDraft] = useState<WebuiScheduledTaskDraft>(() => emptyScheduledTaskDraft());
  const reloadRequestRef = useRef(0);
  const wired = Boolean(transport?.listScheduledTasks);

  const agents = useMemo(() => deriveAgentNames(sessions), [sessions]);
  // 始终使用同一对话 offers the current session plus everything the list
  // already returned, so the choice is not limited to one id.
  const sessionOptions = useMemo(() => {
    const seen = new Map<string, WebuiClientSession>();
    for (const session of sessions) seen.set(session.sessionId, session);
    if (currentSessionId && !seen.has(currentSessionId)) {
      seen.set(currentSessionId, {
        sessionId: currentSessionId,
        agentName: DEFAULT_AGENT_NAME,
        createdAt: 0,
        updatedAt: 0,
      });
    }
    return [...seen.values()].map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
    }));
  }, [currentSessionId, sessions]);

  const reload = useCallback(async () => {
    if (!transport?.listScheduledTasks) return;
    const nonce = ++reloadRequestRef.current;
    setLoading(true);
    try {
      const page: WebuiScheduledTaskListResult | undefined = await transport.listScheduledTasks();
      // The wire is untyped at runtime: a store that fails to project one task
      // must not take the whole list down with it.
      setTasks(Array.isArray(page?.tasks) ? page.tasks : []);
      setError("");
    } catch (cause) {
      if (nonce !== reloadRequestRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (nonce === reloadRequestRef.current) setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    void reload();
    return () => {
      reloadRequestRef.current += 1;
    };
  }, [reload]);

  // The capability question is asked before the panel offers anything, so an
  // unavailable backing store is a state the page states rather than an error
  // on the first click.
  useEffect(() => {
    if (!transport?.getScheduledTaskCapability) {
      setCapability({ available: false, source: "none", reason: "本 Web 服务未接入定时任务能力。" });
      return;
    }
    let cancelled = false;
    void transport
      .getScheduledTaskCapability()
      .then((value) => {
        if (!cancelled && value) setCapability(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCapability({
          available: false,
          source: "none",
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [transport]);

  // The Agent dropdown reads the session list the client already loads, because
  // the merged backend has no `listAgents` and this change must not add one.
  useEffect(() => {
    if (!transport?.loadSessions) return;
    let cancelled = false;
    void transport
      .loadSessions()
      .then((page) => {
        if (cancelled) return;
        const items = Array.isArray(page?.sessions) ? page.sessions : [];
        setSessions(items);
        setDraft((current) => ({
          ...current,
          agentName: current.agentName || resolveDefaultAgentName(deriveAgentNames(items)),
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [transport]);

  /** Every mutation re-reads the list rather than patching local state. */
  const run = useCallback(
    async (rowKey: string, action: () => Promise<unknown>) => {
      setBusyKey(rowKey);
      setError("");
      try {
        await action();
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyKey((current) => (current === rowKey ? "" : current));
      }
    },
    [reload],
  );

  const openManualCreate = useCallback(() => {
    setCreateMenuOpen(false);
    setEditing(undefined);
    setDraft({ ...emptyScheduledTaskDraft(agents[0] ?? DEFAULT_AGENT_NAME), sessionId: currentSessionId ?? "" });
    setMode("manual");
  }, [agents, currentSessionId]);

  const openChatCreate = useCallback(() => {
    setCreateMenuOpen(false);
    setEditing(undefined);
    setMode("chat");
  }, []);

  const submitManual = useCallback(() => {
    if (editing) {
      const request = updateScheduledTaskRequestFromDraft(draft, editing.taskId);
      if (!request) return;
      void run(keyOf(editing.taskId, "form"), () =>
        (transport?.updateScheduledTask as NonNullable<WebuiTransport["updateScheduledTask"]>)(request),
      ).then(() => {
        setMode("list");
        setEditing(undefined);
      });
      return;
    }
    const request = createScheduledTaskRequestFromDraft(draft);
    if (!request) return;
    void run("form", () =>
      (transport?.createScheduledTask as NonNullable<WebuiTransport["createScheduledTask"]>)(request),
    ).then(() => setMode("list"));
  }, [draft, editing, run, transport]);

  const startChat = useCallback(() => {
    if (!transport?.createSession) {
      setError("当前 WebUI 未连接会话创建服务");
      return;
    }
    void run("chat-start", async () => {
      const created = await transport.createSession?.({ name: draft.agentName || DEFAULT_AGENT_NAME });
      const sessionId = created?.sessionId ?? created?.session?.sessionId;
      if (!sessionId) throw new Error("创建会话失败");
      // The shell owns the view switch and the remembered id: the user now
      // talks in that session, and comes back here through the rail.
      onChatSessionCreated?.(sessionId);
      await transport.enqueueMessage?.({ id: sessionId, content: CHAT_CREATE_GUIDE_PROMPT });
    });
  }, [draft.agentName, onChatSessionCreated, run, transport]);

  const submitChat = useCallback(() => {
    if (!chatSessionId) return;
    const request = buildChatScheduledTaskRequest(draft, chatSessionId);
    if (!request) return;
    void run("chat-submit", () =>
      (transport?.createScheduledTask as NonNullable<WebuiTransport["createScheduledTask"]>)(request),
    ).then(() => {
      onChatSessionFinished?.();
      setMode("list");
    });
  }, [chatSessionId, draft, onChatSessionFinished, run, transport]);

  const editTask = useCallback(
    (task: WebuiScheduledTask) => {
      setEditing(task);
      setDraft(scheduledTaskDraftFromTask(task));
      setMode("manual");
    },
    [],
  );

  const dialogBusy = busyKey !== "";
  const unavailable = capability !== undefined && !capability.available;

  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto bg-bg_default_primary text-text_default_primary"
      data-testid="schedules-panel"
      data-webui-schedules-panel="true"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border_default px-4 py-3">
        <WebuiIconSchedule className="shrink-0" />
        <h1 className="min-w-0 flex-1 text-[17px] font-medium leading-tight">定时任务</h1>
        <WebuiCronCreateMenu
          open={createMenuOpen}
          disabled={!wired || unavailable}
          onToggle={() => setCreateMenuOpen((open) => !open)}
          onManual={openManualCreate}
          onChat={openChatCreate}
        />
        {onClose ? (
          <button type="button" className={GHOST_BUTTON} aria-label="关闭定时任务" onClick={onClose}>
            关闭
          </button>
        ) : null}
      </header>

      {/* Stated on the page, not in a release note: the tick is in-process, so a
        task only fires while this Web service is alive, and slots that came due
        while it was not are counted as missed rather than replayed. */}
      <p
        className="shrink-0 border-b border-border_default bg-bg_default_secondary px-4 py-2 text-xs leading-relaxed text-text_default_secondary"
        data-testid="schedules-execution-ownership"
      >
        执行归属：任务由本 Web 服务在进程存活期间执行；webui 未运行时不会触发；
        停机期间错过的时段不会补跑，会记为「已错过」。
      </p>

      {capability ? <WebuiScheduledTaskCapabilityNotice capability={capability} /> : null}

      {error ? (
        <p role="alert" className="shrink-0 px-4 py-2 text-sm text-text_default_primary" data-testid="schedules-error">
          {error}
        </p>
      ) : null}

      {mode === "manual" ? (
        <div className="shrink-0" data-testid="schedules-editor">
          <WebuiCronCreateDialog
            title={editing ? "编辑定时任务" : "定时任务"}
            draft={draft}
            onDraftChange={setDraft}
            agents={agents}
            sessions={sessionOptions}
            busy={dialogBusy}
            submitLabel={editing ? "保存" : "确认"}
            onSubmit={submitManual}
            onClose={() => {
              setMode("list");
              setEditing(undefined);
            }}
          />
        </div>
      ) : null}

      {mode === "chat" ? (
        <div className="shrink-0 px-4 py-3" data-testid="schedules-chat-create">
          <WebuiCronChatCreateFlow
            sessionId={chatSessionId}
            draft={draft}
            onDraftChange={setDraft}
            agents={agents}
            busy={dialogBusy}
            onStart={startChat}
            onSubmit={submitChat}
            onClose={() => setMode("list")}
          />
        </div>
      ) : null}

      {!wired ? (
        <p className="px-4 py-3 text-sm text-text_default_secondary" data-testid="schedules-unavailable">
          当前 Web 服务未连接定时任务服务。
        </p>
      ) : null}

      {wired && !unavailable && loading && tasks.length === 0 ? (
        <p className="px-4 py-3 text-sm text-text_default_secondary">正在加载定时任务...</p>
      ) : null}

      {wired && !unavailable && !loading && tasks.length === 0 ? (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
          data-testid="schedules-empty"
        >
          <p className="text-sm text-text_default_secondary">还没有定时任务。</p>
          <p className="text-xs text-text_default_tertiary">
            点右上角「创建」选「手动创建」或「在对话中创建」。
          </p>
        </div>
      ) : null}

      {wired && !unavailable ? (
        <WebuiScheduledTaskList
          tasks={tasks}
          busyKey={busyKey}
          onToggleEnabled={(task, enabled) =>
            void run(keyOf(task.taskId, "toggle"), () =>
              (
                transport?.updateScheduledTask as NonNullable<WebuiTransport["updateScheduledTask"]>
              )(scheduledTaskToggleRequest(task, enabled)),
            )
          }
          onTrigger={(task) =>
            void run(keyOf(task.taskId, "trigger"), () =>
              (
                transport?.triggerScheduledTaskNow as NonNullable<
                  WebuiTransport["triggerScheduledTaskNow"]
                >
              )(scheduledTaskTriggerRequest(task)),
            )
          }
          onEdit={editTask}
          onDelete={(task) =>
            void run(keyOf(task.taskId, "delete"), () =>
              (
                transport?.deleteScheduledTask as NonNullable<WebuiTransport["deleteScheduledTask"]>
              )(scheduledTaskDeleteRequest(task)),
            )
          }
        />
      ) : null}
    </section>
  );
}

export default SchedulesPanel;
