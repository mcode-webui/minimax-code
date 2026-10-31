// The browser terminal owner's watch registry: what a view release does, what a
// process disposal does, and what must never happen (a PTY killed because a view
// went away). These distinctions are claims about calls, so the cases assert the
// port's call trace.
//
// The defect this pins: `disposeAll` is documented as ending every watch AND
// every process, while the application's disposal is the only caller it has. It
// used to call `detachAll` and nothing else, so a client that went away left its
// PTYs running.

import { describe, expect, it } from "vitest";

import { createWebuiTerminalOwner } from "../../src/client/features/terminal/application/terminal-owner.js";
import { WebuiErrorCode, WebuiWireError } from "../../src/shared/envelope.js";
import { deriveWebuiCapabilityManifestFromBindings } from "../../src/shared/capability-manifest.js";
import type { WebuiTerminalFrame } from "../../src/shared/contracts/terminal.js";

interface Trace {
  readonly calls: string[];
  readonly releases: number[];
}

it("V19/V35 skips a known unavailable roster and reads after readiness changes", async () => {
  let state: "absent" | "not-ready" | "supported" = "absent";
  let reads = 0;
  const owner = createWebuiTerminalOwner({ listTerminals: async () => { reads += 1; return []; } }, {
    readCapabilities: () => ({ terminal: state }),
  });
  await owner.refresh();
  state = "not-ready"; await owner.refresh();
  expect(reads).toBe(0);
  state = "supported"; await owner.refresh();
  expect(reads).toBe(1);
  expect(owner.support().list).toBe("supported");
  owner.dispose();
});

function port(trace: Trace, terminals: string[] = ["terminal-a", "terminal-b"]) {
  let watches = 0;
  return {
    listTerminals: async () =>
      terminals.map((terminalId) => ({ terminalId, status: "running" as const, output: "" })),
    createTerminal: async ({ workspaceDir }: { readonly workspaceDir: string }) => {
      trace.calls.push(`create:${workspaceDir}`);
      return { terminalId: "terminal-new", status: "running" as const };
    },
    writeTerminal: async ({ terminalId, data }: { readonly terminalId: string; readonly data: string }) => {
      trace.calls.push(`write:${terminalId}:${data}`);
    },
    resizeTerminal: async ({ terminalId, cols, rows }: { readonly terminalId: string; readonly cols: number; readonly rows: number }) => {
      trace.calls.push(`resize:${terminalId}:${cols}x${rows}`);
    },
    disposeTerminal: async ({ terminalId }: { readonly terminalId: string }) => {
      trace.calls.push(`dispose:${terminalId}`);
    },
    watchTerminal: (_request: { readonly terminalId: string }, _onFrame: (frame: WebuiTerminalFrame) => void) => {
      const index = (watches += 1);
      trace.calls.push(`watch:${index}`);
      return () => {
        trace.calls.push(`release:${index}`);
        trace.releases.push(index);
      };
    },
  };
}

const newTrace = (): Trace => ({ calls: [], releases: [] });


/** The manifest a service would serve for the given declared-and-wired operations. */
function manifestFor(wired: readonly string[], notWired: readonly string[] = []) {
  const wiredSet = new Set(wired);
  const declaredOnly = new Set(notWired);
  return deriveWebuiCapabilityManifestFromBindings((operation) => ({
    declared: wiredSet.has(operation) || declaredOnly.has(operation),
    wired: wiredSet.has(operation),
  }));
}

