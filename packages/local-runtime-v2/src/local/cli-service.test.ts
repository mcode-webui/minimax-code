import { describe, expect, it, vi } from "vitest";
import { CliService } from "./cli-service.js";

describe("CliService Workspace review forwarding", () => {
  it("requests workspace-scoped summaries and forwards the selected snapshot unchanged", async () => {
    const getReviewSummary = vi.fn(async (_workspaceDir: string, _source: { readonly type: "workspace" }) => ({
      repositoryId: "repo-1",
      reviewSnapshotId: "snapshot-7",
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
    }));
    const listReviewFileDiffs = vi.fn(async (_workspaceDir: string, _source: { readonly type: "workspace" }, _options: { readonly reviewSnapshotId: string; readonly fileIds?: string[] }) => ({ reviewSnapshotId: "snapshot-7", diffs: [] }));
    const getReviewFileContent = vi.fn(async (_workspaceDir: string, _source: { readonly type: "workspace" }, _request: { readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) => ({ reviewSnapshotId: "snapshot-7", fileId: "file-1", path: "a.ts", side: "new" as const, type: "text" as const, content: "new" }));
    const searchReviewDiffs = vi.fn(async (_workspaceDir: string, _source: { readonly type: "workspace" }, _request: { readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }) => ({ reviewSnapshotId: "snapshot-7", matchedFiles: [], totalMatches: 0, totalMatchedFiles: 0, pageIndex: 0, pageSize: 20, matchesBeforePage: 0, hasPreviousPage: false, hasNextPage: false }));
    const service = new CliService({
      application: { workspace: { git: { getReviewSummary, listReviewFileDiffs, getReviewFileContent, searchReviewDiffs } } } as never,
    } as never);

    await expect(service.getWorkspaceReviewSummary("/repo")).resolves.toMatchObject({ reviewSnapshotId: "snapshot-7" });
    await expect(service.listWorkspaceReviewFileDiffs({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileIds: ["file-1"] })).resolves.toMatchObject({ reviewSnapshotId: "snapshot-7" });
    await expect(service.getWorkspaceReviewFileContent({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileId: "file-1", side: "new" })).resolves.toMatchObject({ content: "new" });
    await expect(service.searchWorkspaceReviewDiffs({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", query: "needle", includeUntrackedFiles: true })).resolves.toMatchObject({ reviewSnapshotId: "snapshot-7" });
    expect(getReviewSummary).toHaveBeenCalledWith("/repo", { type: "workspace" });
    expect(listReviewFileDiffs).toHaveBeenCalledWith("/repo", { type: "workspace" }, { reviewSnapshotId: "snapshot-7", fileIds: ["file-1"] });
    expect(getReviewFileContent).toHaveBeenCalledWith("/repo", { type: "workspace" }, { reviewSnapshotId: "snapshot-7", fileId: "file-1", side: "new" });
    expect(searchReviewDiffs).toHaveBeenCalledWith("/repo", { type: "workspace" }, { reviewSnapshotId: "snapshot-7", query: "needle", includeUntrackedFiles: true });
  });

  it("reports unavailable workspace review runtime capabilities", async () => {
    const service = new CliService({ application: { workspace: { git: {} } } as never } as never);
    expect(() => service.getWorkspaceReviewSummary("/repo")).toThrow("Runtime does not expose Workspace review summaries.");
    expect(() => service.listWorkspaceReviewFileDiffs({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileIds: ["file-1"] })).toThrow("Runtime does not expose Workspace review file diffs.");
    expect(() => service.getWorkspaceReviewFileContent({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileId: "file-1", side: "old" })).toThrow("Runtime does not expose Workspace review file content.");
    expect(() => service.searchWorkspaceReviewDiffs({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", query: "needle", includeUntrackedFiles: true })).toThrow("Runtime does not expose Workspace review search.");
  });
});
