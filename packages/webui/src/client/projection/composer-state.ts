// Composer submit helpers — pure form-submit handler extracted from the
// React component so a test can drive the production app-to-helper seam
// without standing up a DOM.
//
// `buildWebuiComposerHandlers` is a single-line pass-through by design: its
// job is to make the call site read `submitWebuiComposerTurn(args,
// buildWebuiComposerHandlers({...}))` rather than scattering the setters
// around the JSX. `submitWebuiComposerTurn` itself is the real handler:
// it normalises the draft, creates a session when one is missing, sends or
// enqueues the message, and routes failures into the `refusal` field so the
// panel surfaces them inline.

import type { WebuiClientMessageEnqueuer } from "../contracts/execution-port.js";
import type { WebuiClientCreateSessionResult, WebuiClientSessionCreator } from "../contracts/session-port.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "../../shared/contracts/goal.js";
import type { WebuiAttachmentInput } from "../../shared/contracts/messages.js";
import { formatWebuiError } from "../value-readers.js";
import { initialWebuiStreamState, ownsWebuiStreamGeneration } from "../stream.js";
import {
  buildWebuiStreamLoopSink,
  runWebuiStreamLoop,
  type WebuiStreamLoopDeps,
} from "../stream-loop.js";
import { streamRecoveryProjection } from "./stream-recovery.js";
import type { WebuiStreamState } from "../stream.js";
import type { SlashCommandEntry, WebuiRunCommandName } from "../slash-palette.js";
import { isWebuiRunnableCommand, classifyWebuiSlashCommand } from "../slash-palette.js";

/**
 * Absolute-path check shared by the project picker and the submit guard.
 * Deliberately not `node:path`: this runs in the browser, where the
 * POSIX and Windows shapes both have to be recognised. The server stays
 * the authority — it rejects anything relative or missing.
 */
export function looksLikeAbsoluteWorkspacePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
}

/**
 * The `workspaceDir` field for a `createSession` call, or a failure the
 * user can act on.
 *
 * A browser can only ever hand us a bare folder name, and the server
 * answers that with `workspaceDir must be an absolute path`. Failing here
 * keeps the reported cause next to the picker that produced it.
 */
function createSessionWorkspaceField(workspaceDir?: string): {
  readonly workspaceDir?: string;
} {
  if (workspaceDir === undefined) return {};
  const value = workspaceDir.trim();
  if (!value) throw new Error("项目目录不能为空，请重新选择项目目录");
  if (!looksLikeAbsoluteWorkspacePath(value))
    throw new Error(
      `项目目录需要绝对路径，收到的是「${value}」。请重新选择项目目录`,
    );
  return { workspaceDir: value };
}

/**
 * Whether the live turn column should own the render surface. Mirrors the
 * Desktop's `phase === "streaming" || "waiting" || "reconnecting"` rule.
 *
 * Single source of truth for the three-value predicate the composer and the
 * transcript both used to inline. The phase taxonomy comes from `stream.ts`
 * (`idle / streaming / waiting / done / refused / error / reconnecting`);
 * `streaming / waiting / reconnecting` are the three phases during which the
 * server-side turn is still in flight, so the live column owns the render
 * surface and the historical transcript defers its `loadMessages` call.
 *
 * `sending` (a separate `WebuiSessionRuntimeState` boolean) is intentionally
 * NOT folded into this predicate: `sending` is the submit lifecycle (a flag
 * the submit path owns and the stop button reads), while `phase` is the
 * session-flow lifecycle owned by the runtime event reducer. Conflating the
 * two would change the meaning of `turnLive` for the `done` phase (where
 * `sending` is briefly still true) and would break the
 * `submitWebuiComposerTurn` `finally` ordering.
 */
export function isTurnLive(
  phase: WebuiStreamState["phase"] | undefined,
): boolean {
  return (
    phase === "streaming" ||
    phase === "waiting" ||
    phase === "reconnecting"
  );
}

