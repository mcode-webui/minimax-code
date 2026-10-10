import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  deriveRecentWorkspaceDirs,
  isTurnLive,
  resolveWebuiComposerEnterAction,
  resolveWebuiSubmissionIntent,
  type WebuiSubmissionIntent,
} from "../../src/client/projection/composer-state.js";
import type { SlashCommandEntry } from "../../src/client/slash-palette.js";
import {
  findWebuiMentionRange,
  findWebuiSlashRange,
  insertWebuiMention,
  removeWebuiSlashToken,
  replaceWebuiSlashToken,
  webuiAttachmentLimitError,
  webuiTextAttachmentDataUrl,
} from "../../src/client/projection/composer-interactions.js";
import { sendMessageOperation, enqueueMessageOperation } from "../../src/server/operation/operations.js";
import { setPermissionModeOperation } from "../../src/server/operation/permission-mode.js";

/**
 * Pure-function tests for the composer submission intent resolver.
 *
 *   resolveWebuiSubmissionIntent(draft, commandMatch, goalMode) → intent
 *   isTurnLive(phase)                                         → boolean
 *
 * The resolver carries no side effects (no React, no setters, no draft
 * clearing). All the test fixtures here are therefore plain value shapes.
 *
 * The intent taxonomy is:
 *   1. activate-goal-mode  — bare `/goal`, not yet in goal mode
 *   2. submit-goal         — `/goal <objective>` or `goalMode + draft`
 *   3. run-command         — slash command in `WEBUI_RUN_COMMAND_NAMES`
 *   4. submit-turn         — default user-message path
 *   undefined              — empty draft with no slash and no goal mode
 *
 * These tests pin the dispatch order (rule 1 beats rule 2 beats rule 3 beats
 * rule 4), the no-op capability (rules 1–3 do not fire when not satisfied),
 * and the error-cleanup shape (the resolver never sets `interactionError`,
 * `sending`, or `commandRunning` — that is the executor's job; the resolver's
 * job is to emit the right kind).
 */

const ICON: SlashCommandEntry["icon"] = () => createElement("span");

/**
 * The resolver reads only `name` and `supported`, but `SlashCommandEntry`
 * also declares the display fields the palette renders, so the fixtures
 * carry the full shape instead of a partial one.
 */
const commandEntry = (
  name: string,
  description: string,
  supported: boolean,
): SlashCommandEntry => ({
  name,
  displayName: name,
  label: name,
  description,
  source_type: -1,
  icon: ICON,
  supported,
});

const goalCommand = commandEntry("goal", "open the goal workflow", true);

// The fixture uses the UI entry shape accepted at the projection boundary.
type WebuiRunCommandEntry = Extract<WebuiSubmissionIntent, { readonly kind: "run-command" }>["command"];
const helpCommand: SlashCommandEntry & WebuiRunCommandEntry = {
  name: "help",
  displayName: "help",
  label: "help",
  description: "show help",
  source_type: -1,
  icon: ICON,
  supported: true,
};

const disabledCommand = commandEntry("compact", "compact the session", false);

const unknownCommand = commandEntry("totally-unknown", "outline only", true);

const runCommandArgs = (overrides: {
  draft?: string;
  commandMatch?: SlashCommandEntry;
  commandInvocationName?: string;
  commandInvocationInput?: string;
  goalMode?: boolean;
}) =>
  ({
    draft: "",
    commandMatch: undefined,
    goalMode: false,
    ...overrides,
  }) as const;

describe("isTurnLive", () => {
  it("is true only for streaming / waiting / reconnecting", () => {
    expect(isTurnLive("streaming")).toBe(true);
    expect(isTurnLive("waiting")).toBe(true);
    expect(isTurnLive("reconnecting")).toBe(true);
  });

  it("is false for idle / done / refused / error / undefined", () => {
    expect(isTurnLive("idle")).toBe(false);
    expect(isTurnLive("done")).toBe(false);
    expect(isTurnLive("refused")).toBe(false);
    expect(isTurnLive("error")).toBe(false);
    expect(isTurnLive(undefined)).toBe(false);
  });
});

