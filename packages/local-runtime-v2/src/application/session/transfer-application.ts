// Session transfer: the runtime half of an export/import round trip.
//
// A conversation is stored in two places that no one keeps in sync, and
// neither is derivable from the other:
//
//   - canonical history -- what the model is actually shown on the next turn.
//     Lives in `<dataDir>/v2/sessions/<date>/messages.jsonl` and is reached
//     only through `SessionHistoryMutationCapability`.
//   - the display projection -- what the sidebar and the transcript render.
//     Rows in `local_runtime_message_rows`, reached through `MessageRepository`.
//
// Storing either one alone is unrecoverable. Canonical alone leaves the
// transcript empty; display alone leaves the model blind to the conversation.
// So the transfer file carries both, and this class is the only place that
// knows how to read and write each.
//
// Both halves are read through the repositories rather than through
// `getMessages`, deliberately. `getMessages` is a *view*: it runs
// `staleCompactionRepair`, then `conversationActions.project`, then
// `toSessionMessageView`, and the last step only preserves the full record
// when `rawJson` happens to be populated. Measured against real sessions that
// silently drops `operationId` and `committedRevision` -- the receipts that tie
// a compaction row back to its canonical mutation -- on roughly 1% of rows.
// A transfer file built from that view cannot be imported back without
// losing them.

import type {
  CanonicalHistoryEnvelope,
  DisplayMessageRecord,
  MessageRepository,
  SessionHistoryMutationCapability,
  SessionHistorySnapshot,
} from "../../service/session-system/index.js";

export const SESSION_TRANSFER_FORMAT = "mcode-webui-session-transfer@1";

/** One canonical history line, kept verbatim. */
export interface SessionTransferEnvelope {
  readonly message_id: string;
  readonly turn_id: string;
  readonly message: unknown;
  readonly turn_config?: unknown;
  readonly history_artifact?: unknown;
}

export interface SessionTransferFile {
  readonly format: typeof SESSION_TRANSFER_FORMAT;
  readonly exportedAt: string;
  readonly session: {
    /** The session this came from. Informational; the importer mints its own. */
    readonly sessionId: string;
    readonly title: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
  };
  readonly canonical: {
    readonly envelopes: readonly SessionTransferEnvelope[];
    /**
     * Compaction snapshots the active file is chained to.
     *
     * These are not optional history. Each generation's file carries a marker
     * naming its parent by `(generation, compactionId)`, and the scanner
     * walks the whole lineage before it will accept a file -- importing the
     * active generation alone fails with `parent-snapshot-missing` as soon as
     * the session has ever been compacted.
     */
    readonly snapshots: readonly SessionTransferSnapshot[];
    readonly generation: number;
    readonly revision: string;
  };
  readonly display: {
    readonly messages: readonly DisplayMessageRecord[];
  };
}

export interface SessionTransferSnapshot {
  readonly generation: number;
  readonly fileName: string;
  readonly revision: string;
  readonly records: readonly SessionTransferEnvelope[];
}

export interface SessionTransferApplicationOptions {
  readonly messages: Pick<MessageRepository, "list" | "replace">;
  readonly historyMutation: Pick<SessionHistoryMutationCapability, "read" | "stageFork">;
  readonly now: () => number;
}

/** What the importer is handed: a target to fill and an untrusted payload. */
export interface ImportSessionTransferRequest {
  /** The freshly created session that will receive the history. */
  readonly targetSessionId: string;
  /** Informational; recorded by `stageFork` as the lineage. */
  readonly sourceSessionId?: string;
  readonly file: unknown;
}

export interface ImportSessionTransferResult {
  readonly sessionId: string;
  readonly canonicalMessages: number;
  readonly displayMessages: number;
  readonly revision: string;
}

export class SessionTransferError extends Error {
  override readonly name = "SessionTransferError";
  constructor(
    readonly code:
      | "not-a-transfer-file"
      | "malformed-transfer-file"
      | "empty-transfer",
    message: string,
  ) {
    super(message);
  }
}

