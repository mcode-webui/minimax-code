// The scheduling business's transport seam.
//
// One method, and it is optional on purpose: a build whose transport does not carry `listCronTasks`
// yet leaves the member `undefined`, and the owner turns that into one stated refusal instead of a
// crash or an empty list that reads as "you have no scheduled tasks".
//
// The request and response types are the shared wire DTOs. This file may not name the runtime's cron
// views — `shared/contracts/cron.ts` is what the browser is allowed to know, and the adapter behind
// the harness is where the conversion happens.
import type {
  WebuiCronRun,
  WebuiCronRunListRequest,
  WebuiCronRunPage,
  WebuiCronTask,
  WebuiCronTaskCreateRequest,
  WebuiCronTaskDeleteRequest,
  WebuiCronTaskListRequest,
  WebuiCronTaskPage,
  WebuiCronTaskRunRequest,
  WebuiCronTaskUpdateRequest,
} from "../../../../shared/contracts/cron.js";

export interface SchedulingPort {
  readonly listCronTasks?: (request: WebuiCronTaskListRequest) => Promise<WebuiCronTaskPage>;
  readonly createCronTask?: (request: WebuiCronTaskCreateRequest) => Promise<WebuiCronTask>;
  readonly updateCronTask?: (request: WebuiCronTaskUpdateRequest) => Promise<WebuiCronTask>;
  readonly deleteCronTask?: (request: WebuiCronTaskDeleteRequest) => Promise<{ readonly success?: boolean }>;
  readonly runCronTaskNow?: (request: WebuiCronTaskRunRequest) => Promise<WebuiCronRun>;
  readonly listCronTaskRuns?: (request: WebuiCronRunListRequest) => Promise<WebuiCronRunPage>;
}
