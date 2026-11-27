import { fork, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

function powershell(script, env = {}) {
  const exe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Preserve quotes and line breaks in the C# here-string through Windows command-line parsing.
  const source = "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" +
    'try {\n' + script + '\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Browser setup exited with code ${result.status}.`);
  return result.stdout.trim();
}

function defaultHttpBrowser() {
  const executable = powershell(String.raw`
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'The runner has no interactive desktop session.' }
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class HttpAssociation {
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    public static extern uint AssocQueryString(uint flags, uint kind, string scheme, string verb, StringBuilder result, ref uint size);
}
'@
$size = [uint32]32768
$result = [Text.StringBuilder]::new([int]$size)
# ASSOCF_IS_PROTOCOL, ASSOCSTR_EXECUTABLE. Query the same shell that will open the launcher's HTTP URL.
$status = [HttpAssociation]::AssocQueryString(0x1000, 2, 'http', 'open', $result, [ref]$size)
if ($status -ne 0) { throw "Could not resolve the Windows HTTP handler (HRESULT $status)." }
$result.ToString()
`);
  const policy = { 'msedge.exe': 'Microsoft\\Edge', 'chrome.exe': 'Google\\Chrome' }[path.basename(executable).toLowerCase()];
  if (!policy || !path.isAbsolute(executable) || !existsSync(executable)) {
    throw new Error(`An installed Edge or Chrome HTTP handler is required. Windows reported ${path.basename(executable)}.`);
  }
  return { executable, policy, versionUrl: policy === 'Microsoft\\Edge' ? 'edge://version/' : 'chrome://version/' };
}

// Shell activation can pass through a broker outside the launcher's process tree.
// Point the runner user's existing browser handler at the test profile across both processes.
function redirectRunnerBrowser(policy, profile) {
  const env = { WEBUI_GATE_POLICY: policy, WEBUI_GATE_PROFILE: profile };
  const keys = String.raw`
$relative = 'Software\Policies\' + $env:WEBUI_GATE_POLICY
$userKey = 'HKCU:\' + $relative
$vendorKey = Split-Path -Parent $userKey
`;
  const created = JSON.parse(powershell(keys + String.raw`
foreach ($key in @($userKey, ('HKLM:\' + $relative))) {
    if ((Test-Path -LiteralPath $key) -and ((Get-Item -LiteralPath $key).GetValueNames() -contains 'UserDataDir')) {
        throw 'An existing browser UserDataDir policy prevents using an isolated test profile.'
    }
}
ConvertTo-Json -Compress -InputObject @( @($userKey, $vendorKey) | Where-Object { -not (Test-Path -LiteralPath $_) } )
`, env));
  const restore = () => powershell(keys + String.raw`
if ((Test-Path -LiteralPath $userKey) -and ((Get-Item -LiteralPath $userKey).GetValueNames() -contains 'UserDataDir')) {
    if ((Get-ItemPropertyValue -LiteralPath $userKey -Name UserDataDir) -cne $env:WEBUI_GATE_PROFILE) {
        throw 'The browser profile policy changed during verification. Its new value has been preserved.'
    }
    Remove-ItemProperty -LiteralPath $userKey -Name UserDataDir
}
foreach ($path in (ConvertFrom-Json $env:WEBUI_GATE_CREATED_KEYS)) {
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($item -and $item.ValueCount -eq 0 -and $item.SubKeyCount -eq 0) { Remove-Item -LiteralPath $path }
}
`, { ...env, WEBUI_GATE_CREATED_KEYS: JSON.stringify(created) });
  try {
    powershell(keys + String.raw`
if (-not (Test-Path -LiteralPath $userKey)) { New-Item -Path $userKey -Force | Out-Null }
New-ItemProperty -LiteralPath $userKey -Name UserDataDir -PropertyType String -Value $env:WEBUI_GATE_PROFILE | Out-Null
if ((Get-ItemPropertyValue -LiteralPath $userKey -Name UserDataDir) -cne $env:WEBUI_GATE_PROFILE) { throw 'Browser profile policy was not installed.' }
`, env);
    return restore;
  } catch (error) {
    try { restore(); }
    catch (cleanupError) { console.warn('Browser policy cleanup also failed:', cleanupError.message); }
    throw error;
  }
}

function launcherEnvironment(installed, work, port, miniappPort) {
  const modules = path.resolve(installed, '..', '..');
  const shimDirectory = [path.join(modules, '.bin'), path.dirname(modules)]
    .find((dir) => existsSync(path.join(dir, 'mcode-webui.cmd')));
  if (!shimDirectory) throw new Error('npm did not install a Windows mcode-webui command shim.');
  const env = {
    ...process.env, MINIMAX_DATA_DIR: path.join(work, 'native-data'), WEBUI_HOST: '127.0.0.1',
    WEBUI_SERVER_PORT: String(port), WEBUI_MINIAPP_PORT: String(miniappPort), WEBUI_OPEN_BROWSER: '',
  };
  delete env.WEBUI_DESKTOP_HOST;
  delete env.WEBUI_LAUNCH_URL_FILE;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = shimDirectory + path.delimiter + (env[pathKey] ?? '');
  return env;
}

function startInstalledCommand(installed, work, port, miniappPort) {
  // Windows keeps the driver's loaded native DLL mapped until this verifier exits.
  // Use the checkout's test driver so the temporary npm installation can be removed.
  const { spawn } = createRequire(new URL('../../packages/webui/package.json', import.meta.url))('node-pty');
  const env = launcherEnvironment(installed, work, port, miniappPort);
  const term = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'mcode-webui.cmd'], {
    cwd: work, env, cols: 120, rows: 30,
  });
  // The terminal can include a credential. Drain it without logging or extracting a launch URL.
  term.onData(() => {});
  let exit;
  const exited = new Promise((resolve) => term.onExit((result) => { exit = result; resolve(); }));
  return {
    pid: term.pid,
    exited,
    async close() {
      if (exit) return;
      term.write('\x03');
      await Promise.race([exited, delay(2000, undefined, { ref: false })]);
      if (!exit) {
        // node-pty's kill() tries to attach to a console which Ctrl+C may already
        // have closed. Stop any remaining processes in this launcher's tree.
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/T', '/F', '/PID', String(term.pid), '/FI', 'IMAGENAME eq cmd.exe'], {
            stdio: 'ignore', windowsHide: true, timeout: 5000,
          });
        await Promise.race([exited, delay(5000, undefined, { ref: false })]);
        if (!exit) {
          // The PTY's output pipe can outlive cmd.exe. Check the OS process as well.
          try { process.kill(term.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
          throw result.error ?? new Error(`Could not stop the test launcher (taskkill exit ${result.status}).`);
        }
      }
    },
  };
}

