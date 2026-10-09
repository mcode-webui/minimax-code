// The application instance (plan §7.1 `application/create-application.ts`).
//
// One call builds the whole browser-side application object: the store, the
// single lease controller, the event coordinator and the turn coordinator, and
// it opens **exactly one** process-event channel for the instance. The channel
// is opened here and handed to the event coordinator, which is its sole
// consumer; components subscribe to the application snapshot this object
// exposes.
//
// This module is deliberately not wired into the live process-event ingress.
// Ticket #45 switches all four `watchEvents` call sites to this layer in one
// delivery unit, because a migration period where the shell uses the new ingress
// while the composer still opens its own connection would make the migration
// itself a source of duplicated state. Until that switch, production behaviour
// is unchanged and this layer is exercised only by its tests.

import {
  createWebuiEventCoordinator,
  type WebuiEventCoordinator,
  type WebuiEventEffects,
} from "./event-coordinator.js";
import type { WebuiOpenEventChannel } from "./event-channel.js";
import { createWebuiSessionStore } from "./session-store.js";
import type { WebuiSessionStore } from "./session-store.js";
import {
  createWebuiStreamLeaseController,
  type WebuiStreamLeaseController,
} from "./stream-lease-controller.js";
import type { WebuiApplicationState } from "./state.js";
import {
  createWebuiTurnCoordinator,
  type WebuiTurnCoordinator,
} from "./turn-coordinator.js";
import type { WebuiTurnCoordinatorDeps } from "./turn-coordinator.js";

export interface WebuiApplicationDeps {
  /** Opens the process-event channel. Called exactly once per instance. */
  readonly openEventChannel: WebuiOpenEventChannel;
  /** The session the UI currently has selected; default reads the store. */
  readonly readActiveSessionId?: () => string | undefined;
  readonly effects?: WebuiEventEffects;
  /** Transport-facing dependencies of the turn coordinator. */
  readonly turns: Omit<WebuiTurnCoordinatorDeps, "store" | "leases">;
}

export interface WebuiApplication {
  /** The current application snapshot; stable until something changes. */
  readonly getSnapshot: () => WebuiApplicationState;
  /** Subscribe to snapshot changes. Returns a detach; never closes a channel. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (sessionId: string | undefined) => void;
  readonly store: WebuiSessionStore;
  readonly leases: WebuiStreamLeaseController;
  readonly events: WebuiEventCoordinator;
  readonly turns: WebuiTurnCoordinator;
  /** Tear down: detach the coordinator, dispose the store, close the channel. */
  readonly dispose: () => void;
}

export function createWebuiApplication(
  deps: WebuiApplicationDeps,
): WebuiApplication {
  const store = createWebuiSessionStore();
  const leases = createWebuiStreamLeaseController(store);
  const readActiveSessionId =
    deps.readActiveSessionId ?? (() => store.getSelectedSessionId());
  const events = createWebuiEventCoordinator({
    store,
    leases,
    readActiveSessionId,
    ...(deps.effects ? { effects: deps.effects } : {}),
  });
  const turns = createWebuiTurnCoordinator({
    store,
    leases,
    ...deps.turns,
  });
  // Exactly one channel per application instance, opened once. The coordinator
  // is its sole consumer; nothing else subscribes to it directly.
  const channel = deps.openEventChannel();
  const detach = events.attach(channel);

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    select: store.select,
    store,
    leases,
    events,
    turns,
    dispose: () => {
      detach();
      store.dispose();
      channel.close?.();
    },
  };
}
