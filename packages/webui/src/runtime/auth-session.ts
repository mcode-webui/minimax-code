// The WebUI's sole OAuth core, active lease, refresh timer and invalidation
// propagation. Split out of `server/assembly.ts` (plan section 7.1).
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

export function createWebuiAuthSession(
  options: WebuiAuthSessionOptions,
): WebuiAuthSession {
  // The account credential is read from the same directory the installed
  // client uses, so a browser session never has to sign in again. See
  // `auth-context.ts` for the store's layout and the deliberate differences
  // from the terminal client's reader.
  const authContext = createWebuiAuthContextReader(options.dataDir);
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
          requiredScopes: MCODE_OAUTH_SCOPES,
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
  const scheduleAuthRefresh = (lease: NonNullable<typeof activeLease>) => {
    if (authRefreshTimer) clearTimeout(authRefreshTimer);
    const delay = Math.max(1_000, lease.expiresAtMs - Date.now() - 60_000);
    authRefreshTimer = setTimeout(() => {
      void refreshOAuthAuthContext().catch(() => undefined);
    }, delay);
    authRefreshTimer.unref?.();
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
        // A concurrent TUI login may have already replaced the lease.
      }
    }
    if (disposed || refreshVersion !== requestVersion) return;
    const lease = await quotaOauthCore.getAccessToken({
      requiredScopes: MCODE_OAUTH_SCOPES,
      minValidityMs: 60_000,
    });
    if (disposed || refreshVersion !== requestVersion) return;
    activeLease = lease;
    const identity = await usageQuota
      .resolveAccountIdentity(lease.accessToken)
      .catch(() => undefined);
    if (
      disposed ||
      refreshVersion !== requestVersion ||
      activeLease?.accessToken !== lease.accessToken
    )
      return;
    authContext.setOAuthAuthContext({
      accessToken: lease.accessToken,
      ...(lease.loginEpoch ? { loginEpoch: lease.loginEpoch } : {}),
      ...(identity ?? {}),
    });
    scheduleAuthRefresh(lease);
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
    // OAuth is the canonical login store shared with `mcode login`; the
    // cli-auth projection is only an optional source of additional identity data.
    await refreshOAuthAuthContext().catch(() => undefined);
  };
  const watch = (): void => {
    if (disposed) return;
    stopAuthWatch = quotaOauthCore.watch((status) => {
      if (
        status.status === "anonymous" ||
        status.status === "logging_out" ||
        status.status === "logout_pending"
      ) {
        activeLease = undefined;
        authContext.setOAuthAuthContext(undefined);
        if (authRefreshTimer) clearTimeout(authRefreshTimer);
        authRefreshTimer = undefined;
        return;
      }
      void refreshOAuthAuthContext().catch(() => undefined);
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
    authContext.setOAuthAuthContext(undefined);
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
