// The WebUI's own scheduled-task runtime: due-time accounting, delivery
// through the host's `sendMessage`, and the product boundary that defines
// what happens to a run the process was not alive for.
//
// ── The product boundary, stated once ──────────────────────────────────────
// The WebUI is an on-demand process. A scheduled task runs **only while the
// WebUI host is running**. A slot that comes due while it is down is not
// replayed when it comes back — that is the decision, not a gap in the
// implementation, and the tests exist so it cannot quietly become a catch-up
// loop.
//
// Not replaying anything at all would lose the run silently, which is a worse
// product than losing it loudly. So a missed slot is recorded: `missedCount`
// and `lastMissedAtMs` are persisted, and the panel can say "missed N times
// while the WebUI was closed" with the timestamp of the slot that was lost.
//
// ── How "missed" is decided, and why it is decidable ───────────────────────
// The loop runs every `tickIntervalMs` for the life of the process, so a slot
// that came due while the process was alive is at most one interval late. A
// slot older than `missGraceMs` therefore cannot have been observed on time by
// a live process: it came due during a shutdown. Comparing due time against
// the wall clock — rather than carrying an "am I catching up" flag — keeps the
// rule stateless, so it holds for the very first tick after a cold start, which
// is precisely the case that matters.

import {
  ScheduledTaskStore,
  openScheduledTaskDatabase,
  type ScheduledTaskCreateInput,
  type ScheduledTaskDatabase,
  type ScheduledTaskOutcome,
  type ScheduledTaskPatch,
  type ScheduledTaskRecord,
} from "./scheduled-task-store.js";
import type {
  WebuiCreateScheduledTaskRequest,
  WebuiScheduledTask,
  WebuiScheduledTaskCapability,
  WebuiScheduledTaskListResult,
  WebuiScheduledTaskTriggerResult,
  WebuiUpdateScheduledTaskRequest,
} from "./port.js";

/** The delivery seam: the host's `sendMessage`, narrowed to what a tick needs. */
export type ScheduledTaskSendMessage = (request: {
  readonly id: string;
  readonly content?: string;
}) => Promise<{
  readonly ok: true;
  readonly source:
    | AsyncIterable<unknown>
    | Iterable<unknown>;
} | {
  readonly ok: false;
  readonly status: number;
  readonly body?: { readonly message?: string; readonly detail?: string };
}>;

export interface ScheduledTaskTickResult {
  readonly firedTaskIds: readonly string[];
  readonly missedTaskIds: readonly string[];
  readonly failedTaskIds: readonly string[];
}

