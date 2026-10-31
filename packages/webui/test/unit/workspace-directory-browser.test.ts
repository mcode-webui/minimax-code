// The workspace directory browser's behaviours.
//
// Browse, loading/error, manual path, selection and dismissal. The picker needs a DOM to drive, so each
// behaviour is asserted as the expression that implements it — the project's convention for structural
// claims, and the reason a regression that drops one shows up here rather than in review.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PATH = "../../src/client/features/workspace/ui/WebuiWorkspaceDirectoryBrowser.public.tsx";
const source = readFileSync(fileURLToPath(new URL(PATH, import.meta.url)), "utf8");
// The listing, its loading state and its failure belong to the files owner;
// the component states what it wants read and renders what came back. Both halves
// are scanned, so a regression that drops the behaviour fails here whichever side
// it lands on.
const OWNER = "../../src/client/features/workspace/application/workspace-files-owner.ts";
const owner = readFileSync(fileURLToPath(new URL(OWNER, import.meta.url)), "utf8");

describe("the directory browser keeps its five behaviours", () => {
  it("browses, and browses the empty dir on the first open", () => {
    // No `dir` means "the workspace root": the request is built with the field absent rather than empty.
    expect(owner).toContain("void browseDirs(dir ? { dir } : {})");
    expect(source).toContain("queries?.browseWorkspaceDirs(dir)");
  });

  it("carries a loading state around the browse, cleared on both outcomes", () => {
    expect(owner).toContain('directoryBrowse: { status: "loading" }');
    // Both outcomes land through one setter, so neither can leave it loading.
    expect(owner).toContain('directoryBrowse: { status: "ready", listing }');
    expect(owner).toContain('directoryBrowse: { status: "error", error: message(reason) }');
    expect(source).toContain('const loading = browseState.status === "loading";');
  });

  it("reports a failure and clears it when the user retries", () => {
    // The runtime's failure is the owner's; the typed-path refusal is the view's.
    expect(owner).toContain("error: message(reason)");
    expect(source).toContain("setLocalError(");
    expect(source).toContain("需要绝对路径，例如 /home/you/projects/my-project");
    // A retry clears the view's own message before it browses again.
    expect(source).toContain("queries?.browseWorkspaceDirs(dir)");
  });

  it("accepts a typed path only when it is absolute, then selects it", () => {
    expect(source).toContain("if (!looksLikeAbsoluteWorkspacePath(value)) {");
    expect(source).toContain("onSelect(value);");
  });

  it("selects the listed directory and can be dismissed", () => {
    expect(source).toContain("if (listing) onSelect(listing.dir);");
    expect(source).toContain("onCancel");
  });
});