export class SessionTransferApplication {
  constructor(private readonly options: SessionTransferApplicationOptions) {}

  /**
   * Read both layers of a session.
   *
   * `messages.list` with no `limit` returns every row in one pass -- the
   * repository treats a missing limit as "unbounded" rather than applying a
   * default -- so there is no cursor loop here and no page-ordering hazard.
   */
  async read(sessionId: string): Promise<SessionTransferFile> {
    const history = await this.options.historyMutation.read(sessionId);
    const page = await this.options.messages.list(sessionId);
    return {
      format: SESSION_TRANSFER_FORMAT,
      exportedAt: new Date(this.options.now()).toISOString(),
      session: { sessionId, title: sessionId },
      canonical: {
        envelopes: history.active.map(toTransferEnvelope),
        snapshots: history.snapshots.map((snapshot) => ({
          generation: snapshot.generation,
          fileName: snapshot.fileName,
          revision: snapshot.revision,
          records: snapshot.records.map(toTransferEnvelope),
        })),
        generation: history.activeGeneration,
        revision: history.revision,
      },
      display: { messages: [...page.messages] },
    };
  }

  /**
   * Recreate both layers in `targetSessionId` from a parsed transfer file.
   *
   * Idempotent by construction: the display write is a full replace, and
   * re-publishing identical canonical envelopes hits `publishFork`'s
   * "already contains this revision" branch and leaves the file alone. A run
   * that dies between the two writes can simply be run again.
   *
   * The canonical write goes through `stageFork` rather than a per-turn
   * append, which is what makes this cheap as well as faithful: `stageFork`
   * writes the supplied envelopes verbatim, so message ids, turn ids and
   * per-turn config all survive byte-for-byte, and it does so in a single
   * publication instead of one full read-validate-rewrite per turn.
   */
  async write(input: ImportSessionTransferRequest): Promise<ImportSessionTransferResult> {
    const parsed = parseSessionTransferFile(input.file);
    const sourceSessionId = input.sourceSessionId ?? input.targetSessionId;

    await this.options.historyMutation
      .stageFork({
        sourceSessionId,
        targetSessionId: input.targetSessionId,
        // Never taken from the payload: `operationId` becomes a directory
        // name under the session, and the payload is untrusted input.
        operationId: `session-import-${input.targetSessionId}-${this.options.now()}`,
        generation: parsed.canonical.generation,
        active: parsed.canonical.envelopes.map(toCanonicalEnvelope),
        snapshots: parsed.canonical.snapshots.map(toCanonicalSnapshot),
      })
      .then((staged) => staged.publish());

    await this.options.messages.replace({
      sessionId: input.targetSessionId,
      messages: [...parsed.display.messages],
    });

    return {
      sessionId: input.targetSessionId,
      canonicalMessages: parsed.canonical.envelopes.length,
      displayMessages: parsed.display.messages.length,
      revision: parsed.canonical.revision,
    };
  }
}

/**
 * Validate an untrusted payload before anything is written.
 *
 * Every field the writer relies on is checked here rather than trusted, so a
 * hand-edited or truncated file fails with a clear error instead of
 * half-populating a session.
 */
