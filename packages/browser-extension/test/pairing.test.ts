// No browser is involved here: `chrome.storage` is replaced by the small fakes
// below, and `crypto.subtle` is Node's own Web Crypto, which is the same
// implementation the service worker gets. Nothing here talks to a real Chrome.
//
// The point of this file is that the credential is **host-authored**. The
// extension cannot mint one: two independently minted credentials never
// match, so the host would never accept a proof against the wrong secret.
// Every credential below arrives through a `pair` frame, decrypted with an
// ECDH key this side minted for that one connection.

import { describe, expect, it } from "vitest";

import {
  answerWebuiBrowserBridgeChallenge,
  answerWebuiBrowserBridgeChallengeWithStoredSecrets,
  answerWebuiBrowserBridgeInstallationChallenge,
  applyWebuiBrowserBridgePairingCredential,
  clearWebuiBrowserBridgeInstallationKey,
  clearWebuiBrowserBridgePairingCredential,
  loadWebuiBrowserBridgeInstallationKey,
  loadWebuiBrowserBridgePairingCredential,
  saveWebuiBrowserBridgeInstallationKey,
  webuiBrowserBridgeInstallationKeyStore,
  webuiBrowserBridgePairingStore,
  webuiBrowserBridgeInstallationKeyStatus,
  WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES,
  WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_STORAGE_KEY,
  WEBUI_BROWSER_BRIDGE_PAIRING_STORAGE_KEY,
  WEBUI_BROWSER_BRIDGE_SECRET_BYTES,
  type WebuiBrowserBridgeStorageArea,
} from "../src/pairing.js";
import {
  encodeWebuiBrowserBridgeBase64,
  exportWebuiBrowserBridgeEcdhPublicKey,
  generateWebuiBrowserBridgeEcdhKeyPair,
  importWebuiBrowserBridgeEcdhPublicKey,
  openWebuiBrowserBridgePairingCredential,
  verifyWebuiBrowserBridgeProof,
  WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES,
  WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO,
  type WebuiBrowserBridgeChallenge,
  type WebuiBrowserBridgeEcdhPublicKey,
  type WebuiBrowserBridgePair,
} from "../src/protocol.js";

function fakeArea(): WebuiBrowserBridgeStorageArea & { readonly values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(key) {
      const keys = key === null ? Object.keys(values) : Array.isArray(key) ? key : [key];
      const read: Record<string, unknown> = {};
      for (const name of keys) if (name in values) read[name] = values[name];
      return read;
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(key) {
      for (const name of Array.isArray(key) ? key : [key]) delete values[name];
    },
  };
}

/**
 * Bytes 1..255, 0..255, 1..255, ... — non-zero, so a zero byte in the secret
 * cannot be mistaken for a padding artefact when it comes back.
 */
function countingSecret(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => ((index + 1) % 256) || 1);
}

/** The credential body a host would keep in its OS secure store. */
function makeHostSecret(seed: number): Uint8Array {
  const bytes = new Uint8Array(WEBUI_BROWSER_BRIDGE_SECRET_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = ((seed * (index + 1)) % 255) || 1;
  }
  return bytes;
}

/** An ECDH key pair, as the two shapes the wire needs. */
async function mintEcdhPair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicJwk: WebuiBrowserBridgeEcdhPublicKey;
}> {
  const { privateKey, publicKey } = await generateWebuiBrowserBridgeEcdhKeyPair();
  return { privateKey, publicJwk: await exportWebuiBrowserBridgeEcdhPublicKey(publicKey) };
}

/**
 * Plays the host: seal a credential body to the extension's `hello` key.
 *
 * This is a second implementation of the host's seal, written here so the
 * test is not asserting the extension's own helper against itself. It is the
 * same construction the webui side ships
 * (`sealWebuiBrowserBridgePairingCredential` in the shared contract), and the
 * shared vector in `protocol.test.ts` pins both halves of it.
 */
