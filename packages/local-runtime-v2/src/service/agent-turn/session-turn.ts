import { randomUUID } from 'node:crypto';

import type { AskQuestionnaireReplyAnswer, AskQuestionnaireRequest } from '@mavis/shared/questionnaire';
import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';

import {
  LocalModelProviderError,
  resolveRequestedSessionModel,
  type LocalConversationRuntimeConfig,
} from '../model-system/index.js';
import type { AbortTurnResult } from '../turn-system/index.js';
import type { DisplayMessageRecord, SessionFrame } from '../session-system/index.js';
import { createFrameProjector } from './session-frame-projection.js';
import { modelSelectionFromRecord } from './model-selection.js';
import type {
  AgentTurnAnswerInput,
  AgentTurnModelSelection,
  AgentTurnResult,
  AgentTurnRunEvent,
  AgentTurnRunInput,
  AgentTurnSession,
  AgentTurnSessionOptions,
} from './contracts.js';

/**
 * The post-policy Session/Turn follower shared by internal Agent consumers.
 *
 * A consumer supplies its session repository, turn service, stream, messages,
 * questionnaire owner and error type; this module supplies the lifecycle:
 * subscribe before steering, follow only the turn it activated, settle a
 * cancelled turn, and report an unobserved continuation as an unknown outcome.
 */

/** Upper bound on delegated-session hops walked to find an owner. */
const MAX_ROOT_HOPS = 16;

/** How long a cancelled run waits for its own terminal so the session is idle afterwards. */
const ABORT_SETTLE_TIMEOUT_MS = 15_000;
/** How long an answer waits for the continuation turn it should start. */
const CONTINUATION_START_TIMEOUT_MS = 15_000;

/** What following one turn needs from either entry (`run` / `answer`). */
interface FollowInput {
  readonly sessionId: string;
  /** Read before dispatch; reported on `turn.started` and the result. */
  readonly model: AgentTurnModelSelection;
  readonly onEvent?: (event: AgentTurnRunEvent) => void;
}

/** The live resume iterator; replaced when a stale terminal forces a re-resume. */
interface FrameSource {
  current: AsyncIterableIterator<SessionFrame>;
  /** A read that lost a race (cancel / timeout); the next read takes its frame. */
  pending?: Promise<IteratorResult<SessionFrame>>;
}

/** Reads the next frame unless `stop` settles first; an unread frame stays for the next read. */
async function read<TStop extends symbol>(
  source: FrameSource,
  stop: Promise<TStop>,
): Promise<IteratorResult<SessionFrame> | TStop> {
  source.pending ??= source.current.next();
  const result = await Promise.race([source.pending, stop]);
  if (typeof result !== 'symbol') source.pending = undefined;
  return result;
}

interface FollowedTurn {
  readonly source: FrameSource;
  readonly turnId: string;
  readonly aborted: Promise<typeof ABORTED>;
  /** Before the turn was requested; only questionnaires created since belong to it. */
  readonly startedAtMs: number;
}

type PendingQuestion = NonNullable<AgentTurnResult['pendingQuestion']>;

export function createAgentTurnSession(options: AgentTurnSessionOptions): AgentTurnSession {
  return {
    run: (input) => runAgentTurn(options, input),
    answer: (input) => answerAgentQuestion(options, input),
  };
}

async function runAgentTurn(
  options: AgentTurnSessionOptions,
  input: AgentTurnRunInput,
): Promise<AgentTurnResult> {
  const model = await modelBeforeDispatch(options, input.sessionId);
  const follow = { ...input, model };
  // Subscribe before steering; the iterator buffers frames until the turnId is known.
  return withTurnStream(options, input, async (source, aborted) => {
    const startedAtMs = options.nowMs();
    const turnId = await activateTurn(options, input);
    return followOwnedTurn(options, follow, { source, turnId, aborted, startedAtMs });
  });
}

