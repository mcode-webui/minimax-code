// The set of live bridge sessions, per browser surface.
//
// One `BrowserBridgeRegistry` per host. It owns four pieces of state:
//
//   * A `BrowserBridgePairing` for each bridge-capable surface (`edge`,
//     `chrome`). The pairing knows the credential, the switch state and
//     the allowlist; the registry just hands it to new sessions.
//   * The set of live `BrowserBridgeSession`s. A pair surface can have
//     multiple simultaneous sessions (e.g. one for Edge and one for
//     Chrome), and even multiple sessions for the same surface if a user
//     has two Edge windows installed side by side. The registry tracks the
//     `browserId` each extension reports, not the socket, because the same
//     browser coming back through a relaunch should reuse the same id.
//   * A target-ownership table, built from the `targets` frames the
//     extensions announce. It is what decides which session a command goes
//     to, and it is the reason the registry cannot answer with "the most
//     recent session": two Edge windows are both live, both admitted, and
//     only the extension that owns a tab can act on it.
//   * A per-tab operation queue. The ADR requires concurrent operations
//     against the SAME tab to be serialized; concurrent operations
//     against DIFFERENT tabs may proceed independently. The queue is held
//     here, not in the session, because a target identity is shared across
//     sessions in principle.
//
// The registry does NOT own the WebSocketServer. Wiring code (lives in
// `service.ts` for the moment) instantiates both and feeds admissions
// into the registry. This module only knows the policies.

import { EventEmitter } from "node:events";

import type {
  WebuiBridgeBrowserSurface,
  WebuiBrowserInputCommand,
} from "../../shared/contracts/browser.js";
import type {
  WebuiBrowserBridgeInputCommand,
  WebuiBrowserBridgeTarget,
} from "../../shared/contracts/browser-bridge.js";

import { BrowserBridgePairing } from "./pairing.js";
import { BrowserBridgeSession, type BrowserBridgeCommandOutcome } from "./session.js";

/** The per-surface snapshot the surface layer can render. */
export interface BrowserBridgeRegistryStatus {
  readonly surfaces: Readonly<Record<WebuiBridgeBrowserSurface, BrowserBridgeSurfaceStatus>>;
}

export interface BrowserBridgeSurfaceStatus {
  readonly enabled: boolean;
  readonly keyId?: string;
  readonly fingerprint?: string;
  readonly sessionCount: number;
}

/** The dependencies for the registry. */
export interface BrowserBridgeRegistryOptions {
  readonly pairings: ReadonlyMap<WebuiBridgeBrowserSurface, BrowserBridgePairing>;
  /** Optional factory for `BrowserBridgeSession`s; tests inject their own. */
  readonly createSession?: (pairing: BrowserBridgePairing) => BrowserBridgeSession;
}

/**
 * Dispatch the input command to the live session that owns the named
 * target. When the session queue for that target serializes the commands
 * and another is already in flight, the new command is enqueued behind it.
 */
export type BrowserBridgeDispatch = (input: WebuiBrowserInputCommand) => Promise<BrowserBridgeCommandOutcome>;

/**
 * A raw DevTools command aimed at a target.
 *
 * It names the target the same way an input command does, so the routing, the
 * ownership check and the per-target serialization are the same ones — a
 * DevTools command must not be able to reach a tab that an input command
 * could not.
 */
