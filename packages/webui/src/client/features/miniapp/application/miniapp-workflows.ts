// The Mini App business's owner.
//
// Everything this client knows about Mini Apps that is not layout: the
// catalogue, the view each Mini App is presented in, why a view was cleared, and
// the refusals a start earned. ADR 0020 puts it here rather than in the plugin
// catalogue (whose lifetime is installing packages) or the workspace panel
// (whose lifetime is layout), because the state is per session and the protocol
// is its own.
//
// Framework-free: no React, no DOM, no `window`. A component reads the snapshot
// and submits these commands; a test drives the same commands against a scripted
// port.
//
// Two rules the state exists to enforce:
//
//   * A refused start is a fact about a row, not a toast. The refusal is kept
//     under the plugin id it was about, so the catalogue's apps area and the
//     launcher's picker — two surfaces, one listing — both show it.
//   * A stopped runtime clears the view and says why, and nothing starts again
//     on its own. Only `open` starts a Mini App, and only a person calls it.

import { webuiPluginFailureText } from "../../../projection/common/plugin-failure-text.js";
import type { PluginPort } from "../../plugins/contracts/plugin-port.js";
import { createWebuiPluginActions } from "../../plugins/contracts/plugin-actions.js";
import type {
  WebuiMiniAppCatalogue,
  WebuiMiniAppCatalogueRow,
  WebuiMiniAppPresentationIntent,
} from "../../../../shared/contracts/miniapp.js";
import type {
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentCallResponse,
  WebuiMiniAppAgentTurnFrame,
  WebuiMiniAppAgentTurnRequest,
} from "../../../../shared/contracts/miniapp-agent.js";
import type { MiniAppPort } from "../contracts/miniapp-port.js";
import {
  webuiMiniAppPluginSource,
  webuiMiniAppRows,
  webuiMiniAppStopReason,
  type WebuiMiniAppRow,
} from "../projection/miniapp-view.js";

/** The port members this business drives: its own five, and the package lifecycle. */
export type WebuiMiniAppPortSlice = Pick<
  MiniAppPort,
  | "listMiniApps"
  | "watchMiniAppPresenter"
  | "openMiniApp"
  | "stopMiniApp"
  | "watchMiniAppPresentation"
  | "miniappStandaloneUrl"
  | "watchMiniAppAgentTurn"
  | "miniAppAgentCall"
> &
  Pick<PluginPort, "pluginManagement">;

const MINIAPP_PRESENTATION_RECONNECT_GRACE_MS = 300;

/**
 * What this client is showing for one Mini App.
 *
 * `open` carries the proxy's view URL and nothing else — not the Mini App's
 * origin, not its surface path, not the credential its guard demands. `stopped`
 * is a cleared view that remembers why, which is what the panel renders instead
 * of a dead frame.
 */
export type WebuiMiniAppPresentation =
  | { readonly kind: "opening" }
  | {
      readonly kind: "open";
      readonly viewUrl: string;
      /**
       * The generation the service issued for this start.
       *
       * Every page-bridge call echoes it, so a request from a replaced frame is
       * refused by the service rather than answered as the live one. It is the
       * client's fencing key and the server's, and it is per start, not per plugin.
       */
      readonly connection: number;
      /** Standalone lease revision observed when this connection was issued. */
      readonly presentationRevision: number;
    }
  | { readonly kind: "stopped"; readonly reason: string };

/** A structural refusal, kept under the plugin it was about. */
export interface WebuiMiniAppRefusal {
  /** The runtime's own wire code, e.g. `OWNED_ELSEWHERE`, `BUSY`. */
  readonly code: string;
  /** The runtime's own message. */
  readonly message: string;
}

