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
// `webui` row accounts for directly. The row and its cells are documented in
// `packages/webui/docs/runtime/boot.md`.
//
// The remaining fields mirror the documented call sites:
//
//   * `packages/tui/src/runtime/embedded-host.ts` — the surface owner, mode
//     and capability projection (lines 85–93).
//   * `packages/tui/src/runtime/lifecycle.ts:456-460` — the conditional
//     `startupExecutionPolicy: 'quarantined'`. The CLI applies it per
//     surface; ADR 0002 and `packages/webui/docs/runtime/boot.md` require the
//     WebUI to set it unconditionally.
//
// The factory is injectable so the assembly can be unit-tested without
// standing up the full host. The default is the real local-runtime-v2
// factory; tests inject a stub that records the options and reports
// the policy's observable effect without driving the host.

import { getDefaultLocalRuntimeConfig } from "@mavis/local-runtime-v2";
import type { CreateLocalRuntimeHostOptions } from "@mavis/local-runtime-v2/process-local";
import { MCODE_OAUTH_SCOPES } from "@mavis/oauth-core";
import { MARKETPLACE_VISIBILITY_DESKTOP_VERSION } from "@mavis/shared/marketplace-visibility";

import { type WebuiAuthContext } from "./auth-context.js";
import { createWebuiAuthSession } from "./auth-session.js";
import { createWebuiRuntimeLifecycle } from "./lifecycle.js";
import { createWebuiAccountLoginSession } from "./account-login.js";
import { createHarnessPortFromHost } from "./harness/adapter.js";
import type {
  WebuiRuntimeCliService,
  WebuiRuntimeHostHandle,
} from "./harness/host-contract.js";
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
 * What the assembly guarantees about the host it hands back.
 *
 * The runtime factory produces the loose handle (`WebuiRuntimeHostHandle`); the
 * assembly then enriches it with the credential-backed slots — quota, daily
 * check-in, account login and the real sign-out — which is why those are
 * required here and optional there. Everything else keeps the handle's own
 * optionality, and the member types come from the handle instead of being
 * restated: the two declarations had drifted apart, and the one member that
 * existed only here (`requestCompaction`) was never assigned by anyone and read
 * by no one — compaction is `cliService.requestCompaction`, resolved by the
 * harness adapter.
 *
 * `appVersion` stays optional because the v2 host does not echo the input
 * option back.
 */
export interface WebuiAssembledHost extends WebuiRuntimeHostHandle {
  // Each type is read back off the handle rather than restated: the two
  // declarations drifted while both spelled the parameter lists out, and a
  // second copy of a signature is a second thing to update.
  readonly dataDir: NonNullable<WebuiRuntimeHostHandle["dataDir"]>;
  readonly invalidateAuth: NonNullable<WebuiRuntimeHostHandle["invalidateAuth"]>;
  readonly getUsageQuota: NonNullable<WebuiRuntimeHostHandle["getUsageQuota"]>;
  readonly getCreditFallback: NonNullable<
    WebuiRuntimeHostHandle["getCreditFallback"]
  >;
  readonly setCreditFallback: NonNullable<
    WebuiRuntimeHostHandle["setCreditFallback"]
  >;
  readonly listResetCards: NonNullable<WebuiRuntimeHostHandle["listResetCards"]>;
  readonly useResetCard: NonNullable<WebuiRuntimeHostHandle["useResetCard"]>;
  readonly queryResetCardFlows: NonNullable<
    WebuiRuntimeHostHandle["queryResetCardFlows"]
  >;
  readonly getAccountUsageSummary: NonNullable<
    WebuiRuntimeHostHandle["getAccountUsageSummary"]
  >;
  readonly getAccountProfile: NonNullable<
    WebuiRuntimeHostHandle["getAccountProfile"]
  >;
  readonly getSigninPanel: NonNullable<WebuiRuntimeHostHandle["getSigninPanel"]>;
  readonly claimSignin: NonNullable<WebuiRuntimeHostHandle["claimSignin"]>;
  readonly beginAccountLogin: NonNullable<
    WebuiRuntimeHostHandle["beginAccountLogin"]
  >;
  readonly getAccountLoginStatus: NonNullable<
    WebuiRuntimeHostHandle["getAccountLoginStatus"]
  >;
  readonly cancelAccountLogin: NonNullable<
    WebuiRuntimeHostHandle["cancelAccountLogin"]
  >;
  readonly signOutAccount: NonNullable<WebuiRuntimeHostHandle["signOutAccount"]>;
}

