/** Pure state for the WebUI code-review surface.
 *
 * The workspace review capability (getWorkspaceReviewSummary /
 * listWorkspaceReviewFileDiffs / searchWorkspaceReviewDiffs) is already wired
 * end to end — the diff card's Review button dispatches into the workspace
 * panel. What was missing was a place to read a whole change set; this module
 * is that place.
 *
 * Everything that can be decided without the network lives here so it can be
 * tested directly: the webui suite runs `environment: "node"` with no jsdom,
 * so the component itself is only reachable through `renderToStaticMarkup`,
 * which runs no effects and fires no events.
 */

import type {
  WebuiGetTurnDiffRequest,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
} from "../../../../shared/contracts/session.js";
import type { WebuiDiffState, WebuiDiffStateAction } from "../contracts/review-view.js";

export interface WebuiReviewFile {
  readonly fileId: string;
  readonly path: string;
  readonly originalPath?: string;
  readonly status: string;
  readonly type?: "text" | "binary";
  readonly additions: number;
  readonly deletions: number;
}

export interface WebuiReviewTotals {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

/** One rendered diff line, carrying the new-side line number so a click can
 * be turned into a real "open this file at this line" request. */
export interface WebuiReviewLine {
  readonly kind: "context" | "addition" | "deletion" | "hunk" | "meta";
  readonly text: string;
  /** 1-based line number on the new side, when this line exists there. */
  readonly newLine?: number;
  /** 1-based line number on the old side, when this line exists there. */
  readonly oldLine?: number;
}

export type WebuiReviewStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

export interface WebuiReviewState {
  readonly status: WebuiReviewStatus;
  readonly files: readonly WebuiReviewFile[];
  readonly totals: WebuiReviewTotals;
  readonly reviewSnapshotId?: string;
  /** Unified diff text per fileId. Absent means "not loaded yet". */
  readonly diffs: Readonly<Record<string, string>>;
  /** Per-file failure text, kept apart from the diff so a file that failed to
   * load never reads as a file with no changes. */
  readonly diffErrors: Readonly<Record<string, string>>;
  readonly loadingFileIds: readonly string[];
  readonly expandedFileIds: readonly string[];
  readonly query: string;
  /** Non-empty only while a search has run. An empty array means "no match",
   * which is why the query these matches belong to is kept alongside them:
   * before a search has run for the current query the list must stay
   * unfiltered, and after one that matched nothing it must be empty. */
  readonly searchedQuery: string;
  readonly matchedFileIds: readonly string[];
  readonly searchPending: boolean;
  readonly error?: string;
}

export const initialWebuiReviewState: WebuiReviewState = {
  status: "idle",
  files: [],
  totals: { files: 0, additions: 0, deletions: 0 },
  diffs: {},
  diffErrors: {},
  loadingFileIds: [],
  expandedFileIds: [],
  query: "",
  searchedQuery: "",
  matchedFileIds: [],
  searchPending: false,
};

export type WebuiReviewStateAction =
  | { readonly type: "load-begun" }
  | {
      readonly type: "summary-loaded";
      readonly reviewSnapshotId: string;
      readonly files: readonly WebuiReviewFile[];
      readonly totals: WebuiReviewTotals;
    }
  | { readonly type: "unavailable"; readonly reason: string }
  | { readonly type: "load-failed"; readonly reason: string }
  | { readonly type: "diffs-begun"; readonly fileIds: readonly string[] }
  | {
      readonly type: "diffs-loaded";
      readonly diffs: Readonly<Record<string, string>>;
      readonly errors?: Readonly<Record<string, string>>;
    }
  | { readonly type: "toggle-file"; readonly fileId: string }
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "search-begun" }
  | { readonly type: "search-settled"; readonly fileIds: readonly string[] }
  | { readonly type: "clear-filters" };

const withoutKeys = <T>(source: Readonly<Record<string, T>>, keys: readonly string[]): Record<string, T> => {
  const next: Record<string, T> = { ...source };
  for (const key of keys) delete next[key];
  return next;
};

const toggle = (list: readonly string[], value: string): readonly string[] =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

