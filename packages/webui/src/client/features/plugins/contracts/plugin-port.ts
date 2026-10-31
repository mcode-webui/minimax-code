// Plugin capability port.
//
// Plugin management and the skill catalogue. Split from the monolithic
// `WebuiTransport`; `transport.ts` composes it. Every method stays optional —
// `undefined` means "the operation is not wired".
//
// `listSkills` was declared on `SettingsPort` until the port re-file. The skill
// catalogue is `plugins`' surface, and counting a port's actions rather than its
// members is why a one-member port is not a reason to leave it where the
// server's own grouping happens to put it.
//
// `pluginManagement` carries 29 actions behind its one member
// (`packages/webui/docs/reference/plugin-action-inventory.md`), which is the figure this port's
// business scope is measured by rather than its member count.

import type { WebuiPluginManagementRequest } from "../../../../shared/plugin-management.js";

export interface PluginPort {
  readonly pluginManagement?: (request: WebuiPluginManagementRequest) => Promise<unknown>;
  readonly listSkills?: (request?: {
    readonly agentName?: string;
  }) => Promise<{
    readonly skills: readonly {
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
    }[];
  }>;
}
