import { isWebuiWireError } from "../../shared/envelope.js";

// The request/freshness primitive.
//
// One cached read has to answer three questions that a state container plus a
// request counter cannot: *which resource* the answer belongs to, whether the
// answer is still the one that should be visible, and whether an in-flight
// request is still allowed to land. The old `query-store.ts` fenced by an
// arbitrary string key but wrote into an independent destination field, so two
// keys could write one field and both stay "current" — a probe returned B and
// then a late A overwrote it. This module is the repair, expressed as two
// explicit contracts rather than one loose helper:
//
//   * **Keyed resource** — answers live under a resource key. The key carries
//     every response-affecting input (session/agent context, an opaque
//     credential/config generation, a snapshot or changeset identity), so a late
//     answer populates *its own* entry and cannot overwrite another entry or the
//     view selection. Identity and storage are the same thing here, which is the
//     invariant the probe showed was missing.
//   * **Selected slot** — one destination with an owning identity and a selection
//     generation. Switching identity invalidates the commit token even when the
//     resource itself is still current, which is what the active-only queue
//     mirror and the single catalogue selection need.
//
// Three rules hold for both:
//
//   * a commit requires the owner incarnation and the request generation to be
//     current, and (for a slot) the selected identity to still be selected;
//   * `invalidate` advances freshness *before* a new read is scheduled, so a
//     pre-invalidation answer cannot mark invalidated data fresh, and a read
//     started before an invalidation is never joined as if it repaired the newer
//     revision;
//   * coalescing happens only when the resource key, the freshness revision and
//     the owner incarnation all match.
//
// Disposal fences everything: no commit, no scheduling, no coalescing. The
// primitive owns mechanics only — which key a business uses, and what a write
// invalidates, stay with the business.
//
// The *shared protocol* the business owners build on has three parts:
//
//   * **Injective keys.** `serializeWebuiResourceKey` encodes each field with an
//     explicit type tag and a length prefix, so a string, a number, a boolean,
//     `null`, `undefined` and an absent field are six different resources rather
//     than whatever `String()` happens to produce. Property order is irrelevant.
//     Unsupported values are rejected rather than coerced, because a key that
//     silently collapses two reads into one entry is the defect this module
//     exists to remove.
//   * **A request-bound outcome.** `load` resolves to *what its own request
//     produced*: `ready` with the commit token that actually committed, or
//     `superseded`, `disposed` and `failed` with the original error. A caller no
//     longer re-reads a shared entry to find out whether its answer is the
//     current one.
//   * **Scoped epoch activation.** `bindEpoch` retires exactly the keys a
//     generation is responsible for. An epoch advancing while some other key is
//     selected leaves that key alone — subscribing one key never invalidates
//     another.

/** A response-affecting input of a resource key. */
export type WebuiResourceKeyValue = string | number | boolean | null | undefined;

/** A resource key: the response-affecting inputs of one read. */
export type WebuiResourceKey = Readonly<Record<string, WebuiResourceKeyValue>>;

/** The state of one cached read, keyed or selected. */
export interface WebuiResourceState<T> {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly value?: T;
  readonly error?: string;
}

/** The state of one cached read, before anyone has asked for it. */
export function idleWebuiResourceState<T>(): WebuiResourceState<T> {
  return { status: "idle" };
}

/** A failure's message, for the error field of a cached read. */
export function webuiResourceMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * What one `load` produced.
 *
 * `ready` carries the token that actually committed, so a caller can keep asking
 * "is this still the answer for my request" without holding a second copy of the
 * revision. Every other branch is a distinct refusal to know, and collapsing
 * them — which is what a shared `Promise<void>` did — is how a superseded read
 * came to present itself as an empty one.
 */
