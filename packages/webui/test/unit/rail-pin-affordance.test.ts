import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiIconContextPin } from "../../src/client/shell/icons.js";
import { WebuiProjectList } from "../../src/client/features/sessions/ui/SessionRail.js";
import type {
  WebuiClientProject,
  WebuiClientSession,
  WebuiClientSessionPage,
} from "../../src/client/features/sessions/contracts/session-view.js";

function session(
  sessionId: string,
  over: Partial<WebuiClientSession> = {},
): WebuiClientSession {
  return { sessionId, agentName: "main", createdAt: 0, updatedAt: 1, ...over };
}

const WORKSPACE = "/w/one";

function project(over: Partial<WebuiClientProject> = {}): WebuiClientProject {
  return {
    projectId: 1,
    projectKind: "workspace",
    workspaceDir: WORKSPACE,
    pinned: false,
    hidden: false,
    orderIndex: 0,
    recentAtMs: 1_700_000_000_000,
    latestActivityAtMs: 1_700_000_000_000,
    sessionCount: 2,
    ...over,
  } as WebuiClientProject;
}

const PAGE: WebuiClientSessionPage = {
  sessions: [
    session("mvs_pinned", { workspaceDir: WORKSPACE }),
    session("mvs_plain", { workspaceDir: WORKSPACE }),
  ],
  hasMore: false,
};

const renderProjectList = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(WebuiProjectList, {
      page: PAGE,
      projectRecords: [project()],
      loading: false,
      now: 1_000_000,
      onToggleSessionPin: () => {},
      ...over,
    }),
  );

function rowSlice(html: string, sessionId: string): string {
  const at = html.indexOf(`data-webui-session-link="${sessionId}"`);
  if (at < 0) return "";
  const end = html.indexOf("</li>", at);
  return html.slice(at, end < 0 ? html.length : end);
}

function pinButton(html: string, sessionId: string): string | undefined {
  return rowSlice(html, sessionId)
    .match(/<button[^>]*data-webui-rail-action="pin"[^>]*>/u)?.[0];
}

/**
 * The pin states a row's glyph draws.
 *
 * The glyph's own class says which state it is: the filled pin is the pinned
 * state and the outline pin is the unpinned one. The hand-drawn glyph used to
 * say it through the id of a clip path it carried; the tabler glyph says it
 * through its class.
 */
function pinGlyph(html: string, sessionId: string): string[] {
  const classes = [
    ...rowSlice(html, sessionId).matchAll(
      /class="[^"]*\btabler-icon-pin(-filled)?\b[^"]*"/gu,
    ),
  ];
  return classes.map((match) => (match[1] ? "pinned" : "unpinned"));
}

describe("the rail pin action", () => {
  it("uses one unpin action on an already pinned session row", () => {
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    const row = rowSlice(html, "mvs_pinned");
    expect(row.match(/<button[^>]*aria-label="取消置顶：/gu)).toHaveLength(1);
    expect(row).not.toContain('data-webui-pin-mark="true"');
    expect(pinGlyph(html, "mvs_pinned")).toEqual(["pinned"]);
    expect(pinButton(html, "mvs_pinned")).toContain('aria-label="取消置顶：main"');
  });

  it("uses one pin action on a session row that is not pinned", () => {
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(pinGlyph(html, "mvs_plain")).toEqual(["unpinned"]);
    expect(pinButton(html, "mvs_plain")).toContain('aria-label="置顶：main"');
  });

  it("renders a distinct glyph instance for each session row", () => {
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    // Each row draws its own pin element. The hand-drawn glyph carried a clip
    // path whose id had to be unique per row (a shared id would have made the
    // second row resolve its clip against the first row's element); the
    // tabler glyph carries no such id, so the substance of the rule is that
    // each row has an element of its own.
    const glyphs = [
      ...html.matchAll(/<svg[^>]*\btabler-icon-pin\b[^>]*>/gu),
    ];
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]?.[0]).not.toBe(glyphs[1]?.[0]);
  });

  it("does not add a pin glyph before a project name", () => {
    const html = renderProjectList({ pinnedProjects: { [WORKSPACE]: true } });
    expect(html).not.toContain('data-webui-project-pin-mark="true"');
    expect(html).toContain('data-webui-project-link="/w/one"');
  });
});

describe("the pin action glyph", () => {
  it("draws different marks for pin and unpin states", () => {
    const pinned = renderToStaticMarkup(createElement(WebuiIconContextPin, { pinned: true }));
    const unpinned = renderToStaticMarkup(createElement(WebuiIconContextPin, { pinned: false }));
    // The filled pin is the pinned state and the outline the unpinned one.
    expect(pinned).toContain('class="tabler-icon tabler-icon-pin-filled"');
    expect(unpinned).toContain('class="tabler-icon tabler-icon-pin"');
    expect(pinned).not.toBe(unpinned);
  });
});