async function hostPairFrame(
  extensionPublicJwk: WebuiBrowserBridgeEcdhPublicKey,
  secretBytes: Uint8Array,
  keyId: string,
): Promise<WebuiBrowserBridgePair> {
  const salt = countingSecret(16);
  const iv = countingSecret(WEBUI_BROWSER_BRIDGE_PAIR_AES_IV_BYTES);
  const host = await generateWebuiBrowserBridgeEcdhKeyPair();
  const peer = await importWebuiBrowserBridgeEcdhPublicKey(extensionPublicJwk);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peer },
    host.privateKey,
    256,
  );
  const baseKey = await crypto.subtle.importKey("raw", sharedBits, { name: "HKDF" }, false, [
    "deriveKey",
  ]);
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: new TextEncoder().encode(WEBUI_BROWSER_BRIDGE_PAIR_HKDF_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(new TextEncoder().encode(encodeWebuiBrowserBridgeBase64(secretBytes))),
    ),
  );
  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.length);
  return {
    kind: "pair",
    keyId,
    publicKey: await exportWebuiBrowserBridgeEcdhPublicKey(host.publicKey),
    salt: encodeBase64ForTest(salt),
    payload: encodeBase64ForTest(payload),
  };
}

describe("pairing credential — host-authored", () => {
  it("holds no credential until a host pair frame delivers one", async () => {
    const store = webuiBrowserBridgePairingStore(fakeArea());

    // No credential is minted on first use: that is the defect this exchange
    // exists to remove. The extension's own id would never match the host's.
    expect(await loadWebuiBrowserBridgePairingCredential(store)).toBeUndefined();
  });

  it("decrypts a pair frame and stores exactly the host's secret", async () => {
    const area = fakeArea();
    const store = webuiBrowserBridgePairingStore(area);
    const { privateKey, publicJwk } = await mintEcdhPair();
    const hostSecret = makeHostSecret(7);

    const cipher = await hostPairFrame(publicJwk, hostSecret, "edge-host-issued-1");

    // The wire frame must not carry the secret in any form.
    const encodedSecret = encodeWebuiBrowserBridgeBase64(hostSecret);
    expect(JSON.stringify(cipher)).not.toContain(encodedSecret);
    expect(cipher).not.toHaveProperty("secret");

    const stored = await applyWebuiBrowserBridgePairingCredential(store, cipher, privateKey);

    expect(stored.keyId).toBe("edge-host-issued-1");
    expect(encodeWebuiBrowserBridgeBase64(stored.secret)).toBe(encodedSecret);
    expect(area.values[WEBUI_BROWSER_BRIDGE_PAIRING_STORAGE_KEY]).toBeDefined();
  });

  it("reloads the same credential after a worker restart", async () => {
    const area = fakeArea();
    const store = webuiBrowserBridgePairingStore(area);
    const { privateKey, publicJwk } = await mintEcdhPair();
    await applyWebuiBrowserBridgePairingCredential(
      store,
      await hostPairFrame(publicJwk, makeHostSecret(11), "edge-restart"),
      privateKey,
    );

    // A restarted worker rebuilds the client from storage alone.
    const reloaded = await loadWebuiBrowserBridgePairingCredential(store);

    expect(reloaded?.keyId).toBe("edge-restart");
    expect(encodeWebuiBrowserBridgeBase64(reloaded!.secret)).toBe(
      encodeWebuiBrowserBridgeBase64(makeHostSecret(11)),
    );
  });

  it("holds no credential when storage has a truncated one", async () => {
    const area = fakeArea();
    const store = webuiBrowserBridgePairingStore(area);
    await area.set({
      [WEBUI_BROWSER_BRIDGE_PAIRING_STORAGE_KEY]: {
        keyId: "edge-broken",
        secret: encodeWebuiBrowserBridgeBase64(new Uint8Array(4)),
      },
    });

    expect(await loadWebuiBrowserBridgePairingCredential(store)).toBeUndefined();
  });

  it("replaces the stored credential when the host rotates it", async () => {
    const area = fakeArea();
    const store = webuiBrowserBridgePairingStore(area);

    // First connection: the switch was on, the host issued credential A.
    const first = await mintEcdhPair();
    await applyWebuiBrowserBridgePairingCredential(
      store,
      await hostPairFrame(first.publicJwk, makeHostSecret(101), "edge-cred-a"),
      first.privateKey,
    );
    expect((await loadWebuiBrowserBridgePairingCredential(store))?.keyId).toBe("edge-cred-a");

    // The person turned the switch off and on again: the host minted a new
    // credential. The next connection delivers it, and the extension drops
    // the old copy rather than keeping both.
    const second = await mintEcdhPair();
    const rotated = await applyWebuiBrowserBridgePairingCredential(
      store,
      await hostPairFrame(second.publicJwk, makeHostSecret(202), "edge-cred-b"),
      second.privateKey,
    );
    const after = await loadWebuiBrowserBridgePairingCredential(store);

    expect(rotated.keyId).toBe("edge-cred-b");
    expect(after?.keyId).toBe("edge-cred-b");
    expect(encodeWebuiBrowserBridgeBase64(after!.secret)).toBe(
      encodeWebuiBrowserBridgeBase64(makeHostSecret(202)),
    );
    expect(encodeWebuiBrowserBridgeBase64(after!.secret)).not.toBe(
      encodeWebuiBrowserBridgeBase64(makeHostSecret(101)),
    );
  });

  it("answers a host challenge with the credential the pair frame carried", async () => {
    const store = webuiBrowserBridgePairingStore(fakeArea());
    const { privateKey, publicJwk } = await mintEcdhPair();
    const hostSecret = makeHostSecret(31);
    const credential = await applyWebuiBrowserBridgePairingCredential(
      store,
      await hostPairFrame(publicJwk, hostSecret, "edge-answer"),
      privateKey,
    );

    // A restarted worker: only storage remains, exactly as it is in a real MV3
    // service worker that was terminated between connections.
    const afterRestart = await loadWebuiBrowserBridgePairingCredential(store);
    const proof = await answerWebuiBrowserBridgeChallenge(
      challengeFor("nonce-abc", credential.keyId),
      afterRestart!,
    );

    // The host verifies against the secret it stored, not against anything the
    // extension chose — so this is the end-to-end claim in one line.
    await expect(
      verifyWebuiBrowserBridgeProof(hostSecret, proof, "nonce-abc", "edge-answer"),
    ).resolves.toBe(true);
  });

  it("refuses a tampered payload instead of storing half a credential", async () => {
    const store = webuiBrowserBridgePairingStore(fakeArea());
    const { privateKey, publicJwk } = await mintEcdhPair();
    const cipher = await hostPairFrame(publicJwk, makeHostSecret(41), "edge-tampered");

    // Flip one bit in the last byte of the payload: the AES-GCM tag covers it,
    // so decryption must fail rather than return a plausible-looking secret.
    const bytes = decodeBase64ForTest(cipher.payload);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    const tampered: WebuiBrowserBridgePair = { ...cipher, payload: encodeBase64ForTest(bytes) };

    await expect(openWebuiBrowserBridgePairingCredential(tampered, privateKey)).rejects.toBeDefined();
    expect(await loadWebuiBrowserBridgePairingCredential(store)).toBeUndefined();
  });

  it("refuses a payload encrypted to a different extension key", async () => {
    const store = webuiBrowserBridgePairingStore(fakeArea());
    const mine = await mintEcdhPair();
    const someoneElse = await mintEcdhPair();
    // Sealed to a key this worker never generated.
    const cipher = await hostPairFrame(someoneElse.publicJwk, makeHostSecret(47), "edge-not-mine");

    await expect(
      applyWebuiBrowserBridgePairingCredential(store, cipher, mine.privateKey),
    ).rejects.toBeDefined();
    expect(await loadWebuiBrowserBridgePairingCredential(store)).toBeUndefined();
  });

  it("forgets the credential only when the caller asks it to", async () => {
    const area = fakeArea();
    const store = webuiBrowserBridgePairingStore(area);
    await area.set({
      [WEBUI_BROWSER_BRIDGE_PAIRING_STORAGE_KEY]: {
        keyId: "edge-doomed",
        secret: encodeWebuiBrowserBridgeBase64(makeHostSecret(3)),
      },
    });

    await clearWebuiBrowserBridgePairingCredential(store);

    expect(area.values[WEBUI_BROWSER_BRIDGE_PAIRING_STORAGE_KEY]).toBeUndefined();
  });
});

