import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { createWin32DirectoryPicker } from './native-directory-picker-win32.mjs';

export function nativeDirectoryPickerEligible({ platform, tty, desktopHost = false, bindHost, fullAccess, env = process.env }) {
  // Ordinary launches stay interactive. A desktop host opts in explicitly
  // because its embedded page cannot supply a TTY; the Win32 worker brings the
  // dialog to the foreground itself. WEBUI_OPEN_BROWSER only controls the
  // system browser and never this capability.
  const desktop = platform === 'win32' || platform === 'darwin'
    || (platform === 'linux' && Boolean(env.DISPLAY || env.WAYLAND_DISPLAY));
  const attended = desktopHost === true || tty === true;
  return desktop && attended && !fullAccess && !env.SSH_CONNECTION && !env.SSH_TTY
    && ['127.0.0.1', '::1'].includes(bindHost);
}

export function nativeDirectoryLaunchUrl(url, grant) {
  const result = new URL(url);
  result.hash = new URLSearchParams({ nativeDirectoryGrant: grant }).toString();
  return result.href;
}

function isExecutable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

async function zenityStartingFolder(previous, userHome) {
  for (const candidate of [previous, userHome]) {
    if (!candidate || !path.posix.isAbsolute(candidate)) continue;
    // Zenity treats a filename without the final slash as a child of the starting folder.
    const folder = candidate.endsWith('/') ? candidate : candidate + '/';
    let timer;
    try {
      // A disconnected share must not hold the chooser's HTTP flight indefinitely.
      await Promise.race([
        access(folder, constants.R_OK | constants.X_OK),
        new Promise((_, reject) => { timer = setTimeout(reject, 1000); }),
      ]);
      return folder;
    } catch { /* Try the next local starting folder. */ }
    finally { clearTimeout(timer); }
  }
  return '/';
}

function unixDirectoryCommand(platform, env, executable) {
  if (platform === 'darwin') {
    // Standard Additions runs the chooser in the owned osascript process.
    return ['/usr/bin/osascript', ['-e', [
      'try', 'activate', 'return POSIX path of (choose folder)',
      'on error number -128', 'return "cancelled"', 'end try',
    ].join('\n')]];
  }
  if (platform !== 'linux') return;
  const kde = env.XDG_CURRENT_DESKTOP?.split(':').some((name) => name.toLowerCase() === 'kde');
  for (const program of kde ? ['kdialog', 'zenity'] : ['zenity', 'kdialog']) {
    // Use the distribution's installed chooser, independent of the project and its PATH.
    for (const bin of ['/usr/bin', '/run/current-system/sw/bin']) {
      const file = path.posix.join(bin, program);
      if (executable(file)) {
        const args = program === 'zenity' ? ['--file-selection', '--directory'] : ['--getexistingdirectory', '.'];
        return [file, args];
      }
    }
  }
}

function directoryResult(platform, code, output, cancelExitCode) {
  if (platform === 'linux' && code === cancelExitCode && output === '') return { kind: 'cancelled' };
  if (code !== 0) throw unavailable();
  // Remove just the command's line terminator. Spaces and newlines can belong to a Unix folder name.
  const directory = output.endsWith('\n') ? output.slice(0, -1) : output;
  if (platform === 'darwin' && directory === 'cancelled') return { kind: 'cancelled' };
  if (path.posix.isAbsolute(directory) && !directory.includes('\0')) {
    // macOS folder aliases include a trailing slash. Match existing project paths, keeping
    // a separator after significant whitespace so workspaceDir.trim() preserves the folder.
    const folder = directory.replace(/\/+$/u, '') || '/';
    return { kind: 'selected', directory: /\s$/u.test(folder) ? folder + '/' : folder };
  }
  throw unavailable();
}

const unavailable = () => new Error('Native folder selection is unavailable');

// A narrow launcher-owned provider, never a shell/command execution endpoint.
export function createNativeDirectoryPicker({
  platform = process.platform, env = process.env, executable = isExecutable,
  spawnProcess = spawn,
} = {}) {
  if (platform === 'win32') return createWin32DirectoryPicker({ spawnProcess });
  const command = unixDirectoryCommand(platform, env, executable);
  if (!command) return;
  const zenity = command && path.posix.basename(command[0]) === 'zenity';
  // GTK startup also exits 1 when the display is gone. Give user dismissal its own status.
  const cancelExitCode = zenity ? 9 : 1;
  const chooserEnv = zenity ? { ...env, ZENITY_CANCEL: '9', ZENITY_ESC: '9', ZENITY_OK: '0', ZENITY_ERROR: '2' } : env;
  let lastZenityDirectory;
  let active;
  let disposed = false;
  return {
    grant: randomUUID(),
    async choose(signal) {
      if (disposed || active || signal.aborted) throw unavailable();
      let invocation = command;
      if (zenity) {
        // Without current_folder the GNOME portal restores its own possibly deleted last folder.
        const folder = await zenityStartingFolder(lastZenityDirectory, env.HOME ?? homedir());
        invocation = [command[0], [...command[1], '--filename=' + folder]];
      }
      if (disposed || active || signal.aborted) throw unavailable();
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
          child = spawnProcess(...invocation, { env: chooserEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
          active = { abort, closed };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            output += chunk.toString('utf8');
            if (Buffer.byteLength(output) > 32768) abort();
          });
          child.once('error', () => {
            finish(unavailable());
          });
          child.once('close', (code) => {
            active = undefined;
            markClosed();
            if (aborting) { finish(unavailable()); return; }
            try {
              const result = directoryResult(platform, code, output, cancelExitCode);
              if (zenity && result.kind === 'selected') lastZenityDirectory = result.directory;
              finish(null, result);
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
