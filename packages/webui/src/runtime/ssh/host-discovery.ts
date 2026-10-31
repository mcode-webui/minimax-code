// The hosts in `~/.ssh/config`.
//
// The file is parsed here, not by OpenSSH: the person needs to see the aliases their config
// declares, with the host, user, port and key each alias resolves to. OpenSSH's own `-G` answers
// the resolution, so the values are the ones the connection will really use.
//
// The three outcomes stay apart, because "no config file" and "a config file with no hosts" are
// different answers:
//
//   * no `~/.ssh/config` at all → `{ configFound: false, hosts: [] }`
//   * a config file with no `Host` entry → `{ configFound: true, hosts: [] }`
//   * a config file that exists but cannot be read → `{ configFound: false, hosts: [], error:
//     "config_unreadable" }`
//
// Every dependency is injectable, so the parser is testable against a synthetic config file
// without touching the machine's own `~/.ssh`.
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSafeSshAlias, isSafeSshHostname, isSafeSshPort, isSafeSshUser } from "./validators.js";
import type { SshDiscoveredHostRecord, SshDiscoveryRecord } from "./types.js";

export interface SshDiscoveryDependencies {
  readonly readTextFile: (filePath: string) => Promise<string>;
  /** The files a directory holds, used to expand an `Include` pattern. */
  readonly listFiles: (directory: string) => Promise<readonly string[]>;
  /** Run one command and capture its output. */
  readonly runCommand: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly homeDirectory: () => string;
}

export const DEFAULT_SSH_DISCOVERY_DEPENDENCIES: SshDiscoveryDependencies = {
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  listFiles: async (directory) => {
    try {
      return await readdir(directory);
    } catch {
      return [];
    }
  },
  runCommand: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawnCommand(command, args);
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", () => resolve({ stdout, stderr }));
    }),
  homeDirectory: () => os.homedir(),
};

function spawnCommand(command: string, args: readonly string[]): ReturnType<typeof spawn> {
  return spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/**
 * The aliases a config file declares.
 *
 * A `Host` line may name several aliases, and a pattern (`*`, `?`, `!`) is not an alias — it
 * matches others. Only the concrete names are collected, in the order the file declares them.
 */
export function parseSshConfigAliases(source: string): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = stripSshConfigComment(rawLine).trim();
    if (!line) continue;
    const directive = /^(\S+)\s+(.+)$/u.exec(line);
    if (!directive) continue;
    const key = directive[1]?.toLowerCase();
    if (key !== "host") continue;
    for (const value of splitSshConfigWords(directive[2] ?? "")) {
      if (!isConcreteAlias(value) || seen.has(value)) continue;
      seen.add(value);
      aliases.push(value);
    }
  }
  return aliases;
}

