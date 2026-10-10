// The application instance (plan §7.1 `application/create-application.ts`).
//
// One call builds the whole browser-side application object: the store, the
// single lease controller, the event coordinator and the turn coordinator, and
// it opens **exactly one** process-event channel for the instance. The channel
// is opened here and handed to the event coordinator, which is its sole
// consumer; components subscribe to the application snapshot this object
// exposes.
//
// This module is the live process-event ingress. The composition root creates
// one application through it; ticket #45 switched all four former `watchEvents`
// call sites (the shell, the composer and both workspace panels) onto it in one
// delivery unit, because a migration period where the shell used the new
// ingress while the composer still opened its own connection would make the
// migration itself a source of duplicated state.

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
import { WEBUI_HOME_SESSION_KEY } from "./state.js";
import {
  createWebuiTurnCoordinator,
  type WebuiTurnCoordinator,
} from "./turn-coordinator.js";
import type { WebuiTurnCoordinatorDeps } from "./turn-coordinator.js";
import {
  createWebuiUnreadController,
  type WebuiUnreadController,
} from "./unread.js";
import {
  createWebuiComposerStore,
  type WebuiComposerStore,
} from "./composer-store.js";
import {
  createWebuiTranscriptHistoryOwner,
  type WebuiTranscriptHistoryOwner,
} from "./transcript-history.js";
import type { WebuiClientMessageLoader } from "../contracts/message-view.js";

export interface WebuiApplicationDeps {
  /** Opens the process-event channel. Called exactly once per instance. */
  readonly openEventChannel: WebuiOpenEventChannel;
  /**
   * The one session store the instance owns. Supply it to bind the application
   * to a store created by the caller (the composition root creates exactly one
   * and the shell hands it in); when omitted a fresh store is created here.
   * Either way there is exactly one map — this is not a second store.
   */
  readonly store?: WebuiSessionStore;
  /** The session the UI currently has selected; default reads the store. */
  readonly readActiveSessionId?: () => string | undefined;
  readonly effects?: WebuiEventEffects;
  /** Transport-facing dependencies of the turn coordinator. */
  readonly turns: Omit<WebuiTurnCoordinatorDeps, "store" | "leases">;
  readonly loadMessages?: WebuiClientMessageLoader;
  /**
   * The unread storage adapter (`infrastructure/storage.ts`), injected because
   * the application layer may not import infrastructure. Absent degrades to a
   * no-op: hydration completes immediately against no stored counts, which is
   * the correct behaviour for SSR and unit tests.
   */
  readonly unreadStorage?: {
    readonly read?: () => Readonly<Record<string, number>>;
    readonly write?: (counts: Readonly<Record<string, number>>) => void;
  };
  /** Seed for the composer store (SSR / tests). */
  readonly composer?: WebuiComposerStore;
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
  readonly transcriptHistory: WebuiTranscriptHistoryOwner;
  /** The one owner of unread hydration ordering (plan §7.6). */
  readonly unread: WebuiUnreadController;
  /** The one owner of composer drafts and input history (plan §7.6). */
  readonly composer: WebuiComposerStore;
  /**
   * Commit home→session adoption as one transition: carry the home turn's live
   * record onto the created session, move the home composer slot onto it and
   * select it. Both store writes are no-notify; the caller writes the hash and
   * the React selection once.
   */
  readonly adoptHomeSession: (sessionId: string) => void;
  /** Tear down: detach the coordinator, dispose the store, close the channel. */
  readonly dispose: () => void;
}

export function createWebuiApplication(
  deps: WebuiApplicationDeps,
): WebuiApplication {
  const store = deps.store ?? createWebuiSessionStore();
  const leases = createWebuiStreamLeaseController(store);
  const readActiveSessionId =
    deps.readActiveSessionId ?? (() => store.getSelectedSessionId());
  // The one unread controller: hydration ordering and the single persistence
  // writer. It is hydrated *before* the channel is opened, so a counted event
  // can never arrive against an un-hydrated map (the gate `recordEvent` holds).
  const unread = createWebuiUnreadController({
    store,
    ...(deps.unreadStorage?.read ? { read: deps.unreadStorage.read } : {}),
    ...(deps.unreadStorage?.write ? { write: deps.unreadStorage.write } : {}),
  });
  unread.hydrate(readActiveSessionId());
  const composer = deps.composer ?? createWebuiComposerStore();
  const events = createWebuiEventCoordinator({
    store,
    leases,
    readActiveSessionId,
    unread,
    ...(deps.effects ? { effects: deps.effects } : {}),
  });
  const turns = createWebuiTurnCoordinator({
    store,
    leases,
    ...deps.turns,
  });
  const transcriptHistory = createWebuiTranscriptHistoryOwner({
    store,
    loadMessages: deps.loadMessages,
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
    transcriptHistory,
    unread,
    composer,
    adoptHomeSession: (sessionId) => {
      // One committed transition: the home turn's live record moves onto the
      // created session, the composer's home slot moves onto it, and the
      // session is selected. Migration is no-notify (the view switching keys
      // re-reads the target in its own effect); selection notifies once.
      store.migrateSession(WEBUI_HOME_SESSION_KEY, sessionId);
      composer.adoptHome(sessionId);
      store.select(sessionId);
    },
    dispose: () => {
      detach();
      store.dispose();
      channel.close?.();
    },
  };
}