describe("challenge answering", () => {
  it("refuses a challenge for a credential it does not hold or an algorithm it does not implement", async () => {
    const credential = {
      keyId: "edge-key",
      secret: makeHostSecret(13),
    };

    await expect(
      answerWebuiBrowserBridgeChallenge(
        challengeFor("n", "edge-someone-else"),
        credential,
      ),
    ).rejects.toThrow(/does not hold/);
    await expect(
      answerWebuiBrowserBridgeChallenge(
        { ...challengeFor("n", credential.keyId), algorithm: "HMAC-SHA1" as "HMAC-SHA256" },
        credential,
      ),
    ).rejects.toThrow(/algorithm/);
  });

  it("binds the proof to the nonce so an earlier one cannot stand in", async () => {
    const credential = { keyId: "edge-key", secret: makeHostSecret(13) };
    const proof = await answerWebuiBrowserBridgeChallenge(
      challengeFor("nonce-now", "edge-key"),
      credential,
    );

    await expect(
      verifyWebuiBrowserBridgeProof(credential.secret, proof, "nonce-later", "edge-key"),
    ).resolves.toBe(false);
  });
});

describe("the installation key — what the options page stores", () => {
  it("stores the pasted key in chrome.storage.local, under its own key", async () => {
    const area = fakeArea();
    const store = webuiBrowserBridgeInstallationKeyStore(area);
    const pasted = encodeWebuiBrowserBridgeBase64(makeHostSecret(7));

    await saveWebuiBrowserBridgeInstallationKey(store, pasted);

    // Its own entry, not the pairing credential's: the two have different
    // lifetimes, so one can never be cleared by clearing the other.
    expect(area.values[WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_STORAGE_KEY]).toBeDefined();
    expect(area.values[WEBUI_BROWSER_BRIDGE_PAIRING_STORAGE_KEY]).toBeUndefined();

    const loaded = await loadWebuiBrowserBridgeInstallationKey(store);
    expect(loaded).toBeDefined();
    expect(loaded!.secret).toHaveLength(WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES);
  });

  it("refuses a paste that is not exactly 32 bytes", async () => {
    const store = webuiBrowserBridgeInstallationKeyStore(fakeArea());
    const tooShort = encodeWebuiBrowserBridgeBase64(new Uint8Array(16));
    await expect(saveWebuiBrowserBridgeInstallationKey(store, tooShort)).rejects.toThrow(/32 bytes/);
    expect(
      await loadWebuiBrowserBridgeInstallationKey(store),
    ).toBeUndefined();
  });

  it("never returns the key after it is stored, only a fingerprint", async () => {
    const store = webuiBrowserBridgeInstallationKeyStore(fakeArea());
    const pasted = encodeWebuiBrowserBridgeBase64(makeHostSecret(11));
    await saveWebuiBrowserBridgeInstallationKey(store, pasted);

    // This is the only reader the options page uses. Its return type carries
    // no key field at all, so "the key is never displayed again" is a
    // property of the type rather than of the markup.
    const state = await webuiBrowserBridgeInstallationKeyStatus(store);
    expect(state).toEqual({ stored: true, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u) });
    expect(JSON.stringify(state)).not.toContain(pasted);
    expect("key" in state).toBe(false);
  });

  it("reports an empty browser as having nothing stored", async () => {
    expect(await webuiBrowserBridgeInstallationKeyStatus(webuiBrowserBridgeInstallationKeyStore(fakeArea()))).toEqual({
      stored: false,
    });
  });

  it("clears only the installation key", async () => {
    const area = fakeArea();
    const pairing = webuiBrowserBridgePairingStore(area);
    const installation = webuiBrowserBridgeInstallationKeyStore(area);
    await saveWebuiBrowserBridgeInstallationKey(installation, encodeWebuiBrowserBridgeBase64(makeHostSecret(3)));
    await pairing.write({ keyId: "edge", secret: encodeWebuiBrowserBridgeBase64(makeHostSecret(5)) });

    await clearWebuiBrowserBridgeInstallationKey(installation);

    expect(await loadWebuiBrowserBridgeInstallationKey(installation)).toBeUndefined();
    expect(await loadWebuiBrowserBridgePairingCredential(pairing)).toBeDefined();
  });
});

