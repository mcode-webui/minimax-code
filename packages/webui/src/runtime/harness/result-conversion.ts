// Runtime result → WebUI wire DTO, member by member.
//
// The harness port promises WebUI shapes. The runtime answers with its own view
// types, which are the same information arranged differently — and in a few
// places arranged differently in a way that matters. Every member that did not
// simply type-check used to be closed with a cast, which moved the difference
// out of sight instead of recording it: a runtime that renamed a field, or began
// returning a value of a type the cast could not see, would have kept compiling
// and failed at the browser.
//
// These functions are that record. Each one names the fields it reads, the ones
// it defaults when the runtime omits or mistypes them, and the ones it refuses —
// so a shape change stops at the boundary that owns it rather than surfacing as
// an undefined field three layers up in a panel.
//
// The rule every function follows: a value the WebUI contract declares as
// required is either read or *failed on*. Guessing a default for an identity
// would produce a review over the wrong repository, and a panel rendering that as
// empty rather than wrong is the worst of the three outcomes.

import type { CliService } from "@mavis/local-runtime-v2/cli-service";
import { SessionTypeView } from "@mavis/local-runtime-v2/cli-service";
import { SessionKind } from "@mavis/protocol/local";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFile,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewFileDiff,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import type { WebuiCanvasDocument } from "../../shared/contracts/canvas.js";
import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type {
  WebuiRuntimeEvent,
  WebuiStreamFrame,
  WebuiStreamResult,
} from "../../shared/contracts/stream.js";
import type { WebuiWorkspaceFile } from "../../shared/contracts/workspace.js";
import type { WebuiRuntimeAttachment } from "./host-contract.js";
import type { WebuiEnqueueMessageResult } from "../../shared/contracts/queue.js";
import type { WebuiEditSessionMessageResult } from "../../shared/contracts/session.js";
import type { WebuiPendingPermission } from "../../shared/contracts/interactions.js";
import type {
  WebuiMessage,
  WebuiMessagesResult,
} from "../../shared/contracts/messages.js";
import type {
  WebuiFileDiffInfoView,
  WebuiSessionListItem,
  WebuiSessionPage,
  WebuiSessionTreePage,
  WebuiGetSessionDiffResult,
  WebuiTurnDiffView,
  WebuiRevertTurnDiffResult,
  WebuiReapplyTurnDiffResult,
} from "../../shared/contracts/session.js";

type RuntimeResult<K extends keyof CliService> = Awaited<
  ReturnType<CliService[K]>
>;
type RuntimeSession = RuntimeResult<"listSessions">["sessions"][number];
type RuntimeChildSession =
  RuntimeResult<"getSessionTree">["sessions"][number]["childSessions"][number];
type RuntimeReviewFile =
  RuntimeResult<"getWorkspaceReviewSummary">["files"][number];
type RuntimeReviewDiff =
  RuntimeResult<"listWorkspaceReviewFileDiffs">["diffs"][number];
type RuntimeStream = RuntimeResult<"sendMessage">;
type StreamSource = Extract<RuntimeStream, { ok: true }>["source"];
type Yielded<T> = T extends AsyncIterable<infer Item> | Iterable<infer Item>
  ? Item
  : never;
type RuntimeFrame = Yielded<StreamSource>;
type RuntimeEvent = Yielded<ReturnType<CliService["watchEvents"]>>;

function isAsyncSource<T>(
  source: AsyncIterable<T> | Iterable<T>,
): source is AsyncIterable<T> {
  return Symbol.asyncIterator in Object(source);
}

/**
 * A runtime value that could not be converted.
 *
 * Carries `capability_unavailable` so a shape drift reaches the browser as "this
 * host cannot answer" rather than as a `harness_error` a user is invited to
 * retry — retrying a deterministic conversion failure is how a permanent break
 * turns into an error the user can never dismiss.
 */
