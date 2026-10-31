// The two fence cells, read from the application.
//
// The composer owns neither the goal's fence nor interactions' late-read
// protection: the cells belong to the two businesses. The application creates
// the instance (once per mount, so the counter outlives a render), and a
// business coordinator is handed the cell it reads — the same arrangement as the
// session store and the composer store.
//
// The fallback exists for a composer mounted without an application (unit tests,
// a standalone surface): a per-mount pair, so the guards keep working rather than
// silently comparing against a counter that resets every render.

import { useMemo } from "react";

import type { WebuiVersionCells } from "../application/version-cell.js";
import { createWebuiVersionCells } from "../application/version-cell.js";
import { useWebuiApplicationOptional } from "./application-context.js";

export function useWebuiVersionCells(): WebuiVersionCells {
  const application = useWebuiApplicationOptional();
  const fallback = useMemo(() => createWebuiVersionCells(), []);
  return application?.versionCells ?? fallback;
}
