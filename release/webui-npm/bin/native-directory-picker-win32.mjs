// Windows native folder chooser driver. The dialog lives in a child process
// (native-directory-picker-worker.cjs) so the server event loop never blocks
// inside the modal Win32 call; this module only owns the IPC conversation and
// keeps one pick in flight, exactly like the other platform adapters.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER = fileURLToPath(new URL('./native-directory-picker-worker.cjs', import.meta.url));
const TITLE = '选择文件夹';
const unavailable = () => new Error('Native folder selection is unavailable');

export function createWin32DirectoryPicker({ spawnProcess = spawn, timeoutMs = 120_000 } = {}) {
  let active;
  let disposed = false;

  function choose(signal) {
    if (disposed || active || signal.aborted) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let aborting = false;
      let timer;
      let killWatchdog;
      let markClosed;
      const closed = new Promise((resolveClosed) => { markClosed = resolveClosed; });

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killWatchdog);
        signal.removeEventListener('abort', abort);
        child?.unref?.();
        if (error) reject(unavailable()); else resolve(result);
      };

      const abort = () => {
        if (aborting || settled) return;
        aborting = true;
        try { child?.kill(); } catch { /* The close event still decides the outcome. */ }
        // Never release the HTTP flight before the process is known to be gone.
        killWatchdog = setTimeout(() => { disposed = true; finish(unavailable()); }, 1000);
      };

      timer = setTimeout(abort, timeoutMs);
      try {
        child = spawnProcess(process.execPath, [WORKER], {
          env: { ...process.env, MCODE_DIALOG_TITLE: TITLE },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
      } catch {
        finish(unavailable());
        return;
      }
      active = { abort, closed };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.once('error', () => finish(unavailable()));
      child.once('close', () => {
        active = undefined;
        markClosed();
        if (!settled) finish(unavailable());
      });
      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.kind === 'error') { finish(unavailable()); return; }
        if (message.kind !== 'done') return;
        if (message.path === null || message.path === undefined || message.path === '') {
          finish(null, { kind: 'cancelled' });
          return;
        }
        if (typeof message.path !== 'string' || !path.win32.isAbsolute(message.path) || /[\0\r\n]/.test(message.path)) {
          finish(unavailable());
          return;
        }
        finish(null, { kind: 'selected', directory: message.path });
      });
    });
  }

  return {
    grant: randomUUID(),
    choose,
    async dispose() {
      disposed = true;
      const pending = active;
      if (!pending) return;
      pending.abort();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(unavailable()), 1000);
        pending.closed.then(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}