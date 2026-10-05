import { ownsElectronRuntimeCapabilities } from "../../application/agent/runtime-browser-use-composition.js";

/** Ownership inputs for the process-local scheduling capability. */
export interface ScheduledTaskRuntimeOwnership {
  readonly runtimeOwnerKind?: string;
  /** Frozen host option: `true` requests an owned Scheduler plus `services.cron`. */
  readonly enableScheduledTasks?: boolean;
}

/**
 * Cron-specific ownership predicate. Electron owners, and resident hosts that
 * explicitly opt in with `enableScheduledTasks`, own the in-process Scheduler
 * and the Cron service. Every other host keeps the previous behavior.
 *
 * Kept separate from the `enableChannel` predicate on purpose: that call site
 * shares `ownsElectronRuntimeCapabilities` with cron today, and widening it
 * would open IM channel delivery as a side effect. This predicate layers the
 * opt-in on top of the unchanged Electron rule instead of relaxing it.
 */
export function ownsScheduledTaskRuntime(options: ScheduledTaskRuntimeOwnership): boolean {
  return (
    ownsElectronRuntimeCapabilities(options.runtimeOwnerKind) ||
    options.enableScheduledTasks === true
  );
}

/** Scheduling inputs resolved once during host assembly. */
export interface ScheduledTaskSchedulingInput {
  readonly electronOwner: boolean;
  /** Startup execution policy decides persisted execution for existing owners. */
  readonly startupExecutionEnabled: boolean;
  readonly enableScheduledTasks?: boolean;
}

export interface ScheduledTaskScheduling {
  /** Assemble the in-process Scheduler; false omits it entirely. */
  readonly schedulerOwned: boolean;
  /** Arm croner timers for persisted jobs instead of refreshing them for inspection. */
  readonly restorePersistedJobExecution: boolean;
}

/**
 * Resolves background-runtime scheduling for one host. A host that opted into
 * scheduled tasks always restores persisted job execution, because a resident
 * host exists to run its schedule; every other host keeps the value derived
 * from the startup execution policy.
 */
export function resolveScheduledTaskScheduling(
  input: ScheduledTaskSchedulingInput,
): ScheduledTaskScheduling {
  const scheduledTaskOwner = input.enableScheduledTasks === true;
  return {
    schedulerOwned: input.electronOwner || scheduledTaskOwner,
    restorePersistedJobExecution: scheduledTaskOwner || input.startupExecutionEnabled,
  };
}
