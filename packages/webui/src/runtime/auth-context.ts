// The WebUI's own account credential.
//
// The WebUI owns what it serves. The lease comes from the one OAuth core the
// WebUI's auth session owns (`runtime/auth-session.ts`), and the account
// identity comes from the WebUI's own account identity request
// (`runtime/usage-quota.ts`) — the same request the Desktop's account identity
// source makes against `/v1/api/user/info`.
//
// It used to read the terminal client's private projection
// (`<dataDir>/cli-auth/**`) as the credential of record: the access token, the
// login epoch and the account identity all came from files only `mcode login`
// wrote. That made the WebUI a reader of another client's store. The credential
// it served was the terminal client's, the identity it showed was the terminal
// client's, and nothing the WebUI did could be signed out of it. Nothing
// outside this process writes the credential now.
//
// What stayed is the shared login state. ADR 0006 has the WebUI read and write
// `~/.minimax`, and the OAuth namespace inside it
// (`auth/<buildEnv>/<region>/mcode-public/`) is where `mcode login` lands a
// login — so a terminal sign-in still signs the browser in, and the browser's
// own sign-in still signs the terminal in. That is the shared directory ADR
// 0006 asks for. The private projection the terminal client kept beside it
// (`cli-auth/`) is what this file no longer reads.
//
// The scope resolver is the other half of that decision. The runtime's
// `MAVIS_REGION` / `MAVIS_BUILD_ENV` and the credential the harness reads must
// name the same scope, or the runtime is pointed at a region the credential was
// never issued for. Both now come from the OAuth namespace — the same place
// the terminal client resolves its own scope from
// (`packages/tui/src/cli/environment.ts`), so the two clients cannot disagree.

import { readFileSync, statSync } from "node:fs";
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
  /** Publishes the credential the WebUI's own auth session holds. */
  readonly setAuthContext: (auth: WebuiAuthContext | undefined) => void;
}

export interface WebuiAuthContextReaderOptions {
  /** Injectable clock; tests drive the reader's expiry without waiting. */
  readonly nowMs?: () => number;
}

const BUILD_ENVS = ["dev", "test", "staging", "prod"] as const;
const REGIONS = ["cn", "en"] as const;

/**
 * The OAuth statuses that mean the namespace still holds a usable login.
 *
 * The same list the terminal client applies when it resolves its own scope
 * (`packages/tui/src/cli/environment.ts` — `isReusableAuthStatus`). One list,
 * two clients: a scope either is a live login for both of them or for neither.
 */
const REUSABLE_AUTH_STATUSES = new Set([
  "authorizing",
  "authenticated",
  "refreshing",
  "scope_upgrade_required",
  "expired",
]);

interface AuthScope {
  readonly region: string;
  readonly buildEnv: string;
}

/**
 * Finds the most recently active OAuth namespace. The OAuth state file carries
 * only scope and status; the credential itself stays inside oauth-core's
 * credential store.
 *
 * This is the scope resolution the WebUI and the terminal client share. The
 * terminal client reads the same state files to decide which region its own
 * lease belongs to, so the two clients cannot end up pointed at different
 * regions because one of them preferred a different file.
 */
export function resolveAuthScope(dataDir: string): AuthScope | undefined {
  const candidates: Array<{
    readonly scope: AuthScope;
    readonly modifiedAtMs: number;
  }> = [];
  for (const buildEnv of BUILD_ENVS) {
    for (const region of REGIONS) {
      const namespace = createAuthNamespace({ dataDir, buildEnv, region });
      const statePath = join(namespace.namespaceHome, "auth-state.json");
      const state = readJsonObject(statePath);
      if (
        !state ||
        state.clientId !== "mcode-public" ||
        state.buildEnv !== buildEnv ||
        state.region !== region ||
        typeof state.status !== "string" ||
        !REUSABLE_AUTH_STATUSES.has(state.status)
      ) {
        continue;
      }
      try {
        candidates.push({
          scope: { buildEnv, region },
          modifiedAtMs: statSync(statePath).mtimeMs,
        });
      } catch {
        // A state file removed during discovery is not a usable scope.
      }
    }
  }
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  return candidates[0]?.scope;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Builds the getter and invalidator pair the runtime host expects. Both are
 * required for managed login: the host defaults them to undefined when an
 * assembly supplies neither, and a managed provider then fails every turn at
 * the agent preflight with "managed OAuth bearer is not synced".
 *
 * The credential lives in this process. The WebUI's auth session publishes it
 * with {@link WebuiAuthContextReader.setAuthContext} whenever a lease is
 * projected, renewed or cleared, so the getter is a read of the projection
 * rather than a read of a file another client owns.
 *
 * A rejection is per credential, not per process. Once the runtime reports a
 * token rejected, that token is withheld until a different one is published;
 * a token from a newer login epoch is served even when it repeats the
 * rejected one, because the epoch is what tells the two apart.
 */
export function createWebuiAuthContextReader(
  options: WebuiAuthContextReaderOptions = {},
): WebuiAuthContextReader {
  let authContext: WebuiAuthContext | undefined;
  let rejectedAccessToken: string | undefined;
  let rejectedLoginEpoch: string | undefined;

  const isRejected = (context: WebuiAuthContext): boolean => {
    const token = optionalString(context.accessToken);
    if (!token) return false;
    if (token !== rejectedAccessToken) return false;
    const epoch = optionalString(context.loginEpoch);
    const rejectedEpoch = optionalString(rejectedLoginEpoch);
    // A rejection that named no epoch rejects this token outright. A rejection
    // that named one only rejects the login it was made in.
    return rejectedEpoch === undefined || epoch === undefined || epoch === rejectedEpoch;
  };

  return {
    getter() {
      if (!authContext) return undefined;
      return isRejected(authContext) ? undefined : authContext;
    },
    invalidator(nextRejectedAccessToken, loginEpoch) {
      const token = optionalString(nextRejectedAccessToken);
      if (token) {
        rejectedAccessToken = token;
        rejectedLoginEpoch = optionalString(loginEpoch);
      }
    },
    setAuthContext(next) {
      authContext = next;
      const token = optionalString(next?.accessToken);
      // A different token clears the rejection: the old one is stale by
      // definition, and a rejected credential is not a reason to distrust an
      // unrelated renewal.
      if (token && token !== rejectedAccessToken) {
        rejectedAccessToken = undefined;
        rejectedLoginEpoch = undefined;
      }
    },
  };
}