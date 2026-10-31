// The composer's own owner module, read by its own presentation.
//
// The `composer` business owns the queue's state. The component used to hold the
// queue in `useState`.
//
// The fallback keeps a composer mounted without an application (unit tests, a
// standalone surface) working against a per-mount store instead of no store at all.

import { useMemo } from "react";

import type { WebuiComposerStore } from "../features/composer/application/composer-store.js";
import { createWebuiComposerStore } from "../features/composer/application/composer-store.js";
import { useWebuiApplicationOptional } from "./application-context.js";

export function useWebuiComposerStore(): WebuiComposerStore {
  const application = useWebuiApplicationOptional();
  const fallback = useMemo(() => createWebuiComposerStore(), []);
  return application?.composer ?? fallback;
}
