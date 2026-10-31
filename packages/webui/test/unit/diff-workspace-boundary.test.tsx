// The workspace boundary for a diff entry.
//
// A turn's diff can name a file outside the workspace: the runtime's capture
// layer records an out-of-workspace write as an absolute path, and the entry
// reaches the client with that file's content attached. The upstream fix that
// stopped the collection was reverted (PR #240) because it changed a package
// this fork may not change, so the boundary is drawn on the client side.
//
// This file pins down the two halves of that boundary:
//
//   * the projection, which removes the body before a surface can render it —
//     the body is blocked in the data, not merely left out of the markup;
//   * the surfaces, which say what is withheld instead of showing the content.
//
// The two are tested separately on purpose. A test that only reads the markup
// passes just as well when the component forgets to ask and the projection
// forgets to answer; a test that only reads the projection passes just as well
// when the component renders the body anyway. Together they say that neither
// one is carrying the other.
//
// Known boundary, and it is a boundary rather than a bug: a symlink inside the
// workspace that points outside it resolves outside, and the browser cannot see
// that. The entry's path is a relative one, so it stays contained here. The
// test below says so out loud rather than leaving it to be discovered.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isWebuiDiffPathWithinWorkspace,
  projectWebuiDiffFile,
  projectWebuiDiffFiles,
  WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE,
} from "../../src/client/projection/common/diff-workspace-boundary.js";
import { WebuiDiffCard } from "../../src/client/features/transcript/ui/DiffCard.js";
import { WebuiDiffFileSection } from "../../src/client/features/workspace/ui/WorkspacePanels.js";
import type { WebuiFileDiffInfoView } from "../../src/shared/contracts/session.js";

const WORKSPACE = "/work/project";

/** A body that must never reach a screen for a file outside the workspace.
 *  The marker is deliberately unlike anything in the file name, so a test that
 *  greps the markup cannot pass on the name alone. */
const BODY_MARKER = "TOKEN_VALUE_9f3a";
const BODY = `@@ -1,1 +1,1 @@\n-const token = "${BODY_MARKER}";\n+const token = "other";`;

const insideFile: WebuiFileDiffInfoView = {
  file: "src/app.ts",
  additions: 1,
  deletions: 1,
  status: "modified",
  diff: BODY,
};

const outsideFile: WebuiFileDiffInfoView = {
  file: "/etc/outside.conf",
  additions: 1,
  deletions: 1,
  status: "modified",
  diff: BODY,
};

describe("the projection removes the body of a file outside the workspace", () => {
  it("keeps the body of a file whose path is relative to the workspace", () => {
    const entry = projectWebuiDiffFile(insideFile, WORKSPACE);

    expect(entry.withinWorkspace).toBe(true);
    expect(entry.diff).toBe(BODY);
  });

  it("removes the body of an absolute path outside the workspace", () => {
    const entry = projectWebuiDiffFile(outsideFile, WORKSPACE);

    expect(entry.withinWorkspace).toBe(false);
    expect(entry.diff).toBeUndefined();
    expect(entry.patch).toBeUndefined();
  });

  it("removes the patch object as well as the diff text", () => {
    const entry = projectWebuiDiffFile(
      { file: "/etc/secret.conf", additions: 0, deletions: 0, patch: { hunks: ["secret"] } },
      WORKSPACE,
    );

    expect(entry.withinWorkspace).toBe(false);
    expect(entry.patch).toBeUndefined();
  });

  it("removes the body of a path that walks out of the workspace with `..`", () => {
    for (const file of ["../outside.txt", "src/../../outside.txt", ".."]) {
      const entry = projectWebuiDiffFile({ file, additions: 1, deletions: 0, diff: BODY }, WORKSPACE);

      expect(entry.withinWorkspace).toBe(false);
      expect(entry.diff).toBeUndefined();
    }
  });

  it("keeps the entry, its name and its counts when the body is removed", () => {
    const entry = projectWebuiDiffFile(outsideFile, WORKSPACE);

    // The file name and the counts are the part a person can still act on:
    // "which file was touched" survives even when its content does not.
    expect(entry.file).toBe("/etc/outside.conf");
    expect(entry.additions).toBe(1);
    expect(entry.deletions).toBe(1);
    expect(entry.status).toBe("modified");
  });

  it("keeps the body when the workspace root is unknown", () => {
    // Without a root there is no boundary to judge against. A check that hid
    // everything it could not place would hide ordinary content too.
    const entry = projectWebuiDiffFile(outsideFile, undefined);

    expect(entry.withinWorkspace).toBe(true);
    expect(entry.diff).toBe(BODY);
  });

  it("calls a sibling directory that shares the root's name outside", () => {
    // A string prefix would have called "/work/project-backup" inside
    // "/work/project"; the comparison is on segments.
    expect(isWebuiDiffPathWithinWorkspace(WORKSPACE, "/work/project-backup/x.ts")).toBe(false);
    expect(isWebuiDiffPathWithinWorkspace(WORKSPACE, "/work/project/x.ts")).toBe(true);
  });

  it("does not detect a symlink inside the workspace that points outside it", () => {
    // The known boundary: the path looks contained and the browser has no way
    // to know what it resolves to. Telling the two apart needs `realpath` on
    // the runtime side.
    expect(isWebuiDiffPathWithinWorkspace(WORKSPACE, "link/out.txt")).toBe(true);
  });

  it("keeps every entry of the list, in order", () => {
    const entries = projectWebuiDiffFiles([insideFile, outsideFile], WORKSPACE);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.file)).toEqual(["src/app.ts", "/etc/outside.conf"]);
    expect(entries.map((entry) => entry.withinWorkspace)).toEqual([true, false]);
  });
});