export interface WebuiMiniAppListing {
  readonly rows: readonly WebuiMiniAppRow[];
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * The presentation this document holds, when it is the standalone one.
 *
 * Only a standalone page has this: it is the frame the service answered its lease
 * with, so it carries what that lease is (the revision) and what the deep link
 * named (the session, and whether the runtime still answers for it).
 */
export interface WebuiMiniAppStandalone {
  readonly pluginId: string;
  readonly sessionId: string;
  readonly presentationRevision: number;
  readonly session: "live" | "ended" | "unresolved";
}

export interface WebuiMiniAppWorkflowsState {
  readonly listing: WebuiMiniAppListing;
  /** Per plugin: the presentation this client holds. */
  readonly presentations: Readonly<Record<string, WebuiMiniAppPresentation>>;
  /** Per plugin: the last refusal a start of it earned. */
  readonly refusals: Readonly<Record<string, WebuiMiniAppRefusal>>;
  /** The plugin whose start is in flight, so its row can say so. */
  readonly opening?: string;
  /**
   * The standalone presentation this document declared, once the service answered.
   *
   * Absent on an inline client, and absent on a standalone one until the lease's
   * first frame arrives — a host that does not wire the operation never sets it,
   * and the page then renders without a presentation notice rather than refusing.
   */
  readonly standalone?: WebuiMiniAppStandalone;
  /**
   * Why the standalone lease could not be established, when it could not.
   *
   * Distinct from an absent `standalone`: that is "no answer yet", this is "the
   * host answered with a failure". Neither is reported as an ended session.
   */
  readonly standaloneFailure?: string;
  /**
   * The capability's absence, when the host has no Mini App cell at all.
   *
   * A different answer from an empty catalogue, and it is said once here rather
   * than deduced by each surface from a missing port member.
   */
  readonly unavailable?: string;
  /**
   * The Mini App session the rail is showing because a page asked to see it.
   *
   * "Shown" is a claim about the client's selection, so it is recorded only after
   * the view selected the session and the service was told. When the person
   * leaves that session this is what makes the close report possible — and a
   * session nobody shows must not stay answerable, or its permission asks wait on
   * a panel that is gone.
   */
  readonly agentShown?: WebuiMiniAppAgentPanel;
  /**
   * The presentation the page asked for, closed because the person left it.
   *
   * Kept so coming back re-reports it: the runtime denies an ask while nothing
   * shows the session, and "the rail has it selected again" is a fact only a new
   * `panelOpened` can convey. Dropped on unmount, navigation and stop, because
   * those mean the page is not coming back.
   */
  readonly agentResting?: WebuiMiniAppAgentPanel;
}

/** One Mini App session a page asked the host to show, and where it is shown. */
export interface WebuiMiniAppAgentPanel {
  readonly pluginId: string;
  readonly sessionId: string;
  readonly hostSessionId: string;
  readonly connection: number;
}

export const initialWebuiMiniAppListing: WebuiMiniAppListing = {
  rows: [],
  loading: false,
};

export const initialWebuiMiniAppWorkflowsState: WebuiMiniAppWorkflowsState = {
  listing: initialWebuiMiniAppListing,
  presentations: {},
  refusals: {},
};

/** The code a refused call carries, when it carries one. */
function refusalOf(error: unknown): WebuiMiniAppRefusal {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code)
      : "harness_error";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

export interface WebuiMiniAppWorkflows {
  readonly getSnapshot: () => WebuiMiniAppWorkflowsState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Whether the host exposes the capability at all. */
  readonly available: boolean;
  /** Follow host-owned presenter requests for the shell to enact. */
  readonly watchPresenter: (
    onFrame: (intent: WebuiMiniAppPresentationIntent) => void,
    onFailure?: (error: Error) => void,
  ) => () => void;

  /** Read the catalogue. Rows carry the runtime's state; nothing is cached by key. */
  readonly loadListing: () => Promise<void>;
  /**
   * Start one Mini App and keep its view URL.
   *
   * `false` means the start was refused: the refusal is in the snapshot under
   * this plugin id, and both surfaces render it.
   */
  readonly open: (pluginId: string) => Promise<boolean>;
  /** Reopen an inline frame after another document has replaced its connection. */
  readonly refreshInline: (pluginId: string) => Promise<void>;
  /** Stop one Mini App and clear its view, recording why. */
  readonly stop: (pluginId: string) => Promise<void>;
  /**
   * Reconcile the open views with the runtime's own answer.
   *
   * A Mini App can stop without this client asking — the process exits, the
   * agent stops it, another window stops it. The view it was shown in has to go,
   * and the reason has to be said, so this is one read plus the transitions it
   * implies. It never starts anything.
   */
  readonly syncPresentations: () => Promise<void>;

