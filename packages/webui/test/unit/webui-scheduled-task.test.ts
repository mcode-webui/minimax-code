// Server-side scheduled tasks (`定时任务`) for the WebUI process.
//
// The scope here is the WebUI's OWN scheduler: its own SQLite file, its own
// table, its own tick loop. It is deliberately not the desktop client's
// scheduled-task engine, and the two never see each other — see the header of
// `src/server/scheduled-task-scheduler.ts` for why reading the v2 table was
// rejected rather than merely avoided.
//
// What this file pins:
//   1. The store's schema migration is idempotent and non-destructive across
//      restarts (the WebUI is an on-demand process; this file is the first
//      persistence the service owns).
//   2. list / create / update / delete.
//   3. A due task fires exactly once, through the host's `sendMessage`.
//   4. A failed delivery is recorded as a failure, never swallowed.
//   5. THE product boundary: a run that came due while webui was NOT running
//      is not replayed, but it is counted and timestamped so the panel can say
//      "missed N times" instead of silently losing it.
//   6. The service owns the loop (beside the heartbeat) and the six operations
//      are wired into the operation registry.

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import {
  SCHEDULED_TASK_SCHEMA_VERSION,
  openScheduledTaskDatabase,
  ScheduledTaskStore,
} from "../../src/server/scheduled-task-store.js";
import {
  WebuiScheduledTaskRuntime,
  type ScheduledTaskSendMessage,
} from "../../src/server/scheduled-task-scheduler.js";
import { createHarnessPortFromHost } from "../../src/server/host.js";
import {
  createOperationRegistry,
  createScheduledTaskOperation,
  deleteScheduledTaskOperation,
  getScheduledTaskCapabilityOperation,
  listScheduledTasksOperation,
  updateScheduledTaskOperation,
} from "../../src/server/operation/operations.js";
import { WebuiService } from "../../src/server/service.js";
import { WEBUI_PROTOCOL_VERSION } from "../../src/server/envelope.js";
import {
  LIST_SCHEDULED_TASKS_OPERATION_NAME,
  CREATE_SCHEDULED_TASK_OPERATION_NAME,
  UPDATE_SCHEDULED_TASK_OPERATION_NAME,
  DELETE_SCHEDULED_TASK_OPERATION_NAME,
  TRIGGER_SCHEDULED_TASK_OPERATION_NAME,
  GET_SCHEDULED_TASK_CAPABILITY_OPERATION_NAME,
} from "../../src/server/operation/names.js";

/** One request, one response frame — the client's actual path. */
function requestOnce(ws: WebSocket, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: import("ws").RawData) => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      try {
        resolve(JSON.parse(raw.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.send(JSON.stringify(request));
  });
}

/** A host that carries no scheduled-task runtime: the fail-closed path. */
function hostWithoutScheduledTasks(): Parameters<typeof createHarnessPortFromHost>[0] {
  return { apiHost: { close: async () => undefined } };
}

function temporaryDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), "webui-scheduled-task-"));
}

interface Harness {
  readonly store: ScheduledTaskStore;
  readonly runtime: WebuiScheduledTaskRuntime;
  readonly sent: Array<{ readonly sessionId: string; readonly prompt: string }>;
  readonly created: Array<{ readonly name: string }>;
  setNow(value: number): void;
  setDelivery(failure: Error | undefined): void;
  close(): void;
}