export type WebuiResourceLoadOutcome<T> =
  | { readonly status: "ready"; readonly token: WebuiCommitToken; readonly value: T }
  | { readonly status: "superseded" }
  | { readonly status: "disposed" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * An opaque generation whose advance retires the answers computed under it.
 *
 * The primitive does not import the epoch module: this is the structural shape it
 * needs, so the mechanism layer keeps no dependency on an application owner and a
 * business adapts its own generation source into it.
 */
export interface WebuiEpochBinding {
  /** The generation's current token; a resource key carries it as a field. */
  readonly token: () => string;
  /** Invoked when the generation advances. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Encodes one key value with an explicit type tag and a length prefix.
 *
 * The length prefix is what makes the encoding injective without escaping: no
 * string can forge a boundary, so a session id containing the separator
 * character cannot collide with a different field's value. `-0` is normalized to
 * `0` because they are the same number, and a non-finite number is rejected
 * rather than written as `"NaN"`, which would collide with a real `"NaN"` id.
 */
function encodeWebuiResourceKeyValue(value: WebuiResourceKeyValue): string {
  if (value === null) return "z";
  if (value === undefined) return "u";
  switch (typeof value) {
    case "string":
      return `s${value.length}:${value}`;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `A resource key cannot carry a non-finite number (${String(value)}): it would be indistinguishable from the string of the same text.`,
        );
      }
      return `n${Object.is(value, -0) ? "0" : String(value)}`;
    case "boolean":
      return value ? "b1" : "b0";
    default:
      throw new TypeError(
        `A resource key cannot carry a value of type ${typeof value}: only string, finite number, boolean, null, undefined and absence are distinct resources.`,
      );
  }
}

/**
 * Serializes a key so equal keys compare equal and unequal keys cannot collide.
 *
 * Fields are sorted, so property order is irrelevant, and every field is written
 * whether or not its value is `undefined`, so `{a: undefined}` and `{}` are
 * different resources. "No session" and "a session whose id is absent" are not
 * the same read.
 *
 * This encoding is internal: it identifies an entry inside one running client and
 * is never written to disk or sent as a product format.
 */
export function serializeWebuiResourceKey(key: WebuiResourceKey): string {
  return Object.keys(key)
    .sort()
    .map((name) => `${name.length}:${name}=${encodeWebuiResourceKeyValue(key[name])}`)
    .join("&");
}

/**
 * A commit token: everything a commit is checked against. It is minted by
 * `capture` and consumed by `commit`, which is what makes the owner-incarnation
 * fence observable rather than internal — a token captured by one owner and
 * handed to another (a recreated owner, a different primitive instance) is
 * rejected instead of landing.
 */
export interface WebuiCommitToken {
  readonly resource: string;
  readonly revision: number;
  readonly incarnation: number;
}

export interface WebuiKeyedResource<T> {
  /** The entry for one key, or `undefined` when nothing has been read for it. */
  readonly read: (key: WebuiResourceKey) => WebuiResourceState<T> | undefined;
  /** Mints the token a commit for this key must carry. */
  readonly capture: (key: WebuiResourceKey) => WebuiCommitToken;
  /**
   * Commits one state under a captured token. Returns whether it landed: a
   * token from another owner, a superseded revision or a disposed resource is
   * refused rather than written.
   */
  readonly commit: (token: WebuiCommitToken, state: WebuiResourceState<T>) => boolean;
  /**
   * Reads the resource under its key and reports what this request produced. A
   * call whose key, freshness revision and owner incarnation all match an
   * in-flight request joins that request instead of starting a second one, and
   * receives the same outcome; any difference starts a new one.
   */
  readonly load: (
    key: WebuiResourceKey,
    fetch: () => Promise<T>,
  ) => Promise<WebuiResourceLoadOutcome<T>>;
  /**
   * Advances the key's freshness. An answer already in flight for the previous
   * revision can no longer commit, and a later read cannot join it.
   */
  readonly invalidate: (key: WebuiResourceKey) => void;
  /**
   * Retires exactly the keys this generation is responsible for, when the
   * generation advances. One binding covers one key, so subscribing a key never
   * invalidates another and an epoch advancing while an unrelated key is
   * selected leaves that key untouched. Returns the unbind.
   */
  readonly bindEpoch: (binding: WebuiEpochBinding, key: WebuiResourceKey) => () => void;
  /** The freshness revision a key currently holds; exposed for tests and owners. */
  readonly revision: (key: WebuiResourceKey) => number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
  /** True once disposed: nothing else is accepted. */
  readonly isDisposed: () => boolean;
  /** How many resource keys hold an entry; a cardinality check, not a cache policy. */
  readonly size: () => number;
  /** Retires one detail identity, including cached data and safe metadata. */
  readonly release: (key: WebuiResourceKey) => void;
  readonly retention: () => { readonly entries: number; readonly revisions: number;
    readonly inFlight: number; readonly epochBindings: number; readonly listeners: number };
}

