/**
 * The scheduled-task panel: projection, owner transitions, and the rendered branches.
 *
 * The panel is the first user-visible slice of ADR 0027, so its claims are asserted where they are
 * made rather than through a browser: the rows' wording, the empty state, the not-held label, the
 * refusal a host without a Cron service gets, and the refresh that makes a task created in another
 * client appear. Rendering goes through `renderToStaticMarkup` — this package has no jsdom.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createWebuiSchedulingOwner,
  WEBUI_SCHEDULING_UNAVAILABLE,
} from "../../src/client/features/scheduling/application/scheduling-owner.js";
import {
  WEBUI_CRON_EMPTY_DRAFT,
  webuiCronDraftFromTask,
  webuiCronScheduleFromDraft,
} from "../../src/client/features/scheduling/projection/scheduling-panel.js";
import { SchedulingEditorView } from "../../src/client/features/scheduling/ui/scheduling-editor.js";
import {
  describeWebuiCronNextRun,
  describeWebuiCronSchedule,
  WEBUI_SCHEDULING_EMPTY_TEXT,
  WEBUI_SCHEDULING_HELD_TEXT,
  WEBUI_SCHEDULING_NOT_HELD_TEXT,
  webuiSchedulingRows,
} from "../../src/client/features/scheduling/projection/scheduling-panel.js";
import { SchedulingPanelView } from "../../src/client/features/scheduling/ui/SchedulingPanel.public.js";
import type { WebuiCronTask } from "../../src/shared/contracts/cron.js";

function task(overrides: Partial<WebuiCronTask> = {}): WebuiCronTask {
  return {
    cronId: "cron-1",
    name: "queue digest",
    agentName: "agent-one",
    prompt: "Summarize the queue.",
    enabled: true,
    heldByThisClient: true,
    schedule: { kind: "recurring", expression: "0 9 * * *" },
    sessionTarget: { mode: "new" },
    project: null,
    model: null,
    nextRunAtMs: Date.UTC(2026, 9, 30, 1, 0),
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

describe("the schedule in readable form", () => {
  it("translates the shapes a person writes and prints the rest verbatim", () => {
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "0 9 * * *" })).toBe(
      "每天 09:00",
    );
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "*/5 * * * *" })).toBe(
      "每 5 分钟",
    );
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "* * * * *" })).toBe("每分钟");
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "0 * * * *" })).toBe(
      "每小时第 0 分钟",
    );
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "0 9 * * 1" })).toBe(
      "每周一 09:00",
    );
    expect(
      describeWebuiCronSchedule({ kind: "recurring", expression: "0 9 * * *", timezone: "UTC" }),
    ).toBe("每天 09:00（UTC）");
    // An expression this projection cannot humanize is not guessed at.
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "0 9 1 * *" })).toBe(
      "自定义：0 9 1 * *",
    );
    expect(describeWebuiCronSchedule({ kind: "recurring", expression: "not a cron" })).toBe(
      "自定义：not a cron",
    );
  });

  it("says when it next runs, and says so when it does not", () => {
    const base = Date.UTC(2026, 9, 30, 0, 0);
    expect(describeWebuiCronNextRun(undefined, base)).toBe("未安排下一次执行");
    expect(describeWebuiCronNextRun(base - 1, base)).toBe("即将执行");
    expect(describeWebuiCronNextRun(base + 20_000, base)).toBe("约 20 秒后");
    expect(describeWebuiCronNextRun(base + 5 * 60_000, base)).toContain("约 5 分钟后");
  });
});

describe("the panel's rows", () => {
  it("carries the task, its schedule, its next run and whether this client holds it", () => {
    const rows = webuiSchedulingRows(
      [task(), task({ cronId: "cron-2", name: "paused", enabled: false, heldByThisClient: false })],
      Date.UTC(2026, 9, 30, 0, 0),
    );
    expect(rows[0]).toMatchObject({
      cronId: "cron-1",
      name: "queue digest",
      scheduleLabel: "每天 09:00",
      enabledLabel: "已启用",
      holdLabel: WEBUI_SCHEDULING_HELD_TEXT,
      heldByThisClient: true,
    });
    // "Not held here" is a different statement from "paused", and the row says both.
    expect(rows[1]).toMatchObject({ enabledLabel: "已停用", holdLabel: WEBUI_SCHEDULING_NOT_HELD_TEXT });
  });
});

