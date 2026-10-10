// React subscription to the connection-health fact (plan §7.2
// `client/bindings/use-connection-health.ts`, split from
// `client/connection-health.ts:87`).
//
// The fact itself — which watchers are live, and whether a link that was held
// has gone down — is recorded in `client/infrastructure/connection-health.ts`.
// This is only the React edge to it: a component re-renders when the fact
// changes and never touches the watcher registry.

import { useSyncExternalStore } from "react";

import {
  isWebuiEventChannelDegraded,
  subscribeWebuiConnectionHealth,
} from "../infrastructure/connection-health.js";

export function useWebuiEventChannelDegraded(): boolean {
  return useSyncExternalStore(
    subscribeWebuiConnectionHealth,
    isWebuiEventChannelDegraded,
    isWebuiEventChannelDegraded,
  );
}