describe("the diff card shows what is withheld instead of the content", () => {
  const renderCard = (file: WebuiFileDiffInfoView, workspaceDir?: string): string =>
    renderToStaticMarkup(
      createElement(WebuiDiffCard, {
        workspaceDir,
        initialView: {
          status: "active",
          changeSetId: "changes-1",
          fileChanges: [file],
        },
        // The card's own review panel is the surface that renders the body.
        initialState: { unsupported: false, busy: false, expanded: false, reviewing: true },
      }),
    );

  it("shows the body of a file inside the workspace", () => {
    const markup = renderCard(insideFile, WORKSPACE);

    expect(markup).toContain(BODY_MARKER);
    expect(markup).not.toContain(WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE);
  });

  it("does not render the body of a file outside the workspace", () => {
    const markup = renderCard(outsideFile, WORKSPACE);

    expect(markup).not.toContain(BODY_MARKER);
    expect(markup).not.toContain("@@ -1,1 +1,1 @@");
    expect(markup).toContain(WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE);
  });

  it("keeps the file in the list with its counts", () => {
    const markup = renderCard(outsideFile, WORKSPACE);

    expect(markup).toContain('data-file-path="/etc/outside.conf"');
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
  });

  it("shows the body when the workspace root is unknown", () => {
    const markup = renderCard(outsideFile);

    expect(markup).toContain(BODY_MARKER);
    expect(markup).not.toContain(WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE);
  });
});

describe("the workspace review panel shows what is withheld instead of the content", () => {
  const renderSection = (file: WebuiFileDiffInfoView, workspaceDir?: string): string =>
    renderToStaticMarkup(
      createElement(WebuiDiffFileSection, {
        file: projectWebuiDiffFile(file, workspaceDir),
        selected: true,
      }),
    );

  it("shows the body of a file inside the workspace", () => {
    const markup = renderSection(insideFile, WORKSPACE);

    expect(markup).toContain(BODY_MARKER);
    expect(markup).toContain("webui-turn-review-line--addition");
  });

  it("does not render the body of a file outside the workspace", () => {
    const markup = renderSection(outsideFile, WORKSPACE);

    expect(markup).not.toContain(BODY_MARKER);
    expect(markup).not.toContain("webui-turn-review-line--addition");
    expect(markup).toContain(WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE);
  });

  it("keeps the file's name and its counts in the section heading", () => {
    const markup = renderSection(outsideFile, WORKSPACE);

    expect(markup).toContain("/etc/outside.conf");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
  });
});
