// The extension's copy of the WebUI browser-bridge wire protocol.
//
// It duplicates `packages/webui/src/shared/contracts/browser-bridge.ts` on
// purpose. An extension is loaded by the browser as plain ES modules with no
// node_modules and no bundler, so it cannot resolve a workspace package, and the
// ADR forbids importing WebUI implementation modules across the bridge boundary
// anyway. The duplication is kept safe by two things: the names here match the
// host's names one for one, so a diff of the two files is meaningful, and both
// sides are pinned to the same signature test vector — a change to the
// construction on either side breaks exactly one suite.

/** The dedicated path the bridge listens on. It is not the WebUI's own path. */
export const WEBUI_BROWSER_BRIDGE_PATH = "/browser-bridge";

/**
 * The options page's request to reconnect.
 *
 * A Manifest V3 service worker is lazy, so saving the installation key does
 * not by itself start it. The page sends this and the worker reconnects.
 */
export const WEBUI_BROWSER_BRIDGE_RECONNECT_MESSAGE = "webui-bridge-reconnect";

/** The only signature scheme the bridge admits. */
export const WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM = "HMAC-SHA256" as const;

/** The HKDF `info` literal the pair cipher is keyed with. */
export const WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO = "webui-browser-bridge-pair-v1" as const;

/** The HKDF salt and AES-GCM IV lengths, in bytes. */
export const WEBUI_BROWSER_BRIDGE_PAIR_HKDF_SALT_BYTES = 16;
export const WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES = 12;

/** A P-256 ECDH public key, as JWK, for the pairing transfer. */
export interface WebuiBrowserBridgeEcdhPublicKey {
  readonly kty: "EC";
  readonly crv: "P-256";
  /** Base64url (no padding) of the raw x coordinate. */
  readonly x: string;
  /** Base64url (no padding) of the raw y coordinate. */
  readonly y: string;
}

/** The external browsers this extension bridges. */
export type WebuiBrowserBridgeBrowser = "edge" | "chrome";

export interface WebuiBrowserBridgeChallenge {
  readonly kind: "challenge";
  /** A fresh, single-use nonce. */
  readonly nonce: string;
  readonly algorithm: typeof WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM;
  /** Which stored credential the host expects the answer to use. */
  readonly keyId: string;
  /**
   * Which installation key the host will accept a proof with.
   *
   * The installation key is what a browser proves *before* it is handed a
   * pairing credential, so it — not `keyId` — is what the extension signs
   * with on a first connection. The id is public: the host names it here on
   * every challenge.
   */
  readonly installationKeyId: string;
}

export interface WebuiBrowserBridgeProof {
  readonly kind: "proof";
  readonly keyId: string;
  /** The nonce this proof answers, echoed so the host cannot mix two challenges. */
  readonly nonce: string;
  /** Base64 HMAC-SHA256 over the proof material. */
  readonly signature: string;
  /**
   * The algorithm the proof was made with, echoed from the challenge.
   *
   * The host verifies against exactly one algorithm, so an absent value is
   * readable as an older extension. Echoing it anyway keeps the two sides of
   * the wire saying the same thing.
   */
  readonly algorithm?: typeof WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM;
}

/**
 * The credential-transfer frame the host sends before the challenge.
 *
 * The host's authoritative credential arrives here on every connect, so a
 * switch that went off and on again — the only way the credential could
 * change — reaches the extension without anyone doing anything.
 */
export interface WebuiBrowserBridgePair {
  readonly kind: "pair";
  readonly keyId: string;
  /**
   * The host's ephemeral P-256 ECDH public key. Required because both
   * halves of the ECDH shared secret depend on it; without it the extension
   * cannot derive the same AES key the host used.
   */
  readonly publicKey: WebuiBrowserBridgeEcdhPublicKey;
  /** Base64 of the 16-byte HKDF salt the host generated for this connection. */
  readonly salt: string;
  /** `base64( iv || aes-gcm-ciphertext )` — the ciphertext already carries its tag. */
  readonly payload: string;
}

export interface WebuiBrowserBridgeTarget {
  readonly browserId: string;
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
  readonly faviconUrl?: string;
  readonly generation: number;
}