export interface WebuiScheduledTaskRuntimeOptions {
  /** Pre-built store. Takes precedence over `databaseFile`; tests inject one. */
  readonly store?: ScheduledTaskStore;
  /** Path to this surface's own database file. Created if absent. */
  readonly databaseFile?: string;
  /** Seam for the native-addon load, so an unavailable host is reportable. */
  readonly openDatabase?: (file: string) => ScheduledTaskDatabase;
  readonly sendMessage: ScheduledTaskSendMessage;
  /**
   * Opens a session for a `new`-target run. The port's own
   * `WebuiCreateSessionResult.sessionId` is optional, so this seam returns it
   * as-is and the scheduler refuses to deliver a turn without one — a missing
   * session is a failed run, not a message sent to `undefined`.
   */
  readonly createSession: (request: {
    readonly name: string;
  }) => Promise<{ readonly sessionId?: string }>;
  readonly now?: () => number;
  /** Loop period the service uses; also the default lateness allowance. */
  readonly tickIntervalMs?: number;
  /**
   * How late a due slot may be and still count as observed on time. Must stay
   * comfortably above `tickIntervalMs` or a merely-late slot is misreported as
   * a missed one.
   */
  readonly missGraceMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_MISS_GRACE_MS = 5 * 60_000;

function toWire(task: ScheduledTaskRecord): WebuiScheduledTask {
  return {
    taskId: task.taskId,
    name: task.name,
    agentName: task.agentName,
    sessionTarget: task.sessionTarget,
    sessionId: task.sessionId,
    prompt: task.prompt,
    scheduleKind: task.scheduleKind,
    runAtMs: task.runAtMs,
    intervalMs: task.intervalMs,
    enabled: task.enabled,
    lastRunAtMs: task.lastRunAtMs,
    lastStatus: task.lastStatus,
    lastError: task.lastError,
    lastResult: task.lastResult,
    lastSessionId: task.lastSessionId,
    nextRunAtMs: task.nextRunAtMs,
    missedCount: task.missedCount,
    lastMissedAtMs: task.lastMissedAtMs,
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
  };
}

type ScheduledGrid = Pick<
  ScheduledTaskRecord,
  "scheduleKind" | "intervalMs" | "runAtMs"
>;

/** The grid's period, or `null` when the task has no recurring schedule. */
function gridPeriod(task: ScheduledGrid, fallbackMs: number): number | null {
  if (task.scheduleKind === "once") return null;
  const interval = task.intervalMs ?? 0;
  return interval > 0 ? interval : null;
}

/**
 * The next slot strictly after `fromMs`.
 *
 * Strictly after, not at-or-after: a run that consumed slot S must not be
 * handed S back, or one slot would be consumed twice.
 */
function nextSlotAfter(task: ScheduledGrid, fromMs: number): number | null {
  const interval = gridPeriod(task, fromMs);
  if (interval === null) return null;
  const anchor = task.runAtMs ?? fromMs;
  if (fromMs < anchor) return anchor;
  return anchor + (Math.floor((fromMs - anchor) / interval) + 1) * interval;
}

/**
 * The first slot at or after `fromMs` — the one currently open.
 *
 * This is the question a missed run asks, and it is deliberately not
 * `nextSlotAfter`: after a downtime the slot under the clock right now is the
 * one the user is waiting for, so arming the slot *after* it would push an
 * hourly task another hour into the future purely because the process was off.
 */
function firstSlotFrom(task: ScheduledGrid, fromMs: number): number | null {
  const interval = gridPeriod(task, fromMs);
  if (interval === null) return null;
  const anchor = task.runAtMs ?? fromMs;
  if (fromMs <= anchor) return anchor;
  return anchor + Math.ceil((fromMs - anchor) / interval) * interval;
}

export class WebuiScheduledTaskRuntime {
  private readonly now: () => number;
  private readonly missGraceMs: number;
  private readonly inFlight = new Set<string>();
  private store: ScheduledTaskStore | undefined;
  /** Why the store could not be opened, when it could not. */
  private unavailableReason: string | undefined;
  private disposed = false;

