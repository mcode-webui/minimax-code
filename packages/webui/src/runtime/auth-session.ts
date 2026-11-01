// The WebUI's sole OAuth core, active lease, refresh timer and invalidation
// propagation. Split out of `runtime/assembly.ts`.
//
// The process-local host, the usage-quota client, the account-login session,
// the daily check-in and the mcode-tools broker all read the same credential:
// one `MCodeOAuthCore` over the shared `mcode login` store. Keeping one core,
// one active lease and one refresh timer in one module is what makes that a
// fact rather than a convention — a second owner is impossible to construct
// without editing this file.
//
// It owns the credential reader, the OAuth core, the usage-quota client, the
// refresh timer and the auth watch. The assembly composes it and injects the
// pieces; nothing here knows about the network service, the harness host or
// the browser.
//
// The projection rules are the Desktop's. The Desktop publishes its account
// into its runtime through one module (`modules/auth/runtime-projection.js` in
// the installed app) and that module's rules are what this one follows:
//
//   * Projections are serialized. Two mutations — a renewal landing while a
//     sign-out lands — must not interleave, or the runtime keeps a credential
//     the account no longer holds.
//   * A projection re-reads the lease after it resolves the account identity
//     and abandons the attempt when the lease moved underneath it. The
//     identity belongs to the token it was resolved with; publishing it
//     against a different token publishes somebody else's account.
//   * A failed projection clears the runtime's credential. Leaving the last
//     good one in place is how a signed-out account keeps talking to the
//     provider.
//   * A rejected credential is recovered, not just dropped: the core is asked
//     what to do with it, and a renewal that the core can still serve is
//     served (`retry`) while a credential the core considers gone ends the
//     session (`logout`).
//   * The watch projects the current lease on every status change, except the
//     two statuses that only mean "the core is working on it" (`refreshing`,
//     `expired`), and it refuses to publish a lease older than the status that
//     triggered it.

import {
  createAuthNamespace,
  createCredentialStore,
  HttpOAuthClient,
  MCodeOAuthCore,
  MCODE_OAUTH_SCOPES,
  migrateLegacyAuthNamespace,
  resolveMCodeOAuthEndpointConfig,
} from "@mavis/oauth-core";

import {
  createWebuiAuthContextReader,
  type WebuiAuthContextReader,
} from "./auth-context.js";
import { UsageQuotaClient } from "./usage-quota.js";

export interface WebuiAuthSessionOptions {
  readonly dataDir: string;
  readonly region: "cn" | "en";
  readonly buildEnv: "dev" | "test" | "staging" | "prod";
}

export interface WebuiAuthSession {
  /** The credential getter/invalidator pair the runtime host consumes. */
  readonly authContext: WebuiAuthContextReader;
  /** The one OAuth core shared with `mcode login` and the account-login session. */
  readonly oauthCore: MCodeOAuthCore;
  /** The usage-quota client the assembly exposes; it leases through `oauthCore`. */
  readonly usageQuota: UsageQuotaClient;
  /** Propagates a rejected token to the runtime host and refreshes the lease. */
  readonly invalidateAuth: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void;
  /**
   * Reads the first OAuth lease. Call before the harness host is built so the
   * managed-provider bearer is present at the agent preflight.
   */
  readonly start: () => Promise<void>;
  /**
   * Arms the auth watch and refreshes once. Call after the harness host exists,
   * so a watch callback never runs before there is a host to observe it.
   */
  readonly watch: () => void;
  /** Stops the auth watch and clears the refresh timer. */
  readonly dispose: () => void;
}

/** How many times a projection may re-read the lease before it gives up. */
const PROJECTION_ATTEMPTS = 3;

