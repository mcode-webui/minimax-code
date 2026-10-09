import { WebuiErrorCode } from "../envelope.js";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import { invalidBody } from "./operation-contract.js";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";
import type {
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceDirectoryListing,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import {
  validateAbsoluteDirectory,
  validateObjectBody,
  validateOptionalObjectBody,
} from "./common.js";
import { LIST_WORKSPACE_FILE_TREE_OPERATION_NAME, BROWSE_WORKSPACE_DIRS_OPERATION_NAME, READ_WORKSPACE_FILE_OPERATION_NAME, GET_WORKSPACE_ENVIRONMENT_OPERATION_NAME, MUTATE_WORKSPACE_GIT_OPERATION_NAME, GET_WORKSPACE_REVIEW_SUMMARY_OPERATION_NAME, LIST_WORKSPACE_REVIEW_FILE_DIFFS_OPERATION_NAME, GET_WORKSPACE_REVIEW_FILE_CONTENT_OPERATION_NAME, SEARCH_WORKSPACE_REVIEW_DIFFS_OPERATION_NAME, READ_CANVAS_OPERATION_NAME, APPLY_CANVAS_OPERATION_NAME, READ_WORKSPACE_ARCHIVE_OPERATION_NAME, EXTRACT_WORKSPACE_ARCHIVE_OPERATION_NAME, CREATE_TERMINAL_OPERATION_NAME, LIST_TERMINALS_OPERATION_NAME, WRITE_TERMINAL_OPERATION_NAME, RESIZE_TERMINAL_OPERATION_NAME, DISPOSE_TERMINAL_OPERATION_NAME, WATCH_TERMINAL_OPERATION_NAME } from "./names.js";

/** Upper bound on one directory listing. A home directory can hold
 *  thousands of folders and the picker only needs a browsable page. */
const WORKSPACE_DIRECTORY_LIMIT = 500;

interface ListWorkspaceFileTreeBody {
  readonly workspaceDir: string;
  readonly path?: string;
}
interface BrowseWorkspaceDirsBody {
  /** Absent means "start from the user's home directory". */
  readonly dir?: string;
}
interface ReadWorkspaceFileBody {
  readonly workspaceDir: string;
  readonly path: string;
}
interface GetWorkspaceEnvironmentBody {
  readonly workspaceDir: string;
}
interface ReadCanvasBody {
  readonly sessionId: string;
}
interface ApplyCanvasBody {
  readonly sessionId: string;
  readonly operation: Record<string, unknown>;
}
interface ReadWorkspaceArchiveBody {
  readonly workspaceDir: string;
  readonly path: string;
  readonly prefix?: string;
}
interface ExtractWorkspaceArchiveBody {
  readonly workspaceDir: string;
  readonly path: string;
  readonly destination: string;
  readonly prefix?: string;
}

export const listWorkspaceFileTreeOperation: WebuiOperation<ListWorkspaceFileTreeBody, readonly WebuiWorkspaceFile[]> = {
  name: LIST_WORKSPACE_FILE_TREE_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<ListWorkspaceFileTreeBody> => {
    const result = validateObjectBody(LIST_WORKSPACE_FILE_TREE_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.workspaceDir !== "string" || !result.body.workspaceDir.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir is required" };
    if (result.body.path !== undefined && typeof result.body.path !== "string")
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "path must be a string" };
    return {
      ok: true,
      body: {
        workspaceDir: result.body.workspaceDir,
        ...(typeof result.body.path === "string" ? { path: result.body.path } : {}),
      },
    };
  },
};
export const browseWorkspaceDirsOperation: WebuiOperation<BrowseWorkspaceDirsBody, WebuiWorkspaceDirectoryListing> = {
  name: BROWSE_WORKSPACE_DIRS_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<BrowseWorkspaceDirsBody> => {
    const result = validateOptionalObjectBody(BROWSE_WORKSPACE_DIRS_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (result.body.dir === undefined) return { ok: true, body: {} };
    if (typeof result.body.dir !== "string")
      return invalidBody(`${BROWSE_WORKSPACE_DIRS_OPERATION_NAME} dir must be a string`);
    const dir = validateAbsoluteDirectory(
      BROWSE_WORKSPACE_DIRS_OPERATION_NAME,
      "dir",
      result.body.dir.trim(),
    );
    return dir.ok ? { ok: true, body: { dir: dir.body } } : dir;
  },
};

/**
 * Enumerate the sub-directories of `dir` for the composer's project
 * picker. Defaults to the user's home directory when the caller has no
 * starting point yet.
 *
 * Files are left out on purpose: a session's working directory has to be
 * a directory, so a file in this list could only produce a request the
 * server rejects. Dot-directories are hidden for the same reason a
 * native file chooser hides them.
 */
export function listWorkspaceDirectories(
  dir?: string,
): WebuiWorkspaceDirectoryListing {
  const target = dir ?? homedir();
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  const parent = dirname(target);
  return {
    dir: target,
    // `dirname("/")` is `/`; there is no way up from the root.
    ...(parent !== target ? { parent } : {}),
    entries: entries.slice(0, WORKSPACE_DIRECTORY_LIMIT),
    truncated: entries.length > WORKSPACE_DIRECTORY_LIMIT,
  };
}

export const readWorkspaceFileOperation: WebuiOperation<ReadWorkspaceFileBody, WebuiWorkspaceFileContent> = {
  name: READ_WORKSPACE_FILE_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<ReadWorkspaceFileBody> => {
    const result = validateObjectBody(READ_WORKSPACE_FILE_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.workspaceDir !== "string" || typeof result.body.path !== "string")
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir and path are required" };
    if (!result.body.workspaceDir.trim() || !result.body.path.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir and path must be non-empty strings" };
    return { ok: true, body: { workspaceDir: result.body.workspaceDir, path: result.body.path } };
  },
};
export const getWorkspaceEnvironmentOperation: WebuiOperation<GetWorkspaceEnvironmentBody, WebuiWorkspaceEnvironment> = {
  name: GET_WORKSPACE_ENVIRONMENT_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<GetWorkspaceEnvironmentBody> => {
    const result = validateObjectBody(GET_WORKSPACE_ENVIRONMENT_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.workspaceDir !== "string" || !result.body.workspaceDir.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir is required" };
    return { ok: true, body: { workspaceDir: result.body.workspaceDir } };
  },
};
export const mutateWorkspaceGitOperation: WebuiOperation<WebuiWorkspaceGitMutationRequest, Record<string, unknown>> = {
  name: MUTATE_WORKSPACE_GIT_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<WebuiWorkspaceGitMutationRequest> => {
    const result = validateObjectBody(MUTATE_WORKSPACE_GIT_OPERATION_NAME, body);
    if (!result.ok) return result as WebuiOperationValidation<WebuiWorkspaceGitMutationRequest>;
    const { workspaceDir, action, message } = result.body;
    if (typeof workspaceDir !== "string" || !workspaceDir.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir is required" };
    if (action !== "commit" && action !== "commitAndPush" && action !== "push")
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "action must be commit, commitAndPush, or push" };
    if (message !== undefined && typeof message !== "string")
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "message must be a string" };
    if (action !== "push" && (typeof message !== "string" || !message.trim()))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "message is required for commit actions" };
    return { ok: true, body: { workspaceDir, action, ...(message === undefined ? {} : { message }) } };
  },
};

export const getWorkspaceReviewSummaryOperation: WebuiOperation<{ readonly workspaceDir: string }, WebuiWorkspaceReviewSummary> = {
  name: GET_WORKSPACE_REVIEW_SUMMARY_OPERATION_NAME,
  validate: (body) => {
    const result = validateObjectBody(GET_WORKSPACE_REVIEW_SUMMARY_OPERATION_NAME, body);
    if (!result.ok) return result;
    return typeof result.body.workspaceDir === "string" && result.body.workspaceDir.trim()
      ? { ok: true, body: { workspaceDir: result.body.workspaceDir } }
      : { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir is required" };
  },
};

export const listWorkspaceReviewFileDiffsOperation: WebuiOperation<{ readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileIds: readonly string[] }, WebuiWorkspaceReviewDiffs> = {
  name: LIST_WORKSPACE_REVIEW_FILE_DIFFS_OPERATION_NAME,
  validate: (body) => {
    const result = validateObjectBody(LIST_WORKSPACE_REVIEW_FILE_DIFFS_OPERATION_NAME, body);
    if (!result.ok) return result;
    const { workspaceDir, reviewSnapshotId, fileIds } = result.body;
    if (typeof workspaceDir !== "string" || !workspaceDir.trim() || typeof reviewSnapshotId !== "string" || !reviewSnapshotId.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir and reviewSnapshotId are required" };
    if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.some((fileId) => typeof fileId !== "string" || !fileId.trim()))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "fileIds must be a non-empty string array" };
    return { ok: true, body: { workspaceDir, reviewSnapshotId, fileIds: fileIds as string[] } };
  },
};
export const getWorkspaceReviewFileContentOperation: WebuiOperation<{ readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }, WebuiWorkspaceReviewFileContent> = {
  name: GET_WORKSPACE_REVIEW_FILE_CONTENT_OPERATION_NAME,
  validate: (body) => {
    const result = validateObjectBody(GET_WORKSPACE_REVIEW_FILE_CONTENT_OPERATION_NAME, body);
    if (!result.ok) return result;
    const { workspaceDir, reviewSnapshotId, fileId, side } = result.body;
    if (typeof workspaceDir !== "string" || !workspaceDir.trim() || typeof reviewSnapshotId !== "string" || !reviewSnapshotId.trim() || typeof fileId !== "string" || !fileId.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir, reviewSnapshotId, and fileId are required" };
    if (side !== "old" && side !== "new") return { ok: false, code: WebuiErrorCode.invalidBody, message: "side must be old or new" };
    return { ok: true, body: { workspaceDir, reviewSnapshotId, fileId, side } };
  },
};
export const searchWorkspaceReviewDiffsOperation: WebuiOperation<{ readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }, WebuiWorkspaceReviewSearchResult> = {
  name: SEARCH_WORKSPACE_REVIEW_DIFFS_OPERATION_NAME,
  validate: (body) => {
    const result = validateObjectBody(SEARCH_WORKSPACE_REVIEW_DIFFS_OPERATION_NAME, body);
    if (!result.ok) return result;
    const { workspaceDir, reviewSnapshotId, query, includeUntrackedFiles, pageIndex, pageSize } = result.body;
    if (typeof workspaceDir !== "string" || !workspaceDir.trim() || typeof reviewSnapshotId !== "string" || !reviewSnapshotId.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir and reviewSnapshotId are required" };
    if (typeof query !== "string") return { ok: false, code: WebuiErrorCode.invalidBody, message: "query must be a string" };
    if (typeof includeUntrackedFiles !== "boolean") return { ok: false, code: WebuiErrorCode.invalidBody, message: "includeUntrackedFiles must be a boolean" };
    if (pageIndex !== undefined && (!Number.isInteger(pageIndex) || (pageIndex as number) < 0)) return { ok: false, code: WebuiErrorCode.invalidBody, message: "pageIndex must be a non-negative integer" };
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || (pageSize as number) < 1)) return { ok: false, code: WebuiErrorCode.invalidBody, message: "pageSize must be a positive integer" };
    return { ok: true, body: { workspaceDir, reviewSnapshotId, query, includeUntrackedFiles, ...(typeof pageIndex === "number" ? { pageIndex } : {}), ...(typeof pageSize === "number" ? { pageSize } : {}) } };
  },
};
export const readCanvasOperation: WebuiOperation<ReadCanvasBody, WebuiCanvasDocument> = {
  name: READ_CANVAS_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<ReadCanvasBody> => {
    const result = validateObjectBody(READ_CANVAS_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.sessionId !== "string" || !result.body.sessionId.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "sessionId is required" };
    return { ok: true, body: { sessionId: result.body.sessionId } };
  },
};
export const applyCanvasOperation: WebuiOperation<ApplyCanvasBody, { readonly operationId: string; readonly document: WebuiCanvasDocument }> = {
  name: APPLY_CANVAS_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<ApplyCanvasBody> => {
    const result = validateObjectBody(APPLY_CANVAS_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.sessionId !== "string" || !result.body.sessionId.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "sessionId is required" };
    if (result.body.operation === undefined || result.body.operation === null || typeof result.body.operation !== "object" || Array.isArray(result.body.operation))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "operation must be an object" };
    return {
      ok: true,
      body: {
        sessionId: result.body.sessionId,
        operation: result.body.operation as Record<string, unknown>,
      },
    };
  },
};
export const readWorkspaceArchiveOperation: WebuiOperation<ReadWorkspaceArchiveBody, WebuiWorkspaceArchiveListing> = {
  name: READ_WORKSPACE_ARCHIVE_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<ReadWorkspaceArchiveBody> => {
    const result = validateObjectBody(READ_WORKSPACE_ARCHIVE_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.workspaceDir !== "string" || !result.body.workspaceDir.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir is required" };
    if (typeof result.body.path !== "string" || !result.body.path.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "path is required" };
    if (result.body.prefix !== undefined && (typeof result.body.prefix !== "string" || !result.body.prefix.trim()))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "prefix must be a non-empty string when present" };
    return {
      ok: true,
      body: {
        workspaceDir: result.body.workspaceDir,
        path: result.body.path,
        ...(typeof result.body.prefix === "string" ? { prefix: result.body.prefix } : {}),
      },
    };
  },
};
export const extractWorkspaceArchiveOperation: WebuiOperation<ExtractWorkspaceArchiveBody, WebuiWorkspaceArchiveExtractResult> = {
  name: EXTRACT_WORKSPACE_ARCHIVE_OPERATION_NAME,
  validate: (body): WebuiOperationValidation<ExtractWorkspaceArchiveBody> => {
    const result = validateObjectBody(EXTRACT_WORKSPACE_ARCHIVE_OPERATION_NAME, body);
    if (!result.ok) return result;
    if (typeof result.body.workspaceDir !== "string" || !result.body.workspaceDir.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "workspaceDir is required" };
    if (typeof result.body.path !== "string" || !result.body.path.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "path is required" };
    // Rejected here, before the runtime sees it: a browser cannot name an
    // absolute path, so a destination the client supplied verbatim would be
    // the one unvalidated path in the chain. The runtime re-validates
    // anyway — this is the first gate, not the only one.
    if (typeof result.body.destination !== "string" || !result.body.destination.trim())
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "destination is required" };
    if (result.body.prefix !== undefined && (typeof result.body.prefix !== "string" || !result.body.prefix.trim()))
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "prefix must be a non-empty string when present" };
    return {
      ok: true,
      body: {
        workspaceDir: result.body.workspaceDir,
        path: result.body.path,
        destination: result.body.destination,
        ...(typeof result.body.prefix === "string" ? { prefix: result.body.prefix } : {}),
      },
    };
  },
};
export const createTerminalOperation: WebuiOperation<Record<string, unknown>> = { name: CREATE_TERMINAL_OPERATION_NAME, validate: (body) => validateObjectBody(CREATE_TERMINAL_OPERATION_NAME, body) };export const listTerminalsOperation: WebuiOperation<Record<string, never>> = { name: LIST_TERMINALS_OPERATION_NAME, validate: (body) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0 ? { ok: true, body: {} } : { ok: false, code: WebuiErrorCode.invalidBody, message: "listTerminals body must be an empty object" } };
export const writeTerminalOperation: WebuiOperation<Record<string, unknown>> = { name: WRITE_TERMINAL_OPERATION_NAME, validate: (body) => validateObjectBody(WRITE_TERMINAL_OPERATION_NAME, body) };
export const resizeTerminalOperation: WebuiOperation<Record<string, unknown>> = { name: RESIZE_TERMINAL_OPERATION_NAME, validate: (body) => validateObjectBody(RESIZE_TERMINAL_OPERATION_NAME, body) };
export const disposeTerminalOperation: WebuiOperation<Record<string, unknown>> = { name: DISPOSE_TERMINAL_OPERATION_NAME, validate: (body) => validateObjectBody(DISPOSE_TERMINAL_OPERATION_NAME, body) };
export const watchTerminalOperation: WebuiOperation<Record<string, unknown>> = { name: WATCH_TERMINAL_OPERATION_NAME, validate: (body) => validateObjectBody(WATCH_TERMINAL_OPERATION_NAME, body) };
