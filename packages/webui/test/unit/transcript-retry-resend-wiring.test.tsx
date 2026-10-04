// Retry must RE-SEND, not abort.
//
// The defect: `WebuiComposer` rendered its `OutputError` retry affordance with
// `onRetry: () => void abortSession({ id: sessionId ?? "" })`. `abortSession`
// takes only `{ id }` and returns `{ success? }` — it structurally cannot carry
// the user's input, so the button labelled "retry" killed a turn that may still
// have been running instead of re-sending it.
//
// The behaviour pinned here, in three parts:
//
//   1. A composer that has submitted a turn records the exact text it put on
//      the wire, locally, and that recorded value is what a retry re-sends.
//   2. The retry itself re-enters the production send path
//      (`submitWebuiComposerTurn`) with that text, and has no abort anywhere in
//      it.
//   3. A composer with nothing recorded offers no retry button at all — the
//      original sin was a control that was present and could not work.
//
// There is no DOM framework in this package (`environment: "node"`, no jsdom).
// The two handlers the component builds are reached by mocking the JSX runtime
// to record every element the tree creates, which yields the REAL `onSubmit` of
// the real `<form>`. Nothing here re-implements the component's internals.
//
// One limit is worth stating up front, because it shapes the split below: a
// server render builds a fresh component instance every time, so state written
// by one render is not visible to the next. The recorded turn therefore cannot
// pre-exist a render, which means the retry button — correctly withheld until a
// record exists — is unreachable from a node render. Part 1 drives the real
// submit; parts 2 and 3 drive the exported retry unit that the button runs, with
// the production send path underneath it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type CapturedElement = { type: unknown; props: Record<string, any> };

/**
 * Every element the tree creates, in creation order. `vi.hoisted` so both mock
 * factories — which vitest hoists above the imports — close over the same array
 * the test body reads.
 */
const createdElements = vi.hoisted(() => [] as CapturedElement[]);

// Vitest's esbuild runs in dev mode, so TSX compiles to `jsxDEV` from
// `react/jsx-dev-runtime`. The classic runtime is mocked too, so the seam holds
// whichever of the two the transform picked.
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const record = (type: unknown, props: Record<string, any>) => {
    createdElements.push({ type, props });
    return actual.jsxDEV(type, props);
  };
  return { ...actual, jsxDEV: record };
});
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  const record = (type: unknown, props: Record<string, any>) => {
    createdElements.push({ type, props });
    return actual.jsx(type, props);
  };
  return { ...actual, jsx: record, jsxs: record };
});

import {
  WebuiComposer,
  planWebuiRetryResend,
  resendRecordedWebuiTurn,
} from "../../src/client/components/SessionComposer.js";
import { OutputError } from "../../src/client/components/OutputError.js";
import {
  buildWebuiComposerHandlers,
  submitWebuiComposerTurn,
} from "../../src/client/projection/composer-state.js";
import { updateSessionRuntimeState } from "../../src/client/session-runtime-store.js";
import { initialWebuiStreamState } from "../../src/client/stream.js";

const SESSION_ID = "session-retry-resend";
const OTHER_SESSION_ID = "session-retry-resend-other";
const REFUSAL = "upstream rejected: connection reset";
const USER_INPUT = "把这两张图对比一下";

/** Seed the module-level runtime store with a failed turn, as the socket would. */
function seedFailedTurn(
  session = SESSION_ID,
  refusal: string | undefined = REFUSAL,
): void {
  updateSessionRuntimeState(session, (current) => ({
    ...current,
    sending: false,
    stream: { ...initialWebuiStreamState, phase: "refused", refusal },
  }));
}

