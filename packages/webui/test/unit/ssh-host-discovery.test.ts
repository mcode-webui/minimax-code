/**
 * The SSH host discovery: the parser and the three empty states.
 *
 * The fixture is a synthetic `~/.ssh/config` in a temporary directory — the machine's own config
 * is never read. The parser's claims are asserted directly (a pattern is not an alias, a comment
 * is not a value, a quoted value is one word) and the discovery's claims are asserted through the
 * injected dependencies (no config file, a config file with no hosts, a config file that cannot be
 * read are three different answers).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverSshHosts,
  parseResolvedSshHost,
  parseSshConfigAliases,
  splitSshConfigWords,
  stripSshConfigComment,
  type SshDiscoveryDependencies,
} from "../../src/runtime/ssh/host-discovery.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "webui-ssh-discovery-"));
  directories.push(directory);
  return directory;
}

const CONFIG_FIXTURE = `# A synthetic ~/.ssh/config.
Host build
  HostName build.example.com
  User builder
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

# A pattern is not an alias: it matches other entries.
Host *.internal
  ProxyJump jump.example.com

# A negated pattern is not an alias either.
Host !excluded
  User nobody

Host deploy
  HostName deploy.example.com
  User deploy
`;

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("the ~/.ssh/config parser", () => {
  it("collects the concrete aliases and skips the patterns", () => {
    expect(parseSshConfigAliases(CONFIG_FIXTURE)).toEqual(["build", "deploy"]);
  });

  it("keeps the order the file declares them in", () => {
    const aliases = parseSshConfigAliases("Host second\nHost first\n");
    expect(aliases).toEqual(["second", "first"]);
  });

  it("drops a comment without touching a value that carries one", () => {
    expect(stripSshConfigComment("  Host build  # the build machine")).toBe("  Host build  ");
    expect(stripSshConfigComment('Host "a#b"')).toBe('Host "a#b"');
  });

  it("splits a value into words and honours quotes", () => {
    expect(splitSshConfigWords("config.d/* other")).toEqual(["config.d/*", "other"]);
    expect(splitSshConfigWords('"one two" three')).toEqual(["one two", "three"]);
  });

  it("reads the host, the user, the port and the key OpenSSH resolved", () => {
    const resolved = parseResolvedSshHost(
      "build",
      [
        "user builder",
        "hostname build.example.com",
        "port 2222",
        "identityfile /home/tester/.ssh/id_ed25519",
        "identityfile /home/tester/.ssh/id_rsa",
      ].join("\n"),
    );
    expect(resolved).toEqual({
      alias: "build",
      hostname: "build.example.com",
      user: "builder",
      port: 2222,
      identityFile: "/home/tester/.ssh/id_ed25519",
    });
  });
});

describe("the discovery", () => {
  it("reports the hosts of a config file and their resolved endpoints", async () => {
    const home = temporaryDirectory();
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    writeFileSync(path.join(home, ".ssh", "config"), CONFIG_FIXTURE, "utf8");

    const discovery = await discoverSshHosts({
      readTextFile: (filePath) => readFile(filePath, "utf8"),
      listFiles: async () => [],
      runCommand: async (_command, args) => {
        const alias = args[args.length - 1];
        return {
          stdout:
            alias === "build"
              ? "user builder\nhostname build.example.com\nport 2222\nidentityfile /keys/build\n"
              : "user deploy\nhostname deploy.example.com\nport 22\n",
          stderr: "",
        };
      },
      homeDirectory: () => home,
    });

    expect(discovery.configFound).toBe(true);
    expect(discovery.error).toBeUndefined();
    expect(discovery.hosts).toEqual([
      {
        alias: "build",
        hostname: "build.example.com",
        user: "builder",
        port: 2222,
        identityFile: "/keys/build",
      },
      { alias: "deploy", hostname: "deploy.example.com", user: "deploy", port: 22 },
    ]);
  });

  it("tells a missing config file from a config file with no hosts", async () => {
    const home = temporaryDirectory();
    mkdirSync(path.join(home, ".ssh"), { recursive: true });

    const missing = await discoverSshHosts({
      readTextFile: async () => {
        const error = new Error("no such file") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      listFiles: async () => [],
      runCommand: async () => ({ stdout: "", stderr: "" }),
      homeDirectory: () => home,
    });
    expect(missing).toEqual({ configFound: false, hosts: [] });

    writeFileSync(path.join(home, ".ssh", "config"), "# nothing here\n", "utf8");
    const empty = await discoverSshHosts({
      readTextFile: async () => "# nothing here\n",
      listFiles: async () => [],
      runCommand: async () => ({ stdout: "", stderr: "" }),
      homeDirectory: () => home,
    });
    expect(empty).toEqual({ configFound: true, hosts: [] });
  });

  it("reports a config file that cannot be read", async () => {
    const home = temporaryDirectory();
    const discovery = await discoverSshHosts({
      readTextFile: async () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      listFiles: async () => [],
      runCommand: async () => ({ stdout: "", stderr: "" }),
      homeDirectory: () => home,
    });
    expect(discovery).toEqual({ configFound: false, hosts: [], error: "config_unreadable" });
  });

  it("keeps an alias visible when OpenSSH cannot resolve it", async () => {
    const home = temporaryDirectory();
    const dependencies: SshDiscoveryDependencies = {
      readTextFile: async () => "Host build\n",
      listFiles: async () => [],
      runCommand: async () => {
        throw new Error("ssh is not installed");
      },
      homeDirectory: () => home,
    };
    const discovery = await discoverSshHosts(dependencies);
    expect(discovery.hosts).toEqual([{ alias: "build" }]);
  });
});
