// The browser settings, moved from under the browser panel to the Settings page.
//
// The migration is the subject here, and it has three halves that can be
// checked without a DOM:
//
//   1. The switches and the bridge key are **gone from the panel**. A setting
//      that stays in both places is two answers to one question, and the one
//      nobody edits is the one that drifts.
//   2. They are **their own tab** — 浏览器, under 偏好 and below 个性化 —
//      because a setting that lives in a panel is a setting nobody finds
//      without opening that panel first.
//   3. They are rendered through the settings page's own skeleton rather than
//      through the panel's chrome, so they read as settings.
//
// The owner underneath is checked too, because it is what makes the two
// surfaces agree: the panel reads the authorization the settings page writes,
// and a refused write has to put the switch back where the host left it.

import { describe, expect, it } from "vitest";
import { useMemo } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  type WebuiBrowserAuthorization,
} from "../../src/shared/contracts/browser.js";
import type { BrowserPort } from "../../src/client/features/browser/contracts/browser-port.js";
import { createWebuiBrowserAuthorizationOwner } from "../../src/client/features/browser/application/browser-authorization.js";
import { BrowserPanelHost } from "../../src/client/features/browser/ui/BrowserPanelHost.public.js";
import { BrowserSettingsPage } from "../../src/client/features/browser/ui/BrowserSettingsPage.public.js";
import { PersonalizationSettings } from "../../src/client/features/settings/ui/PersonalizationSettings.js";
import { DESKTOP_SETTINGS_TABS } from "../../src/client/features/settings/projection/settings-view.js";
import { createWebuiSettingsWorkflows } from "../../src/client/features/settings/application/settings-workflows.js";
import { WebuiSettingsWorkflowsProvider } from "../../src/client/bindings/use-query-state.js";

/** The settings page's own owner, so the 个性化 page renders as it does in the app. */
function PersonalizationHost() {
  const workflows = useMemo(
    () => createWebuiSettingsWorkflows({ port: {} as never }),
    [],
  );
  return (
    <WebuiSettingsWorkflowsProvider workflows={workflows}>
      <PersonalizationSettings />
    </WebuiSettingsWorkflowsProvider>
  );
}

describe("the browser panel no longer carries the settings", () => {
  it("shows the panel and nothing else", () => {
    // A static render of the host without a port: the panel says the browser
    // family is not wired, and the switches are not there at all.
    const markup = renderToStaticMarkup(<BrowserPanelHost />);

    expect(markup).toContain('data-testid="browser-panel-host"');
    expect(markup).not.toContain('data-testid="browser-authorization-surfaces"');
    expect(markup).not.toContain('data-testid="browser-authorization-full-cdp"');
    expect(markup).not.toContain('data-testid="browser-installation-key"');
  });
});

describe("the settings nav carries a 浏览器 tab", () => {
  it("puts it under 偏好, below 个性化", () => {
    const preferences = DESKTOP_SETTINGS_TABS.filter((tab) => tab.group === "preferences");
    const browser = preferences.find((tab) => tab.key === "browser");
    const personalization = preferences.find((tab) => tab.key === "custom-instructions");

    expect(browser?.label).toBe("浏览器");
    expect(browser?.icon).toBe("browser");
    expect(personalization).toBeDefined();
    expect(preferences.indexOf(browser!)).toBeGreaterThan(preferences.indexOf(personalization!));
  });

  it("is reachable by its own name in the settings search", () => {
    // The search filters on the label and the key, so a tab the search cannot
    // find is a tab nobody opens.
    const browser = DESKTOP_SETTINGS_TABS.find((tab) => tab.key === "browser");

    expect(browser?.label).toContain("浏览器");
  });
});

describe("the 浏览器 page carries the settings", () => {
  it("renders the switches and the bridge key", () => {
    const markup = renderToStaticMarkup(<BrowserSettingsPage />);

    expect(markup).toContain('data-testid="browser-authorization-surfaces"');
    expect(markup).toContain('data-testid="browser-authorization-full-cdp"');
    expect(markup).toContain('data-testid="browser-installation-key"');
    // The section is named as a setting, not as a browser: it sits under
    // 偏好 among the person's other preferences.
    expect(markup).toContain("浏览器设置");
  });

  it("renders them through the settings page's own skeleton", () => {
    // The same section and row components every other settings page uses, so
    // the browser settings sit in the page's card treatment rather than in a
    // second style of their own.
    const markup = renderToStaticMarkup(<BrowserSettingsPage />);

    expect(markup).toContain('class="webui-settings-page"');
    expect(markup).toContain('class="webui-settings-section"');
    expect(markup).toContain('class="webui-settings-card"');
    expect(markup).toContain("webui-settings-row");
  });

  it("keeps every switch out of reach until a read gives them a baseline", () => {
    // The provider is not mounted here, so no host has said anything about the
    // four switches. A switch with no baseline is disabled rather than off.
    const markup = renderToStaticMarkup(<BrowserSettingsPage />);

    for (const id of [
      "browser-authorization-isolated-chromium",
      "browser-authorization-edge",
      "browser-authorization-chrome",
      "browser-authorization-full-cdp",
    ]) {
      expect(markup).toMatch(new RegExp(`<button[^>]*data-testid="${id}"[^>]*disabled=""`, "u"));
    }
  });
});

