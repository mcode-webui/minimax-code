// The Browser Core transport over the isolated Chromium's DevTools connection.
//
// What this is: the adapter that lets the provider-neutral Browser Core drive
// the page this process already owns. Browser Core owns the *semantics* —
// element references, snapshots, action deadlines, effect validation — and
// reaches the browser through the `BrowserTransport` contract. This module
// supplies that contract over the CDP connection the provider already holds.
//
// Why it exists: before this adapter, the provider answered a restricted
// browser-tool action by translating it into a raw DevTools method. That
// worked for the handful of actions that are one CDP call wide (`navigate`,
// `reload`, `screenshot`) and could not work for the rest: `click` and `type`
// take an opaque element reference, and turning one into a coordinate needs
// the element map, the retained snapshot and the generation check that only
// Browser Core has. The provider refused those actions rather than guessing
// where a click should land.
//
// What it does NOT do:
//
//   - It does not own the browser process, the connection or the pages. The
//     provider owns those, and the panel's own surface (targets, generations,
//     screencast frames) is answered from the provider's accounting, not from
//     here. This adapter is a *view* of one page for the core's purposes.
//   - It does not decide which action may run. That is the service's and the
//     authorization's job; the core refuses an action it does not implement,
//     and the service refuses one the surface may not perform.
//
// The connection is the provider's, so the adapter holds it rather than
// opening one of its own: two connections to one DevTools endpoint would mean
// two independent protocol views of the same browser, and the core's
// generation would then disagree with the panel's about the same page.

import type {
  BrowserAttachedFrame,
  BrowserEvaluateOptions,
  BrowserTransport,
  BrowserTransportCommandOptions,
  BrowserTransportEvent,
  BrowserTransportEventListener,
} from "@mavis/browser-core";

import { browserOperationError } from "../errors.js";
import type { WebuiBrowserCdpConnection } from "./cdp-connection.js";

/**
 * One page of the isolated Chromium, addressed the way Browser Core addresses
 * a page: a flattened CDP session.
 */
export interface WebuiCoreTransportPage {
  /** The flattened CDP session that addresses this page. */
  readonly sessionId: string;
  /** The target this page is known by, for error messages. */
  readonly targetId: string;
}

/**
 * The Browser Core transport over one page of the isolated Chromium.
 *
 * The provider creates one per page, because Browser Core models a session as
 * a single page: the element map, the retained snapshot and the generation
 * are facts about one document, and a second page in the same browser has its
 * own.
 */
export class WebuiIsolatedChromiumCoreTransport implements BrowserTransport {
  /**
   * The session this page is addressed with.
   *
   * Browser Core uses it to tell an event about this page from an event about
   * another one: a navigation whose session is not this one is not this
   * page's navigation, and treating it as one would raise the generation for
   * a page that did not navigate.
   */
  readonly sessionId: string;

  constructor(
    private readonly connection: WebuiBrowserCdpConnection,
    private readonly page: WebuiCoreTransportPage,
  ) {
    this.sessionId = page.sessionId;
  }