describe("resolveWebuiSubmissionIntent — path 1: activate-goal-mode", () => {
  it("fires for bare `/goal` while not in goal mode", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        goalMode: false,
      }),
    );
    expect(intent).toEqual({ kind: "activate-goal-mode" });
  });

  it("does NOT fire once goal mode is on (rule 1 must not beat rule 2)", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        goalMode: true,
      }),
    );
    // Rule 1's precondition `!goalMode` is false → fall through to rule 2.
    // Rule 2's `(goalMode || directGoalObjective) && (trimmedDraft ||
    // directGoalObjective)` is true (goal mode is on, the trim of the draft
    // is "/goal"), so rule 2 fires with the raw "/goal" as objective. The
    // submit path then calls `submitWebuiGoal({ objective: "/goal", … })`,
    // which is the same shape as the original implementation.
    expect(intent).toEqual({ kind: "submit-goal", objective: "/goal" });
  });

  it("does NOT fire when `/goal` carries an objective (rule 2 wins)", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal ship the release",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        commandInvocationInput: "ship the release",
        goalMode: false,
      }),
    );
    expect(intent).toEqual({
      kind: "submit-goal",
      objective: "ship the release",
    });
  });
});

describe("resolveWebuiSubmissionIntent — path 2: submit-goal", () => {
  it("fires for explicit `/goal <objective>` even when goal mode is off", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal prepare onboarding doc",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        commandInvocationInput: "prepare onboarding doc",
        goalMode: false,
      }),
    );
    expect(intent).toEqual({
      kind: "submit-goal",
      objective: "prepare onboarding doc",
    });
  });

  it("fires for goal-mode composer carrying a draft", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "outline the spec",
        commandMatch: undefined,
        goalMode: true,
      }),
    );
    expect(intent).toEqual({
      kind: "submit-goal",
      objective: "outline the spec",
    });
  });

  it("trims leading/trailing whitespace from the objective", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "   ship the release   ",
        commandMatch: undefined,
        goalMode: true,
      }),
    );
    expect(intent).toEqual({
      kind: "submit-goal",
      objective: "ship the release",
    });
  });

  it("does NOT fire when goal-mode is on but draft is empty (falls through to submit-turn)", () => {
    // An empty submit while in goal mode is the "click send without typing"
    // case; the resolver must NOT misclassify that as submit-goal (an empty
    // objective would create a goal with empty body).
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "",
        commandMatch: undefined,
        goalMode: true,
      }),
    );
    expect(intent).toEqual({ kind: "submit-turn" });
  });
});

describe("resolveWebuiSubmissionIntent — path 3: run-command", () => {
  it("fires for `/help` with no input", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/help",
        commandMatch: helpCommand,
        commandInvocationName: "help",
      }),
    );
    expect(intent?.kind).toBe("run-command");
    if (intent?.kind === "run-command") {
      expect(intent.command.name).toBe("help");
      expect(intent.input).toBeUndefined();
    }
  });

  it("fires for a runnable command carrying input", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/help me",
        commandMatch: helpCommand,
        commandInvocationName: "help",
        commandInvocationInput: "me",
      }),
    );
    expect(intent).toEqual({
      kind: "run-command",
      command: helpCommand,
      input: "me",
    });
  });

  it("does NOT fire for a `supported: false` command (rule 3 must fall through to rule 4)", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/compact",
        commandMatch: disabledCommand,
        commandInvocationName: "compact",
      }),
    );
    expect(intent).toEqual({ kind: "submit-turn" });
  });

  it("does NOT fire for an unknown command name (rule 3 narrows on the registry, not on shape)", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/totally-unknown do thing",
        commandMatch: unknownCommand,
        commandInvocationName: "totally-unknown",
        commandInvocationInput: "do thing",
      }),
    );
    expect(intent).toEqual({ kind: "submit-turn" });
  });
});