/** Render the real composer over a failed turn and hand back the live handlers. */
function renderComposer(props: {
  readonly sessionId?: string;
  readonly draft?: string;
  readonly refusal?: string;
  readonly sendMessage?: (request: any, onFrame: any) => Promise<void>;
  readonly abortSession?: (request: { id: string }) => Promise<{ success?: boolean }>;
  readonly loadMessages?: (request: any) => Promise<any>;
}): {
  html: string;
  submit: ((event: unknown) => Promise<void>) | undefined;
  onRetry: (() => void) | undefined;
} {
  createdElements.length = 0;
  const sessionId = props.sessionId ?? SESSION_ID;
  seedFailedTurn(sessionId, props.refusal);
  const html = renderToStaticMarkup(
    createElement(WebuiComposer, {
      sessionId,
      agentName: "main",
      onWorkspaceChange: () => undefined,
      workspaceMenuOpen: false,
      setWorkspaceMenuOpen: () => undefined,
      draft: props.draft ?? "",
      onDraftChange: () => undefined,
      teamModeOff: false,
      sendMessage: props.sendMessage ?? (async () => undefined),
      abortSession: props.abortSession,
      loadMessages: props.loadMessages,
    } as React.ComponentProps<typeof WebuiComposer>),
  );
  const form = createdElements.find((element) => element.type === "form");
  const outputError = createdElements.find((element) => element.type === OutputError);
  return {
    html,
    submit: form?.props.onSubmit as ((event: unknown) => Promise<void>) | undefined,
    onRetry: outputError?.props.onRetry as (() => void) | undefined,
  };
}

/** A submit event good enough for the composer, which only calls preventDefault. */
function submitEvent(): unknown {
  return { preventDefault: () => undefined };
}