  /**
   * Sends one DevTools command to this page.
   *
   * The session id is the page's, unless the caller addresses another one:
   * Browser Core sends a few commands to a frame's own session (an OOPIF),
   * and the page's session is the right default for everything else.
   *
   * The failure is translated into the core's own vocabulary on the way out.
   * The core reads the code to decide what an interruption means: a cancelled
   * command did not happen, while a timed-out one may still be running in the
   * browser and is the only kind that may require the connection to be reset.
   * The WebUI's codes say the same thing in their own words, but the core
   * reads the core's words, and an untranslated timeout would be taken for an
   * ordinary failure — the one kind of failure that must not reset the
   * connection.
   */
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T> {
    try {
      return await this.connection.send<T>(method, params, sessionId ?? this.page.sessionId, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch (error) {
      throw toCoreTransportError(error);
    }
  }

  /**
   * Evaluates an expression in the page's main execution context.
   *
   * `Runtime.evaluate` is a DevTools command, so this is a `send` with the
   * result unpacked. The exception details are turned into a failure rather
   * than returned: an expression that threw has no value, and a caller that
   * received `undefined` would read it as a successful evaluation of
   * `undefined`.
   */
  async evaluate<T = unknown>(
    expression: string,
    options: BrowserEvaluateOptions = {},
  ): Promise<T> {
    const payload = await this.send<Record<string, unknown>>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true,
        userGesture: options.userGesture ?? true,
      },
      undefined,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
    const exception = payload.exceptionDetails;
    if (exception && typeof exception === "object") {
      const details = exception as Record<string, unknown>;
      throw new Error(String(details.text ?? "Page evaluation failed"));
    }
    const result = payload.result;
    if (!result || typeof result !== "object") return undefined as T;
    const remote = result as Record<string, unknown>;
    if ("value" in remote) return remote.value as T;
    if (remote.unserializableValue === "undefined") return undefined as T;
    return remote.description as T;
  }

  /**
   * Evaluates in every attached frame.
   *
   * The isolated Chromium attaches no out-of-process frames: it drives the
   * page it launched and does not enable auto-attach for frames. So the one
   * frame is the page's own context, and the answer is a single-element list.
   * The core reads this as "the frames this page can address", and a probe
   * that must include OOPIFs would see that there are none.
   */
  async evaluateInAllFrames<T = unknown>(
    expression: string,
    options: BrowserEvaluateOptions = {},
  ): Promise<readonly T[]> {
    return [await this.evaluate<T>(expression, options)];
  }

  /** The attached frames of this page. The isolated Chromium attaches none. */
  listAttachedFrames(): readonly BrowserAttachedFrame[] {
    return [];
  }

  /**
   * Subscribes to the DevTools events of this page.
   *
   * The events are filtered to this page's session. The connection carries the
   * events of every page in the browser, and a core that saw another page's
   * navigation would treat it as its own: it raises the generation and
   * invalidates the references it holds, so a page that never navigated would
   * lose its references because a sibling tab moved.
   *
   * A browser-level event carries no session id, and it belongs to every
   * page: `Target.targetDestroyed` and the like are how the provider learns
   * that a page is gone, and a page that is gone must be seen by its own core
   * as well.
   */
  onEvent(listener: BrowserTransportEventListener): () => void {
    return this.connection.onEvent((event) => {
      if (event.sessionId !== undefined && event.sessionId !== this.page.sessionId) {
        return;
      }
      listener({
        method: event.method,
        params: event.params,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      });
    });
  }

  /**
   * Waits for one DevTools event, or for the deadline.
   *
   * A deadline that passes resolves with `undefined` rather than rejecting:
   * the core uses this to wait for a frame that may never arrive, and a
   * rejection would turn "it did not happen" into "the browser is broken".
   */
  waitForEvent(
    method: string,
    timeoutMs = 5_000,
    options?: Pick<BrowserTransportCommandOptions, "signal">,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      const unsubscribe = this.onEvent((event: BrowserTransportEvent) => {
        if (event.method !== method) return;
        finish(event.params);
      });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const finish = (value: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(value);
      };
      const onAbort = (): void => finish(undefined);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
    });
  }

  /**
   * Starts the page.
   *
   * The page is already attached and its `Page` domain already enabled by the
   * time the core sees it, so there is nothing left to start. The core calls
   * this before its first action; answering it truthfully is what keeps the
   * core from tearing the page down and rebuilding it.
   */
  start(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Stops the page's loading.
   *
   * `Page.stopLoading` is what the core expects here: it is the command that
   * makes a navigation settle, and it is the same one the core's own
   * navigation detection waits for.
   */
  async stopLoading(): Promise<void> {
    try {
      await this.send("Page.stopLoading", {});
    } catch (error) {
      // A page that has already gone cannot be stopped. The core is
      // unwinding a cancelled action, and the page's own absence is already
      // the answer.
      if (isConnectionGone(error)) return;
      throw error;
    }
  }

  /**
   * Resets the protocol connection without closing the page.
   *
   * The core calls this after a command timed out or was cancelled, because
   * a late command may still reach Chromium. The isolated Chromium keeps one
   * connection for the whole browser, so the connection cannot be replaced
   * without replacing every page's — which is what closing the browser would
   * do. The page therefore survives a reset; what does not survive is the
   * core's certainty about it, and the core handles that itself.
   */
  resetConnection(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Closes the page.
   *
   * The page is a web tab of this browser, and closing it is the provider's
   * decision: the provider knows whether the page is the launch page and what
   * the panel is showing. The core calls this when a session is torn down,
   * and the answer is that the page stays — the provider closes the browser
   * when it closes, and the pages go with it.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Whether an error says the connection or the page is gone.
 *
 * The isolated Chromium's own error codes are used, so a page that was closed
 * underneath a cancelled action reads as "gone" rather than as a failure of
 * the action itself.
 */
function isConnectionGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException & { code?: string }).code;
  if (code === "browser_provider_unavailable" || code === "browser_target_unknown") return true;
  return error.message.includes("DevTools connection is closed");
}

/**
 * Translates a WebUI browser error into the core's interruption vocabulary.
 *
 * The core decides what an interruption means by its code, and the three it
 * knows are: the action was cancelled, the action ran out of time, or the
 * transport is gone. The WebUI's own codes say the same three things, so the
 * translation is a renaming rather than a judgement.
 *
 * An error the translation does not recognise is passed through unchanged. A
 * failure the core does not know about is an ordinary failure to it, and
 * making it look like an interruption would reset a connection that is fine.
 */
function toCoreTransportError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as NodeJS.ErrnoException & { code?: string }).code;
  const translated =
    code === "browser_operation_cancelled"
      ? "ABORTED"
      : code === "browser_operation_timeout"
        ? "BROWSER_OPERATION_TIMEOUT"
        : code === "browser_provider_unavailable"
          ? "BROWSER_TRANSPORT_CLOSED"
          : undefined;
  if (!translated) return error;
  return Object.assign(new Error(error.message), { code: translated, cause: error });
}

/**
 * The error a transport raises when the browser is not there.
 *
 * Exported so the provider can answer the same way: a page that cannot be
 * driven because the browser is gone is one condition, not two, and the
 * service's error handling reads it from the code.
 */
export function webuiCoreTransportUnavailable(targetId: string): Error {
  return browserOperationError(
    "browser_provider_unavailable",
    `The isolated Chromium is not running, so the page ${targetId} cannot be driven.`,
    true,
  );
}