export interface WebuiBrowserCdpCommand {
  readonly target: {
    readonly surface: WebuiBridgeBrowserSurface;
    readonly browserId: string;
    readonly targetId: string;
    readonly generation: number;
  };
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * The session count cap per surface. Multiple sessions are tolerated (e.g.
 * two Edge windows pairing at once), but a runaway extension cannot open
 * thousands of sockets without bound.
 */
const MAX_SESSIONS_PER_SURFACE = 16;

/**
 * A canonical string for the per-target queue. Reference equality on
 * structurally identical objects would NOT match in a Map, so we normalize
 * to a string here. The same input → the same string → the same queue.
 */
function targetKey(input: {
  readonly target: {
    readonly surface: string;
    readonly browserId: string;
    readonly targetId: string;
    readonly generation: number;
  };
}): string | undefined {
  const surface = input.target.surface;
  if (surface !== "edge" && surface !== "chrome") return undefined;
  return `${surface}\u0000${input.target.browserId}\u0000${input.target.targetId}\u0000${input.target.generation}`;
}

/**
 * The ownership-table key: the browser plus the tab, without the generation.
 *
 * The generation is deliberately not part of the key. Two generations of one
 * tab are the same claim about the same tab, and the table holds the current
 * one — a command is checked against the generation the owner holds now, not
 * against a separate row per page instance.
 */
/**
 * The key one target is owned under.
 *
 * The surface is part of the key because the instance identity alone is not
 * unique across surfaces: the same extension running in Edge and in Chrome is
 * two browsers, and one of them must not take the other's tab.
 */
function ownershipKey(
  surface: WebuiBridgeBrowserSurface,
  browserId: string,
  targetId: string,
): string {
  return `${surface}\u0000${browserId}\u0000${targetId}`;
}

/**
 * One row of the target-ownership table.
 *
 * The generation lives in the row rather than in the key because it is what
 * makes a command stale: the same tab id re-announced at a higher generation
 * is a different page, and a command recorded against the old page must not
 * be delivered to the new one.
 */
interface TargetOwnership {
  readonly session: BrowserBridgeSession;
  readonly generation: number;
}

/** Where a command may be delivered, or why it may not be delivered. */
type TargetRoute =
  | { readonly ok: true; readonly session: BrowserBridgeSession }
  | { readonly ok: false; readonly reason: string };

/**
 * Translate the typed browser command into the bridge-wire command shape.
 * The wire shape carries no surface because that is fixed by the pairing
 * the extension is bound to; the surface lives only on the host side.
 */
function toBridgeWireCommand(input: WebuiBrowserInputCommand): WebuiBrowserBridgeInputCommand {
  switch (input.kind) {
    case "pointer":
      return {
        kind: "pointer",
        targetId: input.target.targetId,
        generation: input.target.generation,
        action: input.action,
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.clickCount,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      };
    case "key":
      return {
        kind: "key",
        targetId: input.target.targetId,
        generation: input.target.generation,
        key: input.key,
        code: input.code,
        text: input.text,
        modifiers: input.modifiers,
      };
    case "text":
      return {
        kind: "text",
        targetId: input.target.targetId,
        generation: input.target.generation,
        text: input.text,
      };
  }
}

export class BrowserBridgeRegistry extends EventEmitter {
  readonly pairings: ReadonlyMap<WebuiBridgeBrowserSurface, BrowserBridgePairing>;
  private readonly sessions = new Map<string, BrowserBridgeSession>();
  /**
   * The live session per browser instance, keyed by surface and instance.
   *
   * The surface is part of the key because the instance identity alone is not
   * unique across surfaces: the same extension running in Edge and in Chrome
   * is two browsers, and one of them must not close the other because they
   * happened to report the same instance id.
   */
  private readonly sessionByBrowser = new Map<string, BrowserBridgeSession>();
  /** Per-target queue: the next dispatch waits for the previous to settle. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Who owns which tab, keyed by `(browserId, targetId)`.
   *
   * Filled only from what an extension announced for itself. A command names
   * a target; this table is what turns that name into a socket.
   */
  private readonly targetOwners = new Map<string, TargetOwnership>();

  constructor(options: BrowserBridgeRegistryOptions) {
    super();
    this.pairings = options.pairings;
  }