export class WebuiResultShapeError extends Error {
  readonly code = "capability_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "WebuiResultShapeError";
  }
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebuiResultShapeError(
      "expected a record from the runtime, got a different shape",
    );
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const count = (value: unknown): number =>
  typeof value === "number" ? value : 0;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) {
    throw new WebuiResultShapeError(
      `the runtime's review result is missing ${what}`,
    );
  }
  return value;
};

/** One reviewed file. `path` and the two counts are what the panel lists. */
function toReviewFile(file: RuntimeReviewFile): WebuiWorkspaceReviewFile {
  return {
    fileId: requiredText(file.fileId, "a file id"),
    path: text(file.path, ""),
    // Git status is required by the wire contract, so an absent one is named
    // rather than dropped: an empty string would render as a file with no status
    // rather than as a runtime answer that left it out.
    status: text(file.status, "unknown"),
    additions: count(file.additions),
    deletions: count(file.deletions),
    ...(typeof file.originalPath === "string"
      ? { originalPath: file.originalPath }
      : {}),
    ...(file.type === "binary" || file.type === "text" ? { type: file.type } : {}),
  };
}

/**
 * The review summary.
 *
 * The three totals are read from the runtime's own counts rather than summed
 * here: the runtime's total can cover files this snapshot deliberately omits, and
 * re-deriving it would silently disagree with the runtime about what was reviewed.
 */
export function toWebuiReviewSummary(
  summary: RuntimeResult<"getWorkspaceReviewSummary">,
): WebuiWorkspaceReviewSummary {
  const totals = summary.totals;
  return {
    repositoryId: text(summary.repositoryId, ""),
    reviewSnapshotId: requiredText(
      summary.reviewSnapshotId,
      "a review snapshot id",
    ),
    files: summary.files.map(toReviewFile),
    totals: {
      files: count(totals.files),
      additions: count(totals.additions),
      deletions: count(totals.deletions),
    },
  };
}

/**
 * One file's diff.
 *
 * A diff the runtime reports as an error carries the code and message and no
 * content, and that is passed through rather than turned into an empty diff: the
 * panel shows the reason, and an empty diff would read as "no changes".
 */
function toReviewDiff(entry: RuntimeReviewDiff): WebuiWorkspaceReviewFileDiff {
  const errorCode = typeof entry.errorCode === "string" ? entry.errorCode : undefined;
  const error = typeof entry.error === "string" ? entry.error : undefined;
  const fileId = requiredText(entry.fileId, "a file id");
  if (errorCode || error) {
    return {
      fileId,
      ...(errorCode ? { errorCode } : {}),
      ...(error ? { error } : {}),
    };
  }
  const diff = entry.diff;
  if (!diff)
    throw new WebuiResultShapeError(
      "the runtime's review entry has neither a diff nor an error",
    );
  const type = diff.type === "binary" ? "binary" : "text";
  return {
    fileId,
    diff: {
      type,
      content: text(diff.content, ""),
      ...(typeof diff.diff === "string" ? { diff: diff.diff } : {}),
      ...(typeof diff.previewState === "string"
        ? { previewState: diff.previewState }
        : {}),
    },
  };
}

export function toWebuiReviewDiffs(
  diffs: RuntimeResult<"listWorkspaceReviewFileDiffs">,
): WebuiWorkspaceReviewDiffs {
  return {
    reviewSnapshotId: requiredText(
      diffs.reviewSnapshotId,
      "a review snapshot id",
    ),
    diffs: diffs.diffs.map(toReviewDiff),
  };
}

/**
 * One side of one file.
 *
 * `side` is not defaulted. The two sides are different content, so a diff that
 * arrives without one would be attributed to the wrong side of the file and read
 * as a real change that is not in the file at all.
 */
export function toWebuiReviewFileContent(
  content: RuntimeResult<"getWorkspaceReviewFileContent">,
): WebuiWorkspaceReviewFileContent {
  const side = content.side;
  if (side !== "old" && side !== "new") {
    throw new WebuiResultShapeError(
      "the runtime's file content carries no side",
    );
  }
  const error = typeof content.error === "string" ? content.error : undefined;
  return {
    fileId: requiredText(content.fileId, "a file id"),
    path: text(content.path, ""),
    side,
    type: content.type === "binary" ? "binary" : "text",
    ...(typeof content.content === "string" ? { content: content.content } : {}),
    ...(error ? { error } : {}),
  };
}