/** Opens the session stream and the abort watch for one run; both are released when it settles. */
async function withTurnStream(
  options: AgentTurnSessionOptions,
  input: { readonly sessionId: string; readonly signal?: AbortSignal },
  follow: (source: FrameSource, aborted: Promise<typeof ABORTED>) => Promise<AgentTurnResult>,
): Promise<AgentTurnResult> {
  const source: FrameSource = {
    current: options.stream.resume({ sessionId: input.sessionId, waitForTerminal: true }),
  };
  const aborted = abortPromise(input.signal);
  try {
    return await follow(source, aborted.promise);
  } finally {
    aborted.dispose();
    await source.current.return?.();
  }
}

/**
 * Answers the questionnaire the session paused on and follows the continuation turn the
 * answer starts. The stream is subscribed before replying, and the continuation is the
 * first turn-scoped frame that follows. An answer the runtime saved without starting a
 * continuation settles `finished` without a turn; one whose continuation is not observed
 * within the bound has an unknown outcome (the turn may still start later).
 */
async function answerAgentQuestion(
  options: AgentTurnSessionOptions,
  input: AgentTurnAnswerInput,
): Promise<AgentTurnResult> {
  const { sessionId, requestId } = input;
  const { agentName, pending } = await beforeDispatch(
    options,
    { stage: 'answer-lookup', sessionId, requestId },
    async () => {
      const name = (await options.repository.get(sessionId))?.agentName;
      return {
        agentName: name,
        pending: name ? await pendingQuestionOf(options, name, sessionId) : undefined,
      };
    },
  );
  // A request id of another session (even of the same agent) is never settled from here.
  if (!agentName || pending?.requestId !== requestId) {
    throw options.createError('REQUEST_NOT_FOUND', 'Agent question is not pending');
  }
  const model = await modelBeforeDispatch(options, sessionId);
  const follow = { ...input, model };
  return withTurnStream(options, input, async (source, aborted) => {
    const startedAtMs = options.nowMs();
    const reply = await replyQuestion(options, agentName, input);
    if (reply.injected === false) return { status: 'finished' };
    const first = await awaitContinuation(source, aborted);
    if (first === TIMED_OUT) {
      options.logger.warn(
        {
          stage: 'answer-continuation',
          sessionId,
          requestId,
          timeoutMs: CONTINUATION_START_TIMEOUT_MS,
        },
        'Agent answer continuation turn was not observed',
      );
      throw outcomeUnknown(
        options,
        'Agent answer was recorded but the follow-up turn was not observed',
      );
    }
    if (first === ABORTED) {
      return finish(follow, await abortUnidentifiedTurn(options, sessionId, source));
    }
    source.current = prepend(first, source.current);
    return followOwnedTurn(options, follow, {
      source,
      turnId: first.turnId,
      aborted,
      startedAtMs,
    });
  });
}

async function awaitContinuation(
  source: FrameSource,
  aborted: Promise<typeof ABORTED>,
): Promise<TurnFrame | typeof ABORTED | typeof TIMED_OUT> {
  const deadline = timeoutPromise(CONTINUATION_START_TIMEOUT_MS);
  try {
    return await nextTurnFrame(source, Promise.race([aborted, deadline.promise]));
  } finally {
    deadline.dispose();
  }
}

async function replyQuestion(
  options: AgentTurnSessionOptions,
  agentName: string,
  input: AgentTurnAnswerInput,
): Promise<{ readonly ok: true; readonly injected?: boolean }> {
  try {
    return await options.questionnaires.reply({
      agentName,
      requestId: input.requestId,
      answers: [...input.answers],
      submittedAt: options.nowMs(),
    });
  } catch (error) {
    // These statuses are raised before the answer is saved, so nothing was dispatched. Any
    // other failure (e.g. 503 QUESTIONNAIRE_CONTINUATION_NOT_STARTED, raised after the answer
    // was persisted) propagates and is reported as an unknown outcome.
    const status = readNumber(error, 'status');
    if (status === 400) {
      throw options.createError('INVALID_ARGUMENTS', 'Agent answers were rejected');
    }
    if (status === 404 || status === 409 || status === 410) {
      throw options.createError('REQUEST_NOT_FOUND', 'Agent question is not pending');
    }
    throw error;
  }
}