/**
 * The submission intent resolver — pure function that classifies a composer
 * submit into one of the five paths the submit pipeline recognises:
 *
 *   1. `activate-goal-mode` — bare `/goal` with no objective, while not yet
 *      in goal mode. Switches the textarea into goal-mode; the draft is
 *      cleared and the focus stays on the textarea.
 *   2. `submit-goal` — either an explicit `/goal <objective>` or
 *      `goalMode + draft`. Resolved via `submitWebuiGoal` (create/patch).
 *   3. `run-command` — a slash command whose name is in
 *      `WEBUI_RUN_COMMAND_NAMES` (help / new / compact / status / usage /
 *      model) and whose `supported` flag is true. Resolved via the host's
 *      `runCommand` capability.
 *   4. `submit-turn` — the default path: the trim of the draft is the user
 *      message. `submitWebuiComposerTurn` further dispatches into the
 *      `send+resume` (when `sending === false`) and `queue` (when
 *      `sending === true && enqueueMessage` is wired) sub-paths.
 *
 * The resolver carries NO side effects: it reads the inputs and returns the
 * intent, the component decides what to do with it. `undefined` is returned
 * when no intent can be resolved (e.g. an empty draft with no slash match
 * and no goal-mode active — the submit path is a no-op there).
 *
 * `commandInvocation` is the parsed slash command shape `submit` already
 * computes (`name` + optional `(cap, ...rest)` segments). The resolver takes
 * the same primitive (the parsed `name` and the optional `input`) rather than
 * re-parsing the draft — this keeps the slash regex in one place.
 */
export type WebuiSubmissionIntent =
  | { readonly kind: "activate-goal-mode" }
  | { readonly kind: "activate-plan-mode" }
  | { readonly kind: "submit-goal"; readonly objective: string }
  | {
      readonly kind: "run-command";
      readonly command: SlashCommandEntry & {
        readonly name: WebuiRunCommandName;
        readonly supported: true;
      };
      readonly input?: string;
    }
  | {
      readonly kind: "submit-turn";
      readonly message?: string;
      readonly clientIntent?: string;
    };

export function resolveWebuiSubmissionIntent(args: {
  readonly draft: string;
  readonly commandMatch: SlashCommandEntry | undefined;
  readonly commandInvocationName?: string;
  readonly commandInvocationInput?: string;
  readonly goalMode: boolean;
  readonly planMode?: boolean;
}): WebuiSubmissionIntent | undefined {
  const trimmedDraft = args.draft.trim();
  const command = args.commandMatch;
  const directGoalObjective =
    command?.name === "goal"
      ? args.commandInvocationInput?.trim()
      : undefined;
  // Path 1 — bare `/goal` (no objective) flips the textarea into goal mode.
  if (command?.name === "goal" && !args.goalMode && !directGoalObjective) {
    return { kind: "activate-goal-mode" };
  }
  const directPlanPrompt =
    command?.name === "plan"
      ? args.commandInvocationInput?.trim()
      : undefined;
  if (command?.name === "plan" && !args.planMode && !directPlanPrompt) {
    return { kind: "activate-plan-mode" };
  }
  if (directPlanPrompt) {
    return {
      kind: "submit-turn",
      message: directPlanPrompt,
      clientIntent: "plan-entry",
    };
  }
  // Path 2 — goal submission. Either an explicit `/goal <objective>` form,
  // or an active goal-mode composer carrying a draft.
  if (
    (args.goalMode || Boolean(directGoalObjective)) &&
    (Boolean(trimmedDraft) || Boolean(directGoalObjective))
  ) {
    const objective = directGoalObjective ?? trimmedDraft;
    return { kind: "submit-goal", objective };
  }
  if (args.planMode && trimmedDraft) {
    return { kind: "submit-turn", clientIntent: "plan-entry" };
  }
  // Path 3 — slash command backed by `runCommand`. The classification
  // gates the run-command intent: only `runnable` entries reach the host;
  // `inert-wired` (skills; supported but not runnable) and
  // `inert-unsupported` (disabled entries) fall through to path 4. This
  // is the production consumer of `classifyWebuiSlashCommand` — the
  // three-state taxonomy now drives the resolver, not just the test
  // catalogue.
  if (command && classifyWebuiSlashCommand(command) === "runnable") {
    const trimmedInput = args.commandInvocationInput?.trim();
    return {
      kind: "run-command",
      command: command as SlashCommandEntry & {
        readonly name: WebuiRunCommandName;
        readonly supported: true;
      },
      ...(trimmedInput ? { input: trimmedInput } : {}),
    };
  }
  // Path 4 — default user-message submit. `submitWebuiComposerTurn` will
  // further split into `send+resume` vs `queue` based on `args.sending` and
  // the `enqueueMessage` wiring; that split is downstream of the intent
  // resolver because it owns the side effects (setStream / setSending) the
  // resolver must not call.
  return { kind: "submit-turn" };
}

