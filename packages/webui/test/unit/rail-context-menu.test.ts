// Unit tests for the session context menu's wiring into the rail's flat views.
//
// The menu component itself (`WebuiContextMenu`) and its placement helper are
// covered in `webui-shell.test.ts`; `rail-star-favorites.test.ts` covers the
// projects view's menu labels. What neither covers — and what the bug this
// suite pins shut actually was — is the wiring *inside* `SessionRail.tsx`:
//
// The rail renders sessions through two different row shapes. The projects
// view draws its own `<a>` rows with `onContextMenu` bound, and renders the
// menu portal at the end of its return. The other three views (收藏 / 运行中 /
// 未读) early-return into `WebuiSessionList`, whose rows had no
// `onContextMenu` at all — and whose branch never rendered the portal. A
// right-click there was a no-op: no handler fired, and even with a handler
// the menu state would have been set with nothing painted. "The component is
// complete and the projects-view trigger exists" was true while every flat
// view stayed dead.
//
// `renderToStaticMarkup` cannot fire events (this suite is `environment:
// "node"`), so the three links in that chain are pinned as source-level
// assertions, the same convention `rail-star-favorites.test.ts` uses for the
// child row's meta call and `rail-pin-affordance.test.ts` for its disclosure.
// The browser spec (`rail-context-menu.spec.mjs`) proves the same chain with
// a real pointer: menu opens, item callbacks fire, outside/Escape close, and
// the placement stays inside the viewport near an edge.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("../../src/client/components/SessionRail.tsx", import.meta.url),
  "utf8",
);

/** Everything from `anchor` onwards, failing loudly when the anchor moves. */
function sourceFrom(anchor: string): string {
  const at = SOURCE.indexOf(anchor);
  expect(at, `anchor vanished from SessionRail.tsx: ${JSON.stringify(anchor)}`).toBeGreaterThanOrEqual(0);
  return SOURCE.slice(at);
}

/** The flat-view branch: from its early return up to the projects markup. */
function flatViewBranch(): string {
  const start = SOURCE.indexOf('if (activeView !== "projects")');
  expect(start, "the flat-view early return is gone from WebuiProjectList").toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('data-webui-rail-section-header="true"', start);
  expect(end, "the projects branch marker is gone after the flat-view return").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("the flat views' context menu wiring", () => {
  it("binds the session context menu on the flat list's own rows", () => {
    // The flat list has its own <a>; the projects view's binding cannot reach
    // it. Anchor inside `WebuiSessionList` so the projects row's (already
    // covered) binding cannot satisfy this by coincidence.
    const list = sourceFrom("export function WebuiSessionList");
    const anchorAt = list.indexOf('title={session.workspaceDir ?? undefined}');
    expect(anchorAt, "the flat row's title attribute moved").toBeGreaterThanOrEqual(0);
    const row = list.slice(anchorAt, anchorAt + 400);
    expect(row).toContain("onContextMenu={(event) => onSessionContextMenu?.(event, session)}");
  });

  it("hands the flat rows the same menu builder the projects rows use", () => {
    // `openSessionMenu` is the projects view's builder — full root-session
    // menu, labels following pin/star state. The flat views list the same
    // root sessions, so anything else here would be a second, poorer menu.
    expect(flatViewBranch()).toContain("onSessionContextMenu={openSessionMenu}");
  });

  it("renders the menu portal in the flat-view branch, not only the projects one", () => {
    // The regression this whole suite exists for: the early return predates
    // the menu, so a portal rendered only in the projects branch leaves the
    // flat views setting state that no subtree paints. Both branches must
    // render <WebuiContextMenu>; one shared render above the split would also
    // pass this, and would be fine — the assertion is "the flat view paints
    // the menu", not "the file contains two copies".
    expect(flatViewBranch()).toContain("<WebuiContextMenu");
  });

  it("keeps the flat rows' binding optional so un-wired hosts keep the native menu", () => {
    // `WebuiSessionList` renders outside the app too (SSR fixtures); there the
    // prop is absent and the optional call must not become a preventDefault
    // that swallows the native context menu with nothing replacing it.
    const list = sourceFrom("export function WebuiSessionList");
    expect(list).toContain("onSessionContextMenu?:");
    expect(list).not.toContain("onSessionContextMenu!");
  });
});