  /**
   * Present this Mini App inline, or wait for the standalone tab that holds it.
   *
   * The result is what the caller's loop does next:
   *
   *   * `"presented"` — this client now frames it (or already did), so stop asking.
   *   * `"waiting"` — a standalone presentation is live, or the catalogue could not
   *     be read. Ask again: the lease ends when that tab closes, and a fresh read
   *     is the only thing that notices.
   *   * `"blocked"` — a start was refused or the app was stopped. Restarting either
   *     is the person's act, never a timer's.
   *
   * Always a fresh catalogue read, which is the point: a view mounted while another
   * document holds the presentation has no presentation of its own for
   * `syncPresentations` to reconcile.
   */
  readonly presentInline: (
    pluginId: string,
  ) => Promise<"presented" | "waiting" | "blocked">;

  /**
   * The standalone page for one Mini App, or `undefined` when the host does not
   * wire the route.
   *
   * The URL is built by the wire because it carries the service token; a UI that
   * assembled it would have to hold the credential, which is the one thing the
   * client is never given.
   */
  readonly standaloneUrl: (input: {
    readonly pluginId: string;
    readonly sessionId: string;
  }) => string | undefined;
  /**
   * Declare this document as the standalone presentation, and hold the lease.
   *
   * Returns the release. The service ties the lease to the connection this opens,
   * so calling it is what makes `detached` true for the inline view, and the
   * release — a closed tab, an unmount — is what makes it false again.
   */
  readonly claimStandalone: (input: {
    readonly pluginId: string;
    readonly sessionId: string;
  }) => () => void;

  /**
   * One followed turn for a page: the transport is the stream, `observe` is the
   * page's own claim and travels inside the body.
   */
  readonly watchAgentTurn: (
    request: WebuiMiniAppAgentTurnRequest,
    onFrame: (frame: WebuiMiniAppAgentTurnFrame) => void,
    onFailure: (error: Error) => void,
  ) => () => void;
  /** One short call. A host without the capability answers `runtime_unavailable`. */
  readonly agentCall: (
    request: WebuiMiniAppAgentCallRequest,
  ) => Promise<WebuiMiniAppAgentCallResponse>;
  /**
   * Report that the client now shows `sessionId` for `pluginId`.
   *
   * Called after the rail has actually selected it, never on the capability call:
   * the runtime treats a shown session as answerable, so claiming it early makes
   * its asks wait on a panel that is not on screen.
   */
  readonly reportShown: (input: {
    readonly pluginId: string;
    readonly sessionId: string;
    readonly hostSessionId: string;
    readonly connection: number;
  }) => Promise<void>;
  /**
   * The selection the shell resolved.
   *
   * Leaving the shown session is the close report; staying on it changes nothing.
   * The call is idempotent because a selection can be re-announced.
   */
  readonly noteSelectedSession: (sessionId: string | undefined) => void;
  /**
   * Resolve once the client's selection is `sessionId`.
   *
   * A page's `open` becomes "shown" only when the rail has it, so the view waits
   * for the selection to land before reporting. `false` means it did not land
   * within the bound, and nothing was reported: claiming shown on a selection that
   * never happened is what leaves the runtime waiting on a panel that is not there.
   */
  readonly awaitSelection: (sessionId: string, timeoutMs?: number) => Promise<boolean>;
  /** The view is gone: nothing shows it any more, so stop counting it as shown. */
  readonly releaseShown: (pluginId: string) => void;
  /** Package lifecycle, for the catalogue's apps area. */
  readonly setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  readonly uninstall: (pluginId: string) => Promise<void>;
}

/**
 * The client's ordinary session selection, as the Mini App business follows it.
 *
 * Injected rather than discovered because selection belongs to the application
 * store, and its owner is the shell's `select` command: that is what a rail click,
 * a fork, an import and a delete all go through. A `hashchange` listener would miss
 * every one of them — the rail selects through the store and `history.replaceState`,
 * which fires no navigation event at all.
 */
export interface WebuiMiniAppSelectionSource {
  readonly current: () => string | undefined;
  /** Notified whenever the client's selection may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createWebuiMiniAppWorkflows(deps: {
  readonly port: WebuiMiniAppPortSlice;
  readonly selection?: WebuiMiniAppSelectionSource;
}): WebuiMiniAppWorkflows {
  const { port } = deps;
  const available =
    typeof port.listMiniApps === "function" &&
    typeof port.openMiniApp === "function" &&
    typeof port.stopMiniApp === "function";
  const pluginActions = createWebuiPluginActions({ pluginManagement: port.pluginManagement });
  const shownEpochs = new Map<string, number>();
  let state: WebuiMiniAppWorkflowsState = available
    ? initialWebuiMiniAppWorkflowsState
    : {
        ...initialWebuiMiniAppWorkflowsState,
        unavailable: "当前运行时没有提供 Mini App 能力。",
      };
  const listeners = new Set<() => void>();
  const refreshingInline = new Set<string>();
  /** One catalogue read at a time: a second read while one is open is that read. */
  let inFlight: Promise<WebuiMiniAppCatalogue | undefined> | undefined;

