// The scheduled-task editor.
//
// `SchedulingEditorView` is a pure render of a draft, so every branch — each preset's fields, the
// field-level message a rejection carries, the busy state — is testable through
// `renderToStaticMarkup`. `SchedulingEditor` is the small stateful part: it holds the draft, turns it
// into a schedule through the projection, and submits through the owner.
//
// The presets are the point. A person creating "每天 09:00" never types cron; what they pick is
// converted once, in the projection, into the schedule the runtime stores — so the form and the
// shared row cannot disagree about what the preset means.
import { useState, type ReactElement, type ReactNode } from "react";

import type {
  WebuiCronSchedule,
  WebuiCronTask,
  WebuiCronTaskCreateRequest,
  WebuiCronTaskUpdateRequest,
} from "../../../../shared/contracts/cron.js";
import type { WebuiSchedulingOwner } from "../application/scheduling-owner.js";
import {
  WEBUI_CRON_EMPTY_DRAFT,
  WEBUI_CRON_PRESET_LABELS,
  webuiCronDraftFromTask,
  webuiCronScheduleFromDraft,
  webuiCronUpdateRequest,
  type WebuiCronDraft,
  type WebuiCronSchedulePreset,
} from "../projection/scheduling-panel.js";

export interface SchedulingEditorViewProps {
  readonly mode: "create" | "edit";
  readonly draft: WebuiCronDraft;
  readonly busy: boolean;
  /** A rejection from the validator or the runtime, shown above the buttons. */
  readonly error?: string;
  readonly onChange: (patch: Partial<WebuiCronDraft>) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

const inputClass =
  "w-full rounded-[8px] border border-stroke_default bg-bg_default_primary px-2 py-1 text-sm text-text_default_primary outline-none focus:border-stroke_strong";

function Field(props: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-text_default_tertiary">{props.label}</span>
      {props.children}
    </label>
  );
}

export function SchedulingEditorView(props: SchedulingEditorViewProps): ReactElement {
  const { draft, onChange } = props;
  return (
    <form
      data-webui-component="scheduling-editor"
      data-webui-scheduling-editor-mode={props.mode}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
      className="mb-4 space-y-2 rounded-[8px] border border-border_default p-3"
    >
      <Field label="名称">
        <input
          type="text"
          data-webui-scheduling-field="name"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          className={inputClass}
        />
      </Field>
      {props.mode === "create"
        ? <Field label="执行 agent">
          <input
            type="text"
            data-webui-scheduling-field="agentName"
            value={draft.agentName}
            onChange={(event) => onChange({ agentName: event.target.value })}
            className={inputClass}
          />
        </Field>
        : null}
      <Field label="请求">
        <textarea
          data-webui-scheduling-field="prompt"
          value={draft.prompt}
          rows={2}
          onChange={(event) => onChange({ prompt: event.target.value })}
          className={inputClass}
        />
      </Field>
      <Field label="周期">
        <select
          data-webui-scheduling-field="preset"
          value={draft.preset}
          onChange={(event) => onChange({ preset: event.target.value as WebuiCronSchedulePreset })}
          className={inputClass}
        >
          {(Object.keys(WEBUI_CRON_PRESET_LABELS) as WebuiCronSchedulePreset[]).map((preset) => (
            <option key={preset} value={preset}>
              {WEBUI_CRON_PRESET_LABELS[preset]}
            </option>
          ))}
        </select>
      </Field>
      {draft.preset === "daily" || draft.preset === "weekly"
        ? <Field label="时间（HH:MM）">
          <input
            type="text"
            data-webui-scheduling-field="time"
            value={draft.time}
            onChange={(event) => onChange({ time: event.target.value })}
            className={inputClass}
          />
        </Field>
        : null}
      {draft.preset === "weekly"
        ? <Field label="星期（0 为周日）">
          <input
            type="text"
            data-webui-scheduling-field="weekday"
            value={draft.weekday}
            onChange={(event) => onChange({ weekday: event.target.value })}
            className={inputClass}
          />
        </Field>
        : null}
      {draft.preset === "hourly"
        ? <Field label="每小时的分钟数（0-59）">
          <input
            type="text"
            data-webui-scheduling-field="minute"
            value={draft.minute}
            onChange={(event) => onChange({ minute: event.target.value })}
            className={inputClass}
          />
        </Field>
        : null}
      {draft.preset === "once"
        ? <Field label="执行时间">
          <input
            type="datetime-local"
            data-webui-scheduling-field="onceAt"
            value={draft.onceAt}
            onChange={(event) => onChange({ onceAt: event.target.value })}
            className={inputClass}
          />
        </Field>
        : null}
      {draft.preset === "custom"
        ? <Field label="cron 表达式（五段）">
          <input
            type="text"
            data-webui-scheduling-field="expression"
            value={draft.expression}
            onChange={(event) => onChange({ expression: event.target.value })}
            className={inputClass}
          />
        </Field>
        : null}
      <Field label="模型（可选）">
        <input
          type="text"
          data-webui-scheduling-field="model"
          value={draft.model}
          onChange={(event) => onChange({ model: event.target.value })}
          className={inputClass}
        />
      </Field>
      <Field label="项目（可选）">
        <input
          type="text"
          data-webui-scheduling-field="project"
          value={draft.project}
          onChange={(event) => onChange({ project: event.target.value })}
          className={inputClass}
        />
      </Field>
      <Field label="会话（留空则每次新建）">
        <input
          type="text"
          data-webui-scheduling-field="sessionId"
          value={draft.sessionId}
          onChange={(event) => onChange({ sessionId: event.target.value })}
          className={inputClass}
        />
      </Field>
      {props.error
        ? <p data-webui-scheduling-editor-error="true" className="text-sm text-text_default_secondary">
          {props.error}
        </p>
        : null}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          data-webui-scheduling-submit="true"
          disabled={props.busy}
          className="rounded-[6px] border border-stroke_default px-2 py-1 text-sm text-text_default_primary"
        >
          {props.mode === "create" ? "创建" : "保存"}
        </button>
        <button
          type="button"
          data-webui-scheduling-cancel="true"
          onClick={props.onCancel}
          className="rounded-[6px] px-2 py-1 text-sm text-text_default_secondary"
        >
          取消
        </button>
      </div>
    </form>
  );
}

