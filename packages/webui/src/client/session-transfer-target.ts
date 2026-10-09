// Where the session-transfer routes live, and with what credential.
//
// Responsibility (plan §7.2 `client/infrastructure/session-transfer-target.ts`;
// ticket #51): this is **browser infrastructure IO**, not a business rule. It
// reads the injected runtime config (`globalThis.__WEBUI_CONFIG__`) and resolves
// the transfer origin and token at call time. It is deliberately not absorbed
// into a workflow module: the decision of *which* session to export and *where*
// to import it into lives in `application/session-workflows.ts`, and the two
// request adapters (`session-transfer-download.ts`, `session-import.ts`) consume
// this resolver for the shared origin/token answer. Because it reads a global it
// is not a pure rule module and belongs to infrastructure.
//
// Both halves of the round trip need the same answer -- the export GET and
// the import POST are served by the same listener -- so it is resolved once
// here rather than twice with two subtly different copies.

interface WebuiRuntimeConfig {
  readonly websocketUrl: string;
  readonly token: string;
  readonly dataDir?: string;
}

export interface WebuiSessionTransferTarget {
  readonly origin: string;
  readonly token: string;
}

/**
 * The token and origin are read at call time, not at module load: the runtime
 * config is injected before the app renders, and a module-scope read would
 * make this untestable without mutating globals on import.
 */
export function readWebuiSessionTransferTarget(): WebuiSessionTransferTarget | undefined {
  const config = (globalThis as { __WEBUI_CONFIG__?: WebuiRuntimeConfig }).__WEBUI_CONFIG__;
  if (!config?.websocketUrl) return undefined;
  // `new URL("ws://host").origin` stays `ws://host`, which `fetch` cannot use.
  // The transport's URL is the websocket endpoint; the transfer routes are
  // served by the same listener over HTTP.
  let origin: string;
  try {
    origin = new URL(config.websocketUrl).origin.replace(/^ws(?=:\/\/)/u, "http");
  } catch {
    return undefined;
  }
  // An empty token is the dev server's ordinary state -- `vite.config.ts`
  // injects `token:''` and the service skips the credential check when it runs
  // with `dev`. Whether a credential is required is the server's call, not the
  // client's, so a blank token must not be read here as "no runtime attached".
  return { origin, token: config.token ?? "" };
}