describe("answering with the installation key", () => {
  it("signs with the installation key the host named on the challenge", async () => {
    const challenge = challengeFor("nonce-first", "edge-credential-key");
    const installationKey = { secret: makeHostSecret(31) };

    const proof = await answerWebuiBrowserBridgeInstallationChallenge(challenge, installationKey);

    // The key id is the one the host named, so the proof is bound to this
    // host's key and cannot be replayed against another.
    expect(proof.keyId).toBe(challenge.installationKeyId);
    await expect(
      verifyWebuiBrowserBridgeProof(installationKey.secret, proof, challenge.nonce, proof.keyId),
    ).resolves.toBe(true);
  });

  it("prefers the installation key over a held pairing credential", async () => {
    const challenge = challengeFor("nonce-both", "edge-credential-key");
    const installationKey = { secret: makeHostSecret(41) };
    const credential = { keyId: "edge-credential-key", secret: makeHostSecret(43) };

    const proof = await answerWebuiBrowserBridgeChallengeWithStoredSecrets(
      challenge,
      installationKey,
      credential,
    );
    // The installation key survives a host-side credential rotation; a stale
    // pairing credential does not. Preferring it is what lets a re-provisioned
    // host re-pair without the person touching anything.
    expect(proof.keyId).toBe(challenge.installationKeyId);
  });

  it("falls back to the pairing credential when no installation key is held", async () => {
    const challenge = challengeFor("nonce-fallback", "edge-credential-key");
    const credential = { keyId: "edge-credential-key", secret: makeHostSecret(47) };

    const proof = await answerWebuiBrowserBridgeChallengeWithStoredSecrets(
      challenge,
      undefined,
      credential,
    );
    expect(proof.keyId).toBe(credential.keyId);
  });

  it("refuses, with a message that says what to do, when it holds neither", async () => {
    await expect(
      answerWebuiBrowserBridgeChallengeWithStoredSecrets(
        challengeFor("nonce-neither", "edge-credential-key"),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/paste the installation key/);
  });
});

describe("secret handling", () => {
  it("never writes the secret, salt, payload or nonce to the console", async () => {
    const calls: unknown[][] = [];
    const original = { log: console.log };
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const { privateKey, publicJwk } = await mintEcdhPair();
      const hostSecret = makeHostSecret(23);
      const cipher = await hostPairFrame(publicJwk, hostSecret, "edge-quiet");
      await openWebuiBrowserBridgePairingCredential(cipher, privateKey);
      await answerWebuiBrowserBridgeChallenge(
        challengeFor("nonce-abc", "edge-quiet"),
        { keyId: "edge-quiet", secret: hostSecret },
      );
    } finally {
      console.log = original.log;
    }

    expect(calls).toEqual([]);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(encodeWebuiBrowserBridgeBase64(makeHostSecret(23)));
    expect(logged).not.toContain("edge-quiet");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A host challenge, naming both key ids.
 *
 * A challenge without an `installationKeyId` is not one this extension will
 * accept — see `parseWebuiBrowserBridgeHostFrame` — so every fixture here
 * names it rather than omitting it.
 */
function challengeFor(nonce: string, keyId: string): WebuiBrowserBridgeChallenge {
  return {
    kind: "challenge",
    nonce,
    algorithm: "HMAC-SHA256",
    keyId,
    installationKeyId: "webui-browser-bridge-installation-edge-v1",
  };
}

/** Base64 decode without `Buffer`: this package is type-checked against a browser. */
function decodeBase64ForTest(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Base64 encode without `Buffer`. */
function encodeBase64ForTest(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Copy into a plain `ArrayBuffer`: Web Crypto's `BufferSource` wants one. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}