describe("the terminal owner's watch registry", () => {
  it("returns a real disposer that releases its watch exactly once", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    const release = owner.attach("terminal-a", () => undefined);
    expect(trace.calls).toEqual(["watch:1"]);
    release();
    release();
    expect(trace.calls).toEqual(["watch:1", "release:1"]);
  });

  it("supersedes the previous watch when the same terminal is attached again", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    owner.attach("terminal-a", () => undefined);
    owner.attach("terminal-a", () => undefined);
    expect(trace.calls).toEqual(["watch:1", "release:1", "watch:2"]);
  });

  it("detaches every watch without touching a single process", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    owner.attach("terminal-a", () => undefined);
    owner.attach("terminal-b", () => undefined);
    owner.detachAll();
    expect(trace.releases).toEqual([1, 2]);
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:"))).toEqual([]);
  });

  it("ends the watches and no process at all on disposal", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    await owner.refresh();
    owner.attach("terminal-a", () => undefined);
    owner.dispose();
    expect(trace.releases).toEqual([1]);
    // `port(trace)` lists `terminal-a` and `terminal-b`, and neither is this
    // page's to end: observing a process is not owning it.
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:"))).toEqual([]);
  });

  it("releases a terminal's watch before asking the port to dispose it", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    owner.attach("terminal-a", () => undefined);
    await owner.disposeProcess("terminal-a");
    expect(trace.calls.indexOf("release:1")).toBeLessThan(trace.calls.indexOf("dispose:terminal-a"));
  });

  it("publishes what the port can do and what the catalogue holds", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    expect(owner.canWatch).toBe(true);
    expect(owner.canCreate).toBe(true);
    expect(owner.getSnapshot().terminals).toEqual([]);
    await owner.refresh();
    expect(owner.getSnapshot().terminals.map((entry) => entry.terminalId)).toEqual([
      "terminal-a",
      "terminal-b",
    ]);
    await owner.create("/tmp/workspace");
    expect(trace.calls[0]).toBe("create:/tmp/workspace");
  });

  it("keeps a port that offers nothing safe to hold", async () => {
    const owner = createWebuiTerminalOwner({});
    expect(owner.canCreate).toBe(false);
    expect(owner.canWatch).toBe(false);
    expect(owner.attach("terminal-a", () => undefined)).toBeTypeOf("function");
    expect(() => owner.dispose()).not.toThrow();
  });
});

describe("V29 · an absent bridge and an incompatible one are different failures", () => {
  it("reports absent for an operation this host does not provide", async () => {
    const owner = createWebuiTerminalOwner({ listTerminals: async () => [] });

    expect(owner.support()).toEqual({
      create: "absent",
      // No manifest arrived, so nothing established that this works: the port offers
      // the operation and the state says exactly that — an attempt is allowed, and
      // nothing claims it works. Calling it `supported` is how a control gets offered
      // on the strength of a browser stub.
      list: "unverified",
      write: "absent",
      resize: "absent",
      dispose: "absent",
      watch: "absent",
    });
    // Nothing is broken and nothing should be retried: the operation was never
    // there to be refused.
    expect(owner.support().create).not.toBe("incompatible");
    // The attempt stays available even though support is not claimed.
    expect(owner.canCreate).toBe(false);
  });

  it("reports incompatible for an operation this host provides and refuses", async () => {
    const owner = createWebuiTerminalOwner({
      listTerminals: async () => {
        throw new WebuiWireError(
          WebuiErrorCode.unknownOperation,
          "unknown operation ListTerminals",
        );
      },
      createTerminal: async () => {
        throw new WebuiWireError(
          WebuiErrorCode.unknownOperation,
          "unknown operation CreateTerminal",
        );
      },
    });

    await expect(owner.refresh()).resolves.toBeUndefined();
    expect(owner.support().list).toBe("incompatible");
    // The refusal is what makes this observable, and it is reported rather than
    // rendered as an empty roster: telling the user their shells had all exited
    // would be worse than the failure.
    expect(owner.getSnapshot().error).toContain("unknown operation");
    await expect(owner.create("/tmp")).rejects.toThrow("unknown operation");
    expect(owner.support().create).toBe("incompatible");
    // The can* flags keep answering "may I", and they now answer it against what
    // the host actually did rather than against what it declared.
    expect(owner.canCreate).toBe(false);
    expect(owner.support().write).toBe("absent");
  });

  it("does not retire the surface for a failure that is not about the bridge", async () => {
    // A permission denial, a busy terminal or a transport failure answers a *call*.
    // Marking the operation incompatible for one of those retires a surface that would
    // have worked on the next attempt — and it was doing so for every failure.
    const owner = createWebuiTerminalOwner({
      listTerminals: async () => {
        throw new WebuiWireError(WebuiErrorCode.runtimeRejected, "permission denied");
      },
      createTerminal: async () => {
        throw new Error("socket closed before the response");
      },
    });

    await expect(owner.refresh()).resolves.toBeUndefined();
    expect(owner.support().list).not.toBe("incompatible");
    expect(owner.support().list).toBe("unverified");
    await expect(owner.create("/tmp")).rejects.toThrow("socket closed");
    expect(owner.support().create).toBe("unverified");
    // Still attemptable: nothing about the bridge was decided.
    expect(owner.canCreate).toBe(true);
  });

  it("keeps the roster honest when the host has no terminal service at all", async () => {
    const owner = createWebuiTerminalOwner({});
    await owner.refresh();
    expect(owner.getSnapshot()).toEqual({ terminals: [], loading: false });
    expect(owner.support().list).toBe("absent");
  });

  it("records a refused watch without keeping a disposer for a stream that never opened", () => {
    const owner = createWebuiTerminalOwner({
      watchTerminal: () => {
        throw new WebuiWireError(WebuiErrorCode.protocolMismatch, "protocol mismatch");
      },
    });

    expect(() => owner.attach("terminal-a", () => undefined)).toThrow("protocol mismatch");
    expect(owner.support().watch).toBe("incompatible");
    // Disposal still resolves: nothing is registered to release.
    expect(() => owner.detachAll()).not.toThrow();
  });
});

