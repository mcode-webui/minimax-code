import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  WebuiDiffCard,
  buildWebuiDiffMutationRequest,
  confirmWebuiDiffMutation,
  initialWebuiDiffState,
  reduceWebuiDiffState,
} from "../../src/client/components/DiffCard.js";
import { WebuiGoalBanner } from "../../src/client/components/GoalBanner.js";
import { WebuiInteractionPanel } from "../../src/client/components/InteractionPanel.js";
import { chunkWebuiWorkspaceReviewFileIds, projectWebuiUnifiedDiffLines, WebuiDiffFileSection } from "../../src/client/components/WorkspacePanels.js";
import {
  WebuiFeedbackActions,
  WebuiMessageActions,
  WebuiRewindDialog,
  copyWebuiMessageText,
  scheduleWebuiCopiedReset,
  toggleWebuiFeedback,
} from "../../src/client/components/MessageActions.js";
import { MessageItem } from "../../src/client/components/MessageItem.js";
import { PluginManagement } from "../../src/client/components/PluginManagement.js";
import {
  buildWebuiEditRequest,
  buildWebuiForkRequest,
  buildWebuiMessageForkRequest,
  buildWebuiRewindRequest,
} from "../../src/client/projection/action-requests.js";
import {
  buildWebuiGoalEditPatch,
  buildWebuiGoalStatusPatch,
  projectWebuiThreadGoalMessage,
  WEBUI_GOAL_STATUS_COPY,
} from "../../src/client/projection/goal-state.js";
import {
  canAdvanceWebuiQuestionnaireStep,
  sortWebuiQuestionnaireOptions,
  toggleWebuiQuestionnaireOption,
} from "../../src/client/projection/questionnaire-state.js";
import {
  computeThinkingPhraseStartDelay,
  DEFAULT_THINKING_PHRASE_ROTATION_INTERVAL_MS,
  pickWeightedPhrase,
  shouldPlayActivityIndicator,
  bucketPhrases,
  type ThinkingPhraseSet,
} from "../../src/client/components/ActivityIndicator.js";
import { initialWebuiStreamState, reduceWebuiStreamFrame } from "../../src/client/stream.js";
import {
  getSessionDiffOperation,
  getTurnDiffOperation,
  reapplyTurnDiffOperation,
  revertTurnDiffOperation,
} from "../../src/server/operation/operations.js";
import type { WebuiGoal } from "../../src/shared/contracts/goal.js";
import type { WebuiQuestionnaireRequest } from "../../src/shared/contracts/interactions.js";
import type { WebuiTurnDiffView } from "../../src/shared/contracts/session.js";
import { WebuiErrorCode } from "../../src/server/envelope.js";
import { pluginManagementOperation } from "../../src/server/operation/plugin-management.js";

const files = [
  { file: "one.ts", additions: 2, deletions: 1 },
  { file: "two.ts", additions: 3, deletions: 0 },
  { file: "three.ts", additions: 0, deletions: 4 },
  { file: "four.ts", additions: 8, deletions: 2 },
];

const activeView: WebuiTurnDiffView = {
  status: "active",
  changeSetId: "changes-1",
  sourceMessageId: "assistant-1",
  canUndo: true,
  canReapply: false,
  fileChanges: files,
};

const revertedView: WebuiTurnDiffView = {
  ...activeView,
  status: "reverted",
  canUndo: false,
  canReapply: true,
};

function invalid(result: unknown): void {
  expect(result).toMatchObject({ ok: false, code: WebuiErrorCode.invalidBody });
}