export function reduceWebuiReviewState(
  state: WebuiReviewState,
  action: WebuiReviewStateAction,
): WebuiReviewState {
  switch (action.type) {
    case "load-begun":
      // A reload must not leave the previous snapshot's diffs on screen
      // against a new reviewSnapshotId: those file ids belong to another
      // snapshot and would render as this one's changes.
      return {
        ...state,
        status: "loading",
        error: undefined,
        diffs: {},
        diffErrors: {},
        loadingFileIds: [],
        matchedFileIds: [],
        searchedQuery: "",
        searchPending: false,
      };
    case "summary-loaded":
      return {
        ...state,
        status: "ready",
        error: undefined,
        reviewSnapshotId: action.reviewSnapshotId,
        files: action.files,
        totals: action.totals,
      };
    case "unavailable":
      // Distinct from "error": the runtime has no review snapshot for this
      // workspace, which is a normal state, not a failure to report as one.
      return { ...state, status: "unavailable", error: undefined, searchPending: false };
    case "load-failed":
      return { ...state, status: "error", error: action.reason, searchPending: false };
    case "diffs-begun":
      return { ...state, loadingFileIds: [...new Set([...state.loadingFileIds, ...action.fileIds])] };
    case "diffs-loaded": {
      const errors = action.errors ?? {};
      // A file leaves the in-flight list when this response carried it, either
      // as a diff or as an error. Deriving the settled set from the incoming
      // payload rather than from what is already in state is what makes the
      // marker clear: a freshly loaded file is not in `state.diffs` yet, so
      // reading only the existing state would leave it spinning forever.
      const settled = [...new Set([...Object.keys(action.diffs), ...Object.keys(errors)])].filter(
        (fileId) => state.loadingFileIds.includes(fileId),
      );
      return {
        ...state,
        diffs: { ...withoutKeys(state.diffs, settled), ...action.diffs },
        diffErrors: { ...withoutKeys(state.diffErrors, settled), ...errors },
        loadingFileIds: state.loadingFileIds.filter((fileId) => !settled.includes(fileId)),
      };
    }
    case "toggle-file":
      return { ...state, expandedFileIds: toggle(state.expandedFileIds, action.fileId) };
    case "query-changed":
      // Editing the query invalidates the previous result set immediately.
      // Keeping it would filter the list by a query that no longer matches.
      return { ...state, query: action.query, matchedFileIds: [], searchedQuery: "", searchPending: false };
    case "search-begun":
      return { ...state, searchPending: true };
    case "search-settled":
      return {
        ...state,
        searchPending: false,
        searchedQuery: state.query,
        matchedFileIds: action.fileIds,
      };
    case "clear-filters":
      return { ...state, query: "", searchedQuery: "", matchedFileIds: [], searchPending: false };
  }
}

/** The file list the page should render, honouring an active search filter.
 *
 * "No query yet", "query not searched yet" and "query matched nothing" all
 * produce different lists, so the filter is only applied once a search has
 * actually settled for the query currently in the box. */
export function selectWebuiReviewVisibleFiles(state: WebuiReviewState): readonly WebuiReviewFile[] {
  const query = state.query.trim();
  if (!query || state.searchedQuery !== state.query) return state.files;
  const matched = new Set(state.matchedFileIds);
  return state.files.filter((file) => matched.has(file.fileId));
}

export function isWebuiReviewFiltering(state: WebuiReviewState): boolean {
  return state.query.trim().length > 0;
}

/** Splits a unified diff into renderable lines, numbering both sides.
 *
 * The new-side number is what makes "诊断 → 建议 → 行内定位" possible: a click
 * on an added line has to resolve to a real line in the file the editor will
 * open, and only the `+` side survives into the working tree. Hunk headers
 * carry no line of their own, so they are reported as `hunk` with no number
 * rather than inheriting the previous line's. */