// node-pty 1.1 leaves a named-pipe Worker listening after the console exits.
// The owner acknowledges the launcher exit over IPC; the parent then ends the owner.
if (process.send && process.argv[1] === import.meta.filename && process.argv[2] === '--terminal-driver') {
  const send = (value) => new Promise((resolve, reject) => process.send(value, (error) => error ? reject(error) : resolve()));
  const disconnected = new Promise((resolve) => process.once('disconnect', resolve));
  try {
    const shutdown = Promise.withResolvers();
    process.on('message', (message) => { if (message === 'shutdown') shutdown.resolve(true); });
    disconnected.then(() => shutdown.resolve(true));
    const term = startInstalledCommand(...process.argv.slice(3));
    try {
      await send(term.pid);
      if (!await Promise.race([shutdown.promise, term.exited.then(() => false)])) {
        throw new Error('The installed mcode-webui command exited before teardown.');
      }
    } finally {
      if (process.connected) process.send('closing-launcher', () => {});
      await term.close();
    }
    if (process.connected) await send('launcher-closed');
  } catch (error) {
    if (process.connected) await send({ failure: error.message });
  }
  // If the parent disappears before reaping us, release the stranded Worker.
  await disconnected;
  process.kill(process.pid, 'SIGKILL');
}

function startTerminalDriver(installed, work, port, miniappPort) {
  const driver = fork(import.meta.filename, ['--terminal-driver', installed, work, String(port), String(miniappPort)], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
  });
  const ready = Promise.withResolvers();
  const closedLauncher = Promise.withResolvers();
  const exited = Promise.withResolvers();
  let stopped = false;
  let failure;
  function fail(error) {
    failure ??= error;
    ready.resolve();
    closedLauncher.resolve(false);
  }
  driver.on('message', (message) => {
    if (Number.isSafeInteger(message)) ready.resolve(message);
    else if (message === 'closing-launcher') console.log('The terminal driver is closing its launcher.');
    else if (message === 'launcher-closed') closedLauncher.resolve(true);
    else if (typeof message?.failure === 'string') fail(new Error(message.failure));
  });
  driver.on('error', fail);
  // A ConPTY descendant can inherit a pipe. 'exit' confirms the process's OS
  // handle has signalled; 'close' also waits for all the inherited stdio pipes.
  driver.once('exit', (code, signal) => {
    stopped = true;
    if (!driver.killed) fail(new Error(`The Windows terminal driver exited with ${signal ?? code} before teardown completed.`));
    ready.resolve();
    closedLauncher.resolve(false);
    exited.resolve();
  });
  return {
    async launcherPid() {
      const pid = await Promise.race([ready.promise, delay(20_000, undefined, { ref: false })]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw failure ?? new Error('The Windows terminal driver did not report a launcher PID.');
      return pid;
    },
    assertRunning() {
      if (failure || stopped) throw failure ?? new Error('The Windows terminal driver closed before opening its browser tab.');
    },
    async close() {
      if (!driver.pid) throw failure ?? new Error('The Windows terminal driver did not start.');
      console.log('Requesting shutdown of the installed Windows launcher.');
      if (driver.connected) driver.send('shutdown', (error) => { if (error) fail(error); });
      const confirmed = await Promise.race([closedLauncher.promise, delay(20_000, false, { ref: false })]);
      if (confirmed) console.log('The terminal driver confirmed that the launcher exited.');
      if (!confirmed && !stopped) {
        // On missing acknowledgement the launcher may still be in this tree.
        spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(driver.pid)], {
          stdio: 'ignore', windowsHide: true, timeout: 5000,
        });
      }
      if (!stopped) driver.kill('SIGKILL');
      if (driver.connected) driver.disconnect();
      await Promise.race([exited.promise, delay(5000, undefined, { ref: false })]);
      if (!stopped) throw new Error('Could not confirm the Windows terminal driver exited.');
      if (failure) throw failure;
      if (!confirmed) throw new Error('The terminal driver did not confirm that the launcher exited.');
      console.log('Confirmed the terminal driver process exited.');
    },
  };
}

