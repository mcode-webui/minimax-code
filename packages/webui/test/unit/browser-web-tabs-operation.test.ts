// The web-tab operations: the snapshot the strip reconciles against, and the
// call that opens a page for the person — plus the places they have to be
// registered.
//
// A new operation is not registered by adding a name. The browser family's
// readiness is declared in the capability manifest, the name reaches the
// operation-name constants, the operation registry, the server's handler
// table, the port and its binding, and the transport's request table — and
// every one of those is a place where a change that is forgotten shows up as
// a missing capability rather than as an error.
//
// So this file is the executable form of that list: it names every site and
// asserts the operation is there. A site that loses the operation fails
// here rather than in a panel that quietly shows no tabs.

import { describe, expect, it } from "vitest";

import { createWebuiTransport } from "../../src/client/platform/transport.js";
import { createWebuiPortSlices } from "../../src/client/application/port-slices.js";
import { WEBUI_CAPABILITY_REGISTRY_PROOFS } from "../../src/shared/capability-manifest.js";
import {
  OPEN_BROWSER_WEB_TAB_OPERATION_NAME,
  WATCH_BROWSER_WEB_TABS_OPERATION_NAME,
  WEBUI_STREAM_OPERATION_NAMES,
} from "../../src/shared/operation-names.js";
import {
  openBrowserWebTabOperation,
  watchBrowserWebTabsOperation,
  closeBrowserWebTabOperation,
} from "../../src/server/operation/browser.js";
import { createBrowserHandlerEntries } from "../../src/server/operation/handlers/browser.js";
import { createOperationRegistry } from "../../src/server/operation/operations.js";
import { WebuiBrowserService } from "../../src/runtime/browser/browser-service.js";
import type { WebuiBrowserPort } from "../../src/runtime/port.js";
import type { WebuiBrowserAuthorization } from "../../src/shared/contracts/browser.js";

/** A port that answers nothing; the registry only asks whether it is wired. */
const inertBrowserPort = {} as unknown as WebuiBrowserPort;

const AUTHORIZATION_OFF: WebuiBrowserAuthorization = {
  isolatedChromium: false,
  edge: false,
  chrome: false,
  fullCdp: false,
};

describe("the web-tab snapshot operation", () => {
  it("is named in the operation-name constants", () => {
    expect(WATCH_BROWSER_WEB_TABS_OPERATION_NAME).toBe("watchBrowserWebTabs");
  });

  it("is a stream, and not a unary operation", () => {
    expect(WEBUI_STREAM_OPERATION_NAMES).toContain(WATCH_BROWSER_WEB_TABS_OPERATION_NAME);
  });

  it("is on the browser family's ready list in the capability manifest", () => {
    // The ready list is what the handshake derives from: an operation that is
    // not wired makes the whole browser family `not-ready` rather than absent,
    // so putting it here is a promise the other sites have to keep.
    expect(WEBUI_CAPABILITY_REGISTRY_PROOFS.browser.ready).toContain(
      WATCH_BROWSER_WEB_TABS_OPERATION_NAME,
    );
  });

  it("is registered in the operation registry", () => {
    const registry = createOperationRegistry(
      {} as never,
      undefined,
      inertBrowserPort,
    );
    expect(registry.has(WATCH_BROWSER_WEB_TABS_OPERATION_NAME)).toBe(true);
  });

  it("is registered for the close of a web tab", () => {
    // The close is the other half of the open: a tab the person closes must
    // not leave a page running in the browser, and the only way to reach the
    // runtime's close is an operation.
    expect(closeBrowserWebTabOperation.name).toBe("closeBrowserWebTab");
    const registry = createOperationRegistry({} as never, undefined, inertBrowserPort);
    expect(registry.has(closeBrowserWebTabOperation.name)).toBe(true);
    expect(
      createBrowserHandlerEntries(inertBrowserPort).has(closeBrowserWebTabOperation.name),
    ).toBe(true);
  });

  it("is in the server's handler table", () => {
    const entries = createBrowserHandlerEntries(inertBrowserPort);
    expect(entries.has(watchBrowserWebTabsOperation.name)).toBe(true);
  });

  it("is a member of the browser port, and of the service behind it", () => {
    // A compile-time assertion: a member that is not on `WebuiBrowserPort`
    // cannot be bound, so this line is the proof that the port carries the
    // operation. The runtime check is that the service behind the port
    // answers it.
    const portCarriesTheOperation: "watchWebTabs" extends keyof WebuiBrowserPort
      ? true
      : false = true;
    expect(portCarriesTheOperation).toBe(true);

    const service = new WebuiBrowserService({
      authorization: {
        read: async () => AUTHORIZATION_OFF,
        write: async () => AUTHORIZATION_OFF,
      },
      dataDir: "/tmp/webui-web-tabs-operation-test",
    });
    expect(typeof service.watchWebTabs).toBe("function");
  });

  it("is in the transport's request table", () => {
    const transport = createWebuiTransport({
      websocketUrl: "ws://127.0.0.1:1",
      token: "test-token",
      webSocket: { send: () => undefined, close: () => undefined } as never,
    });
    expect(typeof transport.watchBrowserWebTabs).toBe("function");
  });

  it("reaches the browser slice of the client's port", () => {
    const slices = createWebuiPortSlices({
      watchBrowserWebTabs: () => () => undefined,
    } as never);
    expect(typeof slices.browser?.watchBrowserWebTabs).toBe("function");
  });
});

