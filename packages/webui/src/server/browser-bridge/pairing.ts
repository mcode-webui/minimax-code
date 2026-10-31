// Per-browser pairing for the extension bridge.
//
// One `BrowserBridgePairing` per browser surface (`edge` or `chrome`). It
// owns a single active credential at a time, the latest issue-and-verify
// state for the in-flight challenge, and the lifecycle hooks the registry
// calls when the user flips a switch.
//
// The pairing is the single source of truth for "is this browser's switch
// on, and if so what credential proves it". Admission talks to it through
// `authorizeBrowser(extensionId)`; the session talks to it through
// `issueChallenge()` and `verifyProof()`. Neither path needs to know about
// the credential store directly — that is intentional. Storing the secret
// is the store's job; deciding when a credential is valid is this object's
// job.

import { randomBytes } from "node:crypto";

import {
  sealWebuiBrowserBridgePairingCredential,
  signWebuiBrowserBridgeProof,
  verifyWebuiBrowserBridgeProof,
  webuiBrowserBridgeInstallationKeyId,
  WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES,
  WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM,
  type WebuiBrowserBridgeChallenge,
  type WebuiBrowserBridgeEcdhPublicKey,
  type WebuiBrowserBridgeInstallationKeyView,
  type WebuiBrowserBridgeProof,
} from "../../shared/contracts/browser-bridge.js";
import type { WebuiBridgeBrowserSurface } from "../../shared/contracts/browser.js";

import {
  BrowserCredentialStoreUnavailableError,
  fingerprint,
  generateBridgeCredential,
  type SecureCredentialStore,
} from "./credential-store.js";

const NONCE_BYTES = 32;

/** The non-secret metadata for a credential, suitable for surfacing in the UI. */
export interface BrowserBridgePairingMetadata {
  readonly keyId: string;
  readonly fingerprint: string;
  readonly savedAt: number;
}

/** Snapshot of the pairing for the surface layer. Includes the disabled state. */
export type BrowserBridgePairingStatus =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly credential: BrowserBridgePairingMetadata };

/** The dependencies of a pairing. */
export interface BrowserBridgePairingOptions {
  /** Which browser surface this pairing is for. */
  readonly surface: WebuiBridgeBrowserSurface;
  /** The credential store. The pairing never writes secrets anywhere else. */
  readonly credentialStore: SecureCredentialStore;
  /**
   * The extension ids the bridge admits for this browser's switch. The
   * pairing checks membership before issuing a challenge.
   */
  readonly allowedExtensionIds: ReadonlySet<string>;
  /**
   * The persisted credential (key id + secret) to seed the pairing with on
   * construction. When the host is restarted, the same credential must
   * re-present because the extension holds it across restarts. Omit for a
   * fresh pairing that has no enabled history.
   */
  readonly initialCredential?: { readonly keyId: string; readonly secret: Uint8Array };
  /**
   * Override of the entropy source for nonces; tests inject a deterministic
   * generator.
   */
  readonly randomBytes?: (bytes: number) => Uint8Array;
}

/** Why a proof did not open the handshake. Each value names what was missing. */
export type BrowserBridgeProofRefusal =
  /** The surface's switch is off, so nothing is provable. */
  | "switched_off"
  /** The nonce is not one this pairing issued, or was already answered. */
  | "unknown_nonce"
  /** The proof names a key this surface does not hold. */
  | "unknown_key_id"
  /**
   * The proof named the installation key and the signature did not verify:
   * this browser holds an installation key that is not this host's.
   */
  | "installation_key_mismatch"
  /**
   * The proof named the pairing credential and the signature did not verify:
   * this browser holds a pairing credential this host has since rotated.
   */
  | "pairing_credential_mismatch"
  /**
   * The peer proved the installation key but sent no ephemeral public key, so
   * the host has nothing to seal the credential to. Raised by the session,
   * which owns the peer's `hello` frame.
   */
  | "no_peer_public_key"
  /**
   * The peer named a browser this host does not admit its identity on.
   *
   * An unpacked build has one identity, and a person who loads it in both
   * Edge and Chrome lists that identity on both surfaces. The identity
   * therefore cannot say which surface the peer is on, so the peer names the
   * browser it runs in and the host answers with the pairing for that
   * browser. A peer naming a browser the host does not know is refused
   * rather than attached to whichever pairing happened to be first.
   */
  | "unknown_browser";

