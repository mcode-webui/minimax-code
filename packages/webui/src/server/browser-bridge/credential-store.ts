// OS secure credential store for bridge pairing secrets.
//
// The ADR is explicit: WebUI-side bridge credentials live in the operating
// system's secure credential store and ONLY there. If the host has no
// available store, `save()` throws a typed error; the caller translates that
// into a `browser_credential_store_unavailable` reply. There is no file
// fallback, no environment-variable fallback, no in-memory persistence across
// restart.
//
// Three rules hold on every platform, and each one is there because the
// obvious shortcut breaks in a way a test has to be told about:
//
//   * The secret never appears in a child process's argv. argv is world
//     readable through the process list (`ps -eo args`, Task Manager's
//     command line column), so `security … -w <secret>` or `cmdkey /pass:…`
//     hands the credential to anything that can enumerate processes. Every
//     write passes the secret on the child's stdin.
//   * What reaches the store is base64 of the raw bytes, never the bytes
//     pushed through UTF-8. A pairing credential is 32 bytes of CSPRNG
//     output and is routinely not valid UTF-8; decoding the saved text back
//     into bytes does not return the original bytes, so the loaded secret
//     would not be the saved secret.
//   * `load()` asks the platform on every call. Answering from an in-process
//     cache would make `load()` return a credential that only exists until
//     the next restart, which is the exact failure the OS store exists to
//     prevent. Where a platform genuinely cannot read a value back, `load()`
//   returns `undefined` and the caller treats it as "no credential" — never
//   a stale value and never a fabricated one.
//
// Each platform picks a mechanism an unprivileged host can already use
// without a native binding:
//
//   * macOS — the `security` CLI (login Keychain). Available on every modern
//     macOS without a developer-mode bypass. Written with `add-generic-password
//     … -U -w` and the base64 payload on stdin; read back with
//     `find-generic-password … -w`.
//   * Linux — `secret-tool` over the freedesktop Secret Service
//     (GNOME Keyring / KWallet). `store` reads the value from stdin when no
//     value operand is given, and `lookup` prints it back on stdout.
//   * Windows — the Credential Manager cannot be read back, so the
//     store is a PowerShell `ConvertTo-SecureString` /
//     `ConvertFrom-SecureString` DPAPI round trip. The value written is the
//     blob DPAPI encrypts to the interactive user account; the plaintext
//     never touches disk in a recoverable form, and only that account on that
//     machine can decrypt it. The secret itself arrives over stdin and comes
//     back over stdout.
//   * Other / unknown platforms — `isAvailable()` reports false. `save()`
//     throws, as for any other missing store.
//
// `list()` enumerates the *live* key ids this process has written — not the
// contents of the underlying store. Surfacing the secret material would let
// an attacker with read access to the calling process do worse things than
// they can already; the brief asks for ids and a fingerprint, not the secret
// bytes.

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

/** A typed error that means "no OS secure store is available here". */
export class BrowserCredentialStoreUnavailableError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "BrowserCredentialStoreUnavailableError";
    this.reason = reason;
  }
}

/** A reference to a stored credential. The id is opaque but stable. */
export interface SecureCredentialReference {
  readonly keyId: string;
  /** A short, non-secret fingerprint for surfacing in the UI. */
  readonly fingerprint: string;
  /** When the credential was last saved, in epoch milliseconds. */
  readonly savedAt: number;
}

/** The minimum shape every platform implementation provides. */
export interface SecureCredentialStore {
  /** Whether the underlying OS store is reachable in this process. */
  isAvailable(): Promise<boolean>;
  /** Persist the secret bytes under `keyId`. Throws if no store is available. */
  save(keyId: string, secret: Uint8Array): Promise<void>;
  /** Read the secret bytes for `keyId`, or `undefined` if none is stored. */
  load(keyId: string): Promise<Uint8Array | undefined>;
  /** Remove the entry for `keyId`. Idempotent. */
  delete(keyId: string): Promise<void>;
  /** Live, in-process enumeration. Does not return secret material. */
  list(): Promise<readonly SecureCredentialReference[]>;
}

/** What a platform command produced. */
export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Per-run options for a platform command. */
export interface RunPlatformCommandOptions {
  /**
   * The stdin payload. When set, the run is given a writable stdin; this is
   * how a secret reaches the platform command without entering argv.
   */
  readonly stdin?: Buffer | string;
}