/** One alias, as OpenSSH resolved it (`ssh -G`). */
export function parseResolvedSshHost(
  alias: string,
  output: string,
): SshDiscoveredHostRecord {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(.+)$/u.exec(line.trim());
    if (match && !values.has((match[1] ?? "").toLowerCase())) {
      values.set((match[1] ?? "").toLowerCase(), (match[2] ?? "").trim());
    }
  }
  const hostname = values.get("hostname");
  const user = values.get("user");
  const portText = values.get("port");
  const port = portText ? Number.parseInt(portText, 10) : Number.NaN;
  const identityFile = values.get("identityfile");
  return {
    alias,
    ...(hostname && isSafeSshHostname(hostname) ? { hostname } : {}),
    ...(user && isSafeSshUser(user) ? { user } : {}),
    ...(Number.isInteger(port) && isSafeSshPort(port) ? { port } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

/** Read `~/.ssh/config` and resolve every alias it declares. */
export async function discoverSshHosts(
  dependencies: SshDiscoveryDependencies = DEFAULT_SSH_DISCOVERY_DEPENDENCIES,
): Promise<SshDiscoveryRecord> {
  const sshDirectory = path.join(dependencies.homeDirectory(), ".ssh");
  const configPath = path.join(sshDirectory, "config");
  const aliases: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();

  let configFound = true;
  try {
    await collectAliases(configPath, sshDirectory, dependencies, aliases, seen, visited);
  } catch (error) {
    if (isFileNotFound(error)) {
      configFound = false;
    } else {
      return { configFound: false, hosts: [], error: "config_unreadable" };
    }
  }

  const hosts = await Promise.all(
    aliases.map(async (alias) => {
      try {
        const resolved = await dependencies.runCommand("ssh", [
          "-G",
          "-o",
          "BatchMode=yes",
          alias,
        ]);
        return parseResolvedSshHost(alias, resolved.stdout);
      } catch {
        // The alias stays visible even when OpenSSH is unavailable or one stanza cannot be
        // resolved. The probe is what reports the reason.
        return { alias };
      }
    }),
  );

  return { configFound, hosts };
}

/** Collect the aliases of one config file, following the `Include` directives it carries. */
async function collectAliases(
  configPath: string,
  sshDirectory: string,
  dependencies: SshDiscoveryDependencies,
  aliases: string[],
  seen: Set<string>,
  visited: Set<string>,
): Promise<void> {
  const normalizedPath = path.resolve(configPath);
  if (visited.has(normalizedPath)) return;
  visited.add(normalizedPath);
  const source = await dependencies.readTextFile(normalizedPath);
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = stripSshConfigComment(rawLine).trim();
    if (!line) continue;
    const directive = /^(\S+)\s+(.+)$/u.exec(line);
    if (!directive) continue;
    const key = directive[1]?.toLowerCase();
    const values = splitSshConfigWords(directive[2] ?? "");
    if (key === "host") {
      for (const value of values) {
        if (!isConcreteAlias(value) || seen.has(value)) continue;
        seen.add(value);
        aliases.push(value);
      }
      continue;
    }
    if (key !== "include") continue;
    for (const value of values) {
      const pattern = resolveIncludePattern(value, sshDirectory, dependencies.homeDirectory());
      const includedFiles = await expandIncludePattern(pattern, dependencies);
      for (const includedFile of includedFiles) {
        try {
          await collectAliases(
            includedFile,
            sshDirectory,
            dependencies,
            aliases,
            seen,
            visited,
          );
        } catch (error) {
          if (!isFileNotFound(error)) throw error;
        }
      }
    }
  }
}

/** A pattern is not an alias: it matches other entries. */
function isConcreteAlias(value: string): boolean {
  const containsPattern = ["*", "?", "[", "]"].some((token) => value.includes(token));
  return !value.startsWith("!") && !containsPattern && isSafeSshAlias(value);
}

/** OpenSSH resolves a relative `Include` against `~/.ssh`. */
function resolveIncludePattern(value: string, sshDirectory: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return path.isAbsolute(value) ? value : path.join(sshDirectory, value);
}

/**
 * The files an `Include` pattern names.
 *
 * The pattern language OpenSSH accepts is small — `*` and `?` inside a path segment — so it is
 * matched here rather than through a glob dependency this package does not have.
 */
async function expandIncludePattern(
  pattern: string,
  dependencies: SshDiscoveryDependencies,
): Promise<readonly string[]> {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return [];
  let current = [path.isAbsolute(pattern) ? "/" : ""];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const isLast = index === segments.length - 1;
    const next: string[] = [];
    for (const base of current) {
      const directory = base === "" ? "." : base;
      let entries: readonly string[];
      try {
        entries = await dependencies.listFiles(directory);
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!matchesSegment(segment, entry)) continue;
        next.push(base === "" || base === "/" ? `${base}${entry}` : `${base}/${entry}`);
      }
    }
    if (isLast) {
      return next.filter((candidate) => candidate !== "" && candidate !== "/");
    }
    current = next;
  }
  return [];
}

/** Match one path segment against a pattern with `*` and `?`. */
function matchesSegment(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("")
    .map((character) => {
      if (character === "*") return "[^/]*";
      if (character === "?") return "[^/]";
      return character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

/** Remove a trailing comment, honouring quotes so a `#` inside a value survives. */
export function stripSshConfigComment(line: string): string {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

/** Split a directive's value into words, honouring quotes and backslash escapes. */
export function splitSshConfigWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
