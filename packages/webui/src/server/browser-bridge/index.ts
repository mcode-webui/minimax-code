// Public surface of the browser-bridge server module.
//
// The bridge is the only WebUI code that reaches the person's own Edge or
// Chrome. It sits beside the existing generic WebSocket admission (it must
// NOT replace or widen it), and it carries its own credential lifecycle so
// the per-start WebUI token and the browser credentials stay independent.
//
// Modules:
//
//   * `credential-store.ts` — the OS secure credential store; never
//     persists secrets to a file.
//   * `pairing.ts` — per-browser pairing state and the challenge/response
//     HMAC scheme.
//   * `reconnect.ts` — the operation deadline schedule and the bounded
//     retry helper.
//   * `session.ts` — one connected extension; owns the post-upgrade
//     challenge/proof and the per-target command dispatch.
//   * `registry.ts` — the set of live sessions, the per-tab serialization,
//     and the switch on/off hooks.
//   * `admission.ts` — the dedicated upgrade admission path for
//     `/browser-bridge`. The dev-mode bypass lives here as a no-op assertion
//     so the headline test can prove it is absent.
//   * `server.ts` — the bridge's own WebSocket server, its per-surface
//     pairings and the providers it lends to the browser service.

export {
  bridgeBackgroundReconnectDelayMs,
  bridgeOperationReconnectDelayMs,
  withBridgeOperationRetry,
  BridgeOperationError,
  WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS,
  WEBUI_BRIDGE_OPERATION_RECONNECT_CAP_MS,
  WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS,
  WEBUI_BRIDGE_OPERATION_RECONNECT_TOTAL_MS,
  type BridgeOperationAttempt,
  type BridgeOperationRetryOptions,
} from "./reconnect.js";

export {
  BrowserCredentialStoreUnavailableError,
  createInMemorySecureCredentialStore,
  createPlatformSecureCredentialStore,
  decodeCredentialFromStore,
  encodeCredentialForStore,
  fingerprint,
  generateBridgeCredential,
  type CommandOutput,
  type InMemoryCredentialStore,
  type RunPlatformCommand,
  type RunPlatformCommandOptions,
  type SecureCredentialReference,
  type SecureCredentialStore,
  type SecureCredentialStoreOptions,
} from "./credential-store.js";

export {
  BrowserBridgePairing,
  PairingSwitchedOffError,
  type BrowserBridgePairingMetadata,
  type BrowserBridgePairingOptions,
  type BrowserBridgePairingStatus,
  type BrowserBridgeProofOutcome,
  type BrowserBridgeProofRefusal,
} from "./pairing.js";

export {
  generateWebuiBrowserBridgeEcdhKeyPair,
  importWebuiBrowserBridgeEcdhPublicKey,
  exportWebuiBrowserBridgeEcdhPublicKey,
  sealWebuiBrowserBridgePairingCredential,
  openWebuiBrowserBridgePairingCredential,
  signWebuiBrowserBridgeProof,
  verifyWebuiBrowserBridgeProof,
  webuiBrowserBridgeInstallationKeyId,
  webuiBrowserBridgeProofMaterial,
  WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES,
  WEBUI_BROWSER_BRIDGE_PATH,
  WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO,
  WEBUI_BROWSER_BRIDGE_PAIR_HKDF_SALT_BYTES,
  WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES,
  WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM,
  type WebuiBrowserBridgeChallenge,
  type WebuiBrowserBridgeClientFrame,
  type WebuiBrowserBridgeEcdhPublicKey,
  type WebuiBrowserBridgeHostFrame,
  type WebuiBrowserBridgeImageFrame,
  type WebuiBrowserBridgeInputCommand,
  type WebuiBrowserBridgeInstallationKeyView,
  type WebuiBrowserBridgePair,
  type WebuiBrowserBridgePairCipher,
  type WebuiBrowserBridgeProof,
  type WebuiBrowserBridgeTarget,
  type WebuiBrowserBridgeCryptoKey,
} from "../../shared/contracts/browser-bridge.js";

export {
  admitBrowserBridgeUpgrade,
  authorizeBrowserBridgeSession,
  classifyBrowserBridgeClose,
  parseExtensionOrigin,
  rejectBrowserBridgeUpgrade,
  type BrowserBridgeAdmissionContext,
  type BrowserBridgeRejection,
} from "./admission.js";

export {
  BrowserBridgeSession,
  type BrowserBridgeBridgeImageFrameExport,
  type BrowserBridgeBridgeTargetExport,
  type BrowserBridgeCommandOutcome,
  type BrowserBridgeSessionCloseReason,
  type BrowserBridgeSessionEvents,
  type BrowserBridgeSessionOptions,
} from "./session.js";

export {
  BrowserBridgeRegistry,
  type BrowserBridgeRegistryOptions,
  type BrowserBridgeRegistryStatus,
  type BrowserBridgeSurfaceStatus,
  type BrowserBridgeDispatch,
} from "./registry.js";

export {
  BrowserBridgeServer,
  WebuiBridgeOperationError,
  readAllowedExtensionIds,
  type BrowserBridgeServerOptions,
  type BrowserBridgeServerSurfaceStatus,
  type WebuiBridgeSurfaceProvider,
} from "./server.js";
