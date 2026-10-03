// SessionComposer — the message composer: slash palette, model picker,
// permission/questionnaire panels, goal banner, and submit
// pipeline.
//
// W3 tier 4 lift: this component was moved verbatim out of `app.tsx`. The
// body is byte-identical to what used to live there; the lift is move-only.
// `app.tsx` does NOT re-export `WebuiComposer` because only the shell
// (Tier 5) uses it — the call site stays in `app.tsx` and reaches the new
// module via a local `import { WebuiComposer } from "./components/SessionComposer.js";`.
//
// The component reads the runtime store (`useSessionRuntimeState`), so the
// W2.75 invariant about `sessionKeyRef.current` is preserved by importing
// the hook from `./session-runtime-store.js` rather than re-implementing it.

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import {
  type WebuiClientEventWatcher,
  type WebuiClientMessageEnqueuer,
  type WebuiClientMessageLoader,
  type WebuiClientMessageSender,
  type WebuiClientSessionCreator,
  type WebuiClientSessionResumer,
  type WebuiClientSessionPage,
  type WebuiModelSelectionRequest,
  type WebuiTransport,
  type WebuiClientSession,
} from "../contracts.js";
import { projectWebuiMessageToStreamMessage, readUsageNumber } from "../projection/message-projection.js";
import { webuiAnswersEndTurn } from "../projection/questionnaire-state.js";
import { latestContextUsage, readContextUsageSnapshot } from "../projection/context-usage.js";
import {
  isWebuiSubscriptionProbeCurrent,
  ownsWebuiStreamGeneration,
  reduceWebuiStreamFrame,
  releaseWebuiSubscription,
  resolveWebuiSubscriptionRecheck,
  stopWebuiTurn,
  webuiSessionStatusType,
} from "../stream.js";
import { buildWebuiStreamLoopSink, runWebuiStreamLoop } from "../stream-loop.js";

/** Capability subset the session composer consumes. Single source of truth
 *  lives in `WebuiTransport`; this alias keeps the prop block free of
 *  per-key `WebuiTransport["x"]` redeclarations. */
type WebuiSessionComposerCapabilities = Pick<
  WebuiTransport,
  | "loadMessages"
  | "getTurnDiff"
  | "revertTurnDiff"
  | "reapplyTurnDiff"
  | "getSessionForkOptions"
  | "forkSession"
  | "getSessionRewindPreview"
  | "rewindSession"
  | "editSessionMessage"
  | "patchGoal"
  | "clearGoal"
>;
import type {
  WebuiGoal,
  WebuiActiveTurnRequest,
  WebuiActiveTurnResult,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalSessionRequest,
  WebuiInteractionReplyResult,
  WebuiModelEntry,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
  WebuiQueueItem,
  WebuiWorkspaceDirectoryListing,
  WebuiWorkspaceFile,
  WebuiUsageQuotaResult,
} from "../../server/port.js";
import { formatUsageResetLabel } from "./UserMenu.js";
import { WebuiGoalBanner } from "./GoalBanner.js";
import { WebuiInteractionPanel } from "./InteractionPanel.js";
import {
  WebuiModelPicker,
  type WebuiModelPickerDraft,
} from "./ModelPicker.js";
import {
  WebuiIconAttach,
  WebuiIconCheck,
  WebuiIconChevronDown,
  WebuiIconCommandGoal,
  WebuiIconCommandPlan,
  WebuiIconFolder,
  WebuiIconPermissionAuto,
  WebuiIconPermissionFull,
  WebuiIconPermissionRequest,
  WebuiIconPlugins,
  WebuiIconSend,
  WebuiIconSkillGeneric,
  type WebuiIconProps,
} from "../icons.js";
import { OutputError } from "./OutputError.js";
import {
  createWebuiWatchEventCallback,
} from "../projection/effect-reducer.js";
import {
  buildWebuiComposerHandlers,
  submitWebuiGoal,
  submitWebuiComposerTurn,
  resolveWebuiSubmissionIntent,
  resolveWebuiComposerEnterAction,
  isTurnLive,
  looksLikeAbsoluteWorkspacePath,
} from "../projection/composer-state.js";
import { evaluateComposerDismiss, evaluateOutsideClose } from "../projection/outside-close.js";
import {
  buildWebuiModelSelectionRequest,
} from "../projection/action-requests.js";
import {
  createSessionRuntimeWriter,
  HOME_SESSION_RUNTIME_KEY,
  readSessionRuntimeState,
  useSessionRuntimeState,
} from "../session-runtime-store.js";
import { initialWebuiStreamState } from "../stream.js";
import { workspaceProjectName } from "./SessionRail.js";
import {
  findWebuiMentionRange,
  findWebuiSlashRange,
  insertWebuiMention,
  removeWebuiSlashToken,
  replaceWebuiSlashToken,
  webuiAttachmentLimitError,
  type WebuiMentionRange,
} from "../projection/composer-interactions.js";
import {
  shouldRecallWebuiHistory,
  startWebuiHistoryBrowse,
  stepWebuiHistoryBrowse,
  type WebuiHistoryBrowse,
} from "../projection/composer-history.js";
import {
  isWebuiRunnableCommand,
  rankWebuiSlashPalette,
  sectionWebuiSlashPalette,
  slashSkillSummaryToEntry,
  WEBUI_BUILTIN_COMMANDS,
  type SlashCommandEntry,
  type WebuiSlashSkillSummary,
  type WebuiRunCommandName,
} from "../slash-palette.js";

const WEBUI_SLASH_FALLBACK_SECTIONED: SlashCommandEntry[] = await (async () => {
  const { resolveWebuiSlashSkills, sectionWebuiSlashPalette } = await import(
    "../slash-palette.js"
  );
  const resolved = await resolveWebuiSlashSkills();
  return sectionWebuiSlashPalette(WEBUI_BUILTIN_COMMANDS, resolved.skills);
})();

// Desktop keeps the viewport pinned through the short hand-off window where
// the live turn is replaced by the refreshed historical transcript.

interface ComposerAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
  readonly kind: "image" | "file";
}

interface ComposerUrlReference {
  readonly id: string;
  readonly url: string;
}

interface ComposerCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
}

type ComposerMentionChoice =
  | { readonly kind: "plugin"; readonly name: string; readonly label: string; readonly detail?: string; readonly section: string }
  | { readonly kind: "file"; readonly path: string; readonly label: string; readonly section: string }
  | { readonly kind: "local-file"; readonly label: string; readonly section: string }
  | { readonly kind: "local-folder"; readonly label: string; readonly section: string }
  | { readonly kind: "agent"; readonly session: WebuiClientSession; readonly label: string; readonly section: string };

type WebuiComposerPermissionMode = "default" | "auto" | "bypassPermissions";

const PERMISSION_MODE_ORDER = ["default", "auto", "bypassPermissions"] as const;

interface WebuiComposerPermissionOption {
  readonly label: string;
  readonly description: string;
  readonly Icon: (props: WebuiIconProps) => ReactElement;
}

/** The popover's own question, and where "了解更多" points. The docs page is the
 *  public one the README already links; `/permission` is documented there. */
const PERMISSION_MODE_QUESTION = "应如何批准 minimax code 操作?";
const PERMISSION_MODE_LEARN_MORE = "了解更多";
const PERMISSION_MODE_DOCS_URL = "https://agent.minimax.io/docs/cli/features";

/** Default for `recentWorkspaceDirs`. A module constant, not an inline `[]`, so
 *  the prop keeps one identity across renders when the parent does not supply
 *  it — an inline default would be a fresh array every render. */
const EMPTY_WORKSPACE_DIRS: readonly string[] = [];

/** Ordered most-restrictive first, mirroring the `ask` / `auto` / `full` actions
 *  the `/permission` command takes. */
const PERMISSION_MODE_OPTION: Readonly<Record<WebuiComposerPermissionMode, WebuiComposerPermissionOption>> = {
  default: {
    label: "请求批准",
    description: "编辑外部文件和使用互联网时始终询问",
    Icon: WebuiIconPermissionRequest,
  },
  auto: {
    label: "帮我批准",
    description: "仅对检测到的风险操作请求批准",
    Icon: WebuiIconPermissionAuto,
  },
  bypassPermissions: {
    label: "完全访问权限",
    description: "可不受限制地访问互联网和你电脑上的任何文件",
    Icon: WebuiIconPermissionFull,
  },
};

/** The trigger and the rows share one glyph per mode, so the pill always
 *  previews the icon the popover marks as selected. */
function PermissionModeIcon({ mode }: { readonly mode: WebuiComposerPermissionMode }): ReactElement {
  const { Icon } = PERMISSION_MODE_OPTION[mode];
  return <Icon className="webui-composer-permission-icon" />;
}

function readPermissionMode(value: unknown): WebuiComposerPermissionMode | undefined {
  const mode = typeof value === "string"
    ? value
    : value && typeof value === "object" && "mode" in value
      ? (value as { mode?: unknown }).mode
      : undefined;
  return mode === "default" || mode === "auto" || mode === "bypassPermissions"
    ? mode
    : undefined;
}

