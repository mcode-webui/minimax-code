import type {
  WebuiRunCommandName,
  WebuiSlashCommandFields,
} from "../contracts/slash-command.js";
import { classifyWebuiSlashCommand } from "../contracts/slash-command.js";
import type { WebuiStreamState } from "./stream-state.js";

export function looksLikeAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

export function isTurnLive(phase: WebuiStreamState["phase"] | undefined): boolean {
  return phase === "streaming" || phase === "waiting" || phase === "reconnecting";
}

export type WebuiSubmissionIntent =
  | { readonly kind: "activate-goal-mode" }
  | { readonly kind: "activate-plan-mode" }
  | { readonly kind: "submit-goal"; readonly objective: string }
  | {
      readonly kind: "run-command";
      readonly command: WebuiSlashCommandFields & {
        readonly name: WebuiRunCommandName;
        readonly supported: true;
      };
      readonly input?: string;
    }
  | { readonly kind: "submit-turn"; readonly message?: string; readonly clientIntent?: string };

export function resolveWebuiSubmissionIntent(args: {
  readonly draft: string;
  readonly commandMatch: WebuiSlashCommandFields | undefined;
  readonly commandInvocationName?: string;
  readonly commandInvocationInput?: string;
  readonly goalMode: boolean;
  readonly planMode?: boolean;
}): WebuiSubmissionIntent | undefined {
  const trimmedDraft = args.draft.trim();
  const command = args.commandMatch;
  const directGoalObjective = command?.name === "goal" ? args.commandInvocationInput?.trim() : undefined;
  if (command?.name === "goal" && !args.goalMode && !directGoalObjective)
    return { kind: "activate-goal-mode" };
  const directPlanPrompt = command?.name === "plan" ? args.commandInvocationInput?.trim() : undefined;
  if (command?.name === "plan" && !args.planMode && !directPlanPrompt)
    return { kind: "activate-plan-mode" };
  if (directPlanPrompt)
    return { kind: "submit-turn", message: directPlanPrompt, clientIntent: "plan-entry" };
  if (
    (args.goalMode || Boolean(directGoalObjective)) &&
    (Boolean(trimmedDraft) || Boolean(directGoalObjective))
  )
    return { kind: "submit-goal", objective: directGoalObjective ?? trimmedDraft };
  if (args.planMode && trimmedDraft)
    return { kind: "submit-turn", clientIntent: "plan-entry" };
  if (command && classifyWebuiSlashCommand(command) === "runnable") {
    const trimmedInput = args.commandInvocationInput?.trim();
    return {
      kind: "run-command",
      command: command as WebuiSlashCommandFields & {
        readonly name: WebuiRunCommandName;
        readonly supported: true;
      },
      ...(trimmedInput ? { input: trimmedInput } : {}),
    };
  }
  return { kind: "submit-turn" };
}

export type WebuiComposerEnterAction = "submit" | "newline";

export function resolveWebuiComposerEnterAction(args: {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly submitBlocked: boolean;
}): WebuiComposerEnterAction {
  if (args.shiftKey || args.altKey || args.ctrlKey || args.metaKey) return "newline";
  if (args.isComposing || args.submitBlocked) return "newline";
  return "submit";
}

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
