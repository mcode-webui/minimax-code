// The session binding's contribution to the turn seam.
//
// `webui-application-commands.test.ts` drives `sendWebuiTurn` and `attachWebuiTurn`
// directly, and `webui-shell.test.ts` renders the shell. What is this file's own
// subject is the binding: that `useWebuiSessionCommands` hands out the
// *application's* one command set instead of assembling a second one, and that the
// commands it hands out are the ones the application's own routes depend on — the
// live stream read behind the attach guard, the store-backed sink, the
// absent-capability refusals, and the home slot.
//
// The hook used to build its own context: it chose the record key, built the
// store writer, cut the transports out of the capability slice and assembled the
// two view objects. The behaviour cases below are kept, because the behaviour has
// to survive the move; what changed is who constructs it, and the first two cases
// pin that.
//
// The package has no DOM and no `react-test-renderer`, but it does not need either:
// `useMemo` runs during SSR, so a probe component rendered inside the providers
// hands the test the hook's return value.

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WebuiApplicationProvider,
  WebuiSessionStoreProvider,
} from "../../src/client/bindings/application-context.js";
import { useWebuiSessionCommands } from "../../src/client/bindings/use-session-state.js";
import { createWebuiApplication } from "../../src/client/application/create-application.js";
import {
  createWebuiSessionStore,
  type WebuiSessionStore,
} from "../../src/client/application/session-store.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import type { WebuiTurnCapabilityPort } from "../../src/client/features/turn/application/turn-capabilities.js";
import type { WebuiTurnSendIntent } from "../../src/client/features/turn/contracts/turn-commands.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Render the binding over a store and the application that owns it. The turn
 * capabilities arrive through `turnCapabilities` — the composition root's slice —
 * because a command call site has no way to hand one in.
 */
function commandsFor(
  sessionId: string | undefined,
  store: WebuiSessionStore,
  capabilities: WebuiTurnCapabilityPort = {},
) {
  const application = createWebuiApplication({
    openEventChannel: () => ({ subscribe: () => () => undefined }),
    store,
    turns: {
      resumeSession: capabilities.resumeSession ?? (async () => undefined),
    },
    turnCapabilities: capabilities,
  });
  application.start();
  // The binding must read the application's owner rather than build one, so the
  // accessor is observable here.
  const accessor = vi.spyOn(application, "turnCommandsFor");
  let captured: ReturnType<typeof useWebuiSessionCommands> | undefined;
  function Probe() {
    captured = useWebuiSessionCommands(sessionId);
    return null;
  }
  renderToStaticMarkup(
    createElement(WebuiApplicationProvider, {
      application,
      children: createElement(Probe),
    }),
  );
  if (!captured) throw new Error("the probe did not render");
  return { commands: captured, accessor };
}

/** The same probe with no application: a store-only render (SSR, a bare fixture). */
function commandsWithoutApplication(sessionId: string | undefined, store: WebuiSessionStore) {
  let captured: ReturnType<typeof useWebuiSessionCommands> | undefined;
  let rendered = false;
  function Probe() {
    captured = useWebuiSessionCommands(sessionId);
    rendered = true;
    return null;
  }
  renderToStaticMarkup(
    createElement(WebuiSessionStoreProvider, {
      store,
      children: createElement(Probe),
    }),
  );
  if (!rendered) throw new Error("the probe did not render");
  return captured;
}

/** A resumer that delivers one frame and then stays open until released. */
function pendingResumer() {
  let release: () => void = () => {};
  const frames: WebuiStreamFrame[] = [{ dataJson: '{"type":10}' }];
  const resumeSession = vi.fn(
    async (_body: unknown, onFrame: (frame: WebuiStreamFrame) => void) => {
      for (const frame of frames) onFrame(frame);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      onFrame({ dataJson: "[DONE]" });
    },
  );
  return { resumeSession, release: () => release() };
}

describe("the binding's command set", () => {
  it("reads the application's own command set rather than building one", () => {
    const store = createWebuiSessionStore();
    const { commands, accessor } = commandsFor("s1", store);
    // The binding asked the application, for this session, exactly once — and what
    // it hands out is what the application built.
    expect(accessor).toHaveBeenCalledTimes(1);
    expect(accessor).toHaveBeenCalledWith("s1");
    expect(typeof commands.send).toBe("function");
    expect(typeof commands.attach).toBe("function");
    expect(typeof commands.stop).toBe("function");
    // The two views come from the same owner, so a component holds no writer.
    expect(typeof commands.phase.settleStoppedStream).toBe("function");
    expect(typeof commands.lifecycle.clearStream).toBe("function");
  });

  it("hands out nothing at all when the host has no application", () => {
    const store = createWebuiSessionStore();
    // No application means no execution owner. The hook says so instead of
    // assembling a second owner to keep a store-only fixture working.
    expect(commandsWithoutApplication("s1", store)).toBeUndefined();
    expect(commandsWithoutApplication(undefined, store)).toBeUndefined();
  });

  it("routes an undefined session to the home slot, not to a session key", () => {
    const store = createWebuiSessionStore();
    const { commands } = commandsFor(undefined, store);
    commands.lifecycle.setTurnSending(true);
    expect(store.readSession(WEBUI_HOME_SESSION_KEY).sending).toBe(true);
    expect(store.readSession("s1").sending).toBe(false);
  });
});

