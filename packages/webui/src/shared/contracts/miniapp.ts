// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiMiniAppRuntimeStatus` | The states a Mini App row can be in, as the runtime reports them. | Runtime `MiniAppSurfaceSummary.runtime.status` (`@mavis/shared/miniapp-surface`), copied field by field in `runtime/harness/miniapp.ts`. | `WebuiMiniAppSummary`; the row a picker renders. |
// | `WebuiMiniAppSummary` | One catalogue row: identity, display copy and the runtime state, which is what tells a stopped Mini App from a running one. | `listMiniApps` and the `miniApp` half of `openMiniApp` (`runtime/harness/miniapp.ts`; CliService). | `shared/operation-names.ts`; `runtime/port.ts`; `server/operation/handlers/miniapp.ts`. |
// | `WebuiMiniAppList` | The envelope `listMiniApps` answers with, as the runtime answers it: rows and nothing else, because the runtime has no view of presentation. | `runtime/harness/miniapp.ts` (`listMiniApps`; CliService). | `runtime/port.ts`; `server/operation/handlers/miniapp.ts`. |
// | `WebuiMiniAppPresentation` | Whether a standalone presentation is live for a plugin, and how many times one has been acquired. | `server/operation/handlers/miniapp.ts` from `server/miniapp/presentation-lease.ts` — never a constant. | `WebuiMiniAppCatalogueRow`; `client/features/miniapp/projection/miniapp-view.ts`. |
// | `WebuiMiniAppCatalogueRow` | One catalogue row as the service answers it: the runtime's row plus the live presentation. | `server/operation/handlers/miniapp.ts`. | `client/features/miniapp/projection/miniapp-view.ts`; `client/features/miniapp/ui/MiniAppView.public.tsx`. |
// | `WebuiMiniAppCatalogue` | The body `listMiniApps` answers with, presentation facts included. | `server/operation/handlers/miniapp.ts`. | `shared/operation-names.ts`; `client/features/miniapp/contracts/miniapp-port.ts`. |
// | `WebuiMiniAppPresentationState` | One frame of `watchMiniAppPresentation`: the lease a standalone document took, and whether the session its deep link names is still present. | `server/operation/handlers/miniapp.ts` (the stream's first and only frame). | `client/features/miniapp/application/miniapp-workflows.ts`; `client/features/miniapp/ui/MiniAppStandalone.public.tsx`. |
// | `WebuiMiniAppView` | Where the client frames a started Mini App: the loopback proxy's URL, with the plugin it belongs to. It never carries the Mini App's own origin, surface path or launch credential. | `openMiniApp` (`server/operation/handlers/miniapp.ts`, from `server/miniapp/proxy.ts` `viewUrl`). | `shared/operation-names.ts`; unverified — no importer yet; the panel that frames `viewUrl` is a later slice of the same work. |

/**
 * A Mini App's runtime state, as the runtime names it.
 *
 * Kept a closed union rather than a string: the picker decides whether to offer
 * "open" or "stop" from this field, and an unrecognised value would silently
 * become one of those two decisions.
 */
export type WebuiMiniAppRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

/**
 * One catalogue row.
 *
 * `runtime.kind` is present because a Mini App's runtime is a process here and
 * the panel reads the kind before the status; a second kind would be a different
 * surface, not another status.
 */
export interface WebuiMiniAppSummary {
  readonly pluginId: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly iconUrl?: string;
  /**
   * Whether the runtime may start this package.
   *
   * Absent means "the runtime lists only startable packages", which is what the
   * older read answered. `false` marks a row from the installed listing — a Mini
   * App the person disabled, which the catalogue offers to enable rather than to
   * open.
   */
  readonly enabled?: boolean;
  /**
   * Where the package came from.
   *
   * A local package and an official one are not changed by the same path: the
   * official one through the marketplace account, the local one on disk. The
   * row's own buttons need the source to choose, so the runtime publishes it
   * rather than leaving the surface to guess.
   */
  readonly source?: "official" | "local";
  readonly runtime: {
    readonly kind: "process";
    readonly status: WebuiMiniAppRuntimeStatus;
    readonly errorCode?: string;
    readonly ownership?: "other-client";
    readonly ownerClient?: string;
  };
}

/** The catalogue `listMiniApps` answers with, as the runtime answers it. */
export interface WebuiMiniAppList {
  readonly miniApps: readonly WebuiMiniAppSummary[];
}

/**
 * The live presentation of one Mini App, as the service records it.
 *
 * ADR 0020's lease: the standalone document declares its plugin, session and
 * presentation when it connects, and the service keeps the record until that
 * document's socket closes. So `detached` is "a standalone lease exists for this
 * plugin right now" and `presentationRevision` counts the acquisitions so far —
 * a fast detach and release that a poll would otherwise miss still moves the
 * number.
 *
 * Produced only from that record (`server/miniapp/presentation-lease.ts`). The
 * runtime has no view of presentation, which is why these fields are not on
 * `WebuiMiniAppSummary`: an adapter filling them in would have to invent a
 * constant.
 */
export interface WebuiMiniAppPresentation {
  readonly detached: boolean;
  /** Monotonic per plugin, and unchanged by a release. `0` means never acquired. */
  readonly presentationRevision: number;
}