export function projectWebuiReviewLines(unifiedDiff: string): readonly WebuiReviewLine[] {
  const lines = unifiedDiff.split(/\r?\n/u);
  const projected: WebuiReviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
      oldLine = header ? Number(header[1]) : 0;
      newLine = header ? Number(header[2]) : 0;
      inHunk = true;
      projected.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      // File metadata. The diff view parses these into the file header it
      // already draws — path, status, +N/−M — and never renders them as rows, so
      // neither does this list. They stay out of the line numbering path too.
      continue;
    }
    if (!inHunk) {
      // Content before the first hunk header is file metadata, not a line of
      // either side; numbering it would point the editor at the wrong place.
      projected.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      projected.push({ kind: "addition", text: raw.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      projected.push({ kind: "deletion", text: raw.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the preceding line and must
      // not consume a line number.
      projected.push({ kind: "meta", text: raw });
      continue;
    }
    projected.push({ kind: "context", text: raw.slice(1), newLine, oldLine });
    newLine += 1;
    oldLine += 1;
  }
  return projected;
}

/** The line an editor jump should target, if this line can have one.
 *
 * A deleted line is not in the file the editor will open, and a hunk header
 * or a file-metadata row is not a line of the file at all. Rather than
 * re-check the kinds here, this reads the projection's own invariant: only
 * `addition` and `context` rows are ever given a `newLine`, so a row without
 * one has no destination. That invariant is asserted directly in
 * `review-state.test.ts` — putting the check in a guard instead made it
 * untestable, since removing the guard could not change the result. */
export function webuiReviewLineTarget(line: WebuiReviewLine): number | undefined {
  return line.newLine;
}

/** Batch size for listWorkspaceReviewFileDiffs. The server takes a fileId
 * array per call; the workspace panel already batches at five and the same
 * batcher is reused here so both surfaces behave identically. */
export const WEBUI_REVIEW_DIFF_BATCH_SIZE = 5;


// ---------------------------------------------------------------------------
// The diff card's machine. It was filed in the transcript's component — the
// second place review/diff rendering lives — and it belongs here with the review
// page's own machine, so the two readers share one module rather than one of them
// keeping a private copy of the failure copy and the mutation decisions.
//
// The bodies are verbatim from `DiffCard.tsx`; the move changed the export site
// and nothing else.
// ---------------------------------------------------------------------------

export { initialWebuiDiffState } from "../contracts/review-view.js";

export function reduceWebuiDiffState(
  state: WebuiDiffState,
  action: WebuiDiffStateAction,
): WebuiDiffState {
  switch (action.type) {
    case "loaded":
      return { ...state, view: action.view, unsupported: false, busy: false, mutationError: undefined };
    case "unsupported":
      return { ...state, unsupported: true, busy: false, mutationError: undefined };
    /* A failed mutation is not an absent capability: the runtime answered, it
     * just declined this operation. Keeping `unsupported` false is what leaves
     * the card interactive, and `buildWebuiDiffMutationRequest` gating on
     * `unsupported` is what otherwise makes the first failure permanent. */
    case "mutation-failed":
      return { ...state, unsupported: false, busy: false, mutationError: trimmedOrUndefined(action.error) };
    case "begin-mutation":
      // A retry supersedes the previous reason; leaving it up would report a
      // stale failure next to an attempt that is still running.
      return state.busy ? state : { ...state, busy: true, mutationError: undefined };
    case "mutation-succeeded":
      return { ...state, view: action.view, unsupported: false, busy: false, mutationError: undefined };
    case "dismiss-mutation-error":
      return { ...state, mutationError: undefined };
    case "toggle-expanded":
      return { ...state, expanded: !state.expanded };
    case "toggle-review":
      return { ...state, reviewing: !state.reviewing };
  }
}

/** A blank or whitespace-only reason explains nothing, so it is dropped
 * rather than rendered as an empty banner. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/* What the runtime says when a revert or reapply does not apply, and what a
 * person can do about it.
 *
 * The reasons are machine tokens, and the authoritative one is
 * `applyLocalTurnDiffSnapshotMutation`'s `unsafe_path`. Read the runtime, not
 * the name: `normalizeCapturePath` *accepts* a path resolving outside the
 * workspace (returning it absolute), and returns `undefined` for in-workspace
 * paths the capture layer filters (`.git/`, `node_modules/`, the root itself).
 * The mutation now resolves and validates every target in a full precheck
 * before the first write — the checks used to sit inside the write loop, which
 * left a refused run half-applied — so the copy below can say plainly that
 * nothing was touched. `conflict` in particular does not say that the files
 * changed *after* the turn, which is the part that matters.
 *
 * A reason not in this table is passed through unchanged. That is deliberate:
 * `git apply` failures arrive as free-form stderr, and discarding them would
 * replace a real message with a guess. */
const WEBUI_DIFF_FAILURE_COPY: Readonly<Record<string, string>> = {
  unsafe_path: "这轮改动里有文件路径不在工作区内或无法安全定位，操作未执行，磁盘文件均未改动。",
  conflict: "这轮改动之后文件又被修改过，撤销前请先确认当前内容。",
  not_undoable: "这轮文件改动没有留下可撤销的快照。",
  "Turn diff not found": "找不到这轮文件改动。",
  "Only the latest turn diff can be changed": "只能撤销最近一轮的文件改动。",
  "Turn diff is not undoable": "这轮文件改动没有可撤销的补丁。",
};

export function describeWebuiDiffFailure(reason: string | undefined): string | undefined {
  const trimmed = trimmedOrUndefined(reason);
  if (!trimmed) return undefined;
  return WEBUI_DIFF_FAILURE_COPY[trimmed] ?? trimmed;
}

/** Decides what a revert/reapply round trip meant.
 *
 * The two operations nest the resulting view differently, and reading either
 * shape as success is a silent failure:
 *
 *  * `revertTurnDiff` answers `{ success?, error?, turnDiff? }` — the view
 *    lives under `turnDiff`, and a refusal carries only `error`.
 *  * `reapplyTurnDiff` answers with the view itself (`success` required,
 *    `error` optional), so for reapply the result *is* the next view.
 *
 * Two independent things are therefore checked: whether the runtime said it
 * worked, and whether it handed back an applied file list. A view with no
 * files applied nothing, and the card renders `null` for an empty file list,
 * so accepting one would delete the card with no message at all. */
export function resolveWebuiDiffMutation(
  action: "revert" | "reapply",
  result: WebuiRevertTurnDiffResult | WebuiReapplyTurnDiffResult | undefined,
  thrown?: unknown,
): WebuiDiffStateAction {
  if (thrown !== undefined) {
    const message = thrown instanceof Error ? thrown.message : undefined;
    return { type: "mutation-failed", error: describeWebuiDiffFailure(message) };
  }
  // `success` is required on reapply and optional on revert; an explicit
  // `false` is a refusal even if a view rode along beside it.
  if (result?.success === false) {
    return { type: "mutation-failed", error: describeWebuiDiffFailure(result.error) };
  }
  const nextView =
    action === "revert"
      ? (result as WebuiRevertTurnDiffResult | undefined)?.turnDiff
      : (result as WebuiReapplyTurnDiffResult | undefined);
  if (nextView && (nextView.fileChanges ?? []).length > 0) {
    return { type: "mutation-succeeded", view: nextView };
  }
  return { type: "mutation-failed", error: describeWebuiDiffFailure(result?.error) };
}

export function buildWebuiDiffMutationRequest(
  state: WebuiDiffState,
  request: WebuiGetTurnDiffRequest,
  action: "revert" | "reapply",
): WebuiRevertTurnDiffRequest | WebuiReapplyTurnDiffRequest | undefined {
  if (state.busy || state.unsupported || !state.view?.changeSetId) return undefined;
  if (action === "revert" && (state.view.status === "reverted" || state.view.canUndo === false)) return undefined;
  if (action === "reapply" && (state.view.status !== "reverted" || state.view.canReapply === false)) return undefined;
  return { ...request, changeSetId: state.view.changeSetId };
}

export function confirmWebuiDiffMutation(
  state: WebuiDiffState,
  confirmed: boolean,
): WebuiDiffState {
  return confirmed
    ? reduceWebuiDiffState(state, { type: "begin-mutation" })
    : state;
}
