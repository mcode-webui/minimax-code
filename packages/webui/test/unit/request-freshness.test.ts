// The request/freshness primitive.
//
// The first case reproduces the old seam's defect on purpose: `query-store.ts`
// fences by an arbitrary key but writes one destination field, so a late answer
// for one key overwrites the answer for another. That reproduction is the
// "before" half; the rest of the file is the corrected contract, driven through
// the same adversarial scheduling (two requests, resolved out of order, with an
// invalidation in between).
//
// Every case asserts an externally visible outcome: which entry holds what, which
// fetch ran, and whether a disposed owner accepted anything.

import { describe, expect, it, vi } from "vitest";

import {
  classifyWebuiMutationFailure,
  createWebuiKeyedResource,
  createWebuiSelectedSlot,
  runWebuiMutation,
  serializeWebuiResourceKey,
  WebuiRefusedError,
  WebuiRevisionConflictError,
  type WebuiEpochBinding,
} from "../../src/client/conversation/request-freshness.js";

/** A promise whose settlement the test decides. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A generation whose advance the test decides, shaped like the opaque epoch
 * context but owned by the test so a case can move it without the application.
 */
function fakeEpoch(token: string) {
  const listeners = new Set<() => void>();
  let current = token;
  const binding: WebuiEpochBinding = {
    token: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    binding,
    advance: (next: string) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("the seam the primitive replaces", () => {
  it("V16 releases data, revision, in-flight and epoch metadata without reviving old tokens", async () => {
    const resource = createWebuiKeyedResource<string>();
    const epoch = fakeEpoch("epoch-0");
    const pending = deferred<string>();
    const key = { session: "released" };
    resource.bindEpoch(epoch.binding, key);
    const token = resource.capture(key);
    const oldRead = resource.load(key, () => pending.promise);
    expect(resource.retention()).toMatchObject({ entries: 1, revisions: 1, inFlight: 1, epochBindings: 1 });
    resource.release(key);
    expect(resource.retention()).toMatchObject({ entries: 0, revisions: 0, inFlight: 0, epochBindings: 0 });
    const fresh = resource.capture(key);
    expect(resource.commit(fresh, { status: "ready", value: "new" })).toBe(true);
    expect(resource.commit(token, { status: "ready", value: "old" })).toBe(false);
    pending.resolve("late");
    expect((await oldRead).status).toBe("superseded");
    expect(resource.read(key)?.value).toBe("new");
    for (let index = 0; index < 100; index += 1) {
      const item = { session: `detail-${index}` };
      await resource.load(item, async () => "data");
      resource.release(item);
    }
    expect(resource.retention()).toMatchObject({ entries: 1, revisions: 1, inFlight: 0, epochBindings: 0 });
    resource.dispose();
    expect(resource.retention()).toMatchObject({ entries: 0, revisions: 0, inFlight: 0, epochBindings: 0, listeners: 0 });
  });
  it("lets a late answer for one key overwrite the field another key wrote", async () => {
    // The reproduction, written out rather than imported. It used to call
    // `query-store.ts`, which is retired; keeping the store alive to hold a
    // reproduction of the defect it embodied would be a transitional consumer
    // holding a dead module open, so the shape is inlined here instead. It is
    // twenty lines and it is the reason this module exists.
    let version = 0;
    const versions = new Map<string, number>();
    let state: { models?: { value?: string } } = {};
    const set = (next: { models?: { value?: string } }): void => {
      state = next;
    };
    const readInto = async (
      key: string,
      fetch: () => Promise<string>,
    ): Promise<void> => {
      const mine = (versions.get(key) ?? 0) + 1;
      versions.set(key, mine);
      try {
        const value = await fetch();
        // The whole fence: "is my request still the newest for this key?"
        if (versions.get(key) !== mine) return;
        set({ models: { value } });
      } catch {
        // not the case under test
      }
    };

    const slowA = deferred<string>();
    const first = readInto("key-A", () => slowA.promise);
    await readInto("key-B", async () => "B");
    expect(state.models?.value).toBe("B");
    slowA.resolve("A");
    await first;
    // The defect: A and B are different reads, but they share one destination
    // field and one version counter, so the older answer lands last and wins.
    expect(state.models?.value).toBe("A");
  });
});

describe("a keyed resource stores identity as identity", () => {
  it("keeps each key's answer in its own entry, so a late answer cannot overwrite another", async () => {
    const resource = createWebuiKeyedResource<string>();
    const slowA = deferred<string>();
    const first = resource.load({ session: "A" }, () => slowA.promise);
    await resource.load({ session: "B" }, async () => "B");

    expect(resource.read({ session: "B" })?.value).toBe("B");
    slowA.resolve("A");
    await first;

    // A's answer landed in A's entry; B's is untouched, which is the invariant
    // the old seam could not state.
    expect(resource.read({ session: "A" })?.value).toBe("A");
    expect(resource.read({ session: "B" })?.value).toBe("B");
    resource.dispose();
  });

  it("treats an explicit undefined, an absent field and a null field as different resources", () => {
    expect(serializeWebuiResourceKey({ session: undefined })).not.toBe(
      serializeWebuiResourceKey({}),
    );
    expect(serializeWebuiResourceKey({ a: 1, b: 2 })).toBe(
      serializeWebuiResourceKey({ b: 2, a: 1 }),
    );
    // "No session" and "a session whose id is empty" are different reads too.
    expect(serializeWebuiResourceKey({ session: "" })).not.toBe(
      serializeWebuiResourceKey({ session: undefined }),
    );
    expect(serializeWebuiResourceKey({ session: null })).not.toBe(
      serializeWebuiResourceKey({ session: undefined }),
    );
  });

  it("coalesces only reads whose key and freshness revision match", async () => {
    const resource = createWebuiKeyedResource<string>();
    const fetch = vi.fn(async () => "value");
    await Promise.all([
      resource.load({ session: "A" }, fetch),
      resource.load({ session: "A" }, fetch),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);

    // A different key is a different resource, so it gets its own request.
    await resource.load({ session: "B" }, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    resource.dispose();
  });

  it("does not join a read that started before an invalidation", async () => {
    const resource = createWebuiKeyedResource<string>();
    const slow = deferred<string>();
    const first = resource.load({ session: "A" }, () => slow.promise);
    resource.invalidate({ session: "A" });

    const secondFetch = vi.fn(async () => "fresh");
    const second = resource.load({ session: "A" }, secondFetch);
    expect(secondFetch).toHaveBeenCalledTimes(1);

    // The pre-invalidation answer cannot land, and it cannot mark the key fresh:
    // the entry is the newer read's, not the older request's.
    slow.resolve("stale");
    await Promise.all([first, second]);
    expect(resource.read({ session: "A" })?.value).toBe("fresh");
    expect(resource.revision({ session: "A" })).toBe(1);
    resource.dispose();
  });

  it("rejects an answer that was in flight when the key was invalidated", async () => {
    const resource = createWebuiKeyedResource<string>();
    const slow = deferred<string>();
    const pending = resource.load({ session: "A" }, () => slow.promise);
    expect(resource.read({ session: "A" })?.status).toBe("loading");
    resource.invalidate({ session: "A" });
    slow.resolve("stale");
    await pending;
    // Nothing committed: the answer belongs to a revision the owner retired.
    expect(resource.read({ session: "A" })?.status).toBe("loading");
  });

  it("accepts nothing after disposal", async () => {
    const resource = createWebuiKeyedResource<string>();
    const slow = deferred<string>();
    const pending = resource.load({ session: "A" }, () => slow.promise);
    resource.dispose();
    expect(resource.isDisposed()).toBe(true);

    slow.resolve("late");
    await pending;
    expect(resource.read({ session: "A" })).toBeUndefined();
    expect(resource.size()).toBe(0);

    // A read after disposal does not schedule: the fetch never runs.
    const fetch = vi.fn(async () => "value");
    await resource.load({ session: "A" }, fetch);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a selected slot belongs to one identity at a time", () => {
  it("drops an answer for an identity that is no longer selected", async () => {
    const slot = createWebuiSelectedSlot<string>();
    slot.select("A");
    const slowA = deferred<string>();
    const pendingA = slot.load("A", () => slowA.promise);

    slot.select("B");
    const pendingB = slot.load("B", async () => "B");
    await pendingB;
    expect(slot.read()?.value).toBe("B");

    // A's answer arrives after the selection moved: it is dropped rather than
    // shown against B.
    slowA.resolve("A");
    await pendingA;
    expect(slot.read()?.value).toBe("B");
    slot.dispose();
  });

  it("rejects an answer captured before the same identity was re-selected", async () => {
    const slot = createWebuiSelectedSlot<string>();
    slot.select("A");
    const slow = deferred<string>();
    const pending = slot.load("A", () => slow.promise);
    // Away and back: the identity is the same, the generation is not.
    slot.select("B");
    slot.select("A");
    slow.resolve("captured-before");
    await pending;
    expect(slot.read()).toBeUndefined();
    slot.dispose();
  });

  it("clears its value when the selection moves", async () => {
    const slot = createWebuiSelectedSlot<string>();
    slot.select("A");
    await slot.load("A", async () => "A");
    expect(slot.read()?.value).toBe("A");
    slot.select("B");
    // The value belonged to the identity that left.
    expect(slot.read()).toBeUndefined();
    expect(slot.identity()).toBe("B");
    slot.dispose();
  });

  it("refuses a token minted by another owner incarnation", async () => {
    // A recreated owner gets a new incarnation. The token is what makes that
    // check observable: a capture from the previous owner is refused by the new
    // one even though its identity and generation still match.
    const first = createWebuiKeyedResource<string>();
    const captured = first.capture({ session: "A" });
    const second = createWebuiKeyedResource<string>();
    expect(second.commit(captured, { status: "ready", value: "from-the-old-owner" })).toBe(false);
    expect(second.read({ session: "A" })).toBeUndefined();
    // Its own token lands, so the refusal is the incarnation and not the commit
    // path being broken.
    expect(second.commit(second.capture({ session: "A" }), { status: "ready", value: "mine" })).toBe(true);
    expect(second.read({ session: "A" })?.value).toBe("mine");
    first.dispose();
    second.dispose();
  });

  it("refuses a token whose freshness revision was superseded", () => {
    const resource = createWebuiKeyedResource<string>();
    const captured = resource.capture({ session: "A" });
    resource.invalidate({ session: "A" });
    expect(resource.commit(captured, { status: "ready", value: "stale" })).toBe(false);
    expect(resource.read({ session: "A" })).toBeUndefined();
    resource.dispose();
  });

  it("accepts nothing after disposal", async () => {
    const slot = createWebuiSelectedSlot<string>();
    slot.select("A");
    const slow = deferred<string>();
    const pending = slot.load("A", () => slow.promise);
    slot.dispose();
    slow.resolve("late");
    await pending;
    expect(slot.read()).toBeUndefined();
    const fetch = vi.fn(async () => "value");
    await slot.load("A", fetch);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a key is injective over its declared domain", () => {
  // Every pair below would collide under `String(value)` joined with a
  // separator, which is what the previous encoding did.
  const distinct: ReadonlyArray<readonly [unknown, unknown]> = [
    ["1", 1],
    ["true", true],
    [true, "true"],
    [null, "null"],
    [undefined, "undefined"],
    ["", undefined],
  ];

  it("keeps a value and a different type's value in the same text apart", () => {
    for (const [left, right] of distinct) {
      expect(serializeWebuiResourceKey({ v: left as string })).not.toBe(
        serializeWebuiResourceKey({ v: right as string }),
      );
    }
  });

  it("keeps a separator inside a string from forging a field boundary", () => {
    // Under a joined encoding, `a=1&b=2` in one field could be produced by two.
    expect(serializeWebuiResourceKey({ "a=1&b": "2" })).not.toBe(
      serializeWebuiResourceKey({ a: "1&b=2" }),
    );
    expect(serializeWebuiResourceKey({ a: "x&b=y" })).not.toBe(
      serializeWebuiResourceKey({ a: "x", b: "y" }),
    );
  });

  it("normalizes the numeric edges deliberately rather than by accident", () => {
    // The same number, so the same resource: -0 === 0.
    expect(serializeWebuiResourceKey({ v: -0 })).toBe(serializeWebuiResourceKey({ v: 0 }));
    // Distinct numbers stay distinct resources.
    expect(serializeWebuiResourceKey({ v: 1 })).not.toBe(serializeWebuiResourceKey({ v: 2 }));
  });

  it("rejects an unsupported value instead of coercing it into a collision", () => {
    expect(() => serializeWebuiResourceKey({ v: NaN })).toThrow(TypeError);
    expect(() => serializeWebuiResourceKey({ v: Infinity })).toThrow(TypeError);
    expect(() =>
      serializeWebuiResourceKey({ v: { toString: () => "1" } as unknown as string }),
    ).toThrow(TypeError);
    expect(() => serializeWebuiResourceKey({ v: ["1"] as unknown as string })).toThrow(TypeError);
    expect(() =>
      serializeWebuiResourceKey({ v: 1n as unknown as string }),
    ).toThrow(TypeError);
  });
});

describe("a read reports what its own request produced", () => {
  it("returns ready with the token that actually committed", async () => {
    const resource = createWebuiKeyedResource<string>();
    const outcome = await resource.load({ session: "A" }, async () => "value");
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("unreachable");
    expect(outcome.value).toBe("value");
    // The returned token is the one that committed, so a later check asks the
    // resource rather than a second copy of the revision.
    expect(resource.read({ session: "A" })?.value).toBe("value");
    expect(
      resource.commit(outcome.token, { status: "ready", value: "still-current" }),
    ).toBe(true);
    resource.dispose();
  });

  it("reports superseded rather than ready when a later write retired the request", async () => {
    // The acceptance case: a read that resolves after a later write reports the
    // committed revision's fate, not an empty answer it did not produce.
    const resource = createWebuiKeyedResource<string>();
    const slow = deferred<string>();
    const first = resource.load({ session: "A" }, () => slow.promise);
    resource.invalidate({ session: "A" });
    const second = await resource.load({ session: "A" }, async () => "newer");
    expect(second.status).toBe("ready");

    slow.resolve("older");
    expect((await first).status).toBe("superseded");
    // The committed value is the newer read's, so no lost update.
    expect(resource.read({ session: "A" })?.value).toBe("newer");
    resource.dispose();
  });

  it("reports disposed when the owner was disposed under the read", async () => {
    const resource = createWebuiKeyedResource<string>();
    const slow = deferred<string>();
    const pending = resource.load({ session: "A" }, () => slow.promise);
    resource.dispose();
    slow.resolve("late");
    expect((await pending).status).toBe("disposed");
    // A read started after disposal reports the same thing and issues no request.
    const fetch = vi.fn(async () => "value");
    expect((await resource.load({ session: "A" }, fetch)).status).toBe("disposed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports failure with the original error and still updates the cached error state", async () => {
    const resource = createWebuiKeyedResource<string>();
    const boom = new Error("the host refused");
    const outcome = await resource.load({ session: "A" }, async () => {
      throw boom;
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    // The original error, not a stringified copy of it.
    expect(outcome.error).toBe(boom);
    expect(resource.read({ session: "A" })?.status).toBe("error");
    resource.dispose();
  });

  it("gives coalesced callers the same outcome", async () => {
    const resource = createWebuiKeyedResource<string>();
    const slow = deferred<string>();
    const first = resource.load({ session: "A" }, () => slow.promise);
    const second = resource.load({ session: "A" }, () => slow.promise);
    slow.resolve("shared");
    const [a, b] = await Promise.all([first, second]);
    // Same request, so the same answer — a joining caller learns what the joined
    // request produced rather than getting a second, contradictory verdict.
    expect(a).toBe(b);
    resource.dispose();
  });

  it("resolves A → B → A to the value committed for each request", async () => {
    // Three overlapping reads of one key: only the newest may hold the answer.
    const resource = createWebuiKeyedResource<string>();
    const a1 = deferred<string>();
    const a2 = deferred<string>();
    const first = resource.load({ session: "A" }, () => a1.promise);
    resource.invalidate({ session: "A" });
    const second = resource.load({ session: "A" }, () => a2.promise);

    a1.resolve("first-A");
    expect((await first).status).toBe("superseded");
    a2.resolve("second-A");
    expect((await second).status).toBe("ready");
    expect(resource.read({ session: "A" })?.value).toBe("second-A");
    resource.dispose();
  });
});

describe("an epoch binding retires only the keys it covers", () => {
  it("leaves an unrelated key untouched when a generation advances", async () => {
    const resource = createWebuiKeyedResource<string>();
    const credentials = fakeEpoch("cred-0");
    const configuration = fakeEpoch("conf-0");
    // Two different resources, each carrying one generation.
    await resource.load({ session: "A", credentials: credentials.binding.token() }, async () => "A");
    await resource.load(
      { session: "B", configuration: configuration.binding.token() },
      async () => "B",
    );
    resource.bindEpoch(credentials.binding, { session: "A", credentials: "cred-0" });
    resource.bindEpoch(configuration.binding, {
      session: "B",
      configuration: "conf-0",
    });

    credentials.advance("cred-1");

    // Only the credential-keyed entry is retired; B — which carries no
    // credential token at all — keeps the answer it had.
    expect(resource.read({ session: "A", credentials: "cred-0" })?.value).toBe("A");
    expect(resource.revision({ session: "A", credentials: "cred-0" })).toBe(1);
    expect(resource.revision({ session: "B", configuration: "conf-0" })).toBe(0);
    expect(resource.read({ session: "B", configuration: "conf-0" })?.value).toBe("B");
    resource.dispose();
  });

  it("stops retiring a key once it is unbound", () => {
    const resource = createWebuiKeyedResource<string>();
    const epoch = fakeEpoch("cred-0");
    const key = { session: "A", credentials: "cred-0" };
    const unbind = resource.bindEpoch(epoch.binding, key);

    epoch.advance("cred-1");
    expect(resource.revision(key)).toBe(1);

    unbind();
    epoch.advance("cred-2");
    // The generation no longer speaks for this key, so it stops retiring it.
    expect(resource.revision(key)).toBe(1);
    resource.dispose();
  });

  it("retires the key an in-flight read was captured under", async () => {
    const resource = createWebuiKeyedResource<string>();
    const epoch = fakeEpoch("cred-0");
    const key = { session: "A", credentials: "cred-0" };
    resource.bindEpoch(epoch.binding, key);

    const slow = deferred<string>();
    const pending = resource.load(key, () => slow.promise);
    epoch.advance("cred-1");
    slow.resolve("computed-under-the-old-generation");

    // The generation moved while the read was running, so its answer is no
    // longer the current one and is reported as such rather than committed.
    expect((await pending).status).toBe("superseded");
    resource.dispose();
  });
});

describe("a write reports a machine-readable failure category", () => {
  it("settles with the runtime's value when the write lands", async () => {
    const outcome = await runWebuiMutation(async () => "written");
    expect(outcome).toEqual({ status: "settled", value: "written" });
  });

  it("distinguishes a refusal from a lost response", async () => {
    // The distinction the acceptance row is about: these need opposite follow-up,
    // and matching on message text could not tell them apart.
    const refused = await runWebuiMutation(async () => {
      throw new WebuiRefusedError("该模型没有访问权限。");
    });
    const lost = await runWebuiMutation(async () => {
      throw new Error("socket hang up");
    });
    expect(refused.status === "failed" && refused.category).toBe("refused");
    expect(lost.status === "failed" && lost.category).toBe("transport");
  });

  it("classifies the transport categories separately", () => {
    expect(classifyWebuiMutationFailure(new WebuiRevisionConflictError("moved"))).toBe("conflict");
    const timedOut = new Error("no answer");
    timedOut.name = "TimeoutError";
    expect(classifyWebuiMutationFailure(timedOut)).toBe("timeout");
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    expect(classifyWebuiMutationFailure(aborted)).toBe("timeout");
    expect(classifyWebuiMutationFailure("a string")).toBe("transport");
  });

  it("never rejects, so a caller observes settlement without an error path", async () => {
    // The write's own error is data here: a caller that awaits the outcome has
    // nothing to catch.
    const outcome = await runWebuiMutation(async () => {
      throw new WebuiRefusedError("nope");
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    const error = outcome.error;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("nope");
  });
});

