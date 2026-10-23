// The extension bridge protocol.
//
// The bridge is the only way this process reaches the person's own browser.
// It is a WebSocket on loopback, but it is **not** the WebUI's own WebSocket:
// it has its own path, its own admission and its own credential, because the
// thing that connects to it is a browser extension, not the WebUI page.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WEBUI_BROWSER_BRIDGE_PATH` | The dedicated path the bridge listens on. | Host. | Extension. |
// | `WebuiBrowserBridgeClientFrame` | A frame the extension sends to the host. | Extension. | Bridge session. |
// | `WebuiBrowserBridgeHostFrame` | A frame the host sends to the extension. | Host. | Extension. |
// | `WebuiBrowserBridgeChallenge` | The nonce the host issues to prove possession. | Host. | Extension. |
// | `WebuiBrowserBridgeProof` | The extension's answer to a challenge. | Extension. | Bridge session. |
// | `signWebuiBrowserBridgeProof` | Computes the proof over a challenge and a secret. | Both sides. | Bridge session; extension. |
// | `verifyWebuiBrowserBridgeProof` | Checks a proof, in constant time. | Host. | Bridge session. |
//
// Pairing is challenge-response rather than a shared bearer token: the secret
// never crosses the wire in a form that could be replayed from a packet
// capture, and a captured proof is useless because it is bound to a fresh
// nonce. The credential itself travels from host to extension on every
// connect, encrypted to an ECDH key the extension mints for that one
// connection and derives a shared key from, so the secret bytes never cross
// the loopback socket in the clear.

/**
 * The Web Crypto `CryptoKey` type.
 *
 * Reached here as the result type of `crypto.subtle.generateKey`, which
 * Node and `lib.dom` declare with the same name and the same shape. Picking
 * it up from the runtime call avoids relying on whichever global `CryptoKey`
 * happens to be in scope on whichever side is type-checking the file.
 */
export type WebuiBrowserBridgeCryptoKey = Extract<
  Awaited<ReturnType<typeof crypto.subtle.generateKey>>,
  { readonly privateKey: unknown }
>["privateKey"];

/** The dedicated path the bridge listens on. It is not the WebUI's own path. */
export const WEBUI_BROWSER_BRIDGE_PATH = "/browser-bridge";

/**
 * The signature scheme.
 *
 * HMAC-SHA256 over `nonce || separator || keyId`, so a proof cannot be replayed
 * against a different challenge or a different key.
 */
export const WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM = "HMAC-SHA256" as const;

/**
 * The HKDF `info` for the pairing transfer.
 *
 * Both sides must derive byte-identical AES keys from the same ECDH shared
 * secret, so this string is shared literally. A change on either side is a
 * protocol break and is caught by the cross-implementation vector.
 */
export const WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO = "webui-browser-bridge-pair-v1" as const;

/** A P-256 ECDH public key, as JWK, for the pairing transfer. */
export interface WebuiBrowserBridgeEcdhPublicKey {
  readonly kty: "EC";
  readonly crv: "P-256";
  /** Base64url (no padding) of the raw x coordinate. */
  readonly x: string;
  /** Base64url (no padding) of the raw y coordinate. */
  readonly y: string;
}

/**
 * The separator between the nonce and the key id in the signed material.
 *
 * Written as an explicit escape rather than as a literal space: the separator
 * is part of what is signed, so the two implementations must agree on the
 * exact byte, and a literal whitespace character is exactly the kind of thing
 * an editor or a diff can change without anybody noticing. The two
 * implementations are pinned to the same test vector, which is what catches
 * this.
 */
const WEBUI_BROWSER_BRIDGE_PROOF_SEPARATOR = "\u0020";

/** The challenge the host issues when a client first connects. */
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
   * The installation key is the anchor a peer proves *before* it is handed a
   * pairing credential. Naming it on the challenge tells the extension which
   * key id to sign with when it has that key, and tells a peer that has only
   * the pairing credential which key id that was. It is a public label — the
   * id goes on the wire — exactly like `keyId`.
   */
  readonly installationKeyId: string;
}

/** The client's answer to a challenge. */
export interface WebuiBrowserBridgeProof {
  readonly kind: "proof";
  readonly keyId: string;
  /** The nonce this proof answers, echoed so the host cannot mix two challenges. */
  readonly nonce: string;
  /** Base64 HMAC-SHA256 over the signed material. */
  readonly signature: string;
  /**
   * The algorithm the proof was made with, echoed from the challenge.
   *
   * Optional because an older extension does not send it, and absent is
   * readable: the host issued exactly one algorithm and verifies against that
   * one. A *different* algorithm is not read as absent — it is refused.
   */
  readonly algorithm?: typeof WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM;
}

