// The review page.
//
// It is rendered by the settings dialog's existing branch, so its mount and
// unmount are the dialog's and unchanged. It submits and reads the queries the
// workspace owner publishes (`loadReviewSummary`, `loadReviewDiffs`,
// `searchReviewDiffs`); it is presentation, and it creates no owner of its own.
// The prefix `Settings` stays in the name because that is where the user meets it.

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";

import {
  initialWebuiReviewState,
  isWebuiReviewFiltering,
  projectWebuiReviewLines,
  reduceWebuiReviewState,
  selectWebuiReviewVisibleFiles,
  webuiReviewLineTarget,
  type WebuiReviewFile,
  type WebuiReviewState,
} from "../projection/review-state.js";
import {
  groupWebuiWorktreeWorkspaces,
  type WebuiWorktreeSourceSession,
  type WebuiWorktreeWorkspace,
} from "../../sessions/projection/worktree-state.public.js";
import {
  isWebuiDiffPathWithinWorkspace,
  WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE,
} from "../../../projection/common/diff-workspace-boundary.js";
import { selectWebuiCatalogFlatPage } from "../../sessions/application/session-catalog.public.js";
import { useWebuiSessionStoreContext } from "../../../bindings/application-context.js";
import {
  useWebuiWorkspaceQueriesState,
  useWebuiWorkspaceReview,
} from "../../../bindings/use-query-state.js";
import { FolderIcon, SearchIcon } from "../../../ui/settings-glyphs.js";
import { SettingsCard, SettingsPage } from "../../../ui/settings-layout.js";

type WebuiReviewStateAction = Parameters<typeof reduceWebuiReviewState>[1];

/** 「Review 审查模式」and「修复建议+跳转」.
 *
 * The whole change set now comes from the workspace query owner: this page
 * submits `loadReviewSummary` / `loadReviewDiffs` / `searchReviewDiffs` and
 * reads the owner's snapshot, and it lists workspaces from the session catalog
 * instead of a session fetch of its own. Every decision that does not need the
 * network still lives in `review-state.ts` so it can be tested without a DOM —
 * this component is the thin shell that renders what the owner answered. */
