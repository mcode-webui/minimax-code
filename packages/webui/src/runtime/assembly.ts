// Owns one process-local runtime host per WebUI service.
//
// The WebUI does not import `packages/tui` (ADR 0003), and does not drive the
// CLI binary (ADR 0001); it builds directly on the harness layer the terminal
// client uses (`@mavis/local-runtime-v2`).
//
// This module is the composition root only. It creates and wires the process
// resources and injects them into the harness host and the network service; it
// embeds no OAuth state machine (that is `auth-session.ts`) and no close
// ordering or startup-failure cleanup (that is `lifecycle.ts`). The one
// credential core, its lease and refresh timer, the mcode-tools broker and the
// browser provider are owned by the modules this file calls.
//
// `runtimeOwnerKind` is `"webui"`: the WebUI is a declared client identity in
// `local-runtime/src/runtime/runtime-owner-policy.ts`, not a borrowed `tui` row.
// The row decides wiring and turn behaviour in one place, so the WebUI states
// what it is instead of copying the terminal client's answers and inheriting
// its drift. It also no longer sets `capabilityProfile: "cli"`, which the
// `webui` row accounts for directly. The decision record is
// `docs/webui/webui-client-identity-plan.md`.
//
// The remaining fields mirror the documented call sites:
//
//   * `packages/tui/src/runtime/embedded-host.ts` — the surface owner, mode
//     and capability projection (lines 85–93).
//   * `packages/tui/src/runtime/lifecycle.ts:456-460` — the conditional
//     `startupExecutionPolicy: 'quarantined'`. The CLI applies it per
//     surface; ADR 0002 and assembly step 6 of `docs/webui-v1-scope.md`
//     require the WebUI to set it unconditionally.
//
// The factory is injectable so the assembly can be unit-tested without
// standing up the full host. The default is the real local-runtime-v2
// factory; tests inject a stub that records the options and reports
// the policy's observable effect without driving the host.

import { getDefaultLocalRuntimeConfig } from "@mavis/local-runtime-v2";
import type { CreateLocalRuntimeHostOptions } from "@mavis/local-runtime-v2/process-local";
import { MCODE_OAUTH_SCOPES } from "@mavis/oauth-core";

import { type WebuiAuthContext } from "./auth-context.js";
import { createWebuiAuthSession } from "./auth-session.js";
import { createWebuiRuntimeLifecycle } from "./lifecycle.js";
import { createWebuiAccountLoginSession } from "./account-login.js";
import { createHarnessPortFromHost } from "./harness/adapter.js";
import type { WebuiRuntimeCliService } from "./harness/host-contract.js";
import type { WebuiHarnessPort } from "./port.js";
import { configureWebuiRuntimeEnvironment } from "./runtime-environment.js";
import { DailyCheckinClient } from "./check-in.js";
import {
  createWebuiAuthLeaseSession,
  prepareWebuiMcodeToolsIntegration,
  type WebuiMcodeToolsIntegrationDependencies,
  type WebuiMcodeToolsReadiness,
} from "./mcode-tools.js";

/**
 * Minimal host contract the assembly needs from whatever factory
 * produces it. The shape matches what
 * `createLocalRuntimeHostV2` returns (its `apiHost.close()` plus
 * `dataDir`); `appVersion` is optional because the v2 host does not
 * echo the input option back.
 */
