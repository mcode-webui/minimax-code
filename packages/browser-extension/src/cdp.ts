// DevTools commands the extension is willing to send on the bridge's behalf.
//
// `chrome.debugger` exposes only a **subset** of the DevTools domains, and the
// subset differs from what a raw CDP client can do. The host is therefore not
// allowed to name an arbitrary method and have the extension try it: the
// extension sends only the commands listed here, and refuses anything else
// with a reason.
//
// Two things make this list trustworthy rather than hopeful:
//
//   * it is an **explicit** constant, so a method that is not listed is
//     refused before any browser call is made; and
//   * Chrome's own answer is still the authority — a command that is listed but
//     that this browser's build refuses comes back as a refusal with Chrome's
//     own message, not as a success.
//
// The list covers what Browser Use actually needs: reading a page, evaluating
// against it, and driving it.
//
// The list is what the **Browser Core** needs, not what this extension would
// like to be able to do. Browser Core is the layer that turns an opaque
// element reference into a coordinate, that keeps a reference from outliving
// the document it was taken from, and that reports what a page is made of. It
// reaches all of that through the DevTools domains below, so a command that is
// not listed is a command the Browser Use on this surface cannot work
// without.
//
// The surface the extension drives is the person's own browser, so the list
// stays as narrow as the work needs: every entry is one the Browser Core's
// action path calls, and nothing is listed for a capability that only the
// isolated Chromium — which this process launches and owns, and which can
// therefore be driven directly — needs.
//
// One capability is deliberately absent: `Page.captureScreenshot`. The
// extension's live image stream is how the panel shows a tab, and it goes
// through `chrome.tabs.captureVisibleTab`, which can only capture the tab
// the person is currently looking at in a window that is in front. A
// DevTools screenshot has no such limit — it would capture any tab, including
// the ones the person is not looking at. That is a different thing from
// showing them a tab they opened, and it is not a capability the Browser Core
// needs in order to act on a page: it needs to see the page, and the page's
// own geometry is read from the DOM.

/**
 * The DevTools commands the extension will send.
 *
 * Chrome documents the `chrome.debugger` API's supported domains at
 * <https://developer.chrome.com/docs/extensions/reference/api/debugger>. The
 * commands below are drawn from the domains it lists — Accessibility, DOM,
 * DOMDebugger, DOMSnapshot, Emulation, Fetch, Input, Log, Network, Page,
 * Runtime — and each is one that the browser's own documentation lists as
 * supported.
 */
export const WEBUI_BROWSER_BRIDGE_CDP_COMMANDS: ReadonlySet<string> = new Set([
  // Reading the page.
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getOuterHTML",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getAttributes",
  "DOM.getFrameOwner",
  "DOM.resolveNode",
  "DOM.pushNodesByBackendIdsToFrontend",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "DOMDebugger.getEventListeners",
  "DOMSnapshot.captureSnapshot",
  "DOMSnapshot.enable",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.releaseObject",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Network.enable",
  // Driving the page.
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.dispatchTouchEvent",
  // Navigating it.
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.stopLoading",
  // The network, read-only.
  "Network.getCookies",
  "Network.getResponseBody",
  // The surface the page is shown on.
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setScrollbarsHidden",
  // Diagnostics.
  "Log.enable",
  "Console.enable",
  "Fetch.enable",
  "Fetch.disable",
]);

/** The outcome of one dispatched DevTools command. */
export type WebuiBrowserBridgeCdpOutcome =
  | { readonly accepted: true; readonly result: unknown }
  | {
      readonly accepted: false;
      readonly error: string;
      /**
       * Whether the method is outside the extension's supported subset.
       *
       * It is reported separately from a transport failure because the two
       * mean different things to the host: an unsupported method will never
       * work, while a failure may.
       */
      readonly unsupported?: boolean;
    };

/** The tab the extension is talking to. */
export interface WebuiBrowserBridgeCdpTarget {
  readonly tabId: number;
}

export interface WebuiBrowserBridgeCdpDispatcherOptions {
  /**
   * The debugger API.
   *
   * It is the same interface the input dispatcher uses, so the extension has
   * one attach/send path rather than two that could disagree.
   */
  readonly debugger: WebuiBrowserBridgeDebuggerApi;
  /** The protocol version the extension attaches with. */
  readonly version: string;
}

/**
 * The dispatcher the bridge's DevTools commands go through.
 *
 * It attaches once per tab and keeps the attachment, because attaching and
 * detaching around every command would make a sequence of commands racy
 * against a page that is moving.
 */
export interface WebuiBrowserBridgeCdpDispatcher {
  dispatch(
    target: WebuiBrowserBridgeCdpTarget,
    method: string,
    params: Record<string, unknown>,
  ): Promise<WebuiBrowserBridgeCdpOutcome>;
}

import type { WebuiBrowserBridgeDebuggerApi } from "./input.js";

export function createWebuiBrowserBridgeCdpDispatcher(
  options: WebuiBrowserBridgeCdpDispatcherOptions,
): WebuiBrowserBridgeCdpDispatcher {
  const attached = new Map<number, Promise<void>>();

  function attachOnce(tabId: number): Promise<void> {
    const existing = attached.get(tabId);
    if (existing) return existing;
    const attaching = options.debugger.attach({ tabId }, options.version);
    attached.set(tabId, attaching);
    return attaching;
  }

  return {
    async dispatch(target, method, params) {
      if (!WEBUI_BROWSER_BRIDGE_CDP_COMMANDS.has(method)) {
        // Refused before any browser call: the point of the list is that the
        // host cannot ask for something the extension will not do.
        return {
          accepted: false,
          error: `the extension does not support the DevTools command "${method}"`,
          unsupported: true,
        };
      }
      try {
        await attachOnce(target.tabId);
      } catch (error) {
        attached.delete(target.tabId);
        return {
          accepted: false,
          error: `the extension could not attach to the tab: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      try {
        const result = await options.debugger.sendCommand({ tabId: target.tabId }, method, params);
        return { accepted: true, result };
      } catch (error) {
        return {
          accepted: false,
          error: `the browser refused the DevTools command "${method}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}