/**
 * A commit token for a selected slot: the identity that was selected, the
 * selection generation and the owner incarnation. `commit` refuses it when any
 * of the three moved.
 */
export interface WebuiSlotCommitToken {
  readonly identity: string;
  readonly generation: number;
  readonly incarnation: number;
}

export interface WebuiSelectedSlot<T> {
  readonly read: () => WebuiResourceState<T> | undefined;
  /** The identity the slot currently belongs to. */
  readonly identity: () => string | undefined;
  /** Mints the token a commit for this identity must carry. */
  readonly capture: () => WebuiSlotCommitToken;
  /** Commits one state under a captured token; returns whether it landed. */
  readonly commit: (token: WebuiSlotCommitToken, state: WebuiResourceState<T>) => boolean;
  /**
   * Points the slot at an identity and advances its selection generation. A
   * commit captured for the previous identity — or for an earlier selection of
   * the same identity — is rejected afterwards.
   */
  readonly select: (identity: string | undefined) => void;
  /**
   * Reads for the selected identity and commits only if that identity is still
   * selected with the same generation. An answer for an identity that is no
   * longer selected is dropped rather than shown.
   */
  readonly load: (identity: string, fetch: () => Promise<T>) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
}

/** Why a write did not settle, in terms a caller can branch on. */
export type WebuiMutationFailureCategory =
  /** The runtime answered and refused: a refusal is a settled verdict. */
  | "refused"
  /** The write's own precondition moved: a newer revision owns the resource. */
  | "conflict"
  /** The response never arrived: the command may or may not have taken effect. */
  | "lost"
  /** The call exceeded its budget. Treated as lost, not as a refusal. */
  | "timeout"
  /** Anything else the transport raised. */
  | "transport";

/**
 * What one write produced.
 *
 * A caller that only sees a rejection cannot tell a refusal from a lost
 * response, and those two need opposite follow-up: one re-reads, the other must
 * not assume the write landed. The category is what makes that branch possible
 * without matching on message text.
 */
export type WebuiMutationOutcome<T = unknown> =
  | { readonly status: "settled"; readonly value: T }
  | {
      readonly status: "failed";
      readonly category: WebuiMutationFailureCategory;
      readonly error: unknown;
    };

/** The error a raised value carries, for the `failed` branch's `error` field. */
function mutationError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Classifies a raised write into a branchable category.
 *
 * `refused` and `conflict` are answers — the runtime decided — and are carried by
 * a structured error the command layer raises. Everything else is a transport
 * fact, and a transport that named a timeout is reported as one rather than
 * folded into `lost`, because the two lead to different retries.
 */
export function classifyWebuiMutationFailure(reason: unknown): WebuiMutationFailureCategory {
  if (reason instanceof WebuiRefusedError) return "refused";
  if (reason instanceof WebuiRevisionConflictError) return "conflict";
  if (isWebuiWireError(reason)) {
    if (reason.code === "revision_conflict") return "conflict";
    if (["permission_denied", "capability_unavailable", "runtime_rejected", "unknown_operation"].includes(reason.code)) return "refused";
    // A malformed response or a harness exception may follow a committed write.
    // Preserve the error and reconcile that unknown outcome instead of retrying.
  }
  const name = reason instanceof Error ? reason.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "transport";
}

/** A write the runtime answered and refused. */
export class WebuiRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebuiRefusedError";
  }
}

/** A write whose precondition revision was already superseded. */
export class WebuiRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebuiRevisionConflictError";
  }
}

/**
 * Runs one write and reports its outcome without rejecting.
 *
 * This is the write half of the protocol `load` is the read half of: the caller
 * receives a branchable verdict, and the commit fence stays with the owner that
 * holds the resource.
 */