/** What a verified proof proved. Decides whether a `pair` frame follows. */
export type BrowserBridgeProofOutcome =
  /** Proved the installation key. The peer may now receive the credential. */
  | { readonly kind: "installation_key" }
  /**
   * Proved a pairing credential this host already issued. The peer already
   * holds it, so no `pair` frame is sent.
   */
  | { readonly kind: "pairing_credential" }
  /** Neither. `reason` says which anchor was missing or wrong. */
  | { readonly kind: "refused"; readonly reason: BrowserBridgeProofRefusal };

/**
 * One pairing per browser. Use it from the admission path and the session.
 */
export class BrowserBridgePairing {
  readonly surface: WebuiBridgeBrowserSurface;
  private readonly credentialStore: SecureCredentialStore;
  private readonly allowedExtensionIds: ReadonlySet<string>;
  private readonly randomBytesSource: (bytes: number) => Uint8Array;

  /**
   * The live credential. When the switch is off, both `keyId` and `secret`
   * are `undefined`. When the switch is on, both are set together — there is
   * never a half-populated credential.
   */
  private current: { readonly keyId: string; readonly secret: Uint8Array } | undefined;
  /**
   * The set of nonces the host has already issued and that have not yet been
   * answered. The nonce leaves this set exactly once: when a proof that
   * echoes it back is verified (or when the host revokes the challenge
   * without answering it). A nonce may not be answered twice.
   */
  private readonly outstandingNonces = new Set<string>();
  /** Saves the credential timestamp so `list()` shows the right moment. */
  private readonly savedAt = new Map<string, number>();
  /**
   * The installation key, held in memory once this process has loaded it.
   *
   * Unlike `current`, this survives `disable()`: the key is bound to the
   * browser, not to a switch, so toggling the switch must not force the person
   * to re-paste it. It is `undefined` only until `ensureInstallationKey()` has
   * run, which every enable/restore path does.
   */
  private installationKeySecret: Uint8Array | undefined;

  constructor(options: BrowserBridgePairingOptions) {
    this.surface = options.surface;
    this.credentialStore = options.credentialStore;
    this.allowedExtensionIds = options.allowedExtensionIds;
    this.randomBytesSource = options.randomBytes ?? ((bytes) => randomBytes(bytes));
    if (options.initialCredential) {
      this.current = {
        keyId: options.initialCredential.keyId,
        secret: options.initialCredential.secret,
      };
      this.savedAt.set(options.initialCredential.keyId, Date.now());
    }
  }

  /** Whether the surface's switch is currently on. */
  get enabled(): boolean {
    return this.current !== undefined;
  }

  /** The current keyId, if the switch is on. Safe to surface in the UI. */
  get keyId(): string | undefined {
    return this.current?.keyId;
  }

  /** A safe-to-surface snapshot of state. Never includes the secret. */
  status(): BrowserBridgePairingStatus {
    if (!this.current) return { enabled: false };
    const keyId = this.current.keyId;
    const savedAt = this.savedAt.get(keyId) ?? Date.now();
    return {
      enabled: true,
      credential: {
        keyId,
        fingerprint: fingerprint(this.current.secret),
        savedAt,
      },
    };
  }

  /**
   * Whether `extensionId` is on the allowlist for this browser. Called by
   * the admission path BEFORE the connection is accepted at the upgrade so
   * a wrong id never even reads a nonce.
   */
  admitsExtensionId(extensionId: string): boolean {
    return this.allowedExtensionIds.has(extensionId);
  }

  /**
   * Issue a fresh challenge. Throws if the switch is off, because there is
   * no credential to prove against, or if the credential store could not be
   * reached. The caller is expected to translate the store error into a
   * `browser_credential_store_unavailable` reply.
   *
   * The challenge names **two** key ids: the installation key a peer proves
   * before it may receive a credential, and the current pairing credential an
   * already-paired peer answers with. The key id in the proof selects which.
   */
  async issueChallenge(): Promise<WebuiBrowserBridgeChallenge> {
    const current = this.current;
    if (!current) {
      throw new PairingSwitchedOffError(
        `browser bridge for "${this.surface}" is switched off`,
      );
    }
    if (!(await this.credentialStore.isAvailable())) {
      throw new BrowserCredentialStoreUnavailableError(
        "the OS secure credential store is not available",
        `cannot issue challenge for "${this.surface}"`,
      );
    }
    const nonceBytes = this.randomBytesSource(NONCE_BYTES);
    const nonce = bufferToBase64Url(nonceBytes);
    this.outstandingNonces.add(nonce);
    return {
      kind: "challenge",
      nonce,
      algorithm: WEBUI_BROWSER_BRIDGE_SIGNATURE_ALGORITHM,
      keyId: current.keyId,
      installationKeyId: this.installationKeyId,
    };
  }

