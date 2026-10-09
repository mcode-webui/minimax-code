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
import type { WebuiApplicationState } from "../application/state.js";

const WebuiApplicationContext = createContext<WebuiApplication | undefined>(
  undefined,
);

export function WebuiApplicationProvider({
  application,
  children,
}: {
  readonly application: WebuiApplication;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiApplicationContext.Provider value={application}>
      {children}
    </WebuiApplicationContext.Provider>
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