function composerRows(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const items = Array.isArray(row.plugins) ? row.plugins : Array.isArray(row.items) ? row.items : [];
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

function flattenWorkspaceFiles(files: readonly WebuiWorkspaceFile[]): readonly { readonly path: string; readonly name: string; readonly type?: string }[] {
  const flattened: { path: string; name: string; type?: string }[] = [];
  const visit = (items: readonly WebuiWorkspaceFile[]) => {
    for (const item of items) {
      flattened.push({ path: item.path, name: item.name, ...(item.type ? { type: item.type } : {}) });
      if (item.children) visit(item.children);
    }
  };
  visit(files);
  return flattened;
}

function readBrowserFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取文件：${file.name}`));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Directory browser behind the composer's "选择新项目".
 *
 * A browser cannot name a directory for us: the File System Access API
 * hands back a bare directory name, `File.path` exists only inside
 * Electron, and `webkitRelativePath` is relative by definition — while
 * the server requires a real absolute path for a session's working
 * directory. So the server enumerates this machine's directories and the
 * user picks from what it reports.
 *
 * When the transport has no `browseWorkspaceDirs` — a static fixture
 * transport, or a server that predates the operation — the browser falls
 * back to a manual absolute-path field. Either way a failure is shown in
 * the popover; it never resolves to a silent no-op.
 */
export function WebuiWorkspaceDirectoryBrowser({
  browseWorkspaceDirs,
  initialDir,
  onSelect,
  onCancel,
}: {
  readonly browseWorkspaceDirs?: WebuiTransport["browseWorkspaceDirs"];
  readonly initialDir?: string;
  readonly onSelect: (dir: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [listing, setListing] = useState<WebuiWorkspaceDirectoryListing>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [manualPath, setManualPath] = useState(initialDir ?? "");

  const browse = useCallback(
    (dir?: string) => {
      if (!browseWorkspaceDirs) return;
      setLoading(true);
      setError(undefined);
      void browseWorkspaceDirs(dir ? { dir } : {})
        .then((next) => {
          setListing(next);
          setManualPath(next.dir);
        })
        .catch((reason: unknown) => {
          setError(
            reason instanceof Error ? reason.message : String(reason),
          );
        })
        .finally(() => setLoading(false));
    },
    [browseWorkspaceDirs],
  );

  useEffect(() => {
    browse(initialDir);
  }, [browse, initialDir]);

  const submitManualPath = useCallback(() => {
    const value = manualPath.trim();
    if (!value) {
      setError("请输入项目目录的绝对路径");
      return;
    }
    if (!looksLikeAbsoluteWorkspacePath(value)) {
      setError("需要绝对路径，例如 /home/you/projects/my-project");
      return;
    }
    onSelect(value);
  }, [manualPath, onSelect]);

  if (!browseWorkspaceDirs)
    return (
      <div className="flex flex-col gap-2" data-webui-workspace-manual="true">
        <label className="webui-commit-dialog-label">
          <span>项目绝对路径</span>
          <input
            value={manualPath}
            autoFocus
            placeholder="/home/you/projects/my-project"
            onChange={(event) => {
              setManualPath(event.target.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submitManualPath();
            }}
          />
        </label>
        {error ? (
          <p className="webui-commit-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="webui-workspace-browser-actions">
          <button
            type="button"
            className="webui-workspace-browser-action"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="webui-workspace-browser-action webui-workspace-browser-action--primary"
            onClick={submitManualPath}
          >
            使用此目录
          </button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-2" data-webui-workspace-browser="true">
      <div className="flex items-center gap-2">
        {listing?.parent ? (
          <button
            type="button"
            className="webui-workspace-option webui-workspace-option--desktop"
            data-webui-workspace-action="up"
            onClick={() => browse(listing.parent)}
          >
            <span className="min-w-0 flex-1 truncate text-left">上一级</span>
          </button>
        ) : null}
        <span
          className="min-w-0 flex-1 truncate text-text_default_secondary text-size_12"
          title={listing?.dir}
        >
          {listing?.dir ?? "正在读取目录…"}
        </span>
      </div>
      {error ? (
        <p className="webui-commit-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="webui-composer-menu-empty">正在读取目录…</p>
      ) : listing?.entries.length ? (
        listing.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="webui-workspace-option webui-workspace-option--desktop"
            data-webui-workspace-action="enter"
            onClick={() => browse(entry.path)}
          >
            <WebuiIconFolder className="flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {entry.name}
            </span>
          </button>
        ))
      ) : (
        <p className="webui-composer-menu-empty">此目录下没有子目录</p>
      )}
      {listing?.truncated ? (
        <p className="webui-composer-menu-empty">子目录过多，仅显示前若干项</p>
      ) : null}
      <div className="webui-workspace-browser-actions">
        <button
          type="button"
          className="webui-workspace-browser-action"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="webui-workspace-browser-action webui-workspace-browser-action--primary"
          disabled={!listing}
          onClick={() => {
            if (listing) onSelect(listing.dir);
          }}
        >
          使用此目录
        </button>
      </div>
    </div>
  );
}

/** What the retry affordance on a failed turn should do. */
export type WebuiRetryResendPlan =
  | { readonly kind: "resend"; readonly message: string }
  | {
      readonly kind: "withheld";
      readonly reason: "no-refusal" | "no-recorded-input";
    };

/** The input of the last turn a composer submitted, and the session it was in. */
export interface WebuiRecordedTurn {
  readonly session: string | undefined;
  readonly message: string;
}

/**
 * Decide what a retry on a failed turn does.
 *
 * A retry RE-SENDS the input the user submitted. It must not abort: the abort
 * operation carries only a session id, so a "retry" wired to it killed a turn
 * that may still have been running instead of re-asking. The input therefore
 * comes from what this component recorded locally at submit time — never from
 * a server round-trip, which would be slower and able to return a different
 * message than the one that actually failed.
 *
 * `withheld` is the honest answer when there is nothing to re-send. A button
 * that cannot do the thing it names is worse than no button: the previous
 * defect was exactly a control that was present and could not work.
 */
export function planWebuiRetryResend(args: {
  readonly refusal: string | undefined;
  /** The session the recorded input was submitted in; `undefined` is home. */
  readonly recordedSession: string | undefined;
  readonly session: string | undefined;
  readonly lastSubmittedText: string | undefined;
}): WebuiRetryResendPlan {
  if (!args.refusal) return { kind: "withheld", reason: "no-refusal" };
  // `WebuiComposer` is not remounted per session, so a record left over from
  // the previous session would re-send that session's turn. A record is only
  // good for the session that produced it.
  if (args.recordedSession !== args.session)
    return { kind: "withheld", reason: "no-recorded-input" };
  const recorded = args.lastSubmittedText?.trim();
  if (!recorded) return { kind: "withheld", reason: "no-recorded-input" };
  return { kind: "resend", message: recorded };
}

/**
 * Run a retry: hand the recorded input back to the ordinary send path.
 *
 * Split out of the component so the decision and the resend are one testable
 * unit. `sendTurn` is the very function the submit path uses, so a retry
 * cannot drift into a second, subtly different way of sending — and there is no
 * abort anywhere in this path to wire it to by mistake.
 */
export function resendRecordedWebuiTurn(args: {
  readonly refusal: string | undefined;
  readonly recordedTurn: WebuiRecordedTurn | undefined;
  readonly session: string | undefined;
  readonly sendTurn: (turn: { readonly message: string }) => void | Promise<void>;
}): WebuiRetryResendPlan {
  const plan = planWebuiRetryResend({
    refusal: args.refusal,
    recordedSession: args.recordedTurn?.session,
    session: args.session,
    lastSubmittedText: args.recordedTurn?.message,
  });
  if (plan.kind === "resend") void args.sendTurn({ message: plan.message });
  return plan;
}

export function WebuiComposer({
  sessionId,
  sessionStatus,
  sessionLayout = false,
  usageQuota,
  agentName,
  createSession,
  createSessionWorkspaceDir,
  onWorkspaceChange,
  workspaceMenuOpen,
  setWorkspaceMenuOpen,
  recentWorkspaceDirs = EMPTY_WORKSPACE_DIRS,
  runCommand,
  sendMessage,
  resumeSession,
  loadMessages,
  getTurnDiff,
  revertTurnDiff,
  reapplyTurnDiff,
  getSessionForkOptions,
  forkSession,
  getSessionRewindPreview,
  rewindSession,
  editSessionMessage,
  getGoal,
  getActiveTurn,
  createGoal,
  patchGoal,
  clearGoal,
  isGoalEnabled,
  watchEvents,
  listPendingPermissions,
  getPendingQuestionnaire,
  replyPermission,
  replyQuestionnaire,
  dismissQuestionnaire,
  abortSession,
  listQueueMessages,
  deleteQueueItem,
  listModels,
  listSkills,
  selectModel,
  getAccountStatus,
  draft,
  onDraftChange,
  inputHistory = [],
  onInputSubmitted,
  onNeedsSession,
  onSessionCreated,
  enqueueMessage,
  teamModeOff,
  listWorkspaceFileTree,
  browseWorkspaceDirs,
  pluginManagement,
  getPermissionMode,
  setPermissionMode,
  sessions = [],
  workspaceDir,
  onSelectSession,
  onOpenPluginManagement,
}: {
  readonly sessionId?: string;
  readonly sessionStatus?: unknown;
  readonly sessionLayout?: boolean;
  readonly usageQuota?: WebuiUsageQuotaResult;
  readonly agentName: string;
  readonly createSession?: WebuiClientSessionCreator;
  readonly createSessionWorkspaceDir?: string;
  readonly onWorkspaceChange: (workspaceDir?: string) => void;
  /** Open state for the workspace picker; owned by the parent so the
   *  parent's workspace-change handler can also close the popover. */
  readonly workspaceMenuOpen: boolean;
  readonly setWorkspaceMenuOpen: (open: boolean) => void;
  /** Workspace directories offered as `最近`, newest first. Derived from
   *  session history by `deriveRecentWorkspaceDirs`; empty when the user has
   *  no project sessions yet. */
  readonly recentWorkspaceDirs?: readonly string[];
  readonly runCommand?: (request: { readonly command: "help" | "new" | "compact" | "status" | "usage" | "model"; readonly input?: string; readonly sessionId?: string; readonly agentName?: string; readonly workspaceDir?: string; }) => Promise<Record<string, unknown>>;
  readonly sendMessage?: WebuiClientMessageSender;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly resumeSession?: WebuiClientSessionResumer;

  readonly getGoal?: (request: WebuiGoalSessionRequest) => Promise<WebuiGoal | undefined>;
  /** Authoritative active-turn probe; resolves the `recheck` case and the
   * missed-event gap that a reconnect or a slow subscribe can open. */
  readonly getActiveTurn?: (request: WebuiActiveTurnRequest) => Promise<WebuiActiveTurnResult>;
  readonly createGoal?: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;

  readonly isGoalEnabled?: () => Promise<WebuiGoalEnabledResult>;
  readonly watchEvents?: WebuiClientEventWatcher;
  readonly listPendingPermissions?: () => Promise<{ readonly requests: readonly WebuiPendingPermission[] }>;
  readonly getPendingQuestionnaire?: (request: { readonly name: string; readonly sessionId: string }) => Promise<{ readonly request?: WebuiQuestionnaireRequest }>;
  readonly replyPermission?: (request: { readonly name: string; readonly requestId: string; readonly reply: "allowOnce" | "allowAlways" | "deny" }) => Promise<WebuiInteractionReplyResult>;
  readonly replyQuestionnaire?: (request: { readonly name: string; readonly requestId: string; readonly schemaVersion: number; readonly answers: readonly WebuiQuestionnaireAnswer[] }) => Promise<WebuiInteractionReplyResult>;
  readonly dismissQuestionnaire?: (request: { readonly name: string; readonly requestId: string }) => Promise<WebuiInteractionReplyResult>;
  readonly abortSession?: (request: { readonly id: string }) => Promise<{ readonly success?: boolean }>;
  readonly listQueueMessages?: (request: { readonly id: string }) => Promise<{ readonly items?: readonly WebuiQueueItem[]; readonly paused?: boolean; readonly pendingCount?: number }>;
  readonly deleteQueueItem?: (request: { readonly id: string; readonly itemId: string }) => Promise<{ readonly item?: WebuiQueueItem }>;
  readonly listModels?: (request?: { readonly sessionId?: string }) => Promise<readonly WebuiModelEntry[]>;
  readonly listSkills?: (request?: { readonly agentName?: string }) => Promise<{ readonly skills: readonly { readonly name: string; readonly displayName?: string; readonly description?: string }[] }>;
  readonly selectModel?: (request: WebuiModelSelectionRequest) => Promise<{ readonly success?: boolean }>;
  readonly getAccountStatus?: (request?: { readonly sessionId?: string }) => Promise<Record<string, unknown>>;
  /** The draft lives on the shell so it survives silent first-session creation. */
  readonly draft: string;
  readonly onDraftChange: (next: string) => void;
  /**
   * Submitted-input history for ↑ recall (roadmap Module B: 输入历史/草稿).
   * Keyed by session on the shell; the composer only walks it with the pure
   * helpers from `composer-history.ts`.
   */
  readonly inputHistory?: readonly string[];
  /** Records one committed submission into the shell's history store. */
  readonly onInputSubmitted?: (text: string) => void;
  readonly onNeedsSession?: (draft: string) => void;
  readonly onSessionCreated?: (sessionId: string) => void;
  readonly teamModeOff: boolean;
  readonly listWorkspaceFileTree?: WebuiTransport["listWorkspaceFileTree"];
  readonly browseWorkspaceDirs?: WebuiTransport["browseWorkspaceDirs"];
  readonly pluginManagement?: WebuiTransport["pluginManagement"];
  readonly getPermissionMode?: WebuiTransport["getPermissionMode"];
  readonly setPermissionMode?: WebuiTransport["setPermissionMode"];
  readonly sessions?: readonly WebuiClientSession[];
  readonly workspaceDir?: string;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly onOpenPluginManagement?: (area: "plugins" | "skills") => void;
} & WebuiSessionComposerCapabilities): ReactElement {
  const {
    state: runtimeState,
    setStream,
    setSending,
  } = useSessionRuntimeState(sessionId);
  const { stream, sending } = runtimeState;
  const [permissions, setPermissions] = useState<
    readonly WebuiPendingPermission[]
  >([]);
  const [questionnaire, setQuestionnaire] =
    useState<WebuiQuestionnaireRequest>();
  const [goal, setGoal] = useState<WebuiGoal>();
  // Bumped by every write to the goal, so a steering re-read that lands after
  // a newer update can tell it is stale and stand down. EVERY writer must go
  // through `applyGoal` — a direct `setGoal` here would let an in-flight read
  // resurrect the state it was meant to replace.
  const goalVersionRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const applyGoal = useCallback((next: WebuiGoal | undefined) => {
    goalVersionRef.current += 1;
    setGoal(next);
  }, []);
  const [goalEnabled, setGoalEnabled] = useState(true);
  const [goalMode, setGoalMode] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [goalSubmitting, setGoalSubmitting] = useState(false);
  const [interactionError, setInteractionError] = useState<string>();
  const [queueItems, setQueueItems] = useState<readonly WebuiQueueItem[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [models, setModels] = useState<readonly WebuiModelEntry[]>([]);
  const [accountStatus, setAccountStatus] = useState<Record<string, unknown>>();
  const [commandOutput, setCommandOutput] = useState<string>();
  const [commandRunning, setCommandRunning] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [urlReferences, setUrlReferences] = useState<ComposerUrlReference[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [composerMenu, setComposerMenu] = useState<"root" | "skills" | "plugins">();
  const [installedPlugins, setInstalledPlugins] = useState<readonly ComposerCatalogEntry[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string>();
  const [skillsMenuLoading, setSkillsMenuLoading] = useState(false);
  const [skillsMenuError, setSkillsMenuError] = useState<string>();
  const [workspaceFiles, setWorkspaceFiles] = useState<readonly { readonly path: string; readonly name: string; readonly type?: string }[]>([]);
  const [workspaceBrowserOpen, setWorkspaceBrowserOpen] = useState(false);
  const [mentionRange, setMentionRange] = useState<WebuiMentionRange>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [permissionMode, setPermissionModeValue] = useState<WebuiComposerPermissionMode>();
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionUnavailable, setPermissionUnavailable] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const mentionCaretRef = useRef<number>();
  const pendingMentionCaretRef = useRef<number>();
  // The slash palette follows the caret, so its position is state rather than a
  // ref: a click or an arrow key that only moves the caret still has to
  // re-derive whether a slash token is under it.
  const [composerCaret, setComposerCaret] = useState(0);
  // ↑ recall browse state (roadmap Module B). `undefined` = not browsing.
  // While set, ↑/↓ walk `inputHistory` and any manual edit exits (the
  // textarea's onChange only fires for real user edits — a programmatic
  // recall swap never ends its own browse); stepping past the newest
  // restores the stashed pre-browse draft.
  const [historyBrowse, setHistoryBrowse] = useState<WebuiHistoryBrowse>();
  useEffect(() => {
    // Switching sessions swaps the history list under the browse cursor;
    // restart clean rather than trusting the index still means anything.
    setHistoryBrowse(undefined);
  }, [sessionId]);
  const applyHistoryDraft = (next: string) => {
    handleDraftChange(next);
    setComposerCaret(next.length);
    // The DOM caret lags the controlled value swap by a render; pin it to
    // the end once the new value is on screen, the way a terminal leaves the
    // cursor after a recall.
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };
  const editingGoalDraftRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRegionRef = useRef<HTMLDivElement | null>(null);
  // The permission popover's own container: the trigger button plus the popover
  // body. Distinct from `composerRegionRef` on purpose — the popover is a
  // dropdown hinged to the footer button, so "inside" means "inside this wrap",
  // not "anywhere in the composer".
  const permissionWrapRef = useRef<HTMLDivElement | null>(null);
  // The `+` menu's own container: the attach button plus the panel it opens.
  // Distinct from `composerRegionRef` on purpose — a dropdown hinged to that
  // button dismisses on any other click, the textarea included.
  const composerAddWrapRef = useRef<HTMLDivElement | null>(null);
  // The workspace picker's own container: the 选择文件夹 trigger plus whichever
  // panel it has open (the 最近 list or the directory browser). The picker has
  // to be judged against THIS, not `composerRegionRef` — see the effect below.
  const workspacePickerRef = useRef<HTMLDivElement | null>(null);
  const fieldId = useId();
  const contextUsage = stream.contextUsage ?? stream.messages.at(-1)?.contextUsage;
  useEffect(() => {
    if (!sessionId || webuiSessionStatusType(sessionStatus) === "started" || !loadMessages) return;
    let cancelled = false;
    void loadMessages({ id: sessionId }).then((page) => {
      if (cancelled) return;
      const snapshot = readContextUsageSnapshot(page.contextSnapshot);
      const fromMessages = latestContextUsage((page.messages ?? []).map(projectWebuiMessageToStreamMessage));
      const contextUsage = snapshot ?? fromMessages;
      if (contextUsage) setStream((current) => ({ ...current, contextUsage }));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId, sessionStatus, loadMessages]);

  useEffect(() => {
    if (!sessionId) {
      // Inspection data belongs to a session. Clear it when New Task returns to
      // home so the previous session's model/account state cannot bleed into the composer.
      setModels([]);
      setAccountStatus(undefined);
      // The live turn bleeds the same way: the module-level runtime map kept
      // the previous turn's stream under the welcome hero on every 新建任务.
      setStream(() => initialWebuiStreamState);
      setSending(false);
      return undefined;
    }
    let cancelled = false;
    const refreshPending = async () => {
      const [permissionResult, questionnaireResult] = await Promise.all([
        listPendingPermissions?.(),
        getPendingQuestionnaire?.({ name: agentName, sessionId }),
      ]);
      if (cancelled) return;
      const sessionPermissions = (permissionResult?.requests ?? []).filter(
        (permission) => permission.sessionId === sessionId,
      );
      setPermissions(sessionPermissions);
      setQuestionnaire(questionnaireResult?.request);
      if (sessionPermissions.length > 0 || questionnaireResult?.request)
        setStream((current) => ({ ...current, phase: "waiting" }));
      if (listQueueMessages) {
        const queue = await listQueueMessages({ id: sessionId });
        if (cancelled) return;
        setQueueItems(queue.items ?? []);
        setQueuePaused(queue.paused === true);
      }
    };
    void refreshPending().catch((error: unknown) => {
      if (!cancelled)
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
    });
    const readStream = () =>
      readSessionRuntimeState(sessionId ?? HOME_SESSION_RUNTIME_KEY).stream;

    /**
     * The single entry point for following a turn this client did not start.
     * It runs the same stream loop a local send uses, so history anchoring,
     * cursor resume, `resume_overflow` resync, the lease and every terminal
     * exit are handled in exactly one place.
     */
    const attachToTurn = (turnId: string | undefined) => {
      if (!sessionId || !resumeSession) return;
      const existing = readStream();
      if (existing.subscription) return;
      setSending(true);
      void runWebuiStreamLoop(
        { resumeSession, loadMessages },
        {
          sessionId,
          attachTurnId: turnId,
          ...(existing.cursor ? { afterCursor: existing.cursor } : {}),
        },
        buildWebuiStreamLoopSink(setStream),
      ).then((generation) => {
        // Only clear the indicator if this loop still owns the stream. A
        // loop that finished after a newer turn started would otherwise
        // make the new turn look idle while it is still streaming.
        if (ownsWebuiStreamGeneration(readStream(), generation))
          setSending(false);
      });
    };

    /** `session.start` named a turn we do not hold while holding another. */
    const recheckSubscription = (turnId: string | undefined) => {
      if (!sessionId || !getActiveTurn) return;
      // Read the lease *before* the probe leaves, not when it returns. A
      // local send that claims during the round trip gets a lease with no
      // turn id yet; reading only at resolution time would let this stale
      // snapshot retarget the user's own turn away from them.
      const probed = readStream().subscription;
      if (!probed) return;
      void getActiveTurn({ id: sessionId }).then((active) => {
        const owned = readStream().subscription;
        // The lease this probe was about is gone or has been replaced. The
        // answer describes a turn that is no longer ours to act on.
        if (!isWebuiSubscriptionProbeCurrent(probed, owned) || !owned) return;
        const decision = resolveWebuiSubscriptionRecheck(owned, active);
        if (decision === "hold") return;
        // Scoped to the generation we decided is stale: a newer loop may
        // have claimed while the probe was in flight, and that lease is
        // the live one. The old stream is not cancelled server-side, so its
        // late frames stay fenced out by the generation guard in the sink.
        setStream((current) =>
          releaseWebuiSubscription(current, { generation: owned.generation }),
        );
        // `release` means the turn the event announced is already over (or is
        // a compaction, which produces no transcript); its own terminal event
        // settles the phase.
        if (decision === "retarget" && active) attachToTurn(active.turnId);
      }).catch(() => undefined);
    };

    /**
     * Gap recovery. A `session.start` can arrive before this client finished
     * subscribing, or be missed entirely while `watchEvents` reconnects, and
     * the session list cannot answer the question — its `status` carries no
     * turn id and never refreshes on those events. Ask the server instead.
     */
    const recoverMissedTurn = () => {
      if (!sessionId || !getActiveTurn) return;
      void getActiveTurn({ id: sessionId }).then((active) => {
        if (!active || active.busyReason !== "turn") return;
        // Read the lease at resolution time, not at call time: a local send
        // that started while the probe was in flight has already claimed it.
        if (readStream().subscription) return;
        attachToTurn(active.turnId);
      }).catch(() => undefined);
    };

    const onRuntimeEvent = createWebuiWatchEventCallback(
      sessionId,
      () => readSessionRuntimeState(sessionId ?? HOME_SESSION_RUNTIME_KEY).stream,
      () => ({ permissions, questionnaire, goal }),
      {
        refreshPending: () => {
          void refreshPending().catch(() => undefined);
        },
        setSending,
        setStream,
        setPermissions,
        setQuestionnaire,
        // A goal-bearing event landing here invalidates any steering re-read
        // still in flight: that read is older than what we just applied.
        // `applyGoal` performs the version bump the re-read guard checks, so
        // the event path needs no writer of its own.
        setGoal: applyGoal,
        // Goal steering events announce that the objective moved without
        // carrying the new goal, so the banner is re-read rather than patched.
        // The read is eventually consistent, so a late answer must not undo a
        // newer goal that arrived while it was in flight.
        refreshGoal: () => {
          if (!sessionId || !getGoal) return undefined;
          const readFor = sessionId;
          const versionAtRequest = goalVersionRef.current;
          return getGoal({ sessionId: readFor }).then((nextGoal) => {
            if (readFor !== sessionIdRef.current) return;
            if (goalVersionRef.current !== versionAtRequest) return;
            applyGoal(nextGoal);
            if (nextGoal) setGoalMode(nextGoal.status !== "complete");
          });
        },
        attachStream: (turnId, mode) => {
          // `recheck` means we already hold a different turn's lease. The
          // event alone cannot say whether that lease is stale or genuinely
          // concurrent, so ask the server which turn is actually running.
          if (mode === "recheck") {
            void recheckSubscription(turnId);
            return;
          }
          attachToTurn(turnId);
        },
      },
    );
    const unsubscribe = watchEvents?.(onRuntimeEvent, () => {
      // The server accepted `watchEvents` and is pumping it. Not a
      // subscription barrier — the runtime subscribes on the server's first
      // pull, just after this — so this is the same probe the mount path
      // runs, repeated once the stream is being established rather than
      // only requested. A reconnect may also have missed permission,
      // questionnaire, queue or `session.start` events while the browser
      // was suspended, so re-read the authoritative state too.
      void refreshPending().catch(() => undefined);
      recoverMissedTurn();
    });
    // Neither probe is gated on the watcher, and the two are not ordered
    // against each other. A turn that started before a probe read the server
    // is still running, so `getActiveTurn` returns it; a turn that starts
    // after announces itself on the event stream. When there is no watcher
    // there is no announcement to wait for, so the mount probe is the only
    // recovery this client has.
    if (unsubscribe === undefined) recoverMissedTurn();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [
    agentName,
    getActiveTurn,
    getPendingQuestionnaire,
    listPendingPermissions,
    listQueueMessages,
    resumeSession,
    sessionId,
    watchEvents,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!getPermissionMode || !setPermissionMode) {
      setPermissionUnavailable(true);
      return undefined;
    }
    getPermissionMode()
      .then((value) => {
        if (cancelled) return;
        const mode = readPermissionMode(value);
        if (!mode) throw new Error("运行时返回了不支持的授权模式");
        setPermissionModeValue(mode);
        setPermissionUnavailable(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPermissionUnavailable(true);
        setInteractionError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [getPermissionMode, setPermissionMode]);

  useEffect(() => {
    if (composerMenu !== "plugins" && !mentionRange) return;
    if (!pluginManagement) {
      setInstalledPlugins([]);
      return;
    }
    let cancelled = false;
    setPluginsLoading(true);
    setPluginsError(undefined);
    pluginManagement({ action: "listInstalledPlugins", input: { limit: 200 } })
      .then((result) => {
        if (cancelled) return;
        setInstalledPlugins(composerRows(result).map((row) => {
          const name = typeof row.name === "string" ? row.name : typeof row.pluginName === "string" ? row.pluginName : "";
          const displayName = typeof row.displayName === "string" ? row.displayName : name;
          return { name, displayName, ...(typeof row.description === "string" ? { description: row.description } : {}) };
        }).filter((plugin) => plugin.name));
      })
      .catch((error: unknown) => {
        if (!cancelled) setPluginsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!cancelled) setPluginsLoading(false); });
    return () => { cancelled = true; };
  }, [composerMenu, mentionRange !== undefined, pluginManagement]);

  useEffect(() => {
    if (composerMenu !== "skills") return;
    if (!listSkills) {
      setSkillsMenuError("技能目录暂不可用");
      return;
    }
    let cancelled = false;
    setSkillsMenuLoading(true);
    setSkillsMenuError(undefined);
    listSkills({ agentName })
      .then((result) => { if (!cancelled) setSlashSkills(result.skills); })
      .catch((error: unknown) => { if (!cancelled) setSkillsMenuError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setSkillsMenuLoading(false); });
    return () => { cancelled = true; };
  }, [composerMenu, listSkills, agentName]);

  useEffect(() => {
    if (!mentionRange || !workspaceDir || !listWorkspaceFileTree) {
      setWorkspaceFiles([]);
      return undefined;
    }
    let cancelled = false;
    listWorkspaceFileTree({ workspaceDir })
      .then((files) => { if (!cancelled) setWorkspaceFiles(flattenWorkspaceFiles(files).slice(0, 100)); })
      .catch((error: unknown) => {
        if (!cancelled) setInteractionError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [mentionRange !== undefined, workspaceDir, listWorkspaceFileTree]);

  useLayoutEffect(() => {
    const caret = pendingMentionCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === undefined || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    pendingMentionCaretRef.current = undefined;
    // The slash palette derives its state from `composerCaret`, so a caret the
    // composer moved itself has to be mirrored there — no input event follows.
    setComposerCaret(caret);
  }, [draft]);

  useEffect(() => {
    if (!isGoalEnabled) {
      setGoalEnabled(true);
      return undefined;
    }
    let cancelled = false;
    void isGoalEnabled()
      .then((result) => {
        if (cancelled) return;
        setGoalEnabled(result.enabled);
        if (!result.enabled) setGoalMode(false);
      })
      .catch(() => { if (!cancelled) setGoalEnabled(false); });
    return () => { cancelled = true; };
  }, [isGoalEnabled]);

  useEffect(() => {
    if (!sessionId || !getGoal || !goalEnabled) {
      applyGoal(undefined);
      setGoalMode(false);
      return undefined;
    }
    applyGoal(undefined);
    setGoalMode(false);
    let cancelled = false;
    // Same stale-window as the steering re-read: this request can be overtaken
    // by a `thread_goal.*` event while it is in flight, and answering with the
    // older snapshot would resurrect what the event just replaced.
    const versionAtRequest = goalVersionRef.current;
    void getGoal({ sessionId })
      .then((nextGoal) => {
        if (cancelled) return;
        if (goalVersionRef.current !== versionAtRequest) return;
        applyGoal(nextGoal);
        if (nextGoal) setGoalMode(nextGoal.status !== "complete");
      })
      .catch(() => {
        // Same guard on the error path: a rejection must not erase a goal that
        // a newer event installed while this request was in flight.
        if (!cancelled && goalVersionRef.current === versionAtRequest)
          applyGoal(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [getGoal, goalEnabled, sessionId]);

  useEffect(() => {
    if (!listModels && !getAccountStatus) return undefined;
    let cancelled = false;
    const refreshInspection = async () => {
      const [nextModels, nextAccount] = await Promise.all([
        listModels?.({ sessionId }),
        getAccountStatus?.({ sessionId }),
      ]);
      if (cancelled) return;
      setModels(nextModels ?? []);
      setAccountStatus(nextAccount);
    };
    void refreshInspection().catch((error: unknown) => {
      if (!cancelled)
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
    });
    const timer = setInterval(() => {
      void refreshInspection().catch(() => undefined);
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [getAccountStatus, listModels, sessionId]);

  const handlePermission = async (
    permission: WebuiPendingPermission,
    decision: "allowOnce" | "allowAlways" | "deny",
  ) => {
    if (!replyPermission) return;
    setInteractionError(undefined);
    try {
      const result = await replyPermission({
        name: permission.agentName,
        requestId: permission.requestId,
        reply: decision,
      });
      if (result.success !== true)
        throw new Error("The permission request was no longer pending");
      setPermissions((current) =>
        current.filter((item) => item.requestId !== permission.requestId),
      );
      setStream((current) => ({ ...current, phase: "streaming" }));
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleQuestionnaire = async (
    request: WebuiQuestionnaireRequest,
    answers: readonly WebuiQuestionnaireAnswer[],
  ) => {
    if (!replyQuestionnaire) return;
    setInteractionError(undefined);
    try {
      const result = await replyQuestionnaire({
        name: request.requester?.agentName ?? agentName,
        requestId: request.id,
        schemaVersion: request.schemaVersion,
        answers,
      });
      if (result.ok !== true)
        throw new Error("The questionnaire was not accepted");
      setQuestionnaire(undefined);
      // Answering resumes the turn; a skipped answer ends it (see
      // `webuiAnswersEndTurn`). Leaving `streaming` after a skip strands the
      // transcript's thinking pulse, because a finished turn never sends the
      // `[DONE]` frame that would otherwise clear it.
      setStream((current) => ({
        ...current,
        phase: webuiAnswersEndTurn(answers) ? "idle" : "streaming",
      }));
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleDismiss = async (request: WebuiQuestionnaireRequest) => {
    if (!dismissQuestionnaire) return;
    setInteractionError(undefined);
    try {
      const result = await dismissQuestionnaire({
        name: request.requester?.agentName ?? agentName,
        requestId: request.id,
      });
      if (result.ok !== true)
        throw new Error("The questionnaire could not be dismissed");
      setQuestionnaire(undefined);
      // A dismissal never resumes the turn — the runtime only marks the
      // request dismissed — so this is the same "nothing happens now" state
      // a skip produces, and `streaming` was simply wrong here.
      setStream((current) => ({ ...current, phase: "idle" }));
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleStop = async () => {
    if (!sessionId || !abortSession) return;
    setInteractionError(undefined);
    try {
      await stopWebuiTurn({ abortSession, sessionId, setSending, setStream });
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleDeleteQueueItem = async (item: WebuiQueueItem) => {
    if (!deleteQueueItem || !sessionId) return;
    setInteractionError(undefined);
    try {
      await deleteQueueItem({ id: sessionId, itemId: item.itemId });
      setQueueItems((current) =>
        current.filter((candidate) => candidate.itemId !== item.itemId),
      );
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleSelectModel = async (
    model: WebuiModelEntry,
    draft: WebuiModelPickerDraft,
  ) => {
    if (!selectModel) return;
    setInteractionError(undefined);
    try {
      const result = await selectModel(
        buildWebuiModelSelectionRequest(model, draft, sessionId),
      );
      if (result.success === false)
        throw new Error("The model could not be selected");
      const refreshed = await listModels?.({
        ...(sessionId ? { sessionId } : {}),
      });
      if (refreshed) setModels(refreshed);
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const selectedModel = models.find((model) => model.selected);
  const enabledModels = models.filter((model) => model.enabled !== false);
  // The slash token the caret sits in, found the same way as an `@` mention.
  // Every slash opens the palette, not only one at the start of the draft:
  // `findWebuiSlashRange` anchors on the caret and on `(?:^|\s)`, so `帮我 /pl`
  // ranks commands exactly like `/pl` while `http://x` stays a URL. Reading the
  // un-trimmed draft keeps the panel closed once the user types the trailing
  // space after a command — trimming would re-open it, because "/name "
  // trims to "/name" and matches again.
  const commandRange = findWebuiSlashRange(draft, composerCaret);
  const commandQuery = commandRange?.query ?? "";
  // Pull a fresh skill pool from the harness when `listSkills` is wired up.
  // The fallback (fixtures resolved at module init) keeps the popover
  // functional even if the RPC is unavailable or rejects; once the live
  // registry returns, fetched entries replace the fixtures in the sectioning
  // pass.
  const [slashSkills, setSlashSkills] = useState<readonly WebuiSlashSkillSummary[]>(
    [],
  );
  const slashSkillsLoadedRef = useRef(false);
  useEffect(() => {
    if (!listSkills) return;
    if (slashSkillsLoadedRef.current) return;
    let cancelled = false;
    slashSkillsLoadedRef.current = true;
    listSkills({ agentName })
      .then((result) => {
        if (cancelled) return;
        setSlashSkills(result.skills);
      })
      .catch(() => {
        // The popover keeps using the fixtures when the RPC rejects; nothing
        // else to do here. The fetched-set flag stays true so we don't retry
        // on every keystroke; the composer mounts once per session, not on
        // every open.
        if (cancelled) return;
        slashSkillsLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [listSkills, agentName]);
  const slashSectioned = slashSkills.length
    ? sectionWebuiSlashPalette(
        WEBUI_BUILTIN_COMMANDS,
        slashSkills.map(slashSkillSummaryToEntry),
      )
    : WEBUI_SLASH_FALLBACK_SECTIONED;
  const commandSuggestions = commandRange
    ? rankWebuiSlashPalette(slashSectioned, commandQuery)
    : [];
  const mentionQuery = mentionRange?.query.toLocaleLowerCase() ?? "";
  const mentionSuggestions: readonly ComposerMentionChoice[] = mentionRange
    ? [
        ...installedPlugins
          .filter((plugin) => `${plugin.displayName} ${plugin.name}`.toLocaleLowerCase().includes(mentionQuery))
          .map((plugin) => ({ kind: "plugin" as const, name: plugin.name, label: plugin.displayName, detail: plugin.description, section: "插件" })),
        { kind: "local-file" as const, label: "添加本地文件", section: "本地资源" },
        { kind: "local-folder" as const, label: "添加本地文件夹", section: "本地资源" },
        ...workspaceFiles
          .filter((file) => `${file.name} ${file.path}`.toLocaleLowerCase().includes(mentionQuery))
          .map((file) => ({ kind: "file" as const, path: file.path, label: file.path, section: "项目文件" })),
        ...sessions
          .filter((session) => session.parentSessionId === sessionId)
          .filter((session) => `${session.title ?? session.agentName} ${session.agentName}`.toLocaleLowerCase().includes(mentionQuery))
          .map((session) => ({ kind: "agent" as const, session, label: session.title ?? session.agentName, section: "子 Agent" })),
      ]
    : [];
  const [commandIndex, setCommandIndex] = useState(0);
  useEffect(() => {
    setMentionIndex((current) => mentionSuggestions.length === 0 ? 0 : Math.min(current, mentionSuggestions.length - 1));
  }, [mentionRange?.query, mentionSuggestions.length]);
  useEffect(() => {
    setCommandIndex((current) =>
      commandSuggestions.length === 0
        ? 0
        : Math.min(current, commandSuggestions.length - 1),
    );
  }, [commandRange?.query, commandSuggestions.length]);
  // Mirror the desktop's TipTap suggestion plugin behaviour: while the slash
  // popover is open, a pointerdown outside the composer region cancels the
  // slash invocation. The Escape handler above already does the same thing
  // for the keyboard. Without this, the popover stays pinned above the
  // composer until the user types a space or deletes the "/" by hand. We keep
  // refs to `draft` and the current range so the listener always sees the
  // latest values without re-attaching on every keystroke.
  const slashDraftRef = useRef(draft);
  const slashRangeRef = useRef(commandRange);
  useEffect(() => {
    slashDraftRef.current = draft;
    slashRangeRef.current = commandRange;
  });
  const slashPanelOpen = commandRange !== undefined;
  useEffect(() => {
    if (!composerMenu && !permissionMenuOpen && !mentionRange) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      // The three surfaces share this listener but NOT their container: the
      // `+` menu and the mention list are anchored to the textarea and stay
      // open while the caret moves inside the composer, while the permission
      // popover is a dropdown hinged to the footer button and dismisses on any
      // other click, the textarea included. Judging all three against the
      // composer region is what made the popover un-dismissable from inside
      // the composer. The decision itself lives in `evaluateComposerDismiss`;
      // see that function for the full rule.
      const dismiss = evaluateComposerDismiss({
        permissionMenuOpen,
        insidePermissionWrap: permissionWrapRef.current?.contains(event.target) === true,
        addMenuOpen: Boolean(composerMenu),
        insideAddWrap: composerAddWrapRef.current?.contains(event.target) === true,
        insideComposerRegion: composerRegionRef.current?.contains(event.target) === true,
      });
      if (!dismiss.closeComposerMenu && !dismiss.closePermissionMenu && !dismiss.closeMentionRange) {
        return;
      }
      if (dismiss.closeComposerMenu) setComposerMenu(undefined);
      if (dismiss.closePermissionMenu) setPermissionMenuOpen(false);
      if (dismiss.closeMentionRange) setMentionRange(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [composerMenu, permissionMenuOpen, mentionRange]);
  // The workspace picker had NO outside-close listener at all: the only ways to
  // close it were re-clicking its trigger, picking a row, or navigating away,
  // so a stray click anywhere on the page left the panel hanging open. It gets
  // its own effect rather than joining the listener above because it is a
  // separate surface with a separate container — the trigger-and-panel wrap —
  // and it renders below the form, outside the composer's own dismiss group.
  useEffect(() => {
    if (!workspaceMenuOpen && !workspaceBrowserOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        evaluateOutsideClose({
          surface: "workspacePicker",
          kind: "pointerdown",
          insideContainer: workspacePickerRef.current?.contains(event.target) === true,
        }) !== "close"
      ) {
        return;
      }
      setWorkspaceMenuOpen(false);
      setWorkspaceBrowserOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [workspaceMenuOpen, workspaceBrowserOpen, setWorkspaceMenuOpen]);
  // Flip the popover below the composer when there isn't enough room above
  // for the full 320px cap. The measurement runs in `useLayoutEffect` so the
  // first paint already shows the correct placement — a normal `useEffect`
  // would let the panel render above, then re-render below, producing a
  // visible "jump" the moment the user types `/`.
  const [slashPanelBelow, setSlashPanelBelow] = useState(false);
  useLayoutEffect(() => {
    if (!slashPanelOpen) {
      setSlashPanelBelow(false);
      return;
    }
    const region = composerRegionRef.current;
    if (!region) return;
    const measure = () => {
      const rect = region.getBoundingClientRect();
      // Leave headroom of `28px` (= composer top + 24px footer padding + 4px
      // breathing) so the panel never clips into the viewport top edge.
      const availableAbove = Math.max(0, rect.top - 28);
      const needsFlip = availableAbove < 280;
      setSlashPanelBelow(needsFlip);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [slashPanelOpen, slashSkills.length]);
  useEffect(() => {
    if (!slashPanelOpen) return;
    const region = composerRegionRef.current;
    if (!region) return;
    const onPointerDown = (event: PointerEvent) => {
      const range = slashRangeRef.current;
      if (!range) return;
      if (!(event.target instanceof Node)) return;
      const insideContainer = region.contains(event.target);
      // Slash popover's per-surface variant subscribes to `pointerdown`
      // only (no Escape handler — the composer input change handler is
      // the only path). Routing through `evaluateOutsideClose` keeps the
      // four call sites consistent without changing the original close
      // semantics.
      if (
        evaluateOutsideClose({
          surface: "slashPopover",
          kind: "pointerdown",
          insideContainer,
        }) !== "close"
      ) {
        return;
      }
      // Same clear-and-close as Escape: drop the "/xxx" token so the
      // palette no longer has a token under the caret and disappears.
      onDraftChange(removeWebuiSlashToken(slashDraftRef.current, range));
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [slashPanelOpen, onDraftChange]);
  const addFiles = async (filesLike: FileList | readonly File[] | null) => {
    const files = filesLike ? Array.from(filesLike) : [];
    if (files.length === 0) return;
    const limitError = webuiAttachmentLimitError(attachments, files.map((file) => ({ sizeBytes: file.size })));
    if (limitError) {
      setInteractionError(limitError);
      return;
    }
    setAttachmentBusy(true);
    setInteractionError(undefined);
    try {
      const additions = await Promise.all(files.map(async (file): Promise<ComposerAttachment> => {
        const dataUrl = await readBrowserFile(file);
        const fileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        return {
          id: crypto.randomUUID(),
          fileName,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          dataUrl,
          kind: file.type.startsWith("image/") ? "image" : "file",
        };
      }));
      setAttachments((current) => [...current, ...additions]);
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttachmentBusy(false);
    }
  };
  const attachmentWire = attachments.map((attachment) => ({
    meta: {
      attachmentType: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    },
    local: { dataUrl: attachment.dataUrl },
  }));
  const replaceMention = (insertion: string) => {
    if (!mentionRange) return;
    const result = insertWebuiMention(draft, mentionRange, insertion);
    pendingMentionCaretRef.current = result.caret;
    onDraftChange(result.value);
    setMentionRange(undefined);
  };
  const insertAtCaret = (insertion: string) => {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
    const inserted = `${prefix}${insertion} `;
    pendingMentionCaretRef.current = before.length + inserted.length;
    onDraftChange(`${before}${inserted}${draft.slice(caret)}`);
  };
  const chooseMention = (choice: ComposerMentionChoice) => {
    setMentionRange(undefined);
    if (choice.kind === "plugin") {
      replaceMention(`@${choice.name}`);
      return;
    }
    if (choice.kind === "file") {
      replaceMention(`@${choice.path}`);
      return;
    }
    if (choice.kind === "local-file") {
      replaceMention("");
      fileInputRef.current?.click();
      return;
    }
    if (choice.kind === "local-folder") {
      replaceMention("");
      folderInputRef.current?.click();
      return;
    }
    if (!onSelectSession) {
      setInteractionError("子 Agent 切换暂不可用");
      return;
    }
    replaceMention("");
    onSelectSession(choice.session.sessionId);
  };
  const changePermissionMode = async (mode: WebuiComposerPermissionMode) => {
    if (!setPermissionMode || !getPermissionMode) return;
    setPermissionBusy(true);
    setInteractionError(undefined);
    try {
      await setPermissionMode({ mode });
      const refreshed = readPermissionMode(await getPermissionMode());
      if (refreshed !== mode) throw new Error("授权模式未能保存，请重试");
      setPermissionModeValue(refreshed);
      setPermissionUnavailable(false);
      setPermissionMenuOpen(false);
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPermissionBusy(false);
    }
  };
  const activateGoalMode = () => {
    if (!goalEnabled || !createGoal) return;
    setGoalMode(true);
    setPlanMode(false);
    onDraftChange("");
    textareaRef.current?.focus();
  };
  const editGoalInComposer = (objective: string) => {
    editingGoalDraftRef.current = true;
    setGoalMode(true);
    setPlanMode(false);
    onDraftChange(objective);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(objective.length, objective.length);
    });
  };
  const cancelGoalMode = () => {
    setGoalMode(false);
    if (!goal || editingGoalDraftRef.current) onDraftChange("");
    editingGoalDraftRef.current = false;
    textareaRef.current?.focus();
  };
  const activatePlanMode = () => {
    setPlanMode(true);
    setGoalMode(false);
    onDraftChange("");
    textareaRef.current?.focus();
  };
  const cancelPlanMode = () => {
    setPlanMode(false);
    onDraftChange("");
    textareaRef.current?.focus();
  };
  const handleDraftChange = (next: string) => {
    if (next.trim().toLowerCase() === "/goal") {
      activateGoalMode();
      return;
    }
    onDraftChange(next);
  };
  const chooseCommand = (command: string) => {
    if (command === "goal") {
      activateGoalMode();
      return;
    }
    if (command === "plan") {
      activatePlanMode();
      return;
    }
    const insertion = `/${command} `;
    // Rewrite only the token the caret sits in. The draft can already hold an
    // earlier "/skill" the user picked; replacing the whole draft wiped it.
    if (!commandRange) {
      onDraftChange(insertion);
      pendingMentionCaretRef.current = insertion.length;
      textareaRef.current?.focus();
      return;
    }
    const result = replaceWebuiSlashToken(draft, commandRange, insertion);
    onDraftChange(result.value);
    // The caret has to land after the trailing space: the palette is open for
    // any token under the caret, so leaving it inside "/command" would pop the
    // panel straight back open.
    pendingMentionCaretRef.current = result.caret;
    textareaRef.current?.focus();
  };
  const commandInvocation = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(
    draft.trim(),
  );
  const credentialMessage =
    sessionId && typeof selectedModel?.status?.lastErrorMessage === "string"
      ? selectedModel.status.lastErrorMessage
      : sessionId && accountStatus && accountStatus.available === false
        ? "No usable credentials are available for the selected model."
        : undefined;
  // Typing is always available: composing a message does not need a target yet.
  // The first send creates the target session silently, using the selected project.
  const canCompose = Boolean(sendMessage);
  const canQueue = Boolean(enqueueMessage && sessionId);
  // Turn phase remains part of session runtime state; the transcript owns all
  // visible messages for both the live and settled phases.
  // `isTurnLive` is the single source of truth for the three-value phase
  // predicate; `session-runtime-store.ts` carries `sending` as a separate
  // submit-lifecycle boolean the reducer deliberately does NOT merge with
  // `phase` — `submitWebuiComposerTurn` relies on the two staying distinct.
  useLayoutEffect(() => {
    if (!sessionLayout) return undefined;
    const region = composerRegionRef.current;
    const layout = region?.closest<HTMLElement>(
      '[data-webui-session-layout="true"]',
    );
    if (!region || !layout) return undefined;
    const updateReservedHeight = () => {
      // Desktop reserves the measured composer inset plus a small base tail
      // inside its single message viewport. Keep the same contract here so a
      // taller slash/permission/composer state cannot cover the live tail.
      const height = Math.ceil(region.getBoundingClientRect().height);
      layout.style.setProperty(
        "--webui-composer-bottom-padding",
        `${height + 16}px`,
      );
    };
    updateReservedHeight();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updateReservedHeight);
    observer?.observe(region);
    window.addEventListener("resize", updateReservedHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateReservedHeight);
      layout.style.removeProperty("--webui-composer-bottom-padding");
    };
  }, [sessionLayout]);
  const messageDraft = [draft.trim(), ...urlReferences.map((reference) => reference.url.trim()).filter(Boolean)].filter(Boolean).join("\n");
  const sendable = (canCompose || canQueue) && (Boolean(messageDraft) || attachments.length > 0);
  // The one gate for "a submit can start right now". The send button's
  // `disabled` and the Enter shortcut both read this value, so the keyboard
  // can never open a submit path the button itself would have refused.
  const submitBlocked = !sendable || commandRunning || goalSubmitting;
  // The submit handler is a single call into
  // `submitWebuiComposerTurn` with the assembled handler bundle. The
  // assembly itself is `buildWebuiComposerHandlers` — a named unit
  // the shell test drives — so a regression that drops, swaps, or
  // ignores a field inside the assembly is caught by a failing
  // assertion. The component's call site here is verified by
  // inspection: with no DOM environment, the React render path
  // cannot be exercised, and source-text assertions are not part
  // of this project's policy.
  const handlers = buildWebuiComposerHandlers({
    setStream,
    readStream: () => readSessionRuntimeState(sessionId ?? HOME_SESSION_RUNTIME_KEY).stream,
    setSending,
    onDraftChange,
    onNeedsSession,
    onSessionCreated,
    onQueued: () => {
      if (!sessionId || !listQueueMessages) return;
      void listQueueMessages({ id: sessionId })
        .then((queue) => {
          setQueueItems(queue.items ?? []);
          setQueuePaused(queue.paused === true);
        })
        .catch((error: unknown) => {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
        });
    },
  });
  /**
   * The one way a turn reaches the wire. `submit` calls it after resolving an
   * intent; the retry affordance calls it with the input recorded at submit
   * time. Retry deliberately re-enters THIS path rather than a second send of
   * its own, so it inherits the rules an ordinary send obeys — including the
   * "a turn is already in flight ⇒ enqueue" branch inside
   * `submitWebuiComposerTurn`, which is what keeps a retry from racing a
   * running turn.
   */
  const sendTurn = async (turn: {
    readonly message: string;
    readonly clientIntent?: string;
  }) => {
    // A newly submitted turn is a Desktop-style request to follow the latest
    // frontier. The scroll listener can still release this lock immediately
    // if the user wheels back into history while the turn is running.
    let turnRuntimeWriter = sessionId
      ? createSessionRuntimeWriter({ kind: "session", sessionId })
      : createSessionRuntimeWriter({ kind: "home" });
    const turnHandlers = {
      ...handlers,
      setStream: (update: Parameters<typeof turnRuntimeWriter.setStream>[0]) =>
        turnRuntimeWriter.setStream(update),
      setSending: (sending: boolean) => turnRuntimeWriter.setSending(sending),
      onSessionCreated: (createdSessionId: string) => {
        handlers.onSessionCreated?.(createdSessionId);
        if (turnRuntimeWriter.kind === "home") {
          turnRuntimeWriter = turnRuntimeWriter.migrateToSession(createdSessionId);
        }
      },
    };
    await submitWebuiComposerTurn(
      {
        sessionId,
        // `submitWebuiComposerTurn` reads `args.message ?? args.draft` and
        // trims it, so passing the effective text as `message` re-sends it
        // through exactly the path an ordinary send takes. `draft` carries the
        // same value so the "no session yet" hand-off reports the input that
        // is actually going to be sent.
        draft: turn.message,
        message: turn.message,
        ...(turn.clientIntent
          ? { clientIntent: turn.clientIntent }
          : planMode
            ? { clientIntent: "plan-entry" }
            : {}),
        attachments: attachmentWire,
        onAttachmentsSubmitted: () => { setAttachments([]); setUrlReferences([]); },
        sending,
        deps: { sendMessage, resumeSession, loadMessages },
        enqueueMessage,
        createSession,
        createSessionWorkspaceDir,
        teamModeOff,
      },
      turnHandlers,
    );
  };
  // The input of the last turn this composer submitted, kept locally so retry
  // can re-send it without asking the server what was asked. Two holders, one
  // value, as the slash-range ref above also does: the ref is what the retry
  // handler reads (always current, even before the re-render lands), and the
  // state is what makes the affordance appear at all.
  const recordedTurnRef = useRef<WebuiRecordedTurn>();
  const [recordedTurn, setRecordedTurn] = useState<WebuiRecordedTurn>();
  const recordSubmittedTurn = (message: string) => {
    const record: WebuiRecordedTurn = { session: sessionId, message };
    recordedTurnRef.current = record;
    setRecordedTurn(record);
  };
  const retryPlan = planWebuiRetryResend({
    refusal: stream.refusal,
    recordedSession: recordedTurn?.session,
    session: sessionId,
    lastSubmittedText: recordedTurn?.message,
  });
  const handleRetryResend = () => {
    resendRecordedWebuiTurn({
      refusal: stream.refusal,
      recordedTurn: recordedTurnRef.current,
      session: sessionId,
      sendTurn,
    });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = commandInvocation
      ? slashSectioned.find(
          (item) => item.name === commandInvocation[1],
        )
      : undefined;
    // Pure intent resolution — five paths: activate-goal-mode, submit-goal,
    // run-command, submit-turn (which submitWebuiComposerTurn further
    // splits into send+resume vs queue). All side effects (state updates,
    // draft clearing, auto-follow lock, error rendering) stay in this
    // function so the resolver itself can be tested without React.
    const intent = resolveWebuiSubmissionIntent({
      draft: messageDraft,
      commandMatch: command,
      ...(commandInvocation?.[1] !== undefined
        ? { commandInvocationName: commandInvocation[1] }
        : {}),
      ...(commandInvocation?.[2] !== undefined
        ? { commandInvocationInput: commandInvocation[2] }
        : {}),
      goalMode,
      planMode,
    });
    const resolvedIntent = intent ?? (attachments.length > 0 ? { kind: "submit-turn" as const } : undefined);
    if (!resolvedIntent) return;
    // Record the sendable text for ↑ recall on every committed intent —
    // send/queue turns, goal objectives, and runnable commands all start as
    // user-typed composer text. Recording at commit time (not transport
    // success) keeps a refused send from silently eating the user's input,
    // and mode activations (`/goal`, `/plan` bare) record nothing.
    if (
      resolvedIntent.kind === "submit-turn" ||
      resolvedIntent.kind === "submit-goal" ||
      resolvedIntent.kind === "run-command"
    ) {
      onInputSubmitted?.(messageDraft);
      setHistoryBrowse(undefined);
    }
    if (resolvedIntent.kind === "activate-goal-mode") {
      activateGoalMode();
      return;
    }
    if (resolvedIntent.kind === "activate-plan-mode") {
      activatePlanMode();
      return;
    }
    if (resolvedIntent.kind === "submit-goal") {
      const { objective } = resolvedIntent;
      if (!createGoal || !goalEnabled) return;
      setGoalSubmitting(true);
      setInteractionError(undefined);
      try {
        const nextGoal = await submitWebuiGoal(
          {
            sessionId,
            objective,
            currentGoal: goal,
            createGoal,
            patchGoal,
            createSession,
            createSessionWorkspaceDir,
            teamModeOff,
          },
          onSessionCreated,
        );
        applyGoal(nextGoal);
        setGoalMode(nextGoal.status !== "complete");
        onDraftChange("");
        editingGoalDraftRef.current = false;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setGoalSubmitting(false);
      }
      return;
    }
    if (resolvedIntent.kind === "run-command") {
      const { command: matchedCommand, input } = resolvedIntent;
      // The original gate (`runCommand && command && isWebuiRunnableCommand`)
      // collapsed into the intent, but the `runCommand` runtime check stays
      // here — the resolver is the source of truth for *which* path, the
      // component is still the source of truth for *whether the host wired
      // the capability* (a disabled host must not reach the run-path).
      if (!runCommand) return;
      setCommandRunning(true);
      setInteractionError(undefined);
      try {
        const result = await runCommand({
          command: matchedCommand.name,
          ...(input ? { input } : {}),
          ...(sessionId ? { sessionId } : {}),
          agentName,
          ...(createSessionWorkspaceDir
            ? { workspaceDir: createSessionWorkspaceDir }
            : {}),
        });
        const output =
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.data ?? result, null, 2);
        setCommandOutput(output);
        onDraftChange("");
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setCommandRunning(false);
      }
      return;
    }
    // intent.kind === "submit-turn"
    if (resolvedIntent.clientIntent === "plan-entry") {
      setGoalMode(false);
      setPlanMode(true);
    }
    // The exact value `submitWebuiComposerTurn` puts on the wire: it reads
    // `message ?? draft` and trims it, so recording the effective text here is
    // what lets a later retry reproduce this send byte for byte.
    const effectiveMessage = resolvedIntent.message ?? draft;
    recordSubmittedTurn(effectiveMessage);
    await sendTurn({
      message: effectiveMessage,
      ...(resolvedIntent.clientIntent
        ? { clientIntent: resolvedIntent.clientIntent }
        : {}),
    });
  };
  const clearLocalGoal = () => {
    applyGoal(undefined);
    setGoalMode(false);
  };
  // A request that sets `replaceComposer` owns the composer's slot: the
  // runtime sets it on every ordinary questionnaire and on the plan review
  // (only feature-enable requests leave it false), and the desktop draws the
  // interaction card exactly where the input would be. The input therefore
  // yields its place rather than sitting under the card, and comes back the
  // moment the request is answered — which is the whole point of the flag.
  const composerReplaced =
    questionnaire !== undefined &&
    (questionnaire.presentation?.replaceComposer ?? true);
  return (
    <section
      aria-label="Compose message"
      className={`w-full ${sessionLayout ? "webui-session-composer" : ""}`}
      data-webui-session-composer={sessionLayout ? "true" : undefined}
    >
      {sessionId ? (
        <WebuiInteractionPanel
          sessionId={sessionId}
          permissions={permissions}
          questionnaire={questionnaire}
          onPermission={handlePermission}
          onQuestionnaire={handleQuestionnaire}
          onDismiss={handleDismiss}
          interactionError={interactionError}
        />
      ) : null}
      {queuePaused && sessionId ? (
        <span
          role="status"
          className="text-text_default_secondary text-size_12"
        >
          队列已暂停
        </span>
      ) : null}
      {queueItems.length > 0 ? (
        <section
          className="mt-3 flex w-full flex-col gap-2"
          data-webui-queue="true"
        >
          <strong className="text-size_14">
            Waiting messages ({queueItems.length})
          </strong>
          {queueItems.map((item) => (
            <article
              key={item.itemId}
              className="webui-card flex items-center gap-2 p-spacing_12"
            >
              <span className="min-w-0 flex-1 truncate text-size_14">
                {item.content || item.itemId}
              </span>
              {item.status === "queued" ? (
                <button
                  type="button"
                  className="webui-button-secondary text-size_12"
                  onClick={() => void handleDeleteQueueItem(item)}
                  data-webui-remove-queue-item={item.itemId}
                >
                  Remove
                </button>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      {stream.refusal ? (
        <OutputError
          variant="output_error"
          text={stream.refusal}
          errorAt={Date.now()}
          {...(retryPlan.kind === "resend" ? { onRetry: handleRetryResend } : {})}
        />
      ) : null}
      {commandOutput ? (
        <pre
          className="mt-3 w-full whitespace-pre-wrap text-text_default_secondary text-size_12 leading-line_height_16"
          data-webui-command-output="true"
        >
          {commandOutput}
        </pre>
      ) : null}
      {stream.transcriptIncomplete ? (
        <p
          data-webui-transcript-incomplete="true"
          className="text-text_default_secondary text-size_14 leading-line_height_20"
        >
          The displayed transcript may be incomplete; the last update failed
          before all frames could be applied.
        </p>
      ) : null}

      <div
        ref={composerRegionRef}
        className={`relative ${sessionLayout ? "mt-0 webui-session-composer-overlay" : "mt-8"} w-full`}
        data-webui-composer-region="true"
        data-webui-session-composer-overlay={sessionLayout ? "true" : undefined}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="webui-composer-hidden-file-input"
          aria-label="添加文件或图片"
          onChange={(event) => { void addFiles(event.currentTarget.files); event.currentTarget.value = ""; }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="webui-composer-hidden-file-input"
          aria-label="添加本地文件夹"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(event) => { void addFiles(event.currentTarget.files); event.currentTarget.value = ""; }}
        />
        <div className={sessionLayout && sessionId && goalEnabled && goal ? "webui-goal-composer-panel" : undefined}>
        {sessionId && goalEnabled && goal ? <WebuiGoalBanner goal={goal} patchGoal={patchGoal} clearGoal={clearGoal} onEditGoal={editGoalInComposer} onCleared={clearLocalGoal} interactionBlocked={Boolean(questionnaire || permissions.length > 0)} /> : null}
        {!composerReplaced ? (
        <form
          onSubmit={submit}
          onDragOver={(event) => { if (event.dataTransfer.files.length) event.preventDefault(); }}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } }}
          data-webui-composer="true"
          className="w-full"
        >
          <div className="message-input-home-container flex flex-col items-center gap-1.5 rounded-[20px] bg-bg_default_scrim pb-2">
            <div className="w-full rounded-[20px] border border-border_default bg-bg_grouped_secondary_elevated p-3 webui-composer-card">
              <div className="message-input-container relative transition-colors">
                <label className="sr-only" htmlFor={`${fieldId}-content`}>
                  Message
                </label>
                <textarea
                  ref={textareaRef}
                  id={`${fieldId}-content`}
                  name="content"
                  rows={2}
                  value={draft}
                  onChange={(event) => {
                    const next = event.target.value;
                    handleDraftChange(next);
                    // A real user edit ends any active history browse (see
                    // the browse state comment above).
                    setHistoryBrowse(undefined);
                    const caret = event.target.selectionStart;
                    mentionCaretRef.current = caret;
                    setComposerCaret(caret);
                    const nextMentionRange = findWebuiMentionRange(next, caret);
                    if (nextMentionRange) {
                      setComposerMenu(undefined);
                      setPermissionMenuOpen(false);
                    }
                    setMentionRange(nextMentionRange);
                  }}
                  onPaste={(event) => {
                    const pastedFiles = Array.from(event.clipboardData.items).flatMap((item) => item.kind === "file" ? [item.getAsFile()].filter((file): file is File => file !== null) : []);
                    if (pastedFiles.length) { event.preventDefault(); void addFiles(pastedFiles); return; }
                    const pastedText = event.clipboardData.getData("text/plain").trim();
                    if (/^https?:\/\/\S+$/iu.test(pastedText)) {
                      event.preventDefault();
                      const start = event.currentTarget.selectionStart;
                      const end = event.currentTarget.selectionEnd;
                      pendingMentionCaretRef.current = start;
                      onDraftChange(`${draft.slice(0, start)}${draft.slice(end)}`);
                      setUrlReferences((current) => [...current, { id: crypto.randomUUID(), url: pastedText }]);
                    }
                  }}
                  onClick={(event) => {
                    setComposerCaret(event.currentTarget.selectionStart);
                    const nextMentionRange = findWebuiMentionRange(event.currentTarget.value, event.currentTarget.selectionStart);
                    if (nextMentionRange) {
                      setComposerMenu(undefined);
                      setPermissionMenuOpen(false);
                    }
                    setMentionRange(nextMentionRange);
                  }}
                  onKeyUp={(event) => {
                    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
                    setComposerCaret(event.currentTarget.selectionStart);
                    setMentionRange(findWebuiMentionRange(event.currentTarget.value, event.currentTarget.selectionStart));
                  }}
                  onKeyDown={(event) => {
                    if (mentionRange && mentionSuggestions.length > 0) {
                      if (event.key === "Escape") { event.preventDefault(); setMentionRange(undefined); return; }
                      if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((current) => (current + 1) % mentionSuggestions.length); return; }
                      if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length); return; }
                      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); const choice = mentionSuggestions[mentionIndex]; if (choice) chooseMention(choice); return; }
                    }
                    if (event.key === "Escape" && composerMenu) { event.preventDefault(); setComposerMenu(undefined); return; }
                    if (event.key === "Escape" && permissionMenuOpen) { event.preventDefault(); setPermissionMenuOpen(false); return; }
                    if (event.key === "Escape" && (goalMode || planMode)) {
                      event.preventDefault();
                      if (goalMode) cancelGoalMode();
                      else cancelPlanMode();
                      return;
                    }
                    if (event.key === "Escape" && commandRange) {
                      // Mirrors the desktop Escape handling: drop the "/xxx"
                      // token under the caret so the palette closes. Text
                      // before it survives — the user may have typed a
                      // prefix word — which is what cancels this invocation.
                      event.preventDefault();
                      const next = removeWebuiSlashToken(draft, commandRange);
                      onDraftChange(next);
                      setComposerCaret(next.length);
                      return;
                    }
                    if (event.key === "Escape" && historyBrowse) {
                      // Escape during a history browse restores the draft as
                      // it was before ↑ first recalled. Sits after the slash
                      // palette's own Escape so a recalled "/…" closes the
                      // palette first and exits the browse on the second tap.
                      event.preventDefault();
                      const stashed = historyBrowse.draft;
                      setHistoryBrowse(undefined);
                      applyHistoryDraft(stashed);
                      return;
                    }
                    // History recall claims ↑/↓ only when nothing else has:
                    // the mention menu (above) and the slash popover (below,
                    // behind the `commandSuggestions.length === 0` guard) own
                    // the arrows while they are open.
                    if (
                      commandSuggestions.length === 0 &&
                      (event.key === "ArrowUp" || event.key === "ArrowDown")
                    ) {
                      const caret = event.currentTarget.selectionStart ?? 0;
                      if (event.key === "ArrowUp") {
                        const next = historyBrowse
                          ? stepWebuiHistoryBrowse(historyBrowse, "prev", inputHistory)
                          : shouldRecallWebuiHistory(draft, caret)
                            ? startWebuiHistoryBrowse(inputHistory, draft)
                            : undefined;
                        if (next) {
                          event.preventDefault();
                          setHistoryBrowse(next);
                          applyHistoryDraft(inputHistory[next.index] ?? "");
                          return;
                        }
                      } else if (historyBrowse) {
                        const next = stepWebuiHistoryBrowse(historyBrowse, "next", inputHistory);
                        event.preventDefault();
                        setHistoryBrowse(next);
                        // Stepping past the newest exits and restores the
                        // stashed pre-browse draft.
                        applyHistoryDraft(next ? inputHistory[next.index] ?? "" : historyBrowse.draft);
                        return;
                      }
                    }
                    // Enter is claimed above by an open mention menu, and below by
                    // an open slash popover. This MUST sit before the
                    // `commandSuggestions.length === 0` guard: that guard
                    // returns for EVERY key, so a branch placed after it never
                    // runs in the common case of an ordinary message — which is
                    // exactly how a first attempt at this silently did nothing.
                    if (event.key === "Enter" && commandSuggestions.length === 0) {
                      const action = resolveWebuiComposerEnterAction({
                        shiftKey: event.shiftKey,
                        altKey: event.altKey,
                        ctrlKey: event.ctrlKey,
                        metaKey: event.metaKey,
                        isComposing: event.nativeEvent.isComposing,
                        submitBlocked,
                      });
                      if (action === "submit") {
                        event.preventDefault();
                        // `requestSubmit` raises the form's submit event rather
                        // than bypassing it, so the keyboard lands on the same
                        // `onSubmit` the send button reaches.
                        event.currentTarget.form?.requestSubmit();
                        return;
                      }
                    }
                    if (commandSuggestions.length === 0) return;
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setCommandIndex(
                        (current) =>
                          (current + 1) % commandSuggestions.length,
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setCommandIndex(
                        (current) =>
                          (current - 1 + commandSuggestions.length) %
                          commandSuggestions.length,
                      );
                    } else if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const command = commandSuggestions[commandIndex];
                      if (command) chooseCommand(command.name);
                    }
                  }}
                  disabled={!canCompose && !canQueue}
                  placeholder={goalMode ? "描述你想完成的目标" : planMode ? "描述需要规划的任务..." : "输入消息…（输入 / 唤起命令）"}
                  className="webui-textarea webui-composer-input text-text_default_primary"
                  data-webui-composer-input="true"
                />
                {mentionRange && mentionSuggestions.length > 0 ? (
                  <div className="webui-composer-mention-menu" role="listbox" aria-label="提及列表" data-webui-mention-menu="true">
                    {mentionSuggestions.map((choice, index) => (
                      <Fragment key={`${choice.section}:${choice.kind}:${choice.kind === "agent" ? choice.session.sessionId : choice.kind === "file" ? choice.path : choice.kind === "plugin" ? choice.name : choice.label}`}>
                        {(index === 0 || mentionSuggestions[index - 1]?.section !== choice.section) ? <div className="webui-composer-mention-section" role="presentation">{choice.section}</div> : null}
                        <button type="button" role="option" aria-selected={index === mentionIndex} className="webui-composer-mention-option" onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setMentionIndex(index)} onClick={() => chooseMention(choice)}>
                          <span>{choice.label}</span>
                          {choice.kind === "plugin" && choice.detail ? <small>{choice.detail}</small> : null}
                        </button>
                      </Fragment>
                    ))}
                  </div>
                ) : null}
                {attachments.length > 0 ? (
                  <div className="webui-composer-attachments" data-webui-composer-attachments="true">
                    {attachments.map((attachment) => <div key={attachment.id} className={`webui-composer-attachment${attachment.kind === "image" ? " is-image" : ""}`}>
                      {attachment.kind === "image" ? <img src={attachment.dataUrl} alt={attachment.fileName} /> : <span className="webui-composer-attachment-type">{attachment.fileName.split(".").pop()?.toUpperCase() ?? "FILE"}</span>}
                      <span className="webui-composer-attachment-name" title={attachment.fileName}>{attachment.fileName}</span>
                      <button type="button" aria-label={`移除 ${attachment.fileName}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button>
                    </div>)}
                    {urlReferences.map((reference) => <div key={reference.id} className="webui-composer-url-reference">
                      <span aria-hidden="true">↗</span>
                      <input aria-label="URL 引用" value={reference.url} onChange={(event) => setUrlReferences((current) => current.map((item) => item.id === reference.id ? { ...item, url: event.target.value } : item))} />
                      <button type="button" aria-label="移除 URL 引用" onClick={() => setUrlReferences((current) => current.filter((item) => item.id !== reference.id))}>×</button>
                    </div>)}
                    {attachmentBusy ? <span className="webui-composer-attachment-loading" role="status">正在读取文件…</span> : null}
                  </div>
                ) : urlReferences.length > 0 ? <div className="webui-composer-attachments" data-webui-composer-attachments="true">{urlReferences.map((reference) => <div key={reference.id} className="webui-composer-url-reference"><span aria-hidden="true">↗</span><input aria-label="URL 引用" value={reference.url} onChange={(event) => setUrlReferences((current) => current.map((item) => item.id === reference.id ? { ...item, url: event.target.value } : item))} /><button type="button" aria-label="移除 URL 引用" onClick={() => setUrlReferences((current) => current.filter((item) => item.id !== reference.id))}>×</button></div>)}</div> : null}
                {commandSuggestions.length > 0 ? (
                  <div
                    role="listbox"
                    aria-label="命令"
                    data-webui-command-menu="true"
                    data-webui-command-menu-placement={slashPanelBelow ? "below" : "above"}
                    className="webui-command-menu"
                  >
                    {commandSuggestions.map((command, index) => {
                      const Icon = command.icon;
                      const inert = !command.supported;
                      const isFirstSkill =
                        command.paletteSection === "skills" &&
                        (index === 0 ||
                          commandSuggestions[index - 1]?.paletteSection !==
                            "skills");
                      return (
                        <Fragment key={command.name}>
                          {isFirstSkill ? (
                            <div
                              role="separator"
                              data-webui-command-section="skills"
                              className="webui-command-section-header"
                            >
                              技能
                            </div>
                          ) : null}
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === commandIndex}
                            aria-disabled={inert || undefined}
                            disabled={inert}
                            data-webui-command-option-inert={
                              inert ? "true" : undefined
                            }
                            className="webui-command-option"
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => {
                              if (inert) return;
                              setCommandIndex(index);
                            }}
                            onClick={() => {
                              if (inert) return;
                              chooseCommand(command.name);
                            }}
                          >
                            <Icon className="webui-command-option-icon text-icon_default_secondary" />
                            <span className="webui-command-option-label">
                              {command.label}
                            </span>
                            <span className="webui-command-option-description text-text_default_tertiary">
                              {command.description}
                            </span>
                          </button>
                        </Fragment>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <div
                className="flex w-full items-center gap-3 px-3 pt-1"
                data-webui-composer-toolbar="true"
              >
                <div className="webui-composer-add-wrap" ref={composerAddWrapRef}>
                <button
                  type="button"
                  aria-label="添加附件或技能"
                  aria-expanded={Boolean(composerMenu)}
                  aria-haspopup="menu"
                  data-testid="composer-add-menu"
                  className="webui-icon-button text-icon_default_tertiary"
                  onClick={() => {
                    setPermissionMenuOpen(false);
                    setMentionRange(undefined);
                    setComposerMenu((current) => current ? undefined : "root");
                  }}
                >
                  <WebuiIconAttach />
                </button>
        {/* The panel lives inside the trigger's wrap rather than at the end of
         * the section. Anchoring it to the `+` button means it always clears
         * that button — the old `bottom: 56px` was measured from the composer
         * region, so the panel grew over the `+` and the permission pill as
         * soon as the workspace bar changed the region's height. The wrap is
         * also the surface's container for outside-close, which is why a click
         * inside the composer could not dismiss it. */}
        {composerMenu ? (
          <div
            className="webui-composer-menu-stack"
            data-webui-composer-menu-stack="true"
            data-webui-open-submenu={composerMenu === "root" ? undefined : composerMenu}
            onMouseLeave={() => { if (composerMenu !== "root") setComposerMenu("root"); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setComposerMenu(undefined);
              } else if (event.key === "ArrowRight" && event.target instanceof Element && event.target.closest<HTMLElement>("[data-webui-composer-submenu-trigger]")) {
                event.preventDefault();
                const submenu = event.target.closest<HTMLElement>("[data-webui-composer-submenu-trigger]")?.dataset.webuiComposerSubmenuTrigger;
                const stack = event.currentTarget;
                if (submenu) window.requestAnimationFrame(() => stack.querySelector<HTMLElement>(`[data-webui-composer-submenu="${submenu}"] [role="menuitem"]`)?.focus());
              } else if (event.key === "ArrowLeft" && event.target instanceof Element && event.target.closest("[data-webui-composer-submenu]")) {
                event.preventDefault();
                const submenu = event.target.closest<HTMLElement>("[data-webui-composer-submenu]")?.dataset.webuiComposerSubmenu;
                setComposerMenu("root");
                if (submenu) event.currentTarget.querySelector<HTMLElement>(`[data-webui-composer-submenu-trigger="${submenu}"]`)?.focus();
              }
            }}
          >
            <div className="webui-composer-menu" role="menu" aria-label="添加附件或技能" data-webui-composer-menu="root">
              <button type="button" role="menuitem" onMouseEnter={() => { if (composerMenu !== "root") setComposerMenu("root"); }} onFocus={() => { if (composerMenu !== "root") setComposerMenu("root"); }} onClick={() => { setComposerMenu(undefined); fileInputRef.current?.click(); }}><WebuiIconAttach className="webui-composer-menu-icon" />添加文件或图片</button>
              <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={composerMenu === "skills"} data-webui-composer-submenu-trigger="skills" onMouseEnter={() => setComposerMenu("skills")} onFocus={() => setComposerMenu("skills")} onClick={() => setComposerMenu("skills")}><WebuiIconSkillGeneric className="webui-composer-menu-icon" />技能 <span aria-hidden="true">›</span></button>
              <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={composerMenu === "plugins"} data-webui-composer-submenu-trigger="plugins" onMouseEnter={() => setComposerMenu("plugins")} onFocus={() => setComposerMenu("plugins")} onClick={() => setComposerMenu("plugins")}><WebuiIconPlugins className="webui-composer-menu-icon" />插件 <span aria-hidden="true">›</span></button>
              <div role="separator" />
              <button type="button" role="menuitem" onMouseEnter={() => { if (composerMenu !== "root") setComposerMenu("root"); }} onFocus={() => { if (composerMenu !== "root") setComposerMenu("root"); }} onClick={() => { setComposerMenu(undefined); activateGoalMode(); }}><WebuiIconCommandGoal className="webui-composer-menu-icon" />目标</button>
              <button type="button" role="menuitem" onMouseEnter={() => { if (composerMenu !== "root") setComposerMenu("root"); }} onFocus={() => { if (composerMenu !== "root") setComposerMenu("root"); }} onClick={() => { setComposerMenu(undefined); chooseCommand("plan"); }}><WebuiIconCommandPlan className="webui-composer-menu-icon" />计划</button>
            </div>
            {composerMenu === "skills" ? (
              <div className="webui-composer-menu" role="menu" aria-label="技能" data-webui-composer-menu="skills" data-webui-composer-submenu="skills">
                {skillsMenuLoading ? <div className="webui-composer-menu-empty">正在加载技能…</div> : skillsMenuError ? <div className="webui-composer-menu-empty" role="alert">{skillsMenuError}</div> : slashSkills.length ? slashSkills.map((skill) => <button key={skill.name} type="button" role="menuitem" onClick={() => { setComposerMenu(undefined); insertAtCaret(`/${skill.name}`); textareaRef.current?.focus(); }}>{skill.displayName ?? skill.name}</button>) : <div className="webui-composer-menu-empty">没有已安装的技能</div>}
                <div role="separator" />
                <button type="button" role="menuitem" onClick={() => { setComposerMenu(undefined); onOpenPluginManagement?.("skills"); }}>管理技能</button>
                <button type="button" role="menuitem" onClick={() => { setComposerMenu(undefined); onOpenPluginManagement?.("skills"); }}>添加技能</button>
              </div>
            ) : composerMenu === "plugins" ? (
              <div className="webui-composer-menu" role="menu" aria-label="插件" data-webui-composer-menu="plugins" data-webui-composer-submenu="plugins">
                {pluginsLoading ? <div className="webui-composer-menu-empty">正在加载插件…</div> : pluginsError ? <div className="webui-composer-menu-empty" role="alert">{pluginsError}</div> : installedPlugins.length ? installedPlugins.map((plugin) => <button key={plugin.name} type="button" role="menuitem" title={plugin.description} onClick={() => { setComposerMenu(undefined); insertAtCaret(`@${plugin.name}`); textareaRef.current?.focus(); }}>{plugin.displayName}</button>) : <div className="webui-composer-menu-empty">{pluginManagement ? "没有已安装的插件" : "插件目录暂不可用"}</div>}
                <div role="separator" />
                <button type="button" role="menuitem" onClick={() => { setComposerMenu(undefined); onOpenPluginManagement?.("plugins"); }}>添加插件</button>
              </div>
            ) : null}
          </div>
        ) : null}
                </div>
                <div className="webui-composer-permission-wrap" ref={permissionWrapRef}>
                  <button
                    type="button"
                    className={`webui-composer-permission-button${permissionMode === "bypassPermissions" ? " webui-composer-permission-button--warning" : ""}`}
                    aria-label={permissionMode ? `授权模式：${PERMISSION_MODE_OPTION[permissionMode].label}` : "授权模式"}
                    aria-haspopup="menu"
                    aria-expanded={permissionMenuOpen}
                    disabled={permissionUnavailable || permissionBusy || !permissionMode}
                    title={permissionUnavailable ? "授权模式当前不可用" : undefined}
                    data-testid="composer-permission-mode"
                    onClick={() => {
                      setComposerMenu(undefined);
                      setMentionRange(undefined);
                      setPermissionMenuOpen((open) => !open);
                    }}
                  >
                    {permissionMode ? <PermissionModeIcon mode={permissionMode} /> : <WebuiIconPermissionRequest className="webui-composer-permission-icon" />}
                    <span>{permissionMode ? PERMISSION_MODE_OPTION[permissionMode].label : permissionUnavailable ? "授权不可用" : "读取授权模式…"}</span>
                    <WebuiIconChevronDown className="webui-composer-permission-chevron" />
                  </button>
                  {permissionMenuOpen ? <div className="webui-composer-permission-menu" role="menu" aria-label={PERMISSION_MODE_QUESTION} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setPermissionMenuOpen(false); } }}>
                    <div className="webui-composer-permission-header">
                      <span className="webui-composer-permission-question">{PERMISSION_MODE_QUESTION}</span>
                      <a
                        className="webui-composer-permission-learn-more"
                        href={PERMISSION_MODE_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        {PERMISSION_MODE_LEARN_MORE}
                      </a>
                    </div>
                    {PERMISSION_MODE_ORDER.map((mode) => {
                      const option = PERMISSION_MODE_OPTION[mode];
                      const { Icon } = option;
                      const active = permissionMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className="webui-composer-permission-option"
                          disabled={permissionBusy}
                          onClick={() => void changePermissionMode(mode)}
                        >
                          <Icon className="webui-composer-permission-icon" />
                          <span className="webui-composer-permission-copy">
                            <span className="webui-composer-permission-label">{option.label}</span>
                            <span className="webui-composer-permission-description">{option.description}</span>
                          </span>
                          {active ? <WebuiIconCheck className="webui-composer-permission-check" /> : null}
                        </button>
                      );
                    })}
                  </div> : null}
                </div>
                {goalEnabled && createGoal && goalMode ? (
                  <button
                    type="button"
                    className={`webui-goal-mode-button${goalMode ? " is-active" : ""}`}
                    aria-pressed={goalMode}
                    aria-label="取消目标模式"
                    data-testid="composer-goal-mode"
                    disabled={goalSubmitting || Boolean(questionnaire || permissions.length > 0)}
                    onClick={cancelGoalMode}
                  >
                    <WebuiIconCommandGoal />
                    <span>目标</span>
                  </button>
                ) : null}
                {planMode ? (
                  <button
                    type="button"
                    className="webui-goal-mode-button is-active"
                    aria-pressed="true"
                    aria-label="退出计划模式"
                    data-testid="composer-plan-mode"
                    disabled={Boolean(questionnaire || permissions.length > 0)}
                    onClick={cancelPlanMode}
                  >
                    <WebuiIconCommandPlan />
                    <span>计划</span>
                  </button>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <ContextUsageIndicator usage={contextUsage} usageQuota={usageQuota} />
                  <WebuiModelPicker
                    models={enabledModels}
                    selected={selectedModel}
                    onSelect={(model, draft) =>
                      void handleSelectModel(model, draft)
                    }
                    onSettingChange={(model, draft) =>
                      void handleSelectModel(model, draft)
                    }
                  />
                  {sending ? (
                    <button
                      type="button"
                      aria-label="停止"
                      data-webui-composer-stop="true"
                      className="webui-send-button webui-send-button--stop"
                      onClick={() => void handleStop()}
                    >
                      <span className="webui-send-stop-square" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={submitBlocked}
                      aria-label="发送"
                      data-webui-composer-submit="true"
                      className="webui-send-button"
                    >
                      <WebuiIconSend />
                    </button>
                  )}
                </div>
              </div>
            </div>

        {/* The project row lives INSIDE the scrim container rather than beside
         * it. `.message-input-home-container` is the light surface that already
         * wraps the card, so sharing that box is what makes the card and the
         * band one continuous surface. As siblings they left a seam — the
         * card's rounded corners, the container's `pb-2` and a second, slightly
         * different grey all met along one line and read as two stacked boxes. */}
        {!sessionLayout ? (
          <div
            className="webui-workspace-bar"
            data-webui-workspace-toolbar="true"
          >
          <div className="relative" ref={workspacePickerRef}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={workspaceMenuOpen}
              data-webui-workspace-picker="true"
              className="webui-workspace-bar-trigger"
              onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
            >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <WebuiIconFolder />
            </span>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap leading-5">
              {createSessionWorkspaceDir
                ? workspaceProjectName(createSessionWorkspaceDir)
                : "选择文件夹"}
            </span>
            </button>
            {workspaceBrowserOpen ? (
              <div
                role="dialog"
                aria-label="选择项目目录"
                data-webui-workspace-browser-dialog="true"
                className="webui-workspace-menu webui-workspace-menu--desktop"
              >
                <WebuiWorkspaceDirectoryBrowser
                  browseWorkspaceDirs={browseWorkspaceDirs}
                  initialDir={createSessionWorkspaceDir}
                  onSelect={(dir) => {
                    setWorkspaceBrowserOpen(false);
                    onWorkspaceChange(dir);
                  }}
                  onCancel={() => setWorkspaceBrowserOpen(false)}
                />
              </div>
            ) : workspaceMenuOpen ? (
              <div
                role="listbox"
                aria-label="工作目录"
                data-webui-workspace-menu="true"
                className="webui-workspace-menu webui-workspace-menu--desktop"
              >
                {/* Desktop shape: a `最近` group of workspaces the user has
                 * actually been in, a rule, then the two commands. The group
                 * is omitted entirely when there is no history — an empty
                 * `最近` header above a divider reads as a broken panel. */}
                {recentWorkspaceDirs.length > 0 ? (
                  <>
                    <div className="webui-workspace-menu-header" aria-hidden="true">
                      最近
                    </div>
                    {recentWorkspaceDirs.map((dir) => {
                      const active = dir === createSessionWorkspaceDir;
                      return (
                        <button
                          key={dir}
                          type="button"
                          role="option"
                          aria-selected={active}
                          data-webui-workspace-recent={dir}
                          className="webui-workspace-option webui-workspace-option--desktop"
                          title={dir}
                          onClick={() => onWorkspaceChange(dir)}
                        >
                          <WebuiIconFolder className="flex-shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {workspaceProjectName(dir)}
                          </span>
                          {active ? <WebuiIconCheck className="webui-workspace-option-check" /> : null}
                        </button>
                      );
                    })}
                    <div className="webui-workspace-menu-separator" role="separator" />
                  </>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-webui-workspace-action="add-new"
                  className="webui-workspace-option webui-workspace-option--desktop"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    setWorkspaceBrowserOpen(true);
                  }}
                >
                  <WebuiIconFolder className="flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    选择新项目
                  </span>
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected={createSessionWorkspaceDir === undefined}
                  data-webui-workspace-action="no-project"
                  className="webui-workspace-option webui-workspace-option--desktop"
                  onClick={() => onWorkspaceChange(undefined)}
                >
                  <WebuiIconFolder className="flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    不需要项目
                  </span>
                </button>
              </div>
            ) : null}
            </div>
          </div>
        ) : null}
          </div>
        </form>
        ) : null}
        </div>
          {credentialMessage ? (
          <p
            role="alert"
            data-webui-credential-warning="true"
            className="mt-2 text-text_default_secondary text-size_12"
          >
            Model credentials unavailable: {credentialMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}



function ContextUsageIndicator({ usage, usageQuota }: {
  readonly usage?: Record<string, unknown>;
  readonly usageQuota?: WebuiUsageQuotaResult;
}): ReactElement | null {
  const [enabled, setEnabled] = useState(() => typeof window === "undefined" || window.localStorage?.getItem("webui-context-window-usage") !== "false");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const refresh = () => setEnabled(window.localStorage?.getItem("webui-context-window-usage") !== "false");
    window.addEventListener("storage", refresh);
    window.addEventListener("webui-context-window-usage-change", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("webui-context-window-usage-change", refresh);
    };
  }, []);
  if (!enabled || !usage) return null;
  const used = readUsageNumber(usage, "usedTokens", "used_tokens");
  const limit = readUsageNumber(usage, "contextWindowTokens", "context_window_tokens");
  if (used === undefined || used < 0 || limit === undefined || limit <= 0) return null;
  const percent = Math.min(100, Math.max(0, Math.round(used / limit * 100)));
  const circumference = 2 * Math.PI * 7;
  const label = `${percent}% · ${formatContextTokens(used)} / ${formatContextTokens(limit)} tokens`;
  const componentNames: Readonly<Record<string, string>> = {
    MESSAGES: "消息",
    TOOLS: "工具",
    SKILLS: "技能",
    SYSTEM_PROMPT: "系统提示词",
    OTHER: "其他",
    MEMORY: "记忆",
  };
  const componentColors = [1, 0.82, 0.68, 0.54, 0.4, 0.26];
  const rawComponents = Array.isArray(usage.components) ? usage.components : [];
  const components = rawComponents.flatMap((component) => {
    if (!component || typeof component !== "object" || Array.isArray(component)) return [];
    const item = component as Record<string, unknown>;
    const kind = typeof item.kind === "string" ? item.kind : "OTHER";
    const tokens = typeof item.tokens === "number" && Number.isFinite(item.tokens) ? Math.max(0, item.tokens) : 0;
    return [{ kind, label: componentNames[kind] ?? componentNames.OTHER, tokens }];
  }).sort((left, right) => right.tokens - left.tokens);
  const componentsTotal = components.reduce((total, component) => total + component.tokens, 0);
  const quotaResult = usageQuota?.signedIn ? usageQuota : undefined;
  const quota = quotaResult?.quota;
  const planLabel = quotaResult?.tokenPlanTier ?? (quotaResult?.hasTokenPlan ? "Token Plan" : "未订阅 Token Plan");
  const quotaRows = quota ? [
    { label: "5 小时限额", window: quota.fiveHour },
    { label: "周限额", window: quota.weekly },
    ...(quota.video ? [{ label: "视频限额", window: quota.video }] : []),
  ] : [];
  return (
    <div
      className="webui-context-usage-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className="webui-context-usage-trigger"
        aria-label={`上下文窗口使用 ${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`上下文窗口 ${label}`}
        data-testid="composer-context-usage"
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <circle className="webui-context-usage-track" cx="9" cy="9" r="7" />
          <circle
            className="webui-context-usage-value"
            cx="9"
            cy="9"
            r="7"
            style={{
              strokeDasharray: circumference,
              strokeDashoffset: circumference * (1 - percent / 100),
            }}
          />
        </svg>
      </button>
      <div
        className={`webui-context-usage-popover${open ? " is-open" : ""}`}
        role="dialog"
        aria-label="上下文窗口使用情况"
        aria-hidden={!open}
      >
          <div className="webui-context-usage-heading">
            <span>上下文窗口</span><span>{percent}%</span>
          </div>
          <div
            className="webui-context-usage-bar"
            role="progressbar"
            aria-label="上下文窗口使用量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            {componentsTotal > 0 ? components.map((component, index) => (
              <span
                key={component.kind}
                className="webui-context-usage-bar-segment"
                style={{ width: `${component.tokens / componentsTotal * 100}%`, opacity: componentColors[index % componentColors.length] }}
              />
            )) : <span style={{ width: `${percent}%` }} />}
          </div>
          <div className="webui-context-usage-tokens">{formatContextTokens(used)} / {formatContextTokens(limit)} tokens</div>
          {components.length > 0 ? (
            <div className="webui-context-usage-components" aria-label="上下文构成">
              {components.map((component, index) => (
                <div className="webui-context-usage-component" key={component.kind}>
                  <span className="webui-context-usage-component-label">
                    <span className="webui-context-usage-swatch" style={{ opacity: componentColors[index % componentColors.length] }} />
                    {component.label}
                  </span>
                  <span>{componentsTotal > 0 ? `${((component.tokens / componentsTotal) * 100).toFixed(1)}%` : "0.0%"}</span>
                </div>
              ))}
            </div>
          ) : null}
          {quotaResult ? (
            <>
              <div className="webui-context-usage-divider" />
              <div className="webui-context-usage-plan">套餐用量 · {planLabel}</div>
              {quotaRows.length > 0 ? quotaRows.map(({ label: quotaLabel, window }) => {
                const usedPercent = "usedPercent" in window ? window.usedPercent : undefined;
                const totalPercent = "totalPercent" in window ? window.totalPercent : undefined;
                const videoUsed = "usedCount" in window ? window.usedCount : undefined;
                const videoTotal = "totalCount" in window ? window.totalCount : undefined;
                const progress = usedPercent ?? (videoUsed !== undefined && videoTotal ? videoUsed / videoTotal * 100 : undefined);
                const value = window.unlimited
                  ? "无限制"
                  : usedPercent !== undefined
                    ? `${usedPercent}% / ${totalPercent ?? 100}%`
                    : videoUsed !== undefined && videoTotal !== undefined
                      ? `${videoUsed} / ${videoTotal}`
                      : "—";
                const reset = formatUsageResetLabel(window.resetAtMs);
                return (
                  <div className="webui-context-usage-quota" key={quotaLabel}>
                    <div className="webui-context-usage-heading"><span>{quotaLabel}</span><span>{value}</span></div>
                    <div className="webui-context-usage-quota-bar"><span style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }} /></div>
                    {reset ? <div className="webui-context-usage-reset">{reset}</div> : null}
                  </div>
                );
              }) : <div className="webui-context-usage-tokens">当前套餐没有可显示的限额</div>}
            </>
          ) : null}
      </div>
    </div>
  );
}

function formatContextTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}