/** The client frames: what the extension says to the host. */
export type WebuiBrowserBridgeClientFrame =
  | {
      readonly kind: "hello";
      readonly browser: "edge" | "chrome";
      readonly browserId: string;
      readonly extensionVersion: string;
      /**
       * An ephemeral P-256 ECDH public key the host uses to deliver the
       * pairing credential. Always set by the current extension build;
       * optional on the type so an older frame remains parseable, and the
       * host refuses to pair without it.
       */
      readonly publicKey?: WebuiBrowserBridgeEcdhPublicKey;
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

/**
 * The credential-transfer frame the host sends to the extension.
 *
 * Sent **before** the challenge on every `hello`, because the extension needs
 * the credential to answer the challenge: the host's credential is the only
 * one the host will accept a proof against.
 */
export interface WebuiBrowserBridgePair {
  readonly kind: "pair";
  /** Which credential this frame carries — not secret, the extension needs it. */
  readonly keyId: string;
  /**
   * The host's ephemeral P-256 ECDH public key. Required because the
   * extension needs both sides' public keys to derive the shared secret.
   */
  readonly publicKey: WebuiBrowserBridgeEcdhPublicKey;
  /** Base64 of the 16-byte HKDF salt the host generated for this connection. */
  readonly salt: string;
  /** `base64( iv || aes-gcm-ciphertext )` — `aes-gcm-ciphertext` carries its tag. */
  readonly payload: string;
}

/** The host frames: what the host says to the extension. */
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

/** One target the extension reports. */
export interface WebuiBrowserBridgeTarget {
  readonly browserId: string;
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
  readonly faviconUrl?: string;
  readonly generation: number;
}

/** One frame the extension delivers. */
export interface WebuiBrowserBridgeImageFrame {
  readonly browserId: string;
  readonly targetId: string;
  readonly generation: number;
  /** Base64 image bytes. */
  readonly data: string;
  readonly format: "png" | "jpeg";
  readonly sequence: number;
}

/** An input command the host asks the extension to deliver. */
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

/**
 * The bytes a proof is computed over.
 *
 * The key id is inside the signed material so a proof captured for one
 * credential cannot be presented against another.
 */
export function webuiBrowserBridgeProofMaterial(nonce: string, keyId: string): string {
  return `${nonce}${WEBUI_BROWSER_BRIDGE_PROOF_SEPARATOR}${keyId}`;
}

/**
 * Computes the proof for a challenge.
 *
 * The same function runs on both sides: the extension signs with the secret it
 * holds, the host verifies with the secret it stored. Keeping one function
 * removes the possibility of the two sides disagreeing about the construction.
 *
 * Web Crypto is used rather than `node:crypto` so the extension — which runs
 * in a browser, not in Node — computes byte-for-byte the same signature. The
 * base64 encoding is likewise done without `Buffer`, which is a Node global and
 * is absent in an MV3 service worker. The two implementations are pinned to the
 * same test vector.
 */
export async function signWebuiBrowserBridgeProof(
  secret: Uint8Array,
  nonce: string,
  keyId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(new TextEncoder().encode(webuiBrowserBridgeProofMaterial(nonce, keyId))),
  );
  return encodeBase64(new Uint8Array(signature));
}

/**
 * Copies bytes into a plain `ArrayBuffer`.
 *
 * Web Crypto's `BufferSource` is declared over `ArrayBuffer`, but a
 * `Uint8Array` is generic over its buffer, and the compiler will not accept a
 * view whose buffer might be a `SharedArrayBuffer`. Copying into a buffer this
 * function owns removes the question instead of casting it away.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * Verifies a proof against a stored secret.
 *
 * The comparison is constant-time, and a wrong length is a failure rather than
 * an exception: a proof that does not even have the right shape is still just
 * a wrong proof.
 */
export async function verifyWebuiBrowserBridgeProof(
  secret: Uint8Array,
  proof: WebuiBrowserBridgeProof,
  expectedNonce: string,
  expectedKeyId: string,
): Promise<boolean> {
  if (proof.keyId !== expectedKeyId) return false;
  if (proof.nonce !== expectedNonce) return false;
  // An absent algorithm is the older extension, which the host issued exactly
  // one algorithm to. A *different* algorithm is not "older": it is a proof
  // made by something else, and it is refused.
  if (
    proof.algorithm !== undefined &&
    proof.algorithm !== WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM
  ) {
    return false;
  }
  const expected = await signWebuiBrowserBridgeProof(secret, proof.nonce, proof.keyId);
  return constantTimeEqual(expected, proof.signature);
}

