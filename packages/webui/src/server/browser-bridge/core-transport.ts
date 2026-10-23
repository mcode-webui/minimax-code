// The Browser Core transport over the browser bridge.
//
// What this is: the adapter that lets the provider-neutral Browser Core drive
// a tab of the person's own browser, over the bridge's existing DevTools
// command channel. Browser Core owns the *semantics* — element references,
// retained snapshots, action deadlines — and reaches the browser through the
// `BrowserTransport` contract; this module supplies that contract over the
// bridge.
//
// The bridge is not a DevTools connection, and that shapes what this adapter
// can be:
//
//   * A command is a request and an answer, not a session. The extension
//     answers one `cdp` frame with one `cdp-result` frame, and the registry
//     serializes the commands of one tab. So there is no session to address:
//     the transport sends to the tab it was made for.
//
//   * There is no event channel. The extension does not forward the DevTools
//     events, and adding one would change the protocol the extension and the
//     host are pinned to. So this adapter cannot report a navigation the way
//     the isolated Chromium's transport does, by listening for
//     `Page.frameNavigated`.
//
// The navigation is reported a different way. The extension **owns** the
// generation of a tab and raises it on each committed top-level navigation,
// and it announces that generation in its `targets` frame. The host sees the
// generation move, and a moved generation is a navigation. That is what
// `synchronizeGeneration` is for: it invalidates the core's references after
// a navigation the core itself did not observe.
//
// The two are not the same mechanism, and the difference matters: the
// isolated Chromium's generation rises when the main frame navigates, while
// the extension's rises when a top-level document is committed. A navigation
// that never commits — one that is cancelled, or that fails — moves neither.
// What both agree on is the moment that matters: a reference recorded before
// the document behind the tab was replaced is stale afterwards, and must be
// refused rather than acted on.
//
// What this adapter does NOT do:
//
//   - It does not decide which action may run. That is the service's and the
//     authorization's job.
//   - It does not open or close tabs. `chrome.debugger` cannot open a page in
//     the person's browser, so `open_tab` is refused on this surface.
//   - It does not report frame-level events. The extension's debugger
//     exposes a tab, not the frames inside it, so a command that names a
//     frame's own session cannot be routed and is refused.
//
// The surface is not the isolated Chromium, and it cannot do everything the
// isolated Chromium can. Two actions are outside it:
//
//   - `screenshot` needs `Page.captureScreenshot`, which the extension
//     deliberately does not run: it could capture a tab the person is not
//     looking at. The extension's own image stream is how the panel shows a
//     tab, and it can only capture the tab in front.
//   - `upload_files` needs a file chooser the extension does not intercept.
//
// Both are refused by name when they are asked for — the extension answers
// that it does not support the DevTools command — rather than approximated. A
// screenshot of the wrong tab, or a file that went somewhere else, would be
// worse than a refusal that says which capability is missing.

import type {
  BrowserAttachedFrame,
  BrowserEvaluateOptions,
  BrowserTransport,
  BrowserTransportCommandOptions,
  BrowserTransportEvent,
  BrowserTransportEventListener,
} from "@mavis/browser-core";

/**
 * The one command the bridge can run for a tab.
 *
 * The bridge's registry owns the routing — which session owns which tab, and
 * the refusal of an unknown or stale target — so the adapter asks the
 * registry rather than addressing a tab itself.
 */
