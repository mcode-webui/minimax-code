/**
 * #272: the scheduled-task cell of the harness port.
 *
 * Two claims, both about the boundary rather than about cron:
 *
 *   * the runtime's cron view types convert into the WebUI's own wire DTOs — every required field
 *     read or failed on, every optional field elided rather than emitted as `undefined`, and
 *     `project`/`model` normalised to `null` because the panel distinguishes "no project" from
 *     "not reported";
 *   * a host composed without an owned Scheduler answers all six members with one
 *     `capability_unavailable` refusal instead of crashing on an absent method.
 *
 * The real adapter and the real conversions run here; only the host leaves are scripted.
 */
import { describe, expect, it } from "vitest";

import { createCronAdapter } from "../../src/runtime/harness/cron.js";
import { CRON_CAPABILITY_ABSENT, type WebuiHarnessPort } from "../../src/runtime/port.js";

type CronPort = Pick<
  WebuiHarnessPort,
  | "listCronTasks"
  | "createCronTask"
  | "updateCronTask"
  | "deleteCronTask"
  | "runCronTaskNow"
  | "listCronTaskRuns"
>;

/** One runtime definition, in the shape the runtime's own Cron service returns. */
function runtimeTask(overrides: Record<string, unknown> = {}) {
  return {
    cronId: "cron-1",
    name: "queue digest",
    agentName: "agent-one",
    schedule: { kind: "recurring", expression: "*/5 * * * *", timezone: "UTC" },
    enabled: true,
    prompt: "Summarize the queue.",
    sessionTarget: { mode: "new" },
    nextRunAtMs: 1_800_000,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}

function runtimeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    cronId: "cron-1",
    triggerSource: "scheduled",
    status: "delivered",
    sessionId: "session-1",
    createdAtMs: 10,
    deliveredAtMs: 20,
    ...overrides,
  };
}


/**
 * The six members, since the guard treats them as one capability: a host is either a scheduler host
 * or it is not. Tests override the member under test and leave the rest as honest no-ops.
 */
function cliServiceStub(overrides: Record<string, unknown> = {}) {
  return {
    listCronTasks: () => ({ items: [], hasMore: false }),
    createCronTask: async () => runtimeTask(),
    updateCronTask: async () => runtimeTask(),
    deleteCronTask: async () => undefined,
    runCronTaskNow: async () => runtimeRun(),
    listCronTaskRuns: () => ({ items: [], hasMore: false }),
    ...overrides,
  };
}

function adapterWith(cliService: unknown): CronPort {
  return createCronAdapter({
    apiHost: { close: async () => {} },
    cliService: cliService as never,
  });
}


/** Settles a refusal: an `Error`'s `message` is not an own enumerable property, so read it. */
async function refusal(call: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  const error = (await call().catch((reason: unknown) => reason)) as {
    code?: string;
    message?: string;
  };
  return { ...(error.code === undefined ? {} : { code: error.code }), message: error.message ?? "" };
}

describe("the scheduled-task adapter", () => {
  it("converts a listed definition into the wire task", async () => {
    const port = adapterWith(cliServiceStub({
      listCronTasks: () => ({
        items: [runtimeTask({ project: null, model: "minimax/m2" })],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    }));

    const page = await port.listCronTasks({ agentName: "agent-one", limit: 10 });

    expect(page).toEqual({
      items: [
        {
          cronId: "cron-1",
          name: "queue digest",
          agentName: "agent-one",
          prompt: "Summarize the queue.",
          enabled: true,
          schedule: { kind: "recurring", expression: "*/5 * * * *", timezone: "UTC" },
          sessionTarget: { mode: "new" },
          project: null,
          model: "minimax/m2",
          nextRunAtMs: 1_800_000,
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
        },
      ],
      hasMore: true,
      nextCursor: "cursor-2",
    });
  });

  it("elides a field the runtime did not report instead of emitting undefined", async () => {
    const port = adapterWith(cliServiceStub({
      createCronTask: async () =>
        runtimeTask({ nextRunAtMs: undefined, schedule: { kind: "once", runAtMs: 5_000 } }),
    }));

    const task = await port.createCronTask({
      name: "one shot",
      agentName: "agent-one",
      schedule: { kind: "once", runAtMs: 5_000 },
      prompt: "Once.",
      sessionTarget: { mode: "new" },
    });

    expect("nextRunAtMs" in task).toBe(false);
    expect(task.schedule).toEqual({ kind: "once", runAtMs: 5_000 });
    // The runtime omits `project`/`model` entirely; the wire says `null`.
    expect(task.project).toBeNull();
    expect(task.model).toBeNull();
  });

  it("forwards a delete by identity and a run by id", async () => {
    const deleted: string[] = [];
    const port = adapterWith(cliServiceStub({
      deleteCronTask: async (command: { cronId: string }) => {
        deleted.push(command.cronId);
      },
      runCronTaskNow: async (cronId: string) => runtimeRun({ cronId, triggerSource: "manual" }),
    }));

    await port.deleteCronTask({ cronId: "cron-1" });
    const run = await port.runCronTaskNow({ cronId: "cron-1" });

    expect(deleted).toEqual(["cron-1"]);
    expect(run).toEqual({
      runId: "run-1",
      cronId: "cron-1",
      triggerSource: "manual",
      status: "delivered",
      sessionId: "session-1",
      createdAtMs: 10,
      deliveredAtMs: 20,
    });
  });

  it("refuses a run row whose status the wire does not have, rather than guessing one", async () => {
    const port = adapterWith(cliServiceStub({
      listCronTaskRuns: () => ({
        items: [runtimeRun({ status: "abandoned" })],
        hasMore: false,
      }),
    }));

    expect(await refusal(() => port.listCronTaskRuns({ cronId: "cron-1" }))).toEqual({
      code: "capability_unavailable",
      message: "a scheduled task field was not readable: status",
    });
  });

  it("answers all six members with one refusal on a host without a Cron service", async () => {
    const port = adapterWith({});

    for (const call of [
      () => port.listCronTasks(),
      () =>
        port.createCronTask({
          name: "n",
          agentName: "a",
          schedule: { kind: "once", runAtMs: 1 },
          prompt: "p",
          sessionTarget: { mode: "new" },
        }),
      () => port.updateCronTask({ cronId: "cron-1" }),
      () => port.deleteCronTask({ cronId: "cron-1" }),
      () => port.runCronTaskNow({ cronId: "cron-1" }),
      () => port.listCronTaskRuns({ cronId: "cron-1" }),
    ]) {
      expect(await refusal(call)).toEqual({
        code: "capability_unavailable",
        message: CRON_CAPABILITY_ABSENT,
      });
    }
  });
});