export interface WebuiBrowserBridgeImageFrame {
  readonly browserId: string;
  readonly targetId: string;
  readonly generation: number;
  /** Base64 image bytes. */
  readonly data: string;
  readonly format: "png" | "jpeg";
  readonly sequence: number;
}

export type WebuiBrowserBridgeInputCommand =
  | {
      readonly kind: "pointer";
      readonly targetId: string;
      readonly generation: number;
      readonly action?: "press" | "release" | "move" | "scroll";
      readonly x: number;
      readonly y: number;
      readonly button?: "left" | "middle" | "right";
      readonly clickCount?: number;
      readonly deltaX?: number;
      readonly deltaY?: number;
    }
  | {
      readonly kind: "key";
      readonly targetId: string;
      readonly generation: number;
      readonly key: string;
      readonly code?: string;
      readonly text?: string;
      readonly modifiers: readonly ("alt" | "ctrl" | "meta" | "shift")[];
    }
  | {
      readonly kind: "text";
      readonly targetId: string;
      readonly generation: number;
      readonly text: string;
    };

export type WebuiBrowserBridgeClientFrame =
  | {
      readonly kind: "hello";
      readonly browser: WebuiBrowserBridgeBrowser;
      readonly browserId: string;
      readonly extensionVersion: string;
      /**
       * The extension's ephemeral P-256 ECDH public key for this connection.
       * Always set by the current extension build; the host refuses to pair
       * without it.
       */
      readonly publicKey: WebuiBrowserBridgeEcdhPublicKey;
    }
  | WebuiBrowserBridgeProof
  | { readonly kind: "targets"; readonly targets: readonly WebuiBrowserBridgeTarget[] }
  | { readonly kind: "frame"; readonly frame: WebuiBrowserBridgeImageFrame }
  | {
      readonly kind: "input-result";
      readonly commandId: string;
      readonly accepted: boolean;
      readonly error?: string;
    }
  | {
      readonly kind: "cdp-result";
      readonly commandId: string;
      readonly accepted: boolean;
      readonly result?: unknown;
      readonly error?: string;
      /**
       * Whether the method is outside the extension's supported subset.
       *
       * It is reported separately because it means the command will never work,
       * which is a different thing from a failure that might.
       */
      readonly unsupported?: boolean;
    }
  | { readonly kind: "pong"; readonly nonce: string };

export type WebuiBrowserBridgeHostFrame =
  | WebuiBrowserBridgePair
  | WebuiBrowserBridgeChallenge
  | { readonly kind: "ready"; readonly sessionId: string }
  | {
      readonly kind: "input";
      readonly commandId: string;
      readonly command: WebuiBrowserBridgeInputCommand;
    }
  | { readonly kind: "ping"; readonly nonce: string }
  | {
      /**
       * A raw DevTools command for a tab the extension drives.
       *
       * It is sent only when the Full CDP switch is on; the runtime decides
       * that, and the extension refuses a method outside its supported subset.
       */
      readonly kind: "cdp";
      readonly commandId: string;
      readonly targetId: string;
      readonly generation: number;
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | { readonly kind: "closed"; readonly reason: string };

/**
 * The codes the extension itself can report.
 *
 * The full vocabulary belongs to the host contract; this is the subset that a
 * failure inside the extension can honestly claim, kept with the same strings so
 * the panel and the Agent's tools branch on them without the extension importing
 * the host module.
 */
export const WEBUI_BROWSER_BRIDGE_ERROR_CODES = [
  "browser_target_stale",
  "browser_target_unknown",
  "browser_command_invalid",
  "browser_provider_failed",
  "browser_provider_unavailable",
  "browser_operation_timeout",
  "browser_operation_cancelled",
  "browser_pairing_rejected",
] as const;

export type WebuiBrowserBridgeErrorCode = (typeof WEBUI_BROWSER_BRIDGE_ERROR_CODES)[number];

export interface WebuiBrowserBridgeError {
  readonly code: WebuiBrowserBridgeErrorCode;
  readonly message: string;
  /** Whether waiting for the same operation to become possible again could help. */
  readonly retryable: boolean;
}

export function webuiBrowserBridgeError(
  code: WebuiBrowserBridgeErrorCode,
  message: string,
  retryable: boolean,
): WebuiBrowserBridgeError {
  return { code, message, retryable };
}

/**
 * The bytes a proof is computed over.
 *
 * The key id is inside the signed material so a proof captured for one
 * credential cannot be presented against another.
 */
export function webuiBrowserBridgeProofMaterial(nonce: string, keyId: string): string {
  return `${nonce} ${keyId}`;
}

/**
 * Computes the proof for a challenge.
 *
 * Web Crypto rather than `node:crypto`, because this runs in a browser service
 * worker where `node:crypto` does not exist, and base64 is built from `btoa`
 * rather than `Buffer` for the same reason.
 */
export async function signWebuiBrowserBridgeProof(
  secret: Uint8Array,
  nonce: string,
  keyId: string,
): Promise<string> {
  // Copied into a fresh buffer first: `crypto.subtle` only accepts a buffer that
  // is known not to be shared, and a caller's `Uint8Array` may have come from a
  // storage decode with a wider backing store.
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(webuiBrowserBridgeProofMaterial(nonce, keyId)),
  );
  return encodeWebuiBrowserBridgeBase64(new Uint8Array(signature));
}