describe("the rendered panel", () => {
  const render = (snapshot: Parameters<typeof SchedulingPanelView>[0]["snapshot"]) =>
    renderToStaticMarkup(
      SchedulingPanelView({
        snapshot,
        nowMs: 0,
        onClose: () => undefined,
        onRefresh: () => undefined,
        onCreate: () => undefined,
        onEdit: () => undefined,
        onToggle: () => undefined,
        onDelete: () => undefined,
        onRequestDelete: () => undefined,
        onCancelDelete: () => undefined,
      }),
    );

  it("renders one row per task and never names another host", () => {
    const markup = render({ status: "ready", tasks: [task()], loadedAtMs: 1 });
    expect(markup).toContain('data-webui-scheduling-task="cron-1"');
    expect(markup).toContain("queue digest");
    expect(markup).toContain("每天 09:00");
    expect(markup).toContain('data-webui-scheduling-hold="held"');
    expect(markup).toContain("同一台机器上可能还有另一个运行时实例在运行");
    // The panel may say this client holds it; it may not claim who else does.
    expect(markup).not.toContain("Desktop");
    expect(markup).not.toContain("桌面端");
  });

  it("says no task exists yet, rather than showing an empty list", () => {
    const markup = render({ status: "ready", tasks: [], loadedAtMs: 1 });
    expect(markup).toContain('data-webui-scheduling-empty="true"');
    expect(markup).toContain(WEBUI_SCHEDULING_EMPTY_TEXT);
  });

  it("shows a read failure without pretending the list is empty", () => {
    const markup = render({ status: "error", tasks: [], error: WEBUI_SCHEDULING_UNAVAILABLE });
    expect(markup).toContain('data-webui-scheduling-error="true"');
    expect(markup).toContain(WEBUI_SCHEDULING_UNAVAILABLE);
    expect(markup).not.toContain('data-webui-scheduling-empty="true"');
  });

  it("keeps the last good rows on screen while a refresh is in flight", () => {
    const markup = render({ status: "loading", tasks: [task()], loadedAtMs: 1 });
    expect(markup).toContain('data-webui-scheduling-task="cron-1"');
    expect(markup).not.toContain('data-webui-scheduling-loading="true"');
  });
});

