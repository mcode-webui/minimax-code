// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiCronTask` | One scheduled task as the panel reads it. | Runtime `listCronTasks` / `createCronTask` / `updateCronTask` (`runtime/harness/cron.ts`). | `runtime/harness/cron.ts`; the scheduled-task panel (later ticket). |
// | `WebuiCronTaskPage` | One page of scheduled tasks. | Runtime `listCronTasks`. | `runtime/harness/cron.ts`; the scheduled-task panel. |
// | `WebuiCronRun` | One cron run: its status, its session and its failure. | Runtime `listCronTaskRuns` / `runCronTaskNow`. | `runtime/harness/cron.ts`; the run-history view. |
// | `WebuiCronRunPage` | One page of cron runs. | Runtime `listCronTaskRuns`. | `runtime/harness/cron.ts`; the run-history view. |
//
// The runtime's own cron view types are deliberately absent here: `src/shared` may not import
// them, so the harness adapter converts. What stays here is what the browser is allowed to know —
// a schedule it can render, a status it can translate, and the identity every request needs.

/** A schedule the panel can render without the runtime's cron types. */
export type WebuiCronSchedule =
  | {
      readonly kind: "recurring";
      readonly expression: string;
      readonly timezone?: string;
      readonly maxRuns?: number;
    }
  | { readonly kind: "once"; readonly runAtMs: number };

/**
 * Where a run's turn is delivered.
 *
 * `sessionId` absent means "a fresh session per run": the runtime mints it, and the panel reads it
 * back from the run rather than predicting it.
 */
export type WebuiCronSessionTarget =
  | { readonly mode: "new" }
  | { readonly mode: "sessionId"; readonly sessionId?: string };

export interface WebuiCronTask {
  readonly cronId: string;
  readonly name: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly schedule: WebuiCronSchedule;
  readonly sessionTarget: WebuiCronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
  /** The next slot the shared scheduler job is armed for; absent once the task is finished. */
  readonly nextRunAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface WebuiCronTaskPage {
  readonly items: readonly WebuiCronTask[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export type WebuiCronRunStatus = "pending" | "delivered" | "failed";
export type WebuiCronRunTriggerSource = "manual" | "scheduled";

export interface WebuiCronRun {
  readonly runId: string;
  readonly cronId: string;
  readonly triggerSource: WebuiCronRunTriggerSource;
  readonly status: WebuiCronRunStatus;
  /** Absent when the run failed before a session was created. */
  readonly sessionId?: string;
  readonly createdAtMs: number;
  readonly deliveredAtMs?: number;
  readonly failedAtMs?: number;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface WebuiCronRunPage {
  readonly items: readonly WebuiCronRun[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiCronTaskListRequest {
  readonly agentName?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WebuiCronTaskCreateRequest {
  readonly name: string;
  readonly agentName: string;
  readonly schedule: WebuiCronSchedule;
  readonly prompt: string;
  readonly enabled?: boolean;
  readonly sessionTarget: WebuiCronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
}

export interface WebuiCronTaskUpdateRequest {
  readonly cronId: string;
  readonly name?: string;
  readonly schedule?: WebuiCronSchedule;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly sessionTarget?: WebuiCronSessionTarget;
  readonly project?: string | null;
  readonly model?: string | null;
}

export interface WebuiCronTaskDeleteRequest {
  readonly cronId: string;
}

export interface WebuiCronTaskRunRequest {
  readonly cronId: string;
}

export interface WebuiCronRunListRequest {
  readonly cronId: string;
  readonly cursor?: string;
  readonly limit?: number;
}
