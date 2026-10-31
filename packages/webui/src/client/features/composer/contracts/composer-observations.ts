// What the composer needs from the application's observation scheduler.
//
// A narrow seam declared here rather than an import of the scheduler: the composer
// registers the foreground reads it depends on and never schedules one itself, so
// it needs exactly this much of the mechanism and nothing about the rail's class,
// its budgets or its suspension policy. Declaring it here is also what keeps the
// composer readable on its own — a reader auditing its input rules does not have to
// leave its tree to learn what an observation is.

import type { WebuiObservationSink } from "../../../../shared/contracts/observations.js";

/** The scheduler, as the composer sees it. */
export type WebuiComposerObservationSink = WebuiObservationSink;