describe("resolveWebuiSubmissionIntent — path 4: submit-turn (default)", () => {
  it("fires for a plain user message with no slash and no goal mode", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "summarise the diff",
      }),
    );
    expect(intent).toEqual({ kind: "submit-turn" });
  });

  it("fires for whitespace-only drafts (the executor trims and short-circuits empty submits)", () => {
    // The resolver never returns undefined for any well-typed input — the
    // executor decides whether the trimmed draft is empty. This keeps the
    // resolver testable without a "should I send?" boolean.
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "   ",
      }),
    );
    expect(intent).toEqual({ kind: "submit-turn" });
  });
});

describe("resolveWebuiSubmissionIntent — dispatch order (rule 1 > 2 > 3 > 4)", () => {
  it("rule 1 wins over rule 2 for bare `/goal`", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        goalMode: false,
      }),
    );
    expect(intent?.kind).toBe("activate-goal-mode");
  });

  it("rule 2 wins over rule 3 for a `/goal <objective>` form", () => {
    // The `/goal <objective>` form would otherwise be classified by rule 3
    // because `goal` *is* in WEBUI_RUN_COMMAND_NAMES and `supported: true`.
    // The dispatch order guarantees that rule 2 fires first.
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal ship the release",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        commandInvocationInput: "ship the release",
      }),
    );
    expect(intent?.kind).toBe("submit-goal");
  });

  it("rule 3 wins over rule 4 for `/help`", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/help",
        commandMatch: helpCommand,
        commandInvocationName: "help",
      }),
    );
    expect(intent?.kind).toBe("run-command");
  });
});

describe("resolveWebuiSubmissionIntent — no-op capability (resolver never sets UI state)", () => {
  it("the intent value set has no `sending` / `goalSubmitting` / `commandRunning` keys", () => {
    // The resolver returns intent objects only. State setters belong in the
    // executor; the resolver must never leak them. Pin the shape here.
    const cases: ReadonlyArray<{
      readonly args: Parameters<typeof resolveWebuiSubmissionIntent>[0];
      readonly expected: WebuiSubmissionIntent | undefined;
    }> = [
      {
        args: runCommandArgs({
          draft: "/goal",
          commandMatch: goalCommand,
          commandInvocationName: "goal",
        }),
        expected: { kind: "activate-goal-mode" },
      },
      {
        args: runCommandArgs({
          draft: "/help",
          commandMatch: helpCommand,
          commandInvocationName: "help",
        }),
        expected: { kind: "run-command", command: helpCommand },
      },
      {
        args: runCommandArgs({ draft: "hello" }),
        expected: { kind: "submit-turn" },
      },
    ];
    for (const test of cases) {
      const intent = resolveWebuiSubmissionIntent(test.args);
      expect(intent).toEqual(test.expected);
      const keys = intent ? Object.keys(intent) : [];
      expect(keys).not.toContain("sending");
      expect(keys).not.toContain("goalSubmitting");
      expect(keys).not.toContain("commandRunning");
      expect(keys).not.toContain("interactionError");
    }
  });
});

describe("resolveWebuiSubmissionIntent — disabled command inputs do not fill the next rule's preconditions", () => {
  it("a `supported: false` `/compact` falls through to submit-turn, NOT to submit-goal", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/compact",
        commandMatch: disabledCommand,
        commandInvocationName: "compact",
      }),
    );
    expect(intent).toEqual({ kind: "submit-turn" });
  });

  it("the same draft parsed as `/goal <empty>` fires rule 1 (whitespace-only input is treated as no objective)", () => {
    const intent = resolveWebuiSubmissionIntent(
      runCommandArgs({
        draft: "/goal",
        commandMatch: goalCommand,
        commandInvocationName: "goal",
        commandInvocationInput: "   ",
      }),
    );
    // The parser surfaces "   " as `commandInvocationInput`; trim makes it
    // empty, so `directGoalObjective` is "" (falsy). Rule 1's
    // `!directGoalObjective` is true → activate-goal-mode fires, matching
    // the original behaviour where `"/goal "` and `"/goal"` both flip the
    // textarea into goal mode.
    expect(intent).toEqual({ kind: "activate-goal-mode" });
  });
});