  /* ---------------------------------------------------------------------- */
  /* Session lifecycle                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a freshly-upgraded session with the registry. The admission
   * path constructs the `BrowserBridgeSession`; this method attaches it to
   * the bookkeeping the registry owns (close hooks, surface counts).
   */
  async registerSession(
    surface: WebuiBridgeBrowserSurface,
    browserId: string,
    session: BrowserBridgeSession,
  ): Promise<void> {
    const pairing = this.pairings.get(surface);
    if (!pairing) {
      session.close({ kind: "host_revoked" });
      throw new Error(`no pairing registered for surface "${surface}"`);
    }
    if (this.sessionByBrowser.size >= MAX_SESSIONS_PER_SURFACE) {
      session.close({ kind: "host_revoked" });
      throw new Error(`surface "${surface}" already has ${MAX_SESSIONS_PER_SURFACE} sessions`);
    }
    const browserKey = `${surface}\u0000${browserId}`;
    if (this.sessionByBrowser.has(browserKey)) {
      // Replacing a previous session for the same browser. The old session
      // is closed and the new one takes its slot.
      const prior = this.sessionByBrowser.get(browserKey);
      prior?.close({ kind: "host_revoked" });
    }
    this.sessions.set(session.sessionId, session);
    this.sessionByBrowser.set(browserKey, session);
    // The session re-emits its own `targets` frames, so the registry learns
    // ownership without the wiring code having to relay them. Announcements
    // are also accepted through `announceTargets` for a caller that already
    // holds them.
    session.on("targets", (_announcedBrowserId: string, targets: readonly WebuiBrowserBridgeTarget[]) => {
      this.announceTargets(session, targets);
    });
    session.once("closed", () => {
      if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
      if (this.sessionByBrowser.get(browserKey) === session) this.sessionByBrowser.delete(browserKey);
      this.releaseSessionTargets(session);
      this.emit("sessionClosed", { surface, browserId, sessionId: session.sessionId });
    });
    this.emit("sessionOpened", { surface, browserId, sessionId: session.sessionId });
  }

  /**
   * Record that `session` announced these targets.
   *
   * Public because the wiring code may hold an announcement before the
   * session reaches `registerSession`, and because the `targets` event
   * subscription lands here too — one writer, one set of rules.
   */
  announceTargets(
    session: BrowserBridgeSession,
    targets: readonly WebuiBrowserBridgeTarget[],
  ): void {
    for (const target of targets) {
      // A target without an identity could never be named by a command, so
      // recording it would only add a row nothing can ever match.
      if (target.browserId.length === 0 || target.targetId.length === 0) continue;
      if (!Number.isFinite(target.generation)) continue;
      // The surface comes from the session that announced the target: that is
      // the browser it belongs to. The instance identity alone is not unique
      // across surfaces, and one browser must not take another's tab.
      const owner = session.pairing?.surface;
      if (!owner) continue;
      const key = ownershipKey(owner, target.browserId, target.targetId);
      const current = this.targetOwners.get(key);
      // A higher generation is a different page behind the same tab id and
      // supersedes the earlier claim. A lower one is a late duplicate of an
      // announcement the extension has already moved past; letting it through
      // would roll the table back to a page that no longer exists.
      if (current && current.generation > target.generation) continue;
      this.targetOwners.set(key, { session, generation: target.generation });
    }
  }

  /**
   * Drop every target a closing session owned.
   *
   * Ownership is a live fact, not a record: once the socket is gone there is
   * nothing left that could answer an `input-result`, so a surviving row
   * would make the registry promise a delivery it cannot make — or hand the
   * next command to a browser that is no longer listening.
   */
  private releaseSessionTargets(session: BrowserBridgeSession): void {
    for (const [key, owner] of this.targetOwners) {
      if (owner.session === session) this.targetOwners.delete(key);
    }
  }

  /** Close every live session for a surface — used when its switch goes off. */
  closeAllForSurface(surface: WebuiBridgeBrowserSurface): void {
    for (const session of this.sessions.values()) {
      if (session.pairing?.surface === surface) {
        session.close({ kind: "host_revoked" });
      }
    }
  }

  /** Enumerate live sessions for diagnostics — no secrets. */
  snapshot(): BrowserBridgeRegistryStatus {
    const surfaces = {} as Record<WebuiBridgeBrowserSurface, BrowserBridgeSurfaceStatus>;
    const counts = new Map<WebuiBridgeBrowserSurface, number>();
    for (const session of this.sessions.values()) {
      // A registered session has named its browser, so it has a surface. One
      // that has not is not counted rather than counted under a wrong one.
      const surface = session.pairing?.surface;
      if (!surface) continue;
      const current = counts.get(surface) ?? 0;
      counts.set(surface, current + 1);
    }
    for (const [surface, pairing] of this.pairings.entries()) {
      const status = pairing.status();
      surfaces[surface] = {
        enabled: status.enabled,
        sessionCount: counts.get(surface) ?? 0,
        keyId: status.enabled ? status.credential.keyId : undefined,
        fingerprint: status.enabled ? status.credential.fingerprint : undefined,
      };
    }
    return { surfaces };
  }

