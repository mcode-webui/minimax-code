// The scheduled-task cell of the harness port (ADR 0027, "The WebUI surface").
//
// The runtime already owns scheduled tasks: the Cron service stores the definitions, the shared
// Scheduler arms the job and the run queue decides who executes. This adapter forwards and
// converts, and it decides nothing — not the schedule, not the next fire time, not whether a run
// is due.
//
// Two things happen here:
//
//   * the runtime's cron view types stop at this file. `shared/contracts/cron.ts` is what the
//     browser may name, and `src/shared` may not import the runtime's cron types, so every field
//     is read and re-emitted rather than passed through. A field the wire declares as required is
//     either read or failed on (`WebuiResultShapeError`), because a task rendered with a guessed
//     name is worse than one that reports it could not be read.
//   * a host composed without an owned Scheduler answers the six members with one refusal. They
//     are optional on the host and required on the port, so the absence is resolved once, here,
//     instead of at six call sites.
import type { CliService } from "@mavis/local-runtime-v2/cli-service";

import { CRON_CAPABILITY_ABSENT, type WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeCliService, WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";
import { WebuiResultShapeError } from "./result-conversion.js";
import { WebuiCapabilityUnavailableError } from "../../shared/envelope.js";
import type {
  WebuiCronRun,
  WebuiCronRunPage,
  WebuiCronRunStatus,
  WebuiCronRunTriggerSource,
  WebuiCronSchedule,
  WebuiCronSessionTarget,
  WebuiCronTask,
  WebuiCronTaskPage,
} from "../../shared/contracts/cron.js";

/** The six members, as one capability. */
type CronMembers = Required<
  Pick<
    WebuiRuntimeCliService,
    | "listCronTasks"
    | "createCronTask"
    | "updateCronTask"
    | "deleteCronTask"
    | "runCronTaskNow"
    | "listCronTaskRuns"
  >
>;

const CRON_MEMBER_NAMES = [
  "listCronTasks",
  "createCronTask",
  "updateCronTask",
  "deleteCronTask",
  "runCronTaskNow",
  "listCronTaskRuns",
] as const;

type RuntimeTask = Awaited<ReturnType<CliService["createCronTask"]>>;
type RuntimeRun = Awaited<ReturnType<CliService["runCronTaskNow"]>>;
type RuntimeSchedule = RuntimeTask["schedule"];

/**
 * The six members, bound to the service they came from.
 *
 * The runtime's methods read `this.options`, so the receiver has to be the service they were
 * destructured from, not this wrapper. Absent means absent as a group: the runtime composes all
 * six from one Cron service, so a host with three of them is broken rather than partial, and
 * refusing all six is the message a client can act on.
 */
function requireCron(host: WebuiRuntimeHostHandle): CronMembers {
  const cliService = requireCliService(host);
  const record = cliService as unknown as Record<string, unknown>;
  for (const name of CRON_MEMBER_NAMES) {
    if (typeof record[name] !== "function") {
      throw new WebuiCapabilityUnavailableError(CRON_CAPABILITY_ABSENT);
    }
  }
  const bound = {} as Record<string, (...args: unknown[]) => unknown>;
  for (const name of CRON_MEMBER_NAMES) {
    const member = record[name] as (...args: unknown[]) => unknown;
    bound[name] = (...args) => member.apply(cliService, args);
  }
  return bound as unknown as CronMembers;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebuiResultShapeError(`a scheduled task field was not readable: ${field}`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WebuiResultShapeError(`a scheduled task field was not readable: ${field}`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new WebuiResultShapeError(`a scheduled task field was not readable: ${field}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new WebuiResultShapeError(`a scheduled task field was not readable: ${field}`);
  }
  return value as T;
}

const RUN_STATUSES: readonly WebuiCronRunStatus[] = ["pending", "delivered", "failed"];
const RUN_TRIGGER_SOURCES: readonly WebuiCronRunTriggerSource[] = ["manual", "scheduled"];

function toSchedule(schedule: RuntimeSchedule): WebuiCronSchedule {
  if (schedule.kind === "once") {
    return { kind: "once", runAtMs: requiredNumber(schedule.runAtMs, "schedule.runAtMs") };
  }
  const timezone = optionalText(schedule.timezone);
  const maxRuns = optionalNumber(schedule.maxRuns);
  return {
    kind: "recurring",
    expression: requiredText(schedule.expression, "schedule.expression"),
    ...(timezone === undefined ? {} : { timezone }),
    ...(maxRuns === undefined ? {} : { maxRuns }),
  };
}

function toSessionTarget(target: RuntimeTask["sessionTarget"]): WebuiCronSessionTarget {
  if (target.mode !== "sessionId") return { mode: "new" };
  const sessionId = optionalText(target.sessionId);
  return { mode: "sessionId", ...(sessionId === undefined ? {} : { sessionId }) };
}

function toTask(task: RuntimeTask): WebuiCronTask {
  const nextRunAtMs = optionalNumber(task.nextRunAtMs);
  return {
    cronId: requiredText(task.cronId, "cronId"),
    name: requiredText(task.name, "name"),
    agentName: requiredText(task.agentName, "agentName"),
    prompt: requiredText(task.prompt, "prompt"),
    enabled: requiredBoolean(task.enabled, "enabled"),
    schedule: toSchedule(task.schedule),
    sessionTarget: toSessionTarget(task.sessionTarget),
    project: task.project ?? null,
    model: task.model ?? null,
    ...(nextRunAtMs === undefined ? {} : { nextRunAtMs }),
    createdAtMs: requiredNumber(task.createdAtMs, "createdAtMs"),
    updatedAtMs: requiredNumber(task.updatedAtMs, "updatedAtMs"),
  };
}

function toRun(run: RuntimeRun): WebuiCronRun {
  const sessionId = optionalText(run.sessionId);
  const deliveredAtMs = optionalNumber(run.deliveredAtMs);
  const failedAtMs = optionalNumber(run.failedAtMs);
  const errorCode = optionalText(run.errorCode);
  const error = optionalText(run.error);
  return {
    runId: requiredText(run.runId, "runId"),
    cronId: requiredText(run.cronId, "cronId"),
    triggerSource: oneOf(run.triggerSource, RUN_TRIGGER_SOURCES, "triggerSource"),
    status: oneOf(run.status, RUN_STATUSES, "status"),
    ...(sessionId === undefined ? {} : { sessionId }),
    createdAtMs: requiredNumber(run.createdAtMs, "createdAtMs"),
    ...(deliveredAtMs === undefined ? {} : { deliveredAtMs }),
    ...(failedAtMs === undefined ? {} : { failedAtMs }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(error === undefined ? {} : { error }),
  };
}

function toPage<TIn, TOut>(
  page: { readonly items?: unknown; readonly hasMore?: unknown; readonly nextCursor?: unknown },
  convert: (item: TIn) => TOut,
): { readonly items: readonly TOut[]; readonly hasMore: boolean; readonly nextCursor?: string } {
  if (!Array.isArray(page.items)) {
    throw new WebuiResultShapeError("a scheduled-task page carried no items list");
  }
  const nextCursor = optionalText(page.nextCursor);
  return {
    items: (page.items as TIn[]).map(convert),
    hasMore: requiredBoolean(page.hasMore, "hasMore"),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function createCronAdapter(host: WebuiRuntimeHostHandle): Pick<
  WebuiHarnessPort,
  | "listCronTasks"
  | "createCronTask"
  | "updateCronTask"
  | "deleteCronTask"
  | "runCronTaskNow"
  | "listCronTaskRuns"
> {
  return {
    async listCronTasks(request): Promise<WebuiCronTaskPage> {
      const page = await requireCron(host).listCronTasks({
        ...(request?.agentName === undefined ? {} : { agentName: request.agentName }),
        ...(request?.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request?.limit === undefined ? {} : { limit: request.limit }),
      });
      return toPage<RuntimeTask, WebuiCronTask>(page, toTask);
    },

    async createCronTask(request): Promise<WebuiCronTask> {
      const created = await requireCron(host).createCronTask({
        name: request.name,
        agentName: request.agentName,
        schedule: request.schedule,
        prompt: request.prompt,
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        sessionTarget: request.sessionTarget,
        ...(request.project === undefined ? {} : { project: request.project }),
        ...(request.model === undefined ? {} : { model: request.model }),
      });
      return toTask(created);
    },

    async updateCronTask(request): Promise<WebuiCronTask> {
      const updated = await requireCron(host).updateCronTask({
        cronId: request.cronId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.schedule === undefined ? {} : { schedule: request.schedule }),
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        ...(request.sessionTarget === undefined ? {} : { sessionTarget: request.sessionTarget }),
        ...(request.project === undefined ? {} : { project: request.project }),
        ...(request.model === undefined ? {} : { model: request.model }),
      });
      return toTask(updated);
    },

    async deleteCronTask(request): Promise<void> {
      await requireCron(host).deleteCronTask({ cronId: request.cronId });
    },

    async runCronTaskNow(request): Promise<WebuiCronRun> {
      return toRun(await requireCron(host).runCronTaskNow(request.cronId));
    },

    async listCronTaskRuns(request): Promise<WebuiCronRunPage> {
      const page = await requireCron(host).listCronTaskRuns({
        cronId: request.cronId,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return toPage<RuntimeRun, WebuiCronRun>(page, toRun);
    },
  };
}
