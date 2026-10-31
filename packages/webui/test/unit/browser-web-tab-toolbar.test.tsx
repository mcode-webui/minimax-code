// A web tab's toolbar: back, forward, reload, and the url as text.
//
// The toolbar is the browser business's chrome for one page, and the strip is
// not where it belongs — a workspace component drawing a foreign business's page
// chrome is the dependency rule inverted. So the toolbar is rendered by the
// browser business's published host, over the one thing a tab hands it: the
// target. That target is what makes the three presses mean anything, and it is
// the reason the commands name the page they act on.
//
// Four things are checked here, and the fourth is the one that is easy to get
// wrong:
//
//   * the three commands are there and the url is a **display**, not a field —
//     the only address box in the workspace is the new tab page's, and a second
//     one here would be a place where two answers to "where do I type a url"
//     disagree;
//   * each press builds one request on the browser family's existing command
//     operation, naming the tab's own page rather than letting the far end
//     resolve a selection that may be a different page;
//   * a refusal arrives with the runtime's own code and message, because
//     `browser_capability_denied` and `browser_target_stale` need opposite
//     responses from the person in front of them;
//   * the host that has no target — the Settings page's — carries no toolbar,
//     because a chrome row over nothing is a control that cannot work.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  WebuiBrowserCommandRequest,
  WebuiBrowserTargetId,
} from "../../src/shared/contracts/browser.js";
import {
  readBrowserCommand,
  sendBrowserCommandOperation,
} from "../../src/server/operation/browser.js";
import {
  WEBUI_BROWSER_TOOLBAR_COMMANDS,
  BrowserPanelHost,
  webuiBrowserAgentPage,
  webuiBrowserToolbarRequest,
  webuiBrowserToolbarRun,
} from "../../src/client/features/browser/ui/BrowserPanelHost.public.js";
import {
  initialWebuiBrowserPanelState,
  reduceWebuiBrowserPanelState,
} from "../../src/client/features/browser/projection/browser-state.js";

const WORKSPACE_PANELS_SOURCE = readFileSync(
  new URL("../../src/client/features/workspace/ui/WorkspacePanels.tsx", import.meta.url),
  "utf8",
);
const BROWSER_PANEL_HOST_SOURCE = readFileSync(
  new URL("../../src/client/features/browser/ui/BrowserPanelHost.public.tsx", import.meta.url),
  "utf8",
);

const PAGE: WebuiBrowserTargetId = {
  surface: "isolated-chromium",
  browserId: "isolated-1",
  targetId: "target-1",
  generation: 7,
};

/** A send that records what it was asked to send. */
function recordingSend(): {
  readonly send: (request: WebuiBrowserCommandRequest) => Promise<unknown>;
  readonly requests: WebuiBrowserCommandRequest[];
} {
  const requests: WebuiBrowserCommandRequest[] = [];
  return {
    requests,
    send: async (request) => {
      requests.push(request);
      return { accepted: true };
    },
  };
}

