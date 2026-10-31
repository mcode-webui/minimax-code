import type { WebuiComposerSnapshot } from "./composer-state.js";
import type { WebuiMentionRange } from "./composer-interactions.js";
import type { WebuiSlashCommandFields } from "./slash-command.js";
import type { WebuiAttachmentInput } from "../../../../shared/contracts/messages.js";

export interface WebuiComposerSubmitIntent {
  readonly draft: string;
  readonly commandMatch?: WebuiSlashCommandFields;
  readonly commandInvocationInput?: string;
  readonly attachments?: readonly WebuiAttachmentInput[];
  readonly sending: boolean;
  readonly planMode?: boolean;
  readonly goalEnabled: boolean;
  readonly agentName: string;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
  readonly forceTurn?: boolean;
  readonly onSessionCreated?: (sessionId: string, selected: boolean) => void;
}

export type WebuiComposerSubmitOutcome =
  | { readonly kind: "ignored" }
  | { readonly kind: "mode-activated"; readonly mode: "goal" | "plan" }
  | { readonly kind: "submitted"; readonly sessionId?: string; readonly createdSessionId?: string }
  | { readonly kind: "queued"; readonly sessionId: string; readonly createdSessionId?: string }
  | { readonly kind: "goal-updated"; readonly sessionId: string; readonly createdSessionId?: string }
  | { readonly kind: "command-completed"; readonly output: string }
  | { readonly kind: "needs-session"; readonly draft: string }
  | { readonly kind: "failed"; readonly error: string };

export interface WebuiComposerControllerSnapshot {
  readonly composer: WebuiComposerSnapshot;
  readonly interactionError?: string;
  readonly commandOutput?: string;
  readonly commandRunning: boolean;
  readonly goalSubmitting: boolean;
  readonly inspectionSessionId?: string;
  readonly canCompose: boolean;
  readonly canQueue: boolean;
  readonly canRunCommand: boolean;
  readonly canRemoveQueued: boolean;
  readonly createdSession?: { readonly ticketId: number; readonly sessionId: string; readonly selected: boolean };
}

/** View-facing commands. The mutable store remains private to application composition. */
export interface WebuiComposerController {
  readonly getSnapshot: () => WebuiComposerControllerSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly submit: (intent: WebuiComposerSubmitIntent) => Promise<WebuiComposerSubmitOutcome>;
  readonly retry: (input: WebuiComposerSubmitIntent & { readonly refusal?: string; readonly sessionId?: string }) => Promise<void>;
  readonly removeQueued: (input: { readonly sessionId: string; readonly itemId: string }) => Promise<void>;
  readonly refreshQueue: (sessionId: string) => void;
  readonly selectSession: (sessionId: string | undefined) => void;
  readonly attachView: (sessionId: string | undefined) => () => void;
  readonly setGoalMode: (enabled: boolean) => void;
  readonly setPlanMode: (enabled: boolean) => void;
  readonly clearError: () => void;
  readonly setMentionRange: (next: WebuiMentionRange | undefined) => void;
  readonly setStagedAttachments: (next: (current: WebuiComposerSnapshot["staging"]["attachments"]) => WebuiComposerSnapshot["staging"]["attachments"] | WebuiComposerSnapshot["staging"]["attachments"]) => void;
  readonly setAttachmentBusy: (busy: boolean) => void;
  readonly consumeSeed: (token: string) => void;
  readonly setUrlReferences: (next: (current: WebuiComposerSnapshot["staging"]["urlReferences"]) => WebuiComposerSnapshot["staging"]["urlReferences"]) => void;
  readonly setDraft: (text: string, sessionId?: string) => void;
  readonly recordInput: (text: string, sessionId?: string) => void;
  readonly dispose: () => void;
}

export type WebuiComposerCommandName = "goal" | "plan" | (string & {});
