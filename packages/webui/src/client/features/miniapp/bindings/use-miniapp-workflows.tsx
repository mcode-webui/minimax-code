// The Mini App business's binding: one provider, two hooks.
//
// The owner is built once by the composition root (`application/create-application.ts`)
// and provided here, so a surface submits commands and reads the snapshot rather
// than constructing a second owner. With no provider mounted — SSR, a unit test
// that mounts the view on its own — the hooks read the initial snapshot and the
// component renders "no Mini App capability", which is the same thing a host
// without the cell does.

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import {
  initialWebuiMiniAppWorkflowsState,
  type WebuiMiniAppWorkflows,
  type WebuiMiniAppWorkflowsState,
} from "../application/miniapp-workflows.js";

const WebuiMiniAppWorkflowsContext = createContext<WebuiMiniAppWorkflows | undefined>(undefined);

export function WebuiMiniAppWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiMiniAppWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiMiniAppWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiMiniAppWorkflowsContext.Provider>
  );
}

/** The owner, for a component that submits commands. */
export function useWebuiMiniAppWorkflows(): WebuiMiniAppWorkflows | undefined {
  return useContext(WebuiMiniAppWorkflowsContext);
}

const noopSubscribe = (): (() => void) => () => undefined;

function initialSnapshot(): WebuiMiniAppWorkflowsState {
  return initialWebuiMiniAppWorkflowsState;
}

/** The snapshot, for a component that renders it. */
export function useWebuiMiniAppWorkflowsState(): WebuiMiniAppWorkflowsState {
  const workflows = useContext(WebuiMiniAppWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribe : noopSubscribe,
    workflows ? workflows.getSnapshot : initialSnapshot,
    workflows ? workflows.getSnapshot : initialSnapshot,
  );
}