function createHarness(
  options: {
    readonly tickIntervalMs?: number;
    readonly missGraceMs?: number;
    /** Use the wall clock, for the case where the service owns the timer. */
    readonly realClock?: boolean;
  } = {},
): Harness {
  const directory = temporaryDirectory();
  let now = 1_700_000_000_000;
  let failure: Error | undefined;
  const sent: Array<{ sessionId: string; prompt: string }> = [];
  const created: Array<{ name: string }> = [];
  const store = new ScheduledTaskStore(
    openScheduledTaskDatabase(path.join(directory, "scheduled-tasks.sqlite")),
  );
  const sendMessage: ScheduledTaskSendMessage = async (request) => {
    sent.push({ sessionId: request.id, prompt: request.content ?? "" });
    if (failure) throw failure;
    return { ok: true, source: [{ eventJson: "{}" }] };
  };
  const runtime = new WebuiScheduledTaskRuntime({
    store,
    now: options.realClock ? () => Date.now() : () => now,
    tickIntervalMs: options.tickIntervalMs ?? 30,
    missGraceMs: options.missGraceMs ?? 60_000,
    createSession: async (request) => {
      created.push({ name: request.name });
      if (failure) throw failure;
      return { sessionId: `session-${created.length}` };
    },
    sendMessage,
  });
  return {
    store,
    runtime,
    sent,
    created,
    setNow: (value) => {
      now = value;
    },
    setDelivery: (value) => {
      failure = value;
    },
    close: () => {
      runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("scheduled task store", () => {
  it("migrates on first open and is idempotent across restarts", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "scheduled-tasks.sqlite");
    try {
      const first = openScheduledTaskDatabase(file);
      expect(new ScheduledTaskStore(first).schemaVersion()).toBe(SCHEDULED_TASK_SCHEMA_VERSION);
      const store = new ScheduledTaskStore(first);
      const created = store.create({
        name: "nightly",
        agentName: "main",
        sessionTarget: "existing",
        sessionId: "session-1",
        prompt: "summarise the day",
        scheduleKind: "interval",
        intervalMs: 60_000,
        nowMs: 1_000,
      });
      store.close();

      // A second start must neither re-run destructively nor lose the row.
      const second = openScheduledTaskDatabase(file);
      expect(new ScheduledTaskStore(second).schemaVersion()).toBe(SCHEDULED_TASK_SCHEMA_VERSION);
      const reopened = new ScheduledTaskStore(second);
      expect(reopened.list().map((task) => task.taskId)).toEqual([
        created.taskId,
      ]);
      // And migrating an already-migrated file is a no-op, not an error.
      expect(() => reopened.migrate()).not.toThrow();
      expect(reopened.list()).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supports list, create, update and delete", () => {
    const harness = createHarness();
    try {
      expect(harness.store.list()).toEqual([]);
      const created = harness.store.create({
        name: "hourly",
        agentName: "main",
        sessionTarget: "new",
        sessionId: null,
        prompt: "check the build",
        scheduleKind: "interval",
        intervalMs: 3_600_000,
        runAtMs: 5_000,
        nowMs: 1_000,
      });
      expect(created.enabled).toBe(true);
      expect(created.nextRunAtMs).toBe(5_000);
      expect(harness.store.list()).toHaveLength(1);

      const updated = harness.store.update(created.taskId, {
        prompt: "check the release build",
        enabled: false,
        nowMs: 2_000,
      });
      expect(updated?.prompt).toBe("check the release build");
      expect(updated?.enabled).toBe(false);
      expect(harness.store.get(created.taskId)?.updatedAtMs).toBe(2_000);

      expect(harness.store.remove(created.taskId)).toBe(true);
      // Deleting twice reports absence rather than throwing, so a panel that
      // retries a delete does not have to distinguish the two cases.
      expect(harness.store.remove(created.taskId)).toBe(false);
      expect(harness.store.list()).toEqual([]);
    } finally {
      harness.close();
    }
  });
});

describe("scheduled task scheduler", () => {
  it("fires a due task exactly once through the host's sendMessage", async () => {
    const harness = createHarness();
    try {
      const task = harness.store.create({
        name: "interval",
        agentName: "main",
        sessionTarget: "existing",
        sessionId: "session-7",
        prompt: "run the report",
        scheduleKind: "interval",
        intervalMs: 1_000,
        runAtMs: 1_500,
        nowMs: 1_000,
      });
      harness.setNow(1_500);
      const fired = await harness.runtime.tick();
      expect(fired.firedTaskIds).toEqual([task.taskId]);
      expect(harness.sent).toEqual([
        { sessionId: "session-7", prompt: "run the report" },
      ]);
      const afterFirst = harness.store.get(task.taskId);
      expect(afterFirst?.lastStatus).toBe("succeeded");
      expect(afterFirst?.lastRunAtMs).toBe(1_500);
      // The interval is anchored on the due time, not on "now + interval",
      // so a late tick does not drift the schedule forward.
      expect(afterFirst?.nextRunAtMs).toBe(2_500);

      // A tick that finds nothing due must not fire again.
      const second = await harness.runtime.tick();
      expect(second.firedTaskIds).toEqual([]);
      expect(harness.sent).toHaveLength(1);

      harness.setNow(2_500);
      await harness.runtime.tick();
      expect(harness.sent).toHaveLength(2);
    } finally {
      harness.close();
    }
  });

  it("records a failure instead of swallowing it", async () => {
    const harness = createHarness();
    try {
      const task = harness.store.create({
        name: "failing",
        agentName: "main",
        sessionTarget: "existing",
        sessionId: "session-7",
        prompt: "run the report",
        scheduleKind: "once",
        runAtMs: 1_500,
        nowMs: 1_000,
      });
      harness.setDelivery(new Error("agent is busy"));
      harness.setNow(1_500);
      const fired = await harness.runtime.tick();
      expect(fired.failedTaskIds).toEqual([task.taskId]);
      const failed = harness.store.get(task.taskId);
      expect(failed?.lastStatus).toBe("failed");
      expect(failed?.lastError).toContain("agent is busy");
      // A one-shot task is finished either way: a failure must not leave it
      // armed to fire forever, and must not leave it looking pending.
      expect(failed?.enabled).toBe(false);
      expect(failed?.nextRunAtMs).toBeNull();
    } finally {
      harness.close();
    }
  });

  it("does not replay runs missed while webui was closed, but counts them", async () => {
    const harness = createHarness();
    try {
      // The task was due 3 hours ago. webui was not running then, by design:
      // an on-demand process does not catch up on the work it was not alive
      // to do. The product boundary says "do not replay" — this test exists so
      // that boundary can never be quietly turned into a catch-up loop.
      const task = harness.store.create({
        name: "while-asleep",
        agentName: "main",
        sessionTarget: "existing",
        sessionId: "session-7",
        prompt: "run the report",
        scheduleKind: "interval",
        intervalMs: 3_600_000,
        runAtMs: 1_000,
        nowMs: 1_000,
      });
      harness.setNow(1_000 + 3 * 3_600_000);
      const outcome = await harness.runtime.tick();

      expect(outcome.firedTaskIds).toEqual([]);
      expect(harness.sent).toEqual([]);
      expect(outcome.missedTaskIds).toEqual([task.taskId]);
      const missed = harness.store.get(task.taskId);
      expect(missed?.missedCount).toBe(1);
      expect(missed?.lastMissedAtMs).toBe(1_000);
      expect(missed?.lastRunAtMs).toBeNull();
      // A missed run is not a failure: nothing was attempted.
      expect(missed?.lastStatus).toBe("missed");
      // The next occurrence is the next slot on the grid, not a replay of the
      // slot that was lost, so one downtime cannot cascade into a burst. Here
      // `now` sits exactly on a slot boundary, so that boundary is what the
      // task is armed for — the slot that was lost is the earlier one, and the
      // current slot still gets its turn on the next tick.
      expect(missed?.nextRunAtMs).toBe(1_000 + 3 * 3_600_000);
      harness.setNow(1_000 + 3 * 3_600_000 + 1_000);
      await harness.runtime.tick();
      expect(harness.sent).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("creates a session for a new-session target and records which one", async () => {
    const harness = createHarness();
    try {
      const task = harness.store.create({
        name: "new-session",
        agentName: "main",
        sessionTarget: "new",
        sessionId: null,
        prompt: "start a fresh report",
        scheduleKind: "once",
        runAtMs: 1_500,
        nowMs: 1_000,
      });
      harness.setNow(1_500);
      await harness.runtime.tick();
      expect(harness.created).toEqual([{ name: "main" }]);
      expect(harness.sent).toEqual([
        { sessionId: "session-1", prompt: "start a fresh report" },
      ]);
      expect(harness.store.get(task.taskId)?.lastSessionId).toBe("session-1");
    } finally {
      harness.close();
    }
  });

  it("runs a task on demand without waiting for its schedule", async () => {
    const harness = createHarness();
    try {
      const task = harness.store.create({
        name: "manual",
        agentName: "main",
        sessionTarget: "existing",
        sessionId: "session-7",
        prompt: "run the report",
        scheduleKind: "interval",
        intervalMs: 3_600_000,
        runAtMs: 1_000 + 10 * 3_600_000,
        nowMs: 1_000,
      });
      const result = await harness.runtime.triggerScheduledTaskNow({
        taskId: task.taskId,
      });
      expect(result.started).toBe(true);
      expect(harness.sent).toHaveLength(1);
      // A manual run must not consume the scheduled slot: the next automatic
      // run stays where it was.
      expect(harness.store.get(task.taskId)?.nextRunAtMs).toBe(
        1_000 + 10 * 3_600_000,
      );
    } finally {
      harness.close();
    }
  });

  it("reports the capability as unavailable when the store cannot be opened", async () => {
    const runtime = new WebuiScheduledTaskRuntime({
      store: undefined,
      databaseFile: path.join(temporaryDirectory(), "nested", "store.sqlite"),
      openDatabase: () => {
        throw new Error("sqlite native module is missing");
      },
      sendMessage: async () => ({ ok: true, source: [] }),
      createSession: async () => ({ sessionId: "unused" }),
    });
    try {
      const capability = await runtime.getScheduledTaskCapability();
      expect(capability.available).toBe(false);
      expect(capability.reason).toContain("sqlite native module is missing");
      await expect(runtime.listScheduledTasks()).rejects.toThrow(
        /sqlite native module is missing/u,
      );
    } finally {
      runtime.dispose();
    }
  });
});

describe("scheduled task service wiring", () => {
  it("rejects an inexpressible schedule instead of crashing on it", async () => {
    // Regression: the validators return `null` for an absent optional field,
    // and `typeof null === "object"` made that look like a failure object. The
    // dispatcher then read `.ok` off a `null` and the whole message handler
    // threw, taking the request down instead of answering it.
    const harness = createHarness();
    try {
      // Driven through the typed descriptors, so the payload each one accepts
      // is checked at compile time too.
      const invalidCases = [
        // A recurring task with no interval, and a one-shot with no moment:
        // both are missing the half that makes them expressible.
        [createScheduledTaskOperation, { name: "a", agentName: "main", sessionTarget: "new", prompt: "p", scheduleKind: "interval" }],
        [createScheduledTaskOperation, { name: "a", agentName: "main", sessionTarget: "new", prompt: "p", scheduleKind: "once" }],
        [createScheduledTaskOperation, { name: "", agentName: "main", sessionTarget: "new", prompt: "p", scheduleKind: "once", runAtMs: 1 }],
        [createScheduledTaskOperation, { name: "a", agentName: "main", sessionTarget: "existing", prompt: "p", scheduleKind: "once", runAtMs: 1 }],
        [createScheduledTaskOperation, { name: "a", agentName: "main", sessionTarget: "new", prompt: "p", scheduleKind: "interval", intervalMs: 1 }],
        [updateScheduledTaskOperation, { taskId: "x" }],
        [deleteScheduledTaskOperation, {}],
        [listScheduledTasksOperation, { agentName: "" }],
        [getScheduledTaskCapabilityOperation, { unexpected: true }],
      ] as const;
      for (const [operation, body] of invalidCases) {
        const validated = operation.validate(body);
        expect(
          (validated as { readonly ok?: boolean })?.ok,
          `${operation.name} must answer, not throw`,
        ).toBe(false);
      }

      // The other half of the same regression: an explicit `null` for an
      // optional field is a *value*, not a failure, so the create must be
      // accepted and the null must survive into the stored row.
      const validated = createScheduledTaskOperation.validate({
        name: "a",
        agentName: "main",
        sessionTarget: "new",
        prompt: "p",
        scheduleKind: "interval",
        intervalMs: 1_000,
        runAtMs: null,
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error("expected the create to validate");
      const created = await harness.runtime.createScheduledTask(validated.body);
      expect(created.runAtMs).toBeNull();
      expect(created.intervalMs).toBe(1_000);
    } finally {
      harness.close();
    }
  });

  it("fails closed on a host with no scheduled-task runtime", async () => {
    const port = createHarnessPortFromHost(hostWithoutScheduledTasks());
    await expect(port.listScheduledTasks()).rejects.toThrow(
      /scheduled tasks are not available/u,
    );
    expect(await port.getScheduledTaskCapability()).toEqual({
      available: false,
      source: "none",
      reason: expect.stringContaining("scheduled tasks are not available"),
    });
  });

  it("builds its own runtime from the dataDir the port reports", async () => {
    // The production path: no caller passes a runtime, and the surface is
    // still live, because `version().dataDir` is the only thing it needs. A
    // service that only worked with an injected runtime would be unreachable
    // in the shipped CLI, where nothing constructs one.
    const dataDir = temporaryDirectory();
    const sent: Array<{ readonly id: string; readonly content?: string }> = [];
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => undefined },
      dataDir,
      cliService: {
        createSession: async (request: { readonly name: string }) => ({
          sessionId: `session-for-${request.name}`,
        }),
        sendMessage: async (request: { readonly id: string; readonly content?: string }) => {
          sent.push({ id: request.id, ...(request.content === undefined ? {} : { content: request.content }) });
          return { ok: true as const, source: [{ eventJson: "{}" }] };
        },
      } as never,
    });
    const service = new WebuiService({
      port,
      dev: true,
      scheduledTaskTickIntervalMs: 20,
    });
    try {
      // The runtime belongs to the service, not to the port, so it is reached
      // the way a browser reaches it: over the wire.
      const info = await service.start();
      const ws = new WebSocket(info.boundUrl);
      ws.on("error", () => undefined);
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const call = async (operation: string, body: unknown) => {
        const response = (await requestOnce(ws, {
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId: `req-${operation}`,
          operation,
          body,
        })) as { readonly kind: string; readonly body?: unknown };
        expect(response.kind, `${operation} must not be an error frame`).toBe(
          "response",
        );
        return response.body;
      };

      expect(await call(GET_SCHEDULED_TASK_CAPABILITY_OPERATION_NAME, undefined)).toEqual({
        available: true,
        // The wire shape names the implementation, so the surface a client
        // can reach is itself evidence of which scheduler is in place.
        source: "webui-own",
      });

      const created = (await call(CREATE_SCHEDULED_TASK_OPERATION_NAME, {
        name: "own-runtime",
        agentName: "main",
        sessionTarget: "new",
        prompt: "run the report",
        scheduleKind: "once",
        runAtMs: Date.now(),
      })) as { readonly taskId: string; readonly enabled: boolean };
      expect(created.enabled).toBe(true);
      // The store is this surface's own file, under the host's dataDir.
      expect(
        existsSync(path.join(dataDir, "webui", "scheduled-tasks.sqlite")),
      ).toBe(true);

      const deadline = Date.now() + 4_000;
      while (sent.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(sent).toEqual([
        { id: "session-for-main", content: "run the report" },
      ]);
      const listed = (await call(LIST_SCHEDULED_TASKS_OPERATION_NAME, {})) as {
        readonly tasks: ReadonlyArray<{ readonly lastStatus: string | null }>;
      };
      expect(listed.tasks[0]?.lastStatus).toBe("succeeded");
      ws.close();
    } finally {
      await service.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports the capability as unavailable when the host has no dataDir", async () => {
    const port = createHarnessPortFromHost(hostWithoutScheduledTasks());
    expect(await port.getScheduledTaskCapability()).toEqual({
      available: false,
      source: "none",
      reason: expect.stringContaining("scheduled tasks are not available"),
    });
  });

  it("registers all six operations and runs the loop beside the heartbeat", async () => {
    const harness = createHarness({ tickIntervalMs: 20, realClock: true });
    const service = new WebuiService({
      port: createHarnessPortFromHost(hostWithoutScheduledTasks()),
      dev: true,
      scheduledTasks: { runtime: harness.runtime, tickIntervalMs: 20 },
    });
    try {
      const registry = createOperationRegistry(
        createHarnessPortFromHost(hostWithoutScheduledTasks()),
      );
      for (const name of [
        LIST_SCHEDULED_TASKS_OPERATION_NAME,
        CREATE_SCHEDULED_TASK_OPERATION_NAME,
        UPDATE_SCHEDULED_TASK_OPERATION_NAME,
        DELETE_SCHEDULED_TASK_OPERATION_NAME,
        TRIGGER_SCHEDULED_TASK_OPERATION_NAME,
        GET_SCHEDULED_TASK_CAPABILITY_OPERATION_NAME,
      ]) {
        expect(registry.has(name), `expected ${name} in the registry`).toBe(
          true,
        );
      }

      const task = harness.store.create({
        name: "service-driven",
        agentName: "main",
        sessionTarget: "existing",
        sessionId: "session-9",
        prompt: "run the report",
        scheduleKind: "once",
        runAtMs: Date.now(),
        nowMs: Date.now(),
      });
      const info = await service.start();
      expect(info.host).toBe("127.0.0.1");

      // The tick loop lives in the service, not in the runtime: nothing calls
      // `tick()` here, so a fired task proves the service is driving it.
      const deadline = Date.now() + 3_000;
      while (harness.sent.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(harness.sent).toEqual([
        { sessionId: "session-9", prompt: "run the report" },
      ]);
      expect(harness.store.get(task.taskId)?.lastStatus).toBe("succeeded");
    } finally {
      await service.close();
      harness.close();
    }
  });
});
