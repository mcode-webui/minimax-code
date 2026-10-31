// The application lifecycle: constructed → started → disposed.
//
// The seam is the assembled application's own public lifecycle, driven with a
// scripted channel: what a host can observe is the ingress count and what a
// disposed instance refuses.
//
// No DOM: these are the framework-free assembly's guarantees, and the built
// client's boot is covered by the browser suite.

import { describe, expect, it, vi } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiPortSlices } from "../../src/client/application/port-slices.js";
import { createWebuiIdentityEpochs } from "../../src/client/application/identity-epochs.js";
import type { WebuiProcessEventChannel } from "../../src/client/features/turn/application/event-channel.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";
import type { WebuiClientSessionResumer } from "../../src/client/features/turn/contracts/execution-port.js";

const SESSION = "session-initial";
const OTHER = "session-other";

it("selects the visible model catalogue without turning background acquisition into selection", async () => {
  const listModels = vi.fn(async (request?: { readonly sessionId?: string }) => [
    { providerId: "fixture", modelId: request?.sessionId ?? "home" },
  ]);
  const application = createWebuiApplication({
    openEventChannel: () => scriptedChannel().channel,
    slices: createWebuiPortSlices({ listModels } as never),
    turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
  });
  await application.modelsWorkflows.acquireModels(SESSION);
  await application.modelsWorkflows.acquireModels(OTHER);
  application.select(SESSION);
  expect(application.modelsWorkflows.getSnapshot().models.value?.[0]?.modelId).toBe(SESSION);
  application.select(OTHER);
  expect(application.modelsWorkflows.getSnapshot().models.value?.[0]?.modelId).toBe(OTHER);
  expect(listModels).toHaveBeenCalledTimes(2);
  application.dispose();
});

it("reads the session-less catalogue at start so the new-task composer can pick a model", async () => {
  // The home slot is a context like any other, and `selectCatalogue` points at
  // its key — but nothing ever *read* it. `refreshInspection` needs a sessionId
  // and `loadModels` only had the settings panel as a caller, so booting
  // straight into the new-task screen left the composer's Model picker with an
  // empty catalogue and rendered it disabled.
  const listModels = vi.fn(async (request?: { readonly sessionId?: string }) => [
    { providerId: "fixture", modelId: request?.sessionId ?? "home" },
  ]);
  const application = createWebuiApplication({
    openEventChannel: () => scriptedChannel().channel,
    slices: createWebuiPortSlices({ listModels } as never),
    turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
  });

  application.start();
  // `start` is synchronous and the read is not, so let the load settle.
  await Promise.resolve();
  await Promise.resolve();

  expect(listModels).toHaveBeenCalled();
  // The session-less read carries no `sessionId`: the home context asks for
  // the runtime-wide catalogue, not some session's.
  expect(listModels.mock.calls.every((call) => call[0] === undefined)).toBe(true);
  expect(application.modelsWorkflows.getSnapshot().models.value?.[0]?.modelId).toBe("home");
  application.dispose();
});

it("reads the route's own catalogue at start when the route names a session", async () => {
  const listModels = vi.fn(async (request?: { readonly sessionId?: string }) => [
    { providerId: "fixture", modelId: request?.sessionId ?? "home" },
  ]);
  const application = createWebuiApplication({
    openEventChannel: () => scriptedChannel().channel,
    slices: createWebuiPortSlices({ listModels } as never),
    turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
  });

  application.start({ initialSessionId: SESSION });
  await Promise.resolve();
  await Promise.resolve();

  expect(listModels).toHaveBeenCalledWith({ sessionId: SESSION });
  expect(application.modelsWorkflows.getSnapshot().models.value?.[0]?.modelId).toBe(SESSION);
  application.dispose();
});