  const set = (
    update: (current: WebuiMiniAppWorkflowsState) => WebuiMiniAppWorkflowsState,
  ): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const setPresentation = (
    pluginId: string,
    presentation: WebuiMiniAppPresentation | undefined,
  ): void => {
    set((current) => {
      const presentations = { ...current.presentations };
      if (presentation) presentations[pluginId] = presentation;
      else delete presentations[pluginId];
      return { ...current, presentations };
    });
  };

  const setRefusal = (pluginId: string, refusal: WebuiMiniAppRefusal | undefined): void => {
    set((current) => {
      const refusals = { ...current.refusals };
      if (refusal) refusals[pluginId] = refusal;
      else delete refusals[pluginId];
      return { ...current, refusals };
    });
  };

  const readCatalogue = async (): Promise<WebuiMiniAppCatalogue | undefined> => {
    if (!port.listMiniApps) return undefined;
    const list = await port.listMiniApps();
    // A host that answers nothing, or something else, is an empty catalogue rather
    // than a thrown render: a panel that cannot read "no rows" takes the whole
    // workspace down with it.
    const rows = webuiMiniAppRows(Array.isArray(list?.miniApps) ? list.miniApps : []);
    set((current) => ({ ...current, listing: { rows, loading: false } }));
    return list;
  };

  const loadListing = async (): Promise<void> => {
    if (!available) return;
    set((current) => ({ ...current, listing: { ...current.listing, loading: true } }));
    try {
      inFlight = inFlight ?? readCatalogue();
      await inFlight;
    } catch (error) {
      set((current) => ({
        ...current,
        listing: { rows: current.listing.rows, loading: false, error: refusalOf(error).message },
      }));
    } finally {
      inFlight = undefined;
    }
  };

  const open = async (pluginId: string): Promise<boolean> => {
    if (!available || !port.openMiniApp) return false;
    set((current) => ({ ...current, opening: pluginId }));
    setPresentation(pluginId, { kind: "opening" });
    setRefusal(pluginId, undefined);
    try {
      const view = await port.openMiniApp({ pluginId });
      setPresentation(pluginId, {
        kind: "open",
        viewUrl: view.viewUrl,
        connection: view.connection ?? 0,
        presentationRevision: state.listing.rows.find((row) => row.pluginId === pluginId)
          ?.presentationRevision ?? 0,
      });
      // The catalogue can open a Mini App without mounting its panel view, so
      // nothing else would refresh the runtime status after a successful start.
      await loadListing();
      const revision = state.listing.rows.find((row) => row.pluginId === pluginId)?.presentationRevision;
      if (revision !== undefined) {
        const current = state.presentations[pluginId];
        if (current?.kind === "open" && current.connection === (view.connection ?? 0)) {
          setPresentation(pluginId, { ...current, presentationRevision: revision });
        }
      }
      return true;
    } catch (error) {
      const refusal = refusalOf(error);
      setPresentation(pluginId, undefined);
      setRefusal(pluginId, refusal);
      // The runtime refused to start, so the row it refused about is stale: a
      // capacity refusal names the running apps, and those names come from here.
      await loadListing();
      setRefusal(pluginId, refusal);
      return false;
    } finally {
      set((current) => {
        if (current.opening !== pluginId) return current;
        const next = { ...current };
        delete next.opening;
        return next;
      });
    }
  };