describe("V04 · V26 · a PTY belongs to the service, not to the page that opened it", () => {
  // These two rows are about lifetime across a *view* boundary, and the registry
  // cases above only ever exercise one owner in one lifetime. The owner's whole
  // reason to exist is that the panel holding it is a view: what has to survive
  // is the process, and what must not survive is the panel's xterm and frame
  // subscription.
  function serviceHarness() {
    const trace = newTrace();
    // The service keeps the terminal table the client rosters from, so a created
    // terminal is visible to the next `refresh` — the same thing a reload sees.
    // A static list would make "the PTY survived" true for the wrong reason.
    const live = new Set(["terminal-a", "terminal-b"]);
    let counter = 0;
    const wire = {
      ...port(trace, []),
      listTerminals: async () =>
        [...live].map((terminalId) => ({ terminalId, status: "running" as const, output: "" })),
      createTerminal: async ({ workspaceDir }: { readonly workspaceDir: string }) => {
        trace.calls.push(`create:${workspaceDir}`);
        counter += 1;
        const terminalId = `terminal-${counter}`;
        live.add(terminalId);
        return { terminalId, status: "running" as const };
      },
      disposeTerminal: async ({ terminalId }: { readonly terminalId: string }) => {
        trace.calls.push(`dispose:${terminalId}`);
        live.delete(terminalId);
      },
    };
    return { trace, live, owner: createWebuiTerminalOwner(wire), counter: () => counter };
  }

  it("V04 · keeps the PTY alive when the page that opened it goes away", async () => {
    const { trace, owner } = serviceHarness();
    const terminal = await owner.create("/repo");
    expect(terminal?.terminalId).toBe("terminal-1");
    // The panel then mounts its xterm, which is a frame subscription.
    owner.attach("terminal-1", () => undefined);

    // The panel unmounts: it releases its watch and its xterm. Nothing else.
    owner.detachAll();
    expect(trace.releases).toEqual([1]);
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:"))).toEqual([]);

    // The process is still there, and a page that mounts again sees it in the
    // roster — so the user's shell survived the tab closing.
    await owner.refresh();
    const rosters = owner.getSnapshot().terminals.map((entry) => entry.terminalId);
    // Set iteration order is not the contract; membership is.
    expect([...rosters].sort()).toEqual(["terminal-1", "terminal-a", "terminal-b"]);
    expect(owner.canDispose).toBe(true);
  });

  it("V26 · a PTY whose creating page unmounted before the create answered is still adoptable", async () => {
    // The create is in flight when the panel goes away. The panel's disposal is
    // not a reason to abandon or lose the answer: the process exists either way,
    // and the owner that outlives the panel has to hold it.
    let resolveCreate: (() => void) | undefined;
    const trace = newTrace();
    const live = new Set<string>();
    const owner = createWebuiTerminalOwner({
      ...port(trace, []),
      listTerminals: async () =>
        [...live].map((terminalId) => ({ terminalId, status: "running" as const, output: "" })),
      createTerminal: async ({ workspaceDir }: { readonly workspaceDir: string }) => {
        trace.calls.push(`create:${workspaceDir}`);
        // Deliberately slow: the answer lands after the view is gone.
        return new Promise<{ terminalId: string; status: "running" }>((resolve) => {
          resolveCreate = () => {
            live.add("terminal-late");
            resolve({ terminalId: "terminal-late", status: "running" });
          };
        });
      },
    });

    const pending = owner.create("/repo");
    // The panel goes away before the answer — it had mounted nothing yet, so
    // there is no watch to release; the point is that the *process* survives.
    owner.detachAll();
    resolveCreate?.();
    const created = await pending;

    expect(created?.terminalId).toBe("terminal-late");
    // The roster picks it up, so a remounting panel renders it rather than
    // showing an empty terminal list and offering a second create.
    await owner.refresh();
    expect(owner.getSnapshot().terminals.map((entry) => entry.terminalId)).toContain(
      "terminal-late",
    );
    // And it was not killed on the way: a view leaving never disposes a process.
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:"))).toEqual([]);
  });

  it("V06 · an explicit close ends exactly its target, and disposal ends only observation", async () => {
    const { trace, owner } = serviceHarness();
    await owner.create("/repo");
    await owner.create("/repo");
    owner.attach("terminal-1", () => undefined);
    // The explicit close is the only process command this test expects: one
    // target, one disposal.
    const closed = trace.calls.filter((entry) => entry.startsWith("dispose:"));
    await owner.disposeProcess("terminal-1");
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:"))).toEqual([
      ...closed,
      "dispose:terminal-1",
    ]);
    // Page teardown adds no process command: the other terminal stays the
    // service's, and the watch is released.
    const beforeDispose = trace.calls.filter((entry) => entry.startsWith("dispose:")).length;
    owner.dispose();
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:")).length).toBe(beforeDispose);
    // Disposal is terminal and idempotent.
    owner.dispose();
    expect(trace.calls.filter((entry) => entry.startsWith("dispose:")).length).toBe(beforeDispose);
  });

  it("fences the page: a create landing after disposal does not reach a dead owner", async () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace));
    owner.dispose();
    expect(await owner.create("/repo")).toBeUndefined();
    await owner.refresh();
    await owner.write("terminal-a", "ls\n");
    // Every command is refused at the fence rather than sent to the service.
    expect(trace.calls.some((entry) => entry.startsWith("create:") || entry.startsWith("write:"))).toBe(false);
    expect(owner.getSnapshot().terminals).toEqual([]);
  });
});