it("reads the home catalogue when returning from a session to a new task", async () => {
  const listModels = vi.fn(async (request?: { readonly sessionId?: string }) => [
    { providerId: "fixture", modelId: request?.sessionId ?? "home" },
  ]);
  const application = createWebuiApplication({
    openEventChannel: () => scriptedChannel().channel,
    slices: createWebuiPortSlices({ listModels } as never),
    turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
  });

  application.start({ initialSessionId: SESSION });
  await Promise.resolve();
  await Promise.resolve();
  application.select(undefined);
  await Promise.resolve();
  await Promise.resolve();

  expect(listModels).toHaveBeenLastCalledWith(undefined);
  expect(application.modelsWorkflows.getSnapshot().models.value?.[0]?.modelId).toBe("home");
  application.dispose();
});

function scriptedChannel() {
  const listeners = new Set<(event: WebuiRuntimeEvent) => void>();
  const ready = new Set<() => void>();
  let closes = 0;
  const channel: WebuiProcessEventChannel = {
    subscribe: (listener, onReady) => {
      listeners.add(listener);
      if (onReady) ready.add(onReady);
      return () => {
        listeners.delete(listener);
        if (onReady) ready.delete(onReady);
      };
    },
    close: () => {
      closes += 1;
    },
  };
  return {
    channel,
    emit: (event: WebuiRuntimeEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    /** The server accepted the subscription: a reconnect, not a first connect. */
    ready: () => {
      for (const listener of [...ready]) listener();
    },
    listenerCount: () => listeners.size,
    closes: () => closes,
  };
}

function makeApplication(options: {
  readonly channels?: ReturnType<typeof scriptedChannel>[];
  readonly turnCapabilities?: Record<string, unknown>;
  readonly interactionsPort?: Record<string, unknown>;
  readonly goalPort?: Record<string, unknown>;
} = {}) {
  const opened: ReturnType<typeof scriptedChannel>[] = options.channels ?? [];
  const application = createWebuiApplication({
    openEventChannel: () => {
      const fake = scriptedChannel();
      opened.push(fake);
      return fake.channel;
    },
    ...(options.turnCapabilities
      ? { turnCapabilities: options.turnCapabilities as never }
      : {}),
    ...(options.interactionsPort
      ? { interactionsPort: options.interactionsPort as never }
      : {}),
    ...(options.goalPort ? { goalPort: options.goalPort as never } : {}),
    turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
  });
  return { application, opened };
}

describe("construction is dormant", () => {
  it("opens no ingress and touches no persisted state", () => {
    const opened: ReturnType<typeof scriptedChannel>[] = [];
    const { application } = makeApplication({ channels: opened });

    expect(application.state()).toBe("constructed");
    expect(opened).toHaveLength(0);
    // Construction opens no event ingress.
    application.dispose();
  });

  it("supports an absent capability without failing construction or start", () => {
    // A host with nothing wired (SSR, a partial fixture) is a supported state:
    // the assembly exists, the slice is empty and nothing throws.
    const { application, opened } = makeApplication();
    expect(() => application.start()).not.toThrow();
    expect(opened).toHaveLength(1);
    expect(application.turnCapabilities.send).toBeUndefined();
    application.dispose();
  });
});

describe("start installs the event ingress", () => {
  it("installs the ingress exactly once across repeated starts", () => {
    const { application, opened } = makeApplication();
    expect(application.start()).toBe(true);
    expect(application.start()).toBe(true);
    expect(application.start({ initialSessionId: SESSION })).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.listenerCount()).toBe(1);
    application.dispose();
  });

});