// A desktop host starts the installed command without a console and consumes its private file.
// A person starting the same command in the background manually opens the address it prints.
function startBackgroundCommand(installed, work, port, miniappPort, entry) {
  const env = launcherEnvironment(installed, work, port, miniappPort);
  env.MINIMAX_DATA_DIR = mkdtempSync(path.join(work, 'background-data-'));
  const handoffFile = path.join(env.MINIMAX_DATA_DIR, 'launch-url');
  if (entry === 'desktop-handoff') {
    env.WEBUI_DESKTOP_HOST = '1';
    env.WEBUI_LAUNCH_URL_FILE = handoffFile;
    env.WEBUI_OPEN_BROWSER = '0';
  }
  const child = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'mcode-webui.cmd'], {
    cwd: work, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  const printed = Promise.withResolvers();
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.once('error', () => printed.resolve(undefined));
  child.once('exit', () => printed.resolve(undefined));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const match = /^\[mcode-webui\] WebUI running at (\S+)$/u.exec(line);
    if (match) printed.resolve(match[1]);
  });
  return {
    pid: child.pid,
    async pageUrl() {
      const address = await Promise.race([printed.promise, delay(60_000, undefined, { ref: false })]);
      if (!address || !URL.canParse(address)) throw new Error('The background launcher did not print a valid access URL.');
      const url = new URL(address);
      if (url.origin !== `http://127.0.0.1:${port}` || url.hash) throw new Error('Unexpected origin or private fragment in the printed access URL.');
      if (entry === 'manual') return address;
      const handoff = await readFile(handoffFile, 'utf8');
      if (!URL.canParse(handoff)) throw new Error('The desktop host handoff did not contain a valid URL.');
      const privateUrl = new URL(handoff);
      if (privateUrl.origin !== url.origin) throw new Error('The desktop host handoff does not identify its installed launcher.');
      return handoff;
    },
    async close() {
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          // The npm shim owns the Node launcher and any modal worker beneath it.
          spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore', windowsHide: true, timeout: 5000,
          });
        }
        const closed = await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })]);
        if (!closed) throw new Error('The background launcher process tree did not close.');
      } finally {
        lines.close();
        await rm(handoffFile, { force: true });
      }
    },
  };
}