export async function runWebuiMutation<T>(
  command: () => Promise<T>,
): Promise<WebuiMutationOutcome<T>> {
  try {
    return { status: "settled", value: await command() };
  } catch (reason) {
    return { status: "failed", category: classifyWebuiMutationFailure(reason), error: mutationError(reason) };
  }
}

/**
 * The incarnation counter, one per created primitive. A recreated owner gets a
 * new one, so a commit captured by the previous incarnation is rejected even
 * when its key and generation happen to match — the property that makes a
 * remount safe rather than merely unlikely to collide.
 */
let incarnationCounter = 0;

export function createWebuiKeyedResource<T>(): WebuiKeyedResource<T> {
  incarnationCounter += 1;
  const incarnation = incarnationCounter;
  const entries = new Map<string, WebuiResourceState<T>>();
  const revisions = new Map<string, number>();
  const inFlight = new Map<
    string,
    { readonly revision: number; readonly promise: Promise<WebuiResourceLoadOutcome<T>> }
  >();
  const listeners = new Set<() => void>();
  let disposed = false;

  // Released keys need no tombstone map: a scalar floor prevents a recreated
  // identity from ever reusing a revision previously handed to that identity.
  let unseenRevision = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const revisionOf = (serialized: string): number => revisions.get(serialized) ?? unseenRevision;
  const captureRevision = (serialized: string): number => {
    const revision = revisionOf(serialized);
    if (!disposed) revisions.set(serialized, revision);
    return revision;
  };

  const commitToken = (token: WebuiCommitToken, state: WebuiResourceState<T>): boolean => {
    if (disposed) return false;
    // Three fences, and the incarnation is the one that survives a recreated
    // owner: a token minted by another instance can never match this one.
    if (token.incarnation !== incarnation) return false;
    // The revision is the freshness fence: an answer captured before an
    // invalidation cannot commit, whatever else still matches.
    if (revisionOf(token.resource) !== token.revision) return false;
    entries.set(token.resource, state);
    notify();
    return true;
  };

  const retire = (serialized: string): void => {
    if (disposed) return;
    // Freshness advances first, so the request that was already running can no
    // longer land and a new read cannot join it.
    revisions.set(serialized, revisionOf(serialized) + 1);
    inFlight.delete(serialized);
    notify();
  };

  // One binding holds the keys one generation is responsible for, so an advance
  // retires exactly those and nothing else.
  const epochBindings = new Map<WebuiEpochBinding, Set<string>>();
  const epochStops = new Map<WebuiEpochBinding, () => void>();

  const load = (
    key: WebuiResourceKey,
    fetch: () => Promise<T>,
  ): Promise<WebuiResourceLoadOutcome<T>> => {
    if (disposed) return Promise.resolve({ status: "disposed" });
    const serialized = serializeWebuiResourceKey(key);
    const revision = captureRevision(serialized);
    const joined = inFlight.get(serialized);
    // Coalescing is only sound when nothing that affects the answer changed. The
    // joined promise carries the *origin* request's outcome, which is the same
    // answer for this caller: identical key, revision and owner means identical
    // freshness, so there is nothing of its own to report.
    if (joined && joined.revision === revision) return joined.promise;
    const token: WebuiCommitToken = { resource: serialized, revision, incarnation };
    commitToken(token, { status: "loading" });
    const promise = fetch()
      .then((value): WebuiResourceLoadOutcome<T> => {
        // `ready` only when this request's token actually committed. A refusal to
        // commit is the fence naming what happened, not an empty answer.
        if (!commitToken(token, { status: "ready", value })) {
          return disposed ? { status: "disposed" } : { status: "superseded" };
        }
        return { status: "ready", token, value };
      })
      .catch((reason: unknown): WebuiResourceLoadOutcome<T> => {
        // The cached error state still updates: a caller reading the entry sees
        // the failure even though this request is reported as superseded.
        const landed = commitToken(token, {
          status: "error",
          error: reason instanceof Error ? reason.message : String(reason),
        });
        if (!landed) return disposed ? { status: "disposed" } : { status: "superseded" };
        return { status: "failed", error: reason };
      })
      .finally(() => {
        if (inFlight.get(serialized)?.promise === promise) inFlight.delete(serialized);
      });
    inFlight.set(serialized, { revision, promise });
    return promise;
  };

  return {
    read: (key) => entries.get(serializeWebuiResourceKey(key)),
    capture: (key) => {
      const resource = serializeWebuiResourceKey(key);
      return { resource, revision: captureRevision(resource), incarnation };
    },
    commit: commitToken,
    load,
    invalidate: (key) => retire(serializeWebuiResourceKey(key)),
    bindEpoch: (binding, key) => {
      if (disposed) return () => undefined;
      const serialized = serializeWebuiResourceKey(key);
      let keys = epochBindings.get(binding);
      if (!keys) {
        keys = new Set<string>();
        epochBindings.set(binding, keys);
        // Subscribed once per generation, not once per key, so N keys under one
        // generation cost one listener.
        epochStops.set(binding, binding.subscribe(() => {
          for (const bound of [...(epochBindings.get(binding) ?? [])]) retire(bound);
        }));
      }
      keys.add(serialized);
      return () => {
        const current = epochBindings.get(binding);
        if (!current) return;
        current.delete(serialized);
        if (current.size === 0) {
          epochBindings.delete(binding);
          epochStops.get(binding)?.();
          epochStops.delete(binding);
        }
      };
    },
    revision: (key) => revisionOf(serializeWebuiResourceKey(key)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      entries.clear();
      revisions.clear();
      inFlight.clear();
      listeners.clear();
      epochBindings.clear();
      for (const stop of epochStops.values()) stop();
      epochStops.clear();
    },
    isDisposed: () => disposed,
    size: () => entries.size,
    release: (key) => {
      if (disposed) return;
      const serialized = serializeWebuiResourceKey(key);
      unseenRevision = Math.max(unseenRevision, revisionOf(serialized)) + 1;
      entries.delete(serialized);
      revisions.delete(serialized);
      inFlight.delete(serialized);
      for (const [binding, keys] of epochBindings) {
        keys.delete(serialized);
        if (keys.size === 0) {
          epochBindings.delete(binding);
          epochStops.get(binding)?.(); epochStops.delete(binding);
        }
      }
      notify();
    },
    retention: () => ({ entries: entries.size, revisions: revisions.size, inFlight: inFlight.size,
      epochBindings: epochBindings.size, listeners: listeners.size }),
  };
}

