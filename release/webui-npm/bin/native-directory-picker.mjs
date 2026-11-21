import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function nativeDirectoryPickerEligible({ platform, tty, bindHost, fullAccess, browserSetting }) {
  const setting = browserSetting?.trim().toLowerCase();
  return platform === 'win32' && tty === true && !fullAccess
    && ['127.0.0.1', '::1'].includes(bindHost)
    && !['0', 'false', 'no', 'off', 'never'].includes(setting);
}

export function nativeDirectoryLaunchUrl(url, grant) {
  const result = new URL(url);
  result.hash = new URLSearchParams({ nativeDirectoryGrant: grant }).toString();
  return result.href;
}

// A narrow launcher-owned provider, never a shell/command execution endpoint.
export function createWindowsDirectoryPicker({
  spawnProcess = spawn, readScript = () => readFile(new URL('./native-directory-picker.ps1', import.meta.url), 'utf8'),
  windowsRoot = process.env.SystemRoot, architecture = process.arch,
} = {}) {
  let active;
  let disposed = false;
  const unavailable = () => new Error('Native folder selection is unavailable');
  return {
    grant: randomUUID(),
    async choose(signal) {
      if (disposed || active || signal.aborted || !windowsRoot || !path.win32.isAbsolute(windowsRoot)) throw unavailable();
      let script;
      try { script = await readScript(); } catch { throw unavailable(); }
      if (disposed || active || signal.aborted) throw unavailable();
      // A 32-bit launcher must reach 64-bit Windows PowerShell, not its redirected SysWOW64 copy.
      const system = architecture === 'ia32' ? 'Sysnative' : 'System32';
      const executable = path.win32.join(windowsRoot, system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return new Promise((resolve, reject) => {
        let child;
        let output = '';
        let settled = false;
        let aborting = false;
        let killWatchdog;
        let markClosed;
        const closed = new Promise((resolveClosed) => { markClosed = resolveClosed; });
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killWatchdog);
          signal.removeEventListener('abort', abort);
          if (error) reject(unavailable()); else resolve(result);
        };
        const abort = () => {
          if (aborting || settled) return;
          aborting = true;
          try { child?.kill('SIGKILL'); } catch { /* Never disclose process arguments. */ }
          // Do not release the HTTP flight until the process actually closes.
          // If termination cannot be confirmed, fail closed for this launcher's lifetime.
          if (!settled) killWatchdog = setTimeout(() => { disposed = true; finish(unavailable()); }, 1000);
        };
        // Independent bound also covers callers other than the HTTP service.
        const timer = setTimeout(abort, 120_000);
        try {
          child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
          active = { abort, closed };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            output += chunk.toString('utf8');
            if (Buffer.byteLength(output) > 32768) abort();
          });
          child.once('error', () => {
            if (!child.pid) { active = undefined; markClosed(); }
            finish(unavailable());
          });
          child.once('close', (code) => {
            active = undefined;
            markClosed();
            if (aborting || code !== 0) { finish(unavailable()); return; }
            try {
              const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
              if (result.kind === 'cancelled') finish(null, { kind: 'cancelled' });
              else if (result.kind === 'selected' && typeof result.directory === 'string'
                && path.win32.isAbsolute(result.directory) && !/[\0\r\n]/.test(result.directory)) {
                finish(null, { kind: 'selected', directory: result.directory });
              } else finish(unavailable());
            } catch { finish(unavailable()); }
          });
        } catch { active = undefined; finish(unavailable()); }
      });
    },
    async dispose() {
      disposed = true;
      const pending = active;
      if (!pending) return;
      pending.abort();
      // A stuck child cannot indefinitely block service shutdown. No later choose is admitted.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(unavailable()), 1000);
        pending.closed.then(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
