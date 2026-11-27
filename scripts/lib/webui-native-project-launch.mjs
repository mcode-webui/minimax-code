import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

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

function startInstalledCommand(installed, work, port, miniappPort) {
  const modules = path.resolve(installed, '..', '..');
  const shimDirectory = [path.join(modules, '.bin'), path.dirname(modules)]
    .find((dir) => existsSync(path.join(dir, 'mcode-webui.cmd')));
  if (!shimDirectory) throw new Error('npm did not install a Windows mcode-webui command shim.');
  // Windows keeps the driver's loaded native DLL mapped until this verifier exits.
  // Use the checkout's test driver so the temporary npm installation can be removed.
  const { spawn } = createRequire(new URL('../../packages/webui/package.json', import.meta.url))('node-pty');
  const env = {
    ...process.env, MINIMAX_DATA_DIR: path.join(work, 'native-data'), WEBUI_HOST: '127.0.0.1',
    WEBUI_SERVER_PORT: String(port), WEBUI_MINIAPP_PORT: String(miniappPort), WEBUI_OPEN_BROWSER: '',
  };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = shimDirectory + path.delimiter + (env[pathKey] ?? '');
  const term = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'mcode-webui.cmd'], {
    cwd: work, env, cols: 120, rows: 30,
  });
  // The terminal can include a credential. Drain it without logging or extracting a launch URL.
  term.onData(() => {});
  let exit;
  const exited = new Promise((resolve) => term.onExit((result) => { exit = result; resolve(); }));
  return {
    pid: term.pid,
    assertRunning() { if (exit) throw new Error(`mcode-webui exited with code ${exit.exitCode} before opening its browser tab.`); },
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
        if (!exit) throw result.error ?? new Error(`Could not stop the test launcher (taskkill exit ${result.status}).`);
      }
    },
  };
}

export async function launchNativeProjectBrowser({ installed, work, port, miniappPort }) {
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  if (process.platform !== 'win32' || (!hosted && process.env.WEBUI_TEST_DISPOSABLE_DESKTOP !== '1')) {
    throw new Error('Run the Windows project-selection gate on a hosted Windows runner or set WEBUI_TEST_DISPOSABLE_DESKTOP=1 in a disposable Windows desktop account.');
  }
  const { executable, policy, versionUrl } = defaultHttpBrowser();
  const profile = mkdtempSync(path.join(work, 'native-browser-'));
  const restore = redirectRunnerBrowser(policy, profile);
  let context;
  let terminal;
  async function close() {
    try {
      await terminal?.close();
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
    console.log(`Verified the isolated profile of the default HTTP browser (${path.basename(executable)}).`);
    terminal = startInstalledCommand(installed, work, port, miniappPort);
    console.log('Started the installed mcode-webui command in a Windows terminal.');
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    do {
      terminal.assertRunning();
      const page = context.pages().find((tab) => tab.url().startsWith(origin + '/'));
      if (page) {
        console.log('Observed the WebUI tab automatically opened by the launcher.');
        return { page, launcherPid: terminal.pid, close };
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