export interface WebuiAssembledHost {
  readonly apiHost: { close(): Promise<void> };
  readonly dataDir: string;
  readonly appVersion?: string;
  readonly invalidateAuth: () => void;
  readonly getUsageQuota: (request?: {
    readonly forceRefresh?: boolean;
  }) => Promise<import("../shared/contracts/usage-quota.js").WebuiUsageQuotaResult>;
  readonly getSigninPanel: () => Promise<import("../shared/contracts/account.js").WebuiSigninPanelView>;
  readonly claimSignin: () => Promise<import("../shared/contracts/account.js").WebuiClaimSigninView>;
  /**
   * Account login (device authorization) over the same `MCodeOAuthCore` the
   * quota lease reads, plus the sign-out that removes the credential. The
   * core is assembly-owned (never produced by the runtime factory), so these
   * are enrichment slots like `getUsageQuota`, not harness capabilities.
   */
  readonly beginAccountLogin: () => Promise<import("../shared/contracts/account.js").WebuiAccountLoginView>;
  readonly getAccountLoginStatus: () => Promise<import("../shared/contracts/account.js").WebuiAccountLoginView>;
  readonly cancelAccountLogin: () => Promise<void>;
  readonly signOutAccount: () => Promise<{ readonly status: string; readonly generation: number }>;
  /**
   * Conversation compaction is opt-in on the live harness: `local-runtime-v2`
   * exposes `CliService.requestCompaction?` and the WebUI host surface
   * turns its absence into `runtime host does not expose requestCompaction`.
   * Kept as a `?` here so a runtime that does not implement compaction
   * still type-checks. Production hosts that do implement it will satisfy
   * this slot and the service's `runCommand -> /compact` path will work.
   */
  requestCompaction?(request: {
    readonly name: string;
    readonly id: string;
    readonly reason: "ui_request";
    readonly customInstructions?: string;
  }): Promise<Record<string, unknown>>;
  readonly cliService?: WebuiRuntimeCliService;
}

// The browser provider types and the adoption rule live in
// `runtime/browser-provider.ts` (plan §7.1); they are re-exported here so the
// runtime's public surface is unchanged.
export {
  adoptWebuiBrowserProvider,
  type WebuiBrowserAdapter,
  type WebuiBrowserProvider,
  type WebuiBrowserProviderBinding,
  type WebuiBrowserToolExposure,
} from "./browser-provider.js";
import { adoptWebuiBrowserProvider } from "./browser-provider.js";
import type {
  WebuiBrowserAdapter,
  WebuiBrowserProvider,
  WebuiBrowserToolExposure,
} from "./browser-provider.js";

/**
 * Structural shape of the options the WebUI assembly forwards to the
 * harness factory. Mirrors the relevant fields of
 * `CreateLocalRuntimeHostOptions` (declared in
 * `packages/local-runtime/src/runtime/host-factory-types.ts:103` and
 * extended by `packages/local-runtime-v2/src/local/host-contract.ts:56`).
 *
 * Defining the type locally lets the assembly type-check against the
 * real field set without depending on the harness package's exported
 * type, whose transitive imports (vendored pi-mono) collapse in this
 * repo's typecheck (see the v7 brief's item 3). The factory signature
 * still uses the upstream type so production wiring is unchanged.
 */
export interface WebuiForwardedRuntimeHostOptions {
  readonly dataDir: string;
  readonly appVersion?: string;
  readonly runtimeOwnerKind: "webui";
  readonly runtimeMode: "clean";
  readonly startupExecutionPolicy: "quarantined";
  readonly capabilities: {
    readonly cliEmbedded: true;
    readonly questionnaireReply: true;
    readonly permissionPrompt: true;
    readonly elicitation: true;
  };
  readonly enableLiveMcp: true;
  readonly configGetter: () => ReturnType<typeof getDefaultLocalRuntimeConfig>;
  /**
   * Assembly step 3 of `docs/webui-v1-scope.md`. Managed MiniMax login sends no
   * API key — the credential is an OAuth access token — so the runtime resolves
   * it through this pair, and the harness defaults both to undefined when they
   * are absent. Absent them, every turn on a managed provider fails at the
   * agent preflight with "managed OAuth bearer is not synced".
   */
  readonly authContextGetter: () => WebuiAuthContext | undefined;
  readonly authContextInvalidator: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void;
  readonly browserAdapter?: WebuiBrowserAdapter;
  readonly browserToolExposure?: WebuiBrowserToolExposure;
}

/**
 * Factory signature the assembly delegates to. The default is
 * `createLocalRuntimeHostV2`; tests inject a stub that records the
 * options it received.
 */
export type WebuiRuntimeHostFactory = (
  options: CreateLocalRuntimeHostOptions,
) => Promise<
  Omit<
    WebuiAssembledHost,
    | "invalidateAuth"
    | "getUsageQuota"
    | "getSigninPanel"
    | "claimSignin"
    | "beginAccountLogin"
    | "getAccountLoginStatus"
    | "cancelAccountLogin"
    | "signOutAccount"
  >