export function ReviewSettingsPage({ workspaceDir, onOpenFileLine }: {
  readonly workspaceDir?: string;
  readonly onOpenFileLine?: (path: string, line: number) => void;
}): ReactElement {
  const queries = useWebuiWorkspaceReview();
  // The review's slice of the composed snapshot: reading it needs the tree, not
  // the whole workspace.
  const snapshot = useWebuiWorkspaceQueriesState();
  const store = useWebuiSessionStoreContext();
  const catalog = useSyncExternalStore(store.subscribe, () => store.getSnapshot().catalog, () => store.getSnapshot().catalog);
  const workspaceChoices = selectWebuiCatalogFlatPage(catalog).sessions as readonly WebuiWorktreeSourceSession[];
  const [state, setState] = useState<WebuiReviewState>(initialWebuiReviewState);
  const dispatch = useCallback((action: WebuiReviewStateAction) => {
    setState((current) => reduceWebuiReviewState(current, action));
  }, []);

  /* The prop is the selected session's workspace, and it is empty whenever the
   * selected session is not bound to a project — including the default
   * workspace, which the rail groups under 「未选项目」. A workspace chosen here
   * overrides the prop rather than replacing it, so picking one takes effect
   * immediately instead of waiting for the user to go change session in the
   * rail, which the `aria-modal` dialog does not even let them click. */
  const [pickedWorkspaceDir, setPickedWorkspaceDir] = useState<string | undefined>(undefined);
  const effectiveWorkspaceDir = workspaceDir?.trim() || pickedWorkspaceDir;
  /* One stable tab id: the owner keys its review queries per tab. */
  const tabId = "settings-review";
  /* The chooser reads the same catalog the rail renders; a directory-level
   * load is the only "loading" the picker needs to name. */
  const workspaceChoicesLoading = catalog.flat.loading && workspaceChoices.length === 0;
  const workspaceChoicesError = catalog.flat.error;

  useEffect(() => {
    if (!effectiveWorkspaceDir || !queries) return;
    let cancelled = false;
    dispatch({ type: "load-begun" });
    void queries.loadReviewSummary(tabId, effectiveWorkspaceDir)
      .then((summary) => {
        if (cancelled) return;
        const snapshotId = summary?.reviewSnapshotId;
        const files = summary?.files ?? [];
        // A workspace with nothing staged against it is a normal state, and
        // showing it as a failure would put a red banner on every fresh repo.
        if (!snapshotId || !files.length) {
          dispatch({ type: "unavailable", reason: "当前工作区没有待审查的变更" });
          return;
        }
        const totals = summary?.totals ?? {
          files: files.length,
          additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        };
        dispatch({ type: "summary-loaded", reviewSnapshotId: snapshotId, files: [...files], totals });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        dispatch({ type: "load-failed", reason: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
  }, [dispatch, queries, effectiveWorkspaceDir, tabId]);

  /* The snapshot id and the query are passed in rather than read back out of
   * state: reading a `useState` value from inside a setter callback is a type
   * error waiting to happen and silently captures whatever the reducer saw,
   * not what the caller meant. */
  const loadDiffs = useCallback(async (fileIds: readonly string[], reviewSnapshotId: string) => {
    if (!effectiveWorkspaceDir || !queries || !fileIds.length) return;
    dispatch({ type: "diffs-begun", fileIds });
    await queries.loadReviewDiffs({ tabId, workspaceDir: effectiveWorkspaceDir, snapshotId: reviewSnapshotId, fileIds });
    const entries = snapshot.reviewDiffs.diffs;
    const diffs: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const fileId of fileIds) {
      const entry = entries[fileId];
      if (entry?.error) errors[fileId] = entry.error;
      else if (entry?.binary) errors[fileId] = "二进制文件没有可显示的补丁";
      else if (entry?.diff) diffs[fileId] = entry.diff;
      else errors[fileId] = "运行时没有返回这个文件的补丁";
    }
    dispatch({ type: "diffs-loaded", diffs, errors });
  }, [dispatch, queries, snapshot, effectiveWorkspaceDir, tabId]);

  const runSearch = useCallback(async (reviewSnapshotId: string, query: string) => {
    if (!effectiveWorkspaceDir || !queries || !query.trim()) return;
    dispatch({ type: "search-begun" });
    await queries.searchReviewDiffs({ tabId, workspaceDir: effectiveWorkspaceDir, snapshotId: reviewSnapshotId, query });
    const result = snapshot.reviewSearch.result;
    // A failed search must not leave the list filtered by the previous one.
    dispatch({ type: "search-settled", fileIds: (result?.matchedFiles ?? []).map((entry) => entry.fileId) });
  }, [dispatch, queries, snapshot, effectiveWorkspaceDir, tabId]);

  const visible = selectWebuiReviewVisibleFiles(state);
  const filtering = isWebuiReviewFiltering(state);

  /* The picker is the way in. It lists real checkouts, taken from the same
   * grouping the worktree page uses, so one checkout cannot appear twice just
   * because the runtime spelled its path two ways. */
  if (!effectiveWorkspaceDir) {
    return <WebuiReviewWorkspacePicker
      workspaces={groupWebuiWorktreeWorkspaces(workspaceChoices)}
      loading={workspaceChoicesLoading}
      error={workspaceChoicesError}
      selected={pickedWorkspaceDir}
      onSelect={setPickedWorkspaceDir}
    />;
  }
  if (state.status === "idle" || state.status === "loading") {
    return <WebuiReviewPanel state={state} loading />;
  }
  if (state.status === "unavailable" || state.status === "error") {
    return <WebuiReviewPanel state={state} note={state.error} empty={state.status === "error" ? "读取待审查的变更失败" : "当前工作区没有待审查的变更。"} workspaceDir={effectiveWorkspaceDir} />;
  }

  return <WebuiReviewPanel
    state={state}
    visible={visible}
    filtering={filtering}
    workspaceDir={effectiveWorkspaceDir}
    onQueryChange={(query) => {
      dispatch({ type: "query-changed", query });
      // Live search: the owner is asked for every keystroke, and the reducer
      // drops the previous matches first so the list never shows results for a
      // query that is no longer in the box.
      if (state.reviewSnapshotId && query.trim()) void runSearch(state.reviewSnapshotId, query);
    }}
    onClearFilters={() => dispatch({ type: "clear-filters" })}
    onToggleFile={(fileId, willExpand, file) => {
      dispatch({ type: "toggle-file", fileId });
      /* A file outside the workspace is not asked for its patch at all: the
       * content is not going to be shown, so it does not have to travel. */
      if (willExpand && !state.diffs[fileId] && !state.diffErrors[fileId] && state.reviewSnapshotId && isWebuiDiffPathWithinWorkspace(effectiveWorkspaceDir, file.path)) {
        void loadDiffs([fileId], state.reviewSnapshotId);
      }
    }}
    onOpenFileLine={onOpenFileLine}
  />;
}

/** Presentational half of the code-review page.
 *
 * Split from the fetching shell on purpose: `renderToStaticMarkup` runs the
 * first render and never runs effects, so a page that only reaches its
 * populated state through an effect cannot be asserted on at all. Everything
 * that depends on data is decided upstream in `review-state.ts` and arrives
 * here as a plain value, which makes the populated render reachable from a
 * test without a DOM. */
/* The review page used to answer "先打开一个工作区" and stop. That answer
 * named the problem and gave no way out of it — and the settings dialog is
 * `aria-modal`, so the rail cannot be clicked while it is open. Choosing here
 * is the only route that stays inside the page.
 *
 * Presentational like `WebuiReviewPanel`, so the list is assertable without a
 * DOM. It deliberately reuses the worktree panel's class names instead of
 * inventing a second look for what is the same thing: a list of checkouts. */
export function WebuiReviewWorkspacePicker({ workspaces, selected, loading, error, onSelect }: {
  readonly workspaces: readonly WebuiWorktreeWorkspace[];
  readonly selected?: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly onSelect?: (workspaceDir: string) => void;
}): ReactElement {
  const state = error ? "error" : loading ? "loading" : workspaces.length ? "ready" : "empty";
  return <SettingsPage testId="review-workspace-picker" dataAttributes={{ "data-webui-workspace-state": state }}>
    <p className="webui-review-empty">选一个工作区来审查它的变更。</p>
    {error ? <p className="webui-review-error" role="alert" data-testid="review-workspace-error">{error}</p> : null}
    {loading ? <p className="webui-review-loading" role="status">正在读取可审查的工作区…</p> : null}
    {!loading && !error && workspaces.length === 0 ? (
      /* Saying why matters more than saying that: an empty list under the same
       * heading reads as the bug this page is fixing. */
      <p className="webui-review-empty" data-testid="review-workspace-empty">现在没有绑定项目目录的会话，所以没有可审查的工作区。在左栏给一个会话选好项目目录，再回到这里。</p>
    ) : null}
    <SettingsCard>
      <ul className="webui-review-workspace-list">
        {workspaces.map((workspace) => <li className="webui-review-workspace" key={workspace.workspaceDir}>
          <button
            type="button"
            className="webui-review-workspace-heading"
            data-testid="review-workspace-option"
            data-webui-workspace-dir={workspace.workspaceDir}
            data-webui-workspace-current={workspace.workspaceDir === selected ? "true" : undefined}
            onClick={() => onSelect?.(workspace.workspaceDir)}
          >
            <span className="webui-review-workspace-name"><FolderIcon />{workspace.name}</span>
            <span className="webui-review-workspace-kind">{workspace.sessions.length} 个会话</span>
          </button>
          <p className="webui-review-workspace-path" title={workspace.workspaceDir}>{workspace.workspaceDir}</p>
        </li>)}
      </ul>
    </SettingsCard>
  </SettingsPage>;
}

export function WebuiReviewPanel({ state, visible, filtering, loading, note, empty, workspaceDir, onQueryChange, onClearFilters, onToggleFile, onOpenFileLine }: {
  readonly state: WebuiReviewState;
  readonly visible?: readonly WebuiReviewFile[];
  readonly filtering?: boolean;
  readonly loading?: boolean;
  readonly note?: string;
  readonly empty?: string;
  readonly workspaceDir?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly onClearFilters?: () => void;
  readonly onToggleFile?: (fileId: string, willExpand: boolean, file: WebuiReviewFile) => void;
  readonly onOpenFileLine?: (path: string, line: number) => void;
}): ReactElement {
  const rows = visible ?? state.files;
  const filterActive = filtering ?? isWebuiReviewFiltering(state);
  return <SettingsPage testId="settings-review-page" dataAttributes={{ "data-webui-review-state": state.status, ...(state.reviewSnapshotId ? { "data-webui-review-snapshot": state.reviewSnapshotId } : {}) }}>
    {state.status === "ready" ? <div className="webui-review-totals" data-testid="review-totals">
      <span>{state.totals.files} 个文件</span>
      <span className="webui-diff-add">{`+${state.totals.additions}`}</span>
      <span className="webui-diff-del">{`-${state.totals.deletions}`}</span>
    </div> : null}
    {state.status === "ready" ? <div className="webui-review-search">
      <SearchIcon />
      <input
        aria-label="在变更里搜索"
        placeholder="在变更里搜索"
        data-testid="review-search-input"
        value={state.query}
        onChange={(event) => onQueryChange?.(event.target.value)}
      />
      {filterActive ? <button type="button" className="webui-review-clear" data-testid="review-search-clear" onClick={() => onClearFilters?.()}>清除</button> : null}
    </div> : null}
    {loading || state.searchPending ? <p className="webui-review-loading" role="status">{loading ? "正在读取待审查的变更…" : "正在搜索…"}</p> : null}
    {note || state.error ? <p className={state.status === "error" ? "webui-review-error" : "webui-review-empty"} role={state.status === "error" ? "alert" : undefined} data-testid="review-note">{note ?? state.error}</p> : null}
    {workspaceDir ? <p className="webui-review-empty" data-testid="review-workspace">{workspaceDir}</p> : null}
    {empty && !note ? <p className="webui-review-empty" data-testid="review-empty">{empty}</p> : null}
    {state.status === "ready" && rows.length === 0 ? <p className="webui-review-empty" data-testid="review-empty">{filterActive ? "没有匹配的文件" : "没有可显示的文件"}</p> : null}
    <SettingsCard>
      <ul className="webui-review-files">
        {rows.map((file) => {
          const expanded = state.expandedFileIds.includes(file.fileId);
          /* The workspace boundary decides whether the file's patch is shown.
           * The entry stays in the list either way — the name and the counts
           * are what a person can still act on. */
          const withinWorkspace = isWebuiDiffPathWithinWorkspace(workspaceDir, file.path);
          const diff = withinWorkspace ? state.diffs[file.fileId] : undefined;
          const diffError = withinWorkspace ? state.diffErrors[file.fileId] : undefined;
          const pending = withinWorkspace && state.loadingFileIds.includes(file.fileId);
          return <li className="webui-review-file" key={file.fileId} data-testid="review-file" data-file-id={file.fileId} data-webui-review-file-status={file.status} data-webui-review-outside-workspace={withinWorkspace ? undefined : "true"}>
            <button
              type="button"
              className="webui-review-file-heading"
              data-testid="review-file-toggle"
              aria-expanded={expanded}
              onClick={() => onToggleFile?.(file.fileId, !expanded, file)}
            >
              <span className="webui-review-file-path" title={file.path}>{file.path}</span>
              <span className="webui-review-file-status">{file.status}</span>
              <span className="webui-review-file-stats">
                <span className="webui-diff-add">{`+${file.additions}`}</span>
                {file.deletions > 0 ? <span className="webui-diff-del">{`-${file.deletions}`}</span> : null}
              </span>
            </button>
            {expanded ? <div className="webui-review-file-body" data-testid="review-file-body">
              {!withinWorkspace ? <p className="webui-review-file-error" role="status" data-testid="review-file-outside-workspace">{WEBUI_DIFF_OUTSIDE_WORKSPACE_NOTICE}</p> : null}
              {pending ? <p className="webui-review-loading" role="status">正在读取这个文件的补丁…</p> : null}
              {diffError ? <p className="webui-review-file-error" role="status" data-testid="review-file-error">{diffError}</p> : null}
              {diff ? <ol className="webui-review-lines" data-testid="review-lines">
                {projectWebuiReviewLines(diff).map((line, index) => {
                  const target = webuiReviewLineTarget(line);
                  const text = (
                    <>
                      <span className="webui-review-line-number">{line.newLine ?? ""}</span>
                      <span className="webui-review-line-text">{line.text}</span>
                    </>
                  );
                  return <li className={`webui-review-line webui-review-line--${line.kind}`} key={index} data-webui-review-line-kind={line.kind} data-webui-review-line={line.newLine ?? ""}>
                    {target === undefined || !onOpenFileLine
                      ? <span className="webui-review-line-static">{text}</span>
                      : <button type="button" className="webui-review-line-jump" data-testid="review-line-jump" data-webui-review-jump-line={target} onClick={() => onOpenFileLine(file.path, target)}>{text}</button>}
                  </li>;
                })}
              </ol> : null}
            </div> : null}
          </li>;
        })}
      </ul>
    </SettingsCard>
  </SettingsPage>;
}