export function createWebuiSelectedSlot<T>(): WebuiSelectedSlot<T> {
  incarnationCounter += 1;
  const incarnation = incarnationCounter;
  const state: { entry?: WebuiResourceState<T> } = {};
  const listeners = new Set<() => void>();
  let selected: string | undefined;
  let generation = 0;
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const commitToken = (
    token: WebuiSlotCommitToken,
    entry: WebuiResourceState<T>,
  ): boolean => {
    if (disposed) return false;
    // Three checks, because any one of them alone lets a stale answer through:
    // the identity must still be selected, the selection must not have moved on,
    // and the owner must be the one that asked.
    if (selected !== token.identity) return false;
    if (token.generation !== generation) return false;
    if (token.incarnation !== incarnation) return false;
    state.entry = entry;
    notify();
    return true;
  };

  return {
    read: () => state.entry,
    identity: () => selected,
    capture: () => ({
      identity: selected ?? "",
      generation,
      incarnation,
    }),
    commit: commitToken,
    select: (identity) => {
      if (disposed) return;
      if (selected === identity) return;
      selected = identity;
      generation += 1;
      // The slot's own value belongs to the identity that left it.
      state.entry = undefined;
      notify();
    },
    load: (identity, fetch) => {
      if (disposed) return Promise.resolve();
      const token: WebuiSlotCommitToken = { identity, generation, incarnation };
      commitToken(token, { status: "loading" });
      return fetch()
        .then((value) => {
          commitToken(token, { status: "ready", value });
        })
        .catch((reason: unknown) => {
          commitToken(token, {
            status: "error",
            error: reason instanceof Error ? reason.message : String(reason),
          });
        });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      state.entry = undefined;
      listeners.clear();
    },
    isDisposed: () => disposed,
  };
}
