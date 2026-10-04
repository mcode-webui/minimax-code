// The rail's session export.
//
// What is being pinned here is not a URL string. It is a decision that is
// easy to undo by accident: the export is a *navigation* to
// `GET /session-transfer`, not a `fetch` whose body is turned into a blob. A
// real session on this machine exports to tens of megabytes, and buffering
// one in the JS heap to hand it straight back to the browser is how a tab
// starts eating the machine. Nothing about the current code shape would stop
// the next person from "improving" it back into a fetch, so one of these
// tests fails if they do.
//
// The other half of the round trip -- that the file this route serves is one
// the importer accepts -- cannot be checked from here, because the client and
// the server do not reference each other. That assertion lives on the route
// in `session-transfer-route.test.ts`, where the bytes go over HTTP and into
// `assertWebuiTransferFile` directly.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildWebuiSessionTransferUrl,
  startWebuiSessionTransferDownload,
  WebuiSessionExportUnavailable,
} from "../../src/client/session-transfer-download.js";
import { readWebuiSessionTransferTarget } from "../../src/client/session-transfer-target.js";

const target = { origin: "http://127.0.0.1:8788", token: "test-token" };

/**
 * Strip comments so a source assertion can ask about code rather than prose.
 * The `//` rule is guarded on a preceding `:` so a URL literal in a string is
 * not mistaken for the start of a line comment.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

function locationSpy(): { assign: ReturnType<typeof vi.fn>; impl: { assign(url: string): void } } {
  const assign = vi.fn();
  return { assign, impl: { assign } };
}

describe("buildWebuiSessionTransferUrl", () => {
  it("points at the route the server serves, with both the id and the token", () => {
    const url = new URL(buildWebuiSessionTransferUrl("mvs_1", target));
    expect(url.origin).toBe("http://127.0.0.1:8788");
    expect(url.pathname).toBe("/session-transfer");
    expect(url.searchParams.get("sessionId")).toBe("mvs_1");
    expect(url.searchParams.get("token")).toBe("test-token");
  });

  it("encodes a session id that would otherwise break the query", () => {
    // A session id is runtime-issued and always opaque. If one ever arrives
    // with a `&` in it, an unencoded one would quietly export a different
    // session than the row the user clicked.
    const url = new URL(buildWebuiSessionTransferUrl("a&b=c d", target));
    expect(url.searchParams.get("sessionId")).toBe("a&b=c d");
  });

  it("encodes a token containing characters that are not URL-safe", () => {
    const url = new URL(
      buildWebuiSessionTransferUrl("mvs_1", { origin: "http://h", token: "a/b+c=d&e" }),
    );
    expect(url.searchParams.get("token")).toBe("a/b+c=d&e");
  });
});

describe("startWebuiSessionTransferDownload", () => {
  it("navigates to the transfer route and hands back the url", () => {
    const { assign, impl } = locationSpy();
    const url = startWebuiSessionTransferDownload("mvs_1", { target, locationImpl: impl });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(url);
    expect(new URL(url).pathname).toBe("/session-transfer");
  });

  it("does not fetch the file into memory", () => {
    // The load-bearing assertion. A `fetch` + `blob()` version of this would
    // be shorter, easier to error-report, and would hold a 40 MB session on
    // the JS heap for the length of the export. This test exists so that
    // reverting to it fails here rather than in someone's browser.
    const fetchImpl = vi.fn(() => {
      throw new Error("the export must not fetch");
    });
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const { impl } = locationSpy();
      startWebuiSessionTransferDownload("mvs_1", { target, locationImpl: impl });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses in the user's language when no runtime is attached", () => {
    const { impl } = locationSpy();
    // No `target` and no `__WEBUI_CONFIG__`: the message is what the rail
    // shows, so it is asserted rather than left to inspection.
    expect(() => startWebuiSessionTransferDownload("mvs_1", { locationImpl: impl })).toThrow(
      WebuiSessionExportUnavailable,
    );
    expect(() => startWebuiSessionTransferDownload("mvs_1", { locationImpl: impl })).toThrow(
      /未连接运行时/u,
    );
    expect(impl.assign).not.toHaveBeenCalled();
  });

  it("refuses rather than throwing a raw TypeError with no address bar", () => {
    // `location` is absent under a node test runner and in any non-browser
    // embed. A `TypeError: cannot read properties of undefined` would reach the
    // rail's error banner; this keeps the message the same shape as the one
    // above.
    expect(() =>
      startWebuiSessionTransferDownload("mvs_1", { target, locationImpl: undefined as never }),
    ).toThrow(WebuiSessionExportUnavailable);
  });
});

describe("the rail's export button", () => {
  // Source-level, and the reason is stated rather than assumed.
  //
  // This suite runs in `environment: "node"` with no jsdom, so
  // `renderToStaticMarkup` never runs the click handler and nothing above can
  // observe what the button does. The cross-layer assertion in
  // `session-transfer-route.test.ts` does not cover it either -- that one
  // proves the route emits an importable file, which was true before this
  // change too, while the actual defect was that the rail never asked the
  // route for it. The gap is the wire between the button and the URL, and
  // that wire is only visible in the source.
  const shell = readFileSync(
    new URL("../../src/client/components/WebuiClientFoundationApp.tsx", import.meta.url),
    "utf8",
  );

  it("routes the export through the transfer download", () => {
    expect(shell).toContain("startWebuiSessionTransferDownload(session.sessionId)");
  });

  it("does not assemble a file in the browser any more", () => {
    // The regression this review found. Re-introducing a browser-side builder
    // would compile again, and the builder's own tests would pass again,
    // because they never knew the importer rejected the tag it writes.
    expect(shell).not.toContain("buildWebuiSessionExport");
    expect(shell).not.toContain("downloadWebuiSessionExport");
    expect(shell).not.toContain("collectWebuiSessionMessages");
  });

  it("leaves no client module able to produce the retired format", () => {
    // `mcode-webui-session@1` is only worth refusing if nothing can write it,
    // but the importer has to name it in order to refuse it -- so "the string
    // appears nowhere" is the wrong assertion, and asserting it was wrong the
    // first time this test ran.
    //
    // What matters is the direction it is used. In the importer it is the
    // constant a rejection is raised against. Anywhere else it would be a tag
    // being written into a file, which is the defect.
    const importer = readFileSync(
      new URL("../../src/client/session-import.ts", import.meta.url),
      "utf8",
    );
    // Declared as the refusal constant, and read only to raise the refusal.
    expect(importer).toContain('export const WEBUI_LEGACY_CLIENT_EXPORT_FORMAT = "mcode-webui-session@1"');
    // Never assigned into a payload: that would be a second producer.
    expect(importer).not.toMatch(/format:\s*WEBUI_LEGACY_CLIENT_EXPORT_FORMAT/u);
    // And declared exactly once, so the refusal and the check cannot drift.
    expect(importer.match(/"mcode-webui-session@1"/gu)).toHaveLength(1);

    for (const name of ["session-transfer-download.ts", "session-transfer-target.ts"]) {
      const source = readFileSync(
        new URL(`../../src/client/${name}`, import.meta.url),
        "utf8",
      );
      // Comments are exempt, and have to be: this module's header explains in
      // prose exactly which tag it stopped writing. Asserting the raw text is
      // absent would forbid documenting the defect.
      expect(stripComments(source)).not.toContain("mcode-webui-session@1");
    }
  });
});

describe("readWebuiSessionTransferTarget", () => {
  it("maps a ws endpoint to the http origin the routes are served on", () => {
    vi.stubGlobal("__WEBUI_CONFIG__", { websocketUrl: "ws://127.0.0.1:8788/ws", token: "abc" });
    try {
      // `new URL("ws://h").origin` is `ws://h`, which `fetch` cannot use.
      expect(readWebuiSessionTransferTarget()).toEqual({ origin: "http://127.0.0.1:8788", token: "abc" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a blank token as a real dev token, not as no runtime", () => {
    vi.stubGlobal("__WEBUI_CONFIG__", { websocketUrl: "ws://127.0.0.1:5199/ws", token: "" });
    try {
      expect(readWebuiSessionTransferTarget()).toEqual({ origin: "http://127.0.0.1:5199", token: "" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports no target when the config was never injected", () => {
    vi.stubGlobal("__WEBUI_CONFIG__", undefined);
    try {
      expect(readWebuiSessionTransferTarget()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports no target rather than throwing on an unparseable endpoint", () => {
    vi.stubGlobal("__WEBUI_CONFIG__", { websocketUrl: "not a url", token: "abc" });
    try {
      expect(readWebuiSessionTransferTarget()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
