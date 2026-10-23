// SessionComposer — the message composer: slash palette, model picker,
// permission/questionnaire panels, goal banner, and submit
// pipeline.
//
// The shell imports `WebuiComposer` from this business module directly; there
// is no central component re-export layer.
//
// The component reads the stream/sending slices through the application
// bindings (`useWebuiSessionState` / `useWebuiSessionCommands`), which subscribe
// to the one application store and submit purpose-named commands and turn
// intents; the component holds no store writer and no sink factory.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import {
  WebuiComposerEditorStaging,
  type WebuiComposerMentionChoice,
} from "./ComposerEditorStaging.js";
import { WebuiComposerMenus } from "./ComposerMenus.js";
import {
  WebuiComposerModePills,
  WebuiComposerSubmitButton,
} from "./ComposerSubmissionControls.js";
import { WebuiComposerPermissionControl } from "./ComposerPermissionControl.js";
import { WebuiComposerProjectRow } from "./ComposerProjectRow.js";
import type {
  WebuiComposerPluginCatalogue,
  WebuiComposerPluginSummary,
} from "../../../features/plugins/application/composer-catalogue.public.js";
import { readContextUsageFromPage } from "../contracts/context-usage.js";
import { readWebuiComposerSubmitGate } from "../projection/submission-gate.js";
import {
  type WebuiComposerSeed,
} from "../projection/seed-application.js";
import {
  breakdownSegmentPercent,
  breakdownShareLabel,
  breakdownSwatchStyle,
  contextBreakdownRows,
  drawableBreakdownRows,
} from "../projection/context-breakdown.js";
import { isTokenPlanModel } from "../../../features/models/projection/token-plan-model.public.js";
import type {
  WebuiComposerUrlReference,
} from "../projection/composer-interactions.js";
import {
  useWebuiSessionCommands,
  useWebuiSessionGoal,
  useWebuiSessionPermissions,
  useWebuiSessionQuestionnaire,
  useWebuiSessionState,
} from "../../../bindings/use-session-state.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { ContextUsageIndicator } from "./ContextUsageIndicator.js";
import {
  useWebuiModelsWorkflows,
  useWebuiModelsWorkflowsState,
} from "../../../bindings/use-query-state.js";
import {
  useWebuiSettingsWorkflows,
  useWebuiSettingsWorkflowsState,
} from "../../../bindings/use-query-state.js";
import {
  useWebuiWorkspaceFiles,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";
import { type WebuiPermissionMode } from "../../../features/settings/contracts/settings-port.js";
import {
  useWebuiGoalOwner,
  useWebuiGoalReaction,
} from "../../../features/goal/bindings/goal-owner.public.js";
import { useWebuiInteractionOwner } from "../../../features/interactions/bindings/interaction-owner.public.js";
import { useComposerController } from "../bindings/use-composer-controller.js";
import { useComposerLayout } from "../bindings/use-composer-layout.js";
import { useComposerInput } from "../bindings/use-composer-input.js";
import { useComposerAttachments } from "../bindings/use-composer-attachments.js";
import {
  useWebuiApplicationOptional,
  useWebuiSessionStoreSnapshot,
} from "../../../bindings/application-context.js";
import { selectWebuiCatalogFlatPage } from "../../../features/sessions/application/session-catalog.public.js";
import { useWebuiAccountWorkflowsState } from "../../../features/account/bindings/use-account-workflows.public.js";

import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalSessionRequest,
} from "../../../../shared/contracts/goal.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";
import type { WebuiModelEntry } from "../../../../shared/contracts/models.js";
import type { WebuiQueueItem } from "../../../../shared/contracts/queue.js";
import type {
  WebuiWorkspaceFile,
} from "../../../../shared/contracts/workspace.js";
import type { WebuiUsageQuotaResult } from "../../../../shared/contracts/usage-quota.js";
import { formatUsageResetLabel } from "../../../features/account/projection/usage.public.js";
import { WebuiGoalBanner } from "../../../features/goal/ui/GoalBanner.public.js";
import { WebuiInteractionPanel } from "../../../features/interactions/ui/InteractionPanel.public.js";
import { WebuiQueuePanel } from "./QueuePanel.js";
import {
  WebuiModelPicker,
  type WebuiModelPickerDraft,
} from "../../../features/models/ui/ModelPicker.public.js";
import {
  chipLevelLabel,
  resolveEffortOptions,
} from "../../../features/models/projection/thinking-control.public.js";
import {
  WebuiIconAttach,
} from "../../../shell/icons.js";
import { OutputError } from "../../../features/transcript/ui/OutputError.public.js";
import { isTurnLive } from "../../turn/contracts/stream-state.js";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import {
} from "../../../features/sessions/projection/action-requests.public.js";
import { buildWebuiModelSelectionRequest } from "../../../features/models/contracts/model-selection.js";
import {
  findWebuiMentionRange,
  findWebuiSlashRange,
  insertWebuiMention,
  removeWebuiSlashToken,
  replaceWebuiSlashToken,
  webuiTextAttachmentDataUrl,
} from "../projection/composer-interactions.js";
import {
  slashSkillSummaryToEntry,
  WEBUI_BUILTIN_COMMANDS,
  type SlashCommandEntry,
  type WebuiSlashSkillSummary,
} from "./slash-palette.js";
import {
  isWebuiRunnableCommand,
  rankWebuiSlashPalette,
  sectionWebuiSlashPalette,
} from "../contracts/slash-command.js";
import { planWebuiRetryResend } from "../application/turn-retry.js";

const WEBUI_SLASH_FALLBACK_SECTIONED: SlashCommandEntry[] = await (async () => {
  const { resolveWebuiSlashSkills } = await import("./slash-palette.js");
  const resolved = await resolveWebuiSlashSkills();
  return sectionWebuiSlashPalette(WEBUI_BUILTIN_COMMANDS, resolved.skills);
})();

