// The memory hand-off, as a Settings-owned contract.
//
// 「在会话中创建」 crosses a business boundary: Settings decides what to hand
// over, the shell decides where to put it, and the composer renders the chip.
// The shape those three agree on therefore belongs to the business that owns the
// concept, not to the one dialog that first produced it.
//
// It used to live in `ui/MemoryManagerDialog.tsx`, which made every consumer of
// the type — including two outside Settings — import a React component module to
// name an interface. That pulled a component's implementation across a
// boundary the type never needed, and it meant the shape could not be referenced
// without the dialog's dependency list. The pure derivation moves here; the
// component stays where it is and imports this.

/** What 「在会话中创建」 leaves in the composer, beside the attached file.
 *  The home surface opens with exactly this one line already
 *  typed, so the user's next action is to add what they actually want changed. */
export const MEMORY_HANDOFF_PROMPT = "我想调整下这个记忆文件";

/** What 「在会话中创建」 carries across: the body plus the identity the composer
 *  chip needs. `token` makes the hand-off one-shot — the composer remembers the
 *  last token it consumed, so a re-render cannot double-attach a 74KB file. */
export interface MemoryHandoff {
  readonly token: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content: string;
}

/**
 * What the hand-off still owes the composer.
 *
 * The hand-off is one-shot, and so is everything it brings: the file it
 * attaches and the line it types beside it. The file's own latch is the
 * composer's consumed seed token; this is the same latch for the line, asked
 * the same way — with the token the caller has already typed.
 *
 * It has to be a latch rather than a write. The line is typed when the
 * hand-off opens the home surface, but the surface is visited again for every
 * reason there is — a session, a back, a new task — and a line typed on each
 * visit replaces what the user has written since.
 */
export type WebuiMemoryHandoffPrompt =
  /** Nothing to type: no hand-off, or this token has already been typed. */
  | { readonly kind: "none" }
  /** Type this line, and record the token before doing it. */
  | { readonly kind: "prompt"; readonly token: string; readonly prompt: string };

/**
 * Read the hand-off's line, as a decision rather than as a write.
 *
 * The caller records the token before it types, so the order the invariant
 * requires is visible at the call site rather than implied by this function's
 * internals.
 */
export function readWebuiMemoryHandoffPrompt(input: {
  readonly handoff: MemoryHandoff | undefined;
  /** The token whose line has already been typed, if any. */
  readonly consumedToken: string | undefined;
}): WebuiMemoryHandoffPrompt {
  const { handoff } = input;
  if (!handoff) return { kind: "none" };
  if (input.consumedToken === handoff.token) return { kind: "none" };
  return { kind: "prompt", token: handoff.token, prompt: MEMORY_HANDOFF_PROMPT };
}

/**
 * The save predicate, as a decision rather than as component state.
 *
 * `!loading && !saving && draft !== baseline && draft.length > 0`. All four
 * matter: a live button on open offers a write that rewrites the file
 * byte-for-byte, and an empty draft is the delete path, which belongs behind the
 * ⋯ menu's own confirmation rather than on the save control.
 *
 * It lives with the contract because "may this be saved" is a rule about the
 * hand-off's subject — the file — and the dialog is only its first caller.
 */
export function isMemorySaveable(input: {
  readonly draft: string | undefined;
  readonly baseline: string | undefined;
  readonly loading: boolean;
  readonly saving: boolean;
}): boolean {
  return (
    !input.loading &&
    !input.saving &&
    input.draft !== undefined &&
    input.draft !== input.baseline &&
    input.draft.length > 0
  );
}

/**
 * The memory file's timestamp, in the panel's own words.
 *
 * A parse failure renders as nothing rather than as `Invalid Date`: the row shows
 * when the file last changed, and a row that cannot say so has nothing to add.
 */
export function formatMemoryTimestamp(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number): string => String(part).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `更新于 ${stamp}`;
}