describe("attach", () => {
  it("mints its sink from the store writer, so frames and sending land in the store", async () => {
    const store = createWebuiSessionStore();
    const { resumeSession } = pendingResumer();
    const { commands } = commandsFor("s1", store, { resumeSession });
    commands.attach("t1");
    await flush();
    expect(resumeSession).toHaveBeenCalledTimes(1);
    // The resume body names the session. `turnId` is not part of it: the loop
    // takes it as an option and uses it to frame what comes back, so a test that
    // expected it here would be asserting a wire shape that does not exist.
    expect(resumeSession.mock.calls[0]?.[0]).toEqual({ id: "s1" });
    // The frame went through `buildWebuiStreamLoopSink(writer.setStream, …)`: a
    // sink built from anything but the store's writer leaves this slice idle.
    expect(store.readSession("s1").stream.phase).not.toBe("idle");
    // …and `sending` through `writer.setSending`, which is the flag the composer
    // reads to disable its send button.
    expect(store.readSession("s1").sending).toBe(true);
  });

  it("refuses a second attachment while the first is live, because it reads the live slice", async () => {
    const store = createWebuiSessionStore();
    const { resumeSession } = pendingResumer();
    const { commands } = commandsFor("s1", store, { resumeSession });
    commands.attach("t1");
    await flush();
    commands.attach("t2");
    await flush();
    // `attachWebuiTurn` returns early when `readStream().subscription` is set.
    // That guard only works if the reader is live — a snapshot of the idle slice
    // would let a second loop attach to the same session and fight the first.
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it("refuses when the application wires no resume capability, without starting a stream", async () => {
    const store = createWebuiSessionStore();
    // The capability exists here, but it is NOT in the application's slice — so
    // the command has no way to reach it. That is the guard's whole point.
    const { resumeSession } = pendingResumer();
    const { commands } = commandsFor("s1", store);
    commands.attach("t1");
    await flush();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.readSession("s1").stream.phase).toBe("idle");
  });

  it("ignores a capability smuggled in where the turn id belongs", async () => {
    const store = createWebuiSessionStore();
    const { resumeSession } = pendingResumer();
    const { commands } = commandsFor("s1", store);
    // A cast defeats the type the way a plain-JavaScript caller would. The runtime
    // path has to be as narrow as the type: the owner reads the slice, not the
    // object it was handed.
    commands.attach({ turnId: "t1", resumeSession } as unknown as string);
    await flush();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(store.readSession("s1").sending).toBe(false);
  });

  it("does nothing without a session", async () => {
    const store = createWebuiSessionStore();
    const { resumeSession } = pendingResumer();
    const { commands } = commandsFor(undefined, store, { resumeSession });
    commands.attach("t1");
    await flush();
    expect(resumeSession).not.toHaveBeenCalled();
  });
});

describe("send", () => {
  it("sends through the application's capability slice", async () => {
    const store = createWebuiSessionStore();
    const sendMessage = vi.fn(
      async (_request: { readonly id: string; readonly content: string }) =>
        undefined,
    );
    const { commands } = commandsFor("s1", store, { sendMessage });
    await commands.send({
      message: "你好",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toEqual({ id: "s1", content: "你好" });
  });

  it("refuses when the application wires no send capability, without setting sending or opening a stream", async () => {
    const store = createWebuiSessionStore();
    // Again the capability exists and the slice does not carry it.
    const sendMessage = vi.fn(async () => undefined);
    const { commands } = commandsFor("s1", store);
    await commands.send({
      message: "你好",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.readSession("s1").stream.phase).toBe("idle");
  });

  it("ignores a capability bag smuggled into the intent object at runtime", async () => {
    const store = createWebuiSessionStore();
    const sendMessage = vi.fn(async () => undefined);
    const { commands } = commandsFor("s1", store);
    await commands.send({
      message: "你好",
      deps: { sendMessage },
    } as unknown as WebuiTurnSendIntent);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.readSession("s1").sending).toBe(false);
  });
});

describe("stop", () => {
  it("aborts through the slice and settles the local stream", async () => {
    const store = createWebuiSessionStore();
    const abortSession = vi.fn(async () => ({ success: true }));
    const { commands } = commandsFor("s1", store, { abortSession });
    store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(true);
    await commands.stop();
    expect(abortSession).toHaveBeenCalledWith({ id: "s1" });
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.readSession("s1").stream.phase).toBe("done");
  });

  it("does nothing when the application wires no stop capability", async () => {
    const store = createWebuiSessionStore();
    const abortSession = vi.fn(async () => ({ success: true }));
    const { commands } = commandsFor("s1", store);
    await commands.stop();
    expect(abortSession).not.toHaveBeenCalled();
  });
});

/**
 * The published intent type, checked as a type, and the check is total rather than
 * "the literal I happened to write".
 *
 * `SendIntentCapabilityFields` is `never` as long as the intent declares no
 * capability field; if one is ever added, that type becomes that literal, the
 * `... extends never ? true : never` collapses to `never`, and the `const` below
 * stops compiling under `pnpm typecheck:webui-full`. `keyof` reads the *declared*
 * surface, so this holds for every caller rather than for the one object literal a
 * test might write. The attach command takes a bare turn id, which has no fields to
 * check.
 */
type SendIntentCapabilityFields = Extract<
  keyof WebuiTurnSendIntent,
  "resumeSession" | "loadMessages" | "sendMessage" | "deps" | "sink" | "createWriter" | "sending"
>;
type OnlyTrue<T extends true> = T;

const sendIntentRejectsCapabilities: OnlyTrue<
  SendIntentCapabilityFields extends never ? true : never
> = true;

describe("the published intent type", () => {
  it("declares no capability field", () => {
    expect(sendIntentRejectsCapabilities).toBe(true);
  });
});