  constructor(private readonly options: WebuiScheduledTaskRuntimeOptions) {
    this.now = options.now ?? (() => Date.now());
    this.missGraceMs = options.missGraceMs ?? DEFAULT_MISS_GRACE_MS;
    if (options.store) {
      this.store = options.store;
      return;
    }
    const file = options.databaseFile;
    if (!file) {
      this.unavailableReason =
        "scheduled tasks have no store: neither a store nor a database file was configured";
      return;
    }
    try {
      const open = options.openDatabase ?? openScheduledTaskDatabase;
      this.store = new ScheduledTaskStore(open(file));
    } catch (error) {
      this.unavailableReason =
        error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Whether this host can serve the surface at all, and why not when it
   * cannot. A client asks this before rendering the panel, so an unavailable
   * native addon is a state the UI can show rather than a 500 on first click.
   */
  async getScheduledTaskCapability(): Promise<WebuiScheduledTaskCapability> {
    // `source` is this class's own claim, not the outcome: even when the store
    // failed to open the implementation is still the WebUI's own scheduler,
    // and the tripwire that watches for the ADR 0012 retirement reads this
    // field to tell the two apart.
    if (this.disposed)
      return {
        available: false,
        source: "webui-own",
        reason: "scheduled tasks are disposed",
      };
    if (!this.store)
      return {
        available: false,
        source: "webui-own",
        reason: this.unavailableReason ?? "scheduled task store is unavailable",
      };
    return { available: true, source: "webui-own" };
  }

  async listScheduledTasks(
    request: { readonly agentName?: string } = {},
  ): Promise<WebuiScheduledTaskListResult> {
    const store = this.requireStore();
    const tasks = store
      .list()
      .filter((task) => !request.agentName || task.agentName === request.agentName)
      .map(toWire);
    return { tasks, total: tasks.length };
  }

  async createScheduledTask(
    request: WebuiCreateScheduledTaskRequest,
  ): Promise<WebuiScheduledTask> {
    const store = this.requireStore();
    const nowMs = this.now();
    const input: ScheduledTaskCreateInput = {
      name: request.name,
      agentName: request.agentName,
      sessionTarget: request.sessionTarget,
      sessionId:
        request.sessionTarget === "existing" ? request.sessionId ?? null : null,
      prompt: request.prompt,
      scheduleKind: request.scheduleKind,
      runAtMs: request.runAtMs ?? null,
      intervalMs:
        request.scheduleKind === "interval" ? request.intervalMs ?? null : null,
      nowMs,
    };
    return toWire(store.create(input));
  }

  async updateScheduledTask(
    request: WebuiUpdateScheduledTaskRequest,
  ): Promise<WebuiScheduledTask> {
    const store = this.requireStore();
    const nowMs = this.now();
    const patch: ScheduledTaskPatch & { nowMs: number } = { nowMs };
    if (request.name !== undefined) patch.name = request.name;
    if (request.prompt !== undefined) patch.prompt = request.prompt;
    if (request.agentName !== undefined) patch.agentName = request.agentName;
    if (request.sessionTarget !== undefined) patch.sessionTarget = request.sessionTarget;
    if (request.sessionId !== undefined) patch.sessionId = request.sessionId;
    if (request.scheduleKind !== undefined) patch.scheduleKind = request.scheduleKind;
    if (request.runAtMs !== undefined) patch.runAtMs = request.runAtMs;
    if (request.intervalMs !== undefined) patch.intervalMs = request.intervalMs;
    if (request.enabled !== undefined) patch.enabled = request.enabled;
    // Re-enabling a task with no future slot would leave it permanently
    // invisible-but-armed, so the first slot is recomputed from the schedule.
    if (request.enabled === true && request.nextRunAtMs === undefined) {
      const current = store.get(request.taskId);
      if (current && current.nextRunAtMs === null) {
        patch.nextRunAtMs =
          firstSlotFrom(
            {
              scheduleKind: request.scheduleKind ?? current.scheduleKind,
              intervalMs: request.intervalMs ?? current.intervalMs,
              runAtMs: request.runAtMs ?? current.runAtMs,
            },
            nowMs,
          );
      }
    }
    const updated = store.update(request.taskId, patch);
    if (!updated) throw new Error(`scheduled task not found: ${request.taskId}`);
    return toWire(updated);
  }

  /** Idempotent: deleting an absent task reports absence, not an error. */
  async deleteScheduledTask(
    request: { readonly taskId: string },
  ): Promise<{ readonly success: boolean }> {
    const store = this.requireStore();
    return { success: store.remove(request.taskId) };
  }

  /**
   * Runs a task now, without touching its schedule. A manual run does not
   * consume the next automatic slot, so pressing the button cannot silently
   * skip a scheduled run.
   */
  async triggerScheduledTaskNow(
    request: { readonly taskId: string },
  ): Promise<WebuiScheduledTaskTriggerResult> {
    const store = this.requireStore();
    const task = store.get(request.taskId);
    if (!task) throw new Error(`scheduled task not found: ${request.taskId}`);
    if (this.inFlight.has(task.taskId))
      return { taskId: task.taskId, started: false, status: "already_running" };
    const outcome = await this.execute(task, this.now(), false);
    return {
      taskId: task.taskId,
      started: true,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /**
   * One pass of the schedule. Called by the service's timer, which is the only
   * thing that drives it — this method has no timer of its own, so a runtime
   * that is constructed but never attached to a service never fires anything.
   */
  async tick(): Promise<ScheduledTaskTickResult> {
    const store = this.store;
    if (this.disposed || !store)
      return { firedTaskIds: [], missedTaskIds: [], failedTaskIds: [] };
    const nowMs = this.now();
    const firedTaskIds: string[] = [];
    const missedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (const task of store.dueTasks(nowMs)) {
      if (this.inFlight.has(task.taskId)) continue;
      const dueAtMs = task.nextRunAtMs ?? nowMs;
      if (nowMs - dueAtMs > this.missGraceMs) {
        // Came due during a shutdown. Counted, not replayed — see the header.
        store.recordMissed(task.taskId, {
          missedAtMs: dueAtMs,
          nextRunAtMs: firstSlotFrom(task, nowMs),
          // A one-shot task that was missed has nothing left to do; leaving it
          // armed would mean a slot that can only ever be missed again.
          enabled: task.scheduleKind === "interval",
          nowMs,
        });
        missedTaskIds.push(task.taskId);
        continue;
      }
      this.inFlight.add(task.taskId);
      try {
        const outcome = await this.execute(task, dueAtMs);
        if (outcome.status === "failed") failedTaskIds.push(task.taskId);
        else firedTaskIds.push(task.taskId);
      } finally {
        this.inFlight.delete(task.taskId);
      }
    }
    return { firedTaskIds, missedTaskIds, failedTaskIds };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inFlight.clear();
    try {
      this.store?.close();
    } catch {
      // The database is already gone; a failure to close must not mask the
      // shutdown that is already in progress.
    }
    this.store = undefined;
  }

  private requireStore(): ScheduledTaskStore {
    const store = this.store;
    if (this.disposed) throw new Error("scheduled tasks are disposed");
    if (!store)
      throw new Error(
        this.unavailableReason ?? "scheduled task store is unavailable",
      );
    return store;
  }

  /**
   * Delivers one run and records the result. Nothing here is allowed to throw:
   * a scheduler that dies on the first failed turn would turn a transient agent
   * error into a permanently dead surface, so every failure becomes a recorded
   * `failed` status instead.
   */
  private async execute(
    task: ScheduledTaskRecord,
    ranAtMs: number,
    advanceSchedule = true,
  ): Promise<ScheduledTaskOutcome> {
    const recurring = task.scheduleKind === "interval";
    // A manual run reports its outcome but leaves the automatic schedule
    // alone: pressing the button must not consume the next scheduled slot.
    const nextRunAtMs = advanceSchedule
      ? nextSlotAfter(task, ranAtMs)
      : task.nextRunAtMs;
    const enabled = advanceSchedule ? recurring : task.enabled;
    try {
      let sessionId = task.sessionId;
      if (task.sessionTarget === "new" || !sessionId) {
        // The agent name belongs on session creation; a session's agent is
        // fixed once it exists, which is why an existing target needs none.
        const created = await this.options.createSession({
          name: task.agentName,
        });
        if (!created.sessionId)
          throw new Error(
            `the runtime created no session for agent ${task.agentName}`,
          );
        sessionId = created.sessionId;
      }
      const result = await this.options.sendMessage({
        id: sessionId,
        content: task.prompt,
      });
      if (!result.ok) {
        const message = result.body?.message ?? `status ${result.status}`;
        return this.failed(task, ranAtMs, nextRunAtMs, enabled, message);
      }
      // The turn runs in the runtime and reports through the stream. Draining
      // it is what turns "the prompt was accepted" into "the prompt finished";
      // an abandoned iterator would leave the outcome unknown forever.
      let frames = 0;
      for await (const _frame of result.source) frames += 1;
      const outcome: ScheduledTaskOutcome = {
        ranAtMs,
        status: "succeeded",
        result: `${frames} stream frame(s)`,
        sessionId,
        nextRunAtMs,
        enabled,
      };
      this.requireStore().recordOutcome(task.taskId, outcome);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.failed(task, ranAtMs, nextRunAtMs, enabled, message);
    }
  }

  private failed(
    task: ScheduledTaskRecord,
    ranAtMs: number,
    nextRunAtMs: number | null,
    enabled: boolean,
    message: string,
  ): ScheduledTaskOutcome {
    // A recurring task keeps its schedule after a failure — a transient agent
    // error must not disarm it — but the failure is visible on the row.
    this.requireStore().recordOutcome(task.taskId, {
      ranAtMs,
      status: "failed",
      error: message,
      nextRunAtMs,
      enabled,
    });
    return {
      ranAtMs,
      status: "failed",
      error: message,
      nextRunAtMs,
      enabled,
    };
  }
}