  /* ---------------------------------------------------------------------- */
  /* Command dispatch                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Dispatch a command. The registry finds the session that announced the
   * target, and serializes the call behind any in-flight command for the same
   * target. Different targets — different tabs — proceed in parallel.
   *
   * A target that no live session has announced is refused rather than
   * guessed at: delivering to "the most recent session" would put a click in
   * whichever browser answered fastest, which is how a command aimed at one
   * tab ends up in another browser entirely.
   */
  /**
   * Dispatch a raw DevTools command.
   *
   * The routing, the ownership check and the per-target serialization are the
   * input path's: a DevTools command must not be able to reach a tab that an
   * input command could not, and two DevTools commands against one tab must
   * not interleave.
   */
  async dispatchCdp(input: WebuiBrowserCdpCommand): Promise<BrowserBridgeCommandOutcome> {
    const key = targetKey(input);
    const commandId = `cdp-${input.method}`;
    if (!key) {
      return {
        kind: "rejected",
        commandId,
        reason: "the command did not name a bridge surface",
      };
    }
    const route = this.resolveTargetRoute(input);
    if (!route.ok) {
      return { kind: "rejected", commandId, reason: route.reason };
    }
    const session = route.session;
    const wire = {
      targetId: input.target.targetId,
      generation: input.target.generation,
      method: input.method,
      params: input.params,
    };
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => session.sendCdp(wire));
    this.queues.set(key, next.catch(() => undefined));
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    }
  }

  async dispatch(input: WebuiBrowserInputCommand): Promise<BrowserBridgeCommandOutcome> {
    const key = targetKey(input);
    if (!key) {
      return {
        kind: "rejected",
        commandId: makeLocalId(input),
        reason: "input command did not name a bridge surface",
      };
    }
    const route = this.resolveTargetRoute(input);
    if (!route.ok) {
      return {
        kind: "rejected",
        commandId: makeLocalId(input),
        reason: route.reason,
      };
    }
    const session = route.session;
    const wire = toBridgeWireCommand(input);
    const previous = this.queues.get(key) ?? Promise.resolve();
    // The `async` wrapper around the callback is load-bearing: `then`'s
    // contract adopts the callback's return value, but the callback's inner
    // promise is *not* awaited by `.then` itself. Without the wrapper, the
    // next queue tail's `.then` would fire as soon as the callback
    // *returned* — not as soon as the bridge actually acknowledged the
    // command — and a fast sendInput would let two same-target commands
    // overlap.
    const next = previous.then(async () => session.sendInput(wire));
    // Always replace the queue tail — even rejections must serialize so a
    // misbehaving target cannot starve sibling tabs.
    this.queues.set(key, next.catch(() => undefined));
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    }
  }

  /**
   * Resolve the one session allowed to carry out a command for this target.
   *
   * Every refusal here is a refusal to guess: the target is unknown, its
   * generation has moved on, or the session that owned it is gone. Each of
   * those is knowable now, so none of them is reported as a timeout the
   * caller might retry into a different browser.
   */
  private resolveTargetRoute(input: {
    readonly target: {
      readonly surface: string;
      readonly browserId: string;
      readonly targetId: string;
      readonly generation: number;
    };
  }): TargetRoute {
    const { browserId, targetId, generation } = input.target;
    const surface =
      input.target.surface === "edge" || input.target.surface === "chrome"
        ? input.target.surface
        : undefined;
    if (!surface) {
      return {
        ok: false,
        reason: `the command named the unsupported surface "${input.target.surface}"`,
      };
    }
    const ownership = this.targetOwners.get(ownershipKey(surface, browserId, targetId));
    if (!ownership) {
      // The target may be owned on the **other** surface. Saying so is more
      // useful than "no session announced it": the caller named a real tab
      // and pointed it at the wrong browser.
      const other = surface === "edge" ? "chrome" : "edge";
      const elsewhere = this.targetOwners.get(ownershipKey(other, browserId, targetId));
      if (elsewhere) {
        return {
          ok: false,
          reason:
            `target "${browserId}/${targetId}" is owned by a "${other}" ` +
            `session but the command named surface "${surface}"`,
        };
      }
      return {
        ok: false,
        reason: `no bridge session announced target "${browserId}/${targetId}"`,
      };
    }
    if (ownership.generation !== generation) {
      return {
        ok: false,
        reason:
          `target "${browserId}/${targetId}" moved on: ` +
          `command generation ${generation}, announced generation ${ownership.generation}`,
      };
    }
    const session = ownership.session;
    if (this.sessions.get(session.sessionId) !== session) {
      // Defensive: the close hook drops ownership, so reaching here means the
      // two were updated out of order. Refusing beats delivering to a socket
      // nobody is listening on.
      return {
        ok: false,
        reason: `the session that announced target "${browserId}/${targetId}" is no longer connected`,
      };
    }
    if (session.pairing?.surface !== surface) {
      return {
        ok: false,
        reason:
          `target "${browserId}/${targetId}" is owned by a "${session.pairing?.surface ?? "unknown"}" ` +
          `session but the command named surface "${surface}"`,
      };
    }
    return { ok: true, session };
  }

  /* ---------------------------------------------------------------------- */
  /* Switch lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Turn a surface's switch on. Mints a fresh credential through the
   * pairing and closes every live session for the surface (their existing
   * key id is stale).
   */
  async enableSurface(surface: WebuiBridgeBrowserSurface): Promise<void> {
    const pairing = this.pairings.get(surface);
    if (!pairing) throw new Error(`no pairing registered for surface "${surface}"`);
    this.closeAllForSurface(surface);
    await pairing.enable();
    this.emit("surfaceEnabled", { surface });
  }

  /**
   * Re-adopt the credential this surface already had, at startup.
   *
   * The difference from `enableSurface` is the whole point: a restart must not
   * rotate the credential away from the one the extension still holds.
   */
  async restoreSurface(surface: WebuiBridgeBrowserSurface): Promise<void> {
    const pairing = this.pairings.get(surface);
    if (!pairing) throw new Error(`no pairing registered for surface "${surface}"`);
    this.closeAllForSurface(surface);
    await pairing.restore();
    this.emit("surfaceEnabled", { surface });
  }

  /**
   * Turn a surface's switch off. Revokes the credential, closes every live
   * session, and forgets pending operations.
   */
  async disableSurface(surface: WebuiBridgeBrowserSurface): Promise<void> {
    const pairing = this.pairings.get(surface);
    if (!pairing) return;
    this.closeAllForSurface(surface);
    await pairing.disable();
    this.emit("surfaceDisabled", { surface });
  }

  /**
   * Shut down the registry entirely. Closes every session and forgets
   * every queue. Used by the wiring code on host shutdown.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close({ kind: "host_revoked" });
    }
    this.sessions.clear();
    this.sessionByBrowser.clear();
    this.targetOwners.clear();
    this.queues.clear();
    for (const pairing of this.pairings.values()) {
      await pairing.disable();
    }
  }
}

/** A best-effort id for command-result correlation when the session is absent. */
function makeLocalId(input: WebuiBrowserInputCommand): string {
  // Mirror `commandIdOf` in session.ts so a "no live session" rejection has
  // the same id shape as a real command.
  switch (input.kind) {
    case "pointer":
      return `ptr:${input.target.targetId}:${input.target.generation}:${input.action ?? "click"}:${input.x},${input.y}:${input.clickCount ?? ""}:${input.deltaX ?? ""},${input.deltaY ?? ""}`;
    case "key":
      return `key:${input.target.targetId}:${input.target.generation}:${input.key}:${input.modifiers.join("+")}`;
    case "text":
      return `text:${input.target.targetId}:${input.target.generation}:${input.text}`;
  }
}