export function toWebuiReviewSearchResult(
  search: RuntimeResult<"searchWorkspaceReviewDiffs">,
): WebuiWorkspaceReviewSearchResult {
  return {
    reviewSnapshotId: requiredText(
      search.reviewSnapshotId,
      "a review snapshot id",
    ),
    matchedFiles: search.matchedFiles.map((matched) => {
      return {
        fileId: requiredText(matched.fileId, "a file id"),
        path: text(matched.path, ""),
        matchCount: count(matched.matchCount),
      };
    }),
    totalMatches: count(search.totalMatches),
    totalMatchedFiles: count(search.totalMatchedFiles),
    pageIndex: count(search.pageIndex),
    pageSize: count(search.pageSize),
    matchesBeforePage: count(search.matchesBeforePage),
    hasPreviousPage: search.hasPreviousPage === true,
    hasNextPage: search.hasNextPage === true,
  };
}

/**
 * The canvas document.
 *
 * Every node is rebuilt as a plain record. The runtime's node type is an
 * interface, and an interface is not assignable to an index-signature type — so
 * the field the WebUI contract declares (`readonly Record<string, unknown>[]`)
 * could not be satisfied by the runtime's own node type at all, which is exactly
 * the difference this file exists to state. Copying the fields keeps the node
 * opaque to the wire while letting the WebUI's own contract stay independently
 * owned: a new runtime field reaches the panel as an extra key rather than as a
 * type error the cast would have hidden.
 */
export function toWebuiCanvasDocument(
  document: RuntimeResult<"readCanvas">,
): WebuiCanvasDocument {
  return {
    schemaVersion: count(document.schemaVersion),
    canvasId: requiredText(document.canvasId, "a canvas id"),
    sessionId: text(document.sessionId, ""),
    changeSeq: count(document.changeSeq),
    nodes: document.nodes.map((node) => ({
      ...node,
      file: { ...node.file },
      layout: { ...node.layout },
      annotations: node.annotations.map((annotation) => ({
        ...annotation,
        normalizedRect: { ...annotation.normalizedRect },
      })),
    })),
    updatedAtMs: count(document.updatedAtMs),
  };
}

/** The canvas mutation result: the operation's own id plus the document it produced. */
export function toWebuiCanvasApplyResult(
  result: RuntimeResult<"applyCanvas">,
): {
  readonly operationId: string;
  readonly document: WebuiCanvasDocument;
} {
  return {
    operationId: requiredText(result.operationId, "an operation id"),
    document: toWebuiCanvasDocument(result.document),
  };
}

/**
 * An open record the WebUI contract declares as `Record<string, unknown>`.
 *
 * These members are "the runtime decides the shape, the WebUI does not care
 * which one". They were the reason a whole-layer assertion existed: the runtime
 * returns interfaces, and an interface is not assignable to an index-signature
 * type, so `Record<string, unknown>` could not be satisfied by the runtime's own
 * answer no matter how the mirror was written. Copying the fields is the
 * conversion that says what the WebUI contract actually promises — an opaque
 * record — instead of asserting a compatibility that never existed.
 */
export function toWebuiRecord(value: unknown): Record<string, unknown> {
  const source = record(value);
  // Rebuilt rather than returned: the WebUI contract owns a plain record, and
  // handing back the runtime's object would let a later mutation on either side
  // change what the other believes it read.
  return { ...source };
}

export function toWebuiRecordList(
  value: unknown,
): readonly Record<string, unknown>[] {
  return list(value).map(toWebuiRecord);
}