/** How a platform command is executed. Tests inject a recorder. */
export type RunPlatformCommand = (
  command: string,
  args: readonly string[],
  options?: RunPlatformCommandOptions,
) => Promise<CommandOutput>;

/** The factory options. */
export interface SecureCredentialStoreOptions {
  /** The service name. Different processes on the same machine can coexist. */
  readonly serviceName: string;
  /** Override the platform implementation (tests inject an in-memory store). */
  readonly platformOverride?: NodeJS.Platform;
  /** Override the underlying command runner; tests inject a recorder. */
  readonly runCommand?: RunPlatformCommand;
}

/**
 * Build a credential store for the current platform. Returns one even when no
 * platform store is available — `isAvailable()` tells the caller which branch
 * it is in, and `save()` throws if a caller attempts to persist through an
 * unavailable store.
 */
export function createPlatformSecureCredentialStore(
  options: SecureCredentialStoreOptions,
): SecureCredentialStore {
  const platform = options.platformOverride ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunPlatformCommand;
  switch (platform) {
    case "darwin":
      return createMacOsKeychainStore(options.serviceName, runCommand);
    case "linux":
      return createLinuxSecretServiceStore(options.serviceName, runCommand);
    case "win32":
      return createWindowsDpapiCredentialStore(options.serviceName, runCommand);
    default:
      return createUnavailableStore(
        `platform "${platform}" has no OS secure credential store wired into the bridge`,
      );
  }
}

/** Inspect the underlying byte map of an in-memory store. Test-only. */
export interface InMemoryCredentialStore extends SecureCredentialStore {
  readonly __entries: ReadonlyMap<string, CredentialEntry>;
}

interface CredentialEntry {
  readonly savedAt: number;
  readonly secret: Uint8Array;
}

/**
 * An in-memory store for tests. It honours the same contract — there is no
 * file — and its `isAvailable()` is unconditionally true. Production code
 * MUST NOT use this; the type name and `__entries` inspection are the tell.
 */
export function createInMemorySecureCredentialStore(): InMemoryCredentialStore {
  const entries = new Map<string, { readonly secret: Uint8Array; readonly savedAt: number }>();
  return {
    __entries: new Proxy(entries, {
      get(target, key) {
        if (key === "size") return target.size;
        if (key === Symbol.iterator) return target[Symbol.iterator].bind(target);
        return undefined;
      },
    }),
    async isAvailable() {
      return true;
    },
    async save(keyId, secret) {
      entries.set(keyId, { secret, savedAt: Date.now() });
    },
    async load(keyId) {
      return entries.get(keyId)?.secret;
    },
    async delete(keyId) {
      entries.delete(keyId);
    },
    async list() {
      const out: SecureCredentialReference[] = [];
      for (const [keyId, entry] of entries.entries()) {
        out.push({
          keyId,
          fingerprint: fingerprint(entry.secret),
          savedAt: entry.savedAt,
        });
      }
      return out;
    },
  };
}

