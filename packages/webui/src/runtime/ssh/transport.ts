// The SSH transport: the system `ssh` binary, and nothing else.
//
// Desktop spawns `ssh` the same way (`ssh-runtime/ssh-process.js`), and this port keeps that: the
// argument vector goes straight to `spawn`, the process owns its own group so it can be stopped
// without touching anything else, and there is no npm SSH client anywhere in this path.
//
// Two surfaces:
//
//   * `run` — one command, its output captured. This is the probe and the directory listing.
//   * `spawnTerminal` — an interactive session on a local pseudo-terminal, so OpenSSH can carry the
//     window size to the remote pseudo-terminal it allocates. A remote pty whose size cannot be
//     changed is a terminal that is lying about its size, so the local side is a real pty too.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Pty = {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: () => void): void;
};
type PtyModule = {
  spawn(command: string, args: string[], options: Record<string, unknown>): Pty;
};

export interface SshCommandOptions {
  /** The environment the child sees. The caller's environment is the base. */
  readonly env?: Record<string, string | undefined>;
  /** How long the command may run. The default is OpenSSH's own connect timeout plus a margin. */
  readonly timeoutMs?: number;
}

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** Whether the command was stopped because it ran out of time. */
  readonly timedOut: boolean;
  /** The failure that stopped the process from starting at all (`ENOENT` for a missing `ssh`). */
  readonly spawnError?: NodeJS.ErrnoException;
}

export interface SshTerminalSpawnOptions {
  readonly cols: number;
  readonly rows: number;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

export interface SshTerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: { readonly code: number }) => void): void;
}

export interface SshTransport {
  /** Run one `ssh` invocation and capture what it wrote. */
  run(args: readonly string[], options?: SshCommandOptions): Promise<SshCommandResult>;
  /** Start one interactive `ssh` session on a local pseudo-terminal. */
  spawnTerminal(args: readonly string[], options: SshTerminalSpawnOptions): SshTerminalProcess;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** The environment a child gets: the caller's, with the caller's overrides applied. */
function childEnvironment(env?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

/**
 * Stop one process tree.
 *
 * The child was spawned detached, so it owns a process group and the group is what is signalled —
 * a signal to the child alone would leave OpenSSH's own children behind.
 */
function stopProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") child.kill("SIGTERM");
  }
}

/**
 * The transport over the system `ssh` binary.
 *
 * The pty loader is injectable so a test can drive the terminal without the native module, and so
 * a build without it can still serve the command surface.
 */
export function createSystemSshTransport(
  loadPty: () => PtyModule = () => require("node-pty") as PtyModule,
): SshTransport {
  return {
    run(args, options = {}) {
      return new Promise<SshCommandResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

        const child = spawn("ssh", [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: childEnvironment(options.env),
          detached: process.platform !== "win32",
        });

        const finish = (result: SshCommandResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          timedOut = true;
          stopProcessTree(child);
        }, timeoutMs);
        // The timer must not hold the process open on its own.
        timer.unref?.();

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish({
            stdout,
            stderr,
            code: null,
            timedOut,
            spawnError: error,
          });
        });
        child.on("close", (code, signal) => {
          finish({ stdout, stderr, code, signal, timedOut });
        });
      });
    },

    spawnTerminal(args, options) {
      const ptyModule = loadPty();
      const child = ptyModule.spawn("ssh", [...args], {
        name: "xterm-256color",
        cols: Math.max(2, Math.min(500, Math.floor(options.cols))),
        rows: Math.max(1, Math.min(300, Math.floor(options.rows))),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...childEnvironment(options.env), TERM: "xterm-256color" },
      });
      return {
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        kill: () => child.kill(),
        onData: (listener) => child.onData(listener),
        onExit: (listener) =>
          child.onExit(() => listener({ code: 0 })),
      };
    },
  };
}
