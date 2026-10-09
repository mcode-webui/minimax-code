// Resolve the WebUI's runtime scope (region + buildEnv) and reflect it into
// the process environment before the host is created.
//
// Why this file exists. The installed CLI writes `MAVIS_REGION`,
// `MAVIS_BUILD_ENV` and `__MAVIS_RUNTIME_MANAGED` itself
// (`packages/tui/src/cli/environment.ts:40-72`); the WebUI previously did
// not, so `getRuntimeRegion()` and `getRuntimeBuildEnv()` fell back to the
// defaults `en` / `dev` (`packages/config/src/config.ts:120-151`). That
// pointed the content-safety gateway at
// `https://matrix-overseas-test.example.invalid`
// (`packages/tui/src/runtime/public-gateway.ts:19-24`), a placeholder
// domain that does not resolve. The gateway's only failure policy is to
// block on local failure (`content-safety.service.ts:35`), so input review
// failed with `failureKind: "transport"` / `transportKind: "dns"`, the
// turn was marked `retracted`, and the projection emitted a
// `messages-rewound` frame — no assistant content ever reached the
// browser. The runtime's send path is fine; the runtime it hosts was
// configured as the wrong build.
//
// ADR 0003 forbids importing the terminal client's reader, so this mirrors
// the CLI's behaviour deliberately rather than by import:
//   * An explicit `MAVIS_REGION` / `MAVIS_BUILD_ENV` already in the
//     environment wins; the store is the fallback.
//   * Resolution prefers `<dataDir>/cli-auth/shared-projection.json`
//     (`{version, region, buildEnv}`) and falls back to the first
//     `<dataDir>/cli-auth/<buildEnv>/<region>/` directory the scanner
//     finds. The credential reader in `auth-context.ts` already
//     implements that resolution (`resolveAuthScope`,
//     `projectedScope`); this module reuses it so the OAuth bearer and
//     the harness scope agree by construction. A scope is adopted only
//     when its directory actually carries a credential — a stale
//     projection that names a scope whose directory is empty falls
//     through, exactly the rule the credential reader applies. This is
//     the one-decision / two-consumers rule (`auth-context.ts`).
//   * Values are validated against the same allow-list the harness
//     applies (`config.ts:120-151`), so a malformed store or an
//     operator-supplied typo cannot poison the runtime.
//   * When nothing resolves and nothing is explicit the resolver does
//     not guess: it leaves the environment untouched and returns
//     undefined, so a WebUI start without a client-side login still
//     behaves exactly as it did before this file existed.
//   * `__MAVIS_RUNTIME_MANAGED` is set to `'1'` only when this
//     resolver actually wrote `MAVIS_*`, and only when the operator
//     has not pinned the flag themselves. The CLI does this
//     unconditionally; the WebUI's explicit-env precedence means we
//     must respect a `'0'` the operator set on purpose (an internal
//     no-safety build).
//
// `target` is injectable so the assembly can run the resolver against
// `process.env` in production and tests can drive it against a plain
// record.

import {
  projectedScope,
  resolveAuthScope,
} from "./auth-context.js";

const REGIONS = new Set(["cn", "en"]);
const BUILD_ENVS = new Set(["dev", "test", "staging", "prod"]);
const MANAGED_FLAG_VALUES = new Set(["0", "1"]);

export type WebuiRuntimeScopeSource = "env" | "projection" | "directory";

export interface WebuiRuntimeScope {
  readonly region: string;
  readonly buildEnv: string;
  /** Where the resolver found the values, for test assertions and reports. */
  readonly source: WebuiRuntimeScopeSource;
}

export interface ConfigureWebuiRuntimeEnvironmentOptions {
  /** The CLI data directory shared per ADR 0006 (`~/.minimax` by default). */
  readonly dataDir: string;
  /**
   * Process-env-shaped map the resolver writes into. Defaults to
   * `process.env`. Tests pass a plain record so they can observe the
   * writes without polluting the test process's environment.
   */
  readonly target?: Record<string, string | undefined>;
}

/**
 * Tells whether `value` is one of the regions `getRuntimeRegion()` would
 * accept (`packages/config/src/config.ts:120-131`).
 */
function isValidRegion(value: string | undefined): value is string {
  return value !== undefined && REGIONS.has(value);
}

/**
 * Tells whether `value` is one of the build envs `getRuntimeBuildEnv()`
 * would accept (`packages/config/src/config.ts:133-151`).
 */
function isValidBuildEnv(value: string | undefined): value is string {
  return value !== undefined && BUILD_ENVS.has(value);
}

function optionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Resolves the WebUI's runtime scope and writes the three variables the
 * harness reads (`MAVIS_REGION`, `MAVIS_BUILD_ENV`,
 * `__MAVIS_RUNTIME_MANAGED`) into `options.target`. Returns the
 * resolved scope, or undefined when the resolver has nothing to write
 * and nothing to override — the caller can treat that as a no-op.
 *
 * Precedence:
 *   1. An explicit `MAVIS_REGION` + `MAVIS_BUILD_ENV` pair in the
 *      environment, both validated against the harness's allow-list.
 *   2. The scope the installed client last projected
 *      (`cli-auth/shared-projection.json`).
 *   3. The first scoped directory the scanner finds under
 *      `cli-auth/<buildEnv>/<region>/`.
 *   4. Nothing — return undefined and do not touch the environment.
 */
export function configureWebuiRuntimeEnvironment(
  options: ConfigureWebuiRuntimeEnvironmentOptions,
): WebuiRuntimeScope | undefined {
  const target = options.target ?? process.env;

  const explicitRegion = isValidRegion(optionalString(target.MAVIS_REGION))
    ? optionalString(target.MAVIS_REGION)
    : undefined;
  const explicitBuildEnv = isValidBuildEnv(
    optionalString(target.MAVIS_BUILD_ENV),
  )
    ? optionalString(target.MAVIS_BUILD_ENV)
    : undefined;

  let scope: WebuiRuntimeScope | undefined;
  if (explicitRegion && explicitBuildEnv) {
    scope = {
      region: explicitRegion,
      buildEnv: explicitBuildEnv,
      source: "env",
    };
  } else {
    // `resolveAuthScope` and `readWebuiAuthContext` share one decision:
    // a scope is only adopted when its directory actually carries a
    // credential, otherwise the scan falls through. The label here is
    // `"projection"` only when the projection's directory produced the
    // scope we are returning — a projection that was overridden by the
    // scan (its directory had no credential) is labelled `"directory"`.
    const stored = resolveAuthScope(options.dataDir);
    const projected = projectedScope(options.dataDir);
    if (stored) {
      const fromProjection =
        projected !== undefined &&
        projected.region === stored.region &&
        projected.buildEnv === stored.buildEnv;
      scope = {
        region: stored.region,
        buildEnv: stored.buildEnv,
        source: fromProjection ? "projection" : "directory",
      };
    }
  }

  if (!scope) return undefined;

  target.MAVIS_REGION = scope.region;
  target.MAVIS_BUILD_ENV = scope.buildEnv;

  // Honour an operator-pinned managed flag. The CLI sets this
  // unconditionally; the WebUI's "explicit wins" precedence must not
  // override an intentional `'0'` (a no-safety internal build).
  const explicitManaged = optionalString(target.__MAVIS_RUNTIME_MANAGED);
  if (!explicitManaged || !MANAGED_FLAG_VALUES.has(explicitManaged)) {
    target.__MAVIS_RUNTIME_MANAGED = "1";
  }

  return scope;
}