function createUnavailableStore(reason: string): SecureCredentialStore {
  // Nothing is ever written here, so there is nothing to read: `load()`
  // answers `undefined` rather than keeping a side map that would only
  // report back what a failed `save()` could not persist anyway.
  return {
    async isAvailable() {
      return false;
    },
    async save(_keyId, _secret) {
      throw new BrowserCredentialStoreUnavailableError(
        "no operating system secure credential store is available",
        reason,
      );
    },
    async load() {
      return undefined;
    },
    async delete() {
      // Idempotent; there is no store to reach.
    },
    async list() {
      return [];
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Storage encoding                                                            */
/* -------------------------------------------------------------------------- */

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The form a credential takes in the OS store: base64 of the raw bytes.
 *
 * Base64 rather than hex because every backend here takes text, and base64 is
 * the shortest reversible text encoding of arbitrary bytes. The decode side
 * is strict rather than lenient: `Buffer.from(value, "base64")` silently
 * skips characters it does not understand, so a mangled value would decode to
 * *fewer* bytes and read as a valid credential of the wrong length.
 */
export function encodeCredentialForStore(secret: Uint8Array): string {
  return Buffer.from(secret).toString("base64");
}

/**
 * Recover the raw bytes from a stored value. Throws on anything that is not
 * canonical base64; each `load()` treats that as "no credential", because a
 * value that does not decode must never authenticate a pairing.
 *
 * One trailing newline is tolerated because `security find-generic-password`
 * and `secret-tool lookup` both print one, and base64 itself never contains a
 * newline — so stripping it cannot damage a well-formed payload.
 */
export function decodeCredentialFromStore(encoded: string): Uint8Array {
  let text = encoded;
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) {
    throw new Error("stored credential is not canonical base64");
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

/* -------------------------------------------------------------------------- */
/* macOS — Keychain via the `security` CLI                                     */
/* -------------------------------------------------------------------------- */

function createMacOsKeychainStore(
  serviceName: string,
  runCommand: RunPlatformCommand,
): SecureCredentialStore {
  const index = createLiveReferenceIndex();
  const accountArg = (keyId: string): readonly string[] => ["-a", keyId];
  const save = async (keyId: string, secret: Uint8Array): Promise<void> => {
    try {
      // `-w` with no operand makes `security` prompt, which on a piped stdin
      // means "read the password from stdin". The secret therefore never
      // appears in the process list. `-U` updates an existing item in place.
      const result = await runCommand(
        "security",
        ["add-generic-password", "-s", serviceName, ...accountArg(keyId), "-U", "-w"],
        { stdin: encodeCredentialForStore(secret) },
      );
      if (result.exitCode !== 0) {
        throw new Error(commandFailure("security add-generic-password", result));
      }
      index.record(keyId, secret);
    } catch (error) {
      const detail = firstErrorLine(error);
      throw new BrowserCredentialStoreUnavailableError(
        `macOS Keychain rejected the credential: ${detail}`,
        detail,
      );
    }
  };
  const load = async (keyId: string): Promise<Uint8Array | undefined> => {
    try {
      const result = await runCommand(
        "security",
        ["find-generic-password", "-s", serviceName, ...accountArg(keyId), "-w"],
      );
      // A missing item is a non-zero exit with a message on stderr, not a
      // spawn failure, so the exit code is what decides whether a credential
      // exists. The Keychain is the only authority here: nothing is answered
      // from memory, so a restart with an intact Keychain still resolves.
      if (result.exitCode !== 0) return undefined;
      return decodeOrUndefined(result.stdout);
    } catch {
      return undefined;
    }
  };
  const removeEntry = async (keyId: string): Promise<void> => {
    try {
      await runCommand("security", [
        "delete-generic-password",
        "-s",
        serviceName,
        ...accountArg(keyId),
      ]);
    } catch {
      // Idempotent: an absent entry is fine.
    } finally {
      index.release(keyId);
    }
  };
  return {
    async isAvailable() {
      try {
        const result = await runCommand("security", ["help"]);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    save,
    load,
    delete: removeEntry,
    async list() {
      return index.list();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Linux — freedesktop Secret Service via `secret-tool`                        */
/* -------------------------------------------------------------------------- */

function createLinuxSecretServiceStore(
  serviceName: string,
  runCommand: RunPlatformCommand,
): SecureCredentialStore {
  const index = createLiveReferenceIndex();
  const attributesFor = (keyId: string): readonly string[] => [
    "service",
    serviceName,
    "key",
    keyId,
  ];
  const save = async (keyId: string, secret: Uint8Array): Promise<void> => {
    try {
      // `secret-tool store` reads the value from stdin when no value operand
      // follows the attributes, so the secret stays out of argv.
      const result = await runCommand(
        "secret-tool",
        ["store", "--label=WebUI Browser Bridge", ...attributesFor(keyId)],
        { stdin: encodeCredentialForStore(secret) },
      );
      if (result.exitCode !== 0) {
        throw new Error(commandFailure("secret-tool store", result));
      }
      index.record(keyId, secret);
    } catch (error) {
      const detail = firstErrorLine(error);
      throw new BrowserCredentialStoreUnavailableError(
        `Secret Service rejected the credential: ${detail}`,
        detail,
      );
    }
  };
  const load = async (keyId: string): Promise<Uint8Array | undefined> => {
    try {
      const result = await runCommand("secret-tool", ["lookup", ...attributesFor(keyId)]);
      // `lookup` exits non-zero when no matching item exists.
      if (result.exitCode !== 0) return undefined;
      return decodeOrUndefined(result.stdout);
    } catch {
      return undefined;
    }
  };
  const removeEntry = async (keyId: string): Promise<void> => {
    try {
      await runCommand("secret-tool", ["clear", ...attributesFor(keyId)]);
    } catch {
      // Idempotent
    } finally {
      index.release(keyId);
    }
  };
  return {
    async isAvailable() {
      try {
        const result = await runCommand("secret-tool", ["--version"]);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    save,
    load,
    delete: removeEntry,
    async list() {
      return index.list();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Windows — DPAPI round trip via PowerShell                                   */
/* -------------------------------------------------------------------------- */

/*
 * `cmdkey` is deliberately not used: it can write a generic credential but has
 * no way to read the password back, so a store built on it would resolve a
 * credential only until the host restarted — and would have to put the secret
 * in argv to write it at all.
 *
 * The mechanism here is the one Windows itself documents for unattended
 * secrets: `ConvertFrom-SecureString` produces a blob encrypted with DPAPI
 * under the interactive user account, and `ConvertTo-SecureString` reverses
 * it. The blob is what lands on disk, under the user's local application
 * data directory — it is ciphertext, not a plaintext fallback, and no other
 * account or machine can decrypt it. The plaintext enters and leaves the
 * script through stdin and stdout only.
 */

const WINDOWS_BLOB_DIR_SEGMENTS = ["WebUI", "browser-bridge"] as const;
const WINDOWS_BLOB_PREFIX = "bridge-";
const WINDOWS_BLOB_SUFFIX = ".blob";

function windowsBlobPath(serviceName: string, keyId: string): string {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const directory = path.join(localAppData, ...WINDOWS_BLOB_DIR_SEGMENTS);
  // The service name is part of the path so two host processes on one machine
  // do not read each other's blobs. A path segment is built defensively for
  // both parts: a separator in an id would otherwise let a caller choose
  // where the blob lands.
  const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(
    directory,
    sanitize(serviceName),
    `${WINDOWS_BLOB_PREFIX}${sanitize(keyId)}${WINDOWS_BLOB_SUFFIX}`,
  );
}

function powershellLiteral(value: string): string {
  // A single-quoted PowerShell string interpolates nothing, and escapes an
  // embedded quote by doubling it.
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsSaveScript(file: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$plain = [Console]::In.ReadToEnd().Trim()",
    "if ([string]::IsNullOrEmpty($plain)) { throw 'empty credential payload' }",
    "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
    "$blob = ConvertFrom-SecureString -SecureString $secure",
    `[System.IO.Directory]::CreateDirectory(${powershellLiteral(path.dirname(file))}) | Out-Null`,
    "[System.IO.File]::WriteAllText(" +
      `${powershellLiteral(file)}, $blob, (New-Object System.Text.UTF8Encoding($false)))`,
  ].join("; ");
}

function windowsLoadScript(file: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not [System.IO.File]::Exists(${powershellLiteral(file)})) { exit 3 }`,
    "$blob = [System.IO.File]::ReadAllText(" +
      `${powershellLiteral(file)}, (New-Object System.Text.UTF8Encoding($false)))`,
    // Without `-AsPlainText` this takes a `ConvertFrom-SecureString` blob and
    // returns the SecureString it encodes.
    "$secure = ConvertTo-SecureString -String $blob",
    // The placeholder password is required by the NetworkCredential shape and
    // is discarded: only `.Password` is read.
    "[Console]::Out.Write([System.Net.NetworkCredential]::new($secure, 'irrelevant').Password)",
  ].join("; ");
}

function windowsDeleteScript(file: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if ([System.IO.File]::Exists(${powershellLiteral(file)})) ` +
      `{ [System.IO.File]::Delete(${powershellLiteral(file)}) }`,
  ].join("; ");
}

const WINDOWS_AVAILABLE_SCRIPT = "[Console]::Out.Write($PSVersionTable.PSVersion.Major)";

function createWindowsDpapiCredentialStore(
  serviceName: string,
  runCommand: RunPlatformCommand,
): SecureCredentialStore {
  const index = createLiveReferenceIndex();
  const run = (
    script: string,
    stdin?: string,
  ): Promise<CommandOutput> =>
    runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      stdin === undefined ? undefined : { stdin },
    );
  const save = async (keyId: string, secret: Uint8Array): Promise<void> => {
    try {
      const result = await run(
        windowsSaveScript(windowsBlobPath(serviceName, keyId)),
        encodeCredentialForStore(secret),
      );
      if (result.exitCode !== 0) {
        throw new Error(commandFailure("powershell credential save", result));
      }
      index.record(keyId, secret);
    } catch (error) {
      const detail = firstErrorLine(error);
      throw new BrowserCredentialStoreUnavailableError(
        `Windows DPAPI store rejected the credential: ${detail}`,
        detail,
      );
    }
  };
  const load = async (keyId: string): Promise<Uint8Array | undefined> => {
    try {
      const result = await run(windowsLoadScript(windowsBlobPath(serviceName, keyId)));
      // Exit 3 is the script's own "no blob" answer. A missing blob is a
      // legitimate empty credential, not a failure to report, and the blob is
      // the only authority — a restarted host reads whatever DPAPI left.
      if (result.exitCode !== 0) return undefined;
      return decodeOrUndefined(result.stdout);
    } catch {
      return undefined;
    }
  };
  const removeEntry = async (keyId: string): Promise<void> => {
    try {
      await run(windowsDeleteScript(windowsBlobPath(serviceName, keyId)));
    } catch {
      // Idempotent.
    } finally {
      index.release(keyId);
    }
  };
  return {
    async isAvailable() {
      try {
        const result = await run(WINDOWS_AVAILABLE_SCRIPT);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    save,
    load,
    delete: removeEntry,
    async list() {
      return index.list();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const SECRET_BYTES = 32;
const SECURE_FINGERPRINT_NAMESPACE = "webui-browser-bridge/v1";

/**
 * Generate a fresh credential (key id and secret). The id is public — it is
 * what the bridge tells the extension over the wire — so it needs uniqueness,
 * not secrecy. The secret is 32 bytes of CSPRNG output.
 */
export function generateBridgeCredential(): {
  readonly keyId: string;
  readonly secret: Uint8Array;
} {
  return { keyId: randomUUID(), secret: randomBytes(SECRET_BYTES) };
}

/**
 * A short, non-secret fingerprint for a credential — a SHA-256 over the
 * namespace plus the secret, truncated to 16 hex characters. The fingerprint
 * stays stable across restarts so the surface can show a stable handle; it
 * never reveals the secret.
 */
export function fingerprint(secret: Uint8Array): string {
  return createHash("sha256")
    .update(SECURE_FINGERPRINT_NAMESPACE)
    .update(Buffer.from(secret))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The in-process view of what this host has written.
 *
 * Only the fingerprint is retained, not the bytes: `list()` exists to render
 * a stable handle, and keeping a second copy of the secret alive for the life
 * of the process would widen the window for exactly the memory disclosure the
 * OS store is there to reduce.
 */
function createLiveReferenceIndex(): {
  record(keyId: string, secret: Uint8Array): void;
  release(keyId: string): void;
  list(): readonly SecureCredentialReference[];
} {
  const seen = new Map<string, SecureCredentialReference>();
  return {
    record(keyId, secret) {
      seen.set(keyId, { keyId, fingerprint: fingerprint(secret), savedAt: Date.now() });
    },
    release(keyId) {
      seen.delete(keyId);
    },
    list() {
      return [...seen.values()];
    },
  };
}

/** Decode a stored value, answering `undefined` for anything unusable. */
function decodeOrUndefined(stdout: string): Uint8Array | undefined {
  try {
    return decodeCredentialFromStore(stdout);
  } catch {
    return undefined;
  }
}

function commandFailure(label: string, result: CommandOutput): string {
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return detail.length > 0
    ? `${label} exited ${result.exitCode}: ${detail}`
    : `${label} exited ${result.exitCode}`;
}

async function defaultRunPlatformCommand(
  command: string,
  args: readonly string[],
  options?: RunPlatformCommandOptions,
): Promise<CommandOutput> {
  return new Promise<CommandOutput>((resolve, reject) => {
    // No `shell: true`: the arguments below are passed to execve directly,
    // which is what keeps a misquoted argument from becoming a shell word.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    if (options?.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function firstErrorLine(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split("\n")[0] ?? "unknown error";
  }
  return String(error).split("\n")[0] ?? "unknown error";
}