/** What Enter means at the textarea. */
export type WebuiComposerEnterAction = "submit" | "newline";

/**
 * Decide what a bare Enter in the composer textarea does.
 *
 * Enter is already overloaded here before it can be a shortcut: with the
 * mention menu open it accepts the highlighted entry, and with the slash
 * command popover open it accepts the highlighted command. Both of those
 * branches live in the component's `onKeyDown` and return early, so this
 * resolver only ever sees the key once nothing else has claimed it.
 *
 * The remaining decision is send-versus-newline, and it is pure: the same key
 * event plus the gate the send button already uses. Routing the button and the
 * keyboard through one `submitBlocked` flag is the point — a keyboard shortcut
 * that could submit through a path the button would have refused is the bug
 * this shape exists to prevent.
 *
 * `newline` means "do not preventDefault": the textarea inserts its own
 * line break and nothing else happens.
 */
export function resolveWebuiComposerEnterAction(args: {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** True while an IME candidate window is open. */
  readonly isComposing: boolean;
  /** The send button's `disabled` condition, hoisted to a single value. */
  readonly submitBlocked: boolean;
}): WebuiComposerEnterAction {
  // Any modifier keeps Enter as a newline. Shift+Enter is the conventional
  // multi-line gesture, and the platform modifiers belong to the browser and
  // the desktop shell (Ctrl/Cmd+Enter as a submit alias, Alt as a
  // newline-alias) — claiming them would break both.
  if (args.shiftKey || args.altKey || args.ctrlKey || args.metaKey) {
    return "newline";
  }
  // An IME candidate is confirmed with Enter. Sending on that keystroke would
  // fire mid-composition and discard the candidate the user was still choosing
  // between, so composition always wins over the shortcut.
  if (args.isComposing) return "newline";
  // Nothing sendable right now (empty draft, a command already running, a goal
  // already submitting): fall back to the textarea's own newline rather than
  // swallowing the key.
  if (args.submitBlocked) return "newline";
  return "submit";
}

/** Inputs the composer submit handler needs. */
export interface WebuiComposerSubmitArgs {
  readonly sessionId?: string;
  readonly draft: string;
  readonly message?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly onAttachmentsSubmitted?: () => void;
  readonly sending: boolean;
  readonly deps: WebuiStreamLoopDeps;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  /** Create the first session silently when New Task has no selected session. */
  readonly createSession?: WebuiClientSessionCreator;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
}

/** React-state setters the submit handler needs. Bundling them on a single
 *  object lets the test layer pass a stub bag and assert which setters ran. */
export interface WebuiComposerSubmitHandlers {
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  /**
   * Read the current stream state. Needed to answer "does the loop I just
   * started still own this session?" after it settles — a submit that
   * finishes late must not clear the sending flag of a turn that started
   * after it. Optional so the test layer can pass a stub bag without one;
   * without it the submit assumes it still owns the stream.
   */
  readonly readStream?: () => WebuiStreamState;
  readonly setSending: (sending: boolean) => void;
  readonly onDraftChange: (next: string) => void;
  readonly onNeedsSession?: (draft: string) => void;
  readonly onSessionCreated?: (sessionId: string) => void;
  readonly onQueued?: () => void;
}

/**
 * Assemble the React-state setters the submit handler needs into the shape
 * `submitWebuiComposerTurn` accepts. The component in this file calls this
 * once per render with the setters it derives from `useState`, then hands
 * the result to `submitWebuiComposerTurn`. The helper is a single-line
 * pass-through by design — its job is to make the call site read
 * `submitWebuiComposerTurn(args, buildWebuiComposerHandlers({...}))`.
 */