  const refreshInline: WebuiMiniAppWorkflows["refreshInline"] = async (pluginId) => {
    const current = state.presentations[pluginId];
    const row = state.listing.rows.find((candidate) => candidate.pluginId === pluginId);
    if (
      current?.kind !== "open" ||
      row?.detached ||
      state.opening === pluginId ||
      refreshingInline.has(pluginId) ||
      row === undefined ||
      row.presentationRevision <= current.presentationRevision
    ) {
      return;
    }
    refreshingInline.add(pluginId);
    try {
      const listMiniApps = port.listMiniApps;
      if (!listMiniApps) return;
      let first: WebuiMiniAppCatalogueRow | undefined;
      try {
        first = (await listMiniApps()).miniApps.find((candidate) => candidate.pluginId === pluginId);
        if (!first || first.detached || first.presentationRevision <= current.presentationRevision) return;
        await new Promise<void>((resolve) => setTimeout(resolve, MINIAPP_PRESENTATION_RECONNECT_GRACE_MS));
        const confirmed = (await listMiniApps()).miniApps.find((candidate) => candidate.pluginId === pluginId);
        // A just-disconnected standalone tab gets a short reconnect window. Only
        // reacquire when two fresh reads agree that its lease is still gone.
        if (
          !confirmed ||
          confirmed.detached ||
          confirmed.presentationRevision !== first.presentationRevision ||
          confirmed.presentationRevision <= current.presentationRevision
        ) return;
      } catch {
        // A failed confirmation says nothing about lease ownership. Leave the
        // current presentation in place; the next catalogue refresh can retry.
        return;
      }
      await open(pluginId);
    } finally {
      refreshingInline.delete(pluginId);
    }
  };

  const stop = async (pluginId: string): Promise<void> => {
    if (!available || !port.stopMiniApp) return;
    try {
      await port.stopMiniApp({ pluginId });
      setPresentation(pluginId, { kind: "stopped", reason: "运行已停止。" });
      set((current) => {
        const refusals = { ...current.refusals };
        for (const [refusedPluginId, refusal] of Object.entries(refusals)) {
          if (refusedPluginId === pluginId || refusal.code === "BUSY") {
            delete refusals[refusedPluginId];
          }
        }
        return { ...current, refusals };
      });
    } catch (error) {
      setRefusal(pluginId, refusalOf(error));
      return;
    }
    await loadListing();
  };

  const syncPresentations = async (): Promise<void> => {
    if (!available) return;
    const openPlugins = Object.entries(state.presentations)
      .filter(([, presentation]) => presentation.kind === "open")
      .map(([pluginId]) => pluginId);
    if (openPlugins.length === 0) return;
    try {
      await loadListing();
    } catch {
      // A read that failed says nothing about a view that is up; the next one does.
      return;
    }
    set((current) => {
      let presentations: Record<string, WebuiMiniAppPresentation> | undefined;
      for (const pluginId of openPlugins) {
        const row = current.listing.rows.find((candidate) => candidate.pluginId === pluginId);
        const reason = webuiMiniAppStopReason(row);
        if (!reason) continue;
        presentations = presentations ?? { ...current.presentations };
        presentations[pluginId] = { kind: "stopped", reason };
      }
      return presentations ? { ...current, presentations } : current;
    });
  };

  /**
   * The standalone page, when the wire can build one.
   *
   * `undefined` rather than a hand-built path when the member is unwired: a link
   * the client assembled itself would either omit the service token or carry one
   * this layer does not hold.
   */
  const standaloneUrl = (input: {
    readonly pluginId: string;
    readonly sessionId: string;
  }): string | undefined => port.miniappStandaloneUrl?.(input);

  /**
   * Take the standalone lease, and keep it until the returned release is called.
   *
   * The first frame is the service's answer about the lease; it is kept in the
   * snapshot so the standalone surface can say what its deep link named. Nothing
   * here starts the Mini App — the view does that, through `open`, exactly as the
   * inline one does.
   */
  const claimStandalone = (input: {
    readonly pluginId: string;
    readonly sessionId: string;
  }): (() => void) => {
    if (!available || !port.watchMiniAppPresentation) return () => undefined;
    return port.watchMiniAppPresentation(
      input,
      (frame) => {
        if (frame.pluginId !== input.pluginId) return;
        set((current) => {
          const next: WebuiMiniAppWorkflowsState = {
            ...current,
            standalone: {
              pluginId: frame.pluginId,
              sessionId: frame.sessionId,
              presentationRevision: frame.presentationRevision,
              session: frame.session,
            },
          };
          if (current.standaloneFailure === undefined) return next;
          const cleared = { ...next };
          delete cleared.standaloneFailure;
          return cleared;
        });
      },
      // A refused lease is a failure this surface reports. It is deliberately not
      // stored as `standalone.session = "ended"`: nothing here knows what the
      // session is, only that the service could not say.
      (error) => {
        set((current) => ({
          ...current,
          standaloneFailure: error.message,
        }));
      },
    );
  };

