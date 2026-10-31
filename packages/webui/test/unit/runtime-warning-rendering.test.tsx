// D-2 — a `runtime.warning` SystemEvent must read as a warning, not as wire JSON.
//
// The runtime emits hook failures (the lark plugin's SessionStart hook is the
// reported case) as an ordinary `MsgType.SystemEvent` whose `msg_content` is
// the JSON envelope `buildRuntimeWarningEvent` serializes
// (`agent-core/src/event-bridge/runtime-warning.ts`). The transcript used to
// project that string like any other assistant text, so the conversation
// showed `{"eventType":"runtime.warning","category":"system-message",…}` —
// machine data where a human sentence belongs.
//
// The wire contract is unchanged: eventType / message / source / category /
// code / pluginName / hookEvent still ship exactly as before. Only the WebUI
// display layer parses the envelope and renders its human fields. The TUI
// already renders this same event as a warning row
// (`packages/tui/src/tui/controller/projection/turn-hook-message-projection.ts`),
// so this is the WebUI catching up, not a new contract.
//
// Falsification: revert the `runtime_warning` early return in
// `projectMessageParts` and the projection assertions below go red — the
// envelope falls through to the text path and comes back as raw JSON.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiAssistantBody } from "../../src/client/features/transcript/ui/AssistantBody.js";
import {
  describeRuntimeWarning,
  parseRuntimeWarningEventMessage,
} from "../../src/client/features/transcript/projection/message-parts.js";
import { projectWebuiMessage } from "../../src/client/features/transcript/projection/message-projection.js";
import { projectWebuiProcessSegments } from "../../src/client/features/transcript/projection/transcript-projection.js";
import type {
  WebuiClientMessage,
} from "../../src/client/features/transcript/contracts/message-view.js";
import type {
  WebuiRuntimeWarningView,
  WebuiTranscriptItem,
} from "../../src/client/features/transcript/contracts/transcript-view.js";

/** The lark SessionStart failure exactly as `buildRuntimeWarningEvent`
 *  serializes it: `JSON.stringify` over `{ eventType, message, source,
 *  category, hookEvent, code, pluginName }`, optional fields in the
 *  producer's spread order. The message text is the real
 *  `diagnosticWarningMessage` output for a HOOK_TIMEOUT on a non-tool event
 *  (`local-turn-plugin-hooks.ts`). */
function larkHookWarningEnvelope(): string {
  return JSON.stringify({
    eventType: "runtime.warning",
    message:
      'Plugin "lark" Hook could not complete and was skipped during SessionStart. The conversation continued without this Hook.',
    source: "plugin-hook",
    category: "system-message",
    hookEvent: "SessionStart",
    code: "HOOK_TIMEOUT",
    pluginName: "lark",
  });
}

const LARK_WARNING_MESSAGE =
  'Plugin "lark" Hook could not complete and was skipped during SessionStart. The conversation continued without this Hook.';

/** The activity variant narrowed to the warning row. Spelled as a structural
 *  interface rather than `Extract<…>`: the variant's `activityType` is the
 *  full union, so an `Extract` on the literal resolves to `never`. */
interface RuntimeWarningItem {
  readonly kind: "activity";
  readonly activityType: "runtime_warning";
  readonly messageId: string;
  readonly turnId?: string;
  readonly text?: string;
  readonly warning?: WebuiRuntimeWarningView;
  readonly timestamp?: number;
}

function warningItems(
  items: readonly WebuiTranscriptItem[],
): readonly RuntimeWarningItem[] {
  return items.filter(
    (item): item is RuntimeWarningItem =>
      "activityType" in item && item.activityType === "runtime_warning",
  );
}