describe("a web tab's toolbar", () => {
  it("carries back, forward, reload, home and the url", () => {
    const markup = renderToStaticMarkup(
      <BrowserPanelHost target={PAGE} url="https://example.com/one" canGoBack={false} canGoForward={false} />,
    );

    for (const command of WEBUI_BROWSER_TOOLBAR_COMMANDS) {
      expect(markup).toContain(`data-testid="browser-toolbar-${command}"`);
    }
    expect(markup).toContain('data-testid="browser-toolbar-home"');
    expect(markup).toContain('data-testid="browser-toolbar-back" disabled=""');
    expect(markup).toContain('data-testid="browser-toolbar-forward" disabled=""');
    expect(markup).toContain('data-testid="browser-toolbar-url"');
    expect(markup).toContain("https://example.com/one");
  });

  it("shows an editable address field seeded with the current url", () => {
    const markup = renderToStaticMarkup(
      <BrowserPanelHost target={PAGE} url="https://example.com/one" />,
    );
    const toolbar = markup.slice(markup.indexOf('data-testid="browser-toolbar"'));
    const toolbarMarkup = toolbar.slice(0, toolbar.indexOf('data-testid="browser-panel"'));

    // The current tab's address field submits a target-bound navigation.
    expect(toolbarMarkup).toContain("https://example.com/one");
    const address = toolbarMarkup.match(/<input[^>]*data-testid="browser-toolbar-url"[^>]*>/)?.[0];
    expect(address).toContain('type="text"');
    expect(address).toContain('value="https://example.com/one"');
    expect(address).not.toContain("disabled");
    expect(toolbarMarkup).not.toContain("<textarea");
    expect(toolbarMarkup).not.toContain("contenteditable");
    expect(toolbarMarkup).not.toContain("data-testid=\"webui-workspace-launcher-url\"");
  });

  it("names the page the Agent is on, and says nothing when it is the one in front", () => {
    // Two actors, two pages: the one in front and the one the Agent is on. The
    // row says which is which, and it is a report — the strip owns the choice
    // of tab, and nothing here moves the Agent's page.
    const agent: WebuiBrowserTargetId = { ...PAGE, targetId: "target-2" };
    const state = reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
      type: "targets-loaded",
      list: {
        surface: "isolated-chromium",
        targets: [
          { id: PAGE, title: "In front", url: "https://example.com/one", status: "open", selected: false },
          { id: agent, title: "Agent page", url: "https://example.com/two", status: "open", selected: true },
        ],
      },
      selected: agent,
    });

    expect(webuiBrowserAgentPage(state)).toBe("Agent page");

    // A run that has selected nothing has no page to name.
    expect(webuiBrowserAgentPage(initialWebuiBrowserPanelState)).toBeUndefined();
  });

  it("is carried by the browser business's host, over the tab's target", () => {
    // The toolbar is rendered by the host the panel mounts, and the panel hands
    // it one tab's own target and url — so the row and the frame describe the
    // same page rather than a pair that has drifted. That tab is the one the
    // panel kept mounted, which is the one whose frame the reader is looking at.
    expect(WORKSPACE_PANELS_SOURCE).toContain("canGoBack={browserTab.content.canGoBack}");
    expect(WORKSPACE_PANELS_SOURCE).toContain("canGoForward={browserTab.content.canGoForward}");
    expect(WORKSPACE_PANELS_SOURCE).toContain('type: "return-web-tab-to-launcher"');
  });

  it("reloads the target list when the viewed tab or its page generation changes", () => {
    // A tab can move to a new page without the host or surface changing. Its
    // target prop then carries the new generation; the list must be refreshed
    // too, or the frame can render while input stays disabled because the list
    // still only knows the previous generation.
    expect(BROWSER_PANEL_HOST_SOURCE).toContain(
      "[port, refreshTargets, surface, targetProp]",
    );
  });

  it("sends one command naming the page the tab holds", async () => {
    const { send, requests } = recordingSend();

    await webuiBrowserToolbarRun({ send, target: PAGE, command: "back" });

    expect(requests).toEqual([
      { surface: "isolated-chromium", command: "back", target: PAGE },
    ]);
  });

  it("names the tab's page for every command, and never a selection", () => {
    for (const command of WEBUI_BROWSER_TOOLBAR_COMMANDS) {
      const request = webuiBrowserToolbarRequest(PAGE, command);
      // The surface comes off the target rather than being typed again, so the
      // command cannot name a surface the page is not on.
      expect(request.surface).toBe(PAGE.surface);
      expect(request.target).toEqual(PAGE);
      expect(request.command).toBe(command);
      expect(request).not.toHaveProperty("runId");
      expect(request).not.toHaveProperty("url");
    }
  });

  it("passes a refusal out with the code and message the runtime gave it", async () => {
    // The bridge's answer and the target's answer need opposite responses, so
    // neither is flattened into a generic failure on the way to the panel.
    const send = async (): Promise<unknown> => {
      throw { code: "browser_capability_denied", message: "隔离浏览器未授权。" };
    };

    await expect(
      webuiBrowserToolbarRun({ send, target: PAGE, command: "reload" }),
    ).rejects.toMatchObject({
      code: "browser_capability_denied",
      message: "隔离浏览器未授权。",
    });
  });

  it("says so when the runtime does not wire the command at all", async () => {
    // An absent member means the host does not wire the browser family. That is
    // stated rather than discovered by calling, and it is never a silent
    // success — a press that went nowhere has to say it went nowhere.
    await expect(
      webuiBrowserToolbarRun({ send: undefined, target: PAGE, command: "forward" }),
    ).rejects.toMatchObject({ code: "browser_provider_unavailable" });
  });

  it("carries no toolbar on a host that has no page to show", () => {
    // The Settings page mounts the same host with no target. A chrome row over
    // nothing would be three controls that cannot work.
    const markup = renderToStaticMarkup(<BrowserPanelHost />);

    expect(markup).toContain('data-testid="browser-panel-host"');
    expect(markup).not.toContain('data-testid="browser-toolbar"');
  });
});

describe("the command operation's target", () => {
  it("accepts the request a toolbar press makes", () => {
    const validated = sendBrowserCommandOperation.validate(webuiBrowserToolbarRequest(PAGE, "back"));

    expect(validated.ok).toBe(true);
  });

  it("refuses a target that is not a whole identity", () => {
    // A half identity would be acted on by a page the caller never named, so it
    // is malformed at the edge rather than resolved somewhere downstream.
    const { generation: _generation, ...withoutGeneration } = PAGE;
    const validated = sendBrowserCommandOperation.validate({
      surface: PAGE.surface,
      command: "reload",
      target: withoutGeneration,
    });

    expect(validated).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("still reads a request that names no target as a selection", () => {
    // The Agent's tools send no target, and their meaning is unchanged: a run's
    // selection, or the panel's own cell.
    expect(readBrowserCommand({ surface: PAGE.surface, command: "navigate", runId: "run-1" })).toEqual({
      surface: PAGE.surface,
      command: "navigate",
      params: {},
      runId: "run-1",
    });
    expect(
      readBrowserCommand({ ...webuiBrowserToolbarRequest(PAGE, "forward") }),
    ).toMatchObject({ target: PAGE, command: "forward" });
  });
});