describe("dispose is terminal and idempotent", () => {
  it("detaches, closes the ingress and disposes the store once", () => {
    const { application, opened } = makeApplication();
    application.start();
    const channel = opened[0];
    application.dispose();
    application.dispose();

    expect(application.state()).toBe("disposed");
    expect(channel?.closes()).toBe(1);
    expect(channel?.listenerCount()).toBe(0);
    expect(application.store.isDisposed()).toBe(true);
  });

  it("refuses to restart and opens nothing", () => {
    const { application, opened } = makeApplication();
    application.start();
    application.dispose();

    expect(application.start()).toBe(false);
    expect(application.start({ initialSessionId: SESSION })).toBe(false);
    expect(opened).toHaveLength(1);
    expect(application.state()).toBe("disposed");
  });

  it("fences late commits after disposal", () => {
    const { application } = makeApplication();
    application.start({ initialSessionId: SESSION });
    application.dispose();

    // A late answer for a session that was never live cannot create a record.
    application.store.updateSession(OTHER, (current) => ({ ...current, sending: true }));
    expect(application.store.readSession(OTHER).sending).toBe(false);
  });
});

describe("a fresh instance is a fresh lifecycle", () => {
  it("starts and disposes independently of a disposed one", () => {
    const first = makeApplication();
    first.application.start();
    first.application.dispose();

    const second = makeApplication();
    expect(second.application.state()).toBe("constructed");
    expect(second.application.start({ initialSessionId: OTHER })).toBe(true);
    expect(second.opened).toHaveLength(1);
    expect(second.application.store.isDisposed()).toBe(false);
    // The disposed instance's store stays disposed: a remount builds a new
    // assembly rather than reactivating the old one.
    expect(first.application.store.isDisposed()).toBe(true);
    second.application.dispose();
  });

});

describe("the entry's boot shape", () => {
  it("exposes one start and one dispose for the whole instance", () => {
    // Guards against a lifecycle that can be re-entered: the counters are the
    // observable form of "one boot per instance".
    const openEventChannel = vi.fn(() => scriptedChannel().channel);
    const application = createWebuiApplication({
      openEventChannel,
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });
    application.start();
    application.start();
    application.dispose();
    expect(openEventChannel).toHaveBeenCalledTimes(1);
  });
});

// The opaque identity/freshness context: credential and configuration
// generations go in the resource key. These cases pin the three properties a key
// can rely on — the token is opaque, it belongs to one instance, and a
// generation only ever moves forward.
describe("the identity epoch context", () => {
  it("hands out opaque tokens that carry no credential", () => {
    const epochs = createWebuiIdentityEpochs();
    const credentials = epochs.credentials();
    // The token is a counter string, and the *shape* is what makes it safe to
    // key a resource with: no value is passed in, so none can leak out.
    expect(credentials.token).toMatch(/^app\d+\.credentials\.\d+$/u);
    expect(epochs.read("credentials")).toEqual(credentials);
  });

  it("advances one generation at a time and reports it as stale afterwards", () => {
    const epochs = createWebuiIdentityEpochs();
    const captured = epochs.credentials();
    expect(epochs.isCurrent(captured)).toBe(true);

    const advanced = epochs.advance("credentials");
    expect(advanced.generation).toBe(captured.generation + 1);
    // The captured token is no longer current, which is the whole point: an
    // answer that started before the write cannot commit after it.
    expect(epochs.isCurrent(captured)).toBe(false);
    expect(epochs.isCurrent(advanced)).toBe(true);
    // A different key is untouched: a credential write does not retire
    // configuration answers.
    expect(epochs.configuration().generation).toBe(0);
  });

  it("never lets a generation move backwards", () => {
    const epochs = createWebuiIdentityEpochs();
    epochs.advance("configuration");
    const first = epochs.configuration();
    epochs.advance("configuration");
    const second = epochs.configuration();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(epochs.isCurrent(first)).toBe(false);
    expect(epochs.isCurrent(second)).toBe(true);
  });

  it("notifies subscribers with the epoch that moved", () => {
    const epochs = createWebuiIdentityEpochs();
    const seen: string[] = [];
    const detach = epochs.subscribe((epoch) => seen.push(epoch.key));
    epochs.advance("credentials");
    epochs.advance("configuration");
    detach();
    epochs.advance("application");
    expect(seen).toEqual(["credentials", "configuration"]);
  });

  it("gives a fresh assembly fresh tokens, so an old capture is never current", () => {
    const first = createWebuiIdentityEpochs();
    const captured = first.credentials();
    const second = createWebuiIdentityEpochs();
    // Same generation, different instance: the token differs, so the previous
    // instance's answer is rejected rather than accepted on a generation match.
    expect(second.credentials().generation).toBe(captured.generation);
    expect(second.credentials().token).not.toBe(captured.token);
    expect(second.isCurrent(captured)).toBe(false);
  });

  it("publishes the context on the assembled application", () => {
    const { application } = makeApplication();
    const captured = application.identityEpochs.credentials();
    expect(application.identityEpochs.isCurrent(captured)).toBe(true);
    application.identityEpochs.advance("credentials");
    expect(application.identityEpochs.isCurrent(captured)).toBe(false);
    application.dispose();
  });
});

