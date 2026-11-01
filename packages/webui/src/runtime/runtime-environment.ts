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
// ADR 0003 forbids importing the terminal client's reader, so this resolves
// the scope deliberately rather than importing the CLI:
//   * A complete, valid `MAVIS_REGION` / `MAVIS_BUILD_ENV` pair wins.
//   * Otherwise, use the OAuth namespace that holds a live login. This keeps
//     the credential and harness scope aligned by construction.
//   * A fresh install with no stored scope uses `cn/prod`. The WebUI login
//     page must reach a real account endpoint before an OAuth namespace exists;
//     the old `en/dev` default resolved to `example.invalid` and failed.
//   * Values are validated against the same allow-list the harness applies
//     (`config.ts:120-151`).
//   * `__MAVIS_RUNTIME_MANAGED` is set to `'1'` unless the operator has pinned
//     the flag. An explicit `'0'` remains an intentional no-safety build.
//
// `target` is injectable so the assembly can run the resolver against
// `process.env` in production and tests can drive it against a plain
// record.

import { resolveAuthScope } from "./auth-context.js";

const REGIONS = new Set(["cn", "en"]);
const BUILD_ENVS = new Set(["dev", "test", "staging", "prod"]);
const MANAGED_FLAG_VALUES = new Set(["0", "1"]);

export type WebuiRuntimeScopeSource = "env" | "oauth-namespace" | "default";

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
 * resolved scope and writes it into the process environment.
 *
 * Precedence:
 *   1. An explicit `MAVIS_REGION` + `MAVIS_BUILD_ENV` pair in the
 *      environment, both validated against the harness's allow-list.
 *   2. The scope the OAuth namespace scan finds — the namespace that
 *      still holds a login, read from the same state files the
 *      terminal client reads its own scope from.
 *   3. The first-run default: cn/prod.
 */
export function configureWebuiRuntimeEnvironment(
  options: ConfigureWebuiRuntimeEnvironmentOptions,
): WebuiRuntimeScope {
  const target = options.target ?? process.env;

  const explicitRegion = isValidRegion(optionalString(target.MAVIS_REGION))
    ? optionalString(target.MAVIS_REGION)
    : undefined;
  const explicitBuildEnv = isValidBuildEnv(
    optionalString(target.MAVIS_BUILD_ENV),
  )
    ? optionalString(target.MAVIS_BUILD_ENV)
    : undefined;

  let scope: WebuiRuntimeScope;
  if (explicitRegion && explicitBuildEnv) {
    scope = {
      region: explicitRegion,
      buildEnv: explicitBuildEnv,
      source: "env",
    };
  } else {
    // One decision, two consumers: `resolveAuthScope` names the scope
    // whose OAuth namespace holds a live login, and the auth session
    // builds its credential core for exactly that scope. The scope is
    // read from the same state files the terminal client reads its own
    // scope from, so the two clients cannot disagree about which
    // region the credential belongs to.
    const stored = resolveAuthScope(options.dataDir);
    if (stored) {
      scope = {
        region: stored.region,
        buildEnv: stored.buildEnv,
        source: "oauth-namespace",
      };
    } else {
      scope = {
        region: "cn",
        buildEnv: "prod",
        source: "default",
      };
    }
  }

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