/**
 * The model catalogue.
 *
 * `providerId` and `modelId` are the only fields the wire contract requires, and
 * they are the two a model *is*: an entry that arrives without them is not a
 * model the client could select, and reporting it as one would put a row in the
 * picker that fails when clicked. Everything else is passed through, because
 * `WebuiModelEntry` declares an index signature precisely so a runtime field the
 * WebUI has not named yet still reaches the surface that wants it.
 */
export function toWebuiModelEntries(
  value: unknown,
): readonly WebuiModelEntry[] {
  return list(value).map((entry) => {
    const model = record(entry);
    const providerId = model.providerId;
    const modelId = model.modelId;
    if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) {
      throw new WebuiResultShapeError(
        "the runtime listed a model with no provider id or model id",
      );
    }
    return { ...model, providerId, modelId } as WebuiModelEntry;
  });
}

/**
 * The runtime's view types, as plain records.
 *
 * Most of what remains is one cause wearing different clothes. The runtime
 * declares its answers as `interface`s — `SessionInfoView`, `SessionMessageView`,
 * `FileDiffInfoView` — and the WebUI's wire DTOs declare an index signature, and
 * an interface is not assignable to an index-signature type however alike the
 * two look. No spelling of the declaration closes that gap, which is why these
 * members sat behind a whole-layer assertion rather than behind a missing type.
 *
 * Copying is the conversion that says what the wire contract actually promises:
 * an open record whose named fields mean what the WebUI says they mean. The
 * required-field list is the part that matters, because it is where the WebUI's
 * contract is allowed to be strict: a record missing an identity is not
 * converted into a record with an empty one.
 */
/** The runtime's numeric session type, as the wire's string. */
const SESSION_TYPE_NAMES = {
  [SessionTypeView.Branch]: "branch",
  [SessionTypeView.Root]: "root",
} satisfies Record<SessionTypeView, string>;
const SESSION_KIND_NAMES = {
  [SessionKind.Unknown]: "unknown",
  [SessionKind.Conversation]: "conversation",
  [SessionKind.Task]: "task",
  [SessionKind.Peek]: "peek",
  [SessionKind.Channel]: "channel",
  [SessionKind.Cron]: "cron",
} satisfies Record<RuntimeSession["sessionKind"], string>;

/**
 * A session, as the list and the tree both report it.
 *
 * The one genuinely semantic field is `sessionType`: the runtime sends a number
 * (`SessionTypeView.Root === 1`) and the wire carries a name. Translating it here
 * is what lets a client branch on "is this a root session" without hard-coding
 * the runtime's numbering — and numbering is exactly the kind of thing a
 * migration renumbers.
 */
function toSessionListItem(source: RuntimeSession): WebuiSessionListItem {
  const { sessionType, sessionKind, ...fields } = source;
  return {
    ...fields,
    sessionId: requiredText(source.sessionId, "a session id"),
    agentName: text(source.agentName, ""),
    createdAt: count(source.createdAt),
    updatedAt: count(source.updatedAt),
    sessionKind:
      typeof sessionKind === "string"
        ? sessionKind
        : SESSION_KIND_NAMES[sessionKind],
    ...(typeof sessionType === "number" && SESSION_TYPE_NAMES[sessionType] !== undefined
      ? { sessionType: SESSION_TYPE_NAMES[sessionType] }
      : typeof sessionType === "string"
        ? { sessionType }
        : {}),
  };
}

function toChildSession(source: RuntimeChildSession): WebuiSessionListItem {
  const { sessionKind, ...fields } = source;
  return {
    ...fields,
    sessionId: requiredText(source.sessionId, "a child session id"),
    agentName: text(source.agentName, ""),
    createdAt: count(source.createdAt),
    updatedAt: count(source.updatedAt),
    ...(sessionKind === undefined
      ? {}
      : {
          sessionKind:
            typeof sessionKind === "string"
              ? sessionKind
              : SESSION_KIND_NAMES[sessionKind],
        }),
  };
}

export function toWebuiSessionPage(
  page: RuntimeResult<"listSessions">,
): WebuiSessionPage {
  return {
    sessions: page.sessions.map(toSessionListItem),
    hasMore: page.hasMore === true,
    ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
  };
}