async function pendingQuestionOf(
  options: AgentTurnSessionOptions,
  agentName: string,
  sessionId: string,
): Promise<PendingQuestion | undefined> {
  const request: AskQuestionnaireRequest | undefined = await options.questionnaires.getPending({
    agentName,
    sessionId,
  });
  return request
    ? { requestId: request.id, mode: request.mode ?? 'questionnaire', request }
    : undefined;
}

async function followOwnedTurn(
  options: AgentTurnSessionOptions,
  input: FollowInput,
  run: FollowedTurn,
): Promise<AgentTurnResult> {
  try {
    return await followTurn(options, input, run);
  } catch (error) {
    // An Agent error here is raised after the turn ended or after its abort was
    // requested; anything else means the dispatched turn is no longer observed, so do not
    // leave it running without a caller.
    if (!isConsumerError(options, error)) {
      await abortQuietly(options, input.sessionId, run.turnId);
    }
    throw error;
  }
}

function isConsumerError(options: AgentTurnSessionOptions, error: unknown): boolean {
  if (options.isError) return options.isError(error);
  // Without a consumer predicate, a coded error is the best structural signal.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.length > 0
  );
}

async function abortQuietly(
  options: AgentTurnSessionOptions,
  sessionId: string,
  turnId: string,
): Promise<void> {
  try {
    await options.turns.abort({ sessionId, turnId, reason: `${options.source}-stream-lost` });
  } catch (error) {
    // Best effort; the original failure is what the caller sees.
    options.logger.warn(
      { stage: 'abort-unobserved-turn', sessionId, turnId, ...errorFields(error) },
      'Agent could not abort a turn it no longer observes',
    );
  }
}

async function activateTurn(
  options: AgentTurnSessionOptions,
  input: AgentTurnRunInput,
): Promise<string> {
  const { sessionId } = input;
  input.signal?.throwIfAborted();
  const requestId = randomUUID();
  const source = options.source;
  const steered = await options.turns.steer({
    sessionId,
    input: { text: input.text },
    producerId: `${source}:${sessionId}`,
    idempotencyKey: requestId,
    provenance: {
      source,
      routingFingerprint: `${source}:${sessionId}:${requestId}`,
    },
    ...(input.capabilitySelection ? { capabilitySelection: input.capabilitySelection } : {}),
  });
  if (!steered.delivered) {
    throw options.createError('AGENT_UNAVAILABLE', 'Agent turn was rejected', true);
  }
  // A steered delivery merged the text into a turn this run does not own.
  if (steered.mode !== 'activated') {
    throw options.createError('BUSY', 'Agent session is busy', true, 'session_busy');
  }
  return steered.turnId;
}

async function followTurn(
  options: AgentTurnSessionOptions,
  input: FollowInput,
  run: FollowedTurn,
): Promise<AgentTurnResult> {
  const { sessionId } = input;
  const { source, turnId } = run;
  const projector = createFrameProjector(sessionId, turnId, input.model);
  for (;;) {
    const next = await read(source, run.aborted);
    if (next === ABORTED) {
      const abort = await options.turns.abort({ sessionId, turnId, reason: `${options.source}-cancelled` });
      const terminal = await settleAbortedTurn(options, sessionId, source, turnId);
      return finish(input, confirmCancelled(options, { sessionId, turnId, abort, terminal }));
    }
    if (next.done) throw new Error('Session stream ended before the Agent turn terminal');
    const frame = next.value;
    // Frames without a turnId are session-level; frames of other turns are not this run's.
    if (frame.turnId !== undefined && frame.turnId !== turnId) {
      await resumeAfterStaleTerminal(options, sessionId, source, frame);
      continue;
    }
    if (frame.kind === 'turn-terminal') {
      return settleTerminal(options, input, run, frame.data);
    }
    emit(input.onEvent, projector.project(frame));
  }
}