/** One catalogue row as the service answers it: the runtime's row and its presentation. */
export interface WebuiMiniAppCatalogueRow
  extends WebuiMiniAppSummary,
    WebuiMiniAppPresentation {}

/** The body `listMiniApps` answers with. */
export interface WebuiMiniAppCatalogue {
  readonly miniApps: readonly WebuiMiniAppCatalogueRow[];
}

/**
 * One frame of `watchMiniAppPresentation`: the lease this standalone document
 * took, and what its deep link names.
 *
 * `presentationRevision` is the lease's own revision, not the plugin's whole
 * history: a separate tab that opened and closed before this one is somebody
 * else's presentation. There is no `detached` field because this document *is* the
 * standalone presentation — the fact is the connection.
 *
 * `session` is `"ended"` only when the runtime confirmed there is no such session;
 * `"unresolved"` means lookup failed for another reason. Either way the answer is
 * reported rather than enforced: the Mini App is plugin-scoped, so a page outlives
 * the session it was opened from (ADR 0020).
 */
export interface WebuiMiniAppPresentationState {
  readonly pluginId: string;
  readonly sessionId: string;
  readonly presentationRevision: number;
  readonly session: "live" | "ended" | "unresolved";
}

/** A server-owned request for the client to show or close an agent-started app. */
export type WebuiMiniAppPresentationIntent =
  | {
      /** Changes whenever the host service process that owns the presenter changes. */
      readonly epoch: string;
      readonly revision: number;
      readonly action: "open";
      readonly sessionId: string;
      readonly pluginId: string;
    }
  | {
      /** Changes whenever the host service process that owns the presenter changes. */
      readonly epoch: string;
      readonly revision: number;
      readonly action: "close";
      readonly pluginId: string;
      readonly sessionId: string;
    };

/**
 * What `openMiniApp` hands the client: the proxy's own loopback URL.
 *
 * `viewUrl` points at the WebUI's proxy, so the document the client frames is
 * same-machine and the credential the Mini App's guard demands is injected on
 * the way out. Neither that credential nor the Mini App's real origin has any
 * place in this record.
 */
export interface WebuiMiniAppView {
  readonly pluginId: string;
  readonly viewUrl: string;
  /**
   * The presentation-and-connection generation this service issued for this start.
   *
   * The client echoes it on every page-bridge call so a request, a response, an
   * event or a cancellation produced for a replaced frame cannot land in the
   * replacement. It is this service's counter, not the runtime's: the runtime's
   * process generation stays server-side with the rest of the launch coordinates.
   *
   * Absent means the host issues no generation, and the bridge then treats the
   * view as unaddressable — no page call may act as a presentation the service
   * cannot name. That is why the field is optional and why the client defaults it
   * to `0`, the value no registered generation ever has.
   */
  readonly connection?: number;
}

// ---------------------------------------------------------------------------
// The page bridge: the composer half, over `postMessage`.
//
// ADR 0020 lists "how a page's request identifier survives the `postMessage`
// boundary" as the one open implementation question, so the answer is written
// down here rather than left to the page and the host to guess at separately:
// the page mints the request id, the host echoes it in the reply, and a reply
// that names no live request is dropped.
//
// The shapes are the shipped contract's (`@mavis/shared/miniapp-surface`): the
// failure codes and the text bound are copied rather than imported because this
// module is a wire contract the browser bundle may hold, and the shipped module
// is the runtime's. A change there is a change here, and the two constants are
// pinned together by the bridge test.
// ---------------------------------------------------------------------------

/** Absolute path on the Mini App's proxy origin that serves the bridge script. */
export const WEBUI_MINIAPP_BRIDGE_PATH = "/__miniapp/bridge.js";

/** The page's append request, page → host. */
export const WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST = "mcode:miniapp:message-append" as const;

/** The host's answer, host → page. */
export const WEBUI_MINIAPP_BRIDGE_APPEND_REPLY = "mcode:miniapp:message-append-result" as const;

/** The shipped contract's bound (`MINIAPP_COMPOSER_MAX_TEXT_LENGTH`). */
export const WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH = 100_000;

/** The shipped contract's composer failure codes, in its order. */
export type WebuiMiniAppComposerFailureCode =
  | "user_cancelled"
  | "invalid_request"
  | "text_too_large"
  | "not_allowed"
  | "target_unavailable"
  | "result_unknown";

/**
 * What the page is told about one append.
 *
 * Success acknowledges a draft append — never a sent message and never a disk
 * commit. `user_cancelled` is the person declining the confirmation, and it is a
 * refusal like any other: the page cannot tell a decline from a policy refusal
 * apart from the code, and it must not retry either.
 */
export type WebuiMiniAppComposerResult =
  | { readonly success: true }
  | { readonly success: false; readonly code: WebuiMiniAppComposerFailureCode };

/** One append request, as the page sent it. */
export interface WebuiMiniAppBridgeAppendRequest {
  readonly requestId: string;
  readonly text: string;
}

/** The host's reply for one request. */
export interface WebuiMiniAppBridgeAppendReply {
  readonly type: typeof WEBUI_MINIAPP_BRIDGE_APPEND_REPLY;
  readonly requestId: string;
  readonly result: WebuiMiniAppComposerResult;
}