  /**
   * Present here unless another document holds it, and keep asking while it does.
   *
   * The read is the mechanism, not an optimisation: the standalone lease is
   * recorded by the service and released when that tab's socket closes, so a fresh
   * catalogue read is the only way this document can learn it is free again.
   */
  const presentInline = async (
    pluginId: string,
  ): Promise<"presented" | "waiting" | "blocked"> => {
    if (!available) return "blocked";
    const current = state;
    const existing = current.presentations[pluginId];
    if (existing?.kind === "opening") return "presented";
    // A cleared presentation or a refusal is the person's to retry, never a timer's.
    if (existing?.kind === "stopped" || current.refusals[pluginId] !== undefined) return "blocked";
    let catalogue: WebuiMiniAppCatalogue | undefined;
    try {
      catalogue = await readCatalogue();
    } catch {
      // A read that failed says nothing about the lease, and starting on a guess
      // could present a Mini App another tab is already showing. Ask again.
      return "waiting";
    }
    // A host that does not wire the catalogue has no presentation record to read,
    // so there is nothing to wait for and nothing to honour: start it, as the
    // mount always did.
    if (catalogue === undefined) return (await open(pluginId)) ? "presented" : "blocked";
    const row = catalogue.miniApps.find((candidate) => candidate.pluginId === pluginId);
    if (row?.detached === true) return "waiting";
    if (row?.runtime.status === "stopped") {
      // Terminal, and not this client's doing: the runtime is down and nobody here
      // asked it to stop, which is the cross-document case — this view was waiting
      // on another document's lease when that document stopped the app. #256's rule
      // is that a stopped runtime is reported and never reconnected without a
      // person, so the state is recorded (which is what makes the surface say why
      // and offer its own retry) and the loop ends.
      setPresentation(pluginId, { kind: "stopped", reason: "运行已停止。" });
      return "blocked";
    }
    // A local `open` may be stale after another browser document opened the
    // standalone route and replaced the server connection generation. Reopen
    // against the latest service state so this frame never keeps an obsolete id.
    return (await open(pluginId)) ? "presented" : "blocked";
  };

  /**
   * One page turn.
   *
   * A host without the member — an older client, a runtime composed without the
   * agent application — answers a documented code instead of a promise nobody
   * settles. The refusal is delivered through `onFailure` so both paths settle the
   * page's call the same way.
   */
  const watchAgentTurn: WebuiMiniAppWorkflows["watchAgentTurn"] = (request, onFrame, onFailure) => {
    if (!request.hostSessionId) {
      onFailure(Object.assign(new Error("not_permitted"), { code: "not_permitted" }));
      return () => undefined;
    }
    const watch = port.watchMiniAppAgentTurn;
    if (!watch) {
      onFailure(Object.assign(new Error("runtime_unavailable"), { code: "runtime_unavailable" }));
      return () => undefined;
    }
    return watch(request, onFrame, onFailure);
  };

  const agentCall: WebuiMiniAppWorkflows["agentCall"] = async (request) => {
    // No host session means no chat is showing this page, and the runtime refuses
    // such a caller anyway. Answering here keeps the page from waiting on a reply
    // the service would never send.
    if (!request.hostSessionId) return { ok: false, code: "not_permitted" };
    const call = port.miniAppAgentCall;
    if (!call) return { ok: false, code: "runtime_unavailable" };
    return call(request);
  };