/**
 * The resume iterator closes on any turn-terminal; a stale one from an earlier turn must not
 * end this run, so continue from its cursor (the ring replays what followed).
 */
async function resumeAfterStaleTerminal(
  options: AgentTurnSessionOptions,
  sessionId: string,
  source: FrameSource,
  frame: SessionFrame,
): Promise<void> {
  if (frame.kind !== 'turn-terminal' || !frame.cursor) return;
  await source.current.return?.();
  source.current = options.stream.resume({
    sessionId,
    afterCursor: frame.cursor,
    waitForTerminal: true,
  });
}

/** A turn that ended on a questionnaire it raised reports it before `turn.finished`. */
async function settleTerminal(
  options: AgentTurnSessionOptions,
  input: FollowInput,
  run: FollowedTurn,
  data: unknown,
): Promise<AgentTurnResult> {
  const { sessionId } = input;
  const { turnId } = run;
  const result = await terminalResult(options, sessionId, turnId, data);
  if (result.status === 'aborted') return finish(input, result);
  let question: PendingQuestion | undefined;
  try {
    question = await findPendingQuestion(options, input, run);
  } catch (error) {
    options.logger.warn(
      { stage: 'pending-question-lookup', sessionId, turnId, ...errorFields(error) },
      'Agent pending questionnaire lookup failed',
    );
    // The turn did end: deliver its terminal, but not as proof that nothing is pending.
    finish(input, result);
    throw outcomeUnknown(
      options,
      'The Agent turn ended, but whether a question is pending could not be determined; ' +
        'inspect the session, then continue with run({ sessionId }) or answer',
    );
  }
  if (!question) return finish(input, result);
  emit(input.onEvent, [
    {
      type: 'question.requested',
      sessionId,
      turnId,
      requestId: question.requestId,
      mode: question.mode,
      request: question.request,
    },
  ]);
  return finish(input, { ...result, pendingQuestion: question });
}

/**
 * Only a questionnaire created during this turn is its question; an older one left unanswered
 * is not re-reported.
 */
async function findPendingQuestion(
  options: AgentTurnSessionOptions,
  input: FollowInput,
  run: FollowedTurn,
): Promise<PendingQuestion | undefined> {
  const { sessionId } = input;
  const agentName = (await options.repository.get(sessionId))?.agentName;
  const question = agentName ? await pendingQuestionOf(options, agentName, sessionId) : undefined;
  const createdAt = question?.request.createdAt;
  return createdAt === undefined || createdAt >= run.startedAtMs ? question : undefined;
}

type TurnFrame = SessionFrame & { readonly turnId: string };

/** Reads until the first turn-scoped frame, or the `stop` symbol; session-level frames have no turn. */
async function nextTurnFrame<TStop extends symbol>(
  source: FrameSource,
  stop: Promise<TStop>,
): Promise<TurnFrame | TStop> {
  for (;;) {
    const next = await read(source, stop);
    if (typeof next === 'symbol') return next;
    if (next.done) throw new Error('Session stream ended before the Agent turn started');
    const frame = next.value;
    if (frame.turnId !== undefined) return { ...frame, turnId: frame.turnId };
  }
}

/**
 * Cancelled before the continuation turn was seen: wait (bounded) for it to appear, abort it
 * and wait for its terminal, so the session is idle for the next call. Not seeing the turn
 * at all leaves the outcome unknown: it may still start after this call returns.
 */