async function readBrowserPid(context) {
  const session = await context.browser().newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const browsers = processInfo.filter(({ type }) => type === 'browser');
    if (browsers.length !== 1 || !Number.isSafeInteger(browsers[0].id) || browsers[0].id <= 0) {
      throw new Error('The isolated browser did not report one browser process PID.');
    }
    return browsers[0].id;
  } finally {
    await session.detach();
  }
}

export async function launchNativeProjectBrowser({ installed, work, port, miniappPort, entry = 'terminal' }) {
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  if (process.platform !== 'win32' || (!hosted && process.env.WEBUI_TEST_DISPOSABLE_DESKTOP !== '1')) {
    throw new Error('Run the Windows project-selection gate on a hosted Windows runner or set WEBUI_TEST_DISPOSABLE_DESKTOP=1 in a disposable Windows desktop account.');
  }
  if (!['terminal', 'desktop-handoff', 'manual'].includes(entry)) throw new Error('Unknown Windows project-selection entry.');
  const { chromium } = await import('@playwright/test');
  const { executable, policy, versionUrl } = defaultHttpBrowser();
  const profile = mkdtempSync(path.join(work, 'native-browser-'));
  const restore = redirectRunnerBrowser(policy, profile);
  let context;
  let launcher;
  async function close() {
    try {
      await launcher?.close();
    } finally {
      try { await context?.close(); }
      finally { restore(); }
    }
  }
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: executable, headless: false, timeout: 40_000 });
    const version = await context.newPage();
    await version.goto(versionUrl);
    const actualProfile = await version.locator('#profile_path').innerText({ timeout: 10_000 });
    if (path.relative(profile, path.dirname(actualProfile)) !== '') throw new Error('The browser did not open in the test profile.');
    await version.close();
    const browserPid = await readBrowserPid(context);
    console.log(`Verified the isolated profile of the default HTTP browser (${path.basename(executable)}).`);
    if (entry !== 'terminal') {
      launcher = startBackgroundCommand(installed, work, port, miniappPort, entry);
      const address = await launcher.pageUrl();
      const page = await context.newPage();
      // A Playwright navigation error can contain the credential and handoff fragment.
      try { await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
      catch { throw new Error(`Could not open the ${entry} page supplied by the background launcher.`); }
      await page.bringToFront();
      console.log(`Opened the installed background launcher through the ${entry} entry in a fresh browser profile.`);
      return { page, launcherPid: launcher.pid, browserPid, close };
    }
    launcher = startTerminalDriver(installed, work, port, miniappPort);
    const launcherPid = await launcher.launcherPid();
    console.log('Started the installed mcode-webui command in a Windows terminal.');
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    do {
      launcher.assertRunning();
      const page = context.pages().find((tab) => tab.url().startsWith(origin + '/'));
      if (page) {
        console.log('Observed the WebUI tab automatically opened by the launcher.');
        return { page, launcherPid, browserPid, close };
      }
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error('The installed mcode-webui command did not open a tab in the isolated default browser.');
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { console.warn('Launcher cleanup also failed:', cleanupError.message); }
    throw error;
  }
}