export function buildWebuiComposerHandlers(args: {
  readonly setStream: WebuiComposerSubmitHandlers["setStream"];
  readonly readStream?: WebuiComposerSubmitHandlers["readStream"];
  readonly setSending: WebuiComposerSubmitHandlers["setSending"];
  readonly onDraftChange: WebuiComposerSubmitHandlers["onDraftChange"];
  readonly onNeedsSession?: WebuiComposerSubmitHandlers["onNeedsSession"];
  readonly onSessionCreated?: WebuiComposerSubmitHandlers["onSessionCreated"];
  readonly onQueued?: WebuiComposerSubmitHandlers["onQueued"];
}): WebuiComposerSubmitHandlers {
  return {
    setStream: args.setStream,
    ...(args.readStream ? { readStream: args.readStream } : {}),
    setSending: args.setSending,
    onDraftChange: args.onDraftChange,
    onNeedsSession: args.onNeedsSession,
    onSessionCreated: args.onSessionCreated,
    onQueued: args.onQueued,
  };
}

export interface WebuiGoalSubmitArgs {
  readonly sessionId?: string;
  readonly objective: string;
  readonly currentGoal?: WebuiGoal;
  readonly createGoal: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
  readonly createSession?: WebuiClientSessionCreator;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
}

/**
 * Submit the Desktop-style goal composer action without sending the objective
 * as a normal chat message. A home composer creates the session first, then
 * uses the existing goal RPC; an existing goal is updated through patchGoal.
 */
export async function submitWebuiGoal(
  args: WebuiGoalSubmitArgs,
  onSessionCreated?: (sessionId: string) => void,
): Promise<WebuiGoal> {
  const objective = args.objective.trim();
  if (!objective) throw new Error("目标内容不能为空");
  let sessionId = args.sessionId;
  if (!sessionId) {
    if (!args.createSession) throw new Error("无法创建目标会话");
    const result = await args.createSession({
      name: "main",
      ...createSessionWorkspaceField(args.createSessionWorkspaceDir),
      teamModeOff: args.teamModeOff,
    });
    sessionId = createdSessionId(result);
    if (!sessionId) throw new Error("创建目标会话未返回会话 ID");
    onSessionCreated?.(sessionId);
  }
  if (args.currentGoal && args.patchGoal) {
    return args.patchGoal({ sessionId, objective });
  }
  return args.createGoal({ sessionId, objective });
}

/**
 * Submit one composer turn. Steps:
 *   1. Trim the draft; bail out on empty or when no transport is wired.
 *   2. If we have no `sessionId`, call `createSession` and seed the live
 *      state on the (still-home) key. The `onSessionCreated` callback is
 *      the seam the host uses to migrate the state into the new key.
 *   3. If a turn is in flight and `enqueueMessage` is wired, queue the
 *      message instead of sending it. Otherwise call `runWebuiStreamLoop`
 *      with the live `setStream` sink.
 *   4. All failures land on `setStream.refusal` via `formatWebuiError` so
 *      the panel can render them inline.
 */
