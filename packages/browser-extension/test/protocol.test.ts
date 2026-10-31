// No browser is involved here: the protocol module is pure, and everything below
// runs on Node's own Web Crypto.

import { describe, expect, it } from "vitest";

import {
  isWebuiBrowserBridgeInputCommand,
  openWebuiBrowserBridgePairingCredential,
  parseWebuiBrowserBridgeHostFrame,
  verifyWebuiBrowserBridgeProof,
  webuiBrowserBridgeProofMaterial,
  webuiBrowserBridgeUrl,
  WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO,
  WEBUI_BROWSER_BRIDGE_PATH,
  WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM,
  signWebuiBrowserBridgeProof,
  type WebuiBrowserBridgeEcdhPublicKey,
  type WebuiBrowserBridgeProof,
} from "../src/protocol.js";

/**
 * The cross-implementation vector.
 *
 * The host asserts this exact string in its own suite. A change to the material,
 * the algorithm or the encoding on either side therefore breaks exactly one
 * suite, which is the only thing keeping two hand-written copies of this
 * protocol in step.
 */
const TEST_SECRET = new TextEncoder().encode("webui-browser-bridge-test-secret");
const TEST_SIGNATURE = "xb7/GT5s+ScVsaiLkh+eRRndKi5oPQwqQMqU3aX8Znc=";

/* -------------------------------------------------------------------------- */
/* The pairing-transfer vector                                                */
/* -------------------------------------------------------------------------- */

/**
 * A fixed P-256 pair per side, a fixed salt, a fixed IV and a fixed plaintext.
 *
 * The host suite asserts the same numbers against the same key pair, salt and
 * plaintext. Two hand-written implementations of the same construction — one
 * running on Node, one in a service worker — agree only because this string
 * is the tie-breaker: change the `info`, the curve, the salt length or the
 * plaintext encoding on either side and exactly one suite fails.
 */
const VECTOR_HOST_PUBLIC: WebuiBrowserBridgeEcdhPublicKey = {
  kty: "EC",
  crv: "P-256",
  x: "XKwRVe-iSDOdOSBcT7wi5-6UDoXhSi_sJIva2FRwf-A",
  y: "JOmNw0lXPLULOJ02rq1ElmxknaPEkcoSGN7aHuVzYZk",
};

const VECTOR_EXTENSION_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "E97C62Slhb6xSK8jBY_vKNp_bXdZdUyq2z16I_ozyCA",
  y: "-h7QnrdbdOmS5Wgxe8VSGJWBLpsptMBSCKmLKYcockY",
  d: "1xQC1vkpguxZrUo9vhBkgX76gSaP3yiIv7YjgJUa4CA",
} as const;

const VECTOR_SALT = "AAECAwQFBgcICQoLDA0ODw==";
const VECTOR_PLAINTEXT = "ABEiM0RVZneImaq7zN3u/w==";
const VECTOR_PAYLOAD =
  "EBESExQVFhcYGRobrpzg8LW2dZC7oVrnYW8vU8zfjg8p/FNAc/YdMgkvUx7+O5ceWIULAw==";
/**
 * The plaintext the payload above carries, in hex.
 *
 * A published transfer vector, not a credential: the bytes are
 * 0x00, 0x11, 0x22, … so that they are obviously synthetic. The ciphertext
 * above is pinned to them, so the value cannot be changed — only the name.
 */
const VECTOR_PLAINTEXT_HEX = "00112233445566778899aabbccddeeff";