export function SchedulingEditor(props: {
  readonly owner: WebuiSchedulingOwner;
  readonly task?: WebuiCronTask;
  /** The agent a new task belongs to; the panel passes the client's own. */
  readonly agentName?: string;
  readonly nowMs: () => number;
  readonly onDone: () => void;
}): ReactElement {
  // Read once: a narrowed `props.task` inside the submit closure loses the narrowing.
  const editingTask = props.task;
  const mode = editingTask ? "edit" : "create";
  const [initialDraft] = useState<WebuiCronDraft>(() =>
    editingTask
      ? webuiCronDraftFromTask(editingTask)
      : { ...WEBUI_CRON_EMPTY_DRAFT, agentName: props.agentName ?? "" },
  );
  const [draft, setDraft] = useState<WebuiCronDraft>(initialDraft);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (draft.name.trim() === "") return setError("名称不能为空。");
    if (draft.prompt.trim() === "") return setError("请求不能为空。");
    const agentName = draft.agentName.trim();
    if (editingTask === undefined && agentName === "") {
      return setError("执行任务的 agent 不能为空。");
    }
    // A create always carries a schedule; an edit carries one only when the schedule changed — see
    // `webuiCronUpdateRequest`, which owns that rule for the same reason it owns the conversion.
    const converted = webuiCronScheduleFromDraft(draft, props.nowMs());
    if (editingTask === undefined && !converted.ok) return setError(converted.message);

    setBusy(true);
    setError(undefined);
    const sessionTarget = draft.sessionId.trim()
      ? { mode: "sessionId" as const, sessionId: draft.sessionId.trim() }
      : { mode: "new" as const };
    const optional = {
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.project.trim() ? { project: draft.project.trim() } : {}),
    };
    let result: { readonly ok: true } | { readonly ok: false; readonly message: string };
    if (editingTask !== undefined) {
      const built = webuiCronUpdateRequest(draft, initialDraft, editingTask, props.nowMs());
      result = built.ok ? await props.owner.updateTask(built.request) : built;
    } else {
      if (!converted.ok) return setError(converted.message);
      result = await props.owner.createTask({
        name: draft.name,
        agentName,
        prompt: draft.prompt,
        schedule: converted.schedule,
        sessionTarget,
        ...optional,
      } satisfies WebuiCronTaskCreateRequest);
    }
    setBusy(false);
    if (!result.ok) return setError(result.message);
    props.onDone();
  };

  return (
    <SchedulingEditorView
      mode={mode}
      draft={draft}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onCancel={props.onDone}
      onSubmit={() => void submit()}
    />
  );
}