export function createWebuiAuthSession(
  options: WebuiAuthSessionOptions,
): WebuiAuthSession {
  // The credential the WebUI serves is the one this session holds: the lease
  // from the OAuth core below, and the account identity the WebUI resolves
  // for that lease. Nothing is read from the terminal client's store.
  const authContext = createWebuiAuthContextReader();
  const quotaNamespace = createAuthNamespace({
    dataDir: options.dataDir,
    buildEnv: options.buildEnv,
    region: options.region,
  });
  const quotaOauthCore = new MCodeOAuthCore({
    namespace: quotaNamespace,
    credentialStore: createCredentialStore({
      authHome: quotaNamespace.namespaceHome,
    }),
    oauthClient: new HttpOAuthClient(
      resolveMCodeOAuthEndpointConfig(process.env, {
        buildEnv: options.buildEnv,
        region: options.region,
      }),
    ),
    initialize: () => migrateLegacyAuthNamespace(quotaNamespace),
  });
  const usageQuota = new UsageQuotaClient({
    tokenProvider: async () => {
      try {
        const lease = await quotaOauthCore.getAccessToken({
          requiredScopes: [...MCODE_OAUTH_SCOPES],
          minValidityMs: 30_000,
        });
        return {
          accessToken: lease.accessToken,
          realUserID: authContext.getter()?.realUserID,
        };
      } catch {
        return undefined;
      }
    },
    region: options.region,
    buildEnv: options.buildEnv,
  });
  let activeLease: Awaited<ReturnType<typeof quotaOauthCore.getAccessToken>> | undefined;
  let authRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let stopAuthWatch: (() => void) | undefined;
  let disposed = false;
  let refreshVersion = 0;
  // The projection queue. Every publish goes through it, so a renewal that
  // lands while a sign-out lands cannot interleave with it.
  let projectionTail: Promise<void> = Promise.resolve();
  const scheduleAuthRefresh = (lease: NonNullable<typeof activeLease>) => {
    if (authRefreshTimer) clearTimeout(authRefreshTimer);
    const delay = Math.max(1_000, lease.expiresAtMs - Date.now() - 60_000);
    authRefreshTimer = setTimeout(() => {
      void refreshOAuthAuthContext().catch(() => undefined);
    }, delay);
    authRefreshTimer.unref?.();
  };

  /**
   * Publishes the current lease and its account identity into the runtime.
   *
   * The identity is resolved against the token it was resolved with, so the
   * lease is re-read afterwards: if the lease moved, the identity belongs to a
   * credential that is no longer current and the attempt is repeated.
   */
  const projectLease = async (): Promise<void> => {
    if (disposed) return;
    const requestVersion = refreshVersion;
    for (let attempt = 0; attempt < PROJECTION_ATTEMPTS; attempt += 1) {
      const lease = await quotaOauthCore.getAccessToken({
        requiredScopes: [...MCODE_OAUTH_SCOPES],
        minValidityMs: 0,
      });
      const identity = await usageQuota
        .resolveAccountIdentity(lease.accessToken)
        .catch(() => undefined);
      const current = await quotaOauthCore.getAccessToken({
        requiredScopes: [...MCODE_OAUTH_SCOPES],
        minValidityMs: 0,
      });
      if (
        current.generation !== lease.generation ||
        current.accessToken !== lease.accessToken
      ) {
        // The lease moved while the identity was being resolved. The identity
        // belongs to the previous token, so it is not published.
        continue;
      }
      if (disposed || refreshVersion !== requestVersion) return;
      activeLease = lease;
      authContext.setAuthContext({
        accessToken: lease.accessToken,
        ...(lease.loginEpoch ? { loginEpoch: lease.loginEpoch } : {}),
        ...(identity ?? {}),
      });
      scheduleAuthRefresh(lease);
      return;
    }
    throw new Error("The account changed while its identity was being resolved.");
  };

  const clearProjection = (): void => {
    activeLease = undefined;
    if (authRefreshTimer) clearTimeout(authRefreshTimer);
    authRefreshTimer = undefined;
    authContext.setAuthContext(undefined);
  };

  const enqueueProjection = (operation: () => Promise<void>): Promise<void> => {
    const pending = projectionTail.catch(() => undefined).then(operation);
    projectionTail = pending.catch(() => undefined);
    return pending;
  };

  const refreshOAuthAuthContext = async (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ): Promise<void> => {
    if (disposed) return;
    const requestVersion = ++refreshVersion;
    if (rejectedAccessToken && activeLease?.accessToken === rejectedAccessToken) {
      try {
        await quotaOauthCore.handleUnauthorized({
          generation: activeLease.generation,
          ...(loginEpoch ?? activeLease.loginEpoch
            ? { loginEpoch: loginEpoch ?? activeLease.loginEpoch }
            : {}),
        });
      } catch {
        // A concurrent login may have already replaced the lease.
      }
    }
    if (disposed || refreshVersion !== requestVersion) return;
    await enqueueProjection(async () => {
      if (disposed || refreshVersion !== requestVersion) return;
      try {
        await projectLease();
      } catch {
        // A projection that cannot be made leaves the runtime without a
        // credential. Keeping the last good one would let a signed-out
        // account keep talking to the provider.
        if (!disposed && refreshVersion === requestVersion) clearProjection();
      }
    });
  };
  const invalidateAuth = (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ): void => {
    if (disposed) return;
    authContext.invalidator(rejectedAccessToken, loginEpoch);
    void refreshOAuthAuthContext(rejectedAccessToken, loginEpoch).catch(() => undefined);
  };
  const start = async (): Promise<void> => {
    if (disposed) return;
    // The OAuth core is the WebUI's credential store; the terminal client's
    // private projection is not consulted.
    await refreshOAuthAuthContext().catch(() => undefined);
  };
  const watch = (): void => {
    if (disposed) return;
    stopAuthWatch = quotaOauthCore.watch((status) => {
      // `refreshing` and `expired` mean the core is working on the
      // credential, not that the credential is gone.
      if (status.status === "refreshing" || status.status === "expired") return;
      if (
        status.status === "anonymous" ||
        status.status === "logging_out" ||
        status.status === "logout_pending"
      ) {
        enqueueProjection(async () => clearProjection()).catch(() => undefined);
        return;
      }
      void quotaOauthCore
        .getAccessToken({ requiredScopes: [...MCODE_OAUTH_SCOPES], minValidityMs: 0 })
        .then((lease) => {
          // The status that triggered this may already be superseded.
          if (lease.generation < status.generation) return;
          return refreshOAuthAuthContext();
        })
        .catch(() => {
          void refreshOAuthAuthContext().catch(() => undefined);
        });
    });
    void refreshOAuthAuthContext().catch(() => undefined);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    refreshVersion += 1;
    stopAuthWatch?.();
    stopAuthWatch = undefined;
    if (authRefreshTimer) clearTimeout(authRefreshTimer);
    authRefreshTimer = undefined;
    activeLease = undefined;
    authContext.setAuthContext(undefined);
  };
  return {
    authContext,
    oauthCore: quotaOauthCore,
    usageQuota,
    invalidateAuth,
    start,
    watch,
    dispose,
  };
}