/**
 * Checks a proof against a stored secret.
 *
 * The host verifies every proof it admits; the extension keeps the same check so
 * its own round trip is verifiable in tests without a host process, and so a
 * wiring mistake on this side fails as a wrong proof rather than as a silent
 * connection. The comparison is length-then-byte-constant-time, which is as
 * strong as it gets over two base64 strings of public data.
 */
export async function verifyWebuiBrowserBridgeProof(
  secret: Uint8Array,
  proof: WebuiBrowserBridgeProof,
  expectedNonce: string,
  expectedKeyId: string,
): Promise<boolean> {
  if (proof.keyId !== expectedKeyId) return false;
  if (proof.nonce !== expectedNonce) return false;
  const expected = await signWebuiBrowserBridgeProof(secret, proof.nonce, proof.keyId);
  return constantTimeEqual(expected, proof.signature);
}

/** Base64 over bytes, without `Buffer`. */
export function encodeWebuiBrowserBridgeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Bytes from base64, without `Buffer`. */
export function decodeWebuiBrowserBridgeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Copies bytes into a plain `ArrayBuffer`.
 *
 * Web Crypto's `BufferSource` is declared over `ArrayBuffer`, but a
 * `Uint8Array` is generic over its buffer and a view's buffer might be a
 * `SharedArrayBuffer`. Copying into a buffer this function owns removes the
 * question rather than casting it away.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/* -------------------------------------------------------------------------- */
/* Pairing transfer: ECDH P-256 + HKDF-SHA256 + AES-256-GCM (extension side)  */
/* -------------------------------------------------------------------------- */

/**
 * Generates an ephemeral P-256 ECDH key pair for one connection.
 *
 * The private half leaves scope at end of call: there is no longer-lived key
 * to store or leak, and a fresh handshake produces a fresh shared secret that
 * cannot be replayed from a previously captured `pair` frame.
 */
export function generateWebuiBrowserBridgeEcdhKeyPair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}> {
  // `ECDH` over `P-256` with `deriveBits`. The 256-bit output is exactly the
  // width the HKDF then expands into an AES-256 key — anything else would
  // either widen the KDF or shrink the cipher, and both are gratuitous.
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
}

/** Imports a peer ECDH public key from a wire-format JWK. */
export async function importWebuiBrowserBridgeEcdhPublicKey(
  jwk: WebuiBrowserBridgeEcdhPublicKey,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { ...jwk, ext: true, key_ops: [] },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

/** Exports the wire-format P-256 ECDH public key (no `d`, no `key_ops`). */
export async function exportWebuiBrowserBridgeEcdhPublicKey(
  publicKey: CryptoKey,
): Promise<WebuiBrowserBridgeEcdhPublicKey> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new Error(`browser bridge: unexpected ECDH JWK shape (kty=${jwk.kty}, crv=${jwk.crv})`);
  }
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("browser bridge: ECDH JWK is missing x/y");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/**
 * Derives an AES-GCM key from the ECDH shared secret.
 *
 * Same construction as the host: `HKDF-SHA256` over the shared bits, with
 * the salt the host generated and the agreed `info`. A divergence between
 * the two sides is what the cross-implementation test vector catches.
 */
