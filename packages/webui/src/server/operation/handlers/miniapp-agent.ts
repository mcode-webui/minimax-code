// The Mini App page bridge's handlers.
//
// Two operations, and one rule that shapes both: **a page always receives a
// documented outcome**. A runtime refusal, a plugin without Agent access, a host
// composed without the agent application, a stale generation — every one of them is
// an answer, because a page holding a promise that never settles is a page that
// cannot show anything at all. Only a malformed body is the wire's error, and that
// is decided before either handler runs.
//
// The identity rule is the other half. A request body names `pluginId`,
// `hostSessionId` and `connection`, and those are facts the *client* resolved from
// the frame it created — but a client is a document that can be replaced, so the
// service compares them against the presentation it is actually serving
// (`../miniapp/agent-connections.ts`). A body that names a generation this service
// never issued is a stale page, and a stale page is answered, not obeyed.
//
// `observe` is carried, not inferred. The transport is a stream either way; what
// decides whether the runtime may wait on this page for a permission or a
// questionnaire answer is whether this handler passed an event listener to it. A
// turn with `observe: false` reaches the runtime with no listener, so its asks are
// denied rather than hanging (ADR 0020, and the runtime's own approval router).
import { toMiniAppAgentFailureCode } from "@mavis/shared/miniapp-surface";
import type {
  MiniAppAgentBusyReason,
  MiniAppAgentFailureCode,
  MiniAppAgentRunEvent,
  MiniAppAgentRunResult,
} from "@mavis/shared/miniapp-surface";

import { WebuiCapabilityUnavailableError } from "../../../shared/envelope.js";
import type {
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentCallResponse,
  WebuiMiniAppAgentTurnFrame,
  WebuiMiniAppAgentTurnRequest,
} from "../../../shared/contracts/miniapp-agent.js";
import type { WebuiMiniAppAgentCaller } from "../../../runtime/port.js";
import type { WebuiOperationPort } from "../bind-handlers.js";
import type {
  WebuiOperationContext,
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
  WebuiOperationValidation,
} from "../operation-contract.js";
import {
  miniAppAgentCallOperation,
  watchMiniAppAgentTurnOperation,
} from "../miniapp-agent.js";
import type { MiniAppAgentConnections } from "../../miniapp/agent-connections.js";
import type { MiniAppAgentPanels } from "../../miniapp/agent-panels.js";
import type { MiniAppAgentRuns } from "../../miniapp/agent-runs.js";

type BodyOf<Descriptor> = Descriptor extends {
  readonly validate: (body: unknown) => WebuiOperationValidation<infer Body>;
}
  ? Body
  : never;

type DedicatedHandler<Descriptor> = WebuiOperationHandler<BodyOf<Descriptor>, unknown>;

/**
 * How long a page's cancellation waits for the runtime to confirm the abort.
 *
 * Past this the abort is unproven, and an unproven abort is `result_unknown`: the
 * turn may have run. The desktop client's broker uses the same bound for the same
 * reason, so a page written against it sees the same timing here.
 */
const SETTLEMENT_TIMEOUT_MS = 15_000;

/** The members one capability, required together. */
type MiniAppAgentFacade = Required<
  Pick<
    WebuiOperationPort,
    | "runMiniAppAgentTurn"
    | "answerMiniAppAgentQuestion"
    | "replyMiniAppAgentPermission"
    | "openMiniAppAgentSession"
    | "panelOpenedMiniAppAgentSession"
    | "panelClosedMiniAppAgentSession"
    | "listMiniAppAgentModels"
    | "listMiniAppAgentAgents"
    | "listMiniAppAgentSessions"
    | "readMiniAppAgentSession"
    | "createMiniAppAgentSession"
  >
>;

function requireMiniAppAgent(port: WebuiOperationPort): MiniAppAgentFacade {
  const facade = port as MiniAppAgentFacade;
  for (const name of [
    "runMiniAppAgentTurn",
    "answerMiniAppAgentQuestion",
    "replyMiniAppAgentPermission",
    "openMiniAppAgentSession",
    "panelOpenedMiniAppAgentSession",
    "panelClosedMiniAppAgentSession",
    "listMiniAppAgentModels",
    "listMiniAppAgentAgents",
    "listMiniAppAgentSessions",
    "readMiniAppAgentSession",
    "createMiniAppAgentSession",
  ] as const) {
    if (typeof facade[name] !== "function") {
      throw new WebuiCapabilityUnavailableError(
        "runtime host does not expose the Mini App Agent capability",
      );
    }
  }
  return facade;
}

/**
 * Which failure code an error becomes.
 *
 * The runtime's own codes map one to one. Anything else is decided by what the
 * method may have done before it failed: `create`, `reply`, `answer` and `run` can
 * have applied a mutation the service never saw the result of, so they answer
 * `result_unknown` and must not be retried; the reads answer `runtime_unavailable`,
 * which is safe to repeat. No new code is invented for an unrecognised failure —
 * an unknown string is exactly what a closed vocabulary exists to prevent.
 */
