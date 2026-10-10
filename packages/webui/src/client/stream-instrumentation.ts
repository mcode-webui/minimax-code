// Test-only instrumentation for the cursor-ordering invariant. The
// ordering itself (cursor advances only after the frame's data change
// has been applied) is not externally observable from any consumer
// that only sees the reducer's return value — the cursor and the
// data step apply disjoint fields, so a reducer that swapped them
// still produces the same final state. This module is the only place
// outside the reducer that can observe the order, and it does so
// through the probe the reducer carries in its third argument.
//
// It takes the reducer as an argument instead of importing it. This
// module is classified `mechanisms`, and a mechanism may import only
// `contracts` and `shared` (plan §7.2), so importing
// `projection/stream-state.ts` from here would be a boundary
// violation. The type parameters keep the module free of stream types
// altogether: the caller's reducer fixes `S` and `F`.
//
// Production code MUST NOT import from this module. There is no
// runtime guard enforcing that; the rule is by convention. The
// module path (`stream-instrumentation.ts`), the leading underscores
// on its exports, and the `@internal` comment on `ReduceOptions` are
// deliberately loud so a code review catches accidental production
// use.

/**
 * Snapshot of a state transition the reducer applies. Tests use these
 * labels to assert that the cursor is committed only at `after-cursor`,
 * never at `after-data`.
 */
export type ReduceCheckpoint = "after-data" | "after-cursor";

/**
 * @internal — production code must not import this type or pass
 * `options` to the reducer. The type lives here on purpose: any caller
 * that wants the probe has to import this module explicitly, which
 * surfaces the test-only boundary in code review.
 */
export interface ReduceOptions<S> {
  readonly probe?: (snapshot: S, checkpoint: ReduceCheckpoint) => void;
}

/** The reducer shape this module drives: state in, state out. */
export type StreamReduce<S, F> = (
  state: S,
  frame: F,
  options?: ReduceOptions<S>,
) => S;

/**
 * Run the reducer with a probe attached. The probe receives one
 * snapshot after the frame's data step and one after its cursor step.
 * Tests use this helper instead of calling the reducer directly with
 * the probe, so the test-only instrumentation module is the only place
 * the production reducer is invoked with options.
 */
export function __webuiProbeReduce<S, F>(
  reduce: StreamReduce<S, F>,
  state: S,
  frame: F,
  probe: NonNullable<ReduceOptions<S>["probe"]>,
): S {
  return reduce(state, frame, { probe });
}