export function toWebuiSessionTreePage(
  page: RuntimeResult<"getSessionTree">,
): WebuiSessionTreePage {
  return {
    sessions: page.sessions.map((parent) => {
      return {
        // The wire nests each session under `session` and its children under
        // `childSessions`; the runtime reports them flat. The nesting is the
        // WebUI's own and the adapter is where the two meet, so a surface reading
        // the tree never has to know the runtime's arrangement.
        session: toSessionListItem(parent.session),
        childSessions: parent.childSessions.map(toChildSession),
      };
    }),
    hasMore: page.hasMore === true,
    ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
  };
}

/** One stored message. `msgId` is the only field the wire cannot do without. */
export function toWebuiMessage(
  value: NonNullable<RuntimeResult<"getMessages">["messages"]>[number],
): WebuiMessage {
  const { toolCalls, ...fields } = value;
  return {
    ...fields,
    msgId: requiredText(value.msgId, "a message id"),
    ...(toolCalls === undefined
      ? {}
      : { toolCalls: toolCalls.map((call) => ({ ...call })) }),
  };
}

export function toWebuiMessagesResult(
  result: RuntimeResult<"getMessages">,
): WebuiMessagesResult {
  const { messages, turnResults, ...fields } = result;
  return {
    ...fields,
    ...(Array.isArray(messages)
      ? { messages: messages.map(toWebuiMessage) }
      : {}),
    ...(turnResults === undefined
      ? {}
      : { turnResults: turnResults.map((turn) => ({ ...turn })) }),
  };
}

/** A diff entry. Its identity is the pair that names which file and which side. */
export function toWebuiFileDiff(
  value: NonNullable<RuntimeResult<"getSessionDiff">["diffs"]>[number],
): WebuiFileDiffInfoView {
  const { patch, ...fields } = value;
  return {
    ...fields,
    file: requiredText(value.file, "a diff file path"),
    ...(patch === undefined ? {} : { patch: { ...patch } }),
  };
}

/**
 * A diff answer.
 *
 * Each operation keeps its own inferred host input. Nested turn/file diffs
 * are converted explicitly while the operation's remaining fields are copied.
 */
export function toWebuiSessionDiff(
  result: RuntimeResult<"getSessionDiff">,
): WebuiGetSessionDiffResult {
  const { diffs, ...fields } = result;
  return {
    ...fields,
    ...(diffs === undefined ? {} : { diffs: diffs.map(toWebuiFileDiff) }),
  };
}

export function toWebuiTurnDiff(
  result: RuntimeResult<"getTurnDiff">,
): WebuiTurnDiffView {
  const { fileChanges, ...fields } = result;
  return {
    ...fields,
    ...(fileChanges === undefined
      ? {}
      : { fileChanges: fileChanges.map(toWebuiFileDiff) }),
  };
}

export function toWebuiRevertResult(
  result: RuntimeResult<"revertTurnDiff">,
): WebuiRevertTurnDiffResult {
  const { turnDiff, ...fields } = result;
  return {
    ...fields,
    ...(turnDiff === undefined ? {} : { turnDiff: toWebuiTurnDiff(turnDiff) }),
  };
}

