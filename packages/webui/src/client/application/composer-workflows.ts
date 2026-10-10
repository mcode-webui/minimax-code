import type { WebuiClientMessageEnqueuer } from "../contracts/execution-port.js";
import type { WebuiClientCreateSessionResult, WebuiClientSessionCreator } from "../contracts/session-port.js";
import type { WebuiGoal, WebuiGoalCreateRequest, WebuiGoalPatchRequest } from "../../shared/contracts/goal.js";
import type { WebuiAttachmentInput } from "../../shared/contracts/messages.js";
import { formatWebuiError } from "../value-readers.js";
import { queueWebuiTurn } from "./queue-command.js";
import { initialWebuiStreamState, ownsWebuiStreamGeneration, type WebuiStreamState } from "../projection/stream-state.js";
import { buildWebuiStreamLoopSink, runWebuiStreamLoop, type WebuiStreamLoopDeps } from "../mechanisms/stream-loop.js";
import { streamRecoveryProjection } from "../projection/stream-recovery.js";
import { streamStateBundle } from "./stream-state-bundle.js";

export interface WebuiComposerSubmitArgs {
  readonly sessionId?: string;
  readonly draft: string;
  readonly message?: string;
  readonly clientIntent?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly onAttachmentsSubmitted?: () => void;
  readonly sending: boolean;
  readonly deps: Omit<WebuiStreamLoopDeps, "projection" | "streamState">;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly createSession?: WebuiClientSessionCreator;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
}

export interface WebuiComposerSubmitHandlers {
  readonly setStream: (update: (current: WebuiStreamState) => WebuiStreamState) => void;
  readonly readStream?: () => WebuiStreamState;
  readonly setSending: (sending: boolean) => void;
  readonly onDraftChange: (next: string) => void;
  readonly onNeedsSession?: (draft: string) => void;
  readonly onSessionCreated?: (sessionId: string) => void;
  readonly onQueued?: () => void;
}

export function buildWebuiComposerHandlers(args: WebuiComposerSubmitHandlers): WebuiComposerSubmitHandlers {
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

function looksLikeAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

function createSessionWorkspaceField(workspaceDir?: string): { readonly workspaceDir?: string } {
  if (workspaceDir === undefined) return {};
  const value = workspaceDir.trim();
  if (!value) throw new Error("项目目录不能为空，请重新选择项目目录");
  if (!looksLikeAbsoluteWorkspacePath(value))
    throw new Error(`项目目录需要绝对路径，收到的是「${value}」。请重新选择项目目录`);
  return { workspaceDir: value };
}

export function createdSessionId(result: WebuiClientCreateSessionResult): string | undefined {
  return result.sessionId?.trim() || result.session?.sessionId?.trim() || undefined;
}

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
  if (args.currentGoal && args.patchGoal) return args.patchGoal({ sessionId, objective });
  return args.createGoal({ sessionId, objective });
}

export async function submitWebuiComposerTurn(
  args: WebuiComposerSubmitArgs,
  handlers: WebuiComposerSubmitHandlers,
): Promise<void> {
  const message = (args.message ?? args.draft).trim();
  const attachments = args.attachments ?? [];
  if ((!message && attachments.length === 0) || (!args.deps.sendMessage && !args.enqueueMessage)) return;
  let sessionId = args.sessionId;
  if (!sessionId) {
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
      if (!sessionId) throw new Error("createSession response did not include a session id");
      handlers.setStream(() => ({ ...initialWebuiStreamState, phase: "streaming", processingStartedAtMs: Date.now() }));
      handlers.onSessionCreated?.(sessionId);
    } catch (error) {
      handlers.setStream((current) => ({ ...current, refusal: formatWebuiError(error) }));
      return;
    }
  }
  if (args.sending) {
    if (!args.enqueueMessage) return;
    await queueWebuiTurn({
      sessionId,
      message,
      ...(args.clientIntent ? { clientIntent: args.clientIntent } : {}),
      ...(attachments.length ? { attachments } : {}),
      enqueueMessage: args.enqueueMessage,
      onDraftChange: handlers.onDraftChange,
      onAttachmentsSubmitted: args.onAttachmentsSubmitted,
      onQueued: handlers.onQueued,
      setRefusal: (refusal) => handlers.setStream((current) => ({ ...current, refusal })),
    });
    return;
  }
  if (!args.deps.sendMessage) return;
  handlers.setSending(true);
  handlers.onDraftChange("");
  args.onAttachmentsSubmitted?.();
  handlers.setStream((current) => ({ ...initialWebuiStreamState, phase: "streaming", processingStartedAtMs: Date.now() }));
  let claimed: number | undefined;
  try {
    claimed = await runWebuiStreamLoop(
      { ...args.deps, projection: streamRecoveryProjection, streamState: streamStateBundle },
      { sessionId, message, ...(args.clientIntent ? { clientIntent: args.clientIntent } : {}), ...(attachments.length ? { attachments } : {}) },
      buildWebuiStreamLoopSink(handlers.setStream, streamStateBundle),
    );
  } finally {
    const current = handlers.readStream?.();
    if (current === undefined || ownsWebuiStreamGeneration(current, claimed)) handlers.setSending(false);
  }
}
