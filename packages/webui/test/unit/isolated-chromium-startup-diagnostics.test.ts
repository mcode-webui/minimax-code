import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WebuiBrowserOperationError } from "../../src/runtime/browser/errors.js";
import {
  WebuiIsolatedChromiumProvider,
  browserDiagnosticsDir,
  resolveChromePath,
  waitForDevToolsEndpoint,
  writeBrowserDiagnostics,
} from "../../src/runtime/browser/isolated-chromium/provider.js";

/**
 * A launch that fails used to be silent.
 *
 * The browser's own error output was dropped, a browser that was killed was
 * not noticed, and a browser that could not be started took the process with
 * it. The facts below are what the browser said about itself: the message a
 * failure carries has to name the browser's own words, and the files it
 * leaves behind have to hold them.
 *
 * The browser here is Node itself: given Chrome's flags it refuses them and
 * says so on its error stream, which is exactly the shape of a browser that
 * dies during startup — and it behaves the same on every platform.
 */
const FAKE_BROWSER = process.execPath;

/** The temporary directories this file made, so that they can be removed. */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.WEBUI_BROWSER_OUTPUT_DIR;
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("isolated Chromium startup diagnostics", () => {
  it("reports a browser that was killed by a signal at once", async () => {
    const startedAt = Date.now();
    const error = await waitForDevToolsEndpoint(
      { exitCode: null, signalCode: "SIGKILL" },
      join(tmpdir(), "webui-never-written-DevToolsActivePort"),
      {
        timeoutMs: 30_000,
        chromePath: "/opt/chrome/chrome",
        stderr: () => "FATAL: the profile is locked by another Chrome",
      },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(WebuiBrowserOperationError);
    expect((error as WebuiBrowserOperationError).code).toBe("browser_provider_failed");
    const message = (error as Error).message;
    expect(message).toContain("SIGKILL");
    expect(message).toContain("exit code none");
    expect(message).toMatch(/after \d+ms/u);
    // The browser's own words are quoted, not a bare timeout.
    expect(message).toContain("FATAL: the profile is locked by another Chrome");
    // The signal is noticed straight away rather than after the whole
    // thirty-second startup budget.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("reports a timeout with the facts of the launch", async () => {
    const error = await waitForDevToolsEndpoint(
      { exitCode: null, signalCode: null },
      join(tmpdir(), "webui-absent-DevToolsActivePort"),
      {
        timeoutMs: 200,
        chromePath: "/opt/chrome/chrome",
        stderr: () => "FATAL: profile lock held",
      },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(WebuiBrowserOperationError);
    expect((error as WebuiBrowserOperationError).code).toBe("browser_operation_timeout");
    const message = (error as Error).message;
    expect(message).toContain("/opt/chrome/chrome");
    expect(message).toContain("DevToolsActivePort file: absent");
    expect(message).toContain("exit code: none");
    expect(message).toContain("signal: none");
    expect(message).toMatch(/after \d+ms/u);
    expect(message).toContain("FATAL: profile lock held");
  });

  it("reads the endpoint the browser published", async () => {
    const directory = await temporaryDirectory("webui-chrome-endpoint-");
    const activePortPath = join(directory, "DevToolsActivePort");
    await writeFile(activePortPath, "43123\n/devtools/browser/8f1c-42\n");
    const seen: string[] = [];

    const endpoint = await waitForDevToolsEndpoint(
      { exitCode: null, signalCode: null },
      activePortPath,
      {
        chromePath: "/opt/chrome/chrome",
        onEndpoint: (value: string) => seen.push(value),
      },
    );

    expect(endpoint).toBe("ws://127.0.0.1:43123/devtools/browser/8f1c-42");
    expect(seen).toEqual(["ws://127.0.0.1:43123/devtools/browser/8f1c-42"]);
  });

  it("reports a browser that could not be started", async () => {
    const error = await waitForDevToolsEndpoint(
      { exitCode: null, signalCode: null },
      join(tmpdir(), "webui-never-written-DevToolsActivePort"),
      {
        timeoutMs: 30_000,
        chromePath: "/opt/chrome/chrome",
        spawnError: () => new Error("spawn /opt/chrome/chrome ENOENT"),
      },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(WebuiBrowserOperationError);
    expect((error as WebuiBrowserOperationError).code).toBe("browser_provider_failed");
    expect((error as Error).message).toContain("spawn /opt/chrome/chrome ENOENT");
  });

  it("keeps the quoted browser output short", async () => {
    const error = await waitForDevToolsEndpoint(
      { exitCode: 7, signalCode: null },
      join(tmpdir(), "webui-never-written-DevToolsActivePort"),
      { chromePath: "/opt/chrome/chrome", stderr: () => "x".repeat(5_000) },
    ).catch((failure: unknown) => failure);

    const message = (error as Error).message;
    expect(message.length).toBeLessThan(800);
    expect(message).toContain("...");
  });

  it("skips a candidate that cannot be executed", async () => {
    const directory = await temporaryDirectory("webui-chrome-candidates-");
    const notExecutable = join(directory, "chrome-without-the-executable-bit");
    const executable = join(directory, "chrome");
    await writeFile(notExecutable, "#!/bin/sh\nexit 0\n");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await chmod(notExecutable, 0o644);

    if (process.platform === "win32") {
      // Windows has no executable bit, so `X_OK` behaves as `F_OK` there and
      // the first candidate that exists is the one that is used.
      expect(await resolveChromePath(undefined, [notExecutable, executable])).toBe(notExecutable);
      return;
    }

    expect(await resolveChromePath(undefined, [notExecutable, executable])).toBe(executable);
    await expect(resolveChromePath(undefined, [notExecutable])).rejects.toMatchObject({
      code: "browser_provider_unavailable",
    });
  });

  it("quotes the browser's own output when the browser dies during startup", async () => {
    const dataDir = await temporaryDirectory("webui-chrome-launch-");
    const outputDir = join(dataDir, "results");
    process.env.WEBUI_BROWSER_OUTPUT_DIR = outputDir;

    const startedAt = Date.now();
    const error = await WebuiIsolatedChromiumProvider.launch({
      dataDir,
      chromePath: FAKE_BROWSER,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(WebuiBrowserOperationError);
    expect((error as WebuiBrowserOperationError).code).toBe("browser_provider_failed");
    const message = (error as Error).message;
    // The browser's own words, not a bare timeout.
    expect(message).toContain("bad option");
    expect(message).toContain(FAKE_BROWSER);
    expect(message).toMatch(/after \d+ms/u);
    // A browser that dies is noticed at once rather than after the whole
    // thirty-second startup budget.
    expect(Date.now() - startedAt).toBeLessThan(20_000);

    const artifact = JSON.parse(
      await readFile(join(outputDir, "chrome-startup.json"), "utf8"),
    ) as {
      chromePath?: string;
      chromeVersion?: string;
      failure?: { code?: string; message?: string };
      stderrTail?: string;
      marks?: { phase: string }[];
    };
    expect(artifact.chromePath).toBe(FAKE_BROWSER);
    expect(artifact.chromeVersion).toBe(process.version);
    expect(artifact.failure?.code).toBe("browser_provider_failed");
    expect(artifact.failure?.message).toContain("bad option");
    expect(artifact.stderrTail).toContain("bad option");
    const phases = (artifact.marks ?? []).map((mark) => mark.phase);
    expect(phases).toContain("chromePathResolved");
    expect(phases).toContain("spawned");

    const stderrLog = await readFile(join(outputDir, "chrome-stderr.log"), "utf8");
    expect(stderrLog).toContain("bad option");
    const profileLog = await readFile(
      join(dataDir, "browser", "isolated-chromium", "profile", "chrome-stderr.log"),
      "utf8",
    );
    expect(profileLog).toContain("bad option");
  });

  it("turns a browser that cannot be started into a browser error", async () => {
    const dataDir = await temporaryDirectory("webui-chrome-missing-");
    process.env.WEBUI_BROWSER_OUTPUT_DIR = join(dataDir, "results");

    const startedAt = Date.now();
    const error = await WebuiIsolatedChromiumProvider.launch({
      dataDir,
      chromePath: join(dataDir, "no-such-chrome"),
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(WebuiBrowserOperationError);
    expect((error as WebuiBrowserOperationError).code).toBe("browser_provider_failed");
    expect((error as Error).message).toContain("no-such-chrome");
    expect((error as Error).message).toContain("ENOENT");
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });

  it("writes the diagnostics where the run collects them", async () => {
    const directory = await temporaryDirectory("webui-chrome-diagnostics-");
    const userDataDir = join(directory, "profile");
    const outputDir = join(directory, "results");

    expect(browserDiagnosticsDir(userDataDir)).toBe(join(userDataDir, "browser-diagnostics"));
    process.env.WEBUI_BROWSER_OUTPUT_DIR = outputDir;
    expect(browserDiagnosticsDir(userDataDir)).toBe(outputDir);

    await writeBrowserDiagnostics({
      outputDir,
      userDataDir,
      artifact: { kind: "isolated-chromium-startup" },
      stderr: "FATAL: profile lock held",
    });

    expect(
      JSON.parse(await readFile(join(outputDir, "chrome-startup.json"), "utf8")),
    ).toEqual({ kind: "isolated-chromium-startup" });
    expect(await readFile(join(outputDir, "chrome-stderr.log"), "utf8")).toBe(
      "FATAL: profile lock held",
    );
    expect(await readFile(join(userDataDir, "chrome-stderr.log"), "utf8")).toBe(
      "FATAL: profile lock held",
    );
  });
});
