// The terminal process manager: cancellation, resource traces and the limits
// these cases pin. The native module is injected, so every case runs without a
// PTY — but it runs against the real manager: the same queue, the same listener
// bookkeeping, the same disposal paths the service drives.
//
// Why the traces matter: "exactly once" is a claim about calls, not about a
// state we can read from outside. Each case therefore asserts the call trace the
// fake PTY recorded (one kill, one release, the resize values that were asked
// for) instead of asserting that nothing seemed to happen.

import { describe, expect, it } from "vitest";

import { WebuiTerminalManager } from "../../src/runtime/terminal.js";

interface FakePty {
  readonly pid: number;
  data: (data: string) => void;
  exit: () => void;
  kills: number;
  readonly resizes: Array<readonly [number, number]>;
  readonly writes: string[];
}

function fakePtyModule(trace: string[]) {
  const ptys: FakePty[] = [];
  const module = {
    spawn: () => {
      const pty: FakePty = {
        pid: 1000 + ptys.length,
        data: () => undefined,
        exit: () => undefined,
        kills: 0,
        resizes: [],
        writes: [],
      };
      ptys.push(pty);
      trace.push(`spawn:${pty.pid}`);
      return {
        get pid() {
          return pty.pid;
        },
        write: (data: string) => {
          pty.writes.push(data);
          trace.push(`write:${data}`);
        },
        resize: (cols: number, rows: number) => {
          pty.resizes.push([cols, rows]);
          trace.push(`resize:${cols}x${rows}`);
        },
        kill: () => {
          pty.kills += 1;
          trace.push(`kill:${pty.pid}`);
        },
        onData: (listener: (data: string) => void) => {
          pty.data = listener;
        },
        onExit: (listener: () => void) => {
          pty.exit = listener;
        },
      };
    },
  };
  return { ptys, module: module as never };
}

function collect(iterable: AsyncIterable<{ readonly data: string; readonly exited: boolean }>) {
  const frames: string[] = [];
  const done = (async () => {
    for await (const frame of iterable) frames.push(`${frame.data}|${frame.exited}`);
  })();
  return { frames, done };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the terminal process manager — identities and limits", () => {
  it("gives every terminal its own identity and reports it running", () => {
    const manager = new WebuiTerminalManager(() => fakePtyModule([]).module);
    const first = manager.create("/tmp/a");
    const second = manager.create("/tmp/a");
    expect(first.terminalId).not.toBe(second.terminalId);
    expect(manager.list()).toHaveLength(2);
    expect(manager.list().every((entry) => entry.status === "running")).toBe(true);
  });

  it("holds the process count at five and frees a slot when one is disposed", () => {
    const manager = new WebuiTerminalManager(() => fakePtyModule([]).module);
    const ids = Array.from({ length: 5 }, () => manager.create("/tmp/a").terminalId);
    expect(() => manager.create("/tmp/a")).toThrow("最多可以打开 5 个终端");
    manager.dispose(ids[0]);
    expect(() => manager.create("/tmp/a")).not.toThrow();
    expect(manager.list()).toHaveLength(5);
  });

  it("keeps a terminal's output and its exited state in the catalogue", () => {
    const fake = fakePtyModule([]);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    fake.ptys[0].data("hello ");
    fake.ptys[0].data("world");
    expect(manager.list()[0].output).toBe("hello world");
    expect(manager.list()[0].status).toBe("running");
    fake.ptys[0].exit();
    expect(manager.list()[0].status).toBe("exited");
    expect(manager.list()[0].output).toBe("hello world");
  });

  it("passes write and resize through with the exact values asked for", () => {
    const trace: string[] = [];
    const fake = fakePtyModule(trace);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    manager.write(terminalId, "echo hi\n");
    manager.resize(terminalId, 120, 40);
    expect(fake.ptys[0].writes).toEqual(["echo hi\n"]);
    expect(fake.ptys[0].resizes).toEqual([[120, 40]]);
    expect(trace).toContain("resize:120x40");
  });
});

describe("the terminal process manager — disposal", () => {
  it("kills once per dispose and refuses a repeated dispose without killing again", () => {
    const trace: string[] = [];
    const fake = fakePtyModule(trace);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    manager.dispose(terminalId);
    expect(fake.ptys[0].kills).toBe(1);
    expect(manager.list()).toHaveLength(0);
    expect(() => manager.dispose(terminalId)).toThrow("终端不存在");
    expect(fake.ptys[0].kills).toBe(1);
    expect(trace.filter((entry) => entry.startsWith("kill:")).length).toBe(1);
  });

  it("ends every process and empties the catalogue on the session-wide disposal", () => {
    const fake = fakePtyModule([]);
    const manager = new WebuiTerminalManager(() => fake.module);
    manager.create("/tmp/a");
    manager.create("/tmp/a");
    manager.disposeBySession();
    expect(fake.ptys.every((pty) => pty.kills === 1)).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  it("refuses write, resize and watch against an identity it does not hold", async () => {
    const manager = new WebuiTerminalManager(() => fakePtyModule([]).module);
    expect(() => manager.write("terminal-nope", "x")).toThrow("终端不存在");
    expect(() => manager.resize("terminal-nope", 80, 24)).toThrow("终端不存在");
    // An async generator's body runs on the first iteration, not at the call.
    await expect(collect(manager.watch("terminal-nope")).done).rejects.toThrow("终端不存在");
  });
});

describe("the terminal process manager — cancellation finalizes exactly once", () => {
  it("replays the buffered output, then delivers live frames", async () => {
    const fake = fakePtyModule([]);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    fake.ptys[0].data("buffered");
    const { frames, done } = collect(manager.watch(terminalId));
    await settle();
    expect(frames).toEqual(["buffered|false"]);
    fake.ptys[0].data("live");
    await settle();
    expect(frames).toEqual(["buffered|false", "live|false"]);
    fake.ptys[0].exit();
    await done;
    expect(frames.at(-1)).toBe("|true");
  });

  it("wakes a parked iterator when the terminal exits with no output at all", async () => {
    const fake = fakePtyModule([]);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    const { frames, done } = collect(manager.watch(terminalId));
    await settle();
    expect(frames).toEqual([]);
    fake.ptys[0].exit();
    await done;
    expect(frames).toEqual(["|true"]);
  });

  it("finalizes a parked iterator on abort and never calls its listener again", async () => {
    const fake = fakePtyModule([]);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    const controller = new AbortController();
    const { frames, done } = collect(manager.watch(terminalId, controller.signal));
    await settle();
    controller.abort();
    await done;
    expect(frames).toEqual([]);
    fake.ptys[0].data("after abort");
    await settle();
    expect(frames).toEqual([]);
  });

  it("keeps a second watcher alive when the first cancels", async () => {
    const fake = fakePtyModule([]);
    const manager = new WebuiTerminalManager(() => fake.module);
    const { terminalId } = manager.create("/tmp/a");
    const first = new AbortController();
    const one = collect(manager.watch(terminalId, first.signal));
    const two = collect(manager.watch(terminalId));
    await settle();
    first.abort();
    await one.done;
    fake.ptys[0].data("still watched");
    await settle();
    expect(one.frames).toEqual([]);
    expect(two.frames).toEqual(["still watched|false"]);
    fake.ptys[0].exit();
    await two.done;
  });
});
