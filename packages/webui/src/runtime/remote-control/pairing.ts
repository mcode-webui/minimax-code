// The pairing client — the WebUI's side of the archon_biz binding HTTP pipeline.
//
// The bridge's `PairingClient` is host-neutral: it needs an origin, a bearer, a user id, a device
// id and a platform, and it sends nothing else. This module supplies those five from the WebUI's
// own stores.
//
// ## Who signs the binding
//
// Desktop splits the binding HTTP across two processes: the renderer owns it because only the
// renderer's axios can sign `GET /desktop/bindings`, and the main process owns the WebSocket.
// The WebUI keeps the same split in *shape* — the operation `applyRemoteControlCredentials`
// carries a browser-signed ticket down to the service, and the service holds the socket — but the
// signer is the **service**, not the browser document.
//
// The reason is the credential's location. The WebUI's account token lives in the service's
// OAuth store (`cli-auth/<scope>/local-runtime.auth.json`); the browser document never receives
// it and must not, because the browser may be running on another machine and the WebUI's own
// transport is a local loopback socket. So the service signs, and it signs with the same first-
// party pipeline the quota and check-in clients already use (`signing.ts`).
//
// The ticket never leaves the service: it goes from `PairingClient` into the bridge's credential
// provider, is consumed by the WebSocket handshake, and is never persisted, logged or returned to
// the browser. The bridge's `state.json` holds the device id, the binding id and the account id —
// never a ticket, never a token.
//
// ## The bearer
//
// The bearer is the service's **OAuth lease**, not the legacy cli-auth projection.
//
// Desktop's main process cannot do this: under Shared OAuth it fails closed on the legacy SSO
// token projection (`getJwt: () => ''`), so Desktop's own pairing-code request cannot be signed
// from the main process. The WebUI's service does hold a first-party lease — the one the quota and
// the daily check-in sign with — so it signs the pairing pipeline with that, and the account id
// travels in the `user_id` common-param the server cross-checks against the token.
import { hostname } from "node:os";

import { resolveAuthScope, readWebuiAuthContext } from "../auth-context.js";
import { PairingClient } from "./bridge/pairing-client.js";
import type { RcLogger } from "./bridge/types.js";

/** Mirrors `@mavis/config`'s unions without adding a dependency. */
type MavisRegion = "cn" | "en";
type MavisBuildEnv = "dev" | "test" | "staging" | "prod";

/**
 * The matrix gateway origins, copied from `check-in.ts` (which copied them from the TUI's
 * public gateway). The remote-control endpoints live under the same
 * `/minimax-cloud/api/v1/remote-control` prefix as the other first-party routes.
 */
const MATRIX_ORIGINS: Readonly<
  Record<MavisRegion, Readonly<Record<MavisBuildEnv, string>>>
> = {
  cn: {
    dev: "https://matrix-test.example.invalid",
    test: "https://matrix-test.example.invalid",
    staging: "https://matrix-pre.example.invalid",
    prod: "https://agent.minimaxi.com",
  },
  en: {
    dev: "https://matrix-overseas-test.example.invalid",
    test: "https://matrix-overseas-test.example.invalid",
    staging: "https://matrix-overseas-pre.example.invalid",
    prod: "https://agent.minimax.io",
  },
};

function isRegion(value: string): value is MavisRegion {
  return value === "cn" || value === "en";
}

function isBuildEnv(value: string): value is MavisBuildEnv {
  return value === "dev" || value === "test" || value === "staging" || value === "prod";
}

/**
 * The origin the binding pipeline talks to.
 *
 * The scope comes from the same store the credential lives in, so the origin and the token
 * cannot disagree about which environment this installation is in. Without a scope the
 * installation is not configured for the cloud at all, and the caller gets `undefined` rather
 * than a request to a placeholder origin.
 */
export function resolveRemoteControlOrigin(dataDir: string): string | undefined {
  const scope = resolveAuthScope(dataDir);
  if (!scope) return undefined;
  const region = isRegion(scope.region) ? scope.region : undefined;
  const buildEnv = isBuildEnv(scope.buildEnv) ? scope.buildEnv : undefined;
  if (!region || !buildEnv) return undefined;
  return MATRIX_ORIGINS[region][buildEnv];
}