describe("runtime.warning envelope projection", () => {
  it("projects the envelope into a warning row whose text is the reason, not the JSON", () => {
    const envelope = larkHookWarningEnvelope();
    const items = projectWebuiMessage({
      msgId: "evt-1",
      turnId: "turn-1",
      timestamp: 1_700_000_000_000,
      msgContent: envelope,
    } satisfies WebuiClientMessage);

    const warnings = warningItems(items);
    expect(warnings).toHaveLength(1);

    // The assertion this whole test exists for. The body is the producer's
    // human reason, and it is NOT the wire envelope: with the projection
    // early return reverted, the envelope falls through to the text path,
    // the item becomes an assistant message, and `text` is the raw JSON —
    // both of these lines go red.
    expect(warnings[0]!.text).toBe(LARK_WARNING_MESSAGE);
    expect(warnings[0]!.text).not.toBe(envelope);
    expect(warnings[0]!.text).not.toContain("eventType");

    // The structured fields ride along so the renderer never re-parses JSON.
    expect(warnings[0]!.warning).toEqual({
      message: LARK_WARNING_MESSAGE,
      source: "plugin-hook",
      category: "system-message",
      hookEvent: "SessionStart",
      code: "HOOK_TIMEOUT",
      pluginName: "lark",
    });
  });

  it("parses a reordered or re-spaced envelope just the same", () => {
    // The producer's JSON.stringify format (field order, spacing) is an
    // implementation detail. The original detection hard-coded it as a
    // `{"eventType":` prefix and would fail silently the day the producer
    // reformatted — the raw JSON would come back with no error anywhere.
    // Detection now parses any {…} content and reads the parsed eventType.
    const envelope = JSON.stringify(
      {
        source: "plugin-hook",
        category: "system-message",
        message: LARK_WARNING_MESSAGE,
        eventType: "runtime.warning",
      },
      null,
      2,
    );
    const parsed = parseRuntimeWarningEventMessage({ msgId: "evt-6", msgContent: envelope });
    expect(parsed?.message).toBe(LARK_WARNING_MESSAGE);
    expect(parsed?.category).toBe("system-message");
    expect(parsed?.source).toBe("plugin-hook");
  });

  it("keeps Desktop parts when the message carries them alongside envelope-looking content", () => {
    // The claim sits on the msgContent path, after the parts branch has
    // returned: a message with structured parts keeps its parts even when
    // its msgContent also looks like an envelope (the original PR claimed
    // before the parts branch and would have swallowed them).
    const items = projectWebuiMessage({
      msgId: "evt-7",
      msgContent: larkHookWarningEnvelope(),
      parts: [{ type: "text", id: "p1", content: "结构化正文" }],
    } satisfies WebuiClientMessage);
    expect(warningItems(items)).toHaveLength(0);
    expect(items).toEqual([
      expect.objectContaining({ kind: "assistant", text: "结构化正文" }),
    ]);
  });

  it("keeps the allowlisted terminalSequence out of the browser surface", () => {
    const envelope = JSON.stringify({
      eventType: "runtime.warning",
      message: "Plugin \"lark\" asked the terminal to repaint.",
      source: "plugin-hook",
      category: "runtime-message",
      // Only a live TUI surface may execute these bytes; a browser must
      // never carry them, render them, or act on them.
      terminalSequence: "\u001b[2J\u001b[H",
    });
    const parsed = parseRuntimeWarningEventMessage({ msgId: "evt-2", msgContent: envelope });
    expect(parsed?.message).toBe('Plugin "lark" asked the terminal to repaint.');
    expect(parsed).not.toHaveProperty("terminalSequence");
  });

  it("leaves a warning with no human reason to the ordinary path instead of inventing one", () => {
    // An empty message means the producer had nothing to say; rendering an
    // empty warning row would be decoration, so the envelope is not claimed
    // and the existing text path keeps its current behaviour.
    expect(
      parseRuntimeWarningEventMessage({
        msgId: "evt-3",
        msgContent: JSON.stringify({ eventType: "runtime.warning", message: "   ", source: "plugin-hook" }),
      }),
    ).toBeUndefined();
    // Malformed JSON is likewise left alone rather than half-parsed.
    expect(
      parseRuntimeWarningEventMessage({ msgId: "evt-4", msgContent: '{"eventType":"runtime.warning","mess' }),
    ).toBeUndefined();
  });

  it("composes the row labels from the category and the provenance", () => {
    const labels = describeRuntimeWarning({
      message: LARK_WARNING_MESSAGE,
      category: "system-message",
      pluginName: "lark",
      hookEvent: "SessionStart",
    });
    // 类别 in the title, 插件 + hook 事件 as the provenance line, reason verbatim.
    expect(labels.title).toBe("运行时告警 · system-message");
    expect(labels.meta).toBe("lark · SessionStart");
    expect(labels.body).toBe(LARK_WARNING_MESSAGE);

    // A category-less warning still gets a readable title and no meta line.
    const bare = describeRuntimeWarning({ message: "Something needs attention." });
    expect(bare.title).toBe("运行时告警");
    expect(bare.meta).toBeUndefined();
  });

  it("feeds the render pipeline as a process segment, not as assistant prose", () => {
    const items = projectWebuiMessage({
      msgId: "evt-5",
      turnId: "turn-1",
      timestamp: 1_700_000_000_000,
      msgContent: larkHookWarningEnvelope(),
    } satisfies WebuiClientMessage);
    const segments = projectWebuiProcessSegments(items);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.activityParts).toEqual([
      {
        type: "runtime_warning",
        title: "运行时告警 · system-message",
        meta: "lark · SessionStart",
        text: LARK_WARNING_MESSAGE,
      },
    ]);
  });

  it("does not claim ordinary messages or the todo_updated envelope", () => {
    // Regression guards for the two paths that share this seam: an ordinary
    // assistant message still projects as assistant prose, and the
    // todo_updated envelope is still omitted entirely (workspace progress
    // owns it) rather than becoming a warning.
    const plain = projectWebuiMessage({
      msgId: "msg-1",
      role: "assistant",
      msgContent: "A runtime.warning would look like JSON, and this is not one.",
    } satisfies WebuiClientMessage);
    expect(warningItems(plain)).toHaveLength(0);
    expect(plain).toEqual([
      expect.objectContaining({ kind: "assistant", text: "A runtime.warning would look like JSON, and this is not one." }),
    ]);

    const todo = projectWebuiMessage({
      msgId: "msg-2",
      msgContent: JSON.stringify({ eventType: "todo_updated", todos: [] }),
    } satisfies WebuiClientMessage);
    expect(todo).toEqual([]);
  });
});

