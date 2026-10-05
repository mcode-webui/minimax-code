// Unit tests for the pre-React-root boot failure surface.
//
// `main.tsx` owns two boot checks that run BEFORE `createRoot().render()`:
// the `#webui-root` mount node and the `__WEBUI_CONFIG__` runtime config.
// Both used to be bare `throw`s, and no error boundary can catch them — the
// boundary is mounted BY the render those throws prevented, so either failure
// was a white page. `WebuiStartupFallback` is the surface `main.tsx` renders
// instead.
//
// This suite pins the two halves the node environment can reach:
//   * the surface itself — human sentence, technical reason, one action —
//     through `renderToStaticMarkup`;
//   * the `main.tsx` wiring — that neither cause throws anymore, that both
//     render the fallback, and that the happy path still only runs when both
//     preconditions hold.
// The browser-verified half (a served page with a missing config actually
// painting the surface) is recorded in the PR that added this, with
// screenshots; the fixture harness always injects a config, so covering it
// here would mean standing up a deliberately-broken server in the shared
// suite.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiStartupFallback } from "../../src/client/components/StartupFallback.js";

const MAIN_SOURCE = readFileSync(
  new URL("../../src/client/main.tsx", import.meta.url),
  "utf8",
);

describe("WebuiStartupFallback", () => {
  const render = (over: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(WebuiStartupFallback, {
        reason: "WebUI runtime configuration is missing (__WEBUI_CONFIG__)",
        detail: "页面没有拿到启动所需的连接配置，通常是服务端启动异常。",
        onReload: () => {},
        ...over,
      }),
    );

  it("says something a human can act on, in a sentence", () => {
    const markup = render();
    expect(markup).toContain("页面未能启动");
    expect(markup).toContain("页面没有拿到启动所需的连接配置");
    // An alert, so assistive tech announces the boot failure rather than
    // leaving a silent blank document.
    expect(markup).toContain('role="alert"');
  });

  it("shows the technical cause verbatim, not just in the console", () => {
    // Same rule as the error boundary's fallback: on a machine where the page
    // never booted there is no console guarantee, and this line is the only
    // place the cause survives.
    const markup = render({ reason: "WebUI mount node #webui-root is missing" });
    expect(markup).toContain("WebUI mount node #webui-root is missing");
    expect(markup).toContain('data-testid="webui-startup-fallback-reason"');
  });

  it("offers exactly one action: load the page again", () => {
    const markup = render();
    expect(markup).toContain("刷新重试");
    expect(markup).toContain('data-testid="webui-startup-fallback-reload"');
    // One button, not a menu of speculative fixes — a reload is the only
    // action that can cure both causes (a torn-down document, a server that
    // failed to inject the config).
    expect(markup.match(/<button/gu) ?? []).toHaveLength(1);
  });
});

describe("main.tsx boot wiring", () => {
  it("no longer throws for a missing mount node or a missing config", () => {
    // The white-page bug this closes: both pre-render `throw`s. A bare
    // `throw new Error("WebUI …")` at module top level cannot be caught by
    // the boundary, the browser, or the user.
    expect(MAIN_SOURCE).not.toContain('throw new Error("WebUI mount node');
    expect(MAIN_SOURCE).not.toContain('throw new Error("WebUI runtime configuration');
  });

  it("renders the startup surface for either cause", () => {
    expect(MAIN_SOURCE).toContain("<WebuiStartupFallback");
    // Both causes carry their own reason string, so the surface can say which
    // one fired instead of a generic "failed to start".
    expect(MAIN_SOURCE).toContain('"WebUI mount node #webui-root is missing"');
    expect(MAIN_SOURCE).toContain(
      '"WebUI runtime configuration is missing (__WEBUI_CONFIG__)"',
    );
  });

  it("reloads the page from the fallback's action", () => {
    // The one recovery the surface offers has to actually be the reload.
    expect(MAIN_SOURCE).toContain("onReload={() => location.reload()}");
  });

  it("keeps the happy path gated on both boot preconditions", () => {
    // The guard is one branch over both checks, and the app render (the
    // `createRoot(rootElement)` path) lives inside it — loosening either
    // side reintroduces a crash the boundary still cannot catch.
    const guardAt = MAIN_SOURCE.indexOf("if (!rootElement || !config)");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    const renderAt = MAIN_SOURCE.indexOf("root.render(");
    expect(renderAt).toBeGreaterThan(guardAt);
    // And the fallback branch never constructs a transport with a config it
    // does not have: the happy path's transport stays inside the else.
    const transportAt = MAIN_SOURCE.indexOf("createWebuiTransport(runtimeConfig)");
    expect(transportAt).toBeGreaterThan(guardAt);
  });
});