// The browser provider types and the adoption rule live in
// `runtime/browser-provider.ts`; they are re-exported here so the runtime's
// public surface is unchanged.
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
 * The options the WebUI assembly forwards to the harness factory: the runtime's
 * own fields, picked from the real `CreateLocalRuntimeHostOptions` instead of
 * re-spelled.
 *
 * The hand-written copy that used to live here is why the factory call carried a
 * double assertion: the copy described one field set, the runtime's type
 * described another, and only the cast reconciled them. The runtime's
 * declaration is the one the factory checks, so it is the one this type derives
 * from — an unsupported field or a wrong literal is now a compile error at the
 * object below, not a runtime surprise.
 */
export type WebuiForwardedRuntimeHostOptions = Pick<
  CreateLocalRuntimeHostOptions,
  | "dataDir"
  | "appVersion"
  | "marketplaceVisibilityVersion"
  | "runtimeOwnerKind"
  | "runtimeMode"
  | "startupExecutionPolicy"
  | "capabilities"
  | "enableLiveMcp"
  | "configGetter"
  | "authContextGetter"
  | "authContextInvalidator"
  | "browserAdapter"
  | "browserToolExposure"
  | "miniAppSurface"
>;

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
    | "getCreditFallback"
    | "setCreditFallback"
    | "listResetCards"
    | "useResetCard"
    | "queryResetCardFlows"
    | "getAccountUsageSummary"
    | "getAccountProfile"
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
   * The CLI data directory (`~/.minimax` by default), shared per ADR 0006. It
   * carries the login state, the provider configuration and the session history
   * the WebUI shows, so a run that needs a clean slate has to opt into
   * `MINIMAX_DATA_DIR` instead.
   */
  readonly dataDir: string;
  /** Build identity forwarded to the host for metric labels. */
  readonly appVersion?: string;
  /** Browser provider explicitly owned by the WebUI process, when enabled. */
  readonly browserProvider?: WebuiBrowserProvider;
  readonly browserToolExposure?: WebuiBrowserToolExposure;
  /**
   * The Mini App presenter, when this client supplies one.
   *
   * The runtime's `MiniAppPresenter` is a host-owned port: on the desktop client it
   * moves a native view, and here it is the browser implementation
   * (`server/miniapp/presenter.ts`). It is an option rather than something the
   * assembly builds because the two sides may not import each other — the server
   * holds the presenter, the runtime holds the port — so the file outside the layer
   * system (an entry script) is what joins them.
   *
   * `undefined` is a host whose runtime has no presenter: the agent's `open` action
   * then refuses with `OPEN_UNAVAILABLE`, which is why the Mini App service cell is
   * not enabled until a presenter and a view both exist.
   */
  readonly miniAppSurface?: NonNullable<CreateLocalRuntimeHostOptions["miniAppSurface"]>;
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
 * Boots one process-local runtime host as the `webui` owner with the
 * unconditionally quarantined cold-start policy. Returns a `WebuiHarnessPort`
 * the `WebuiService` can tear down in the close order
 * `packages/webui/docs/runtime/boot.md` states.
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
    // The cloud filters the marketplace by the desktop version a client
    // declares. The WebUI is not the desktop, so it declares the desktop
    // version the shared constant names — and the runtime only carries the
    // declaration.
    marketplaceVisibilityVersion: MARKETPLACE_VISIBILITY_DESKTOP_VERSION,
    runtimeOwnerKind: "webui",
    runtimeMode: "clean",
    startupExecutionPolicy: "quarantined",
    // Interaction capabilities mirror `packages/tui/src/runtime/lifecycle.ts:451-455`:
    // the WebUI is the surface that answers the questionnaire, permission
    // prompt and elicitation, so all three are unconditionally true here.
    // Adding a `webui` value to `surface` is out of scope per ADR 0004.
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
          // The capability switch stays the configured value. The Desktop client
          // keeps `beta.mcodeTools` as the resolved config value too, so the
          // `mcode-tools-master` skill stays in the catalog even when this
          // client's host integration is not ready. Overriding it with the
          // readiness dropped that skill from the catalog, and the Agent then
          // had no entry point for multimodal generation at all.
          // `browserUseTooling` is still readiness-gated: the browser tool is
          // only usable when this client actually adopted a browser provider.
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
    ...(options.miniAppSurface ? { miniAppSurface: options.miniAppSurface } : {}),
  };
  // The factory signature is the runtime's own: `forwardedOptions` is derived
  // from `CreateLocalRuntimeHostOptions`, so the call is checked field by field
  // instead of reconciled by a cast.
  let host: Omit<
    WebuiAssembledHost,
    | "invalidateAuth"
    | "getUsageQuota"
    | "getCreditFallback"
    | "setCreditFallback"
    | "listResetCards"
    | "useResetCard"
    | "queryResetCardFlows"
    | "getAccountUsageSummary"
    | "getAccountProfile"
    | "getSigninPanel"
    | "claimSignin"
    | "beginAccountLogin"
    | "getAccountLoginStatus"
    | "cancelAccountLogin"
    | "signOutAccount"
  >;
  try {
    host = await factory(forwardedOptions);
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
          requiredScopes: [...MCODE_OAUTH_SCOPES],
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
    // The account-billing surface of the usage-and-model page rides the same
    // client and therefore the same credential lease as the quota read.
    getCreditFallback: () => authSession.usageQuota.getCreditFallback(),
    setCreditFallback: (request: { readonly enabled: boolean }) =>
      authSession.usageQuota.setCreditFallback(request),
    listResetCards: (request?: {
      readonly page?: number;
      readonly size?: number;
    }) => authSession.usageQuota.listResetCards(request),
    useResetCard: (request: {
      readonly sourceType?: string;
      readonly outBizNo?: string;
    }) => authSession.usageQuota.useResetCard(request),
    queryResetCardFlows: (request?: {
      readonly page?: number;
      readonly size?: number;
      readonly createTimeMs?: number;
    }) => authSession.usageQuota.queryResetCardFlows(request),
    getAccountUsageSummary: () => authSession.usageQuota.getUsageSummary(),
    getAccountProfile: () => authSession.usageQuota.getAccountProfile(),
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
  // No assertion.
  //
  // This returned `as unknown as Omit<WebuiAssembledHost, ...>` for the whole
  // life of the seam — one assertion covering every forwarded member, with a
  // comment admitting that dozens of them did not type-check and that closing
  // the gap was future work. It stated all of the difference in a single place,
  // which is the one form a compiler cannot help with: a runtime that renamed a
  // field, or began answering with a shape the declaration could not see, kept
  // compiling and failed in the browser.
  //
  // Both halves are now checked. The results convert at the boundary that owns
  // them, in `harness/result-conversion.ts`, and the mirror declares the requests
  // the runtime actually accepts — including the three that were looser than it
  // (a model-provider candidate with a required `baseUrl`, a key reveal that is
  // synchronous, and attachment lists the runtime keeps rather than borrows).
  //
  // A runtime that changes any of it now fails here.
  return await createLocalRuntimeHostV2(options);
};
