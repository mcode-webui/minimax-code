// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiVersionInfo` | The handshake fact: version, protocolVersion, dataDir. | Runtime `createHarnessPortFromHost` version const (`runtime/harness/adapter.ts`). | `client/contracts/settings-port.ts`; `client/transport.ts`; `client/components/UserMenu.tsx`; `client/components/SettingsModal.tsx`. |
export interface WebuiVersionInfo {
  readonly version: string;
  readonly protocolVersion: number;
  readonly dataDir?: string;
}