describe("the operation that opens a page for the person", () => {
  it("is named in the operation-name constants and promised on the ready list", () => {
    expect(OPEN_BROWSER_WEB_TAB_OPERATION_NAME).toBe("openBrowserWebTab");
    expect(WEBUI_CAPABILITY_REGISTRY_PROOFS.browser.ready).toContain(
      OPEN_BROWSER_WEB_TAB_OPERATION_NAME,
    );
  });

  it("is registered in the operation registry and in the server's handler table", () => {
    const registry = createOperationRegistry({} as never, undefined, inertBrowserPort);
    expect(registry.has(OPEN_BROWSER_WEB_TAB_OPERATION_NAME)).toBe(true);
    expect(createBrowserHandlerEntries(inertBrowserPort).has(openBrowserWebTabOperation.name)).toBe(
      true,
    );
  });

  it("is a member of the browser port, and the transport calls it", () => {
    const portCarriesTheOperation: "openWebTab" extends keyof WebuiBrowserPort ? true : false = true;
    expect(portCarriesTheOperation).toBe(true);

    const transport = createWebuiTransport({
      websocketUrl: "ws://127.0.0.1:1",
      token: "test-token",
      webSocket: { send: () => undefined, close: () => undefined } as never,
    });
    expect(typeof transport.openBrowserWebTab).toBe("function");
    const slices = createWebuiPortSlices({ openBrowserWebTab: async () => undefined } as never);
    expect(typeof slices.browser?.openBrowserWebTab).toBe("function");
  });

  it("refuses a request with no url rather than opening a blank page", () => {
    expect(openBrowserWebTabOperation.validate({ runId: "run-1" })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(openBrowserWebTabOperation.validate({ url: "   " }).ok).toBe(false);
    expect(openBrowserWebTabOperation.validate({ url: "https://example.test" }).ok).toBe(true);
  });

  it("asks the port for the page the person typed, declaring the person's side of it", async () => {
    // The port member is the one the Agent's `open_tab` reaches. What differs is
    // the last argument: this operation is the person's side, so the page joins
    // the run's selection only through the runtime's one bootstrap rather than
    // replacing whatever the run was working on.
    const asked: { runId?: string; params?: Record<string, unknown>; opener?: string }[] = [];
    const port = {
      openWebTab: async (
        runId?: string,
        params?: Record<string, unknown>,
        _signal?: AbortSignal,
        opener?: string,
      ) => {
        asked.push({ runId, params, opener });
        return {
          accepted: true,
          target: {
            surface: "isolated-chromium",
            browserId: "browser-1",
            targetId: "tab-1",
            generation: 1,
          },
        };
      },
    } as unknown as WebuiBrowserPort;

    const handler = createBrowserHandlerEntries(port).get(openBrowserWebTabOperation.name);
    const result = await handler?.handle(
      { requestId: "request-1" } as never,
      { url: "https://example.test" },
    );

    expect(asked).toEqual([
      { runId: undefined, params: { url: "https://example.test" }, opener: "person" },
    ]);
    expect(result).toMatchObject({ body: { accepted: true } });
  });

  it("passes the run the workspace named, so the runtime can apply the bootstrap", async () => {
    // The workspace knows its session, and the session id is the run id the rest
    // of the browser port already uses. Naming it is what lets the runtime decide
    // the bootstrap; the client never decides it.
    const asked: { runId?: string; opener?: string }[] = [];
    const port = {
      openWebTab: async (
        runId?: string,
        _params?: Record<string, unknown>,
        _signal?: AbortSignal,
        opener?: string,
      ) => {
        asked.push({ runId, opener });
        return {
          accepted: true,
          target: {
            surface: "isolated-chromium",
            browserId: "browser-1",
            targetId: "tab-1",
            generation: 1,
          },
        };
      },
    } as unknown as WebuiBrowserPort;

    const handler = createBrowserHandlerEntries(port).get(openBrowserWebTabOperation.name);
    await handler?.handle(
      { requestId: "request-2" } as never,
      { runId: "session-1", url: "https://example.test" },
    );

    expect(asked).toEqual([{ runId: "session-1", opener: "person" }]);
  });

  it("gets the same refusal as the Agent when the surface's switch is off", async () => {
    // This is the property the two paths share: both reach `openWebTab`, so a
    // surface that is switched off refuses both of them the same way — before
    // any provider is asked for a page.
    let providerAsked = false;
    const service = new WebuiBrowserService({
      authorization: {
        read: async () => AUTHORIZATION_OFF,
        write: async () => AUTHORIZATION_OFF,
      },
      dataDir: "/tmp/webui-open-web-tab-operation-test",
      createIsolatedProvider: async () => {
        providerAsked = true;
        throw new Error("the browser must not be launched for a refused request");
      },
    });

    await expect(
      service.openWebTab(undefined, { url: "https://example.test" }),
    ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
    expect(providerAsked).toBe(false);
  });
});