/** Let a not-awaited handler's synchronous prologue run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("a composer submit records the exact text it sent", () => {
  beforeEach(() => {
    createdElements.length = 0;
  });

  it("puts the user's own words on the wire through the real form handler", async () => {
    const sent: { id: string; content: string }[] = [];
    const sendMessage = vi.fn(async (request: { id: string; content: string }) => {
      sent.push(request);
    });

    const composer = renderComposer({ draft: USER_INPUT, sendMessage });
    expect(composer.submit).toBeTypeOf("function");
    await composer.submit?.(submitEvent());

    expect(sent.map((request) => request.content)).toEqual([USER_INPUT]);
    expect(sent[0]?.id).toBe(SESSION_ID);
  });

  it("records the trimmed form of the draft, so a resend reproduces the send", async () => {
    const sent: string[] = [];
    const sendMessage = vi.fn(async (request: { content: string }) => {
      sent.push(request.content);
    });

    await renderComposer({ draft: `  ${USER_INPUT}\n`, sendMessage }).submit?.(submitEvent());

    // The wire form is the trimmed one, so the recorded value has to be too:
    // a record of the raw draft would re-send something the turn never sent.
    expect(sent).toEqual([USER_INPUT]);
    expect(
      planWebuiRetryResend({
        refusal: REFUSAL,
        recordedSession: SESSION_ID,
        session: SESSION_ID,
        lastSubmittedText: `  ${USER_INPUT}\n`,
      }),
    ).toEqual({ kind: "resend", message: USER_INPUT });
  });

  it("never reaches for the server to recover the input", async () => {
    const loadMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
    const sent: string[] = [];
    const sendMessage = vi.fn(async (request: { content: string }) => {
      sent.push(request.content);
    });

    await renderComposer({ draft: USER_INPUT, sendMessage, loadMessages }).submit?.(
      submitEvent(),
    );
    expect(sent).toEqual([USER_INPUT]);
    // The record is local. A `loadMessages` round-trip could return a different
    // message than the one that failed, and would make a local affordance
    // depend on a network call.
    expect(loadMessages).not.toHaveBeenCalled();
  });
});

describe("retry re-sends the recorded input and never aborts", () => {
  it("hands the recorded text back to the production send path", async () => {
    const sent: { id: string; content: string }[] = [];
    const abortSession = vi.fn(async () => ({ success: true }));
    // The real turn sender, assembled the way the composer assembles it.
    let inFlight: Promise<void> | undefined;
    const sendTurn = (turn: { message: string }) => {
      inFlight = submitWebuiComposerTurn(
        {
          sessionId: SESSION_ID,
          message: turn.message,
          sending: false,
          deps: {
            sendMessage: async (request) => {
              sent.push(request);
            },
          },
          teamModeOff: false,
        },
        buildWebuiComposerHandlers({
          setStream: () => undefined,
          setSending: () => undefined,
          onDraftChange: () => undefined,
        }),
      );
    };

    const plan = resendRecordedWebuiTurn({
      refusal: REFUSAL,
      recordedTurn: { session: SESSION_ID, message: `  ${USER_INPUT}\n` },
      session: SESSION_ID,
      sendTurn,
    });

    expect(plan).toEqual({ kind: "resend", message: USER_INPUT });
    // The retry is fire-and-forget, exactly as the click is; drain the turn it
    // started rather than guessing how many ticks the send path needs.
    expect(inFlight).toBeInstanceOf(Promise);
    await inFlight;
    // A resend, carrying the user's own words, to the same session…
    expect(sent.map((request) => request.content)).toEqual([USER_INPUT]);
    expect(sent[0]?.id).toBe(SESSION_ID);
    // …and no abort was even in reach of this path.
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("sends nothing at all when there is no recorded input", () => {
    const sendTurn = vi.fn();
    const plan = resendRecordedWebuiTurn({
      refusal: REFUSAL,
      recordedTurn: undefined,
      session: SESSION_ID,
      sendTurn,
    });

    expect(plan).toEqual({ kind: "withheld", reason: "no-recorded-input" });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("sends nothing when the record belongs to another session", () => {
    const sendTurn = vi.fn();
    // This component is not remounted when the user switches sessions, so a
    // stale record would otherwise re-send the previous session's turn.
    const plan = resendRecordedWebuiTurn({
      refusal: REFUSAL,
      recordedTurn: { session: SESSION_ID, message: USER_INPUT },
      session: OTHER_SESSION_ID,
      sendTurn,
    });

    expect(plan).toEqual({ kind: "withheld", reason: "no-recorded-input" });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("sends nothing when there is no failure to retry", () => {
    const sendTurn = vi.fn();
    const plan = resendRecordedWebuiTurn({
      refusal: undefined,
      recordedTurn: { session: SESSION_ID, message: USER_INPUT },
      session: SESSION_ID,
      sendTurn,
    });

    expect(plan).toEqual({ kind: "withheld", reason: "no-refusal" });
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("the composer withholds a retry it cannot honour", () => {
  it("pressing the retry affordance does not abort the session", () => {
    // This is the defect's signature, kept as a standing guard: the affordance
    // was wired to `abortSession`, which carries only a session id and so can
    // only ever kill a turn, never re-send one. In a node render no record can
    // pre-exist, so this pins the wiring (the composer offers nothing here);
    // the runtime effect of a real retry is pinned by `resendRecordedWebuiTurn`
    // above, which reaches the production send path.
    const abortSession = vi.fn(async () => ({ success: true }));
    const rendered = renderComposer({ draft: USER_INPUT, abortSession });

    rendered.onRetry?.();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("renders no retry button when this composer has submitted nothing", () => {
    const abortSession = vi.fn(async () => ({ success: true }));
    const rendered = renderComposer({ draft: "", abortSession });

    // The failure itself is still surfaced…
    expect(rendered.html).toContain(REFUSAL);
    // …but a button that cannot re-send anything is not offered. `OutputError`
    // draws its button from the presence of `onRetry`, so withholding the prop
    // is what removes the affordance.
    expect(rendered.html).not.toContain('data-testid="output-error-retry"');
    expect(rendered.onRetry).toBeUndefined();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("still shows the failure, and no button, when the composer only has a draft", () => {
    // A draft the user has not sent is not a recorded input: retrying it would
    // send something the user never chose to send.
    const rendered = renderComposer({ draft: USER_INPUT });

    expect(rendered.html).toContain(REFUSAL);
    expect(rendered.html).not.toContain('data-testid="output-error-retry"');
    expect(rendered.onRetry).toBeUndefined();
  });
});