async function deriveWebuiBrowserBridgePairAesKey(
  sharedBits: ArrayBuffer,
  salt: Uint8Array,
  subtle: SubtleCrypto,
): Promise<CryptoKey> {
  const baseKey = await subtle.importKey("raw", sharedBits, { name: "HKDF" }, false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: new TextEncoder().encode(WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Opens a `pair` frame.
 *
 * Returns the secret **bytes** — the `chrome.storage.local` write stores the
 * bytes themselves, not their base64 form, so a re-load on the next connect
 * produces the exact value the host expects the proof against.
 *
 * A one-byte change in the ciphertext or IV is a GCM auth failure and this
 * throws — which is what we want: a tampered frame cannot read as a valid
 * credential.
 */
export async function openWebuiBrowserBridgePairingCredential(
  cipher: Pick<WebuiBrowserBridgePair, "publicKey" | "salt" | "payload">,
  ownPrivateKey: CryptoKey,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<Uint8Array> {
  const salt = decodeWebuiBrowserBridgeBase64(cipher.salt);
  const payloadBytes = decodeWebuiBrowserBridgeBase64(cipher.payload);
  if (payloadBytes.length < WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES + 16) {
    throw new Error("browser bridge: pair payload is too short to be a valid AES-GCM frame");
  }
  const iv = payloadBytes.subarray(0, WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES);
  const ciphertext = payloadBytes.subarray(WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES);
  const peerPublic = await importWebuiBrowserBridgeEcdhPublicKey(cipher.publicKey);
  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: peerPublic },
    ownPrivateKey,
    256,
  );
  const aesKey = await deriveWebuiBrowserBridgePairAesKey(sharedBits, salt, subtle);
  const plain = new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(ciphertext),
    ),
  );
  // Plaintext is `base64(secretBytes)`; decode so we store the raw secret.
  const decoded = decodeWebuiBrowserBridgeBase64(new TextDecoder().decode(plain));
  if (decoded.length === 0) {
    throw new Error("browser bridge: pair plaintext is empty");
  }
  return decoded;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/**
 * The loopback WebSocket URL for a configured host origin.
 *
 * Only loopback origins are accepted: the bridge is a local-only surface, and an
 * extension that can reach any origin could be pointed at a remote listener by
 * anything that can write its storage.
 */
export function webuiBrowserBridgeUrl(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:") {
    throw new Error(`browser bridge: unsupported origin protocol ${parsed.protocol}`);
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`browser bridge: origin host must be loopback, got ${parsed.hostname}`);
  }
  return `${parsed.origin}${WEBUI_BROWSER_BRIDGE_PATH}`;
}

export type WebuiBrowserBridgeFrameParse =
  | { readonly ok: true; readonly frame: WebuiBrowserBridgeHostFrame }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses one frame from the host.
 *
 * A frame that is not one this protocol declares is a protocol violation, not
 * something to ignore: the caller closes the socket with the returned reason
 * rather than carrying on against a stream it is no longer parsing correctly.
 */
