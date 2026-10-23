// Workspace files, git state, review diffs and the canvas.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`. Carries
// the workspace result shaping: the file tree is statted here (the one place
// that sees both the runtime tree and the filesystem) and a bare basename is
// resolved to a unique nested path before reading.
import { posix as pathPosix } from "node:path";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  extractWorkspaceArchiveDirectory,
  readWorkspaceArchiveListing,
} from "../workspace-archive.js";
import { checkWorkspaceFence } from "../workspace-real-path.js";
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeCliService, WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService, requireHostSlot } from "./requirements.js";
import { toRuntimeCanvasInput } from "./canvas-input.js";
import { WebuiErrorCode, WebuiWireError } from "../../shared/envelope.js";
import {
  toWebuiCanvasApplyResult,
  toWebuiCanvasDocument,
  toWebuiReviewDiffs,
  toWebuiReviewFileContent,
  toWebuiReviewSearchResult,
  toWebuiReviewSummary,
  toWebuiWorkspaceFiles,
} from "./result-conversion.js";
import type {
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceEnvironment,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";

export function createWorkspaceAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<
  WebuiHarnessPort,
  | "listWorkspaceFileTree"
  | "readWorkspaceArchive"
  | "extractWorkspaceArchive"
  | "readWorkspaceFile"
  | "getWorkspaceEnvironment"
  | "mutateWorkspaceGit"
  | "getWorkspaceReviewSummary"
  | "listWorkspaceReviewFileDiffs"
  | "getWorkspaceReviewFileContent"
  | "searchWorkspaceReviewDiffs"
  | "readCanvas"
  | "applyCanvas"
> {
  return {
    async listWorkspaceFileTree(request) {
      const cliService = requireCliService(host);
      const tree = await requireHostSlot(
        cliService.listWorkspaceFileTree,
        "Workspace file listing",
      ).call(cliService, request);
      // The runtime reports names and shape but no file facts, while the port
      // contract now promises `size` and `modifiedAt` for the panel's metadata
      // column. Statted here because this is the one place that sees both the
      // tree and the filesystem — extending the runtime would put the change
      // outside this package, and a tree that silently omits the fields would
      // leave the column blank rather than failing loudly.
      return Promise.all(
        toWebuiWorkspaceFiles(tree).map(async (entry) => {
          if (entry.type === "directory") return entry;
          try {
            const stats = await stat(
              path.join(request.workspaceDir, entry.path),
            );
            return { ...entry, size: stats.size, modifiedAt: stats.mtimeMs };
          } catch {
          // A file that vanished or is unreadable keeps its entry and loses
          // only the metadata; dropping it from the tree would be a lie.
          return entry;
        }
        }),
      );
    },

    // Both operations are served by this package now, so the optional runtime
    // hook is a preference rather than a requirement: a host that implements
    // one keeps it, and a host that implements neither lands on
    // `./workspace-archive.ts` instead of the "capability not connected yet"
    // error this pair used to throw. The built-in reader owns the hardening
    // (path validation, entry ceiling, expansion ratio), which is the reason it
    // is not left to a runtime that may not have shipped one.
    async readWorkspaceArchive(request) {
      const cliService = requireCliService(host);
      if (cliService.readWorkspaceArchive) return cliService.readWorkspaceArchive(request);
      return readWorkspaceArchiveListing(request);
    },

    async extractWorkspaceArchive(request) {
      const cliService = requireCliService(host);
      // The destination is where the entries are written, so it is fenced
      // before anything is created: a destination that leaves the workspace
      // through a symlink would otherwise create its directory outside first
      // and be refused afterwards.
      await assertArchiveDestinationInsideWorkspace(
        request.workspaceDir,
        request.destination,
      );
      if (cliService.extractWorkspaceArchive) return cliService.extractWorkspaceArchive(request);
      return extractWorkspaceArchiveDirectory(request);
    },

    async readWorkspaceFile(request) {
      const cliService = requireCliService(host);
      const result = (await cliService.readWorkspaceFile!(
        request,
      )) as WebuiWorkspaceFileContent;
      if (
        result.type !== "binary" ||
        result.error !== "Path traversal denied" ||
        request.path.includes("/") ||
        request.path.includes("\\") ||
        !cliService.searchWorkspaceFiles
      ) return result;

      // Assistant replies sometimes link only a basename (for example,
      // `SessionComposer.tsx`) even when the file lives in a nested package.
      // Resolve only an exact, unique basename; never guess among duplicates.
      try {
        const matches = await cliService.searchWorkspaceFiles({
          workspaceDir: request.workspaceDir,
          query: request.path,
          limit: 100,
        });
        const exactMatches = matches.filter(
          (candidate) => pathPosix.basename(candidate.replace(/\\/gu, "/")) === request.path,
        );
        const [exactMatch] = exactMatches;
        if (exactMatches.length === 1 && exactMatch) {
          const resolved = (await cliService.readWorkspaceFile!({
            ...request,
            path: exactMatch,
          })) as WebuiWorkspaceFileContent;
          return { ...resolved, resolvedPath: exactMatch };
        }
        return {
          type: "text",
          content: "",
          error:
            exactMatches.length > 1
              ? `工作区中有多个名为 ${request.path} 的文件，请使用完整相对路径。`
              : `工作区中没有找到 ${request.path}。`,
        };
      } catch {
        return result;
      }
    },

    async getWorkspaceEnvironment(request) {
      const cliService = requireCliService(host);
      const getWorkspaceGitEnvironment = requireHostSlot(
        cliService.getWorkspaceGitEnvironment,
        "Workspace git state",
      );
      const { metadata, changes } = await getWorkspaceGitEnvironment.call(
        cliService,
        request.workspaceDir,
      );
      return {
        isGitRepo: changes.isGitRepo === true || metadata.isGitRepo === true,
        ...(typeof metadata.branch === "string" ? { branch: metadata.branch } : {}),
        changedFiles: typeof changes.changedFiles === "number" ? changes.changedFiles : 0,
        insertions: typeof changes.insertions === "number" ? changes.insertions : 0,
        deletions: typeof changes.deletions === "number" ? changes.deletions : 0,
        lineStatsStatus: changes.lineStatsStatus === "ready" || changes.lineStatsStatus === "partial" ? changes.lineStatsStatus : "skipped",
        ...(typeof metadata.canPush === "boolean" ? { canPush: metadata.canPush } : {}),
        ...(typeof metadata.hasRemote === "boolean" ? { hasRemote: metadata.hasRemote } : {}),
        ...(typeof metadata.hasUpstream === "boolean" ? { hasUpstream: metadata.hasUpstream } : {}),
        ...(typeof changes.error === "string" ? { changesError: changes.error } : {}),
        ...(typeof metadata.error === "string" ? { metadataError: metadata.error } : {}),
      } as WebuiWorkspaceEnvironment;
    },

    async mutateWorkspaceGit(request) {
      const cliService = requireCliService(host);
      const mutateWorkspaceGit = requireHostSlot(
        cliService.mutateWorkspaceGit,
        "Workspace git mutations",
      );
      return mutateWorkspaceGit.call(cliService, request);
    },

    async getWorkspaceReviewSummary(request) {
      const cliService = requireCliService(host);
      const getWorkspaceReviewSummary = requireHostSlot(
        cliService.getWorkspaceReviewSummary,
        "Workspace review summaries",
      );
      // Converted, not asserted: the runtime answers with its own review view, and
      // every field the panel lists is read and defaulted here so a rename on the
      // runtime side stops at this boundary instead of becoming an undefined
      // column three layers up.
      return toWebuiReviewSummary(
        await getWorkspaceReviewSummary.call(cliService, request.workspaceDir),
      );
    },

    async listWorkspaceReviewFileDiffs(request) {
      const cliService = requireCliService(host);
      const listWorkspaceReviewFileDiffs = requireHostSlot(
        cliService.listWorkspaceReviewFileDiffs,
        "Workspace review file diffs",
      );
      return toWebuiReviewDiffs(
        await listWorkspaceReviewFileDiffs.call(cliService, {
          ...request,
          fileIds: [...request.fileIds],
        }),
      );
    },

    async getWorkspaceReviewFileContent(request) {
      const cliService = requireCliService(host);
      const getWorkspaceReviewFileContent = requireHostSlot(
        cliService.getWorkspaceReviewFileContent,
        "Workspace review file content",
      );
      return toWebuiReviewFileContent(
        await getWorkspaceReviewFileContent.call(cliService, request),
      );
    },

    async searchWorkspaceReviewDiffs(request) {
      const cliService = requireCliService(host);
      const searchWorkspaceReviewDiffs = requireHostSlot(
        cliService.searchWorkspaceReviewDiffs,
        "Workspace review search",
      );
      return toWebuiReviewSearchResult(
        await searchWorkspaceReviewDiffs.call(cliService, request),
      );
    },

    async readCanvas(request) {
      const cliService = requireCliService(host);
      return toWebuiCanvasDocument(
        await requireHostSlot(cliService.readCanvas, "canvas documents").call(
          cliService,
          request,
        ),
      );
    },

    async applyCanvas(request) {
      const cliService = requireCliService(host);
      const input = toRuntimeCanvasInput(request);
      // Fenced before the runtime is asked to apply the operation: the canvas
      // names workspace files, and a name that leaves the workspace through a
      // symlink has to be refused here rather than after the runtime resolved
      // it. The path itself is passed on unchanged — the fence only decides.
      await assertCanvasPathsInsideWorkspace(cliService, input);
      return toWebuiCanvasApplyResult(
        await requireHostSlot(cliService.applyCanvas, "canvas writes").call(
          cliService,
          input,
        ),
      );
    },
  };
}

/**
 * The archive destination has to really live inside the workspace.
 *
 * `destination` is a path the browser chose, and the extraction creates it
 * before it writes anything into it. The fence therefore runs first: a
 * destination that leaves the workspace through a symlink is refused before the
 * directory exists, not after.
 *
 * The wording is the archive reader's own — the panel shows this message next
 * to the extraction it refused.
 */
async function assertArchiveDestinationInsideWorkspace(
  workspaceDir: string,
  destination: string,
): Promise<void> {
  const verdict = await checkWorkspaceFence(
    workspaceDir,
    path.resolve(workspaceDir, destination),
  );
  if (verdict.allowed) return;
  throw new WebuiWireError(
    WebuiErrorCode.invalidBody,
    verdict.reason === "outside"
      ? `解压目标越界：${destination}`
      : `解压目标无法解析：${destination}`,
  );
}

/**
 * Every workspace file the canvas operation names has to really live inside the
 * session's workspace.
 *
 * The canvas carries workspace *relative* names, and the root they are relative
 * to is the session's — the runtime resolves the same root on its side, so the
 * fence asks the same question of the same source. A mutation that names no
 * file (an asset-backed one, whose path the runtime picks) is not fenced: there
 * is no client-chosen path to check.
 */
async function assertCanvasPathsInsideWorkspace(
  cliService: WebuiRuntimeCliService,
  input: ReturnType<typeof toRuntimeCanvasInput>,
): Promise<void> {
  const workspaceDir = await resolveSessionWorkspaceDir(cliService, input.sessionId);
  // Without a workspace there is no root to compare against. The runtime
  // refuses such a canvas itself ("Session workspace is unavailable"), so no
  // write can follow from this.
  if (!workspaceDir) return;
  for (const mutation of input.operation.mutations) {
    if (mutation.kind !== "add_file") continue;
    const relativePath = mutation.relativePath;
    if (relativePath === undefined) continue;
    const verdict = await checkWorkspaceFence(
      workspaceDir,
      path.resolve(workspaceDir, relativePath),
    );
    if (verdict.allowed) continue;
    throw new WebuiWireError(
      WebuiErrorCode.invalidBody,
      verdict.reason === "outside"
        ? `Canvas file path escapes the workspace: ${relativePath}`
        : `Canvas file path cannot be resolved: ${relativePath}`,
    );
  }
}

/**
 * The workspace the session works in, as the runtime reports it.
 *
 * `undefined` when the host cannot answer: the session lookup is a required
 * member of the host contract, but a host that does not implement it leaves the
 * canvas root unknown, and the runtime then resolves the canvas path against
 * the session's own workspace and refuses a path that is not inside it.
 */
async function resolveSessionWorkspaceDir(
  cliService: WebuiRuntimeCliService,
  sessionId: string,
): Promise<string | undefined> {
  if (typeof cliService.getSession !== "function") return undefined;
  const found = await cliService.getSession({ id: sessionId }, {});
  const workspaceDir = found.session?.workspaceDir?.trim();
  return workspaceDir ? workspaceDir : undefined;
}