describe("Desktop composer interaction contracts", () => {
  it("keeps the @ query range at the caret and preserves the surrounding draft", () => {
    const value = "fix @plug tail";
    const range = findWebuiMentionRange(value, 9);
    expect(range).toEqual({ start: 4, end: 9, query: "plug" });
    expect(insertWebuiMention(value, range!, "@plugin-name")).toEqual({
      value: "fix @plugin-name  tail",
      caret: 17,
    });
    expect(findWebuiMentionRange("email@host", 10)).toBeUndefined();
  });

  it("opens the slash palette from any slash, not just the first character", () => {
    // The palette used to be anchored to the start of the draft, so only a
    // leading "/" opened it. `帮我 /pl` is 6 UTF-16 units, not 8.
    expect(findWebuiSlashRange("/pl", 3)).toEqual({ start: 0, end: 3, query: "pl" });
    expect(findWebuiSlashRange("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findWebuiSlashRange("帮我 /pl", 6)).toEqual({
      start: 3,
      end: 6,
      query: "pl",
    });
    // A second slash opens it too, once the caret moves into that token.
    expect(findWebuiSlashRange("/a /b", 5)).toEqual({ start: 3, end: 5, query: "b" });
  });

  it("keeps the slash palette closed where a slash is not a command", () => {
    // A `/` glued to another character belongs to a URL, not to a command.
    expect(findWebuiSlashRange("http://example.com", 18)).toBeUndefined();
    // Text after the token moves the caret out of it.
    expect(findWebuiSlashRange("/plan rest of it", 13)).toBeUndefined();
    expect(findWebuiSlashRange("/plan rest of it", 5)).toEqual({
      start: 0,
      end: 5,
      query: "plan",
    });
    // No slash at all.
    expect(findWebuiSlashRange("帮我看看", 4)).toBeUndefined();
    expect(findWebuiSlashRange("", 0)).toBeUndefined();
  });

  it("drops only the slash token when the palette is dismissed", () => {
    // Both the Escape key and the outside-pointerdown path cancel through this,
    // so a token in the middle of a sentence leaves the rest of the draft alone.
    const value = "帮我 /pl 谢谢";
    const range = findWebuiSlashRange(value, 6)!;
    expect(range).toEqual({ start: 3, end: 6, query: "pl" });
    expect(removeWebuiSlashToken(value, range)).toBe("帮我  谢谢");
    // The leading-token case still clears the whole draft, as before.
    expect(removeWebuiSlashToken("/plan", findWebuiSlashRange("/plan", 5)!)).toBe("");
  });

  it("keeps an earlier slash token when the second one is chosen", () => {
    // The reported bug: "/pptx /deep" + picking a skill from the second
    // token's palette used to rewrite the whole draft, so the "/pptx" the
    // user had already committed was wiped.
    const value = "/pptx /deep";
    const range = findWebuiSlashRange(value, 11)!;
    expect(range).toEqual({ start: 6, end: 11, query: "deep" });
    const result = replaceWebuiSlashToken(value, range, "/deep-research ");
    expect(result.value).toBe("/pptx /deep-research ");
    // The caret lands after the inserted text's trailing space, which is what
    // closes the palette again.
    expect(result.caret).toBe(result.value.length);
    expect(findWebuiSlashRange(result.value, result.caret)).toBeUndefined();
    // The leading-token case is unchanged: the draft *is* the token.
    expect(
      replaceWebuiSlashToken("/deep", findWebuiSlashRange("/deep", 5)!, "/deep-research "),
    ).toEqual({ value: "/deep-research ", caret: 15 });
  });

  it("round-trips a hand-seeded text attachment through the same data-URL shape a picked file uses", () => {
    const decode = (dataUrl: string): string => {
      expect(dataUrl.startsWith("data:text/markdown;base64,")).toBe(true);
      const bytes = Uint8Array.from(atob(dataUrl.slice("data:text/markdown;base64,".length)), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    };

    // The whole reason this helper exists: `btoa` throws above U+00FF, and the
    // one file it carries — MEMORY.md — is almost entirely Chinese. An ASCII
    // case would pass against a broken implementation.
    expect(decode(webuiTextAttachmentDataUrl("text/markdown", "记忆"))).toBe("记忆");
    expect(decode(webuiTextAttachmentDataUrl("text/markdown", ""))).toBe("");
    expect(decode(webuiTextAttachmentDataUrl("text/markdown", "a中b\n🙂"))).toBe("a中b\n🙂");
    // Past the 32KB chunk boundary the builder concatenates, so a body longer
    // than one chunk is where a chunking bug would show up.
    expect(decode(webuiTextAttachmentDataUrl("text/markdown", "x".repeat(0x8000 * 2 + 7)))).toHaveLength(0x8000 * 2 + 7);
  });

  it("applies attachment count and WebSocket payload caps before reading files", () => {    expect(webuiAttachmentLimitError(
      Array.from({ length: 10 }, () => ({ sizeBytes: 0 })),
      [{ sizeBytes: 1 }],
    )).toBe("最多添加 10 个文件");
    expect(webuiAttachmentLimitError(
      [{ sizeBytes: 70 * 1024 * 1024 }],
      [{ sizeBytes: 1 }],
    )).toBe("附件总大小不能超过 70 MB");
    expect(webuiAttachmentLimitError([], [{ sizeBytes: 1 }])).toBeUndefined();
  });

  it("forwards local attachment records through send and queue validators", () => {
    const attachment = {
      meta: { attachmentType: "image", fileName: "shot.png", mimeType: "image/png", sizeBytes: 4 },
      local: { dataUrl: "data:image/png;base64,YWJj" },
    };
    expect(sendMessageOperation.validate({ id: "session-1", attachments: [attachment] }).ok).toBe(true);
    expect(enqueueMessageOperation.validate({ id: "session-1", content: "", attachments: [attachment] }).ok).toBe(true);
    expect(sendMessageOperation.validate({ id: "session-1", attachments: [{ cloud: { url: "https://example.invalid" } }] }).ok).toBe(false);
    expect(sendMessageOperation.validate({
      id: "session-1",
      attachments: [{ meta: { sizeBytes: 70 * 1024 * 1024 + 1 }, local: { dataUrl: "data:image/png;base64,YWJj" } }],
    }).ok).toBe(false);
  });

  it("restricts the permission selector to the three Desktop modes", () => {
    for (const mode of ["default", "auto", "bypassPermissions"]) {
      expect(setPermissionModeOperation.validate({ mode }).ok).toBe(true);
    }
    expect(setPermissionModeOperation.validate({ mode: "off" }).ok).toBe(false);
  });
});

describe("deriveRecentWorkspaceDirs — the 最近 group in the workspace picker", () => {
  it("orders by most recently updated session", () => {
    expect(
      deriveRecentWorkspaceDirs([
        { workspaceDir: "/old", updatedAt: 10 },
        { workspaceDir: "/new", updatedAt: 30 },
        { workspaceDir: "/mid", updatedAt: 20 },
      ]),
    ).toEqual(["/new", "/mid", "/old"]);
  });

  it("collapses duplicate workspaces and keeps the newest one's rank", () => {
    expect(
      deriveRecentWorkspaceDirs([
        { workspaceDir: "/a", updatedAt: 50 },
        { workspaceDir: "/a", updatedAt: 90 },
        { workspaceDir: "/b", updatedAt: 40 },
      ]),
    ).toEqual(["/a", "/b"]);
  });

  it("skips sessions with no workspace — 不需要项目 covers those", () => {
    expect(
      deriveRecentWorkspaceDirs([
        { workspaceDir: undefined, updatedAt: 99 },
        { workspaceDir: "   ", updatedAt: 98 },
        { workspaceDir: "", updatedAt: 97 },
        { workspaceDir: "/real", updatedAt: 1 },
      ]),
    ).toEqual(["/real"]);
  });

  it("trims whitespace so a padded path matches its trimmed twin", () => {
    expect(
      deriveRecentWorkspaceDirs([
        { workspaceDir: "/a", updatedAt: 20 },
        { workspaceDir: "  /a  ", updatedAt: 10 },
      ]),
    ).toEqual(["/a"]);
  });

  it("treats a missing updatedAt as oldest rather than newest", () => {
    expect(
      deriveRecentWorkspaceDirs([
        { workspaceDir: "/undated" },
        { workspaceDir: "/dated", updatedAt: 5 },
      ]),
    ).toEqual(["/dated", "/undated"]);
  });

  it("caps the list at the limit, keeping the most recent", () => {
    expect(
      deriveRecentWorkspaceDirs(
        [
          { workspaceDir: "/a", updatedAt: 5 },
          { workspaceDir: "/b", updatedAt: 4 },
          { workspaceDir: "/c", updatedAt: 3 },
          { workspaceDir: "/d", updatedAt: 2 },
        ],
        2,
      ),
    ).toEqual(["/a", "/b"]);
  });

  it("returns an empty list when nothing has a workspace", () => {
    expect(deriveRecentWorkspaceDirs([])).toEqual([]);
    expect(deriveRecentWorkspaceDirs([{ updatedAt: 1 }])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const sessions = [
      { workspaceDir: "/a", updatedAt: 1 },
      { workspaceDir: "/b", updatedAt: 9 },
    ];
    deriveRecentWorkspaceDirs(sessions);
    expect(sessions.map((s) => s.workspaceDir)).toEqual(["/a", "/b"]);
  });
});

/**
 * Enter-to-send in the composer textarea.
 *
 *   resolveWebuiComposerEnterAction(key, gates) → "submit" | "newline"
 *
 * The taxonomy is two-valued on purpose: `newline` is the absence of an
 * action, and the component reads it as "do not preventDefault", so the
 * textarea keeps its own line break. Everything Enter could otherwise mean —
 * accepting an open mention, accepting an open slash command — is claimed by
 * earlier branches of the component's `onKeyDown`, which return before this
 * resolver is consulted.
 *
 * These tests pin the precedence the resolver documents: any modifier first,
 * then an open IME composition, then the submit gate. The IME case is the one
 * that is easy to regress silently and expensive when it does — a Chinese or
 * Japanese candidate window is confirmed with Enter, and submitting on that
 * keystroke would send a half-typed word.
 */
describe("resolveWebuiComposerEnterAction", () => {
  const enter = {
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    submitBlocked: false,
  };

  it("submits on a bare Enter when the draft can be sent", () => {
    expect(resolveWebuiComposerEnterAction(enter)).toBe("submit");
  });

  // Each modifier is checked on its own: a combined assertion would pass even
  // if the implementation tested only one of them.
  for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
    it(`keeps the newline for ${modifier}`, () => {
      expect(
        resolveWebuiComposerEnterAction({ ...enter, [modifier]: true }),
      ).toBe("newline");
    });
  }

  it("keeps the newline while an IME candidate window is open", () => {
    // Submitting here would discard the candidate the user is still choosing.
    expect(resolveWebuiComposerEnterAction({ ...enter, isComposing: true })).toBe(
      "newline",
    );
  });

  it("does not submit when the send button is blocked", () => {
    // The component feeds its `submitBlocked` — the button's own `disabled`
    // condition — in, so the keyboard cannot open a path the button refuses.
    expect(
      resolveWebuiComposerEnterAction({ ...enter, submitBlocked: true }),
    ).toBe("newline");
  });

  it("prefers composition over the submit gate and vice versa, both losing to modifiers", () => {
    // Modifier is the outermost guard: Shift+Enter stays a newline even when
    // a send is perfectly available.
    expect(
      resolveWebuiComposerEnterAction({
        ...enter,
        shiftKey: true,
        isComposing: false,
        submitBlocked: false,
      }),
    ).toBe("newline");
    // With no modifier, composing still wins over an otherwise sendable draft.
    expect(
      resolveWebuiComposerEnterAction({
        ...enter,
        shiftKey: false,
        isComposing: true,
        submitBlocked: false,
      }),
    ).toBe("newline");
  });

  it("only submits when no modifier is held, nothing is composing, and the gate is open", () => {
    expect(
      resolveWebuiComposerEnterAction({
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
        submitBlocked: false,
      }),
    ).toBe("submit");
  });
});