  /**
   * Verify a proof against the installation key first, then the pairing
   * credential.
   *
   * The order is the whole point of the design: only a proof against the
   * installation key authorises the host to hand over a credential, and a
   * proof against the pairing credential only says "already paired". A peer
   * that can spoof the allowlisted `Origin` header holds neither secret, so it
   * reaches neither branch.
   *
   * The nonce must be one this pairing issued *and* must not have been
   * answered already. A successful verification consumes the nonce so the
   * same proof cannot be replayed. A failed verification leaves the nonce
   * outstanding so the extension gets exactly one chance to recover.
   *
   * The store is read on every call rather than from `this.current` so a host
   * whose store entry was removed out from under it refuses rather than
   * answering from memory.
   */
  async verifyProof(proof: WebuiBrowserBridgeProof): Promise<BrowserBridgeProofOutcome> {
    const current = this.current;
    if (!current) {
      return { kind: "refused", reason: "switched_off" };
    }
    if (!this.outstandingNonces.has(proof.nonce)) {
      return { kind: "refused", reason: "unknown_nonce" };
    }
    if (proof.keyId === this.installationKeyId) {
      const secret = await this.loadInstallationKey();
      if (!secret) {
        return { kind: "refused", reason: "unknown_key_id" };
      }
      const valid = await this.check(secret, proof);
      if (!valid) return { kind: "refused", reason: "installation_key_mismatch" };
      this.outstandingNonces.delete(proof.nonce);
      return { kind: "installation_key" };
    }
    if (proof.keyId !== current.keyId) {
      return { kind: "refused", reason: "unknown_key_id" };
    }
    const stored = await this.readFromStore(current.keyId);
    if (!stored) return { kind: "refused", reason: "pairing_credential_mismatch" };
    const valid = await this.check(stored, proof);
    if (!valid) return { kind: "refused", reason: "pairing_credential_mismatch" };
    this.outstandingNonces.delete(proof.nonce);
    return { kind: "pairing_credential" };
  }

  /** Verify a proof against the current credential, as a bare yes/no. */
  async verifyPairingCredentialProof(proof: WebuiBrowserBridgeProof): Promise<boolean> {
    const outcome = await this.verifyProof(proof);
    return outcome.kind !== "refused";
  }

  /**
   * One HMAC check, with the nonce still outstanding.
   *
   * The caller consumes the nonce only once a check succeeds, so a failed
   * attempt leaves the challenge answerable — which is what the existing
   * "one shot to recover" behaviour promises.
   */
  private async check(secret: Uint8Array, proof: WebuiBrowserBridgeProof): Promise<boolean> {
    try {
      return await verifyWebuiBrowserBridgeProof(secret, proof, proof.nonce, proof.keyId);
    } catch {
      return false;
    }
  }

  /** A store read that turns any failure into "not there". */
  private async readFromStore(keyId: string): Promise<Uint8Array | undefined> {
    try {
      return await this.credentialStore.load(keyId);
    } catch {
      return undefined;
    }
  }

  /**
   * Drop the outstanding nonce for a challenge the extension will never
   * answer (e.g. because the socket closed before proof arrived). The host
   * simply forgets the nonce; verification will fail later if anyone tries
   * to use it.
   */
  forgetChallenge(nonce: string): void {
    this.outstandingNonces.delete(nonce);
  }

  /**
   * Every nonce the host has issued and not yet answered. Test-only
   * inspection — production code never queries this.
   */
  outstandingNonceCount(): number {
    return this.outstandingNonces.size;
  }

  /**
   * Sign a proof for the current challenge, using the current credential.
   * Provided so a test client (or a sibling host) can drive the
   * challenge/response exchange with the SAME secret the host stores. We
   * re-export the underlying signer so the construction stays a single
   * source of truth.
   */
  async signProof(nonce: string): Promise<string> {
    const current = this.current;
    if (!current) {
      throw new PairingSwitchedOffError(
        `browser bridge for "${this.surface}" is switched off`,
      );
    }
    return signWebuiBrowserBridgeProof(current.secret, nonce, current.keyId);
  }

  /**
   * The current `keyId`, or `undefined` when the surface is off.
   *
   * Surfaced separately from `keyId` for callers that want it alongside the
   * cipher without juggling the `undefined` case twice.
   */
  currentKeyId(): string | undefined {
    return this.current?.keyId;
  }

  /**
   * The public id of this surface's installation key.
   *
   * Public: it is named on every challenge, so the extension knows what to
   * sign with. It is derived from the surface rather than random so the host
   * finds the same entry again on the next start.
   */
  get installationKeyId(): string {
    return webuiBrowserBridgeInstallationKeyId(this.surface);
  }