describe("browser bridge pairing transfer vector", () => {
  it("pins the agreed HKDF info and the byte layout", () => {
    expect(WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO).toBe("webui-browser-bridge-pair-v1");
  });

  it("opens the exact payload the host produced", async () => {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { ...VECTOR_EXTENSION_PRIVATE_JWK, key_ops: ["deriveBits"] },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );

    const secret = await openWebuiBrowserBridgePairingCredential(
      { publicKey: VECTOR_HOST_PUBLIC, salt: VECTOR_SALT, payload: VECTOR_PAYLOAD },
      privateKey,
    );

    expect(hexOf(secret)).toBe(VECTOR_PLAINTEXT_HEX);
    // The plaintext on the wire is `base64(secret)`, not the raw bytes.
    expect(encodeBase64(secret)).toBe(VECTOR_PLAINTEXT);
  });

  it("refuses a payload one bit away from the vector", async () => {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { ...VECTOR_EXTENSION_PRIVATE_JWK, key_ops: ["deriveBits"] },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const bytes = decodeBase64(VECTOR_PAYLOAD);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;

    await expect(
      openWebuiBrowserBridgePairingCredential(
        { publicKey: VECTOR_HOST_PUBLIC, salt: VECTOR_SALT, payload: encodeBase64(bytes) },
        privateKey,
      ),
    ).rejects.toBeDefined();
  });

  it("refuses a salt that is not the one the host chose", async () => {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { ...VECTOR_EXTENSION_PRIVATE_JWK, key_ops: ["deriveBits"] },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );

    await expect(
      openWebuiBrowserBridgePairingCredential(
        { publicKey: VECTOR_HOST_PUBLIC, salt: "AAECAwQFBgcICQoLDA0ODxA", payload: VECTOR_PAYLOAD },
        privateKey,
      ),
    ).rejects.toBeDefined();
  });
});

describe("browser bridge protocol", () => {
  it("signs the shared test vector", async () => {
    await expect(signWebuiBrowserBridgeProof(TEST_SECRET, "nonce-abc", "key-1")).resolves.toBe(
      TEST_SIGNATURE,
    );
  });

  it("signs the nonce and key id joined by exactly one space", () => {
    expect(webuiBrowserBridgeProofMaterial("nonce-abc", "key-1")).toBe("nonce-abc key-1");
    expect(WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM).toBe("HMAC-SHA256");
    expect(WEBUI_BROWSER_BRIDGE_PATH).toBe("/browser-bridge");
  });

  it("accepts a proof that answers the exact challenge", async () => {
    const proof: WebuiBrowserBridgeProof = {
      kind: "proof",
      keyId: "key-1",
      nonce: "nonce-abc",
      signature: TEST_SIGNATURE,
    };
    await expect(verifyWebuiBrowserBridgeProof(TEST_SECRET, proof, "nonce-abc", "key-1")).resolves.toBe(
      true,
    );
  });

  it("rejects a proof whose nonce is not the challenge it answers", async () => {
    const proof: WebuiBrowserBridgeProof = {
      kind: "proof",
      keyId: "key-1",
      nonce: "nonce-xyz",
      signature: TEST_SIGNATURE,
    };
    await expect(verifyWebuiBrowserBridgeProof(TEST_SECRET, proof, "nonce-abc", "key-1")).resolves.toBe(
      false,
    );
  });

  it("rejects a proof for a different key id", async () => {
    const proof: WebuiBrowserBridgeProof = {
      kind: "proof",
      keyId: "key-2",
      nonce: "nonce-abc",
      signature: TEST_SIGNATURE,
    };
    await expect(verifyWebuiBrowserBridgeProof(TEST_SECRET, proof, "nonce-abc", "key-1")).resolves.toBe(
      false,
    );
  });

  it("rejects a tampered signature and one of the wrong length", async () => {
    const tampered: WebuiBrowserBridgeProof = {
      kind: "proof",
      keyId: "key-1",
      nonce: "nonce-abc",
      signature: `xb7/GT5s+ScVsaiLkh+eRRndKi5oPQwqQMqU3aX8Znd=`,
    };
    await expect(verifyWebuiBrowserBridgeProof(TEST_SECRET, tampered, "nonce-abc", "key-1")).resolves.toBe(
      false,
    );
    const short: WebuiBrowserBridgeProof = { ...tampered, signature: "xb7" };
    await expect(verifyWebuiBrowserBridgeProof(TEST_SECRET, short, "nonce-abc", "key-1")).resolves.toBe(false);
  });

  it("refuses to build a bridge URL off loopback", () => {
    expect(webuiBrowserBridgeUrl("http://127.0.0.1:7777")).toBe("http://127.0.0.1:7777/browser-bridge");
    expect(webuiBrowserBridgeUrl("http://localhost:4319")).toBe("http://localhost:4319/browser-bridge");
    expect(() => webuiBrowserBridgeUrl("https://127.0.0.1:7777")).toThrow(/protocol/);
    expect(() => webuiBrowserBridgeUrl("http://example.com")).toThrow(/loopback/);
  });
});