export function toWebuiReapplyResult(
  result: RuntimeResult<"reapplyTurnDiff">,
): WebuiReapplyTurnDiffResult {
  return {
    ...toWebuiTurnDiff(result),
    success: result.success,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/** One workspace tree entry, recursively. */
export function toWebuiWorkspaceFiles(
  value: unknown,
): readonly WebuiWorkspaceFile[] {
  return list(value).map((entry) => {
    const node = record(entry);
    return {
      ...node,
      path: requiredText(node.path, "a path"),
      name: requiredText(node.name, "a name"),
      ...(typeof node.type === "string" ? { type: node.type } : {}),
      ...(Array.isArray(node.children)
        ? { children: toWebuiWorkspaceFiles(node.children) }
        : {}),
    } as WebuiWorkspaceFile;
  });
}

/**
 * One pending permission request.
 *
 * Every field here is required, and `ruleContents` is the one that must not be
 * defaulted: it is the list the dialog shows the user as the thing being asked
 * for. An empty list would render a permission request that grants nothing and
 * explains nothing, which is the one outcome worse than refusing the read.
 */
export function toWebuiPendingPermissions(
  value: RuntimeResult<"listPendingPermissions">["requests"],
): readonly WebuiPendingPermission[] {
  return (value ?? []).map((request) => {
    if (!Array.isArray(request.ruleContents)) {
      throw new WebuiResultShapeError(
        "the runtime listed a permission request with no rule contents",
      );
    }
    return {
      ...request,
      requestId: requiredText(request.requestId, "a request id"),
      sessionId: requiredText(request.sessionId, "a session id"),
      agentName: text(request.agentName, ""),
      toolName: text(request.toolName, ""),
      ruleContents: request.ruleContents.map((rule) => String(rule)),
      reason: text(request.reason, ""),
      allowAlwaysSupported: request.allowAlwaysSupported === true,
      createdAt: count(request.createdAt),
    };
  });
}

/**
 * The compaction answer.
 *
 * An open record on both sides; the runtime simply answers with an interface, so
 * the conversion copies it.
 */
export function toWebuiCompactionResult(
  value: unknown,
): Record<string, unknown> {
  return toWebuiRecord(value);
}

/**
 * A session-stream answer: an iterable source of frames, or a structured failure.
 *
 * Both `sendMessage` and `resumeSession` answer with this envelope, and the
 * conversion has two halves because the difference is in two places. The failure
 * body already carries the wire's `key`/`message`/`detail`, so it is copied
 * rather than reshaped. The frames are not: the runtime's view type declares
 * `messageActionDeltas` as its own interface, and the wire declares the list as
 * open records — the same index-signature gap as everywhere else, reached here
 * through an iterator.
 *
 * The source is wrapped rather than drained. A session stream is unbounded and
 * long-lived; collecting it to convert it would turn "start a turn" into "buffer
 * the whole turn", which is the failure mode this conversion exists to avoid.
 * Each frame is converted as it is pulled, so a shape drift surfaces at the
 * frame that caused it instead of after the stream has already ended.
 */
export function toWebuiStreamResult(
  envelope: RuntimeStream,
): WebuiStreamResult {
  if (envelope.ok !== true) {
    const body = envelope.body;
    return {
      ok: false,
      status: count(envelope.status),
      body: {
        ...(typeof body.key === "string" ? { key: body.key } : {}),
        // `message` is required by the wire and by every reader of a failed
        // stream. A failure body without one is not a failure a caller can
        // report, so it is refused here rather than turned into an empty string.
        message: requiredText(body.message, "a failure message"),
        ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
      },
    };
  }
  const source = envelope.source;
  const toFrame = (frame: RuntimeFrame): WebuiStreamFrame => {
    const { messageActionDeltas, ...fields } = frame;
    return {
      ...fields,
      ...(Array.isArray(messageActionDeltas)
        ? {
            messageActionDeltas: messageActionDeltas.map((delta) => ({
              ...delta,
            })),
          }
        : {}),
    };
  };
  if (isAsyncSource(source)) {
    return {
      ok: true,
      source: {
        [Symbol.asyncIterator](): AsyncIterator<WebuiStreamFrame> {
          const iterator = source[Symbol.asyncIterator]();
          return {
            // The final step carries `value: undefined`; converting that would
            // read a frame that was never sent. Only a yielded value is a frame.
            next: async () => {
              const step = await iterator.next();
              if (step.done) return { done: true as const, value: undefined };
              return { done: false as const, value: toFrame(step.value) };
            },
            return: async (value?: unknown) => {
              await iterator.return?.(value);
              return { done: true as const, value: undefined };
            },
          };
        },
      },
    };
  }
  return { ok: true, source: [...source].map(toFrame) };
}

/**
 * The event stream, as the wire's event.
 *
 * Same cause as the stream frames, and the same answer: the runtime's event
 * `payload` is a discriminated union keyed by event type, and the wire declares
 * it as an open record. A union of interfaces cannot satisfy an index signature,
 * so this wraps the iterable and copies each payload as it is pulled — never
 * draining it, because this stream runs for the life of the application.
 *
 * `type`, `timestamp` and `source` are passed through rather than rebuilt: they
 * are the event's identity, and an event that arrived without a type could not be
 * routed to the surface that cares about it, so that is refused.
 */
export function toWebuiEventStream(
  source: AsyncIterable<RuntimeEvent>,
): AsyncIterable<WebuiRuntimeEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WebuiRuntimeEvent> {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: async () => {
          const step = await iterator.next();
          if (step.done) return { done: true as const, value: undefined };
          return {
            done: false as const,
            value: toWebuiRuntimeEvent(step.value),
          };
        },
        return: async (value?: unknown) => {
          await iterator.return?.(value);
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

function toWebuiRuntimeEvent(event: RuntimeEvent): WebuiRuntimeEvent {
  return {
    type: requiredText(event.type, "an event type"),
    timestamp: count(event.timestamp),
    source: text(event.source, "local-runtime"),
    payload: toWebuiRecord(event.payload),
  };
}

/**
 * The queue-answer and the edit-answer, both rebuilt field by field.
 *
 * Both are closed contracts — every field is named and the type has no index
 * signature — so unlike the open-record members they cannot be satisfied by
 * copying. Naming each field is the conversion: it states what the WebUI expects
 * from an edit that rewound a turn and from a queue item's position, instead of
 * asserting that the runtime's answer happens to have those fields.
 */
export function toWebuiEnqueueResult(
  result: RuntimeResult<"enqueueMessage">,
): WebuiEnqueueMessageResult {
  return {
    ...result,
    ...(typeof result.itemId === "string" ? { itemId: result.itemId } : {}),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.position === "number" ? { position: result.position } : {}),
  };
}

export function toWebuiEditMessageResult(
  result: RuntimeResult<"editSessionMessage">,
): WebuiEditSessionMessageResult {
  // `rewound` is the whole answer: whether the edit actually rewound the turn.
  // Defaulting it would tell the transcript to re-render as though it had.
  if (typeof result.rewound !== "boolean") {
    throw new WebuiResultShapeError(
      "the runtime's message-edit result says nothing about whether it rewound",
    );
  }
  return {
    ...result,
    rewound: result.rewound,
    ...(Array.isArray(result.deletedMessageIds)
      ? { deletedMessageIds: result.deletedMessageIds.map((id) => String(id)) }
      : {}),
  };
}

/**
 * A request whose attachments the runtime wants as a mutable list.
 *
 * `WebuiAttachmentInput` is `readonly` all the way down —
 * which is right for a wire contract a surface builds — while the runtime's
 * `AttachmentInput` is mutable, because it keeps and normalises what it is
 * given. The two agree field for field; only the variance differs.
 *
 * Copying the list is the conversion. It is done here, in the adapter, rather
 * than by loosening the wire contract to be mutable: a contract that other code
 * can write to after the fact is a contract nobody can rely on.
 */
/** A string the request must carry, or the shape is refused rather than forwarded. */
export function asText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) {
    throw new WebuiResultShapeError(`the request is missing ${what}`);
  }
  return value;
}

export function toRuntimeAttachmentRequest<
  T extends { readonly attachments?: readonly unknown[] },
>(
  request: T,
): Omit<T, "attachments"> & {
  readonly attachments?: WebuiRuntimeAttachment[];
} {
  const attachments = request.attachments;
  if (attachments === undefined)
    return request as Omit<T, "attachments"> & {
      readonly attachments?: WebuiRuntimeAttachment[];
    };
  return {
    ...request,
    attachments: attachments.map(
      (attachment) => ({ ...record(attachment) }) as WebuiRuntimeAttachment,
    ),
  };
}