  /**
   * Make sure this surface has an installation key, minting one if not.
   *
   * Called from every enable and restore path, so switching a surface on is
   * what provisions the key the person pastes into the extension. The key is
   * written to the OS secure store and nowhere else — never a file, a log line
   * or an error message.
   */
  async ensureInstallationKey(): Promise<void> {
    if (this.installationKeySecret) return;
    const existing = await this.readFromStore(this.installationKeyId);
    if (existing && existing.length === WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES) {
      this.installationKeySecret = existing;
      return;
    }
    if (!(await this.credentialStore.isAvailable())) {
      throw new BrowserCredentialStoreUnavailableError(
        "the OS secure credential store is not available",
        `cannot provision the installation key for "${this.surface}"`,
      );
    }
    const secret = this.randomBytesSource(WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES);
    try {
      await this.credentialStore.save(this.installationKeyId, secret);
    } catch (error) {
      if (error instanceof BrowserCredentialStoreUnavailableError) throw error;
      throw new BrowserCredentialStoreUnavailableError(
        `credential store refused the "${this.surface}" installation key`,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.installationKeySecret = secret;
    this.savedAt.set(this.installationKeyId, Date.now());
  }

  /** Read the installation key from the store, caching it in memory. */
  private async loadInstallationKey(): Promise<Uint8Array | undefined> {
    if (this.installationKeySecret) return this.installationKeySecret;
    const stored = await this.readFromStore(this.installationKeyId);
    if (stored && stored.length === WEBUI_BROWSER_BRIDGE_INSTALLATION_KEY_BYTES) {
      this.installationKeySecret = stored;
      return stored;
    }
    return undefined;
  }

  /**
   * The installation key, for the person's own Settings surface to display.
   *
   * This is the ONE place the key crosses from the secure store to anything a
   * UI can see, and it is deliberately narrow: the caller is the person's own
   * WebUI tab, and the key's purpose is to defeat a local *process*, not the
   * person holding the paste buffer. Returns `undefined` when the surface has
   * no key yet — an unprovisioned surface has nothing to paste.
   *
   * The bytes are returned as base64 so they can be copied through a text
   * field; nothing else in the host ever renders them.
   */
  async installationKeyForDisplay(): Promise<WebuiBrowserBridgeInstallationKeyView | undefined> {
    const secret = await this.loadInstallationKey();
    if (!secret) return undefined;
    return {
      surface: this.surface,
      keyId: this.installationKeyId,
      key: Buffer.from(secret).toString("base64"),
      fingerprint: fingerprint(secret),
    };
  }

  /** Sign a proof with the installation key, as the extension would. */
  async signInstallationKeyProof(nonce: string): Promise<string> {
    const secret = await this.loadInstallationKey();
    if (!secret) {
      throw new Error(
        `browser bridge for "${this.surface}" has no installation key to sign with`,
      );
    }
    return signWebuiBrowserBridgeProof(secret, nonce, this.installationKeyId);
  }

  /**
   * Encrypts the current credential for delivery to the extension.
   *
   * Returns `undefined` when the surface is off: a switch that is off has
   * no credential, and the existing admission path already refuses to
   * accept connections in that state, so the session can skip this and
   * proceed to refuse the handshake.
   *
   * The cipher carries the host's ephemeral public key as well as the
   * encrypted credential, so the extension can derive the same AES key on
   * its side. The `randomBytes` override is for tests that pin the salt
   * and IV exactly.
   */
  async sealCredentialForExtension(
    peerPublicKey: WebuiBrowserBridgeEcdhPublicKey,
    options: { readonly randomBytes?: (length: number) => Uint8Array } = {},
  ): Promise<
    | { readonly kind: "off" }
    | {
        readonly kind: "sealed";
        readonly keyId: string;
        readonly publicKey: WebuiBrowserBridgeEcdhPublicKey;
        readonly salt: string;
        readonly payload: string;
      }
  > {
    const current = this.current;
    if (!current) return { kind: "off" };
    const cipher = await sealWebuiBrowserBridgePairingCredential(current.secret, peerPublicKey, {
      randomBytes: options.randomBytes,
    });
    return {
      kind: "sealed",
      keyId: current.keyId,
      publicKey: cipher.publicKey,
      salt: cipher.salt,
      payload: cipher.payload,
    };
  }

  /**
   * Adopt the credential the store already holds, or mint one if there is none.
   *
   * This is the **startup** path, and it is different from `enable()` on
   * purpose. A host that restarts must keep the credential the extension still
   * holds: minting a fresh one would leave the two holding different secrets,
   * and the extension could never answer a challenge the host issued. The
   * extension stores its credential in `chrome.storage.local` and keeps it
   * across restarts, so the host has to keep its side too.
   *
   * `enable()` remains the **toggle** path: turning a switch off revokes the
   * credential and removes it from the store, so the next `enable()` finds
   * nothing to restore and mints a fresh credential, which is what the ADR
   * asks for.
   */
  async restore(): Promise<BrowserBridgePairingMetadata> {
    // The installation key lives in the same store, so it MUST be excluded
    // here: without this filter a host that provisioned the key most recently
    // would adopt the installation key as its pairing credential, and every
    // extension would then be proving against the wrong secret.
    const references = (await this.credentialStore.list()).filter(
      (reference) => reference.keyId !== this.installationKeyId,
    );
    // The newest reference wins: the store keeps one entry per credential and
    // a rotation leaves the old one behind only if the delete failed.
    const newest = [...references].sort((left, right) => right.savedAt - left.savedAt)[0];
    if (newest) {
      const secret = await this.credentialStore.load(newest.keyId);
      if (secret) {
        this.current = { keyId: newest.keyId, secret };
        this.savedAt.set(newest.keyId, newest.savedAt);
        // A restart keeps the installation key the extension still holds, and
        // mints one only when none was ever stored.
        await this.ensureInstallationKey();
        return {
          keyId: newest.keyId,
          fingerprint: newest.fingerprint,
          savedAt: newest.savedAt,
        };
      }
    }
    return await this.enable();
  }

  /**
   * Turn the switch on (or replace an existing credential). Throws if the
   * credential store is unavailable: the ADR forbids falling back to a
   * plaintext write. The new credential is fresh: a different key id and a
   * different secret. The previous credential, if any, is revoked.
   */
  async enable(): Promise<BrowserBridgePairingMetadata> {
    // Provision the installation key *before* the credential: the credential
    // is what a peer receives, and a peer may only receive it after proving
    // the installation key, so the key has to exist the moment the surface is
    // switched on.
    await this.ensureInstallationKey();
    const { keyId, secret } = generateBridgeCredential();
    try {
      await this.credentialStore.save(keyId, secret);
    } catch (error) {
      if (error instanceof BrowserCredentialStoreUnavailableError) throw error;
      throw new BrowserCredentialStoreUnavailableError(
        `credential store refused the new "${this.surface}" credential`,
        error instanceof Error ? error.message : String(error),
      );
    }
    // Revoke any prior credential. We do this AFTER persisting the new one
    // so a store hiccup that succeeds at deleting but fails at writing leaves
    // the surface in a "switched on with a known credential" state rather
    // than "switched on with no way to verify".
    if (this.current) {
      const previous = this.current;
      this.savedAt.delete(previous.keyId);
      try {
        await this.credentialStore.delete(previous.keyId);
      } catch {
        // Idempotent: even if delete fails the in-memory state is updated.
      }
    }
    this.current = { keyId, secret };
    this.savedAt.set(keyId, Date.now());
    // Forget any outstanding challenge for the previous credential — a
    // challenge for the old key id can never be answered now.
    this.outstandingNonces.clear();
    return { keyId, fingerprint: fingerprint(secret), savedAt: this.savedAt.get(keyId)! };
  }

  /**
   * Turn the switch off. Revokes the credential, deletes it from the store,
   * forgets every outstanding challenge and ensures no later presentation of
   * the old credential can succeed (because `current` is now undefined, the
   * verifier refuses). Idempotent.
   *
   * The installation key is deliberately **kept**. It is bound to the browser,
   * not to this switch, and destroying it would force the person to re-paste
   * the key into the extension's options page every time they toggle the
   * switch — a recovery loop with no security benefit, since the credential it
   * authorises has just been revoked anyway. It is cleared only when the
   * extension's own storage is cleared on that browser.
   */
  async disable(): Promise<void> {
    const prior = this.current;
    this.current = undefined;
    this.outstandingNonces.clear();
    if (prior) {
      this.savedAt.delete(prior.keyId);
      try {
        await this.credentialStore.delete(prior.keyId);
      } catch {
        // Idempotent.
      }
    }
  }
}

/** A typed signal that the pairing refuses because the switch is off. */
export class PairingSwitchedOffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingSwitchedOffError";
  }
}

/** Encode bytes as base64url with no padding — the challenge's nonce format. */
function bufferToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
