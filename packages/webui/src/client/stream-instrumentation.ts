// Test-only instrumentation for the cursor-ordering invariant. The
// ordering itself (cursor advances only after the frame's data change
// has been applied) is not externally observable from any consumer
// that only sees the reducer's return value — the cursor and the
// data step apply disjoint fields, so a reducer that swapped them
// still produces the same final state. This module is the only place
// outside the reducer that can observe the order, and it does so
// through a probe the reducer carries in its third argument, typed
// here on purpose so production callers have to reach into this
// module to enable it.
//
// Production code MUST NOT import from this module. There is no
// runtime guard enforcing that; the rule is by convention. The
// module path (`stream-instrumentation.ts`), the leading underscores
// on its exports, and the `@internal` comment on `ReduceOptions` are
// deliberately loud so a code review catches accidental production
// use.

import {
  applyFrameCursor,
  applyFrameData,
  reduceWebuiStreamFrame,
  type WebuiStreamState,
} from "./projection/stream-state.js";
import type { WebuiStreamFrame } from "../shared/contracts/stream.js";

/**
 * Snapshot of a state transition the reducer applies. Tests use these
 * labels to assert that the cursor is committed only at `after-cursor`,
 * never at `after-data`.
 */
export type ReduceCheckpoint = "after-data" | "after-cursor";

/**
 * @internal — production code must not import this type or pass
 * `options` to `reduceWebuiStreamFrame`. The type lives here on
 * purpose: any caller that wants the probe has to import this module
 * explicitly, which surfaces the test-only boundary in code review.
 */
export interface ReduceOptions {
  readonly probe?: (snapshot: WebuiStreamState, checkpoint: ReduceCheckpoint) => void;
}

/**
 * Run the reducer with a probe attached. The probe receives one
 * snapshot after `applyFrameData` and one after `applyFrameCursor`.
 * Tests use this helper instead of calling `reduceWebuiStreamFrame`
 * directly with the probe so the test-only instrumentation module is
 * the only place the production reducer is invoked with options.
 */
export function __webuiProbeReduce(
  state: WebuiStreamState,
  frame: WebuiStreamFrame,
  probe: NonNullable<ReduceOptions["probe"]>,
): WebuiStreamState {
  return reduceWebuiStreamFrame(state, frame, { probe });
}