import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isSafeWebuiMarkdownHref,
  WebuiMarkdown,
} from "../../src/client/markdown.js";
import {
  applyFrameCursor,
  applyFrameData,
  initialWebuiStreamState,
  reduceWebuiStreamFrame,
  recogniseWebuiStreamPayload,
  webuiSessionStatusType,
} from "../../src/client/projection/stream-state.js";
import { __webuiProbeReduce } from "../../src/client/mechanisms/stream-instrumentation.js";

const frame = (dataJson: string) => ({ dataJson });

describe("session stream recovery status", () => {
  it("recognizes the numeric SessionStatusInfoView started status", () => {
    expect(webuiSessionStatusType({ statusType: 1 })).toBe("started");
  });
});

describe("WebUI mixed stream reducer", () => {
  it("retains Desktop ordered activity parts from the live wire envelope", () => {
    const state = reduceWebuiStreamFrame(initialWebuiStreamState, frame(JSON.stringify({
      type: "agent_message",
      agent_message: {
        msg_id: "activity-1",
        msg_content: "Done",
        parts: [
          { id: "think", type: "thinking", content: "Reasoning" },
          { id: "delegate", type: "delegation", message: { fromAgent: "main", toAgent: "child" } },
          null,
        ],
      },
    })));
    expect(state.messages[0]?.parts).toEqual([
      { id: "think", type: "thinking", content: "Reasoning" },
      { id: "delegate", type: "delegation", message: { fromAgent: "main", toAgent: "child" } },
    ]);
  });

  it("keeps open, whole messages, chunks, thinking, actions, status and done distinct", () => {
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame('{"type":10}'),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"answer","thinking_content":"thought"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":" more","thinking_content":" +"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"answer more","thinking_content":"thought +"}}',
      ),
    );
    state = reduceWebuiStreamFrame(state, {
      messageActionDeltas: [{ action: "open" }],
    });
    state = reduceWebuiStreamFrame(
      state,
      frame('{"type":"session_status","session_status":{"type":"finished"}}'),
    );
    expect(state.messages).toEqual([
      { id: "m1", answer: "answer more", thinking: "thought +" },
    ]);
    expect(state.actionDeltas).toEqual([{ action: "open" }]);
    expect(state.status).toBe("finished");
    expect(state.phase).toBe("streaming");
    state = reduceWebuiStreamFrame(state, frame("[DONE]"));
    expect(state.phase).toBe("done");
  });

  it("projects Desktop-compatible Todo and Subagent events into session state", () => {
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(JSON.stringify({
        type: "todo_updated",
        todos: [
          { content: "完成面板", status: "completed", priority: "high" },
          { content: "验证交互", status: "in_progress", priority: "medium" },
        ],
      })),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(JSON.stringify({
        type: "generic",
        generic: {
          eventType: "session.spawned",
          data: {
            sessionId: "child-1",
            agentName: "goal-verification",
            title: "Goal verification",
            parentSessionId: "parent-1",
          },
        },
      })),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(JSON.stringify({
        type: "generic",
        generic: {
          eventType: "session.status_updated",
          data: { sessionId: "child-1", status: "completed" },
        },
      })),
    );
    expect(state.workspaceProgress.todos).toEqual([
      { content: "完成面板", status: "completed", priority: "high" },
      { content: "验证交互", status: "in_progress", priority: "medium" },
    ]);
    expect(state.workspaceProgress.subagents).toEqual([
      {
        sessionId: "child-1",
        agentName: "goal-verification",
        title: "Goal verification",
        status: "completed",
        parentSessionId: "parent-1",
      },
    ]);
  });

  it("takes progress from a batched frame's nested messages, not its outer envelope", () => {
    // A batched frame is owned by its `messages[]` entries: the transcript
    // upsert replaces the outer message with the nested ones instead of
    // merging both, so the progress fold has to pick the same source.
    //
    // The outer envelope therefore carries a `session.spawned` for
    // `child-outer` that the nested entries never mention, and it must
    // vanish. The subagent assertion is what pins the rule: a todo snapshot
    // cannot witness it, because the nested `todo_updated` always overwrites
    // the list whatever order the two run in.
    const event = (value: Record<string, unknown>) => JSON.stringify(value);
    const state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(JSON.stringify({
        type: 2,
        agent_message: {
          msg_id: "batch-1",
          msg_content: event({
            eventType: "session.spawned",
            sessionId: "child-outer",
            agentName: "outer-only-agent",
            status: "running",
          }),
          messages: [
            {
              id: "batch-1",
              msg_content: event({
                eventType: "todo_updated",
                todos: [{ content: "nested-first", status: "in_progress", priority: "medium" }],
              }),
            },
            {
              id: "batch-1",
              msg_content: event({
                eventType: "todo_updated",
                todos: [{ content: "nested-last", status: "completed", priority: "high" }],
              }),
            },
            {
              id: "batch-1",
              msg_content: event({
                eventType: "session.spawned",
                sessionId: "child-batch",
                agentName: "goal-runner",
                // Pinned so the assertion does not depend on the status
                // fallthrough for an event that carries no status at all.
                status: "running",
              }),
            },
          ],
        },
      })),
    );
    // Last nested entry wins, so a fold that stopped at the first one fails.
    expect(state.workspaceProgress.todos).toEqual([
      { content: "nested-last", status: "completed", priority: "high" },
    ]);
    // And the outer envelope contributes nothing at all.
    expect(state.workspaceProgress.subagents).toEqual([
      {
        sessionId: "child-batch",
        agentName: "goal-runner",
        status: "running",
      },
    ]);
  });

  it("keeps committed tool calls and their results in the live transcript", () => {
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        JSON.stringify({
          type: 2,
          agent_message: {
            msg_id: "browser-turn",
            msg_content: "The browser task is",
          },
        }),
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        JSON.stringify({
          type: 2,
          agent_message: {
            msg_id: "browser-turn",
            msg_content: "The browser task is",
            tool_calls: [
              {
                tool_name: "browser_inspect",
                tool_call_id: "call-1",
                tool_call_status: 2,
                tool_call_result_data: "browser result",
              },
            ],
          },
        }),
      ),
    );
    expect(state.messages).toEqual([
      {
        id: "browser-turn",
        answer: "The browser task is",
        thinking: "",
        toolCalls: [
          {
            tool_name: "browser_inspect",
            tool_call_id: "call-1",
            tool_call_status: 2,
            tool_call_result_data: "browser result",
          },
        ],
      },
    ]);
  });

  it("updates a chunk's message by identity rather than by position", () => {
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        '{"type":2,"agent_message":{"msg_id":"first","msg_content":"one"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"second","msg_content":"two"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":6,"agent_message_chunk":{"msg_id":"first","msg_content":" updated"}}',
      ),
    );
    expect(state.messages).toEqual([
      { id: "first", answer: "one updated", thinking: "" },
      { id: "second", answer: "two", thinking: "" },
    ]);
  });

  it("preserves earlier messages when successive whole-message frames arrive", () => {
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        '{"type":2,"agent_message":{"messages":[{"msg_id":"first","msg_content":"one","thinking_content":"first thought"}]}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"messages":[{"msg_id":"second","msg_content":"two","thinking_content":"second thought"}]}}',
      ),
    );
    expect(state.messages).toEqual([
      { id: "first", answer: "one", thinking: "first thought" },
      { id: "second", answer: "two", thinking: "second thought" },
    ]);
  });

  it("keeps accumulated thinking when a later whole-message frame omits it", () => {
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        '{"type":2,"agent_message":{"msg_id":"thinking-message","msg_content":"answer","thinking_content":"first thought"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"thinking-message","msg_content":"answer"}}',
      ),
    );
    expect(state.messages).toEqual([
      { id: "thinking-message", answer: "answer", thinking: "first thought" },
    ]);
  });

  it("appends a chunk's thinking to the accumulated thinking of the same message", () => {
    // Red-first fixture: the previous "keeps accumulated thinking"
    // test passed under the mutation `messages[index]!.thinking +
    // thinking → thinking` because it only fed whole-message frames,
    // which take the `!chunk` branch. This fixture feeds a chunk and
    // never lets a later whole-message frame re-supply the same text,
    // so the mutation cannot hide behind it.
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        '{"type":2,"agent_message":{"msg_id":"thinking-message","msg_content":"answer","thinking_content":"first thought"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":6,"agent_message_chunk":{"msg_id":"thinking-message","msg_content":" more","thinking_content":" plus"}}',
      ),
    );
    expect(state.messages).toEqual([
      {
        id: "thinking-message",
        answer: "answer more",
        thinking: "first thought plus",
      },
    ]);
  });

  it("does not throw on malformed or unknown data", () => {
    expect(() =>
      reduceWebuiStreamFrame(initialWebuiStreamState, frame("{")),
    ).not.toThrow();
    expect(
      reduceWebuiStreamFrame(
        initialWebuiStreamState,
        frame('{"type":"future","value":1}'),
      ).runtimeEvents,
    ).toHaveLength(1);
  });

  it("advances the cursor only on cursor-bearing frames (whole-group discipline)", () => {
    // The cursor rides only on the last mapped frame of a source-frame
    // group. The reducer must therefore only advance the cursor when the
    // frame carries one — never per frame, never on a middle-of-group frame
    // — so a resume never lands mid-group. A "per-frame" mutation that
    // records every frame's cursor (or worse, applies the cursor before
    // the rest of the group's frames are applied) would advance the cursor
    // before the group has finished being applied; this fixture asserts
    // the cursor is held back until a cursor-bearing frame actually
    // arrives.
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame('{"type":10}'),
    );
    expect(state.cursor).toBeUndefined();
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"partial"}}',
      ),
    );
    expect(state.cursor).toBeUndefined();
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":" more"}}',
      ),
    );
    expect(state.cursor).toBeUndefined();
    state = reduceWebuiStreamFrame(state, {
      dataJson:
        '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"whole"}}',
      cursor: "c1",
    });
    expect(state.cursor).toBe("c1");
    // A subsequent frame without a cursor leaves the cursor untouched.
    state = reduceWebuiStreamFrame(
      state,
      frame('{"type":"session_status","session_status":{"type":"finished"}}'),
    );
    expect(state.cursor).toBe("c1");
    // The next cursor-bearing frame advances again.
    state = reduceWebuiStreamFrame(state, {
      dataJson: "[DONE]",
      cursor: "c2",
    });
    expect(state.cursor).toBe("c2");
  });

  it("does not duplicate a message the reducer has already seen when a resumed stream re-sends it", () => {
    // Identity rule: whole-message frames carry `msg_id`. A resumed stream
    // may legitimately replay the last fully-applied message; the reducer
    // must upsert on `msg_id`, never append. This is the dedup contract a
    // resume relies on.
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        '{"type":2,"agent_message":{"msg_id":"turn-1","msg_content":"first answer","thinking_content":"first thought"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"turn-2","msg_content":"second answer","thinking_content":"second thought"}}',
      ),
    );
    expect(state.messages.map((message) => message.id)).toEqual([
      "turn-1",
      "turn-2",
    ]);
    // Resume replay: the server re-sends the last whole-message frame and
    // a new one. The replay must not produce a second `turn-2`.
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"turn-2","msg_content":"second answer","thinking_content":"second thought"}}',
      ),
    );
    state = reduceWebuiStreamFrame(
      state,
      frame(
        '{"type":2,"agent_message":{"msg_id":"turn-3","msg_content":"third answer","thinking_content":"third thought"}}',
      ),
    );
    expect(state.messages.map((message) => message.id)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
    expect(state.messages[1]?.answer).toBe("second answer");
  });

  it("records the cursor only after the frame's data change is applied", () => {
    // Cursor discipline, instrumentation-boundary edition: the
    // ordering between the data step and the cursor step is not
    // externally observable from the reducer's return value — the
    // two steps apply disjoint fields, so a reducer that swapped
    // them produces the same final state. The only way to catch a
    // swap is to observe the intermediate snapshots the reducer
    // commits while it runs, which is what the test-only probe in
    // `stream-instrumentation.ts` does. The probe is the explicit,
    // documented mechanism for verifying the cursor-ordering
    // invariant; it lives in a separate module so production code
    // cannot reach it without an obvious import. The brief that
    // introduced this ticket accepts this trade-off explicitly: the
    // public boundary cannot observe the ordering, and the
    // instrumentation is isolated so it cannot be mistaken for
    // production API.
    const frame = {
      dataJson:
        '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"hello","thinking_content":"thought"}}',
      cursor: "c1",
      messageActionDeltas: [{ action: "fork" }],
    };
    // Public-surface observation: the data step alone does not
    // advance the cursor, and the cursor step alone records it.
    const afterData = applyFrameData(initialWebuiStreamState, frame);
    expect(afterData.cursor).toBeUndefined();
    expect(afterData.messages).toHaveLength(1);
    expect(afterData.actionDeltas).toHaveLength(1);
    const afterCursor = applyFrameCursor(afterData, frame);
    expect(afterCursor.cursor).toBe("c1");
    // Public-surface regression: the reducer still equals the
    // documented composition.
    expect(reduceWebuiStreamFrame(initialWebuiStreamState, frame)).toEqual(
      afterCursor,
    );
    // Instrumentation-boundary observation: the probe fires after the
    // data step (cursor still undefined) and after the cursor step
    // (cursor advanced). A buggy reducer that committed the cursor
    // before the data step would emit `c1` already at the
    // `after-data` probe call, and the assertion below would fail.
    const probes: { checkpoint: string; cursor?: string; messages: number }[] = [];
    __webuiProbeReduce(reduceWebuiStreamFrame, initialWebuiStreamState, frame, (snapshot, checkpoint) => {
      probes.push({
        checkpoint,
        cursor: snapshot.cursor,
        messages: snapshot.messages.length,
      });
    });
    expect(probes).toEqual([
      { checkpoint: "after-data", cursor: undefined, messages: 1 },
      { checkpoint: "after-cursor", cursor: "c1", messages: 1 },
    ]);
  });

  it("flips to reconnecting and sets resumeRequired when the server emits resume_overflow", () => {
    // The harness maps a `resync-required` source frame to
    // `{type:"resume_overflow"}` on the way out (see
    // `session-stream-delivery.ts:116`). The WebUI client must recognise
    // this signal and surface a `reconnecting` phase the shell can render
    // as visible state, and a `resumeRequired` flag the shell reads to
    // reload authoritative history and establish a new subscription. The
    // previous behaviour fell through into the generic runtime-event
    // branch and silently swallowed the signal.
    let state = reduceWebuiStreamFrame(
      initialWebuiStreamState,
      frame(
        '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"partial"}}',
      ),
    );
    state = reduceWebuiStreamFrame(state, {
      dataJson: '{"type":"resume_overflow"}',
      cursor: "c-overflow",
    });
    expect(state.phase).toBe("reconnecting");
    expect(state.resumeRequired).toBe(true);
    // The cursor that came with the resume_overflow frame is recorded so a
    // reload can establish a fresh subscription immediately after
    // `getMessages` resolves.
    expect(state.cursor).toBe("c-overflow");
  });
});