describe("V19/V29 · what the handshake declares decides more than the port's shape", () => {
  it("calls a family the service declared supported supported, without probing", () => {
    const trace = newTrace();
    const owner = createWebuiTerminalOwner(port(trace), {
      readCapabilities: () =>
        manifestFor([
          "listTerminals",
          "createTerminal",
          "disposeTerminal",
          "watchTerminal",
          "writeTerminal",
          "resizeTerminal",
        ]),
    });

    expect(owner.support().create).not.toBe("incompatible");
    // Nothing was asked of the port: the declaration answered the question.
    expect(trace.calls).toEqual([]);
  });

  it("distinguishes a bridge that is not ready from one that is absent", () => {
    const owner = createWebuiTerminalOwner(port(newTrace()), {
      // A roster with no frame stream lists terminals nobody can use: the operations are
      // declared and wired, and the prerequisite the family needs is not.
      readCapabilities: () =>
        manifestFor(["listTerminals", "createTerminal", "disposeTerminal"], [
          "watchTerminal",
          "writeTerminal",
          "resizeTerminal",
        ]),
    });
    expect(owner.support().list).toBe("not-ready");

    const gone = createWebuiTerminalOwner(port(newTrace()), {
      readCapabilities: () => manifestFor([]),
    });
    expect(gone.support().list).toBe("absent");
  });

  it("keeps the historical attempt path when the service sent no manifest", async () => {
    const trace = newTrace();
    // No manifest: an older service, so neither support nor absence is fabricated
    // here — the port's presence keeps the attempt available, and only a refusal
    // that actually came back makes an operation incompatible.
    const owner = createWebuiTerminalOwner(port(trace));
    expect(owner.support().create).not.toBe("incompatible");
    expect(owner.support().create).not.toBe("absent");
  });
});
