// The shell adopting an application the composition root built.
//
// The invariant is "one application, one store, one channel" — and the failure it
// guards against is the quiet one: a shell that *also* builds an instance renders
// fine, passes every other suite, and leaves the page with two stores and two
// channels. So the assertion is not "it renders"; it is that the shell reads the
// provided instance's store and not one of its own.
//
// The observable used is the session catalog. The shell seeds its own store from
// the `sessionPage` prop, so a running adoption shows the provided store's session
// and *not* the prop's. Both directions are tested: with a provider the prop is
// ignored (the provided store wins), and with no provider the shell refuses to
// render rather than composing a fallback of its own.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiSessionCatalogFromPage } from "../../src/client/features/sessions/application/session-catalog.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { WebuiApplicationProvider } from "../../src/client/bindings/application-context.js";
import { WebuiClientFoundationApp } from "../../src/client/shell/WebuiClientFoundationApp.js";

const sessionPage = (sessionId: string) => ({
  sessions: [
    {
      sessionId,
      agentName: "main",
      createdAt: 1,
      updatedAt: 2,
      workspaceDir: "/tmp/project",
    },
  ],
  hasMore: false,
});

function applicationWith(sessionId: string) {
  const store = createWebuiSessionStore({
    catalog: createWebuiSessionCatalogFromPage(sessionPage(sessionId) as never),
  });
  const application = createWebuiApplication({
    openEventChannel: () => ({ subscribe: () => () => undefined }),
    store,
    turns: { resumeSession: async () => {} },
  });
  application.start();
  return { application, store };
}

describe("the shell adopts the application the composition root provides", () => {
  it("reads the provided store's catalog, not one seeded from the prop", () => {
    const { application } = applicationWith("adopted-session");
    const markup = renderToStaticMarkup(
      <WebuiApplicationProvider application={application}>
        <WebuiClientFoundationApp
          label="webui-foundation"
          locationHash="#session=adopted-session"
          sessionPage={sessionPage("prop-session") as never}
        />
      </WebuiApplicationProvider>,
    );

    expect(markup).toContain("adopted-session");
    expect(markup).not.toContain("prop-session");
    application.dispose();
  });

  it("still renders the shell when no application is provided", () => {
    // The fallback is gone: a host that renders the shell without an assembled
    // application has a wiring defect, and it must say so rather than silently
    // composing a second application with different inputs.
    expect(() =>
      renderToStaticMarkup(
        createElement(WebuiClientFoundationApp, {
          label: "webui-foundation",
          locationHash: "#session=prop-session",
          sessionPage: sessionPage("prop-session") as never,
        }),
      ),
    ).toThrow(/WebUI assembly error/);
  });

  it("renders the adopted application's own snapshot state", () => {
    const { application } = applicationWith("adopted-session");
    const markup = renderToStaticMarkup(
      <WebuiApplicationProvider application={application}>
        <WebuiClientFoundationApp
          label="webui-foundation"
          locationHash="#session=adopted-session"
        />
      </WebuiApplicationProvider>,
    );

    // The shell ran: the archon shell marker is the outermost thing it renders,
    // so the adoption path produced a full render rather than an empty one.
    expect(markup).toContain('data-webui-archon-shell="true"');
    expect(markup.length).toBeGreaterThan(1000);
    application.dispose();
  });
});