>;

export interface CreateWebuiRuntimeHostOptions {
  /**
   * The CLI data directory (`~/.minimax` by default), shared per ADR 0006 and
   * assembly step 1 of `docs/webui-v1-scope.md`. It carries the login state,
   * the provider configuration and the session history the WebUI shows, so a
   * run that needs a clean slate has to opt into `MINIMAX_DATA_DIR` instead.
   */
  readonly dataDir: string;
  /** Build identity forwarded to the host for metric labels. */
  readonly appVersion?: string;
  /** Browser provider explicitly owned by the WebUI process, when enabled. */
  readonly browserProvider?: WebuiBrowserProvider;
  readonly browserToolExposure?: WebuiBrowserToolExposure;
  /** Defaults to the configured beta switch, but the effective runtime value is readiness-gated. */
  readonly mcodeToolsRequested?: boolean;
  readonly mcodeTools?: {
    readonly prepare?: (
      options: Parameters<typeof prepareWebuiMcodeToolsIntegration>[0],
      dependencies?: WebuiMcodeToolsIntegrationDependencies,
    ) => Promise<WebuiMcodeToolsReadiness>;
  };
  /**
   * Factory override; defaults to `createLocalRuntimeHostV2`. Tests
   * inject a stub; production callers leave it untouched.
   */
  readonly factory?: WebuiRuntimeHostFactory;
}

export interface WebuiRuntimeHost {
  readonly harnessPort: WebuiHarnessPort;
  /** The host the assembly produced; tests inspect it directly. */
  readonly host: WebuiAssembledHost;
  /** The exact options the assembly forwarded to the factory. */
  readonly forwardedOptions: WebuiForwardedRuntimeHostOptions;
  readonly mcodeTools: WebuiMcodeToolsReadiness;
  readonly invalidateAuth: () => void;
}

/**
 * Boots one process-local runtime host with the assembly step 6 owner
 * combination and the unconditionally quarantined cold-start policy.
 * Returns a `WebuiHarnessPort` the `WebuiService` can tear down in
 * the order step 13 of `docs/webui-v1-scope.md` requires.
 */