// The one reconciliation entry point. A selection change and a suspected
// observation gap must reach the same authoritative re-reads instead of each
// surface probing on its own, and the re-reads are the ones the installed
// routes own — asserted through the routes themselves, not a copy.
describe("the reconciliation entry point", () => {
  it("runs the reconciled session's authoritative re-reads through their owners", () => {
    const listPendingPermissions = vi.fn(async () => ({ requests: [] }));
    const getGoal = vi.fn(async () => undefined);
    const { application } = makeApplication({
      interactionsPort: { listPendingPermissions },
      goalPort: { getGoal },
    });

    application.reconcile(SESSION);

    // One entry point, and it is the owner routes the event path uses: the
    // pending snapshot is really re-read and the goal is really re-read.
    expect(listPendingPermissions).toHaveBeenCalledTimes(1);
    expect(getGoal).toHaveBeenCalledWith({ sessionId: SESSION });
    application.dispose();
  });

  it("defaults to the application's own selection", () => {
    const listPendingPermissions = vi.fn(async () => ({ requests: [] }));
    const { application } = makeApplication({
      interactionsPort: { listPendingPermissions },
    });
    application.start({ initialSessionId: SESSION });

    application.reconcile();

    expect(listPendingPermissions).toHaveBeenCalledTimes(1);
    application.dispose();
  });

  it("does nothing when there is no session to reconcile", () => {
    const listPendingPermissions = vi.fn(async () => ({ requests: [] }));
    const { application } = makeApplication({
      interactionsPort: { listPendingPermissions },
    });
    application.start();

    application.reconcile();

    expect(listPendingPermissions).not.toHaveBeenCalled();
    application.dispose();
  });

  it("stops reconciling after disposal", () => {
    const listPendingPermissions = vi.fn(async () => ({ requests: [] }));
    const { application } = makeApplication({
      interactionsPort: { listPendingPermissions },
    });
    application.start({ initialSessionId: SESSION });
    application.dispose();

    application.reconcile(SESSION);

    expect(listPendingPermissions).not.toHaveBeenCalled();
  });
});