async function abortUnidentifiedTurn(
  options: AgentTurnSessionOptions,
  sessionId: string,
  source: FrameSource,
): Promise<AgentTurnResult> {
  const deadline = timeoutPromise(ABORT_SETTLE_TIMEOUT_MS);
  let first: TurnFrame | typeof TIMED_OUT;
  try {
    first = await nextTurnFrame(source, deadline.promise);
  } catch (error) {
    options.logger.warn(
      { stage: 'cancel-continuation-watch', sessionId, ...errorFields(error) },
      'Agent lost the stream while waiting for the cancelled continuation turn',
    );
    first = TIMED_OUT;
  } finally {
    deadline.dispose();
  }
  if (first === TIMED_OUT) {
    options.logger.warn(
      { stage: 'cancel-continuation', sessionId, timeoutMs: ABORT_SETTLE_TIMEOUT_MS },
      'Agent cancelled answer: continuation turn was not observed',
    );
    throw outcomeUnknown(
      options,
      'Agent answer was cancelled but the follow-up turn was not observed',
    );
  }
  const turnId = first.turnId;
  if (first.kind === 'turn-terminal') {
    const terminal = { status: readString(first.data, 'status') };
    return confirmCancelled(options, { sessionId, turnId, terminal });
  }
  const abort = await options.turns.abort({ sessionId, turnId, reason: `${options.source}-cancelled` });
  const terminal = await settleAbortedTurn(options, sessionId, source, turnId);
  return confirmCancelled(options, { sessionId, turnId, abort, terminal });
}

/** The terminal frame a cancelled run saw for its turn; `status` is as the frame carried it. */
interface ObservedTerminal {
  readonly status: string | undefined;
}

/**
 * A cancel is reported `aborted` only when the runtime acknowledged the abort or the turn's
 * own `aborted` terminal was seen. A timeout, an ended stream, or a turn that was no longer
 * running (it may have finished on its own) does not prove the abort.
 */
function confirmCancelled(
  options: AgentTurnSessionOptions,
  cancel: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly abort?: AbortTurnResult;
    readonly terminal: ObservedTerminal | undefined;
  },
): AgentTurnResult {
  const { sessionId, turnId, abort, terminal } = cancel;
  if (abort?.status === 'aborted' || terminal?.status === 'aborted') {
    return { turnId, status: 'aborted' };
  }
  options.logger.warn(
    {
      stage: 'cancel-confirmation',
      sessionId,
      turnId,
      abortStatus: abort?.status ?? 'not-requested',
      terminalStatus: terminal ? (terminal.status ?? 'missing') : 'not-observed',
    },
    'Agent cancel was not confirmed',
  );
  const observed = terminal?.status;
  throw outcomeUnknown(
    options,
    observed === undefined
      ? 'Agent run was cancelled but the abort was not confirmed'
      : `Agent run was cancelled but the turn ended on its own first (terminal status: ${observed}); inspect the session before continuing`,
  );
}

function prepend(
  frame: SessionFrame,
  rest: AsyncIterableIterator<SessionFrame>,
): AsyncIterableIterator<SessionFrame> {
  let head: SessionFrame | undefined = frame;
  const iterator: AsyncIterableIterator<SessionFrame> = {
    [Symbol.asyncIterator]: () => iterator,
    next() {
      if (!head) return rest.next();
      const value = head;
      head = undefined;
      return Promise.resolve({ done: false, value });
    },
    return: () => rest.return?.() ?? Promise.resolve({ done: true, value: undefined }),
  };
  return iterator;
}

/**
 * Waits (bounded) for the aborted turn's own terminal so a follow-up run finds the session
 * idle; undefined when it was not seen (timeout or the stream ended).
 */