describe("the list owner", () => {
  it("refuses once, in one sentence, when the transport has no list member", async () => {
    const owner = createWebuiSchedulingOwner({ port: {} });
    await owner.load();
    expect(owner.getSnapshot()).toMatchObject({
      status: "error",
      error: WEBUI_SCHEDULING_UNAVAILABLE,
      tasks: [],
    });
  });

  it("reads the list, keeps the rows on a later failure, and refreshes on its interval", async () => {
    const calls: number[] = [];
    let fail = false;
    const bound = task();
    const timers: Array<() => void> = [];
    const owner = createWebuiSchedulingOwner({
      port: {
        listCronTasks: async () => {
          calls.push(1);
          if (fail) throw new Error("runtime said no");
          return { items: [bound], hasMore: false };
        },
      },
      nowMs: () => 7,
      refreshMs: 1_000,
      setIntervalFn: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearIntervalFn: () => undefined,
    });

    await owner.load();
    expect(owner.getSnapshot()).toMatchObject({ status: "ready", loadedAtMs: 7, tasks: [bound] });

    // The refresh interval re-reads; a new task from another client shows up without a reload.
    expect(timers).toHaveLength(0);
    const stop = owner.startRefreshing();
    expect(timers).toHaveLength(1);
    fail = false;
    timers[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(2);

    // A failed re-read keeps the rows and reports the failure.
    fail = true;
    await owner.load();
    expect(owner.getSnapshot()).toMatchObject({
      status: "error",
      tasks: [bound],
      error: "runtime said no",
    });
    stop();
  });

  it("shares one request between concurrent loads", async () => {
    let resolveRead: (() => void) | undefined;
    let reads = 0;
    const owner = createWebuiSchedulingOwner({
      port: {
        listCronTasks: () =>
          new Promise((resolve) => {
            reads += 1;
            resolveRead = () => resolve({ items: [], hasMore: false });
          }),
      },
    });
    const first = owner.load();
    const second = owner.load();
    expect(reads).toBe(1);
    resolveRead?.();
    await Promise.all([first, second]);
    expect(owner.getSnapshot().status).toBe("ready");
  });
});

describe("the editor's presets", () => {
  const draft = { ...WEBUI_CRON_EMPTY_DRAFT };

  it("converts each preset into the schedule the task stores", () => {
    expect(webuiCronScheduleFromDraft({ ...draft, preset: "daily", time: "09:00" }, 0)).toEqual({
      ok: true,
      schedule: { kind: "recurring", expression: "0 9 * * *" },
    });
    expect(
      webuiCronScheduleFromDraft({ ...draft, preset: "weekly", time: "18:30", weekday: "5" }, 0),
    ).toEqual({ ok: true, schedule: { kind: "recurring", expression: "30 18 * * 5" } });
    expect(webuiCronScheduleFromDraft({ ...draft, preset: "hourly", minute: "15" }, 0)).toEqual({
      ok: true,
      schedule: { kind: "recurring", expression: "15 * * * *" },
    });
    const once = webuiCronScheduleFromDraft(
      { ...draft, preset: "once", onceAt: "2026-10-30T09:00" },
      Date.UTC(2026, 9, 29),
    );
    expect(once.ok).toBe(true);
    expect(webuiCronScheduleFromDraft(
      { ...draft, preset: "custom", expression: "0 9 1 * *" },
      0,
    )).toEqual({ ok: true, schedule: { kind: "recurring", expression: "0 9 1 * *" } });
  });

  it("names the field that stopped it", () => {
    expect(webuiCronScheduleFromDraft({ ...draft, preset: "daily", time: "9am" }, 0)).toMatchObject({
      ok: false,
      field: "time",
    });
    expect(
      webuiCronScheduleFromDraft({ ...draft, preset: "weekly", time: "09:00", weekday: "9" }, 0),
    ).toMatchObject({ ok: false, field: "weekday" });
    expect(webuiCronScheduleFromDraft({ ...draft, preset: "once", onceAt: "" }, 0)).toMatchObject({
      ok: false,
      field: "onceAt",
    });
    expect(
      webuiCronScheduleFromDraft({ ...draft, preset: "custom", expression: "0 9 *" }, 0),
    ).toMatchObject({ ok: false, field: "expression" });
    expect(
      webuiCronScheduleFromDraft(
        { ...draft, preset: "once", onceAt: "2026-10-29T09:00" },
        Date.UTC(2026, 9, 30),
      ),
    ).toMatchObject({ ok: false, field: "onceAt" });
  });

  it("opens an existing task in the preset it was written with", () => {
    expect(webuiCronDraftFromTask(task())).toMatchObject({
      preset: "daily",
      time: "09:00",
      name: "queue digest",
    });
    expect(
      webuiCronDraftFromTask(task({ schedule: { kind: "recurring", expression: "30 18 * * 5" } })),
    ).toMatchObject({ preset: "weekly", weekday: "5", time: "18:30" });
    expect(
      webuiCronDraftFromTask(task({ schedule: { kind: "recurring", expression: "15 * * * *" } })),
    ).toMatchObject({ preset: "hourly", minute: "15" });
    expect(
      webuiCronDraftFromTask(task({ schedule: { kind: "recurring", expression: "0 9 1 * *" } })),
    ).toMatchObject({ preset: "custom", expression: "0 9 1 * *" });
  });
});

describe("the rendered editor", () => {
  const render = (draft: Parameters<typeof SchedulingEditorView>[0]["draft"]) =>
    renderToStaticMarkup(
      SchedulingEditorView({
        mode: "create",
        draft,
        busy: false,
        onChange: () => undefined,
        onCancel: () => undefined,
        onSubmit: () => undefined,
      }),
    );

  it("shows only the fields the chosen preset needs", () => {
    expect(render({ ...WEBUI_CRON_EMPTY_DRAFT, preset: "daily" })).toContain(
      'data-webui-scheduling-field="time"',
    );
    expect(render({ ...WEBUI_CRON_EMPTY_DRAFT, preset: "weekly" })).toContain(
      'data-webui-scheduling-field="weekday"',
    );
    const hourly = render({ ...WEBUI_CRON_EMPTY_DRAFT, preset: "hourly" });
    expect(hourly).toContain('data-webui-scheduling-field="minute"');
    expect(hourly).not.toContain('data-webui-scheduling-field="time"');
    expect(render({ ...WEBUI_CRON_EMPTY_DRAFT, preset: "once" })).toContain(
      'data-webui-scheduling-field="onceAt"',
    );
    expect(render({ ...WEBUI_CRON_EMPTY_DRAFT, preset: "custom" })).toContain(
      'data-webui-scheduling-field="expression"',
    );
  });

  it("shows the rejection message beside the form", () => {
    const markup = renderToStaticMarkup(
      SchedulingEditorView({
        mode: "create",
        draft: WEBUI_CRON_EMPTY_DRAFT,
        busy: false,
        error: "schedule.expression必须是五段的 cron 表达式。",
        onChange: () => undefined,
        onCancel: () => undefined,
        onSubmit: () => undefined,
      }),
    );
    expect(markup).toContain('data-webui-scheduling-editor-error="true"');
    expect(markup).toContain("schedule.expression必须是五段的 cron 表达式。");
  });
});
