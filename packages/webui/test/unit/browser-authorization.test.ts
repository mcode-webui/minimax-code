import { describe, expect, it } from "vitest";

import {
  browserSwitchForSurface,
  defaultBrowserAuthorization,
  isBrowserCommandAllowed,
  isBrowserSurfaceUsable,
  normalizeBrowserAuthorization,
} from "../../src/runtime/browser/authorization.js";
import {
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  type WebuiBrowserAuthorization,
} from "../../src/shared/contracts/browser.js";

/**
 * The restricted command set ordinary Browser Use may send. A command outside
 * it needs the Full CDP switch.
 */
const RESTRICTED = ["navigate", "click", "type", "screenshot"] as const;

describe("browser authorization", () => {
  it("defaults every switch off", () => {
    const authorization = defaultBrowserAuthorization();
    expect(authorization).toEqual({
      isolatedChromium: false,
      edge: false,
      chrome: false,
      fullCdp: false,
    });
    expect(authorization).toEqual(WEBUI_BROWSER_AUTHORIZATION_DEFAULT);
  });

  it("reads a missing or partial answer as off", () => {
    expect(normalizeBrowserAuthorization(undefined)).toEqual({
      isolatedChromium: false,
      edge: false,
      chrome: false,
      fullCdp: false,
    });
    // A host that answers with one switch has authorized that one and nothing
    // else. Defaulting the missing keys to true would turn an incomplete
    // answer into a grant.
    expect(
      normalizeBrowserAuthorization({ edge: true } as Partial<WebuiBrowserAuthorization>),
    ).toEqual({
      isolatedChromium: false,
      edge: true,
      chrome: false,
      fullCdp: false,
    });
  });

  it("reads anything that is not exactly true as off", () => {
    expect(
      normalizeBrowserAuthorization({
        isolatedChromium: "true",
        edge: 1,
        chrome: null,
        fullCdp: undefined,
      } as unknown as Partial<WebuiBrowserAuthorization>),
    ).toEqual({
      isolatedChromium: false,
      edge: false,
      chrome: false,
      fullCdp: false,
    });
  });

  it("gates each surface on its own switch", () => {
    const authorization: WebuiBrowserAuthorization = {
      isolatedChromium: true,
      edge: false,
      chrome: false,
      fullCdp: false,
    };
    expect(isBrowserSurfaceUsable(authorization, "isolated-chromium")).toBe(true);
    expect(isBrowserSurfaceUsable(authorization, "edge")).toBe(false);
    expect(isBrowserSurfaceUsable(authorization, "chrome")).toBe(false);
  });

  it("does not let Full CDP authorize a surface", () => {
    const authorization: WebuiBrowserAuthorization = {
      isolatedChromium: false,
      edge: false,
      chrome: false,
      fullCdp: true,
    };
    // Full CDP widens an authorized surface; it never authorizes one.
    expect(isBrowserSurfaceUsable(authorization, "isolated-chromium")).toBe(false);
    expect(isBrowserSurfaceUsable(authorization, "edge")).toBe(false);
    expect(isBrowserSurfaceUsable(authorization, "chrome")).toBe(false);
  });

  it("allows the restricted command set whatever the Full CDP switch says", () => {
    const off: WebuiBrowserAuthorization = {
      isolatedChromium: true,
      edge: false,
      chrome: false,
      fullCdp: false,
    };
    for (const command of RESTRICTED) {
      expect(isBrowserCommandAllowed(off, command, RESTRICTED)).toBe(true);
    }
    expect(isBrowserCommandAllowed(off, "Browser.grantPermissions", RESTRICTED)).toBe(false);
  });

  it("allows a full command only when the Full CDP switch is on", () => {
    const on: WebuiBrowserAuthorization = {
      isolatedChromium: true,
      edge: false,
      chrome: false,
      fullCdp: true,
    };
    expect(isBrowserCommandAllowed(on, "Browser.grantPermissions", RESTRICTED)).toBe(true);
    // The restricted set is still allowed: turning Full CDP on widens the set,
    // it does not replace it.
    expect(isBrowserCommandAllowed(on, "click", RESTRICTED)).toBe(true);
  });

  it("maps every switch to the field that holds it", () => {
    expect(browserSwitchForSurface("isolated-chromium")).toBe("isolatedChromium");
    expect(browserSwitchForSurface("edge")).toBe("edge");
    expect(browserSwitchForSurface("chrome")).toBe("chrome");
    expect(browserSwitchForSurface("full-cdp")).toBe("fullCdp");
  });
});