describe("round-3 authoritative diff state machine", () => {
  it("transitions active to reverted and back with the view-owned changeSetId", () => {
    let state = reduceWebuiDiffState(initialWebuiDiffState, { type: "loaded", view: activeView });
    const revert = buildWebuiDiffMutationRequest(state, { id: "session-1", assistantMessageId: "assistant-1" }, "revert");
    expect(revert).toEqual({ id: "session-1", assistantMessageId: "assistant-1", changeSetId: "changes-1" });
    state = reduceWebuiDiffState(state, { type: "mutation-succeeded", view: revertedView });
    expect(state.view?.status).toBe("reverted");
    const reapply = buildWebuiDiffMutationRequest(state, { id: "session-1", assistantMessageId: "assistant-1" }, "reapply");
    expect(reapply).toEqual({ id: "session-1", assistantMessageId: "assistant-1", changeSetId: "changes-1" });
    state = reduceWebuiDiffState(state, { type: "mutation-succeeded", view: activeView });
    expect(state.view?.status).toBe("active");
  });

  it("rejects unavailable actions, busy actions, and missing change sets", () => {
    const active = reduceWebuiDiffState(initialWebuiDiffState, { type: "loaded", view: activeView });
    expect(buildWebuiDiffMutationRequest(active, { id: "s" }, "reapply")).toBeUndefined();
    expect(buildWebuiDiffMutationRequest({ ...active, view: { ...activeView, canUndo: false } }, { id: "s" }, "revert")).toBeUndefined();
    expect(buildWebuiDiffMutationRequest({ ...active, busy: true }, { id: "s" }, "revert")).toBeUndefined();
    expect(buildWebuiDiffMutationRequest({ ...active, view: { ...activeView, changeSetId: undefined } }, { id: "s" }, "revert")).toBeUndefined();
  });

  it("keeps unsupported and confirmation-cancelled paths from becoming success", () => {
    const unsupported = reduceWebuiDiffState(initialWebuiDiffState, { type: "unsupported" });
    expect(unsupported.unsupported).toBe(true);
    expect(buildWebuiDiffMutationRequest(unsupported, { id: "s" }, "revert")).toBeUndefined();
    const before = reduceWebuiDiffState(initialWebuiDiffState, { type: "loaded", view: activeView });
    const cancelled = confirmWebuiDiffMutation(before, false);
    expect(cancelled).toEqual(before);
    expect(cancelled).toBe(before);
    expect(confirmWebuiDiffMutation(before, true).busy).toBe(true);
  });

  it("reduces busy, expanded, and review state independently", () => {
    let state = reduceWebuiDiffState(initialWebuiDiffState, { type: "loaded", view: activeView });
    state = reduceWebuiDiffState(state, { type: "begin-mutation" });
    expect(state.busy).toBe(true);
    expect(reduceWebuiDiffState(state, { type: "begin-mutation" })).toBe(state);
    state = reduceWebuiDiffState(state, { type: "mutation-succeeded", view: activeView });
    state = reduceWebuiDiffState(state, { type: "toggle-expanded" });
    state = reduceWebuiDiffState(state, { type: "toggle-review" });
    expect(state.expanded).toBe(true);
    expect(state.reviewing).toBe(true);
  });

  it("renders active/reverted metadata, file limit, review, and disabled controls", () => {
    const active = renderToStaticMarkup(createElement(WebuiDiffCard, {
      initialView: activeView,
      initialState: { expanded: false, reviewing: false },
    }));
    expect(active).toContain('data-webui-diff-state="active"');
    expect(active).toContain('data-testid="turn-diff-card"');
    expect(active).toContain('data-testid="turn-diff-summary"');
    expect(active).toContain('data-testid="turn-diff-file-icon"');
    expect(active).toContain('data-testid="turn-diff-undo"');
    expect(active).toContain('data-testid="turn-diff-review"');
    expect(active).toContain('data-testid="turn-diff-show-more"');
    expect(active).toContain('data-change-set-id="changes-1"');
    expect(active).toContain('data-source-message-id="assistant-1"');
    expect(active).toContain("展开其余 1 个");
    expect(active).toContain("撤销");
    expect(active).not.toContain("four.ts");

    const expandedReview = renderToStaticMarkup(createElement(WebuiDiffCard, {
      initialView: activeView,
      initialState: { expanded: true, reviewing: true },
    }));
    expect(expandedReview).toContain("four.ts");
    expect(expandedReview).toContain("关闭 Review");
    expect(expandedReview).toContain('data-webui-diff-review-panel="true"');

    const reverted = renderToStaticMarkup(createElement(WebuiDiffCard, {
      initialView: { ...revertedView, canReapply: false },
    }));
    expect(reverted).toContain('data-webui-diff-state="reverted"');
    expect(reverted).toContain("重新应用");
    expect(reverted).toContain("disabled");

    const neutral = renderToStaticMarkup(createElement(WebuiDiffCard, {
      initialState: { unsupported: true },
    }));
    expect(neutral).toContain('data-webui-diff-state="runtime-unsupported"');
    expect(neutral).not.toContain("已编辑");
  });
});