describe("WebUI Markdown", () => {
  it("allows web, mail and relative links but renders unsafe schemes as text", () => {
    expect(isSafeWebuiMarkdownHref("https://example.com")).toBe(true);
    expect(isSafeWebuiMarkdownHref("http://example.com")).toBe(true);
    expect(isSafeWebuiMarkdownHref("mailto:user@example.com")).toBe(true);
    expect(isSafeWebuiMarkdownHref("/docs")).toBe(true);
    expect(isSafeWebuiMarkdownHref("../docs")).toBe(true);
    expect(isSafeWebuiMarkdownHref("#section")).toBe(true);
    expect(isSafeWebuiMarkdownHref("javascript:alert(1)")).toBe(false);
    expect(isSafeWebuiMarkdownHref("data:text/html,bad")).toBe(false);
    expect(isSafeWebuiMarkdownHref("//evil.example")).toBe(false);
  });

  it("renders fenced code through the block branch — language, container, pre", () => {
    // Real newlines, not the two-character sequence `\n`. The previous
    // fixture used `"\\n"` so marked saw a paragraph with an inline
    // codespan, not a code fence — the assertion `<code` therefore did
    // not distinguish block rendering from inline rendering, and a
    // mutation that drops the block branch would survive the suite.
    // With real newlines marked emits a `code` token whose `lang` is the
    // fence language and whose `text` is the body; the implementation
    // wraps it in `webui-code-block` with a `data-language` attribute
    // and a `<pre>` shell, and that is what the assertions check.
    const html = renderToStaticMarkup(
      createElement(WebuiMarkdown, { source: "```js\nconst a = 1\n```" }),
    );
    expect(html).toContain("webui-code-block");
    expect(html).toContain('data-language="js"');
    expect(html).toContain("<pre");
    // Tag-stripped, because a registered language is now syntax-highlighted
    // (SPEC-C C-1) and the text arrives wrapped in `hljs-*` spans. The claim
    // under test is that the code text survives rendering intact, not that it
    // survives as one unbroken run of characters in the serialised HTML — the
    // two are different claims, and only the first is true of a highlighter.
    expect(html.replace(/<[^>]*>/g, "")).toContain("const a = 1");
    expect(html).not.toContain("dangerously");
  });

  it("renders a partial fence through the block branch without throwing", () => {
    // An incomplete fence is still a `code` token in marked (it cannot
    // close, but it is not a paragraph either), so the implementation
    // must take the block branch and produce the `webui-code-block`
    // container. The previous assertion only checked that render did
    // not throw; the block branch produces the `data-language`
    // attribute and the `<pre>` shell, neither of which the inline
    // codespan renderer would emit, so this fixture fails the moment
    // the block branch is dropped.
    expect(() =>
      renderToStaticMarkup(
        createElement(WebuiMarkdown, { source: "```js\nconst a" }),
      ),
    ).not.toThrow();
    const html = renderToStaticMarkup(
      createElement(WebuiMarkdown, { source: "```js\nconst a" }),
    );
    expect(html).toContain("webui-code-block");
    expect(html).toContain('data-language="js"');
    expect(html).toContain("<pre");
    expect(html.replace(/<[^>]*>/g, "")).toContain("const a");
    expect(html).not.toContain("dangerously");
  });

  it("renders math code fences with KaTeX and leaves currency prose alone", () => {
    const mathHtml = renderToStaticMarkup(
      createElement(WebuiMarkdown, { source: "```math\nx^2 + 1\n```" }),
    );
    expect(mathHtml).toContain("webui-math-block");
    expect(mathHtml).toContain("katex");

    const currencyHtml = renderToStaticMarkup(
      createElement(WebuiMarkdown, { source: "Prices are $5 and $10." }),
    );
    expect(currencyHtml).not.toContain("webui-math");
    expect(currencyHtml).toContain("$5 and $10");

    const inlineMathHtml = renderToStaticMarkup(
      createElement(WebuiMarkdown, { source: "The result is $x^2$." }),
    );
    expect(inlineMathHtml).toContain("webui-math");
    expect(inlineMathHtml).toContain("katex");
  });
});
