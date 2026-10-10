import os from "node:os";
import process from "node:process";
import { createRequire } from "node:module";

type Pty = { readonly pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(): void; onData(listener: (data: string) => void): void; onExit(listener: () => void): void };
type PtyModule = { spawn(shell: string, args: string[], options: Record<string, unknown>): Pty };
const require = createRequire(import.meta.url);

type Terminal = { readonly id: string; readonly pty: Pty; readonly output: string[]; readonly listeners: Set<(data: string) => void>; exited: boolean };

export class WebuiTerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  constructor(private readonly loadPty: () => PtyModule = () => require("node-pty") as PtyModule) {}
  create(workspaceDir: string) {
    if (this.terminals.size >= 5) throw new Error("最多可以打开 5 个终端");
    const id = `terminal-${crypto.randomUUID()}`;
    let ptyModule: PtyModule;
    try {
      ptyModule = this.loadPty();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`终端原生模块加载失败；请在 node_modules/node-pty 内执行 npx --yes node-gyp rebuild。${detail}`);
    }
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    const child = ptyModule.spawn(shell, process.platform === "win32" ? [] : ["-il"], { name: "xterm-256color", cols: 80, rows: 24, cwd: workspaceDir, env: { ...process.env, TERM: "xterm-256color" } });
    const terminal: Terminal = { id, pty: child, output: [], listeners: new Set(), exited: false };
    child.onData((data) => { terminal.output.push(data); if (terminal.output.length > 10000) terminal.output.shift(); for (const listener of terminal.listeners) listener(data); });
    child.onExit(() => { terminal.exited = true; for (const listener of terminal.listeners) listener(""); });
    this.terminals.set(id, terminal);
    return { terminalId: id, status: "running" as const };
  }
  list() { return [...this.terminals.values()].map((terminal) => ({ terminalId: terminal.id, status: terminal.exited ? "exited" : "running", output: terminal.output.join("") })); }
  write(terminalId: string, data: string) { this.get(terminalId).pty.write(data); return { success: true as const }; }
  resize(terminalId: string, cols: number, rows: number) { this.get(terminalId).pty.resize(cols, rows); return { success: true as const }; }
  dispose(terminalId: string) { const terminal = this.get(terminalId); terminal.pty.kill(); this.terminals.delete(terminalId); return { success: true as const }; }
  async *watch(terminalId: string, signal?: AbortSignal): AsyncIterable<{ readonly terminalId: string; readonly data: string; readonly exited: boolean }> {
    const terminal = this.get(terminalId);
    const queue: string[] = [...terminal.output];
    let wake: (() => void) | undefined;
    const listener = (data: string) => { queue.push(data); wake?.(); };
    terminal.listeners.add(listener);
    try { while (!signal?.aborted && (!terminal.exited || queue.length)) { if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; }); else { const data = queue.shift() ?? ""; yield { terminalId, data, exited: terminal.exited }; } } }
    finally { terminal.listeners.delete(listener); }
  }
  disposeBySession() { for (const terminal of this.terminals.values()) terminal.pty.kill(); this.terminals.clear(); }
  private get(id: string) { const terminal = this.terminals.get(id); if (!terminal) throw new Error("终端不存在"); return terminal; }
}
