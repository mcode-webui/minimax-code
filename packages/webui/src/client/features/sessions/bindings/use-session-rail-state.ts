import { useEffect, useSyncExternalStore } from "react";
import type { WebuiSessionWorkflows } from "../application/session-workflows.js";

/** Attach the rail to its application-owned project read model. */
export function useSessionRailState(workflows: WebuiSessionWorkflows) {
  const projects = useSyncExternalStore(
    workflows.subscribeProjects,
    workflows.getProjectsSnapshot,
    workflows.getProjectsSnapshot,
  );
  useEffect(() => {
    if (!workflows.canLoadProjects) return;
    void workflows.loadProjects().catch(() => undefined);
  }, [workflows]);
  return projects;
}