  /**
   * Tells the runtime one panel is no longer on screen.
   *
   * Best effort by this workflow's convention: a close that cannot be delivered is
   * swallowed, because the runtime's own record is also closed by a stop, and a
   * rejected report must never become an unhandled rejection.
   */
  const closePanel = (panel: WebuiMiniAppAgentPanel): Promise<void> =>
    agentCall({
      pluginId: panel.pluginId,
      hostSessionId: panel.hostSessionId,
      connection: panel.connection,
      requestId: `panel-closed-${panel.sessionId}`,
      method: "panelClosed",
      targetSessionId: panel.sessionId,
    })
      .then(() => undefined)
      .catch(() => undefined);

  /** Forgets a remembered presentation, when it is still the one remembered. */
  const dropResting = (panel: WebuiMiniAppAgentPanel): void => {
    set((current) =>
      current.agentResting === panel ? { ...current, agentResting: undefined } : current,
    );
  };

  /** Stops counting one shown session as answerable, and says so. */
  const closeShown = async (
    shown: WebuiMiniAppAgentPanel,
    options: { readonly keep: boolean } = { keep: true },
  ): Promise<void> => {
    set((current) =>
      current.agentShown !== shown
        ? current
        : {
            ...current,
            agentShown: undefined,
            ...(options.keep ? { agentResting: shown } : {}),
          },
    );
    await closePanel(shown);
  };

  const reportShown: WebuiMiniAppWorkflows["reportShown"] = async (input) => {
    const epoch = shownEpochs.get(input.pluginId) ?? 0;
    const response = await agentCall({
      pluginId: input.pluginId,
      hostSessionId: input.hostSessionId,
      connection: input.connection,
      requestId: `panel-shown-${input.sessionId}`,
      method: "panelOpened",
      targetSessionId: input.sessionId,
    });
    // Only a session the runtime accepted is recorded: recording it on a refused
    // report would make the close report name a panel the runtime never knew about.
    if (!response.ok) return;
    const selection = deps.selection;
    if (
      (shownEpochs.get(input.pluginId) ?? 0) !== epoch ||
      (selection !== undefined && selection.current() !== input.sessionId)
    ) {
      // The view may have unmounted or the person may have moved on while the
      // service accepted this report. Withdraw it before a permission ask can be
      // routed to a page that is no longer present.
      await closePanel(input);
      return;
    }
    set((current) => ({ ...current, agentShown: input, agentResting: undefined }));
  };

  /**
   * Report a resting presentation again, because the person selected it.
   *
   * The one report that makes a Mini App session's asks answerable while the rail
   * has it. Guarded against a burst of store notifications: the owner notifies on
   * every snapshot change, and a second `panelOpened` per tick is noise.
   */
  let reopening = false;
  const reopen = async (resting: WebuiMiniAppAgentPanel): Promise<void> => {
    if (reopening) return;
    reopening = true;
    try {
      let response: Awaited<ReturnType<typeof agentCall>>;
      try {
        response = await agentCall({
          pluginId: resting.pluginId,
          hostSessionId: resting.hostSessionId,
          connection: resting.connection,
          requestId: `panel-shown-${resting.sessionId}`,
          method: "panelOpened",
          targetSessionId: resting.sessionId,
        });
      } catch {
        // A transport failure is handled like a refusal: the claim could not be
        // made, and keeping the record would re-ask on every store notification
        // with no better chance. A page that still wants it can open it again.
        dropResting(resting);
        return;
      }
      if (!response.ok) {
        // The runtime refused to be told this session is shown — a stopped
        // runtime, a revoked generation. Keeping the record would re-ask on every
        // store notification, and nothing this client can do would succeed, so the
        // claim is dropped instead.
        dropResting(resting);
        return;
      }
      // The person may have left while the report was in flight. The runtime has
      // now been told this session is on screen, so it has to be told otherwise
      // before this client records a session nobody is looking at as shown.
      const selection = deps.selection;
      if (selection && selection.current() !== resting.sessionId) {
        await closePanel(resting);
        return;
      }
      set((current) =>
        current.agentResting !== resting
          ? current
          : { ...current, agentShown: resting, agentResting: undefined },
      );
    } finally {
      reopening = false;
    }
  };

  const noteSelectedSession: WebuiMiniAppWorkflows["noteSelectedSession"] = (sessionId) => {
    const shown = state.agentShown;
    if (shown) {
      if (shown.sessionId === sessionId) return;
      // Leaving it withdraws the fact the runtime acts on.
      void closeShown(shown);
      return;
    }
    const resting = state.agentResting;
    // Coming back is a new claim: without it the session stays unanswerable while
    // the rail shows it, which is the state AC6 says must be answerable.
    if (resting && resting.sessionId === sessionId) void reopen(resting);
  };

