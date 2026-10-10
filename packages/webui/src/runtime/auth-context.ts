// Account credentials for the WebUI's runtime host.
//
// Assembly step 3 of `docs/webui-v1-scope.md` requires an auth context getter
// with refresh and invalidation. Managed MiniMax login carries no API key: the
// credential is an OAuth access token sent as `Authorization: Bearer`, and the
// resolver throws `managed OAuth bearer is not synced` when the header is
// absent. `@mavis/local-runtime-v2` defaults the getter to `() => undefined`
// (`compat/v1/runtime.ts`), so an assembly that passes nothing can never talk
// to a managed provider: every turn fails at the agent preflight.
//
// ADR 0003 keeps the WebUI off the terminal client's internals, so this reads
// the on-disk store directly rather than importing that client's reader. The
// layout is the one the client writes:
//
//   <dataDir>/cli-auth/shared-projection.json   → { region, buildEnv, … }
//   <dataDir>/cli-auth/<buildEnv>/<region>/cli-auth.scope.json
//   <dataDir>/cli-auth/<buildEnv>/<region>/local-runtime.auth.json → { auth }
//
// Three deliberate differences from the terminal client's reader:
//
//   * It never writes. That reader imports a shared projection into the
//     client's own scope directory; a second client mutating the same store
//     would make two writers of one credential file for no gain, so this is
//     read-only.
//   * It resolves its own scope. The client knows its build environment at
//     compile time; the WebUI has no equivalent, so it takes the scope the
//     installed client last used from the shared projection and falls back to
//     whichever scoped directory actually carries a token.
//   * It refreshes by re-reading. The installed client renews the token in
//     place, so picking a renewal up is a read; only a rejected token is
//     remembered, and only for this process's lifetime.
//
// One decision, two consumers. The scope picked here is also the scope
// `MAVIS_REGION` / `MAVIS_BUILD_ENV` are written from
// (`packages/webui/src/server/runtime-environment.ts`). The projection is
// adopted only when its directory actually carries a credential; otherwise
// the scan falls through to the first scoped directory that does. Without
// this guard a stale projection strands the runtime on a scope whose
// bearer does not exist — the same `managed OAuth bearer is not synced`
// text the credential gap produced, but with the OAuth-bearer fix in
// place, leaving the diagnosis ambiguous.
//
// Refresh: a successful read is cached for `AUTH_CONTEXT_TTL_MS` so one turn
// resolving several models does not re-read the file per resolution, and the
// cache expires so an upstream renewal becomes visible without a restart. Only
// a found credential is cached — a missing or rejected one is re-read, because
// that is the case where picking the change up promptly is the whole point.
// Invalidation: the runtime reports a rejected token, which is then withheld
// until the store carries a different one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAuthNamespace } from "@mavis/oauth-core";

/** The subset of `LocalRuntimeAuthContext` this adapter can supply. */
export interface WebuiAuthContext {
  readonly accessToken?: string;
  readonly loginEpoch?: string;
  readonly realUserID?: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
}

export interface WebuiAuthContextReader {
  /** Supplied to the runtime host as its `authContextGetter`. */
  readonly getter: () => WebuiAuthContext | undefined;
  /** Supplied to the runtime host as its `authContextInvalidator`. */
  readonly invalidator: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void;
  /** Updates the in-memory projection from the shared OAuth lease. */
  readonly setOAuthAuthContext: (auth: WebuiAuthContext | undefined) => void;
}

export interface WebuiAuthContextReaderOptions {
  /** Injectable clock; tests drive the cache's expiry without waiting. */
  readonly nowMs?: () => number;
}

const CLI_AUTH_DIRECTORY = "cli-auth";
const CLI_AUTH_SCOPE_FILE = "cli-auth.scope.json";
const CLI_SHARED_PROJECTION_FILE = "shared-projection.json";
const CLI_AUTH_CONTEXT_FILE = "local-runtime.auth.json";
const AUTH_CONTEXT_TTL_MS = 5_000;
const REGIONS = new Set(["cn", "en"]);
const BUILD_ENVS = new Set(["dev", "test", "staging", "prod"]);

interface AuthScope {
  readonly region: string;
  readonly buildEnv: string;
}

type ScopeSource = "projection" | "directory";

interface AdoptedScope {
  readonly scope: AuthScope;
  readonly source: ScopeSource;
  readonly auth: WebuiAuthContext;
}

interface ScopedDirectory {
  readonly directory: string;
  readonly scope: AuthScope;
}