// The viewport stays pinned through the short hand-off window where
// the live turn is replaced by the refreshed historical transcript.




/** Default for `recentWorkspaceDirs`. A module constant, not an inline `[]`, so
 *  the prop keeps one identity across renders when the parent does not supply
 *  it — an inline default would be a fresh array every render. */
const EMPTY_WORKSPACE_DIRS: readonly string[] = [];

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

export function WebuiComposer({
  sessionId,
  sessionLayout = false,
  usageQuota,
  agentName,
  createSessionWorkspaceDir,
  onWorkspaceChange,
  workspaceMenuOpen,
  setWorkspaceMenuOpen,
  recentWorkspaceDirs = EMPTY_WORKSPACE_DIRS,
  draft,
  onDraftChange,
  inputHistory = [],
  onNeedsSession,
  onSessionCreated,
  teamModeOff,
  workspaceDir,
  onSelectSession,
  onOpenPluginManagement,
  seedAttachment,
}: {
  readonly sessionId?: string;
  readonly sessionLayout?: boolean;
  readonly usageQuota?: WebuiUsageQuotaResult;
  readonly agentName: string;
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

  /** Authoritative active-turn probe; resolves the `recheck` case and the
   * missed-event gap that a reconnect or a slow subscribe can open. */

  /** The draft lives on the shell so it survives silent first-session creation. */
  readonly draft: string;
  readonly onDraftChange: (next: string) => void;
  /**
   * A file dropped into the composer from outside it — 记忆摘要's 「在会话中创建」
   * hands the memory file over this way, because the composer is the only
   * surface that can render an attachment chip and the only one that can put it
   * on the wire.
   *
   * One-shot by `token`: the shell keeps the seed around across the view switch
   * that opens the composer, so an effect keyed on anything else would re-attach
   * the same 74KB file on every re-render of this component.
   */
  readonly seedAttachment?: WebuiComposerSeed;
  /**
   * Submitted-input history for ↑ recall. Keyed by session on the shell; the composer
   * only walks it with the pure helpers from `composer-history.ts`.
   */
  readonly inputHistory?: readonly string[];
  /** Records one committed submission into the shell's history store. */
  readonly onInputSubmitted?: (text: string) => void;
  readonly onNeedsSession?: (draft: string) => void;
  /**
   * The created session, whether the navigation claim that started the creation is
   * still current, and the Agent Team choice the request was submitted with. The
   * third value is the captured one, not the default reached at completion, so a
   * default changed while the creation was in flight does not rewrite it.
   */
  readonly onSessionCreated?: (sessionId: string, selected: boolean, teamModeOff: boolean) => void;
  readonly teamModeOff: boolean;
  /**
   * What is installed, and what the agent can run, answered by the plugins
   * business. The composer used to hold `pluginManagement` and `listSkills`
   * itself and dispatch a raw wire verb from an effect; it now asks a question
   * and receives rows it already recognises.
   */
  readonly workspaceDir?: string;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly onOpenPluginManagement?: (area: "plugins" | "skills") => void;
}): ReactElement {

  const { dom } = useWebuiBrowserCapabilities();
  const { stream, sending, transcript } = useWebuiSessionState(sessionId);
  const turnCommands = useWebuiSessionCommands(sessionId);
  // The per-session effects registry the shell provides. The composer registers
  // this session's event handlers here so the application event coordinator —
  // the sole consumer of the process-event channel — runs them for events
  // addressed to this session; it holds no channel and registers nothing when no
  // provider is mounted (SSR, tests).
  // The interaction slices live on the one application store, read here through
  // selectors and kept nowhere else. The commands write through the store's
  // interaction writer; the composer holds no store writer and no local copy
  // of permissions, questionnaire or goal.
  const permissions = useWebuiSessionPermissions(sessionId);
  const questionnaire = useWebuiSessionQuestionnaire(sessionId);
  const goal = useWebuiSessionGoal(sessionId);
  // The interaction flows
  // (`client/features/interactions/application/interaction-coordinator.ts`).
  // The policy — what counts as an accepted reply, what state transition follows
  // it, which permissions a re-read keeps — lives there. This component supplies
  // the wiring and keeps the one error slot that every other flow in this file
  // also writes, which is why the flows return an outcome instead of an error.
  // The two fence cells come from the application, not from this component:
  // the composer owns neither the goal's fence nor interactions' late-read
  // protection. Bumped by every write, so a steering re-read that lands after a
  // newer update can tell it is stale and stand down; EVERY goal writer must go
  // through `applyGoal`, because a direct store write would let an in-flight
  // read resurrect the state it was meant to replace. The policy is each
  // coordinator's; the cell has to outlive a render, which is why the application
  // creates it — a counter inside a per-render coordinator would
  // reset and silently disable the guard it protects. Both fences are the
  // owners' now, so this component reads neither.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // The interaction owner is the application's, keyed by session: this
  // component reads the one for the session it is showing instead of
  // constructing one, so an event re-reads and a reply commits whether or not
  // this view is mounted, and each session has its own fence.
  const interactionCoordinator = useWebuiInteractionOwner(sessionId);
  // The goal owner is the application's, keyed by session: this component
  // reads the one for the session it is showing instead of constructing one, so a
  // goal event commits whether or not this view is mounted and each session has
  // its own fence.
  const goalCoordinator = useWebuiGoalOwner(sessionId);
  const applyGoal = goalCoordinator.applyGoal;
  const [goalEnabled, setGoalEnabled] = useState(true);
  // The composer's owner, read once for everything this component keeps in it:
  // the input modes, the retry record, the queue and the may-write cell for
  // the staging. One store, one subscription.
  const { controller: composerController, snapshot: controllerSnapshot, isAttachedTo } = useComposerController(sessionId);
  if (!composerController || !controllerSnapshot) {
    throw new Error("WebuiComposer requires the application-owned composer controller");
  }
  const observedCreationTicketRef = useRef<number>();
  useEffect(() => {
    const created = controllerSnapshot.createdSession;
    if (!created || observedCreationTicketRef.current === created.ticketId) return;
    observedCreationTicketRef.current = created.ticketId;
    if (isAttachedTo(sessionId)) onSessionCreated?.(created.sessionId, created.selected, teamModeOff);
  }, [controllerSnapshot.createdSession, isAttachedTo, onSessionCreated, sessionId, teamModeOff]);
  // Sessions' published create command, read from its owner rather than relayed
  // through a prop. The composer's own command workflows and the substrate's
  // capability slice are the same: both are published by the assembly rather
  // than relayed through props.
  const application = useWebuiApplicationOptional();
  // Published by the plugins/composer owner; a read model the composer consumes
  // rather than a prop the shell relays.
  const pluginCatalogue = application?.composerPluginCatalogue;
  // Sessions' published read model: the one catalog the store holds, resolved to
  // the flat page. The child sessions the mention menu lists
  // are entries of it, so the component reads them rather than receiving a page.
  const sessionCatalog = useWebuiSessionStoreSnapshot().catalog;
  const sessions = useMemo(
    () => selectWebuiCatalogFlatPage(sessionCatalog).sessions,
    [sessionCatalog],
  );
  // The composer renders a file tree, so it takes the files contract — not
  // the whole workspace, and not a git mutation it has no view for.
  const workspaceFileCommands = useWebuiWorkspaceFiles();
  const workspaceFileTree = useWebuiWorkspaceQueriesState().fileTree;
  const composerSnapshot = controllerSnapshot.composer;
  // The input modes are the composer's own state, kept by its owner.
  const goalMode = composerSnapshot.modes.goal;
  const planMode = composerSnapshot.modes.plan;
  const setGoalMode = composerController.setGoalMode;
  const setPlanMode = composerController.setPlanMode;
  const goalSubmitting = controllerSnapshot.goalSubmitting;
  const [localInteractionError, setLocalInteractionError] = useState<string>();
  const interactionError = controllerSnapshot.interactionError ?? localInteractionError;
  const setInteractionError = useCallback((error: string | undefined) => {
    setLocalInteractionError(error);
    if (error === undefined) composerController.clearError();
  }, [composerController]);
  // The queue mirror is the composer's own state, and its owner is the composer
  // store. It is live state: not persisted, and not per-slot, because unlike
  // the draft it does not survive a session switch.
  const queueState = composerSnapshot.queue;
  const queueItems = queueState.items;
  const queuePaused = queueState.paused;
  // The model catalogue is the models owner's cached read:
  // the composer used to hold a second copy fed by its own 2s poll of the raw
  // `listModels` port method.
  const modelsWorkflows = useWebuiModelsWorkflows();
  // The subscription, not the value: the models owner publishes on every
  // catalogue commit, and this component reads its own session's entry below.
  // The subscription is what makes that read current.
  useWebuiModelsWorkflowsState();
  /**
   * The catalogue of the session on screen.
   *
   * It used to be the owner's SELECTED catalogue, gated on a scope the composer
   * kept of its own — two facts that had to agree, and when they did not, the
   * list came out empty: the chip fell back to the literal "Model" and the
   * trigger went inert until a reload. Asking the owner for THIS session's
   * entry removes the agreement: the entry is keyed by the session, so one
   * session's models can never be rendered as another's, and the last good
   * answer stands in while the next read is in flight.
   */
  const models: readonly WebuiModelEntry[] =
    modelsWorkflows?.readModelsFor(sessionId).value ?? [];
  const modelsScope = controllerSnapshot.inspectionSessionId;
  // The account status is the account owner's answer, not this component's copy
  // of an RPC result. The owner drops a superseded read.
  const accountSnapshot = useWebuiAccountWorkflowsState();
  // Same scope guard the catalogue read uses: an answer the owner holds for
  // another session must not bleed into this one, and on home nothing shows.
  const accountStatus =
    modelsScope === sessionId ? accountSnapshot.account.value : undefined;
  const commandOutput = controllerSnapshot.commandOutput;
  const commandRunning = controllerSnapshot.commandRunning;
  // The staged attachments and URL references are the composer's own state, kept
  // by its owner module and read from the same snapshot as the queue.
  const attachments = composerSnapshot.staging.attachments;
  const urlReferences = composerSnapshot.staging.urlReferences;
  const attachmentBusy = composerSnapshot.staging.busy;
  const setUrlReferences = useCallback(
    (
      next:
        | readonly WebuiComposerUrlReference[]
        | ((current: readonly WebuiComposerUrlReference[]) => readonly WebuiComposerUrlReference[]),
    ) => {
      composerController.setUrlReferences((current) => typeof next === "function" ? next(current) : next);
    },
    [composerController],
  );
  const [composerMenu, setComposerMenu] = useState<"root" | "skills" | "plugins">();
  const [installedPlugins, setInstalledPlugins] = useState<readonly WebuiComposerPluginSummary[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string>();
  const [skillsMenuLoading, setSkillsMenuLoading] = useState(false);
  const [skillsMenuError, setSkillsMenuError] = useState<string>();
  const [workspaceFiles, setWorkspaceFiles] = useState<readonly { readonly path: string; readonly name: string; readonly type?: string }[]>([]);
  // The mention range is the composer's own state; the slash range is derived
  // (`commandRange` below), so only this half is state.
  const mentionRange = composerSnapshot.mentionRange;
  const setMentionRange = composerController.setMentionRange;
  const composerInput = useComposerInput(draft, sessionId);
  const { mentionIndex, setMentionIndex, commandIndex, setCommandIndex, historyBrowse, setHistoryBrowse } = composerInput;
  // The mode is the settings owner's answer, read through its snapshot;
  // only the menu's open/busy/unavailable presentation state is local.
  const settingsWorkflows = useWebuiSettingsWorkflows();
  const settingsSnapshot = useWebuiSettingsWorkflowsState();
  const permissionMode = settingsSnapshot.permissionMode.value;
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionUnavailable, setPermissionUnavailable] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // The slash palette follows the caret, so its position is state rather than a
  // ref: a click or an arrow key that only moves the caret still has to
  // re-derive whether a slash token is under it.
  const composerCaret = composerInput.caret;
  const editingGoalDraftRef = useRef(false);
  const textareaRef = composerInput.textareaRef;
  const composerRegionRef = useRef<HTMLDivElement | null>(null);
  // The composer's input box — the frame the textarea and the staging row sit
  // in. The mention list and the command palette hang off it, because it is
  // the box a reader sees; a caret has no rectangle to measure.
  const composerInputContainerRef = useRef<HTMLDivElement | null>(null);
  // The workspace picker's own container: the 选择文件夹 trigger plus whichever
  // panel it has open (the 最近 list or the directory browser). The picker has
  // to be judged against THIS, not `composerRegionRef` — see the effect below.
  const fieldId = useId();
  // The session's context-window reading, and the two records that own half of
  // it each.
  //
  //   - the LIVE turn's own reading — the snapshot the runtime attaches to a
  //     frame. It is the fresher one while a turn runs, and the only one that
  //     carries the per-category breakdown.
  //   - the HISTORY's reading — the transcript page's context snapshot. It is
  //     what a reloaded session has, and the transcript's own record of it.
  //
  // The readout reads both and writes neither. It used to read the history and
  // WRITE it into the live turn's record, and that copy was the bug: a turn
  // starting again reset the record and took the reading with it; a page read
  // that lost its race with a refresh left nothing to write and nothing to
  // retry it, so the ring stayed blank for the rest of the session's life with
  // no error anywhere; and the write replaced the live snapshot's breakdown
  // with the history's plainer one. Reading the owners has no copy to lose —
  // the ring follows the live turn while one runs, and the page whenever the
  // transcript commits it.
  const liveContextUsage = stream.contextUsage ?? stream.messages.at(-1)?.contextUsage;
  const historyContextUsage = readContextUsageFromPage(transcript.page);
  const contextUsage = liveContextUsage ?? historyContextUsage;

  useEffect(() => {
    let cancelled = false;
    if (!settingsWorkflows) return undefined;
    if (!settingsWorkflows.canReadPermissionMode) {
      setPermissionUnavailable(true);
      return undefined;
    }
    // The owner reports what this request produced, so the surface does not
    // re-read the shared snapshot to find out what it just got — and an
    // unsupported payload is this request's error rather than a field that may
    // have been overwritten by a later read.
    settingsWorkflows
      .loadPermissionMode()
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "ready") {
          setPermissionUnavailable(false);
          return;
        }
        setPermissionUnavailable(true);
        if (outcome.status === "failed") {
          setInteractionError(
            outcome.error instanceof Error ? outcome.error.message : "加载授权模式失败",
          );
          return;
        }
        // Superseded or disposed: this request was refused, so there is nothing
        // to report — the switch keeps whatever the snapshot already holds.
        setPermissionUnavailable(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPermissionUnavailable(true);
        setInteractionError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [settingsWorkflows]);

  useEffect(() => {
    if (composerMenu !== "plugins" && !mentionRange) return;
    if (!pluginCatalogue?.available) {
      setInstalledPlugins([]);
      return;
    }
    let cancelled = false;
    setPluginsLoading(true);
    setPluginsError(undefined);
    // The rows are already the shape this menu renders, so there is no local
    // copy of the runtime's naming rules here any more.
    pluginCatalogue.installedPlugins()
      .then((plugins) => { if (!cancelled) setInstalledPlugins(plugins); })
      .catch((error: unknown) => {
        if (!cancelled) setPluginsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!cancelled) setPluginsLoading(false); });
    return () => { cancelled = true; };
  }, [composerMenu, mentionRange !== undefined, pluginCatalogue]);

  // The skills submenu and the slash palette render the same pool, so they read
  // it through one loader. The request cache is the catalogue's, keyed by agent,
  // rather than a ref in this component: a second reader joins the request the
  // first one started instead of replacing the pool underneath it, and the
  // composer no longer owns that lifetime.
  const [slashSkills, setSlashSkills] = useState<readonly WebuiSlashSkillSummary[]>(
    [],
  );
  const readSlashSkills = useCallback((): Promise<
    readonly WebuiSlashSkillSummary[]
  > => {
    if (!pluginCatalogue) return Promise.reject(new Error("技能目录暂不可用"));
    return pluginCatalogue.runtimeSkills(agentName);
  }, [pluginCatalogue, agentName]);

  useEffect(() => {
    if (composerMenu !== "skills") return;
    if (!pluginCatalogue) {
      setSkillsMenuError("技能目录暂不可用");
      return;
    }
    let cancelled = false;
    setSkillsMenuLoading(true);
    setSkillsMenuError(undefined);
    readSlashSkills()
      .then((skills) => { if (!cancelled) setSlashSkills(skills); })
      .catch((error: unknown) => { if (!cancelled) setSkillsMenuError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setSkillsMenuLoading(false); });
    return () => { cancelled = true; };
  }, [composerMenu, pluginCatalogue, readSlashSkills]);

  useEffect(() => {
    // The directory listing is `workspace`'s capability: the composer asks its
    // owner and reads the answer from the owner's state rather than holding
    // the operation itself.
    if (!mentionRange || !workspaceDir || !workspaceFileCommands?.canListFileTree) {
      setWorkspaceFiles([]);
      return undefined;
    }
    workspaceFileCommands.loadFileTree(workspaceDir);
    return undefined;
  }, [mentionRange !== undefined, workspaceDir, workspaceFileCommands]);

  useEffect(() => {
    if (mentionRange === undefined) {
      setWorkspaceFiles([]);
      return;
    }
    if (workspaceFileTree.error) {
      setInteractionError(workspaceFileTree.error);
      return;
    }
    if (workspaceFileTree.workspaceDir !== workspaceDir) return;
    setWorkspaceFiles(flattenWorkspaceFiles(workspaceFileTree.files).slice(0, 100));
  }, [mentionRange !== undefined, workspaceDir, workspaceFileTree]);

  /**
   * The view's half of a steering re-read: after one lands, the composer's goal
   * mode follows the goal it returned. A subscription rather than a replaceable
   * effect, so a reaction cannot displace the authoritative route, and it is
   * keyed by the session whose goal it describes.
   */
  useWebuiGoalReaction(sessionId, (next) => {
    if (next) setGoalMode(next.status !== "complete");
  });

  const goalEnabledProbe = goalCoordinator.isGoalEnabled;
  useEffect(() => {
    if (!goalEnabledProbe) {
      setGoalEnabled(true);
      return undefined;
    }
    let cancelled = false;
    void goalEnabledProbe()
      .then((result) => {
        if (cancelled) return;
        setGoalEnabled(result.enabled);
        if (!result.enabled) setGoalMode(false);
      })
      .catch(() => { if (!cancelled) setGoalEnabled(false); });
    return () => { cancelled = true; };
  }, [goalEnabledProbe]);

  const handlePermission = async (
    permission: WebuiPendingPermission,
    decision: "allowOnce" | "allowAlways" | "deny",
  ) => {
    setInteractionError(undefined);
    const outcome = await interactionCoordinator.replyPermission(
      permission,
      decision,
    );
    if (!outcome.ok) setInteractionError(outcome.error);
  };

  const handleQuestionnaire = async (
    request: WebuiQuestionnaireRequest,
    answers: readonly WebuiQuestionnaireAnswer[],
  ) => {
    setInteractionError(undefined);
    // The composer knows the session's agent (it is a prop from the session
    // list), so it names the requester itself rather than relying on the owner's
    // fallback reader.
    const outcome = await interactionCoordinator.answerQuestionnaire(
      request,
      answers,
      agentName,
    );
    if (!outcome.ok) setInteractionError(outcome.error);
  };

  const handleDismiss = async (request: WebuiQuestionnaireRequest) => {
    setInteractionError(undefined);
    const outcome = await interactionCoordinator.dismissQuestionnaire(request);
    if (!outcome.ok) setInteractionError(outcome.error);
  };

  const handleStop = async () => {
    if (!sessionId) return;
    setInteractionError(undefined);
    try {
      // The stop capability comes from the application's turn capability
      // slice, inside the owner; this component invokes the command only.
      await turnCommands?.stop();
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleDeleteQueueItem = async (item: WebuiQueueItem) => {
    if (!sessionId) return;
    setInteractionError(undefined);
    await composerController.removeQueued({ sessionId, itemId: item.itemId });
  };

  const handleSelectModel = async (
    model: WebuiModelEntry,
    draft: WebuiModelPickerDraft,
  ) => {
    if (!modelsWorkflows) return;
    setInteractionError(undefined);
    try {
      // The owner checks the runtime's own success flag and re-reads the
      // catalogue, so the marked row follows the write.
      await modelsWorkflows.selectModel(
        buildWebuiModelSelectionRequest(model, draft, sessionId),
      );
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const selectedModel = models.find((model) => model.selected);
  const enabledModels = models.filter((model) => model.enabled !== false);
  // The active model's thinking options, resolved ONCE and read by both the
  // model chip (to name the level) and the brain trigger (to decide whether
  // there is a level to name). Two `resolveEffortOptions` calls would be two
  // chances to disagree about this model's shape, and the disagreement renders
  // as a chip stating a level beside a brain claiming the model has none.
  const thinkingOptions = selectedModel ? resolveEffortOptions(selectedModel) : [];
  // The slash token the caret sits in, found the same way as an `@` mention.
  // Every slash opens the palette, not only one at the start of the draft:
  // `findWebuiSlashRange` anchors on the caret and on `(?:^|\s)`, so `帮我 /pl`
  // ranks commands exactly like `/pl` while `http://x` stays a URL. Reading the
  // un-trimmed draft keeps the panel closed once the user types the trailing
  // space after a command — trimming would re-open it, because "/name "
  // trims to "/name" and matches again.
  const commandRange = findWebuiSlashRange(draft, composerCaret);
  const commandQuery = commandRange?.query ?? "";
  // Pull a fresh skill pool from the harness when the catalogue is wired up.
  // The fallback (fixtures resolved at module init) keeps the popover
  // functional even if the RPC is unavailable or rejects; once the live
  // registry returns, fetched entries replace the fixtures in the sectioning
  // pass.
  const slashSkillsLoadedRef = useRef(false);
  useEffect(() => {
    if (!pluginCatalogue) return;
    if (slashSkillsLoadedRef.current) return;
    let cancelled = false;
    slashSkillsLoadedRef.current = true;
    readSlashSkills()
      .then((skills) => {
        if (cancelled) return;
        setSlashSkills(skills);
      })
      .catch(() => {
        // The popover keeps using the fixtures when the RPC rejects; the
        // submenu reports the failure in its own state. Clearing the flag lets
        // the next effect run retry; within one mount that means an
        // `agentName` change, not every keystroke.
        if (cancelled) return;
        slashSkillsLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [pluginCatalogue, readSlashSkills]);
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
  const mentionSuggestions: readonly WebuiComposerMentionChoice[] = mentionRange
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
  // TipTap suggestion-plugin behaviour: while the slash
  // popover is open, a pointerdown outside the composer region cancels the
  // slash invocation. The Escape handler above already does the same thing
  // for the keyboard. Without this, the popover stays pinned above the
  // composer until the user types a space or deletes the "/" by hand. We keep
  // refs to `draft` and the current range so the listener always sees the
  // latest values without re-attaching on every keystroke.
  const slashPanelOpen = commandRange !== undefined;
  // The `+` menu, the permission popover, the mention list and the command
  // palette are all dropdowns now: the shared skeleton dismisses them on a
  // press outside the region they belong to and on Escape. The mention list and
  // the palette have no trigger of their own — a keystroke in the textarea
  // opens them — so they name the composer's region as the place a press
  // inside is not a dismissal, and the composer still owns their cursors.
  // The workspace picker's outside-close listener moved with the row itself
  // (ComposerProjectRow), which owns that container and its two flags.
  //
  // Which side the palette opens on is NOT decided here. The palette's own
  // height decides it, and its height is only known where it is measured and
  // placed — the placement rule, which is handed the panel's measured size and
  // the viewport and answers with the side that has room for it. A guess made
  // here is a guess about a number this file does not have, and a wrong guess
  // put the palette below the input box with its rows running off the bottom
  // of the screen.
  // Attachment acquisition, the seed decision and the wire projection are one
  // responsibility; the store owns the staged state, this binding owns the flow.
  const { addFiles, removeAttachment, attachmentWire } = useComposerAttachments({
    setStagedAttachments: composerController.setStagedAttachments,
    setAttachmentBusy: composerController.setAttachmentBusy,
    consumeSeed: composerController.consumeSeed,
    attachments,
    seedToken: composerSnapshot.staging.seedToken,
    ...(seedAttachment ? { seedAttachment } : {}),
    setInteractionError,
  });
  const replaceMention = (insertion: string) => {
    if (!mentionRange) return;
    const result = insertWebuiMention(draft, mentionRange, insertion);
    composerInput.setPendingCaret(result.caret);
    onDraftChange(result.value);
    setMentionRange(undefined);
  };
  const insertAtCaret = (insertion: string) => {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
    const inserted = `${prefix}${insertion} `;
    composerInput.setPendingCaret(before.length + inserted.length);
    onDraftChange(`${before}${inserted}${draft.slice(caret)}`);
  };
  const chooseMention = (choice: WebuiComposerMentionChoice) => {
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
  const changePermissionMode = async (mode: WebuiPermissionMode) => {
    if (!settingsWorkflows?.canWritePermissionMode) return;
    // Close the menu at the point of selection. The write may take a moment,
    // but the selected row should never remain visible in a disabled/greyed
    // state while the runtime is saving it.
    setPermissionMenuOpen(false);
    setPermissionBusy(true);
    setInteractionError(undefined);
    try {
      // The owner writes and answers with the mode the runtime settled on, so a
      // runtime that accepted something else is caught here, as before.
      const refreshed = await settingsWorkflows.savePermissionMode(mode);
      if (refreshed !== mode) throw new Error("授权模式未能保存，请重试");
      setPermissionUnavailable(false);
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPermissionBusy(false);
    }
  };
  const activateGoalMode = () => {
    if (!goalEnabled || !goalCoordinator.createGoal) return;
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
      composerInput.setPendingCaret(insertion.length);
      textareaRef.current?.focus();
      return;
    }
    const result = replaceWebuiSlashToken(draft, commandRange, insertion);
    onDraftChange(result.value);
    // The caret has to land after the trailing space: the palette is open for
    // any token under the caret, so leaving it inside "/command" would pop the
    // panel straight back open.
    composerInput.setPendingCaret(result.caret);
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
  const canCompose = controllerSnapshot.canCompose;
  const canQueue = controllerSnapshot.canQueue;
  // Turn phase remains part of session runtime state; the transcript owns all
  // visible messages for both the live and settled phases.
  // `isTurnLive` is the single source of truth for the three-value phase
  // predicate; the application session record (`application/state.ts`) carries
  // `sending` as a separate submit-lifecycle boolean the reducer deliberately
  // does NOT merge with `phase` — `submitWebuiComposerTurn` relies on the two
  // staying distinct.
  useComposerLayout(sessionLayout, composerRegionRef);
  const messageDraft = [draft.trim(), ...urlReferences.map((reference) => reference.url.trim()).filter(Boolean)].filter(Boolean).join("\n");
  // The button and Enter read one gate; its rule and its matrix live in the projection.
  const { submitBlocked } = readWebuiComposerSubmitGate({
    canCompose,
    canQueue,
    draft: messageDraft,
    attachmentCount: attachments.length,
    commandRunning,
    goalSubmitting,
  });
  const recordedTurn = composerSnapshot.retry;
  const retryPlan = planWebuiRetryResend({
    refusal: stream.refusal,
    recordedSession: recordedTurn?.session,
    session: sessionId,
    lastSubmittedText: recordedTurn?.message,
  });
  const handleRetryResend = () => {
    void composerController.retry({
      refusal: stream.refusal,
      sessionId,
      draft: recordedTurn?.message ?? "",
      attachments: attachmentWire,
      sending,
      planMode,
      goalEnabled,
      agentName,
      ...(createSessionWorkspaceDir ? { createSessionWorkspaceDir } : {}),
      ...(teamModeOff ? { teamModeOff: true } : {}),
      onSessionCreated: (createdSessionId, selected) => {
        if (isAttachedTo(sessionId)) onSessionCreated?.(createdSessionId, selected, teamModeOff);
      },
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
    setInteractionError(undefined);
    const outcome = await composerController.submit({
      draft: messageDraft,
      ...(command ? { commandMatch: command } : {}),
      ...(commandInvocation?.[2] !== undefined ? { commandInvocationInput: commandInvocation[2] } : {}),
      attachments: attachmentWire,
      sending,
      planMode,
      goalEnabled,
      agentName,
      ...(createSessionWorkspaceDir ? { createSessionWorkspaceDir } : {}),
      ...(teamModeOff ? { teamModeOff: true } : {}),
      onSessionCreated: (createdSessionId, selected) => {
        if (isAttachedTo(sessionId)) onSessionCreated?.(createdSessionId, selected, teamModeOff);
      },
    });
    if (outcome.kind !== "ignored" && outcome.kind !== "mode-activated") setHistoryBrowse(undefined);
    if (outcome.kind === "needs-session" && isAttachedTo(sessionId)) onNeedsSession?.(outcome.draft);
    if (outcome.kind === "goal-updated") editingGoalDraftRef.current = false;
  };
  const clearLocalGoal = () => {
    applyGoal(undefined);
    setGoalMode(false);
  };
  // A request that sets `replaceComposer` owns the composer's slot: the
  // runtime sets it on every ordinary questionnaire and on the plan review
  // (only feature-enable requests leave it false), and the interaction card
  // is drawn exactly where the input would be. The input therefore
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
      {/* The pause notice was gated on a session while the queue list was not,
          and the component keeps that split: there is no queue to pause before
          a session exists, but the list is a pure function of `queueItems`. */}
      <WebuiQueuePanel
        items={queueItems}
        paused={sessionId ? queuePaused : false}
        onRemove={(item) => void handleDeleteQueueItem(item)}
      />
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
        {sessionId && goalEnabled && goal ? <WebuiGoalBanner goal={goal} patchGoal={goalCoordinator.patchGoal} clearGoal={goalCoordinator.clearGoal} onEditGoal={editGoalInComposer} onCleared={clearLocalGoal} interactionBlocked={Boolean(questionnaire || permissions.length > 0)} /> : null}
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
              <div ref={composerInputContainerRef} className="message-input-container relative transition-colors">
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
                    composerInput.edit({
                      value: event.target.value,
                      caret: event.target.selectionStart,
                      changeDraft: handleDraftChange,
                      mentionRange,
                      setMentionRange,
                      setComposerMenu,
                      setPermissionMenuOpen,
                    });
                  }}
                  onPaste={(event) => {
                    const pastedFiles = Array.from(event.clipboardData.items).flatMap((item) => item.kind === "file" ? [item.getAsFile()].filter((file): file is File => file !== null) : []);
                    if (pastedFiles.length) { event.preventDefault(); void addFiles(pastedFiles); return; }
                    const pastedText = event.clipboardData.getData("text/plain").trim();
                    if (/^https?:\/\/\S+$/iu.test(pastedText)) {
                      event.preventDefault();
                      const start = event.currentTarget.selectionStart;
                      const end = event.currentTarget.selectionEnd;
                      composerInput.setPendingCaret(start);
                      onDraftChange(`${draft.slice(0, start)}${draft.slice(end)}`);
                      setUrlReferences((current) => [...current, { id: crypto.randomUUID(), url: pastedText }]);
                    }
                  }}
                  onClick={(event) => {
                    const caret = event.currentTarget.selectionStart;
                    composerInput.updateCaret(event.currentTarget.value, caret, mentionRange, setMentionRange);
                    const nextMentionRange = findWebuiMentionRange(event.currentTarget.value, caret);
                    if (nextMentionRange) {
                      setComposerMenu(undefined);
                      setPermissionMenuOpen(false);
                    }
                    setMentionRange(nextMentionRange);
                  }}
                  onKeyUp={(event) => {
                    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
                    composerInput.updateCaret(event.currentTarget.value, event.currentTarget.selectionStart, mentionRange, setMentionRange);
                  }}
                  onKeyDown={(event) => composerInput.handleKeyDown(event, {
                    draft,
                    history: inputHistory,
                    mentionRange,
                    mentionCount: mentionSuggestions.length,
                    commandRange,
                    commandCount: commandSuggestions.length,
                    composerMenu,
                    permissionMenuOpen,
                    goalMode,
                    planMode,
                    submitBlocked,
                    setMentionRange,
                    setComposerMenu,
                    setPermissionMenuOpen,
                    onDraftChange,
                    onHistoryDraftChange: handleDraftChange,
                    onCancelGoal: cancelGoalMode,
                    onCancelPlan: cancelPlanMode,
                    chooseMention: (index) => { const choice = mentionSuggestions[index]; if (choice) chooseMention(choice); },
                    chooseCommand: (index) => { const command = commandSuggestions[index]; if (command) chooseCommand(command.name); },
                  })}
                  disabled={!canCompose && !canQueue}
                  placeholder={goalMode ? "描述你想完成的目标" : planMode ? "描述需要规划的任务..." : "输入消息…（输入 / 唤起命令）"}
                  className="webui-textarea webui-composer-input text-text_default_primary"
                  data-webui-composer-input="true"
                />
                <WebuiComposerEditorStaging
                  attachments={attachments}
                  urlReferences={urlReferences}
                  attachmentBusy={attachmentBusy}
                  onRemoveAttachment={(id) =>
                    removeAttachment(id)
                  }
                  onChangeReference={(id, url) =>
                    setUrlReferences((current) =>
                      current.map((item) => (item.id === id ? { ...item, url } : item)),
                    )
                  }
                  onRemoveReference={(id) =>
                    setUrlReferences((current) => current.filter((item) => item.id !== id))
                  }
                  mention={
                    mentionRange && mentionSuggestions.length > 0
                      ? {
                          choices: mentionSuggestions,
                          index: mentionIndex,
                          onIndexChange: setMentionIndex,
                          onChoose: chooseMention,
                        }
                      : undefined
                  }
                  commands={commandSuggestions}
                  commandIndex={commandIndex}
                  onCommandIndexChange={setCommandIndex}
                  onChooseCommand={chooseCommand}
                  anchorRef={composerInputContainerRef}
                  dismissRegionRef={composerRegionRef}
                  onDismissMention={() => setMentionRange(undefined)}
                  onDismissCommand={() => {
                    if (!commandRange) return;
                    onDraftChange(removeWebuiSlashToken(draft, commandRange));
                  }}
                />
              </div>
              <div
                className="flex w-full items-center gap-3 px-3 pt-1"
                data-webui-composer-toolbar="true"
              >
                <WebuiDropdown
                  open={composerMenu !== undefined}
                  onOpen={() => {
                    setPermissionMenuOpen(false);
                    setMentionRange(undefined);
                    setComposerMenu("root");
                  }}
                  onClose={() => setComposerMenu(undefined)}
                  role="presentation"
                  triggerHasPopup="menu"
                  side="top"
                  align="start"
                  offset={8}
                  collision="clamp"
                  wrapperClassName="webui-composer-add-wrap"
                  className="webui-composer-menu-stack"
                  trigger={(triggerProps) => (
                    <button
                      type="button"
                      {...triggerProps}
                      aria-label="添加附件或技能"
                      data-testid="composer-add-menu"
                      className="webui-icon-button text-icon_default_tertiary"
                    >
                      <WebuiIconAttach />
                    </button>
                  )}
                >
        <WebuiComposerMenus
          menu={composerMenu}
          onMenuChange={setComposerMenu}
          skills={slashSkills}
          skillsLoading={skillsMenuLoading}
          skillsError={skillsMenuError}
          plugins={installedPlugins}
          pluginsLoading={pluginsLoading}
          pluginsError={pluginsError}
          pluginsAvailable={pluginCatalogue?.available === true}
          onOpenPluginManagement={onOpenPluginManagement}
          onAttach={() => fileInputRef.current?.click()}
          onGoal={activateGoalMode}
          onPlan={() => chooseCommand("plan")}
          onInsertSkill={(name) => { insertAtCaret(`/${name}`); textareaRef.current?.focus(); }}
          onInsertPlugin={(name) => { insertAtCaret(`@${name}`); textareaRef.current?.focus(); }}
        />
                </WebuiDropdown>
                <WebuiComposerPermissionControl
                  mode={permissionMode}
                  busy={permissionBusy}
                  unavailable={permissionUnavailable}
                  menuOpen={permissionMenuOpen}
                  onToggleRequest={() => {
                    setComposerMenu(undefined);
                    setMentionRange(undefined);
                    setPermissionMenuOpen((open) => !open);
                  }}
                  onClose={() => setPermissionMenuOpen(false)}
                  onChangeMode={(mode) => void changePermissionMode(mode)}
                />
                <WebuiComposerModePills
                  goalActive={goalEnabled && goalCoordinator.createGoal !== undefined && goalMode}
                  goalSubmitting={goalSubmitting}
                  planActive={planMode}
                  interactionBlocked={Boolean(questionnaire || permissions.length > 0)}
                  onCancelGoal={cancelGoalMode}
                  onCancelPlan={cancelPlanMode}
                />
                {/* 3.2px, written as an arbitrary value on purpose. The
                 * spacing scale is a fixed enumeration, so `gap-0.8` is not a
                 * class that exists and would silently render a ZERO gap
                 * instead of the 3.2px asked for — a spacing change that
                 * quietly becomes "controls touching" is worse than no change.
                 *
                 * This cluster got here by measurement, across three passes:
                 * 12px → 6px → 4px → 3.2px, each visibly looser than the last
                 * next to controls this small. 3.2 is the floor: the hit areas
                 * are neighbouring 28px squares, and 0 or 2px stops reading as
                 * separate controls at all. */}
                <div className="webui-composer-toolbar-actions ml-auto flex items-center gap-[3.2px]">
                  <ContextUsageIndicator
                    usage={contextUsage}
                    usageQuota={usageQuota}
                    planModel={selectedModel}
                  />
                  <WebuiModelPicker
                    models={enabledModels}
                    selected={selectedModel}
                    // The level rides the model name. It is resolved from the
                    // SAME option list the panel's slider reads, so the two
                    // cannot disagree about whether this model has a depth
                    // scale — a chip claiming "max" beside a panel that says
                    // nothing about a level is the contradiction this avoids.
                    triggerLevel={
                      selectedModel ? chipLevelLabel(thinkingOptions, selectedModel.thinking?.effort) : ""
                    }
                    onSelect={(model, draft) =>
                      void handleSelectModel(model, draft)
                    }
                    onSettingChange={(model, draft) =>
                      void handleSelectModel(model, draft)
                    }
                  />
                  <WebuiComposerSubmitButton
                    sending={sending}
                    submitBlocked={submitBlocked}
                    onStop={() => void handleStop()}
                  />
                </div>
              </div>
            </div>

        {!sessionLayout ? (
          <WebuiComposerProjectRow
            projectDir={createSessionWorkspaceDir}
            recentDirs={recentWorkspaceDirs}
            menuOpen={workspaceMenuOpen}
            onMenuOpenChange={setWorkspaceMenuOpen}
            onSelectProject={onWorkspaceChange}
          />
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
