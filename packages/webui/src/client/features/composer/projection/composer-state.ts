import type {
  WebuiRunCommandName,
  WebuiSlashCommandFields,
} from "../contracts/slash-command.js";
import { classifyWebuiSlashCommand } from "../contracts/slash-command.js";
import { shortcutMatches, type ShortcutBindings, type ShortcutKeyEvent } from "../../../projection/common/shortcuts.js";
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

export type WebuiComposerShortcutAction = "submit" | "newline" | "ignore";

/**
 * What a key press in the composer does.
 *
 * The rule is the configured binding, not a hard-coded one: the settings page
 * can bind "send the message" to any combination, and the composer follows it.
 * `ignore` is the answer for a press that names no binding at all — the
 * browser's own behaviour then stands, which is how a key that is not bound
 * keeps doing what a key in a textarea does.
 *
 * The default bindings (`Enter` sends, `Shift+Enter` breaks the line) reproduce
 * the rule this composer had before the bindings were rebindable.
 */
export function resolveWebuiComposerShortcutAction(args: {
  readonly event: ShortcutKeyEvent;
  readonly isComposing: boolean;
  readonly submitBlocked: boolean;
  readonly bindings: ShortcutBindings;
}): WebuiComposerShortcutAction {
  // While an input method is composing, Enter belongs to the composition.
  if (args.isComposing) return "ignore";
  if (shortcutMatches(args.bindings["composer.submit"], args.event)) {
    return args.submitBlocked ? "ignore" : "submit";
  }
  if (shortcutMatches(args.bindings["composer.newline"], args.event)) return "newline";
  return "ignore";
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


/**
 * Whether intent resolution records this input before its command settles. It
 * belongs beside the resolution it qualifies, because what it answers is a
 * property of the resolved intent.
 */
export function shouldRecordWebuiComposerSubmission(
  intent: WebuiSubmissionIntent | undefined,
): boolean {
  return intent?.kind === "submit-turn" || intent?.kind === "submit-goal" || intent?.kind === "run-command";
}

/**
 * The input of the last turn a composer submitted, and the session it was in. It
 * lives here because the composer's owner keeps the record and an application
 * module may not import a component.
 */
export type { WebuiRecordedTurn } from "../contracts/composer-turn.js";
