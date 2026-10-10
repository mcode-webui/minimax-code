// Plugin capability port.
//
// Plugin management. Split from the monolithic `WebuiTransport` in the former
// `client/contracts.ts`; `transport.ts` composes it. The method stays optional
// — `undefined` means "the operation is not wired".

import type { WebuiPluginManagementRequest } from "../../shared/plugin-management.js";

export interface PluginPort {
  readonly pluginManagement?: (request: WebuiPluginManagementRequest) => Promise<unknown>;
}