export interface WebuiBridgeCoreCommandRunner {
  /**
   * Runs one DevTools command against a tab and returns its result.
   *
   * A command that did not run comes back as a failure: the registry refuses
   * a target the session no longer owns, and the extension refuses a method
   * outside its supported subset. Both are facts about the command, and the
   * core needs to see them.
   */
  run(targetId: string, generation: number, method: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * The Browser Core transport over one tab of the bridged browser.
 *
 * One per tab, because the core models a session as a single document: the
 * element map, the retained snapshot and the generation are facts about one
 * document, and a second tab has its own.
 */
export class WebuiBridgeCoreTransport implements BrowserTransport {
  /**
   * The tab this transport drives.
   *
   * The core reads it to tell a frame event from a page event, and to refuse
   * an event that belongs to another tab. The bridge has no frame sessions,
   * so the tab's own identity is the whole session.
   */
  readonly sessionId: string;

  constructor(
    private readonly runner: WebuiBridgeCoreCommandRunner,
    private readonly tab: {
      readonly targetId: string;
      /**
       * The tab's current generation.
       *
       * It is read on every command rather than captured, because the
       * extension raises it when the document behind the tab is replaced. A
       * captured generation would make every command after a navigation
       * address a page that no longer exists, and the registry would refuse
       * it as stale — which is the right refusal for the wrong reason.
       */
      readonly currentGeneration: () => number;
    },
  ) {
    this.sessionId = tab.targetId;
  }

  /**
   * Sends one DevTools command to this tab.
   *
   * The failure is translated into the core's own vocabulary on the way out.
   * The core reads the code to decide what an interruption means: a cancelled
   * command did not happen, while a timed-out one may still be running in the
   * browser and is the only kind that may require the connection to be reset.
   * An untranslated timeout would be taken for an ordinary failure — the one
   * kind of failure that must not reset anything.
   */
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T> {
    if (sessionId !== undefined && sessionId !== this.sessionId) {
      // The bridge addresses tabs, not frames. A command that names another
      // session cannot be routed, and routing it to this tab would run it on
      // the wrong page.
      throw Object.assign(
        new Error(`The browser bridge cannot address the session ${sessionId}`),
        { code: "BROWSER_TRANSPORT_CLOSED" },
      );
    }
    if (options?.signal?.aborted) {
      throw Object.assign(new Error("ABORTED: Browser action was cancelled"), {
        code: "ABORTED",
      });
    }
    try {
      return (await this.runner.run(
        this.tab.targetId,
        this.tab.currentGeneration(),
        method,
        params,
      )) as T;
    } catch (error) {
      throw toCoreTransportError(error);
    }
  }

  /**
   * Evaluates an expression in the tab's main execution context.
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
    const payload = await this.send<Record<string, unknown>>("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: options.userGesture ?? true,
    });
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
   * The bridge's debugger exposes the tab, not the frames inside it, so the
   * one frame is the tab's own context. A probe that must include an
   * out-of-process frame would see that there are none.
   */
  async evaluateInAllFrames<T = unknown>(
    expression: string,
    options: BrowserEvaluateOptions = {},
  ): Promise<readonly T[]> {
    return [await this.evaluate<T>(expression, options)];
  }

  /** The attached frames of this tab. The bridge attaches none. */
  listAttachedFrames(): readonly BrowserAttachedFrame[] {
    return [];
  }

  /**
   * Subscribes to the DevTools events of this tab.
   *
   * The bridge carries no DevTools events, so this subscription never fires.
   * It is answered with an empty subscription rather than left undefined,
   * because the core calls it to learn when a navigation replaced the
   * document — and on this surface that fact arrives through the
   * generation instead.
   */
  onEvent(_listener: BrowserTransportEventListener): () => void {
    return () => undefined;
  }

  /**
   * Waits for one DevTools event, or for the deadline.
   *
   * There are no events to wait for, so this resolves with `undefined` once
   * the deadline passes. The core uses this to wait for a frame that may
   * never arrive, and a rejection would turn "it did not happen" into "the
   * browser is broken".
   */
  async waitForEvent(
    _method: string,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return undefined;
  }

  /**
   * Starts the tab.
   *
   * The extension is already attached to the tab, so there is nothing left to
   * start. The core calls this before its first action; answering it
   * truthfully is what keeps the core from tearing the tab down and
   * rebuilding it.
   */
  start(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Stops the tab's loading.
   *
   * `Page.stopLoading` is what the core expects here: it is the command that
   * makes a navigation settle.
   */
  async stopLoading(): Promise<void> {
    try {
      await this.send("Page.stopLoading", {});
    } catch (error) {
      // A tab that has gone cannot be stopped. The core is unwinding a
      // cancelled action, and the tab's own absence is already the answer.
      if (isTargetGone(error)) return;
      throw error;
    }
  }

  /**
   * Resets the protocol connection without closing the tab.
   *
   * The core calls this after a command timed out or was cancelled, because
   * a late command may still reach the browser. The bridge's connection to
   * the extension is the session's, not this tab's, so it cannot be replaced
   * without dropping the whole session — which would take every other tab
   * with it. The tab therefore survives a reset; what does not survive is the
   * core's certainty about it, and the core handles that itself.
   */
  resetConnection(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Closes the tab.
   *
   * The tab belongs to the person's browser, and closing it is the person's
   * business: the extension's debugger can detach from a tab but must not
   * close it. The core calls this when a session is torn down, and the answer
   * is that the tab stays.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Whether an error says the tab or the session is gone.
 *
 * The bridge's own codes are used, so a tab that was closed underneath a
 * cancelled action reads as "gone" rather than as a failure of the action.
 */
function isTargetGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException & { code?: string }).code;
  if (code === "browser_target_unknown" || code === "browser_target_stale") return true;
  if (code === "BROWSER_TRANSPORT_CLOSED") return true;
  return error.message.includes("is not registered");
}

/**
 * Translates a bridge error into the core's interruption vocabulary.
 *
 * The core decides what an interruption means by its code, and the three it
 * knows are: the action was cancelled, the action ran out of time, or the
 * transport is gone. The bridge's codes say the same three things in their
 * own words, so the translation is a renaming rather than a judgement.
 *
 * An error the translation does not recognise is passed through unchanged. A
 * failure the core does not know about is an ordinary failure to it, and
 * making it look like an interruption would reset something that is fine.
 */
function toCoreTransportError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as NodeJS.ErrnoException & { code?: string }).code;
  const translated =
    code === "browser_operation_cancelled"
      ? "ABORTED"
      : code === "browser_operation_timeout"
        ? "BROWSER_OPERATION_TIMEOUT"
        : code === "browser_provider_unavailable" || code === "browser_target_unknown"
          ? "BROWSER_TRANSPORT_CLOSED"
          : undefined;
  if (!translated) return error;
  return Object.assign(new Error(error.message), { code: translated, cause: error });
}