/** The producer platform label the bridge sends in the pairing-code request. */
export function resolveRemoteControlPlatform(): "darwin" | "win32" | "linux" {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

/**
 * The account credential the pairing pipeline signs with.
 *
 * `accessToken` is the bearer; `realUserID` is the account the server cross-checks it against.
 */
export interface RemoteControlCredential {
  readonly accessToken?: string;
  readonly realUserID?: string;
}

/**
 * How long a cached credential is trusted before it is refreshed.
 *
 * The bridge's pairing poll runs once a second while a pairing code is outstanding and the
 * bridge reads the bearer synchronously, so the cache is refreshed ahead of its expiry rather
 * than at it.
 */
const CREDENTIAL_TTL_MS = 60_000;

/**
 * How soon a failed refresh is retried.
 *
 * A renewal that failed may have left the cached bearer as the only one this
 * host has, so the retry is sooner than the renewal of a healthy credential.
 */
const CREDENTIAL_RETRY_INTERVAL_MS = 10_000;

/**
 * The credential the pairing pipeline signs with.
 *
 * The bridge's `PairingClient` reads the bearer and the account id synchronously, so both live
 * here: the owner refreshes the source before every operation that can reach the network, and
 * {@link RemoteControlCredentialSource.refreshWhenStale} refreshes it in the background once the
 * cached credential has aged out — so the bridge's own poll never signs with a stale token.
 *
 * The token is never logged and never leaves the service: the browser receives the pairing code,
 * not the credential.
 */
export class RemoteControlCredentialSource {
  private credential: RemoteControlCredential | undefined;
  private refreshedAtMs = 0;
  private attemptedAtMs = 0;
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly read: () => Promise<RemoteControlCredential | undefined>,
    private readonly onFailure?: (message: string) => void,
  ) {}

  /** The bearer for the next request; empty when nobody is signed in. */
  get token(): string {
    return this.credential?.accessToken ?? "";
  }

  /** The account id the server cross-checks the bearer against. */
  get userId(): string | undefined {
    return this.credential?.realUserID;
  }

  /**
   * Reads the credential and waits for it.
   *
   * A read that fails does **not** clear the credential. The bearer is a lease:
   * a refresh that cannot renew it — a network hiccup, a lease that is mid
   * rotation — is not a sign-out, and clearing the good token would turn a
   * transient failure into "no user JWT available". The bridge's pairing poll
   * treats that answer as fatal and tears the pairing session down, which
   * strands a phone that was about to bind.
   *
   * A real sign-out is not silent: it invalidates the lease, the server answers
   * 401, and the pairing pipeline says so.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      return;
    }
    const pending = (async () => {
      this.attemptedAtMs = Date.now();
      try {
        const next = await this.read();
        if (!next) {
          this.onFailure?.("the account credential could not be read");
          return;
        }
        // The account id is part of the identity the binding is checked against:
        // a refresh that cannot resolve it must not erase the one this host
        // already knows, or the identity would flip under the pairing poll.
        const realUserID = next.realUserID ?? this.credential?.realUserID;
        this.credential = {
          ...(next.accessToken ? { accessToken: next.accessToken } : {}),
          ...(realUserID ? { realUserID } : {}),
        };
        this.refreshedAtMs = Date.now();
      } catch (error) {
        this.onFailure?.(error instanceof Error ? error.message : String(error));
      }
    })();
    this.refreshing = pending;
    try {
      await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = undefined;
    }
  }

  /**
   * Refreshes in the background once the cached credential has aged out.
   *
   * A failed refresh is retried sooner than a successful one: the cached bearer
   * may still be the only one this host has.
   */
  refreshWhenStale(): void {
    if (this.refreshing) return;
    const now = Date.now();
    if (this.refreshedAtMs > 0 && now - this.refreshedAtMs < CREDENTIAL_TTL_MS) return;
    if (now - this.attemptedAtMs < CREDENTIAL_RETRY_INTERVAL_MS) return;
    void this.refresh();
  }
}

export interface RemoteControlPairingOptions {
  /** The WebUI's data directory; the scope is read from it. */
  readonly dataDir: string;
  /** This machine's stable device id, owned by the bridge's identity store. */
  readonly getDeviceId: () => string;
  /** The producer version the pairing request reports. */
  readonly appVersion: string;
  /** The credential the pipeline signs with. */
  readonly credential: RemoteControlCredentialSource;
  readonly logger?: RcLogger;
  /** Overrides the ambient fetch; a test injects its own. */
  readonly fetchImpl?: typeof fetch;
  /** Overrides the host name the pairing request reports. */
  readonly getDeviceName?: () => string | undefined;
}

/**
 * Builds the bridge's pairing client.
 *
 * The bearer and the user id are read from the credential source on every call rather than
 * captured once: the lease is refreshed in place by the OAuth core, and a captured token would
 * be a token that silently expires.
 */
export function createRemoteControlPairingClient(
  options: RemoteControlPairingOptions,
): PairingClient {
  return new PairingClient({
    baseUrl: resolveRemoteControlOrigin(options.dataDir) ?? "https://agent.minimaxi.com",
    getJwt: () => {
      options.credential.refreshWhenStale();
      return options.credential.token;
    },
    getUserId: () => {
      options.credential.refreshWhenStale();
      return options.credential.userId;
    },
    getDeviceId: options.getDeviceId,
    getPlatform: resolveRemoteControlPlatform,
    getAppVersion: () => options.appVersion,
    getDeviceName: options.getDeviceName ?? (() => hostname() || undefined),
    getExtraHeaders: () => ({}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/**
 * The credential the legacy cli-auth projection carries, if it carries one.
 *
 * The projection is the *older* store: it is a second place an account id can live, and the
 * server cross-checks the `user_id` common-param against the token's own subject. It is read
 * only as a fallback for the account id — the bearer always comes from the OAuth lease.
 */
export function readLegacyAuthIdentity(dataDir: string): string | undefined {
  return readWebuiAuthContext(dataDir)?.realUserID;
}