/**
 * Base64 without `Buffer`.
 *
 * `Buffer` is a Node global; an MV3 service worker does not have it. `btoa`
 * does exist in both, so the bytes are turned into a binary string and handed
 * to it. The chunked loop keeps the argument below the argument limit of
 * `String.fromCharCode` for long inputs.
 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/**
 * Decodes base64 into bytes, without `Buffer`.
 *
 * Same rationale as `encodeBase64`: run in both Node and a browser service
 * worker, neither of which want a `Buffer` dependency on one side and the
 * global on the other.
 */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The installation key's size, in bytes.
 *
 * 32 bytes matches the pairing credential's own secret, so the two secrets a
 * browser holds are the same strength and neither is the weak link.
 */
export const WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES = 32;

/**
 * The key id of a surface's installation key.
 *
 * The id is public — it is named on the challenge, so the extension knows what
 * to sign with — and it is *derived from the surface* rather than random: the
 * host has to find this exact entry again on the next start, and a stable id is
 * what makes that a load rather than a search.
 */
export function webuiBrowserBridgeInstallationKeyId(surface: string): string {
  return `webui-browser-bridge-installation-${surface}-v1`;
}

/** The one installation key for a surface, as the Settings surface receives it. */
export interface WebuiBrowserBridgeInstallationKeyView {
  /** The surface the key belongs to. */
  readonly surface: string;
  /** The public key id; the secret bytes are under `key`. */
  readonly keyId: string;
  /** Base64 of the 32 raw bytes. Shown once, to be pasted into the extension. */
  readonly key: string;
  /**
   * A short non-secret fingerprint, so the extension's options page can say
   * "a key is stored" without ever displaying it again.
   */
  readonly fingerprint: string;
}

/**
 * Compares two strings without leaking where they differ.
 *
 * The length difference is not hidden — it is observable in the length itself —
 * but the *position* of the first differing character is not, which is what a
 * timing attack on a signature needs.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

/* -------------------------------------------------------------------------- */
/* Pairing transfer: ECDH P-256 + HKDF-SHA256 + AES-256-GCM                   */
/* -------------------------------------------------------------------------- */

/**
 * The default salts and IVs lengths in bytes.
 *
 * Pinned so the test vector's payload is byte-for-byte reproducible: a
 * regression that tweaks these changes the payload and breaks both suites at
 * once, which is the only thing keeping the two hand-written implementations
 * honest.
 */
export const WEBUI_BROWSER_BRIDGE_PAIR_HKDF_SALT_BYTES = 16;
export const WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES = 12;

/**
 * Generates an ephemeral P-256 key pair on the curve ECDH admits. Returns the
 * key in the `CryptoKey` shape so the caller can `deriveBits`. The pair is
 * extractable so the public side can be exported as a JWK for the wire.
 */
export function generateWebuiBrowserBridgeEcdhKeyPair(): Promise<{
  readonly privateKey: WebuiBrowserBridgeCryptoKey;
  readonly publicKey: WebuiBrowserBridgeCryptoKey;
}> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
}

/**
 * Imports an extension's ECDH public key from its JWK form.
 */
export async function importWebuiBrowserBridgeEcdhPublicKey(
  jwk: WebuiBrowserBridgeEcdhPublicKey,
): Promise<WebuiBrowserBridgeCryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { ...jwk, ext: true, key_ops: [] },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

/**
 * Exports an ECDH public key as the wire-format JWK (no `d`, no `key_ops`).
 */
export async function exportWebuiBrowserBridgeEcdhPublicKey(
  publicKey: WebuiBrowserBridgeCryptoKey,
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
 * Derives a 256-bit AES-GCM key from an ECDH shared secret.
 *
 * Inputs (in order): the 32-byte shared secret from `ECDH`, a 16-byte salt,
 * the shared `info` string. The `info` literal is part of the wire protocol
 * and lives in this contract module so it cannot drift between copies.
 */
async function deriveWebuiBrowserBridgePairAesKey(
  sharedBits: ArrayBuffer,
  salt: Uint8Array,
): Promise<WebuiBrowserBridgeCryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(new TextEncoder().encode(WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO)) },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derives an AES-GCM key from `ECDH(privateKey, peerPublicKey)`.
 *
 * On **both** sides: the encryption side uses `ECDH(host_priv, ext_pub)` and
 * the decryption side uses `ECDH(ext_priv, host_pub)`. With the same salt
 * and `info` they land on the same bytes.
 */