describe("runtime.warning rendering", () => {
  it("renders the warning row with its reason and without any JSON", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiAssistantBody, {
        messageId: "evt-1",
        answers: [],
        processSegments: [
          {
            messageId: "evt-1",
            activityParts: [
              {
                type: "runtime_warning",
                title: "运行时告警 · system-message",
                meta: "lark · SessionStart",
                text: LARK_WARNING_MESSAGE,
              },
            ],
          },
        ],
      }),
    );

    // What the reader sees: the title with its category, the provenance
    // line, and the reason. (React escapes the reason's double quotes as
    // `&quot;`; match a quote-free span so the assertion pins the text, not
    // the escaping.)
    expect(html).toContain("运行时告警 · system-message");
    expect(html).toContain("lark · SessionStart");
    expect(html).toContain("Hook could not complete and was skipped during SessionStart.");
    // What the reader must NOT see: any trace of the envelope.
    expect(html).not.toContain("eventType");
    expect(html).not.toContain("runtime.warning");
    expect(html).not.toContain("HOOK_TIMEOUT");
    expect(html).not.toContain("plugin-hook");

    // A warning is never delivered collapsed: a turn whose only activity is
    // the warning renders its detail container expanded (React serializes
    // `hidden={false}` as no attribute at all), so the row is read rather
    // than toggled open. Checked on the opening tag alone — `aria-hidden`
    // elsewhere in the row also contains "hidden".
    const detailOpenTag = html.slice(
      html.indexOf('data-testid="turn-process-detail"'),
      html.indexOf(">", html.indexOf('data-testid="turn-process-detail"')),
    );
    expect(detailOpenTag).not.toContain("hidden");
  });
});