function failureOf(
  error: unknown,
  method: string,
): { readonly code: MiniAppAgentFailureCode; readonly reason?: MiniAppAgentBusyReason } {
  if (error instanceof WebuiCapabilityUnavailableError) return { code: "runtime_unavailable" };
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = record?.code;
  const mapped = toMiniAppAgentFailureCode(code);
  if (mapped) {
    const reason = record?.reason;
    return typeof reason === "string" && (reason === "session_busy" || reason === "queue_full")
      ? { code: mapped, reason }
      : { code: mapped };
  }
  const mayHaveApplied =
    method === "run" || method === "answer" || method === "reply" || method === "create";
  return { code: mayHaveApplied ? "result_unknown" : "runtime_unavailable" };
}

/**
 * A frame buffer one producer fills and one consumer drains.
 *
 * The turn's events arrive from a callback while the generator is suspended
 * between frames, so something has to hold them; this is that, and nothing more.
 * Closing it is what ends a stream whose client has gone away.
 */
function createFrameQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(item: T): void {
      if (closed) return;
      items.push(item);
      wake?.();
    },
    close(): void {
      closed = true;
      wake?.();
    },
    async next(): Promise<T | undefined> {
      for (;;) {
        const item = items.shift();
        if (item !== undefined) return item;
        if (closed) return undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

export interface MiniAppAgentHandlerOptions {
  /** The presentations this service is serving, and their generations. */
  readonly connections: MiniAppAgentConnections;
  /** The turns in flight, so a page's cancellation can reach one. */
  readonly runs: MiniAppAgentRuns;
  /**
   * The sessions the runtime has been told are on screen.
   *
   * Shared with the stop handler, which closes them before it revokes the
   * generation: after the revoke the client could no longer deliver a close report.
   */
  readonly panels: MiniAppAgentPanels;
}

/** One followed turn, as a stream of progress events and one settlement. */
async function* turnSource(
  input: {
    readonly context: WebuiOperationContext;
    readonly body: WebuiMiniAppAgentTurnRequest;
    readonly port: WebuiOperationPort;
    readonly options: MiniAppAgentHandlerOptions;
  },
): AsyncGenerator<WebuiMiniAppAgentTurnFrame> {
  const { body, context, options, port } = input;
  const caller = options.connections.callerFor({
    pluginId: body.pluginId,
    hostSessionId: body.hostSessionId,
    connection: body.connection,
  });
  if (!caller) {
    // A replaced presentation, or one this service is not serving. Answered rather
    // than thrown: the page is still there and can act on the code.
    yield { kind: "failure", code: "runtime_unavailable" };
    return;
  }

  let facade: MiniAppAgentFacade;
  try {
    facade = requireMiniAppAgent(port);
  } catch (error) {
    yield { kind: "failure", ...failureOf(error, body.method) };
    return;
  }

  const run = options.runs.begin({ pluginId: body.pluginId, requestId: body.requestId });
  if (!run) {
    // Two turns sharing an id would also share its events and its settlement.
    yield { kind: "failure", code: "busy", reason: "session_busy" };
    return;
  }

  const queue = createFrameQueue<WebuiMiniAppAgentTurnFrame>();
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  run.onCancelled(() => {
    // The runtime settles an aborted turn itself when it can; the watchdog only
    // exists for the case where it never does.
    watchdog = setTimeout(() => {
      queue.push({ kind: "failure", code: "result_unknown" });
      queue.close();
    }, SETTLEMENT_TIMEOUT_MS);
  });

  // A client that goes away stops reading; its turn is aborted silently because
  // nobody is waiting for an answer.
  const onDetach = (): void => {
    run.controller.abort();
    queue.close();
  };
  context.signal?.addEventListener("abort", onDetach, { once: true });

  const onEvent = body.observe
    ? (event: MiniAppAgentRunEvent): void => queue.push({ kind: "event", event })
    : undefined;

  const settle = (result: MiniAppAgentRunResult): void => {
    queue.push({ kind: "settled", result });
    queue.close();
  };
  const fail = (error: unknown): void => {
    const failure = failureOf(error, body.method);
    queue.push({ kind: "failure", ...failure });
    queue.close();
  };

  const turn =
    body.method === "run"
      ? facade.runMiniAppAgentTurn({
          caller,
          text: body.text ?? "",
          ...(body.targetSessionId !== undefined ? { sessionId: body.targetSessionId } : {}),
          ...(body.agent !== undefined ? { agent: body.agent } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          signal: run.controller.signal,
          ...(onEvent ? { onEvent } : {}),
        })
      : facade.answerMiniAppAgentQuestion({
          caller,
          sessionId: body.targetSessionId ?? "",
          requestId: body.questionRequestId ?? "",
          answers: (body.answers ?? []) as unknown as readonly never[],
          ...(body.model !== undefined ? { model: body.model } : {}),
          signal: run.controller.signal,
          ...(onEvent ? { onEvent } : {}),
        });
  void turn.then(settle, fail);

  try {
    for (;;) {
      const frame = await queue.next();
      if (frame === undefined) return;
      yield frame;
    }
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    context.signal?.removeEventListener("abort", onDetach);
    run.end();
  }
}

export function createMiniAppAgentHandlerEntries(
  port: WebuiOperationPort,
  options: MiniAppAgentHandlerOptions,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const watchMiniAppAgentTurn: DedicatedHandler<typeof watchMiniAppAgentTurnOperation> = async (
    context,
    body,
  ) => ({
    stream: {
      ok: true,
      // The cast is the pattern the presentation lease uses: the handler contract
      // names the two data streams, while this watcher's frame type is its own and
      // is declared on the descriptor.
      source: turnSource({ context, body, port, options }) as unknown as AsyncIterable<
        Record<string, unknown>
      >,
    },
  });

  const miniAppAgentCall: DedicatedHandler<typeof miniAppAgentCallOperation> = async (
    _context,
    body,
  ): Promise<{ body: WebuiMiniAppAgentCallResponse }> => {
    const caller: WebuiMiniAppAgentCaller | undefined = options.connections.callerFor({
      pluginId: body.pluginId,
      hostSessionId: body.hostSessionId,
      connection: body.connection,
    });
    if (!caller) return { body: { ok: false, code: "runtime_unavailable" } };

    // Cancellation is answered from this service's own registry: the turn may be
    // long dead, and asking the runtime about an id it has already forgotten would
    // turn a no-op into an error the page cannot act on.
    if (body.method === "cancel") {
      options.runs.cancel({ pluginId: body.pluginId, requestId: body.requestId });
      return { body: { ok: true, method: "cancel" } };
    }

    let facade: MiniAppAgentFacade;
    try {
      facade = requireMiniAppAgent(port);
    } catch (error) {
      return { body: { ok: false, ...failureOf(error, body.method) } };
    }

    try {
      switch (body.method) {
        case "models":
          return { body: { ok: true, method: "models", models: await facade.listMiniAppAgentModels({ caller }) } };
        case "agents":
          return { body: { ok: true, method: "agents", agents: await facade.listMiniAppAgentAgents({ caller }) } };
        case "sessions":
          return { body: { ok: true, method: "sessions", sessions: await facade.listMiniAppAgentSessions({ caller }) } };
        case "session":
          return {
            body: {
              ok: true,
              method: "session",
              session: await facade.readMiniAppAgentSession({ caller, ...(body.targetSessionId ? { sessionId: body.targetSessionId } : {}) }),
            },
          };
        case "create": {
          const created = await facade.createMiniAppAgentSession({
            caller,
            ...(body.agent !== undefined ? { agent: body.agent } : {}),
          });
          return { body: { ok: true, method: "create", sessionId: created.sessionId } };
        }
        case "reply":
          await facade.replyMiniAppAgentPermission({
            caller,
            sessionId: body.targetSessionId ?? "",
            requestId: body.questionRequestId ?? "",
            decision: body.decision ?? "deny",
          });
          return { body: { ok: true, method: "reply" } };
        case "open": {
          const opened = await facade.openMiniAppAgentSession({
            caller,
            sessionId: body.targetSessionId ?? "",
          });
          return {
            body: {
              ok: true,
              method: "open",
              sessionId: opened.sessionId,
              hostSessionId: opened.hostSessionId,
            },
          };
        }
        case "panelOpened": {
          const sessionId = body.targetSessionId ?? "";
          await facade.panelOpenedMiniAppAgentSession({
            sessionId,
            hostSessionId: body.hostSessionId,
          });
          // Recorded here, on the runtime's acceptance: a panel it refused is not
          // a panel this service may claim a stop has to close.
          options.panels.opened({
            pluginId: body.pluginId,
            sessionId,
            hostSessionId: body.hostSessionId,
          });
          return { body: { ok: true, method: "panelOpened" } };
        }
        case "panelClosed": {
          const sessionId = body.targetSessionId ?? "";
          await facade.panelClosedMiniAppAgentSession({
            sessionId,
            hostSessionId: body.hostSessionId,
          });
          options.panels.closed({
            pluginId: body.pluginId,
            sessionId,
            hostSessionId: body.hostSessionId,
          });
          return { body: { ok: true, method: "panelClosed" } };
        }
        default:
          return { body: { ok: false, code: "not_permitted" } };
      }
    } catch (error) {
      return { body: { ok: false, ...failureOf(error, body.method) } };
    }
  };

  return new Map([
    [
      watchMiniAppAgentTurnOperation.name,
      {
        operation: watchMiniAppAgentTurnOperation,
        handle: watchMiniAppAgentTurn as WebuiOperationHandler<unknown>,
      },
    ],
    [
      miniAppAgentCallOperation.name,
      {
        operation: miniAppAgentCallOperation,
        handle: miniAppAgentCall as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}

/** The request type the call handler reads, exported for the tests that drive it. */
export type { WebuiMiniAppAgentCallRequest };
