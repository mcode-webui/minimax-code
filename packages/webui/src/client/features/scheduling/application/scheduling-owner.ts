// The scheduled-task list owner.
//
// Framework-free — no React, no DOM — so the transitions are testable against a scripted port
// (`packages/webui/AGENTS.md`: no jsdom in this package).
//
// Two facts it has to get right:
//
//   * **A refresh keeps the rows on screen.** Re-reading the list replaces the surfaces only when an
//     answer arrives; a request in flight shows the previous list with its own status, because a
//     panel that blanks out every five seconds is worse than one that is a little stale.
//   * **An unwired transport is not an empty list.** "This host cannot list scheduled tasks" and
//     "there are no scheduled tasks" are different answers, and only the second one belongs in the
//     empty state.
import type { WebuiCronTask, WebuiCronTaskPage } from "../../../../shared/contracts/cron.js";
import type { SchedulingPort } from "../contracts/scheduling-port.js";

export type WebuiSchedulingStatus = "idle" | "loading" | "ready" | "error";

export interface WebuiSchedulingSnapshot {
  readonly status: WebuiSchedulingStatus;
  readonly tasks: readonly WebuiCronTask[];
  /** Present when the last read failed; the rows are then the last good ones. */
  readonly error?: string;
  readonly loadedAtMs?: number;
}

export interface WebuiSchedulingOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WebuiSchedulingSnapshot;
  /** Reads the list once. Concurrent calls share one request. */
  readonly load: () => Promise<void>;
  /** Re-reads on an interval while the panel is open. Returns the stop function. */
  readonly startRefreshing: () => () => void;
}

export const WEBUI_SCHEDULING_UNAVAILABLE =
  "这个运行时无法列出定时任务（宿主没有定时任务服务）。";
export const WEBUI_SCHEDULING_READ_FAILED = "读取定时任务失败。";

export interface CreateWebuiSchedulingOwnerOptions {
  readonly port: SchedulingPort;
  readonly nowMs?: () => number;
  /** How often the open panel re-reads. Five seconds: a task created in another client shows up. */
  readonly refreshMs?: number;
  readonly setIntervalFn?: (callback: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_REFRESH_MS = 5_000;

export function createWebuiSchedulingOwner(
  options: CreateWebuiSchedulingOwnerOptions,
): WebuiSchedulingOwner {
  const nowMs = options.nowMs ?? Date.now;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const setIntervalFn =
    options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms) as unknown);
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as never));

  const listeners = new Set<() => void>();
  let snapshot: WebuiSchedulingSnapshot = { status: "idle", tasks: [] };
  let inFlight: Promise<void> | undefined;

  const publish = (next: WebuiSchedulingSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const load = async (): Promise<void> => {
    if (inFlight) return inFlight;
    const read = options.port.listCronTasks;
    if (!read) {
      publish({ status: "error", tasks: snapshot.tasks, error: WEBUI_SCHEDULING_UNAVAILABLE });
      return;
    }
    publish({ ...snapshot, status: "loading" });
    inFlight = (async () => {
      try {
        const page: WebuiCronTaskPage = await read({});
        publish({ status: "ready", tasks: page.items, loadedAtMs: nowMs() });
      } catch (error) {
        publish({
          status: "error",
          tasks: snapshot.tasks,
          error: error instanceof Error && error.message ? error.message : WEBUI_SCHEDULING_READ_FAILED,
        });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    load,
    startRefreshing: () => {
      const handle = setIntervalFn(() => void load(), refreshMs);
      return () => clearIntervalFn(handle);
    },
  };
}