async function deriveWebuiBrowserBridgePairAesKeyFromKeyPairs(
  ownPrivateKey: WebuiBrowserBridgeCryptoKey,
  peerPublicKey: WebuiBrowserBridgeCryptoKey,
  salt: Uint8Array,
): Promise<WebuiBrowserBridgeCryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    ownPrivateKey,
    256,
  );
  return deriveWebuiBrowserBridgePairAesKey(sharedBits, salt);
}

export interface WebuiBrowserBridgePairCipher {
  readonly publicKey: WebuiBrowserBridgeEcdhPublicKey;
  readonly salt: string;
  readonly payload: string;
}

/**
 * Encrypts `secretBytes` to the extension's ECDH public key.
 *
 * The result carries the **host's** ephemeral public key as well, because the
 * extension needs both public keys to derive the same shared secret.
 *
 * `randomBytes` and `hostKeyPair` are injectable: the cross-implementation
 * vector needs a fixed salt, IV and host key so both sides reproduce the same
 * payload byte for byte. Production calls with no override get
 * `crypto.getRandomValues` and a fresh `crypto.subtle.generateKey`.
 */
export async function sealWebuiBrowserBridgePairingCredential(
  secretBytes: Uint8Array,
  peerPublicKeyJwk: WebuiBrowserBridgeEcdhPublicKey,
  options: {
    readonly randomBytes?: (length: number) => Uint8Array;
    readonly hostKeyPair?: {
      readonly privateKey: WebuiBrowserBridgeCryptoKey;
      readonly publicKey: WebuiBrowserBridgeCryptoKey;
    };
  } = {},
): Promise<WebuiBrowserBridgePairCipher> {
  const random = options.randomBytes ?? defaultRandomBytes;
  const salt = random(WEBUI_BROWSER_BRIDGE_PAIR_HKDF_SALT_BYTES);
  const iv = random(WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES);
  const host = options.hostKeyPair ?? (await generateWebuiBrowserBridgeEcdhKeyPair());
  const hostPublicJwk = await exportWebuiBrowserBridgeEcdhPublicKey(host.publicKey);
  const peerPublic = await importWebuiBrowserBridgeEcdhPublicKey(peerPublicKeyJwk);
  const aesKey = await deriveWebuiBrowserBridgePairAesKeyFromKeyPairs(
    host.privateKey,
    peerPublic,
    salt,
  );
  // Plaintext is base64 of the credential bytes — one self-contained string,
  // not raw, so the encrypted side does not rely on a particular encoding
  // around the secret.
  const plaintextBytes = new TextEncoder().encode(encodeBase64(secretBytes));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(plaintextBytes),
    ),
  );
  const payloadBytes = new Uint8Array(iv.length + ciphertext.length);
  payloadBytes.set(iv, 0);
  payloadBytes.set(ciphertext, iv.length);
  return {
    publicKey: hostPublicJwk,
    salt: encodeBase64(salt),
    payload: encodeBase64(payloadBytes),
  };
}

/**
 * Opens a `pair` frame.
 *
 * Returns the secret bytes — the **bytes**, not the base64 — so the caller can
 * store them directly. Throws on a tampered payload: a one-byte change in the
 * ciphertext or IV is a GCM auth failure and the call rejects, which is
 * what we want.
 */
export async function openWebuiBrowserBridgePairingCredential(
  cipher: { readonly publicKey: WebuiBrowserBridgeEcdhPublicKey; readonly salt: string; readonly payload: string },
  ownPrivateKey: WebuiBrowserBridgeCryptoKey,
): Promise<Uint8Array> {
  const salt = decodeBase64(cipher.salt);
  const payloadBytes = decodeBase64(cipher.payload);
  if (payloadBytes.length < WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES + 16) {
    throw new Error("browser bridge: pair payload is too short to be a valid AES-GCM frame");
  }
  const iv = payloadBytes.subarray(0, WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES);
  const ciphertext = payloadBytes.subarray(WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES);
  const peerPublic = await importWebuiBrowserBridgeEcdhPublicKey(cipher.publicKey);
  const aesKey = await deriveWebuiBrowserBridgePairAesKeyFromKeyPairs(
    ownPrivateKey,
    peerPublic,
    salt,
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, aesKey, toArrayBuffer(ciphertext)),
  );
  // The plaintext is `base64(secretBytes)`; decode it so the extension stores
  // the raw secret rather than its base64.
  const decoded = decodeBase64(new TextDecoder().decode(plain));
  if (decoded.length === 0) {
    throw new Error("browser bridge: pair plaintext is empty");
  }
  return decoded;
}

/** Reads bytes via `crypto.getRandomValues`. The default entropy source. */
function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