export function parseWebuiBrowserBridgeHostFrame(raw: string): WebuiBrowserBridgeFrameParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "frame is not valid JSON" };
  }
  if (typeof value !== "object" || value === null) return { ok: false, reason: "frame is not an object" };
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "challenge": {
      if (typeof candidate.nonce !== "string" || candidate.nonce.length === 0) {
        return { ok: false, reason: "challenge has no nonce" };
      }
      if (typeof candidate.keyId !== "string" || candidate.keyId.length === 0) {
        return { ok: false, reason: "challenge has no key id" };
      }
      // Required, not optional: without it the extension cannot tell which
      // key the host will accept a proof with, and answering with the pairing
      // credential on a first connection would fail against a host that has
      // none. A host that omits it is refused rather than guessed at.
      if (
        typeof candidate.installationKeyId !== "string" ||
        candidate.installationKeyId.length === 0
      ) {
        return { ok: false, reason: "challenge has no installation key id" };
      }
      if (candidate.algorithm !== WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM) {
        return { ok: false, reason: `challenge algorithm ${String(candidate.algorithm)} is not supported` };
      }
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    case "pair": {
      if (typeof candidate.keyId !== "string" || candidate.keyId.length === 0) {
        return { ok: false, reason: "pair has no key id" };
      }
      if (!isWebuiBrowserBridgeEcdhPublicKey(candidate.publicKey)) {
        return { ok: false, reason: "pair public key is missing or not a P-256 JWK" };
      }
      if (typeof candidate.salt !== "string" || candidate.salt.length === 0) {
        return { ok: false, reason: "pair has no salt" };
      }
      if (typeof candidate.payload !== "string" || candidate.payload.length === 0) {
        return { ok: false, reason: "pair has no payload" };
      }
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    case "ready": {
      if (typeof candidate.sessionId !== "string") return { ok: false, reason: "ready has no session id" };
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    case "input": {
      if (typeof candidate.commandId !== "string") return { ok: false, reason: "input has no command id" };
      if (!isWebuiBrowserBridgeInputCommand(candidate.command)) {
        return { ok: false, reason: "input carries an invalid command" };
      }
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    case "cdp": {
      // A raw DevTools command. The extension decides for itself whether it
      // will run the method — this parser only establishes that the frame is
      // well formed, so a malformed one is refused rather than dispatched.
      if (typeof candidate.commandId !== "string") {
        return { ok: false, reason: "cdp has no command id" };
      }
      if (typeof candidate.targetId !== "string" || candidate.targetId.length === 0) {
        return { ok: false, reason: "cdp has no target id" };
      }
      if (typeof candidate.generation !== "number" || !Number.isInteger(candidate.generation)) {
        return { ok: false, reason: "cdp has no generation" };
      }
      if (typeof candidate.method !== "string" || candidate.method.length === 0) {
        return { ok: false, reason: "cdp has no method" };
      }
      if (!isWebuiBrowserBridgeCdpParams(candidate.params)) {
        return { ok: false, reason: "cdp carries invalid params" };
      }
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    case "ping": {
      if (typeof candidate.nonce !== "string") return { ok: false, reason: "ping has no nonce" };
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    case "closed": {
      if (typeof candidate.reason !== "string") return { ok: false, reason: "closed has no reason" };
      return { ok: true, frame: candidate as unknown as WebuiBrowserBridgeHostFrame };
    }
    default:
      return { ok: false, reason: `unknown frame kind ${String(candidate.kind)}` };
  }
}

/** Whether a value is a plain object of DevTools parameters. */
function isWebuiBrowserBridgeCdpParams(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a structurally valid P-256 ECDH public-key JWK. */
function isWebuiBrowserBridgeEcdhPublicKey(value: unknown): value is WebuiBrowserBridgeEcdhPublicKey {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    typeof candidate.x === "string" &&
    candidate.x.length > 0 &&
    typeof candidate.y === "string" &&
    candidate.y.length > 0
  );
}

/** Whether an input command has the shape the wire protocol declares. */
export function isWebuiBrowserBridgeInputCommand(value: unknown): value is WebuiBrowserBridgeInputCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  if (typeof command.targetId !== "string" || command.targetId.length === 0) return false;
  if (typeof command.generation !== "number") return false;
  switch (command.kind) {
    case "pointer":
      return (
        typeof command.x === "number" &&
        typeof command.y === "number" &&
        (command.action === undefined || ["press", "release", "move", "scroll"].includes(String(command.action))) &&
        (command.action === "move" || command.action === "scroll" || typeof command.button === "string") &&
        (command.action !== undefined || typeof command.clickCount === "number") &&
        (command.action !== "scroll" || (typeof command.deltaX === "number" && typeof command.deltaY === "number"))
      );
    case "key":
      return typeof command.key === "string" && Array.isArray(command.modifiers);
    case "text":
      return typeof command.text === "string";
    default:
      return false;
  }
}
