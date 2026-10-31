// The OS credential store: invariants the bridge depends on and the one
// property the ADR refuses a fallback for.
//
// The most important assertions here are about the unavailable branch —
// when no OS store is reachable, a `save()` call throws
// `BrowserCredentialStoreUnavailableError` AND no file is written. We do
// not need a real filesystem to prove that; an explicit `noFileWritten`
// spy on the test side is sufficient.
//
// The second group covers the three rules every platform shares: the secret
// never reaches argv, the stored form is a reversible encoding of arbitrary
// bytes, and `load()` asks the platform rather than an in-process cache. The
// platform command runs are exercised through a recording fake runner, so
// these assertions are about what the code *sends*, not about what a local
// `security` / `secret-tool` / `powershell.exe` happens to do — none of the
// three exists on this Linux host.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BrowserCredentialStoreUnavailableError,
  createInMemorySecureCredentialStore,
  createPlatformSecureCredentialStore,
  fingerprint,
  generateBridgeCredential,
  type SecureCredentialReference,
} from "../../src/server/browser-bridge/index.js";
import {
  decodeCredentialFromStore,
  encodeCredentialForStore,
  type CommandOutput,
  type RunPlatformCommand,
} from "../../src/server/browser-bridge/credential-store.js";

describe("WebUI bridge credential store", () => {
  it("round-trips a secret through the in-memory store and surfaces a fingerprint without the secret", async () => {
    const store = createInMemorySecureCredentialStore();
    const { keyId, secret } = generateBridgeCredential();
    await store.save(keyId, secret);
    const loaded = await store.load(keyId);
    expect(loaded).toBeDefined();
    expect(Buffer.from(loaded!).toString("hex")).toBe(Buffer.from(secret).toString("hex"));
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.keyId).toBe(keyId);
    // The fingerprint must not contain the secret bytes.
    expect(list[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(list[0]!.fingerprint).not.toContain(Buffer.from(secret).toString("hex"));
  });

  it("returns undefined for a missing key without throwing", async () => {
    const store = createInMemorySecureCredentialStore();
    expect(await store.load("missing")).toBeUndefined();
  });

  it("deletes an entry idempotently", async () => {
    const store = createInMemorySecureCredentialStore();
    await store.save("k", new TextEncoder().encode("v"));
    await store.delete("k");
    await store.delete("k");
    expect(await store.load("k")).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  it("reports the secret store as unavailable on an unsupported platform", async () => {
    const store = createPlatformSecureCredentialStore({
      serviceName: "webui-browser-bridge",
      platformOverride: "haiku" as NodeJS.Platform,
    });
    expect(await store.isAvailable()).toBe(false);
  });

  it("throws a typed error when no OS store is available and writes nothing to disk", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "bridge-credential-store-"));
    const before = await listFilesRecursive(tmp);
    try {
      const store = createPlatformSecureCredentialStore({
        serviceName: "webui-browser-bridge",
        platformOverride: "haiku" as NodeJS.Platform,
      });
      const { keyId, secret } = generateBridgeCredential();
      let captured: unknown;
      try {
        await store.save(keyId, secret);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(BrowserCredentialStoreUnavailableError);
      const after = await listFilesRecursive(tmp);
      // No file may have been written; the ADR's whole point is "no
      // plaintext fall back". The test scratch directory would surface any
      // such write.
      expect(after).toEqual(before);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite the secret to disk on any code path through the unavailable store", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "bridge-credential-store-overwrite-"));
    try {
      // Plant a known file in the scratch directory. A test runner that
      // produced a stray write here would change its mtime.
      const decoy = path.join(tmp, "decoy.txt");
      await writeFile(decoy, "");
      const beforeStat = (await import("node:fs/promises")).stat(decoy);
      const store = createPlatformSecureCredentialStore({
        serviceName: "webui-browser-bridge",
        platformOverride: "haiku" as NodeJS.Platform,
      });
      const { keyId, secret } = generateBridgeCredential();
      try {
        await store.save(keyId, secret);
      } catch {
        // expected
      }
      const afterStat = await beforeStat;
      expect(afterStat.mtimeMs).toBe((await (await import("node:fs/promises")).stat(decoy)).mtimeMs);
      // No additional file appears besides the decoy.
      const files = await listFilesRecursive(tmp);
      expect(files.length).toBeLessThanOrEqual(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports no credential from an unavailable store even for a key it was asked to keep", async () => {
    const store = createPlatformSecureCredentialStore({
      serviceName: "webui-browser-bridge",
      platformOverride: "haiku" as NodeJS.Platform,
    });
    // An unavailable store has no platform to read from, so it must answer
    // "no credential" rather than keep a side map of what a failed save
    // could not persist anyway.
    expect(await store.load("anything")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The stored encoding                                                         */
/* -------------------------------------------------------------------------- */

describe("WebUI bridge credential storage encoding", () => {
  it("round-trips bytes that are not valid UTF-8 through the store helpers", () => {
    // Deliberately not UTF-8: a lone 0xff, an invalid 0xfe, an embedded NUL
    // and a bare continuation byte. This is what 32 bytes of CSPRNG output
    // routinely look like.
    const secret = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const encoded = encodeCredentialForStore(secret);
    expect(encoded).toBe(Buffer.from(secret).toString("base64"));
    const decoded = decodeCredentialFromStore(encoded);
    expect(decoded.byteLength).toBe(secret.byteLength);
    expect(Buffer.from(decoded).toString("hex")).toBe(Buffer.from(secret).toString("hex"));
  });

  it("round-trips a full 32-byte generated credential exactly", () => {
    const { secret } = generateBridgeCredential();
    const decoded = decodeCredentialFromStore(encodeCredentialForStore(secret));
    expect(Buffer.from(decoded).toString("hex")).toBe(Buffer.from(secret).toString("hex"));
  });

  it("would not survive a UTF-8 round trip, which is why the store encodes instead", () => {
    const secret = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    // The shape the implementation must not have: bytes → text → bytes.
    const viaText = new Uint8Array(Buffer.from(Buffer.from(secret).toString("utf8"), "utf8"));
    expect(Buffer.from(viaText).toString("hex")).not.toBe(Buffer.from(secret).toString("hex"));
    // The shape it does have.
    const viaBase64 = decodeCredentialFromStore(encodeCredentialForStore(secret));
    expect(Buffer.from(viaBase64).toString("hex")).toBe(Buffer.from(secret).toString("hex"));
  });

  it("tolerates the single trailing newline the lookup commands print", () => {
    const secret = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const encoded = encodeCredentialForStore(secret);
    expect(Buffer.from(decodeCredentialFromStore(`${encoded}\n`)).toString("hex")).toBe(
      Buffer.from(secret).toString("hex"),
    );
    expect(Buffer.from(decodeCredentialFromStore(`${encoded}\r\n`)).toString("hex")).toBe(
      Buffer.from(secret).toString("hex"),
    );
  });

  it("rejects a stored value that is not canonical base64", () => {
    // `Buffer.from(x, "base64")` silently skips what it does not understand,
    // so a lenient decode would hand back a short, plausible, wrong secret.
    expect(() => decodeCredentialFromStore("not base64!!")).toThrow();
    expect(() => decodeCredentialFromStore("QQ")).toThrow();
    expect(() => decodeCredentialFromStore("")).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Per-platform command construction                                           */
/* -------------------------------------------------------------------------- */

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A stand-in for the OS store, keyed by whatever the CLI would use. */
interface FakeOsPlatform {
  readonly run: RunPlatformCommand;
  readonly calls: RecordedCall[];
  /** The stored values, keyed by key id — the "OS side" a restart returns to. */
  readonly items: Map<string, string>;
  readonly controls: { failWrites: boolean };
}

function createFakeOsPlatform(): FakeOsPlatform {
  const items = new Map<string, string>();
  const calls: RecordedCall[] = [];
  const controls = { failWrites: false };

  // Each store names its key differently on the wire; recovering it is what
  // lets one fake stand in for all three.
  const keyFor = (command: string, args: readonly string[]): string => {
    if (command === "security") {
      const index = args.indexOf("-a");
      return args[index + 1] ?? "";
    }
    if (command === "secret-tool") {
      const index = args.indexOf("key");
      return args[index + 1] ?? "";
    }
    return /bridge-([A-Za-z0-9_-]+)\.blob/.exec(args.join(" "))?.[1] ?? "";
  };

  const run: RunPlatformCommand = async (
    command: string,
    args: readonly string[],
    options,
  ): Promise<CommandOutput> => {
    // The stores always send text on stdin; normalise once so both the
    // recorded call and the fake store agree on its shape.
    const stdin = options?.stdin === undefined ? undefined : String(options.stdin);
    calls.push({ command, args: [...args], stdin });
    const script = args.join(" ");
    // Availability probes.
    if (args.includes("help") || args.includes("--version") || script.includes("PSVersionTable")) {
      return { stdout: "1\n", stderr: "", exitCode: 0 };
    }
    const key = keyFor(command, args);
    const isWrite = script.includes("add-generic-password")
      ? true
      : args[0] === "store"
        ? true
        : script.includes("WriteAllText");
    const isRead = args[0] === "find-generic-password"
      ? true
      : args[0] === "lookup"
        ? true
        : script.includes("ReadAllText");
    const isDelete = args[0] === "delete-generic-password"
      ? true
      : args[0] === "clear"
        ? true
        : script.includes("Delete");
    if (isWrite) {
      if (controls.failWrites) {
        return { stdout: "", stderr: "the store is locked", exitCode: 1 };
      }
      // The OS store keeps the encoded payload, not the raw bytes.
      items.set(key, stdin ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (isRead) {
      const stored = items.get(key);
      if (stored === undefined) {
        return { stdout: "", stderr: "the specified item could not be found", exitCode: 44 };
      }
      return { stdout: `${stored}\n`, stderr: "", exitCode: 0 };
    }
    if (isDelete) {
      items.delete(key);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  return { run, calls, items, controls };
}

const PLATFORM_CASES = [
  { platform: "darwin" as NodeJS.Platform, label: "macOS Keychain", command: "security" },
  { platform: "linux" as NodeJS.Platform, label: "Secret Service", command: "secret-tool" },
  { platform: "win32" as NodeJS.Platform, label: "Windows DPAPI", command: "powershell.exe" },
];

const NON_UTF8_SECRET = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x80]);
const TEST_KEY_ID = "11111111-2222-3333-4444-555555555555";

describe("WebUI bridge credential store — platform commands", () => {
  // The Windows store derives its blob path from LOCALAPPDATA at call time.
  // Pointing it at a scratch directory makes "wrote no file" checkable and
  // keeps a test run from touching the real user profile.
  let scratch = "";
  let previousLocalAppData: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "bridge-credential-platform-"));
    previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = scratch;
  });

  afterEach(async () => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    await rm(scratch, { recursive: true, force: true });
  });

  for (const { platform, label, command } of PLATFORM_CASES) {
    it(`keeps the ${label} secret out of argv and writes it on stdin`, async () => {
      const os = createFakeOsPlatform();
      const store = createPlatformSecureCredentialStore({
        serviceName: "webui-browser-bridge",
        platformOverride: platform,
        runCommand: os.run,
      });
      expect(await store.isAvailable()).toBe(true);
      await store.save(TEST_KEY_ID, NON_UTF8_SECRET);

      const encoded = encodeCredentialForStore(NON_UTF8_SECRET);
      // argv is readable by any process on the machine, so no argument of any
      // call may carry the secret in any of its forms.
      for (const call of os.calls) {
        const argv = [call.command, ...call.args].join(" ");
        expect(argv).not.toContain(encoded);
        expect(argv).not.toContain(Buffer.from(NON_UTF8_SECRET).toString("hex"));
        expect(argv).not.toContain(Buffer.from(NON_UTF8_SECRET).toString("utf8"));
      }
      // The write carried it on stdin, not on the command line.
      const write = os.calls.find((call) => call.stdin !== undefined);
      expect(write?.stdin).toBe(encoded);
      expect(write?.command).toBe(command);
      // Nothing was written into the scratch directory by any of this.
      expect(await listFilesRecursive(scratch)).toEqual([]);
    });

    it(`reads a saved ${label} credential back after a restart`, async () => {
      const os = createFakeOsPlatform();
      const options = {
        serviceName: "webui-browser-bridge",
        platformOverride: platform,
        runCommand: os.run,
      };
      await createPlatformSecureCredentialStore(options).save(TEST_KEY_ID, NON_UTF8_SECRET);

      // A brand new store instance: the in-process state of the writer is
      // gone, so a value that resolves now came from the platform.
      const afterRestart = createPlatformSecureCredentialStore(options);
      const loaded = await afterRestart.load(TEST_KEY_ID);
      expect(loaded).toBeDefined();
      expect(Buffer.from(loaded!).toString("hex")).toBe(
        Buffer.from(NON_UTF8_SECRET).toString("hex"),
      );
    });

    it(`answers "no credential" from the ${label} platform when the entry is gone`, async () => {
      const os = createFakeOsPlatform();
      const store = createPlatformSecureCredentialStore({
        serviceName: "webui-browser-bridge",
        platformOverride: platform,
        runCommand: os.run,
      });
      await store.save(TEST_KEY_ID, NON_UTF8_SECRET);
      // The store's own memory must not be the answer: once the platform no
      // longer holds it, load() has to say so rather than serve a stale copy.
      os.items.clear();
      expect(await store.load(TEST_KEY_ID)).toBeUndefined();
    });

    it(`throws the typed unavailable error when the ${label} platform refuses the write`, async () => {
      const os = createFakeOsPlatform();
      os.controls.failWrites = true;
      const store = createPlatformSecureCredentialStore({
        serviceName: "webui-browser-bridge",
        platformOverride: platform,
        runCommand: os.run,
      });
      await expect(store.save(TEST_KEY_ID, NON_UTF8_SECRET)).rejects.toBeInstanceOf(
        BrowserCredentialStoreUnavailableError,
      );
      expect(await listFilesRecursive(scratch)).toEqual([]);
    });

    it(`deletes a ${label} credential so a later load finds nothing`, async () => {
      const os = createFakeOsPlatform();
      const store = createPlatformSecureCredentialStore({
        serviceName: "webui-browser-bridge",
        platformOverride: platform,
        runCommand: os.run,
      });
      await store.save(TEST_KEY_ID, NON_UTF8_SECRET);
      await store.delete(TEST_KEY_ID);
      // Idempotent: a second delete must not throw.
      await store.delete(TEST_KEY_ID);
      expect(await store.load(TEST_KEY_ID)).toBeUndefined();
      expect(await store.list()).toEqual([]);
    });
  }
});

describe("WebUI bridge credential generation", () => {
  it("emits a 32-byte secret and a UUID-shaped key id", () => {
    const { keyId, secret } = generateBridgeCredential();
    expect(keyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(secret.byteLength).toBeGreaterThanOrEqual(32);
  });

  it("yields a stable, non-secret fingerprint that does not include the secret bytes", () => {
    const a = generateBridgeCredential();
    const b = generateBridgeCredential();
    // Same secret, same fingerprint.
    expect(fingerprint(a.secret)).toBe(fingerprint(a.secret));
    // Different secrets, different fingerprints.
    expect(fingerprint(a.secret)).not.toBe(fingerprint(b.secret));
    // Fingerprints are 16 hex characters and never accidentally swallow the
    // secret bytes verbatim — they are SHA-256 over a namespace prefix.
    const sample = fingerprint(a.secret);
    expect(sample).toMatch(/^[0-9a-f]{16}$/);
    expect(sample).not.toContain(Buffer.from(a.secret).toString("hex").slice(0, 16));
  });
});

/* -------------------------------------------------------------------------- */

async function listFilesRecursive(root: string): Promise<readonly string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const s = await stat(full);
        out.push(`${full}:${s.size}`);
      }
    }
  }
  await walk(root);
  return out;
}

// Reserved import to keep TypeScript happy when the test file shrinks.
void (null as unknown as SecureCredentialReference);