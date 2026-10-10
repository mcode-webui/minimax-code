// React application provider and context (plan §7.2
// `client/bindings/application-context.tsx`).
//
// This is the boundary between the framework-free application layer and React.
// The application object is created once by the composition root and provided
// here; components read it and subscribe to its snapshot. They never receive a
// store writer and never register a process-event callback — that is the
// ticket's "components subscribe to application snapshots or selectors and
// register no business event callback".

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { WebuiApplication } from "../application/create-application.js";
import type { WebuiSessionStore } from "../application/session-store.js";
import type { WebuiApplicationState } from "../application/state.js";

/**
 * The session store, provided on its own so a subtree can read and submit
 * commands without the whole application object — and, crucially, without
 * opening the process-event channel. The composition root owns one store and
 * provides it once (plan §7.2, §7.6; ticket #45).
 */
const WebuiSessionStoreContext = createContext<WebuiSessionStore | undefined>(
  undefined,
);

const WebuiApplicationContext = createContext<WebuiApplication | undefined>(
  undefined,
);

export function WebuiSessionStoreProvider({
  store,
  children,
}: {
  readonly store: WebuiSessionStore;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiSessionStoreContext.Provider value={store}>
      {children}
    </WebuiSessionStoreContext.Provider>
  );
}

export function useWebuiSessionStoreContext(): WebuiSessionStore {
  const store = useContext(WebuiSessionStoreContext);
  if (!store) {
    throw new Error(
      "useWebuiSessionStoreContext must be used within a WebuiSessionStoreProvider",
    );
  }
  return store;
}

/**
 * Subscribe to the session store's snapshot through the bindings. The store's
 * `subscribe` and cached `getSnapshot` are stable, so a component re-renders
 * exactly when the store changes.
 */
export function useWebuiSessionStoreSnapshot(): WebuiApplicationState {
  const store = useWebuiSessionStoreContext();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

export function WebuiApplicationProvider({
  application,
  children,
}: {
  readonly application: WebuiApplication;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiSessionStoreContext.Provider value={application.store}>
      <WebuiApplicationContext.Provider value={application}>
        {children}
      </WebuiApplicationContext.Provider>
    </WebuiSessionStoreContext.Provider>
  );
}

export function useWebuiApplication(): WebuiApplication {
  const application = useContext(WebuiApplicationContext);
  if (!application) {
    throw new Error(
      "useWebuiApplication must be used within a WebuiApplicationProvider",
    );
  }
  return application;
}

/**
 * Subscribe to the whole application snapshot. `subscribe` is the store's and
 * is stable across renders, and `getSnapshot` returns a cached object, so a
 * component re-renders exactly when the application state changes — and a
 * throwing consumer cannot unpack the subscription of its siblings.
 */
export function useWebuiApplicationSnapshot(): WebuiApplicationState {
  const application = useWebuiApplication();
  return useSyncExternalStore(
    application.subscribe,
    application.getSnapshot,
    application.getSnapshot,
  );
}
