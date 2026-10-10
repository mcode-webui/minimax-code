// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiWorkspaceFile` | One node of the workspace file tree. | Runtime `listWorkspaceFileTree` (`runtime/harness/workspace.ts`; CliService). | `client/contracts/workspace-port.ts`; `client/components/WorkspaceFileTree.tsx`; `client/components/SessionComposer.tsx`. |
// | `WebuiWorkspaceFileContent` | One file's content, type and preview data. | Runtime `readWorkspaceFile` (`runtime/harness/workspace.ts`). | `client/contracts/workspace-port.ts`; `client/components/WorkspaceHtmlPreview.tsx`; `client/components/WorkspaceMediaPreview.tsx`. |
// | `WebuiWorkspaceDirectoryEntry` | One directory entry in a server listing. | Server `listWorkspaceDirectories` (`server/operation/workspace.ts`; the local browseWorkspaceDirs resource). | unverified — nested in `WebuiWorkspaceDirectoryListing.entries`; no direct importer. |
// | `WebuiArchiveEntry` | One entry inside an archive listing (archive-internal path). | Runtime `readWorkspaceArchiveListing` (`runtime/workspace-archive.ts`, via `runtime/harness/workspace.ts` `readWorkspaceArchive`). | `client/components/WorkspaceArchiveView.tsx`. |
// | `WebuiWorkspaceArchiveListing` | One level of an archive listing (entries, total, truncated). | Runtime `readWorkspaceArchive` (`runtime/harness/workspace.ts`; `runtime/workspace-archive.ts`). | `client/contracts/workspace-port.ts`; `client/components/WorkspaceArchiveView.tsx`. |
// | `WebuiWorkspaceArchiveExtractResult` | The written-file count of an archive extraction. | Runtime `extractWorkspaceArchive` (`runtime/harness/workspace.ts`; `runtime/workspace-archive.ts`). | `client/contracts/workspace-port.ts`; `client/components/WorkspaceArchiveView.tsx`. |
// | `WebuiWorkspaceDirectoryListing` | One level of the local directory tree for the project picker. | Server `listWorkspaceDirectories` (`server/operation/workspace.ts`; a local server resource, not a runtime call). | `client/contracts/workspace-port.ts`; `client/components/SessionComposer.tsx`. |
// | `WebuiWorkspaceEnvironment` | The session-scoped git/workspace environment projection. | Runtime `getWorkspaceEnvironment` (`runtime/harness/workspace.ts`). | `client/contracts/workspace-port.ts`; `client/components/WorkspacePanels.tsx`; `server/operation/workspace.ts`. |
// | `WebuiWorkspaceGitMutation` | The commit / commitAndPush / push action value. | Browser `client/components/WorkspacePanels.tsx`. | unverified — nested in `WebuiWorkspaceGitMutationRequest.action`; no direct importer. |
// | `WebuiWorkspaceGitMutationRequest` | Request to run a workspace git mutation. | Browser `client/components/WorkspacePanels.tsx`. | `client/contracts/workspace-port.ts`; runtime `mutateWorkspaceGit`; `server/operation/workspace.ts`. |
export interface WebuiWorkspaceFile {
  readonly path: string;
  readonly name: string;
  readonly type?: string;
  /** Bytes. Absent for directories and for runtimes that do not stat. */
  readonly size?: number;
  /** Epoch milliseconds of the last modification. Same absence rule as `size`. */
  readonly modifiedAt?: number;
  readonly children?: readonly WebuiWorkspaceFile[];
}

export interface WebuiWorkspaceFileContent {
  readonly type: "text" | "binary";
  readonly content: string;
  readonly resolvedPath?: string;
  readonly mimeType?: string;
  readonly previewDataUrl?: string;
  readonly error?: string;
}

export interface WebuiWorkspaceDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

/**
 * One entry inside an archive listed by `readWorkspaceArchive`. `path` is
 * the archive-internal POSIX path, never a host path: nothing in this shape
 * may be handed to the filesystem without re-validating it against the
 * extraction root.
 */
export interface WebuiArchiveEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size?: number;
}

export interface WebuiWorkspaceArchiveListing {
  readonly archivePath: string;
  /** Only the entries directly under `prefix`, or under the archive root. */
  readonly entries: readonly WebuiArchiveEntry[];
  /** Total entries in the archive, which may exceed `entries.length`. */
  readonly totalEntries: number;
  /** True when the listing was cut off before covering the whole archive. */
  readonly truncated: boolean;
}

export interface WebuiWorkspaceArchiveExtractResult {
  readonly archivePath: string;
  readonly destination: string;
  readonly writtenFiles: number;
  /** Set when the archive carried more entries than the hard ceiling allows. */
  readonly truncated?: boolean;
}

/**
 * One level of the local directory tree, for the composer's project
 * picker. A browser cannot hand the WebUI an absolute path — the File
 * System Access API returns a bare directory name, and `File.path` only
 * exists inside Electron — so the server enumerates the candidates and
 * the browser picks from what the server reports.
 */
export interface WebuiWorkspaceDirectoryListing {
  readonly dir: string;
  /** Absent at the filesystem root, where there is nowhere to go up. */
  readonly parent?: string;
  readonly entries: readonly WebuiWorkspaceDirectoryEntry[];
  /** True when `dir` held more directories than one listing carries. */
  readonly truncated: boolean;
}

/**
 * The small, session-scoped projection used by the Desktop environment
 * section. Keep the runtime's snapshot ids and file-level details private;
 * the browser only needs the state that controls visibility and actions.
 */
export interface WebuiWorkspaceEnvironment {
  readonly isGitRepo: boolean;
  readonly branch?: string;
  readonly changedFiles: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly lineStatsStatus: "ready" | "partial" | "skipped";
  readonly canPush?: boolean;
  readonly hasRemote?: boolean;
  readonly hasUpstream?: boolean;
  readonly changesError?: string;
  readonly metadataError?: string;
}

export type WebuiWorkspaceGitMutation =
  | "commit"
  | "commitAndPush"
  | "push";

export interface WebuiWorkspaceGitMutationRequest {
  readonly workspaceDir: string;
  readonly action: WebuiWorkspaceGitMutation;
  readonly message?: string;
}