export function parseSessionTransferFile(value: unknown): SessionTransferFile {
  if (!isRecord(value)) {
    throw new SessionTransferError("not-a-transfer-file", "Transfer payload is not an object");
  }
  if (value.format !== SESSION_TRANSFER_FORMAT) {
    throw new SessionTransferError(
      "not-a-transfer-file",
      `Unsupported transfer format: ${String(value.format)}`,
    );
  }
  const canonical = isRecord(value.canonical) ? value.canonical : undefined;
  const display = isRecord(value.display) ? value.display : undefined;
  const rawEnvelopes = canonical?.envelopes;
  const rawMessages = display?.messages;
  if (!Array.isArray(rawEnvelopes) || !Array.isArray(rawMessages)) {
    throw new SessionTransferError(
      "malformed-transfer-file",
      "Transfer payload is missing its canonical or display layer",
    );
  }

  const envelopes = rawEnvelopes.map(toTransferEnvelope);
  const rawSnapshots = canonical?.snapshots === undefined ? [] : canonical.snapshots;
  if (!Array.isArray(rawSnapshots)) {
    throw new SessionTransferError(
      "malformed-transfer-file",
      "Transfer payload has a non-array canonical snapshot set",
    );
  }
  const snapshots = rawSnapshots.map(toTransferSnapshot);
  const generation = canonical?.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new SessionTransferError(
      "malformed-transfer-file",
      "Transfer payload has no usable canonical generation",
    );
  }
  if (envelopes.length === 0 && rawMessages.length === 0) {
    throw new SessionTransferError("empty-transfer", "Transfer payload carries no messages");
  }
  const generations = snapshots.map((snapshot) => snapshot.generation);
  if (new Set(generations).size !== generations.length) {
    throw new SessionTransferError(
      "malformed-transfer-file",
      "Transfer payload repeats a snapshot generation",
    );
  }

  const session = isRecord(value.session) ? value.session : {};
  const revision = typeof canonical?.revision === "string" ? canonical.revision : "";

  return {
    format: SESSION_TRANSFER_FORMAT,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
    session: {
      sessionId: typeof session.sessionId === "string" ? session.sessionId : "",
      title: typeof session.title === "string" ? session.title : "",
      ...(typeof session.agentName === "string" ? { agentName: session.agentName } : {}),
      ...(typeof session.workspaceDir === "string"
        ? { workspaceDir: session.workspaceDir }
        : {}),
    },
    canonical: { envelopes, snapshots, generation: generation as number, revision },
    display: { messages: rawMessages.filter(isRecord) as DisplayMessageRecord[] },
  };
}

function toTransferSnapshot(value: unknown): SessionTransferSnapshot {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    typeof value.fileName !== "string" ||
    !value.fileName ||
    typeof value.revision !== "string" ||
    !Array.isArray(value.records)
  ) {
    throw new SessionTransferError(
      "malformed-transfer-file",
      "Transfer payload contains a snapshot without a generation, file name and revision",
    );
  }
  return {
    generation: value.generation as number,
    // The file name becomes a path under the session's snapshot directory, so
    // only its last segment may survive -- a payload that names `../../x`
    // must not be able to place a file outside it.
    fileName: value.fileName.split(/[/\\]/u).pop() ?? value.fileName,
    revision: value.revision,
    records: value.records.map(toTransferEnvelope),
  };
}

function toCanonicalSnapshot(snapshot: SessionTransferSnapshot): SessionHistorySnapshot {
  return {
    generation: snapshot.generation,
    fileName: snapshot.fileName,
    revision: snapshot.revision,
    records: snapshot.records.map(toCanonicalEnvelope),
  };
}

function toTransferEnvelope(value: unknown): SessionTransferEnvelope {
  if (
    !isRecord(value) ||
    typeof value.message_id !== "string" ||
    !value.message_id ||
    typeof value.turn_id !== "string" ||
    !value.turn_id
  ) {
    throw new SessionTransferError(
      "malformed-transfer-file",
      "Transfer payload contains a canonical entry without message_id and turn_id",
    );
  }
  return {
    message_id: value.message_id,
    turn_id: value.turn_id,
    message: value.message,
    ...(value.turn_config === undefined ? {} : { turn_config: value.turn_config }),
    ...(value.history_artifact === undefined
      ? {}
      : { history_artifact: value.history_artifact }),
  };
}

function toCanonicalEnvelope(envelope: SessionTransferEnvelope): CanonicalHistoryEnvelope {
  return {
    message_id: envelope.message_id,
    turn_id: envelope.turn_id,
    message: envelope.message as CanonicalHistoryEnvelope["message"],
    ...(envelope.turn_config === undefined
      ? {}
      : { turn_config: envelope.turn_config as CanonicalHistoryEnvelope["turn_config"] }),
    ...(envelope.history_artifact === undefined
      ? {}
      : {
          history_artifact:
            envelope.history_artifact as CanonicalHistoryEnvelope["history_artifact"],
        }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