  /**
   * Resolve when the client's selection is (or becomes) `sessionId`.
   *
   * A subscription rather than a poll: the owner notifies, and the answer is the
   * owner's state at that moment. The bound exists because a selection can be
   * refused elsewhere (a session that no longer exists), and waiting forever would
   * leave the page's `open` promise unsettled.
   */
  const awaitSelection: WebuiMiniAppWorkflows["awaitSelection"] = (sessionId, timeoutMs = 2_000) => {
    const selection = deps.selection;
    if (!selection) return Promise.resolve(false);
    if (selection.current() === sessionId) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      let unsubscribe: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        unsubscribe();
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      unsubscribe = selection.subscribe(() => {
        if (selection.current() === sessionId) finish(true);
      });
      timer = setTimeout(() => finish(false), timeoutMs);
      // The selection may have landed between the first read and the subscription.
      if (selection.current() === sessionId) finish(true);
    });
  };

  const releaseShown: WebuiMiniAppWorkflows["releaseShown"] = (pluginId) => {
    shownEpochs.set(pluginId, (shownEpochs.get(pluginId) ?? 0) + 1);
    const shown = state.agentShown;
    if (shown && shown.pluginId === pluginId) {
      // Nothing shows it any more and nothing is coming back, so the lease is
      // closed and forgotten rather than kept for a later selection.
      void closeShown(shown, { keep: false });
      return;
    }
    const resting = state.agentResting;
    if (resting && resting.pluginId === pluginId) {
      // A session switch unmounts its workspace tab after `noteSelectedSession`
      // has closed the shown lease. Keep that panel so selecting the session
      // again can truthfully report it shown; an unmount while it is still the
      // selected session is a real close and must not be revived later.
      const selectedSessionId = deps.selection?.current();
      if (selectedSessionId !== undefined && selectedSessionId !== resting.sessionId) {
        return;
      }
      set((current) =>
        current.agentResting === resting ? { ...current, agentResting: undefined } : current,
      );
    }
  };

  const mutatePlugin = async (
    action: "enablePlugin" | "disablePlugin" | "uninstallPlugin",
    pluginId: string,
  ): Promise<void> => {
    if (!port.pluginManagement) return;
    try {
      // The source decides the path the runtime takes: a local package is
      // changed on disk and an official one through the marketplace account.
      // Without it every mutation is read as an official one, and a local
      // package is refused with an authentication error nobody can fix.
      const source = webuiMiniAppPluginSource(
        state.listing.rows.find((row) => row.pluginId === pluginId),
      );
      await pluginActions.invoke(action, {
        pluginName: pluginId,
        ...(source === undefined ? {} : { source }),
      });
    } catch (error) {
      const refusal = refusalOf(error);
      set((current) => ({
        ...current,
        listing: {
          ...current.listing,
          error: webuiPluginFailureText({
            code: refusal.code,
            message: refusal.message,
          }),
        },
      }));
      return;
    }
    await loadListing();
  };

  // Follow the selection owner: every change either keeps the shown session or
  // closes its lease, which is the fact the runtime's approval router reads. The
  // subscription lives as long as the store and this owner do, which is the
  // application's own lifetime, so it is never released separately.
  deps.selection?.subscribe(() => {
    noteSelectedSession(deps.selection?.current());
  });

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    available,
    watchPresenter: (onFrame, onFailure) =>
      port.watchMiniAppPresenter?.(onFrame, onFailure) ?? (() => undefined),
    loadListing,
    open,
    refreshInline,
    stop,
    syncPresentations,
    presentInline,
    standaloneUrl,
    claimStandalone,
    watchAgentTurn,
    agentCall,
    reportShown,
    noteSelectedSession,
    awaitSelection,
    releaseShown,
    setPluginEnabled: (pluginId, enabled) =>
      mutatePlugin(enabled ? "enablePlugin" : "disablePlugin", pluginId),
    uninstall: (pluginId) => mutatePlugin("uninstallPlugin", pluginId),
  };
}