export async function submitWebuiComposerTurn(
  args: WebuiComposerSubmitArgs,
  handlers: WebuiComposerSubmitHandlers,
): Promise<void> {
  const message = (args.message ?? args.draft).trim();
  const attachments = args.attachments ?? [];
  if ((!message && attachments.length === 0) || (!args.deps.sendMessage && !args.enqueueMessage)) return;
  let sessionId = args.sessionId;
  if (!sessionId) {
    // No workspace is fine: the harness falls back to the default workspace
    // (desktop's 不需要项目 / default-directory flows). Only bail when the
    // session creator itself is not wired — that used to swallow the send
    // silently whenever the folder pill was unset.
    if (!args.createSession) {
      handlers.onNeedsSession?.(args.draft);
      return;
    }
    try {
      const result = await args.createSession({
        name: "main",
        ...createSessionWorkspaceField(args.createSessionWorkspaceDir),
        teamModeOff: args.teamModeOff,
      });
      sessionId = createdSessionId(result);
      if (!sessionId)
        throw new Error("createSession response did not include a session id");
      handlers.setStream(() => ({
        ...initialWebuiStreamState,
        phase: "streaming",
        processingStartedAtMs: Date.now(),
      }));
      handlers.onSessionCreated?.(sessionId);
    } catch (error) {
      handlers.setStream((current) => ({
        ...current,
        refusal: formatWebuiError(error),
      }));
      return;
    }
  }
  if (args.sending) {
    if (!args.enqueueMessage) return;
    try {
      await args.enqueueMessage({ id: sessionId, content: message, ...(args.clientIntent ? { clientIntent: args.clientIntent } : {}), ...(attachments.length ? { attachments } : {}) });
      handlers.onDraftChange("");
      args.onAttachmentsSubmitted?.();
      handlers.onQueued?.();
    } catch (error) {
      handlers.setStream((current) => ({
        ...current,
        refusal: formatWebuiError(error),
      }));
    }
    return;
  }
  if (!args.deps.sendMessage) return;
  handlers.setSending(true);
  handlers.onDraftChange("");
  args.onAttachmentsSubmitted?.();
  handlers.setStream((current) => ({
    ...initialWebuiStreamState,
    phase: "streaming",
    processingStartedAtMs: Date.now(),
  }));
  let claimed: number | undefined;
  try {
    claimed = await runWebuiStreamLoop(
      { ...args.deps, projection: args.deps.projection ?? streamRecoveryProjection },
      { sessionId, message, ...(args.clientIntent ? { clientIntent: args.clientIntent } : {}), ...(attachments.length ? { attachments } : {}) },
      buildWebuiStreamLoopSink(handlers.setStream),
    );
  } finally {
    // Only clear the indicator if this turn still owns the stream. A submit
    // that settles after another turn started would otherwise make that
    // turn look idle while it is still streaming.
    const current = handlers.readStream?.();
    // Without a reader we cannot tell whether a newer turn took over, so
    // fall back to clearing. A stranded "thinking" indicator is worse than
    // one cleared a moment early.
    if (current === undefined || ownsWebuiStreamGeneration(current, claimed))
      handlers.setSending(false);
  }
}

/** Extract a non-blank session id from the `createSession` result.
 *
 * The runtime returns the id in two places — top-level or under `session` —
 * and either field can be missing, blank, or padded with whitespace.
 * `submitWebuiComposerTurn` later uses this as the live session key, so the
 * `.trim()` + `|| undefined` matters: a `"   "` session id would
 * `!sessionId`-branch off cleanly under `??` but skip the trim and pass the
 * whitespace into the runtime. Match the historical semantics.
 */
export function createdSessionId(
  result: WebuiClientCreateSessionResult,
): string | undefined {
  return result.sessionId?.trim() || result.session?.sessionId?.trim() || undefined;
}

/**
 * Workspace directories to offer as `最近` in the project picker, derived
 * from session history.
 *
 * There is no `listRecentWorkspaces` operation: the runtime exposes only
 * `browseWorkspaceDirs` (an on-demand filesystem walk behind the 选择新项目
 * browser) and `listWorkspaceFileTree` (files inside a workspace). The only
 * recency signal the client already holds is the session list, so that is
 * what this reads — a workspace you have actually worked in, most recently
 * touched first. No extra round trip, and the list can never name a
 * directory the user has not been in.
 *
 * Ordering rules, in priority order:
 *   - sessions are scanned newest-first, so a workspace's FIRST appearance
 *     fixes its rank; a later session in the same workspace does not
 *     demote it;
 *   - duplicates collapse on the raw path;
 *   - blank and missing `workspaceDir` are skipped (a session with no
 *     project is exactly what the `不需要项目` row is for);
 *   - `limit` caps the rendered rows. The cap is applied last so a workspace
 *     that only appears late in the list is still reachable.
 *
 * The caller sorts by recency; this function deliberately does not read the
 * clock, so the result is a pure function of its input.
 */
export function deriveRecentWorkspaceDirs(
  sessions: ReadonlyArray<{
    readonly workspaceDir?: string;
    readonly updatedAt?: number;
  }>,
  limit = 6,
): readonly string[] {
  const byRecency = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const session of byRecency) {
    const dir = session.workspaceDir?.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    result.push(dir);
    if (result.length >= limit) break;
  }
  return result;
}
