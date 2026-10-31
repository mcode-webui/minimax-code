// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | `WebuiCapabilityManifest` | Optional, additive capability/readiness facts derived from the wired port. | Runtime `createHarnessPortFromHost` via `deriveWebuiCapabilityManifest` (`shared/capability-manifest.ts`). | `client/features/terminal/application/terminal-owner.ts`; any surface deciding whether to offer a family. |
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiVersionInfo` | The handshake fact: version, protocolVersion, dataDir. | Runtime `createHarnessPortFromHost` version const (`runtime/harness/adapter.ts`). | `client/features/settings/application/settings-workflows.ts`; `client/features/settings/contracts/settings-port.ts`; `client/platform/transport.ts`; `client/features/account/ui/UserMenu.tsx`; `client/features/settings/ui/SettingsModal.tsx`; `client/shell/WebuiClientFoundationApp.tsx`. |
import type { WebuiCapabilityManifest } from "../capability-manifest.js";

export interface WebuiVersionInfo {
  readonly version: string;
  readonly protocolVersion: number;
  readonly dataDir?: string;
  /**
   * What this service actually registered and wired.
   *
   * Optional and additive: a service that predates the manifest omits it, and an
   * omitted manifest means **unknown**. It never means all-supported (a client
   * that read absence as support would offer everything) and never means
   * all-unsupported (that would hide features a service does have).
   */
  readonly capabilities?: WebuiCapabilityManifest;
}