/**
 * Picks the {@link AdoptedScope} the runtime host should run as. The rule
 * is the one {@link readWebuiAuthContext} already applies to credentials:
 * a scope is adopted only when its directory can produce a credential, so
 * a stale projection cannot strand the runtime on a scope whose bearer
 * does not exist (a divergence that previously surfaced as the same
 * `managed OAuth bearer is not synced` error the credential gap produced
 * for a different cause).
 *
 * Used by both consumers — the runtime-environment resolver and the
 * credential reader — so the OAuth bearer and the
 * `MAVIS_REGION` / `MAVIS_BUILD_ENV` the harness picks up agree by
 * construction. Both reject when nothing is resolvable; both prefer the
 * projection when it can be backed; both fall through to the directory
 * scan otherwise.
 */
function adoptScope(dataDir: string): AdoptedScope | undefined {
  const projected = projectedScope(dataDir);
  if (projected) {
    const auth = readScopedAuth(scopedDirectory(dataDir, projected), projected);
    if (auth) return { scope: projected, source: "projection", auth };
  }
  for (const { directory, scope } of scopedDirectories(dataDir)) {
    const auth = readScopedAuth(directory, scope);
    if (auth) return { scope, source: "directory", auth };
  }
  return undefined;
}

/**
 * Resolves the {@link AuthScope} the installed client last projected,
 * falling back to the first scoped directory that actually carries a
 * credential. Returns undefined when the data directory holds nothing the
 * resolver can trust, so the caller can choose to do nothing rather than
 * guess.
 *
 * Exported so the runtime-environment module can share one decision with
 * the credential reader — the same scope decides both the OAuth bearer
 * and the `MAVIS_REGION` / `MAVIS_BUILD_ENV` the harness picks up.
 */
export function resolveAuthScope(dataDir: string): AuthScope | undefined {
  return adoptScope(dataDir)?.scope ?? resolveOAuthAuthScope(dataDir);
}

/**
 * Finds the most recently active OAuth namespace when the legacy CLI
 * projection is absent. The OAuth state file carries only scope and status;
 * credentials remain inside oauth-core's credential store.
 */
