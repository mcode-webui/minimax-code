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
import { useState, type ReactElement } from "react";
import { WebuiInline } from "../../../ui/layout-primitives.js";

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
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiFormLayout, WebuiSelect, WebuiTextarea, WebuiTextInput } from "../../../ui/field.js";

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
      className="mb-4 rounded-[8px] border border-border_default p-3"
    >
      <WebuiFormLayout>
        <WebuiField
          label="名称"
          control={(props) => (
            <WebuiTextInput
              {...props}
              controlSize="dense"
              type="text"
              data-webui-scheduling-field="name"
              value={draft.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          )}
        />
        {props.mode === "create"
          ? <WebuiField
            label="执行 agent"
            control={(props) => (
              <WebuiTextInput
                {...props}
                controlSize="dense"
                type="text"
                data-webui-scheduling-field="agentName"
                value={draft.agentName}
                onChange={(event) => onChange({ agentName: event.target.value })}
              />
            )}
          />
          : null}
        <WebuiField
          label="请求"
          control={(props) => (
            <WebuiTextarea
              {...props}
              controlSize="compact"
              data-webui-scheduling-field="prompt"
              value={draft.prompt}
              rows={2}
              onChange={(event) => onChange({ prompt: event.target.value })}
            />
          )}
        />
        <WebuiField
          label="周期"
          control={(props) => (
            <WebuiSelect
              {...props}
              controlSize="dense"
              data-webui-scheduling-field="preset"
              value={draft.preset}
              onChange={(event) => onChange({ preset: event.target.value as WebuiCronSchedulePreset })}
            >
              {(Object.keys(WEBUI_CRON_PRESET_LABELS) as WebuiCronSchedulePreset[]).map((preset) => (
                <option key={preset} value={preset}>
                  {WEBUI_CRON_PRESET_LABELS[preset]}
                </option>
              ))}
            </WebuiSelect>
          )}
        />
        {draft.preset === "daily" || draft.preset === "weekly"
          ? <WebuiField
            label="时间（HH:MM）"
            control={(props) => (
              <WebuiTextInput
                {...props}
                controlSize="dense"
                type="text"
                data-webui-scheduling-field="time"
                value={draft.time}
                onChange={(event) => onChange({ time: event.target.value })}
              />
            )}
          />
          : null}
        {draft.preset === "weekly"
          ? <WebuiField
            label="星期（0 为周日）"
            control={(props) => (
              <WebuiTextInput
                {...props}
                controlSize="dense"
                type="text"
                data-webui-scheduling-field="weekday"
                value={draft.weekday}
                onChange={(event) => onChange({ weekday: event.target.value })}
              />
            )}
          />
          : null}
        {draft.preset === "hourly"
          ? <WebuiField
            label="每小时的分钟数（0-59）"
            control={(props) => (
              <WebuiTextInput
                {...props}
                controlSize="dense"
                type="text"
                data-webui-scheduling-field="minute"
                value={draft.minute}
                onChange={(event) => onChange({ minute: event.target.value })}
              />
            )}
          />
          : null}
        {draft.preset === "once"
          ? <WebuiField
            label="执行时间"
            control={(props) => (
              <WebuiTextInput
                {...props}
                controlSize="dense"
                type="datetime-local"
                data-webui-scheduling-field="onceAt"
                value={draft.onceAt}
                onChange={(event) => onChange({ onceAt: event.target.value })}
              />
            )}
          />
          : null}
        {draft.preset === "custom"
          ? <WebuiField
            label="cron 表达式（五段）"
            control={(props) => (
              <WebuiTextInput
                {...props}
                controlSize="dense"
                type="text"
                data-webui-scheduling-field="expression"
                value={draft.expression}
                onChange={(event) => onChange({ expression: event.target.value })}
              />
            )}
          />
          : null}
        <WebuiField
          label="模型（可选）"
          control={(props) => (
            <WebuiTextInput
              {...props}
              controlSize="dense"
              type="text"
              data-webui-scheduling-field="model"
              value={draft.model}
              onChange={(event) => onChange({ model: event.target.value })}
            />
          )}
        />
        <WebuiField
          label="项目（可选）"
          control={(props) => (
            <WebuiTextInput
              {...props}
              controlSize="dense"
              type="text"
              data-webui-scheduling-field="project"
              value={draft.project}
              onChange={(event) => onChange({ project: event.target.value })}
            />
          )}
        />
        <WebuiField
          label="会话（留空则每次新建）"
          control={(props) => (
            <WebuiTextInput
              {...props}
              controlSize="dense"
              type="text"
              data-webui-scheduling-field="sessionId"
              value={draft.sessionId}
              onChange={(event) => onChange({ sessionId: event.target.value })}
            />
          )}
        />
        {props.error
          ? <p data-webui-scheduling-editor-error="true" className="text-sm text-text_default_secondary">
            {props.error}
          </p>
          : null}
        <WebuiInline gap="small" className="pt-1">
          <WebuiButton variant="outline" size="inline" type="submit"
            data-webui-scheduling-submit="true"
            disabled={props.busy}

          >
            {props.mode === "create" ? "创建" : "保存"}
          </WebuiButton>
          <WebuiButton variant="quiet-secondary" size="inline" data-webui-scheduling-cancel="true"
            onClick={props.onCancel}

          >
            取消
          </WebuiButton>
        </WebuiInline>
      </WebuiFormLayout>
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