describe("the 个性化 page no longer carries the browser settings", () => {
  it("keeps the browser business's settings out of this business's page", () => {
    // The browser switches are their own tab. Leaving them here as well would
    // put the same control in two places, and the one nobody edits drifts.
    const markup = renderToStaticMarkup(<PersonalizationHost />);

    expect(markup).toContain("记忆");
    expect(markup).not.toContain('data-testid="browser-authorization-surfaces"');
    expect(markup).not.toContain('data-testid="browser-installation-key"');
  });
});

describe("the browser authorization owner", () => {
  const authorized: WebuiBrowserAuthorization = {
    ...WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
    edge: true,
  };

  it("publishes what the host says once the read lands", async () => {
    const owner = createWebuiBrowserAuthorizationOwner({
      port: { getBrowserAuthorization: () => Promise.resolve(authorized) },
    });

    expect(owner.getSnapshot().status).toBe("idle");
    await owner.load();

    expect(owner.getSnapshot().status).toBe("ready");
    expect(owner.getSnapshot().authorization).toEqual(authorized);
  });

  it("reads once for two callers that ask together", async () => {
    // The panel and the settings page mount in different trees and can ask in
    // the same moment; the host should not be asked twice for one answer.
    let reads = 0;
    const owner = createWebuiBrowserAuthorizationOwner({
      port: {
        getBrowserAuthorization: () => {
          reads += 1;
          return Promise.resolve(authorized);
        },
      },
    });

    await Promise.all([owner.load(), owner.load()]);

    expect(reads).toBe(1);
  });

  it("writes one switch and leaves the other three alone", async () => {
    const written: unknown[] = [];
    const owner = createWebuiBrowserAuthorizationOwner({
      port: {
        getBrowserAuthorization: () => Promise.resolve(authorized),
        setBrowserAuthorization: (change) => {
          written.push(change);
          return Promise.resolve({ ...authorized, chrome: true });
        },
      },
    });
    await owner.load();

    await owner.toggle({ surface: "chrome", enabled: true });

    expect(written).toEqual([{ chrome: true }]);
    expect(owner.getSnapshot().authorization).toEqual({ ...authorized, chrome: true });
  });

  it("puts the switch back where the host left it when the write is refused", async () => {
    const owner = createWebuiBrowserAuthorizationOwner({
      port: {
        getBrowserAuthorization: () => Promise.resolve(authorized),
        setBrowserAuthorization: () => Promise.reject(new Error("refused")),
      },
    });
    await owner.load();

    await owner.toggle({ surface: "chrome", enabled: true });

    expect(owner.getSnapshot().authorization).toEqual(authorized);
    expect(owner.getSnapshot().error).toContain("refused");
  });

  it("reads a partial answer as off rather than as unknown", async () => {
    // A host that answers with one switch has authorized that one and nothing
    // else. Publishing the answer verbatim would leave the other three
    // `undefined`, and a switch with an undefined state renders without an
    // `aria-checked` of its own — which says nothing about what it is.
    const owner = createWebuiBrowserAuthorizationOwner({
      port: {
        getBrowserAuthorization: () => Promise.resolve({ edge: true } as never),
      },
    });

    await owner.load();

    expect(owner.getSnapshot().authorization).toEqual({
      isolatedChromium: false,
      edge: true,
      chrome: false,
      fullCdp: false,
    });
  });

  it("reports a host that does not wire the browser family as unwritten", async () => {
    const owner = createWebuiBrowserAuthorizationOwner({ port: {} });

    await owner.load();

    expect(owner.getSnapshot().canWrite).toBe(false);
    expect(owner.getSnapshot().canReadInstallationKey).toBe(false);
    // Nothing was read, so nothing was said: the switches stay unclaimed
    // rather than being reported as off.
    expect(owner.getSnapshot().status).toBe("idle");
  });

  it("keeps the panel's port out of its own reach", () => {
    // The owner asks for three calls, not for the whole browser port: the
    // panel's target listing and frame stream are its own business.
    const port: BrowserPort = {
      getBrowserAuthorization: () => Promise.resolve(WEBUI_BROWSER_AUTHORIZATION_DEFAULT),
      setBrowserAuthorization: () => Promise.resolve(WEBUI_BROWSER_AUTHORIZATION_DEFAULT),
      getBrowserInstallationKey: () =>
        Promise.resolve({ present: false, surface: "edge", reason: "not_provisioned" }),
      listBrowserTargets: () => Promise.resolve({ surface: "isolated-chromium", targets: [] }),
    };
    const owner = createWebuiBrowserAuthorizationOwner({ port });

    expect(Object.keys(owner).sort()).toEqual([
      "getSnapshot",
      "load",
      "readInstallationKey",
      "subscribe",
      "toggle",
    ]);
  });
});
