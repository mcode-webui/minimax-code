// Unit tests for the per-session effects-registration bridge (ticket #45,
// pre-flip slice).
//
// The bridge is deliberately not wired into the live `watchEvents` ingress, so
// these cases drive it directly:
//
//   * the registry routes each `WebuiEventEffects` call to the session it
//     names, so one application-wide coordinator can run many sessions'
//     handlers;
//   * the coordinator, built by `createWebuiApplication`, runs the handlers a
//     component registered — the composer's shape — when events arrive, and
//     fans a channel-accepted signal out to every registered session;
//   * the bindings-layer transport adapter turns a `watchEvents` watcher into
//     the channel the coordinator subscribes to, so a frame off the transport
//     reaches the registered handler.

import { describe, expect, it, vi } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiEventEffectsRegistry } from "../../src/client/application/event-effects-registry.js";
import type { WebuiProcessEventChannel } from "../../src/client/application/event-channel.js";
import { createWebuiOpenEventChannel } from "../../src/client/bindings/event-channel-adapter.js";
import type {
  WebuiClientEventWatcher,
  WebuiClientSessionResumer,
} from "../../src/client/contracts/execution-port.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";

function event(type: string, payload: Record<string, unknown>): WebuiRuntimeEvent {
  return { type, payload, timestamp: 1, source: "test" };
}

const resumeSession = vi.fn(async () => {}) as unknown as WebuiClientSessionResumer;

describe("the per-session effects registry", () => {
  it("routes each effect call to the session it names", () => {
    const registry = createWebuiEventEffectsRegistry();
    const a = { refreshPending: vi.fn(), channelReady: vi.fn() };
    const b = { refreshGoal: vi.fn() };
    const offA = registry.register("A", a);
    registry.register("B", b);

    const effects = registry.asWebuiEventEffects();
    effects.refreshPending?.("A");
    expect(a.refreshPending).toHaveBeenCalledWith("A");
    expect(b.refreshGoal).not.toHaveBeenCalled();

    // A session with no registration is a no-op, not a crash.
    expect(() => effects.refreshGoal?.("missing")).not.toThrow();

    effects.channelReady?.();
    expect(a.channelReady).toHaveBeenCalledTimes(1);

    offA();
    expect(registry.read("A")).toBeUndefined();
    // Re-registering a session and dropping the stale unregister leaves it in
    // place: the unregister removes only the exact set it registered.
    const first = { refreshPending: vi.fn() };
    const second = { refreshPending: vi.fn() };
    const offFirst = registry.register("C", first);
    registry.register("C", second);
    offFirst();
    expect(registry.read("C")).toBe(second);
  });
});

function makeChannel(): {
  readonly channel: WebuiProcessEventChannel;
  readonly emit: (event: WebuiRuntimeEvent) => void;
  readonly ready: () => void;
} {
  const listeners = new Set<(event: WebuiRuntimeEvent) => void>();
  const readyCallbacks = new Set<() => void>();
  return {
    channel: {
      subscribe: (listener, onReady) => {
        listeners.add(listener);
        if (onReady) readyCallbacks.add(onReady);
        return () => {
          listeners.delete(listener);
          if (onReady) readyCallbacks.delete(onReady);
        };
      },
    },
    emit: (value) => {
      for (const listener of [...listeners]) listener(value);
    },
    ready: () => {
      for (const onReady of [...readyCallbacks]) onReady();
    },
  };
}

describe("the coordinator runs the registered effect handlers", () => {
  it("runs them per session and fans the ready signal out", () => {
    const registry = createWebuiEventEffectsRegistry();
    const refreshPending = vi.fn();
    const refreshGoal = vi.fn();
    const attachStream = vi.fn();
    const channelReady = vi.fn();
    registry.register("s1", {
      refreshPending,
      refreshGoal,
      attachStream,
      channelReady,
    });

    const fake = makeChannel();
    createWebuiApplication({
      openEventChannel: () => fake.channel,
      effects: registry.asWebuiEventEffects(),
      turns: { resumeSession },
    });

    fake.emit(event("session.queue.updated", { sessionId: "s1" }));
    expect(refreshPending).toHaveBeenCalledWith("s1");

    fake.emit(event("thread_goal.objective_updated_steering", { sessionId: "s1", goalId: "g1" }));
    expect(refreshGoal).toHaveBeenCalledWith("s1");

    fake.emit(event("session.start", { sessionId: "s1", turnId: "t1" }));
    expect(attachStream).toHaveBeenCalledWith("s1", "t1", "attach");

    fake.ready();
    expect(channelReady).toHaveBeenCalledTimes(1);
  });
});

describe("the bindings-layer transport event-channel adapter", () => {
  it("turns a watchEvents watcher into the channel the coordinator consumes", () => {
    const registry = createWebuiEventEffectsRegistry();
    const refreshPending = vi.fn();
    const channelReady = vi.fn();
    registry.register("s1", { refreshPending, channelReady });

    let onEvent: ((event: WebuiRuntimeEvent) => void) | undefined;
    let onReady: (() => void) | undefined;
    const watcher: WebuiClientEventWatcher = (event, ready) => {
      onEvent = event;
      onReady = ready;
      return () => {
        onEvent = undefined;
        onReady = undefined;
      };
    };

    createWebuiApplication({
      openEventChannel: createWebuiOpenEventChannel(watcher),
      effects: registry.asWebuiEventEffects(),
      turns: { resumeSession },
    });

    // A frame off the transport reaches the coordinator through the adapter…
    onEvent?.(event("session.queue.updated", { sessionId: "s1" }));
    expect(refreshPending).toHaveBeenCalledWith("s1");

    // …and the watcher's acceptance signal reaches the registered session.
    onReady?.();
    expect(channelReady).toHaveBeenCalledTimes(1);
  });
});