async function settleAbortedTurn(
  options: AgentTurnSessionOptions,
  sessionId: string,
  source: FrameSource,
  turnId: string,
): Promise<ObservedTerminal | undefined> {
  const deadline = timeoutPromise(ABORT_SETTLE_TIMEOUT_MS);
  try {
    for (;;) {
      const next = await read(source, deadline.promise);
      if (next === TIMED_OUT || next.done) return undefined;
      if (next.value.kind === 'turn-terminal' && next.value.turnId === turnId) {
        return { status: readString(next.value.data, 'status') };
      }
      if (next.value.turnId !== turnId) {
        await resumeAfterStaleTerminal(options, sessionId, source, next.value);
      }
    }
  } finally {
    deadline.dispose();
  }
}

const TIMED_OUT = Symbol('timed-out');

function timeoutPromise(ms: number): {
  readonly promise: Promise<typeof TIMED_OUT>;
  dispose(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return { promise, dispose: () => clearTimeout(timer) };
}

const ABORTED = Symbol('aborted');

function abortPromise(signal: AbortSignal | undefined): {
  readonly promise: Promise<typeof ABORTED>;
  dispose(): void;
} {
  if (!signal) return { promise: new Promise(() => undefined), dispose: () => undefined };
  let onAbort: () => void = () => undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

/**
 * The final event carries the settled result, so it is emitted only once that result exists;
 * a result without a turn (nothing ran) has no `turn.finished`.
 */
function finish(input: FollowInput, result: AgentTurnResult): AgentTurnResult {
  if (result.turnId === undefined) return result;
  const reported = { ...result, model: input.model };
  emit(input.onEvent, [
    {
      type: 'turn.finished',
      sessionId: input.sessionId,
      turnId: result.turnId,
      status: result.status,
      ...(result.text === undefined ? {} : { text: result.text }),
      ...(result.error ? { error: result.error } : {}),
    },
  ]);
  return reported;
}

function emit(
  onEvent: ((event: AgentTurnRunEvent) => void) | undefined,
  events: readonly AgentTurnRunEvent[],
): void {
  if (!onEvent) return;
  for (const event of events) {
    try {
      onEvent(event);
    } catch {
      // A listener failure must not break the run.
    }
  }
}

async function terminalResult(
  options: AgentTurnSessionOptions,
  sessionId: string,
  turnId: string,
  data: unknown,
): Promise<AgentTurnResult> {
  const status = readField(data, 'status');
  if (status === 'aborted') return { turnId, status: 'aborted' };
  if (status === 'failed') {
    const code = readString(data, 'errorSource');
    return {
      turnId,
      status: 'error',
      error: {
        code: code && TURN_ERROR_CODE_PATTERN.test(code) ? code : 'TURN_FAILED',
        message: 'The Agent turn failed.',
      },
    };
  }
  if (status !== 'completed') {
    // Malformed terminal data says nothing about how the turn ended.
    options.logger.warn(
      { stage: 'turn-terminal', sessionId, turnId, terminalStatus: status ?? null },
      'Agent turn terminal has no known status',
    );
    throw outcomeUnknown(options, 'Agent turn ended with an unreadable result');
  }
  const text = finalAssistantText(await options.messages.listTurn(sessionId, turnId));
  return { turnId, status: 'finished', ...(text ? { text } : {}) };
}

/** Runtime error sources are forwarded only when they are short identifiers, never free text. */
const TURN_ERROR_CODE_PATTERN = /^[A-Za-z][\w.-]{0,63}$/;

function finalAssistantText(messages: readonly DisplayMessageRecord[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const body = message.msg_content ?? message.msgContent ?? message.content;
    if (typeof body === 'string' && body.trim()) return body;
  }
  return undefined;
}

async function modelBeforeDispatch(
  options: AgentTurnSessionOptions,
  sessionId: string,
): Promise<AgentTurnModelSelection> {
  const record = await options.repository.get(sessionId);
  const recorded = record ? modelSelectionFromRecord(record) : undefined;
  return (
    recorded ??
    beforeDispatch(options, { stage: 'resolve-default-model', sessionId }, async () => {
      return (await resolveDefaultSessionModel(options)).selection;
    })
  );
}

/** The model a consumer should mutate a session to before dispatching its own turn. */
export async function resolveAgentTurnModel(
  options: AgentTurnSessionOptions,
  requested: Parameters<typeof resolveRequestedSessionModel>[1],
): Promise<{ readonly selection: AgentTurnModelSelection; readonly contextWindow?: number }> {
  return resolveSelection(options, requested);
}

export async function resolveDefaultAgentTurnModel(
  options: AgentTurnSessionOptions,
): Promise<{ readonly selection: AgentTurnModelSelection; readonly contextWindow?: number }> {
  return resolveDefaultSessionModel(options);
}

async function resolveDefaultSessionModel(
  options: AgentTurnSessionOptions,
): Promise<{ readonly selection: AgentTurnModelSelection; readonly contextWindow?: number }> {
  const config = options.modelConfig();
  return resolveSelection(options, {
    ...(config.defaultModelVariant === undefined ? {} : { variant: config.defaultModelVariant }),
    ...(config.defaultModelThinking === undefined
      ? {}
      : { thinking: config.defaultModelThinking }),
    ...(config.defaultModelContextWindow === undefined
      ? {}
      : { contextLimit: config.defaultModelContextWindow }),
  });
}

async function resolveSelection(
  options: AgentTurnSessionOptions,
  requested: Parameters<typeof resolveRequestedSessionModel>[1],
): Promise<{ readonly selection: AgentTurnModelSelection; readonly contextWindow?: number }> {
  try {
    const config = options.modelConfig();
    const resolved = resolveRequestedSessionModel(config, requested);
    if (!resolved.providerId || !resolved.modelId) {
      throw options.createError(
        'INVALID_ARGUMENTS',
        'Model is not available: the runtime default model is not configured',
      );
    }
    // A retired official model was already replaced above. The internal API
    // still validates its arguments up front: a model no route lists is an
    // input error for the caller rather than a Turn left to fail upstream.
    const availability = resolveModelAvailability({
      config,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      preset: getRuntimePresetKey(),
      source: 'explicit_request',
    });
    if (!availability.available) {
      throw options.createError(
        'INVALID_ARGUMENTS',
        `Model is not available: ${availability.message}`,
      );
    }
    return {
      selection: {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        ...(typeof resolved.variant === 'string' ? { variant: resolved.variant } : {}),
        ...(resolved.thinking?.effort ? { thinking: { effort: resolved.thinking.effort } } : {}),
      },
      ...(resolved.contextLimit === undefined ? {} : { contextWindow: resolved.contextLimit }),
    };
  } catch (error) {
    if (error instanceof LocalModelProviderError) {
      throw options.createError('INVALID_ARGUMENTS', `Model is not available: ${error.message}`);
    }
    throw error;
  }
}

/** A failure before anything was dispatched: nothing ran, so the caller may retry. */
async function beforeDispatch<T>(
  options: AgentTurnSessionOptions,
  context: { readonly stage: string; readonly sessionId: string; readonly requestId?: string },
  lookup: () => Promise<T>,
): Promise<T> {
  try {
    return await lookup();
  } catch (error) {
    if (isConsumerError(options, error)) throw error;
    options.logger.warn(
      { ...context, ...errorFields(error) },
      'Agent lookup failed before dispatch',
    );
    throw options.createError('AGENT_UNAVAILABLE', 'Agent session is unavailable', true);
  }
}

/** Unknown outcome: something may have run or been recorded, so a blind retry is not safe. */
function outcomeUnknown(options: AgentTurnSessionOptions, message: string): Error {
  return options.createError('AGENT_OUTCOME_UNKNOWN', message);
}

function errorFields(error: unknown): { readonly errorName: string; readonly error: string } {
  return error instanceof Error
    ? { errorName: error.name, error: error.message }
    : { errorName: typeof error, error: String(error) };
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === 'string' ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key);
  return typeof field === 'number' ? field : undefined;
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
