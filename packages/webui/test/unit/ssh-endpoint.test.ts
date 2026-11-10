/**
 * The endpoint a saved host is reached with.
 *
 * Three claims, and they are the ones the SSH settings page stands or falls by:
 *
 *   * **A host picked from `~/.ssh/config` is stored as its alias alone.** OpenSSH resolves the
 *     host, the user, the port and the key when it is asked for that alias. A stored
 *     copy of what `ssh -G` reported would pin the host to the config as it reads today.
 *   * **A key path may be written the way OpenSSH writes it.** `ssh -G` reports
 *     `~/.ssh/id_ed25519` and the form offers it as an example, so the runtime has to accept it
 *     and store the expanded path.
 *   * **The values the person overrode reach OpenSSH as its own options.** The user an `ssh_config`
 *     host overrides travels as `-l`, the key as `-i`, and neither is dropped on the way.
 *
 * The transport is scripted, so nothing here opens a connection.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSshArgs, SSH_PROBE_MARKER } from "../../src/runtime/ssh/command.js";
import type { SshDiscoveryDependencies } from "../../src/runtime/ssh/host-discovery.js";
import { createSshRuntime } from "../../src/runtime/ssh/index.js";
import type { SshTransport } from "../../src/runtime/ssh/transport.js";
import { normalizeSshIdentityFile } from "../../src/runtime/ssh/validators.js";

const HOME = process.platform === "win32" ? "C:\\Users\\tester" : "/home/tester";
const directories: string[] = [];

function temporaryDataDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "webui-ssh-endpoint-"));
  directories.push(directory);
  return directory;
}

/** A transport that answers the probe and remembers what it was asked to run. */
function scriptedTransport(): { readonly transport: SshTransport; readonly runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    transport: {
      run: async (args: readonly string[]) => {
        runs.push([...args]);
        return {
          stdout: `${SSH_PROBE_MARKER}\nhostname=example\nremote_user=root\n`,
          stderr: "",
          code: 0,
          timedOut: false,
        };
      },
      spawnTerminal: () => {
        throw new Error("no terminal in this test");
      },
    },
  };
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A config file that declares one host, read without touching the machine's own.
 *
 * The runtime asks the discovery whether the config still declares an alias before it
 * saves a host that is reached by that alias alone. Without an injected discovery the
 * runtime reads the machine's real `~/.ssh/config`, so this file's claim — that a host
 * named in the config file keeps its alias — would hold only on a machine that happens
 * to declare this alias. The dependency is what makes the claim true everywhere.
 */
function syntheticDiscovery(alias: string): SshDiscoveryDependencies {
  return {
    readTextFile: async () => `Host ${alias}\n  HostName example.com\n  User builder\n`,
    listFiles: async () => [],
    runCommand: async () => ({ stdout: "", stderr: "" }),
    homeDirectory: () => HOME,
  };
}

describe("a key path", () => {
  it("expands the tilde the way OpenSSH writes it", () => {
    expect(normalizeSshIdentityFile("~/.ssh/id_ed25519", HOME)).toBe(path.join(HOME, ".ssh", "id_ed25519"));
    expect(normalizeSshIdentityFile("~", HOME)).toBe(HOME);
  });

  it("keeps a path that is already absolute", () => {
    expect(normalizeSshIdentityFile("/etc/keys/id", HOME)).toBe("/etc/keys/id");
  });

  it("refuses a path that is neither absolute nor a tilde", () => {
    expect(normalizeSshIdentityFile("keys/id", HOME)).toBeUndefined();
    expect(normalizeSshIdentityFile("", HOME)).toBeUndefined();
  });
});

describe("the argument vector", () => {
  it("asks OpenSSH for the alias alone when nothing is overridden", () => {
    const args = buildSshArgs({ kind: "ssh_config", alias: "textvision.top" });
    expect(args.at(-1)).toBe("textvision.top");
    expect(args).not.toContain("-i");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-l");
  });

  it("passes an overridden user as OpenSSH's own option", () => {
    const args = buildSshArgs({ kind: "ssh_config", alias: "textvision.top", username: "root" });
    expect(args).toContain("-l");
    expect(args[args.indexOf("-l") + 1]).toBe("root");
  });

  it("expands a key path written with a tilde", () => {
    const args = buildSshArgs({
      kind: "ssh_config",
      alias: "textvision.top",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(args[args.indexOf("-i") + 1]).toBe(path.join(os.homedir(), ".ssh/id_ed25519"));
  });
});

describe("a saved host", () => {
  it("keeps the alias alone for a host named in the config file", async () => {
    const { transport, runs } = scriptedTransport();
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport,
      homeDirectory: () => HOME,
      discovery: syntheticDiscovery("textvision.top"),
    });

    const saved = await runtime.connections.save({
      alias: "textvision.top",
      endpoint: { kind: "ssh_config", alias: "textvision.top" },
    });

    expect(saved.success).toBe(true);
    expect(saved.connection?.endpoint).toEqual({ kind: "ssh_config", alias: "textvision.top" });
    expect(saved.probe?.status).toBe("connected");
    // The destination is the alias itself, right before the command the probe runs.
    const args = runs.at(-1) ?? [];
    expect(args).toContain("textvision.top");
    expect(args.indexOf("textvision.top")).toBe(args.length - 2);
  });

  it("stores the expanded path for a key written with a tilde", async () => {
    const { transport } = scriptedTransport();
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport,
      homeDirectory: () => HOME,
    });

    const saved = await runtime.connections.save({
      alias: "manual-host",
      endpoint: {
        kind: "manual",
        host: "203.0.113.10",
        port: 54751,
        username: "root",
        identityFile: "~/.ssh/id_ed25519",
      },
    });

    expect(saved.success).toBe(true);
    expect(saved.connection?.endpoint.identityFile).toBe(path.join(HOME, ".ssh", "id_ed25519"));
  });

  it("refuses a key path that is not a path at all", async () => {
    const { transport } = scriptedTransport();
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport,
      homeDirectory: () => HOME,
    });

    const saved = await runtime.connections.save({
      alias: "manual-host",
      endpoint: { kind: "manual", host: "203.0.113.10", identityFile: "keys/id" },
    });

    expect(saved.success).toBe(false);
    expect(saved.error).toBe("invalid_input");
  });
});