describe("host frame parsing", () => {
  it("parses each declared host frame", () => {
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "ready", sessionId: "s-1" }))).toEqual({
      ok: true,
      frame: { kind: "ready", sessionId: "s-1" },
    });
    expect(
      parseWebuiBrowserBridgeHostFrame(
        JSON.stringify({
          kind: "challenge",
          nonce: "n-1",
          algorithm: "HMAC-SHA256",
          keyId: "key-1",
          installationKeyId: "webui-browser-bridge-installation-edge-v1",
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "ping", nonce: "p-1" }))).toMatchObject({
      ok: true,
    });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "closed", reason: "revoked" }))).toMatchObject({
      ok: true,
    });
  });

  it("reports an unusable frame instead of guessing", () => {
    expect(parseWebuiBrowserBridgeHostFrame("not json")).toEqual({
      ok: false,
      reason: "frame is not valid JSON",
    });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "surprise" }))).toEqual({
      ok: false,
      reason: "unknown frame kind surprise",
    });
    expect(
      parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "challenge", nonce: "n", keyId: "k", algorithm: "none" })),
    ).toMatchObject({ ok: false });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "challenge", keyId: "k" }))).toMatchObject({
      ok: false,
    });
    expect(
      parseWebuiBrowserBridgeHostFrame(JSON.stringify({ kind: "input", commandId: "c-1" })),
    ).toMatchObject({ ok: false, reason: "input carries an invalid command" });
  });

  it("requires an input command to name a target and a generation", () => {
    expect(
      isWebuiBrowserBridgeInputCommand({ kind: "pointer", targetId: "tab-7", generation: 2, x: 1, y: 2, button: "left", clickCount: 1 }),
    ).toBe(true);
    expect(
      isWebuiBrowserBridgeInputCommand({ kind: "text", targetId: "tab-7", generation: 2, text: "hi" }),
    ).toBe(true);
    expect(isWebuiBrowserBridgeInputCommand({ kind: "text", targetId: "tab-7", text: "hi" })).toBe(false);
    expect(isWebuiBrowserBridgeInputCommand({ kind: "text", targetId: "", generation: 2, text: "hi" })).toBe(false);
    expect(isWebuiBrowserBridgeInputCommand({ kind: "scroll", targetId: "tab-7", generation: 2 })).toBe(false);
  });

  it("parses a pair frame and rejects one missing a field it cannot open", () => {
    const frame = {
      kind: "pair",
      keyId: "edge-1",
      publicKey: VECTOR_HOST_PUBLIC,
      salt: VECTOR_SALT,
      payload: VECTOR_PAYLOAD,
    };
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify(frame))).toMatchObject({ ok: true });

    // A `pair` without the host's public key cannot be decrypted, and saying
    // so at parse time is what stops the handshake hanging on it.
    expect(
      parseWebuiBrowserBridgeHostFrame(JSON.stringify({ ...frame, publicKey: undefined })),
    ).toMatchObject({ ok: false, reason: "pair public key is missing or not a P-256 JWK" });
    expect(
      parseWebuiBrowserBridgeHostFrame(
        JSON.stringify({ ...frame, publicKey: { kty: "RSA", crv: "P-256", x: "a", y: "b" } }),
      ),
    ).toMatchObject({ ok: false });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ ...frame, salt: "" }))).toMatchObject({
      ok: false,
      reason: "pair has no salt",
    });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ ...frame, payload: "" }))).toMatchObject({
      ok: false,
      reason: "pair has no payload",
    });
    expect(parseWebuiBrowserBridgeHostFrame(JSON.stringify({ ...frame, keyId: "" }))).toMatchObject({
      ok: false,
      reason: "pair has no key id",
    });
  });
});

/* -------------------------------------------------------------------------- */

/** Base64 without `Buffer` — this package is type-checked against a browser. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 decode without `Buffer`. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Hex, so a byte comparison in a failure message is readable. */
function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}