function resolveOAuthAuthScope(dataDir: string): AuthScope | undefined {
  const candidates: Array<{ readonly scope: AuthScope; readonly modifiedAtMs: number }> = [];
  for (const buildEnv of ["dev", "test", "staging", "prod"] as const) {
    for (const region of ["cn", "en"] as const) {
      const namespace = createAuthNamespace({ dataDir, buildEnv, region });
      const statePath = join(namespace.namespaceHome, "auth-state.json");
      const state = readJsonObject(statePath);
      if (
        !state ||
        state.clientId !== "mcode-public" ||
        state.buildEnv !== buildEnv ||
        state.region !== region ||
        (state.status !== "authenticated" &&
          state.status !== "expired" &&
          state.status !== "refreshing")
      ) {
        continue;
      }
      try {
        candidates.push({ scope: { buildEnv, region }, modifiedAtMs: statSync(statePath).mtimeMs });
      } catch {
        // A state file removed during discovery is not a usable scope.
      }
    }
  }
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  return candidates[0]?.scope;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * Reads a scope record, rejecting anything the client would not have written.
 * Both `shared-projection.json` and `cli-auth.scope.json` carry this shape.
 */
function readScope(
  record: Record<string, unknown> | undefined,
): AuthScope | undefined {
  if (!record || record.version !== 1) return undefined;
  const region = optionalString(record.region);
  const buildEnv = optionalString(record.buildEnv);
  if (!region || !buildEnv) return undefined;
  if (!REGIONS.has(region) || !BUILD_ENVS.has(buildEnv)) return undefined;
  return { region, buildEnv };
}

function scopedDirectory(dataDir: string, scope: AuthScope): string {
  return join(dataDir, CLI_AUTH_DIRECTORY, scope.buildEnv, scope.region);
}

/** The scope the installed client last projected, if it left a record. */
export function projectedScope(dataDir: string): AuthScope | undefined {
  return readScope(
    readJsonObject(join(dataDir, CLI_AUTH_DIRECTORY, CLI_SHARED_PROJECTION_FILE)),
  );
}

/**
 * Every `<buildEnv>/<region>` directory under `cli-auth`, sorted so the scan
 * is deterministic. The scope comes from the path, not from the scope file, so
 * a directory whose record disagrees with the name it sits in is not read as a
 * live login. Used only when the projection is missing or stale.
 */
function scopedDirectories(dataDir: string): ScopedDirectory[] {
  const root = join(dataDir, CLI_AUTH_DIRECTORY);
  let buildEnvs;
  try {
    buildEnvs = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories: ScopedDirectory[] = [];
  for (const buildEnv of buildEnvs
    .filter((entry) => entry.isDirectory() && BUILD_ENVS.has(entry.name))
    .map((entry) => entry.name)
    .sort()) {
    let regions;
    try {
      regions = readdirSync(join(root, buildEnv), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const region of regions
      .filter((entry) => entry.isDirectory() && REGIONS.has(entry.name))
      .map((entry) => entry.name)
      .sort())
      directories.push({
        directory: join(root, buildEnv, region),
        scope: { buildEnv, region },
      });
  }
  return directories;
}

/**
 * Reads the credential stored for one scope directory. The scope file has to
 * agree with the directory it sits in — the client writes it alongside the
 * credential precisely so a stale directory is not read as a live login.
 */
function readScopedAuth(
  directory: string,
  scope: AuthScope,
): WebuiAuthContext | undefined {
  const recorded = readScope(
    readJsonObject(join(directory, CLI_AUTH_SCOPE_FILE)),
  );
  if (
    !recorded ||
    recorded.region !== scope.region ||
    recorded.buildEnv !== scope.buildEnv
  )
    return undefined;
  const record = readJsonObject(join(directory, CLI_AUTH_CONTEXT_FILE));
  if (!record || record.version !== 1) return undefined;
  const auth = record.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  const source = auth as Record<string, unknown>;
  const accessToken = optionalString(source.accessToken);
  if (!accessToken) return undefined;
  const loginEpoch = optionalString(source.loginEpoch);
  const realUserID = optionalString(source.realUserID);
  const userEmail = optionalString(source.userEmail);
  const userName = optionalString(source.userName);
  const subUserName = optionalString(source.subUserName);
  return {
    accessToken,
    ...(loginEpoch ? { loginEpoch } : {}),
    ...(realUserID ? { realUserID } : {}),
    ...(userEmail ? { userEmail } : {}),
    ...(userName ? { userName } : {}),
    ...(subUserName ? { subUserName } : {}),
  };
}

/**
 * Reads the account credential the installed client holds for `dataDir`.
 * Prefers the scope the client last projected and falls back to the first
 * scoped directory that carries one. Delegates to {@link adoptScope} so
 * the scope picked here matches the one {@link resolveAuthScope} would
 * return — the runtime environment and the credential can never disagree
 * on what scope they belong to.
 */
export function readWebuiAuthContext(
  dataDir: string,
): WebuiAuthContext | undefined {
  return adoptScope(dataDir)?.auth;
}

/**
 * Builds the getter and invalidator pair the runtime host expects. Both are
 * required for managed login; see the header for why.
 */
export function createWebuiAuthContextReader(
  dataDir: string,
  options: WebuiAuthContextReaderOptions = {},
): WebuiAuthContextReader {
  const nowMs = options.nowMs ?? Date.now;
  let cached: { readonly atMs: number; readonly auth: WebuiAuthContext } | undefined;
  // Only the most recent rejection is withheld: once the store carries a
  // different token the rejected one is stale by definition, and a rejected
  // token is not a reason to distrust an unrelated renewal.
  let rejectedAccessToken: string | undefined;
  let oauthAuthContext: WebuiAuthContext | undefined;

  const read = (): WebuiAuthContext | undefined => {
    const oauthAccessToken = oauthAuthContext?.accessToken;
    if (oauthAccessToken && oauthAccessToken !== rejectedAccessToken) {
      const stored = readWebuiAuthContext(dataDir);
      return stored?.accessToken === oauthAccessToken
        ? { ...stored, ...oauthAuthContext }
        : oauthAuthContext;
    }
    const auth = readWebuiAuthContext(dataDir);
    const accessToken = auth?.accessToken;
    if (!accessToken || accessToken === rejectedAccessToken) return undefined;
    return auth;
  };

  return {
    getter() {
      const now = nowMs();
      if (cached && now - cached.atMs < AUTH_CONTEXT_TTL_MS) return cached.auth;
      const auth = read();
      cached = auth ? { atMs: now, auth } : undefined;
      return auth;
    },
    invalidator(nextRejectedAccessToken) {
      const token = optionalString(nextRejectedAccessToken);
      if (token) rejectedAccessToken = token;
      cached = undefined;
    },
    setOAuthAuthContext(auth) {
      oauthAuthContext = auth;
      if (auth?.accessToken && auth.accessToken !== rejectedAccessToken) {
        rejectedAccessToken = undefined;
      }
      cached = undefined;
    },
  };
}