describe("turn review unified diff projection", () => {
  it("keeps hunk context and old/new line numbers for review rendering", () => {
    expect(projectWebuiUnifiedDiffLines([
      "diff --git a/src/example.ts b/src/example.ts",
      "index 123..456 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -4,2 +4,3 @@",
      " const ready = true;",
      "-return false;",
      "+return ready;",
      "+console.log(ready);",
    ].join("\n"))).toEqual([
      { kind: "hunk", content: "@@ -4,2 +4,3 @@" },
      { kind: "context", oldLine: 4, newLine: 4, content: "const ready = true;" },
      { kind: "deletion", oldLine: 5, content: "return false;" },
      { kind: "addition", newLine: 5, content: "return ready;" },
      { kind: "addition", newLine: 6, content: "console.log(ready);" },
    ]);
  });

  it("renders workspace review additions and deletions using the shared highlighted diff rows", () => {
    const markup = renderToStaticMarkup(createElement(WebuiDiffFileSection, {
      file: { file: "src/example.ts", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-return false;\n+return true;" },
      selected: true,
    }));

    expect(markup).toContain("webui-turn-review-line--deletion");
    expect(markup).toContain("webui-turn-review-line--addition");
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("hljs-keyword");
  });

  it("keeps workspace review diff requests within the runtime's five-file batch limit", () => {
    expect(chunkWebuiWorkspaceReviewFileIds(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"])).toEqual([
      ["a", "b", "c", "d", "e"],
      ["f", "g", "h", "i", "j"],
      ["k"],
    ]);
  });
});

describe("round-3 diff operation validators", () => {
  for (const [name, operation] of [
    ["getSessionDiff", getSessionDiffOperation],
    ["getTurnDiff", getTurnDiffOperation],
    ["revertTurnDiff", revertTurnDiffOperation],
    ["reapplyTurnDiff", reapplyTurnDiffOperation],
  ] as const) {
    it(`${name} rejects missing id and wrong optional types`, () => {
      invalid(operation.validate({}));
      invalid(operation.validate({ id: "s", changeSetId: 1 }));
      invalid(operation.validate({ id: "s", assistantMessageId: false }));
    });
  }
});

describe("round-3 message actions", () => {
  it("uses clipboard and execCommand fallback paths and exposes the copied state markup", async () => {
    const clipboard: string[] = [];
    expect(await copyWebuiMessageText("hello", { clipboard: { writeText: async (value) => { clipboard.push(value); } } })).toBe(true);
    expect(clipboard).toEqual(["hello"]);
    let fallbackCalls = 0;
    expect(await copyWebuiMessageText("fallback", { fallback: () => { fallbackCalls += 1; } })).toBe(true);
    expect(fallbackCalls).toBe(1);
    expect(await copyWebuiMessageText("missing", {})).toBe(false);
    const scheduled: number[] = [];
    let copied = true;
    let reset!: () => void;
    scheduleWebuiCopiedReset((value) => { copied = value; }, (callback, delayMs) => { reset = callback; scheduled.push(delayMs); });
    expect(scheduled).toEqual([1200]);
    expect(copied).toBe(true);
    reset();
    expect(copied).toBe(false);

    const html = renderToStaticMarkup(createElement(WebuiMessageActions, {
      role: "assistant",
      messageId: "assistant-1",
      copyText: "answer",
      actions: { fork: true },
      onFork: () => undefined,
    }));
    expect(html).toContain('data-testid="message-copy-button"');
    expect(html).toContain('data-testid="message-fork-button"');
    expect(html).toContain('data-testid="message-feedback-actions"');
  });

  it("builds rewind/edit/fork requests with cancel and empty-input boundaries", () => {
    expect(buildWebuiRewindRequest("s", "u", "r", true)).toEqual({ id: "s", userMessageId: "u", clientRequestId: "r", rewindTurnDiff: true });
    expect(buildWebuiEditRequest("s", "u", "e", "  trimmed text  ")).toEqual({ id: "s", userMessageId: "u", clientRequestId: "e", content: "trimmed text" });
    expect(buildWebuiEditRequest("s", "u", "e", "   ")).toBeUndefined();
    expect(buildWebuiForkRequest({ id: "s", assistantMessageId: "a", clientRequestId: "f", title: "  title ", useSuggestedTitle: false, createIsolatedWorktree: false })).toEqual({ id: "s", assistantMessageId: "a", clientRequestId: "f", title: "title", useSuggestedTitle: false, createIsolatedWorktree: false });
    expect(buildWebuiForkRequest({ id: "s", clientRequestId: "f", useSuggestedTitle: true, createIsolatedWorktree: false })).not.toHaveProperty("assistantMessageId");
    expect(buildWebuiMessageForkRequest("s", "assistant-1", "f", "")).toEqual({ id: "s", assistantMessageId: "assistant-1", clientRequestId: "f", useSuggestedTitle: true, createIsolatedWorktree: false });
  });

  it("toggles like/dislike and gates fork/rewind in SSR", () => {
    expect(toggleWebuiFeedback(undefined, "like")).toBe("like");
    expect(toggleWebuiFeedback("like", "like")).toBe("dislike");
    expect(toggleWebuiFeedback("dislike", "dislike")).toBe("like");
    const html = renderToStaticMarkup(createElement(WebuiMessageActions, {
      role: "user",
      messageId: "user-1",
      copyText: "user",
      actions: {},
    }));
    expect(html).not.toContain("message-rewind-button");
    expect(html).not.toContain("message-fork-button");
  });

  it("renders rewind preview for file and no-file cases", () => {
    const noFiles = renderToStaticMarkup(createElement(WebuiRewindDialog, {
      messageId: "user-1",
      loading: false,
      busy: false,
      preview: { turns: [{ turnId: "turn-1", files: [] }] },
      onClose: () => undefined,
      onConfirm: () => undefined,
    }));
    expect(noFiles).toContain("没有受影响的文件改动");
    expect(noFiles).not.toContain("rewind-confirm-with-files");
    const withFiles = renderToStaticMarkup(createElement(WebuiRewindDialog, {
      messageId: "user-1",
      loading: false,
      busy: false,
      preview: { turns: [{ turnId: "turn-1", files: [{ filePath: "a.ts", action: "modify", skipped: false }] }] },
      onClose: () => undefined,
      onConfirm: () => undefined,
    }));
    expect(withFiles).toContain("rewind-confirm-with-files");
    expect(withFiles).toContain("a.ts");
  });
});

function goal(status: WebuiGoal["status"], wait?: WebuiGoal["executionWait"]): WebuiGoal {
  return { goalId: "goal-1", sessionId: "session-1", objective: "ship it", status, createdAt: 1, updatedAt: 1, tokensUsed: 4, turnsUsed: 2, timeUsedSeconds: 9, tokenBudget: null, statusReason: null, executionWait: wait };
}

describe("round-3 goal and questionnaire behavior", () => {
  it("renders all goal states and wait reasons with the correct status copy", () => {
    for (const status of ["active", "paused", "blocked", "complete", "budget_limited", "usage_limited"] as const) {
      const html = renderToStaticMarkup(createElement(WebuiGoalBanner, { goal: goal(status), onEditGoal: () => undefined }));
      expect(html).toContain(`data-goal-status="${status}"`);
      expect(html).toContain(`>${WEBUI_GOAL_STATUS_COPY[status]}<`);
    }
    const waiting = renderToStaticMarkup(createElement(WebuiGoalBanner, { goal: goal("active", { reason: "permission", sinceMs: 1 }), onEditGoal: () => undefined }));
    expect(waiting).toContain("等待你确认权限");
  });

  it("validates goal edits, status actions, clear confirmation, and desktop actions", () => {
    expect(buildWebuiGoalEditPatch("  objective  ", "50K")).toEqual({ ok: true, patch: { objective: "objective", tokenBudget: 50000 } });
    expect(buildWebuiGoalEditPatch(" ", "50K")).toMatchObject({ ok: false });
    expect(buildWebuiGoalEditPatch("objective", "not-a-budget")).toMatchObject({ ok: false });
    expect(buildWebuiGoalStatusPatch("paused")).toEqual({ status: "paused" });
    const html = renderToStaticMarkup(createElement(WebuiGoalBanner, { goal: goal("active"), onEditGoal: () => undefined }));
    expect(html).toContain("thread-goal-banner-pause");
    expect(html).toContain("thread-goal-banner-clear");
    expect(html).toContain("thread-goal-banner-edit-button");
  });

  it("projects objective_updated, steering, and updated goal events into one user message", () => {
    const current = goal("active");
    for (const type of ["thread_goal.objective_updated", "thread_goal.objective_steering", "thread_goal.updated"]) {
      expect(projectWebuiThreadGoalMessage(type, current)).toMatchObject({ id: "thread-goal-goal-1", role: "user", isGoal: true, answer: "ship it" });
    }
    expect(projectWebuiThreadGoalMessage("thread_goal.cleared", current)).toBeUndefined();
  });

  it("enforces questionnaire required, selection-mode, recommended-order, Other, and answer rules", () => {
    const options = [{ id: "normal", label: "Normal" }, { id: "recommended", label: "Recommended", recommended: true }];
    expect(sortWebuiQuestionnaireOptions(options).map((item) => item.id)).toEqual(["recommended", "normal"]);
    expect(toggleWebuiQuestionnaireOption([], "a", false)).toEqual(["a"]);
    expect(toggleWebuiQuestionnaireOption(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleWebuiQuestionnaireOption(["a", "b"], "a", true)).toEqual(["b"]);
    const step = { id: "step", question: "Pick", selectionMode: 0, allowOther: true, otherPlaceholder: "Other", required: true } as const;
    expect(canAdvanceWebuiQuestionnaireStep(step, [], false, "")).toBe(false);
    expect(canAdvanceWebuiQuestionnaireStep(step, [], true, "  ")).toBe(false);
    expect(canAdvanceWebuiQuestionnaireStep(step, [], true, "custom")).toBe(true);
    expect(canAdvanceWebuiQuestionnaireStep(step, ["a"], false, "")).toBe(true);
  });

  it("renders questionnaire progress/countdown and permission/questionnaire cards", () => {
    const request: WebuiQuestionnaireRequest = {
      schemaVersion: 1,
      id: "q-1",
      title: "Choose",
      presentation: { replaceComposer: false, showProgress: true, allowBackNavigation: true },
      // `purpose: 1` (QuestionnairePurpose.Goal): the countdown renders only
      // inside the goal auto-reply window — the runtime's scheduler replies
      // only for goal questionnaires, so any other expiry would be a promise
      // nothing keeps.
      purpose: 1,
      expiresAt: Date.now() + 10_000,
      steps: [
        { id: "one", question: "One", selectionMode: 0, required: true, allowOther: false, otherPlaceholder: "" , options: [{ id: "a", label: "A" }] },
        { id: "two", question: "Two", selectionMode: 1, required: false, allowOther: true, otherPlaceholder: "Other", options: [{ id: "b", label: "B" }] },
      ],
    };
    const html = renderToStaticMarkup(createElement(WebuiInteractionPanel, {
      sessionId: "session-1",
      permissions: [{ requestId: "p-1", sessionId: "session-1", agentName: "main", toolName: "read", ruleContents: [], reason: "needs access", allowAlwaysSupported: true, createdAt: 1 }],
      questionnaire: request,
      onPermission: async () => undefined,
      onQuestionnaire: async () => undefined,
      onDismiss: async () => undefined,
    }));
    expect(html).toContain('data-testid="questionnaire-composer"');
    expect(html).toContain('data-testid="questionnaire-progress"');
    expect(html).toContain('data-testid="questionnaire-auto-reply-countdown"');
    expect(html).toContain('data-webui-permission-request="p-1"');
    expect(html).toContain('data-testid="questionnaire-next"');
  });
});

describe("round-3 phrase and reduced-motion behavior", () => {
  const phrases: ThinkingPhraseSet = { basic: ["basic"], specific: ["specific"], motion: ["motion"] };

  it("uses the 0.75/0.15/0.1 buckets with an injected RNG", () => {
    const buckets = bucketPhrases(phrases);
    const values: number[] = [];
    for (let index = 0; index < 1000; index += 1) values.push((index + 0.5) / 1000, 0.5);
    let cursor = 0;
    const counts = { basic: 0, specific: 0, motion: 0 };
    for (let index = 0; index < 1000; index += 1) {
      const selected = pickWeightedPhrase(buckets, null, () => values[cursor++] ?? 0);
      if (selected === "basic" || selected === "specific" || selected === "motion") counts[selected] += 1;
    }
    expect(counts).toEqual({ basic: 750, specific: 150, motion: 100 });
  });

  it("uses injectable timing for 2–3 second startup and 3.5 second rotation", () => {
    expect(computeThinkingPhraseStartDelay(2000, 3000, () => 0)).toBe(2000);
    expect(computeThinkingPhraseStartDelay(2000, 3000, () => 1)).toBe(3000);
    expect(DEFAULT_THINKING_PHRASE_ROTATION_INTERVAL_MS).toBe(3500);
  });

  it("disables animation for reduced motion while keeping the label path available", () => {
    expect(shouldPlayActivityIndicator(true)).toBe(false);
    expect(shouldPlayActivityIndicator(false)).toBe(true);
  });
});

describe("round-3 stream state and transcript render units", () => {
  const frame = (dataJson: string) => ({ dataJson });

  it("drives empty to running to completed and renders each unit", () => {
    let state = initialWebuiStreamState;
    expect(state.phase).toBe("idle");
    expect(renderToStaticMarkup(createElement(MessageItem, {
      view: {
        source: "live",
        messageId: "empty",
        role: "assistant",
        answers: [],
      },
    }))).toContain('data-testid="message-item"');

    state = reduceWebuiStreamFrame(state, frame('{"type":10}'));
    expect(state.phase).toBe("streaming");
    state = reduceWebuiStreamFrame(state, frame('{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"hello","thinking_content":"consider"}}'));
    expect(state.messages[0]?.answer).toBe("hello");
    expect(renderToStaticMarkup(createElement(MessageItem, {
      view: {
        source: "live",
        messageId: "m1",
        role: "assistant",
        thinking: "consider",
        answers: ["hello"],
        streaming: true,
        streamMessageId: "m1",
        messageRootId: "m1",
      },
    }))).toContain('data-testid="turn-process-disclosure"');

    state = reduceWebuiStreamFrame(state, frame("[DONE]"));
    expect(state.phase).toBe("done");
    expect(renderToStaticMarkup(createElement(MessageItem, {
      view: {
        source: "live",
        messageId: "m1",
        role: "assistant",
        answers: ["hello"],
        streaming: false,
        streamMessageId: "m1",
        messageRootId: "m1",
      },
    }))).toContain("hello");
  });

  it("renders Goal identity and Desktop-style visible process segments", () => {
    const goalMarkup = renderToStaticMarkup(createElement(MessageItem, {
      view: {
        source: "live",
        messageId: "goal-message",
        role: "user",
        userText: "你好",
        isGoal: true,
        streamMessageId: "goal-message",
      },
    }));
    expect(goalMarkup).toContain('data-webui-goal-label="true"');
    expect(goalMarkup).toContain(">Goal<");

    const assistantMarkup = renderToStaticMarkup(createElement(MessageItem, {
      view: {
        source: "live",
        messageId: "assistant-message",
        role: "assistant",
        thinking: "第一段思考",
        answers: ["答复"],
        processSegments: [
          { messageId: "segment-1", thinking: "第一段思考" },
          { messageId: "segment-2", thinking: "第二段思考", tools: [{ name: "read" }] },
        ],
        streamMessageId: "assistant-message",
        messageRootId: "assistant-message",
      },
    }));
    expect(assistantMarkup).toContain('data-testid="turn-process-detail"');
    expect(assistantMarkup).toContain("思考 1 次");
    expect(assistantMarkup).toContain("查看 1 个文件");
    expect(assistantMarkup).toContain("答复");
  });

  it("drives a session error to the error rendering boundary", () => {
    const state = reduceWebuiStreamFrame(initialWebuiStreamState, frame('{"type":"session.error","error":"upstream failed"}'));
    expect(state.phase).toBe("error");
    expect(state.refusal).toBe("upstream failed");
  });
});

describe("plugin management WebUI operation", () => {
  it("renders its entry surface and rejects actions outside the allowlist", () => {
    const markup = renderToStaticMarkup(
      createElement(PluginManagement, {
        transport: { pluginManagement: async () => ({ plugins: [] }) },
      }),
    );
    expect(markup).toContain('data-testid="plugin-management"');
    expect(markup).toContain("市场");
    expect(markup).toContain("管理");
    expect(
      pluginManagementOperation.validate({
        action: "listMarketplacePlugins",
        input: { source: 1, limit: 20 },
      }).ok,
    ).toBe(true);
    expect(
      pluginManagementOperation.validate({ action: "runShell", input: {} }).ok,
    ).toBe(false);
    expect(
      pluginManagementOperation.validate({
        action: "createMcpServer",
        input: [],
      }).ok,
    ).toBe(false);
    expect(
      pluginManagementOperation.validate({
        action: "createMcpServer",
        input: { name: "server", config: null },
      }).ok,
    ).toBe(false);
    expect(
      pluginManagementOperation.validate({
        action: "listMarketplacePlugins",
        input: { limit: "many" },
      }).ok,
    ).toBe(false);
    expect(
      pluginManagementOperation.validate({
        action: "previewGithubPlugin",
        input: { url: "" },
      }).ok,
    ).toBe(false);
  });
});