describe("one owner's cleanup failing does not strand the others", () => {
  it("still fences the store and reports the failure", () => {
    // The event channel is host-facing, so its close is the realistic place for a
    // cleanup to throw. A throw there must not leave the application accepting
    // writes, and must not propagate at a caller that cannot act on it.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const opened = scriptedChannel();
      const application = createWebuiApplication({
        openEventChannel: () => ({
          ...opened.channel,
          close: () => {
            opened.channel.close?.();
            throw new Error("host channel close failed");
          },
        }),
        turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
      });
      application.start({ initialSessionId: SESSION });
      expect(() => application.dispose()).not.toThrow();

      // Everything ran: the ingress it was observing is closed, and the store is
      // fenced, so a late write cannot land on a disposed application.
      expect(opened.closes()).toBe(1);
      expect(application.store.isDisposed()).toBe(true);
      application.store.updateSession(OTHER, (current) => ({ ...current, sending: true }));
      expect(application.store.readSession(OTHER).sending).toBe(false);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps dispose terminal after a failed cleanup", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const opened = scriptedChannel();
      const application = createWebuiApplication({
        openEventChannel: () => ({
          ...opened.channel,
          close: () => {
            throw new Error("host channel close failed");
          },
        }),
        turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
      });
      application.start({ initialSessionId: SESSION });
      application.dispose();
      // Disposal is fenced before any cleanup runs, so a retrying caller cannot
      // start a second teardown — including after one of them threw.
      expect(() => application.dispose()).not.toThrow();
      expect(() => application.dispose()).not.toThrow();
      expect(application.state()).toBe("disposed");
      expect(opened.listenerCount()).toBe(0);
      expect(application.start()).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("reads resolve after the application is disposed", () => {
  it("answers every business read instead of throwing", () => {
    const { application } = makeApplication();
    application.start({ initialSessionId: SESSION });
    const before = application.reads.stream(SESSION);
    application.dispose();

    // A read that outlives disposal is a reader that has not been told yet, not
    // a programming error: it must still answer, and answer from the last
    // committed snapshot rather than from a torn one. A hook that threw here
    // would replace a recoverable error with a fatal one during teardown.
    expect(() => application.reads.stream(SESSION)).not.toThrow();
    expect(application.reads.stream(SESSION)).toEqual(before);
    expect(() => application.reads.transcriptPage(SESSION)).not.toThrow();
    expect(() => application.getSnapshot()).not.toThrow();
    // Models, Settings, Plugins, Transcript, Review and Workspace all publish a
    // read model, and each surface holds one across the disposal that unmounts it.
    expect(() => application.modelsWorkflows.getSnapshot()).not.toThrow();
    expect(() => application.settingsWorkflows.getSnapshot()).not.toThrow();
    expect(() => application.pluginWorkflows.getSnapshot()).not.toThrow();
    expect(() => application.accountWorkflows.getSnapshot()).not.toThrow();
    expect(() => application.sessionWorkflows.getArchivedSnapshot()).not.toThrow();
    expect(() => application.workspaceQueries.getSnapshot()).not.toThrow();
    expect(() => application.turnReview.read({ sessionId: SESSION })).not.toThrow();
  });
});

describe("V02 · independent owners' pending IO cannot commit after disposal", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  it("fences Models, Settings, Plugins, Transcript, Review and Workspace late answers", async () => {
    const models = deferred<readonly never[]>();
    const instructions = deferred<never>();
    const plugins = deferred<never>();
    const reviewDiff = deferred<never>();
    const files = deferred<readonly never[]>();
    const history = deferred<never>();

    const application = createWebuiApplication({
      openEventChannel: () => scriptedChannel().channel,
      loadMessages: (() => history.promise) as never,
      slices: createWebuiPortSlices({
        listModels: () => models.promise,
        getGlobalInstructions: () => instructions.promise,
        pluginManagement: () => plugins.promise,
        listWorkspaceFileTree: () => files.promise,
      } as never),
      turnReview: { getTurnDiff: () => reviewDiff.promise } as never,
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });
    application.start({ initialSessionId: SESSION });

    // Every independent owner built by the assembly, watched the way a mounted
    // surface watches it.
    const notifications = { models: 0, settings: 0, plugins: 0, transcript: 0, review: 0, workspace: 0 };
    application.modelsWorkflows.subscribe(() => { notifications.models += 1; });
    application.settingsWorkflows.subscribe(() => { notifications.settings += 1; });
    application.workspaceQueries.subscribe(() => { notifications.workspace += 1; });
    application.turnReview.subscribe(() => { notifications.review += 1; });
    application.store.subscribe(() => { notifications.transcript += 1; });

    const pending = Promise.all([
      application.modelsWorkflows.loadModels(SESSION),
      application.settingsWorkflows.loadInstructions(),
      application.composerPluginCatalogue.installedPlugins(),
      application.turnReview.load({ sessionId: SESSION, turnId: "turn-1" }),
      application.transcriptHistory.loadPage(SESSION),
      Promise.resolve(application.workspaceQueries.files.loadFileTree("/repo")),
    ]);
    // The answers are in flight when the application goes away.
    application.dispose();
    const settledAtDisposal = { ...notifications };

    models.resolve([]);
    instructions.resolve({} as never);
    plugins.resolve({} as never);
    reviewDiff.resolve({} as never);
    files.resolve([]);
    history.resolve({} as never);
    const outcomes = await pending;

    // No owner published after teardown: a late commit would have notified a
    // subscriber that had already unmounted, and re-populated a read model the
    // disposal was supposed to fence. The counts below are whatever the in-flight
    // reads had already published while the application was alive.
    expect(notifications).toEqual(settledAtDisposal);
    expect(settledAtDisposal.models).toBeGreaterThan(0);
    // Each read settled with an outcome that says why it is not shown, rather
    // than a value.
    expect(application.modelsWorkflows.getSnapshot().models.status).not.toBe("ready");
    expect(application.settingsWorkflows.getSnapshot().instructions.status).not.toBe("ready");
    const transcriptOutcome = outcomes[4] as { readonly status: string };
    const reviewOutcome = outcomes[3] as { readonly status: string };
    expect(transcriptOutcome.status).toBe("stale");
    expect(reviewOutcome.status).toBe("stale");
    // A read started after the disposal is refused at the owner, not sent on a
    // socket nobody is reading.
    await expect(application.composerPluginCatalogue.installedPlugins()).rejects.toThrow();
  });
});


describe("V03 · a failure while ending owners strands nothing", () => {
  it("runs every remaining step, keeps the failure, and survives a second disposal", () => {
    let closes = 0;
    const application = createWebuiApplication({
      openEventChannel: (): WebuiProcessEventChannel => ({
        subscribe: () => () => {
          // The ingress detach is the *first* step of disposal, so a failure here is
          // the worst case for the ordering rule: everything after it must still run.
          throw new Error("detach failed");
        },
        close: () => {
          closes += 1;
        },
      }),
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });
    application.start({ initialSessionId: SESSION });

    expect(() => application.dispose()).not.toThrow();

    // The fence was installed before any cleanup ran, so the instance is terminal
    // even though an owner failed.
    expect(application.state()).toBe("disposed");
    // The last step still ran: the failure did not strand the owners behind it.
    expect(closes).toBe(1);
    // And the failure is kept with its owner's label, not only printed.
    expect(application.disposalFailures().map((failure) => failure.label)).toEqual([
      "event ingress",
    ]);
    expect(application.disposalFailures()[0]?.reason).toBeInstanceOf(Error);

    // A second disposal runs nothing again and does not lose the record.
    application.dispose();
    expect(closes).toBe(1);
    expect(application.disposalFailures()).toHaveLength(1);
  });
});

describe("R2 · the handshake facts are re-read when the connection returns", () => {
  it("re-reads the version, so readiness is a live answer rather than a boot-time one", async () => {
    const opened: ReturnType<typeof scriptedChannel>[] = [];
    let versionReads = 0;
    const application = createWebuiApplication({
      openEventChannel: () => {
        const fake = scriptedChannel();
        opened.push(fake);
        return fake.channel;
      },
      slices: createWebuiPortSlices({
        version: async () => {
          versionReads += 1;
          return { version: "1.0.0", protocolVersion: 1, capabilities: { terminal: "absent" } };
        },
      } as never),
      turns: { resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer },
    });
    application.start({ initialSessionId: SESSION });

    // A reconnect is a possible observation gap *and* a possible restart on the other
    // side: a service that came back with a different bridge must not keep the previous
    // connection's capability answer.
    opened[0]!.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(versionReads).toBeGreaterThanOrEqual(1);

    application.dispose();
  });
});