export async function createWebuiRuntimeHost(
  options: CreateWebuiRuntimeHostOptions,
): Promise<WebuiRuntimeHost> {
  const factory = options.factory ?? defaultWebuiRuntimeHostFactory;
  const baseConfig = getDefaultLocalRuntimeConfig();
  // Reflect the installed client's scope into this process's environment
  // before the host is built, so `getRuntimeRegion()` /
  // `getRuntimeBuildEnv()` / `isManagedRuntime()` see the same scope the
  // credential reader served. The CLI does this for itself
  // (`packages/tui/src/cli/environment.ts:40-72`); the WebUI has to do
  // its own because ADR 0003 forbids importing that module. The resolver
  // is a no-op when the store carries nothing and nothing is explicit in
  // the environment, so a WebUI start without a client-side login still
  // falls back to the harness defaults — `en` / `dev`,
  // `isManagedRuntime()=false` — exactly as before this step existed.
  const scope = configureWebuiRuntimeEnvironment({ dataDir: options.dataDir });
  const quotaRegion = (scope?.region ?? process.env.MAVIS_REGION ?? "en") as
    | "cn"
    | "en";
  const quotaBuildEnv = (
    scope?.buildEnv ?? process.env.MAVIS_BUILD_ENV ?? "dev"
  ) as "dev" | "test" | "staging" | "prod";
  // The one OAuth core, lease and refresh timer. It reads the shared `mcode
  // login` credential the installed client uses, so a browser session never has
  // to sign in again.
  const authSession = createWebuiAuthSession({
    dataDir: options.dataDir,
    region: quotaRegion,
    buildEnv: quotaBuildEnv,
  });
  const browser = adoptWebuiBrowserProvider(
    options.browserProvider,
    options.browserToolExposure,
  );
  let mcodeTools!: WebuiMcodeToolsReadiness;
  const lifecycle = createWebuiRuntimeLifecycle({
    disposeAuth: authSession.dispose,
    disposeMcodeTools: () => mcodeTools?.dispose(),
    closeBrowserProvider: browser.closeBrowserProvider,
  });
  const requestedMcodeTools =
    options.mcodeToolsRequested ?? baseConfig.beta?.mcodeTools === true;
  try {
    await authSession.start();
    mcodeTools = await (
      options.mcodeTools?.prepare ?? prepareWebuiMcodeToolsIntegration
    )({
      requested: requestedMcodeTools,
      dataDir: options.dataDir,
      buildEnv: quotaBuildEnv,
      region: quotaRegion,
      session: createWebuiAuthLeaseSession(
        authSession.authContext.getter,
        authSession.invalidateAuth,
      ),
      entryUrl: import.meta.url,
    });
  } catch (error) {
    try {
      await lifecycle.closeAcquiredResources();
    } catch (cleanupError) {
      if (cleanupError instanceof AggregateError)
        throw new AggregateError([error, ...cleanupError.errors], "WebUI runtime startup failed");
      throw new AggregateError([error, cleanupError], "WebUI runtime startup failed");
    }
    throw error;
  }
  const forwardedOptions: WebuiForwardedRuntimeHostOptions = {
    dataDir: options.dataDir,
    ...(options.appVersion !== undefined
      ? { appVersion: options.appVersion }
      : {}),
    runtimeOwnerKind: "webui",
    runtimeMode: "clean",
    startupExecutionPolicy: "quarantined",
    // Interaction capabilities mirror `packages/tui/src/runtime/lifecycle.ts:451-455`:
    // the WebUI is the surface that answers the questionnaire, permission
    // prompt and elicitation, so all three are unconditionally true here.
    // Adding a `webui` value to `surface` is out of scope per ADR 0004 and
    // assembly step 4 of `docs/webui-v1-scope.md`.
    capabilities: {
      cliEmbedded: true,
      questionnaireReply: true,
      permissionPrompt: true,
      elicitation: true,
    },
    enableLiveMcp: true,
    configGetter: () => {
      // Model selection updates the shared config file while the runtime is
      // still alive. Re-read the config on every access so listModels and
      // subsequent turns observe the new default instead of the startup
      // snapshot captured in `baseConfig`.
      const currentConfig = getDefaultLocalRuntimeConfig();
      return {
        ...currentConfig,
        beta: {
          ...currentConfig.beta,
          mcodeTools: mcodeTools.ready,
          browserUseTooling: browser.browserUseTooling,
        },
      };
    },
    authContextGetter: authSession.authContext.getter,
    authContextInvalidator: authSession.invalidateAuth,
    ...(browser.browserAdapter ? { browserAdapter: browser.browserAdapter } : {}),
    ...(browser.browserToolExposure
      ? { browserToolExposure: browser.browserToolExposure }
      : {}),
  };
  // The factory parameter is `CreateLocalRuntimeHostOptions`, but in this
  // typecheck the upstream type collapses to `{}` (no keys) because the
  // transitive import chain through `@mavis/local-runtime-v2` →
  // `@mavis/local-runtime` → `@mavis/agent-core` → `@earendil-works/pi-*`
  // fails to resolve — the vendored pi-mono packages ship no `dist/` and
  // there is no workspace build script that emits one (see the v7 brief's
  // item 3). The forwarded fields are correct against the source type
  // (`runtimeOwnerKind` / `runtimeMode` /
  // `startupExecutionPolicy` / `capabilities` all live in
  // `packages/local-runtime/src/runtime/host-factory-types.ts:32-47`); the
  // cast below is narrowly scoped to the factory boundary and exists only
  // because the typecheck can't see the upstream shape.
  let host: Omit<
    WebuiAssembledHost,
    | "invalidateAuth"
    | "getUsageQuota"
    | "getSigninPanel"
    | "claimSignin"
    | "beginAccountLogin"
    | "getAccountLoginStatus"
    | "cancelAccountLogin"
    | "signOutAccount"
  >;
  try {
    host = await factory(
      forwardedOptions as unknown as CreateLocalRuntimeHostOptions,
    );
  } catch (error) {
    // The factory is allowed to fail before it returns an apiHost.  The
    // capability owners were already acquired above, so release them on this
    // path as well; otherwise a broker socket or Browser profile survives a
    // failed WebUI start and contaminates the next attempt.
    const failures: unknown[] = [error];
    try {
      await lifecycle.closeAcquiredResources();
    } catch (cleanupError) {
      // `closeAcquiredResources` already aggregates the acquired-owner
      // failures; fold them in rather than replacing the factory error.
      if (cleanupError instanceof AggregateError) {
        failures.push(...cleanupError.errors);
      } else {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "WebUI runtime startup failed");
  }
  authSession.watch();
  const runtimeClose = host.apiHost.close.bind(host.apiHost);
  lifecycle.registerHostClose(runtimeClose);
  host.apiHost.close = () => lifecycle.close();
  try {
    mcodeTools.ensureCommandPath();
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      // `apiHost.close` is already wrapped above and therefore closes the
      // runtime followed by both capability owners exactly once.
      await host.apiHost.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "WebUI runtime startup failed");
  }
  const dailyCheckin = new DailyCheckinClient({
    tokenProvider: async () => {
      try {
        const lease = await authSession.oauthCore.getAccessToken({
          requiredScopes: MCODE_OAUTH_SCOPES,
          minValidityMs: 30_000,
        });
        const realUserID = authSession.authContext.getter()?.realUserID?.trim();
        // The check-in query and account guard need a real user id; without
        // one the panel renders its signed-out copy.
        if (!realUserID) return undefined;
        return { accessToken: lease.accessToken, realUserID };
      } catch {
        return undefined;
      }
    },
    region: quotaRegion,
    buildEnv: quotaBuildEnv,
    appVersion: options.appVersion || "webui",
  });
  // Consumers rebuild the service port from `host` (the dev launcher does:
  // `createHarnessPortFromHost(assembled.host)`), so the assembly-level
  // enrichments must live on `host` itself — otherwise `getUsageQuota`
  // only exists on `harnessPort` and the live panel fails with
  // "runtime host does not expose the usage quota client".
  // The account-login session shares the quota core deliberately: one
  // credential store, one watch — a login (here or in the terminal client)
  // refreshes both, and a sign-out clears both.
  const accountLogin = createWebuiAccountLoginSession(authSession.oauthCore);
  const hostHandle = {
    ...host,
    appVersion: options.appVersion ?? host.appVersion ?? "webui",
    invalidateAuth: authSession.invalidateAuth,
    getUsageQuota: (request?: { readonly forceRefresh?: boolean }) =>
      authSession.usageQuota.getUsageQuota(request),
    getSigninPanel: () => dailyCheckin.getSigninPanel(),
    claimSignin: () => dailyCheckin.claimSignin(),
    beginAccountLogin: () => accountLogin.begin(),
    getAccountLoginStatus: () => accountLogin.status(),
    cancelAccountLogin: () => accountLogin.cancel(),
    // The real sign-out: revoke + remove the credential, then clear this
    // process's projections. `invalidateAuth` alone only cleared projections
    // — the credential survived and the next lease refresh signed straight
    // back in, which is why 退出登录 never actually logged out.
    signOutAccount: async () => {
      const result = await authSession.oauthCore.logout({ revoke: true });
      authSession.invalidateAuth();
      return result;
    },
  };
  const harnessPort = createHarnessPortFromHost(hostHandle);
  return {
    harnessPort,
    host: hostHandle,
    forwardedOptions,
    mcodeTools,
    invalidateAuth: authSession.invalidateAuth,
  };
}

/**
 * Default factory: dynamically imports the real local-runtime-v2 host
 * factory so the WebUI server bundle does not pull in the full harness
 * layer (the assembly runs the import at boot, not at bundle time).
 */
const defaultWebuiRuntimeHostFactory: WebuiRuntimeHostFactory = async (
  options,
) => {
  const { createLocalRuntimeHostV2 } = await import("@mavis/local-runtime-v2");
  return (await createLocalRuntimeHostV2(
    options,
  )) as unknown as Omit<
    WebuiAssembledHost,
    | "invalidateAuth"
    | "getUsageQuota"
    | "getSigninPanel"
    | "claimSignin"
    | "beginAccountLogin"
    | "getAccountLoginStatus"
    | "cancelAccountLogin"
    | "signOutAccount"
  >;
};
