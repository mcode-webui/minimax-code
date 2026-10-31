// The one shared test-side assembly for hosts that render the shell.
//
// The shell renders an application the composition root assembled; it no longer
// builds a fallback of its own. A fixture that renders the shell
// therefore has to hand it an application built the same way production builds
// one — through `createWebuiApplication` — rather than a second composition with
// different inputs. This helper is that construction, in one place:
//
//   * a no-op event channel, so a markup fixture opens nothing;
//   * the caller's store when it seeds a catalogue, otherwise a fresh one;
//   * no ambient browser storage or runtime activity is accessed during render.
//
// It returns a **dormant** application: constructing performs no IO. A fixture
// that needs the ingress or lifecycle states calls `start()`.

import { createWebuiApplication } from "../../../src/client/application/create-application.js";
import type {
  WebuiApplication,
  WebuiApplicationStart,
} from "../../../src/client/application/create-application.js";
import type { WebuiPortSlices } from "../../../src/client/application/port-slices.js";
import type { WebuiTurnCapabilityPort } from "../../../src/client/features/turn/application/turn-capabilities.js";
import type { GoalPort } from "../../../src/client/features/goal/contracts/goal-port.js";
import type { WebuiSessionStore } from "../../../src/client/application/session-store.js";

/** A channel that accepts one listener and never emits: SSR-shaped hosts. */
export const inertEventChannel = () => ({ subscribe: () => () => undefined });

export interface ApplicationFixtureOptions {
  readonly store?: WebuiSessionStore;
  readonly loadMessages?: (args: { readonly sessionId: string }) => Promise<unknown>;
  /**
   * The per-business port slices the assembly hands its owners. A fixture that
   * supplies a transport-shaped bag must cut them and pass them here: the shell
   * builds no fallback of its own.
   */
  readonly slices?: WebuiPortSlices;
  /**
   * The turn capability port. The substrate publishes its capability slice by
   * cutting this port, so it is derived from the same bag the port
   * slices are cut from rather than shared with them: a fixture that wires only
   * the slices leaves the substrate reporting no send and no enqueue, which a
   * reader sees as "this host cannot send".
   */
  readonly turnCapabilities?: WebuiTurnCapabilityPort;
  /**
   * The goal capability port. A fixture that drives a goal submission needs it:
   * the submission asks the created session's owner, and the owner answers from
   * this port.
   */
  readonly goalPort?: GoalPort;
}

/** Builds a dormant application for a host that renders the shell. */
export function createWebuiApplicationFixture(
  options: ApplicationFixtureOptions = {},
): WebuiApplication {
  return createWebuiApplication({
    openEventChannel: inertEventChannel,
    ...(options.store ? { store: options.store } : {}),
    ...(options.slices ? { slices: options.slices } : {}),
    ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
    ...(options.goalPort ? { goalPort: options.goalPort } : {}),
    turns: { resumeSession: async () => {} },
  });
}

/** Builds and starts one, for a fixture that needs the ingress. */
export function startWebuiApplicationFixture(
  options: ApplicationFixtureOptions = {},
  start?: WebuiApplicationStart,
): WebuiApplication {
  const application = createWebuiApplicationFixture(options);
  application.start(start);
  return application;
}
