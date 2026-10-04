// Unit tests for the workspace archive preview.
//
// Two halves:
//   * the server module (`workspace-archive.ts`) against real archives built in
//     a temp dir, plus hand-rolled byte-level zips for the shapes no archive
//     tool will emit on request (`../escape`, `/absolute`, a symlink, a lying
//     header, ten thousand entries);
//   * the view (`WorkspaceArchiveView.tsx`) through `renderToStaticMarkup` —
//     the project's SSR test convention, see `workspace-panel-state.test.ts`.
//     Static rendering does not run effects, so the container's first paint and
//     every non-loading state are asserted through the presentational exports.
//
// The clauses these pin shut:
//   * a valid zip/tar/tar.gz lists one level, and `prefix` walks deeper;
//   * an entry that escapes the destination is refused and nothing is written;
//   * absolute names, Windows drive letters and backslash separators are
//     refused;
//   * a symlink is refused rather than materialised;
//   * the entry ceiling stops the reader before a huge entry count can exhaust
//     memory while building a listing;
//   * a lying header is caught, both by the declared-total pre-flight and by the
//     per-entry expansion ratio;
//   * a truncated or non-archive file produces a clear message, not a crash;
//   * the port no longer throws "capability not connected yet".

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractWorkspaceArchiveDirectory, readWorkspaceArchiveListing } from "../../src/server/workspace-archive.js";
import { createHarnessPortFromHost, type WebuiRuntimeCliService } from "../../src/server/host.js";
import {
  archiveDestinationFor,
  formatArchiveSize,
  WorkspaceArchiveListing,
  WorkspaceArchiveNotice,
  WorkspaceArchiveView,
} from "../../src/client/components/WorkspaceArchiveView.js";

/** Fixtures live in the OS temp dir; nothing is written into the repo tree. */
let workspace = "";

function artifactPath(name: string): string {
  return path.join(workspace, name);
}

function writeArtifact(name: string, content: Buffer | string): string {
  const target = artifactPath(name);
  writeFileSync(target, content);
  return target;
}

/** Whether anything at all sits at this path, directory included. */
function exists(candidate: string): boolean {
  try {
    statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** The files (not directories) written under a destination, relative and sorted. */
function writtenFiles(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .sort();
  } catch {
    return [];
  }
}

function readArtifact(name: string): string | undefined {
  try {
    return readFileSync(artifactPath(name), "utf8");
  } catch {
    return undefined;
  }
}

beforeAll(() => {
  // `realpathSync` first: on macOS the temp dir is a symlink, and the module
  // resolves the workspace root through `realpath`, so an unresolved fixture
  // path would not match what the module compares against.
  workspace = mkdtempSync(path.join(realpathSync(tmpdir()), "webui-archive-"));
});

afterAll(() => {
  if (workspace) rmSync(workspace, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function canRun(command: string): boolean {
  try {
    execFileSync(command, ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_ZIP = canRun("zip");
const HAS_TAR = canRun("tar");

function writeTree(name: string, members: Readonly<Record<string, string>>): string {
  const source = artifactPath(name);
  mkdirSync(source, { recursive: true });
  for (const [member, content] of Object.entries(members)) {
    const file = path.join(source, member);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return source;
}

/**
 * `COPYFILE_DISABLE` for the fixture builders: without it macOS's archiver adds
 * an AppleDouble sidecar member (`._inner.txt`) beside every file, which would
 * make these assertions about the platform rather than about the reader.
 */
const FIXTURE_ENV = { ...process.env, COPYFILE_DISABLE: "1" };

/** A real zip, built by the `zip` CLI. */
function realZip(name: string, members: Readonly<Record<string, string>>): string {
  const source = writeTree(`${name}-src`, members);
  execFileSync("zip", ["-q", "-r", artifactPath(name), "."], { cwd: source, env: FIXTURE_ENV });
  return artifactPath(name);
}

/** A real tar, or a gzipped one when the name ends in `.tgz`. */
function realTar(name: string, members: Readonly<Record<string, string>>): string {
  const source = writeTree(`${name}-src`, members);
  const args = name.endsWith(".tgz") ? ["czf", artifactPath(name)] : ["cf", artifactPath(name)];
  execFileSync("tar", [...args, "."], { cwd: source, env: FIXTURE_ENV });
  return artifactPath(name);
}

type CraftedZipEntry = {
  readonly name: string;
  readonly content?: string | Buffer;
  /** Unix mode written into the external attributes; 0o120000 marks a link. */
  readonly mode?: number;
  readonly method?: 0 | 8;
  /** Overrides for the central directory, i.e. the header being lied to. */
  readonly declaredUncompressedSize?: number;
  readonly declaredCompressedSize?: number;
};

/**
 * A zip written byte by byte.
 *
 * The archive tools refuse to emit the hostile shapes — `zip` answers "Nothing
 * to do!" for `../escape` and for `/etc/hostname` — so the security cases need a
 * writer that will. Only the fields the reader parses are filled in; the CRC is
 * left zero because nothing verifies it, which is precisely the kind of sloppiness
 * a hostile archive would have.
 */
function craftZip(entries: readonly CraftedZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "", "utf8");
    const method = entry.method ?? 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // High byte 3 = unix, which is what makes the external attributes a mode.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.declaredCompressedSize ?? data.length, 20);
    central.writeUInt32LE(entry.declaredUncompressedSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    // `>>> 0`, not `<< 16`: a mode with bit 31 set (0o120777) shifts into the
    // sign bit and comes back negative.
    central.writeUInt32LE(((mode & 0xffff) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/** A minimal tar: one 512-byte header, its padded data, and the end marker. */
function craftTar(name: string, content: string, typeflag = "0"): Buffer {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148, "ascii");
  header.write(typeflag, 156, "ascii");
  header.write("ustar\0" + "00", 257, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

// ---------------------------------------------------------------------------
// Server: listing
// ---------------------------------------------------------------------------

describe("workspace archive listing", () => {
  it.skipIf(!HAS_ZIP)("lists one level of a real zip and synthesises its directories", async () => {
    realZip("plain.zip", { "inner.txt": "hello", "sub/deep.txt": "deeper" });
    const listing = await readWorkspaceArchiveListing({ workspaceDir: workspace, path: "plain.zip" });
    expect(listing.archivePath).toBe("plain.zip");
    // `sub` is implied by `sub/deep.txt`; a listing that reported only what is
    // literally present would show an empty level for a directory full of files.
    expect(listing.entries.map((entry) => [entry.name, entry.isDirectory, entry.size])).toEqual([
      ["sub", true, undefined],
      ["inner.txt", false, 5],
    ]);
    expect(listing.totalEntries).toBe(3);
    expect(listing.truncated).toBe(false);
  });

  it.skipIf(!HAS_ZIP)("walks into a directory by re-listing with a prefix", async () => {
    realZip("nested.zip", { "inner.txt": "hello", "sub/deep.txt": "deeper", "sub/other/x.txt": "x" });
    const listing = await readWorkspaceArchiveListing({ workspaceDir: workspace, path: "nested.zip", prefix: "sub" });
    expect(listing.entries.map((entry) => [entry.name, entry.isDirectory])).toEqual([
      ["other", true],
      ["deep.txt", false],
    ]);
    expect(listing.truncated).toBe(false);
  });

  it.skipIf(!HAS_TAR)("reads a path longer than the 100-byte name field", async () => {
    // Longer than the tar name field, so it arrives in the ustar prefix field or
    // a pax `path=` record depending on the archiver. Either way the listing has
    // to name the real path: dropping the prefix would rename every member under
    // a deep directory, silently.
    const directory = "d".repeat(90);
    const file = `${"n".repeat(60)}.txt`;
    realTar("long.tar", { [`${directory}/${file}`]: "deep" });
    const root = await readWorkspaceArchiveListing({ workspaceDir: workspace, path: "long.tar" });
    expect(root.entries.map((entry) => entry.name)).toEqual([directory]);
    const nested = await readWorkspaceArchiveListing({
      workspaceDir: workspace,
      path: "long.tar",
      prefix: directory,
    });
    expect(nested.entries.map((entry) => entry.name)).toEqual([file]);
    expect(nested.truncated).toBe(false);
  });

  it.skipIf(!HAS_TAR)("reads a real tar and a gzipped tar the same way", async () => {
    realTar("plain.tar", { "inner.txt": "hello", "sub/deep.txt": "deeper" });
    realTar("plain.tgz", { "inner.txt": "hello", "sub/deep.txt": "deeper" });
    for (const archive of ["plain.tar", "plain.tgz"]) {
      const listing = await readWorkspaceArchiveListing({ workspaceDir: workspace, path: archive });
      expect(listing.entries.map((entry) => entry.name)).toEqual(["sub", "inner.txt"]);
      expect(listing.truncated).toBe(false);
    }
  });

  it("refuses a file that is not an archive, and names the formats it can read", async () => {
    writeArtifact("notes.zip", "this is not a zip at all\n");
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "notes.zip" })).rejects.toThrow(
      /不是可识别的 ZIP/,
    );
    writeArtifact("bundle.rar", "Rar!\x1a\x07\x00");
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "bundle.rar" })).rejects.toThrow(
      /不支持的压缩包格式/,
    );
    writeArtifact("plain.gz", gzipSync(Buffer.from("hello")));
    // A bare `.gz` is one compressed stream with no directory structure, so it
    // is refused by name rather than guessed at as a tar.
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "plain.gz" })).rejects.toThrow(
      /\.tar\.gz/,
    );
    writeArtifact("bundle.7z", "7z\xbc\xaf\x27\x1c");
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "bundle.7z" })).rejects.toThrow(
      /不支持的压缩包格式/,
    );
    writeArtifact("notes.txt", "plain text");
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "notes.txt" })).rejects.toThrow(
      /只有 .zip/,
    );
  });

  it("reports a truncated zip instead of reading past the end of the file", async () => {
    const complete = craftZip([{ name: "a.txt", content: "hello" }]);
    // Drop the end-of-central-directory record, which is exactly what a partial
    // download or a full disk leaves behind.
    writeArtifact("truncated.zip", complete.subarray(0, complete.length - 12));
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "truncated.zip" })).rejects.toThrow(
      /不是可识别的 ZIP/,
    );
    writeArtifact("half.zip", craftZip([{ name: "a.txt", content: "hello" }]).subarray(0, 20));
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "half.zip" })).rejects.toThrow(/ZIP/);
  });

  it("reports a truncated or corrupt tar rather than trusting a garbage header", async () => {
    const complete = craftTar("a.txt", "hello");
    writeArtifact("cut.tar", complete.subarray(0, 700));
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "cut.tar" })).rejects.toThrow(/tar/);

    const corrupt = Buffer.from(complete);
    corrupt[124] = 0xff;
    writeArtifact("corrupt.tar", corrupt);
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "corrupt.tar" })).rejects.toThrow(
      /校验和|大小字段/,
    );

    writeArtifact("tiny.tar", Buffer.alloc(200));
    await expect(readWorkspaceArchiveListing({ workspaceDir: workspace, path: "tiny.tar" })).rejects.toThrow(/太短或已截断/);
  });

  it("stops at the entry ceiling before a huge entry count can exhaust memory", async () => {
    // One directory holding 10,001 files. A full parse would report a single row
    // *and* `truncated: false`, so `truncated: true` here can only mean the
    // reader stopped at its ceiling.
    writeArtifact(
      "many.zip",
      craftZip(
        Array.from({ length: 10_001 }, (_, index) => ({
          name: `d/file-${String(index).padStart(5, "0")}.txt`,
          content: "",
        })),
      ),
    );
    const listing = await readWorkspaceArchiveListing({ workspaceDir: workspace, path: "many.zip" });
    expect(listing.entries).toHaveLength(1);
    expect(listing.totalEntries).toBe(10_001);
    expect(listing.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server: extraction
// ---------------------------------------------------------------------------

describe("workspace archive extraction", () => {
  it.skipIf(!HAS_ZIP)("writes the current directory into a destination beside the archive", async () => {
    realZip("bundle.zip", { "inner.txt": "hello", "sub/deep.txt": "deeper", "sub/other/x.txt": "x" });
    const result = await extractWorkspaceArchiveDirectory({
      workspaceDir: workspace,
      path: "bundle.zip",
      destination: "unpacked",
      prefix: "sub",
    });
    // The prefix is stripped, so extracting `sub` writes `deep.txt`, not
    // `sub/deep.txt`.
    expect(result).toMatchObject({ archivePath: "bundle.zip", destination: "unpacked", writtenFiles: 2 });
    expect(readArtifact("unpacked/deep.txt")).toBe("deeper");
    expect(readArtifact("unpacked/other/x.txt")).toBe("x");
    expect(exists(artifactPath("unpacked/inner.txt"))).toBe(false);
  });

  it("refuses an entry that escapes the destination and writes nothing", async () => {
    for (const name of ["../escaped.txt", "a/../../escaped.txt", "..\\escaped.txt"]) {
      writeArtifact("slip.zip", craftZip([{ name, content: "pwned" }]));
      await expect(
        extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "slip.zip", destination: "out" }),
      ).rejects.toThrow(/不安全|越界/);
    }
    // Two phases: validation happens before the first byte is written, so a
    // rejected archive leaves neither a half-extracted tree nor a stray file
    // above the workspace.
    expect(exists(artifactPath("out"))).toBe(false);
    expect(exists(path.join(workspace, "..", "escaped.txt"))).toBe(false);
  });

  it("refuses a hostile entry elsewhere in the archive even when a prefix is scoped", async () => {
    // Scoping the extraction must not become a way to skip a check: a hostile
    // entry outside the selected directory still refuses the whole operation,
    // the same as it does when the archive is extracted whole.
    writeArtifact(
      "scoped-slip.zip",
      craftZip([
        { name: "sub/fine.txt", content: "fine" },
        { name: "../escaped.txt", content: "pwned" },
      ]),
    );
    await expect(
      extractWorkspaceArchiveDirectory({
        workspaceDir: workspace,
        path: "scoped-slip.zip",
        destination: "scoped-out",
        prefix: "sub",
      }),
    ).rejects.toThrow(/不安全|越界/);
    expect(exists(artifactPath("scoped-out"))).toBe(false);
    expect(exists(path.join(workspace, "..", "escaped.txt"))).toBe(false);
  });

  it("refuses absolute entry names, drive letters and backslash separators", async () => {
    const cases: Readonly<Record<string, RegExp>> = {
      "/etc/passwd": /不安全/,
      "\\etc\\passwd": /不安全/,
      "C:/Windows/system32/etc/hosts": /不安全/,
      "C:x": /不安全/,
    };
    for (const [name, message] of Object.entries(cases)) {
      writeArtifact("absolute.zip", craftZip([{ name, content: "pwned" }]));
      await expect(
        extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "absolute.zip", destination: "out" }),
      ).rejects.toThrow(message);
    }
    expect(exists(artifactPath("out"))).toBe(false);
  });

  it("refuses a symlink rather than materialising one", async () => {
    // A symlink written into a workspace is a write primitive pointing wherever
    // the archive wants, so it is refused instead of created.
    const source = writeTree("link-src", { "inner.txt": "hello" });
    symlinkSync("inner.txt", path.join(source, "link.txt"));
    if (HAS_ZIP) {
      // `-y` stores the link itself rather than the file it points at.
      execFileSync("zip", ["-q", "-y", artifactPath("linky.zip"), "link.txt"], { cwd: source });
      await expect(
        extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "linky.zip", destination: "out" }),
      ).rejects.toThrow(/符号链接/);
    }
    if (HAS_TAR) {
      realTarLink("linky.tar", source, "link.txt");
      await expect(
        extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "linky.tar", destination: "out" }),
      ).rejects.toThrow(/符号链接/);
    }
    // And against a hand-built zip, so the refusal does not depend on a CLI.
    writeArtifact("craft-link.zip", craftZip([{ name: "link.txt", content: "/etc/passwd", mode: 0o120777 }]));
    await expect(
      extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "craft-link.zip", destination: "out" }),
    ).rejects.toThrow(/符号链接/);
    expect(exists(artifactPath("out"))).toBe(false);
  });

  it("refuses a declared-size lie: a huge declared total, and an absurd expansion ratio", async () => {
    // The header claims a gigabyte of expansion for a two-byte member. The
    // pre-flight sums the declared sizes, so nothing is inflated at all.
    writeArtifact(
      "lie-total.zip",
      craftZip([{ name: "a.txt", content: "hi", declaredUncompressedSize: 1024 * 1024 * 1024 }]),
    );
    await expect(
      extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "lie-total.zip", destination: "out" }),
    ).rejects.toThrow(/声明的展开后体积过大/);

    // Here the declared total is 1 byte while the real payload is a megabyte,
    // and the compressed size is claimed as 1 byte as well, so the declared
    // pre-flight has nothing to catch. Deflate cannot do better than about
    // 1032:1, so a member claiming to have compressed a megabyte into a byte is
    // a lie either way it is caught: a reader that trusts the declared
    // compressed size slices a one-byte stream and fails to inflate it, and one
    // that inflates first measures 1 MiB against 1 byte and trips the ratio.
    // Either outcome is a refusal, and the point of the test is the refusal.
    writeArtifact(
      "lie-ratio.zip",
      craftZip([
        { name: "bomb.bin", content: Buffer.alloc(1024 * 1024), declaredUncompressedSize: 1, declaredCompressedSize: 1 },
      ]),
    );
    await expect(
      extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "lie-ratio.zip", destination: "out" }),
    ).rejects.toThrow(/异常膨胀|ZIP 条目已损坏/);
    // Names and the declared total are refused before the destination is even
    // created; a byte-level failure (a corrupt stream, an expansion blow-up, a
    // file that already exists) is discovered mid-write, so what must not
    // survive it is a written *file*.
    expect(writtenFiles(artifactPath("out"))).toEqual([]);
  });

  it("refuses a destination outside the workspace, and creates nothing", async () => {
    writeArtifact("small.zip", craftZip([{ name: "a.txt", content: "hello" }]));
    await expect(
      extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "small.zip", destination: "../escape" }),
    ).rejects.toThrow(/越界/);
    await expect(
      extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "small.zip", destination: "/tmp/webui-escape" }),
    ).rejects.toThrow(/越界/);
    expect(exists(path.join(workspace, "..", "escape"))).toBe(false);
  });

  it("refuses to overwrite a file that is already in the destination", async () => {
    writeArtifact("clash.zip", craftZip([{ name: "a.txt", content: "from archive" }]));
    mkdirSync(artifactPath("clash-out"), { recursive: true });
    writeArtifact("clash-out/a.txt", "already mine");
    // An archive the user did not write must never be able to overwrite a file
    // already in their workspace.
    await expect(
      extractWorkspaceArchiveDirectory({ workspaceDir: workspace, path: "clash.zip", destination: "clash-out" }),
    ).rejects.toThrow(/EEXIST|file already exists/iu);
    expect(readArtifact("clash-out/a.txt")).toBe("already mine");
  });

  it.skipIf(!HAS_ZIP)("extracts a whole archive when no prefix is given", async () => {
    realZip("whole.zip", { "one.txt": "1", "two/deep.txt": "2" });
    const result = await extractWorkspaceArchiveDirectory({
      workspaceDir: workspace,
      path: "whole.zip",
      destination: "whole-out",
    });
    expect(result.writtenFiles).toBe(2);
    expect(readArtifact("whole-out/one.txt")).toBe("1");
    expect(readArtifact("whole-out/two/deep.txt")).toBe("2");
  });
});

/** A tar containing a symlink, via the CLI (`tar` records typeflag `2`). */
function realTarLink(name: string, source: string, member: string): string {
  execFileSync("tar", ["cf", artifactPath(name), member], { cwd: source, env: FIXTURE_ENV });
  return artifactPath(name);
}

// ---------------------------------------------------------------------------
// Server: the port projection
// ---------------------------------------------------------------------------

describe("harness port archive members", () => {
  it("serves both operations from this package when the runtime has neither", async () => {
    writeArtifact("port.zip", craftZip([{ name: "a/b.txt", content: "hello" }]));
    // A host whose cliService predates the archive capability. Before this
    // change the two port members threw "压缩包浏览能力尚未接入。" right here.
    const port = createHarnessPortFromHost({
      appVersion: "archive-test",
      cliService: {} as unknown as WebuiRuntimeCliService,
    });
    const listing = await port.readWorkspaceArchive({ workspaceDir: workspace, path: "port.zip" });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a"]);
    const result = await port.extractWorkspaceArchive({
      workspaceDir: workspace,
      path: "port.zip",
      destination: "port-out",
    });
    expect(result.writtenFiles).toBe(1);
    // No prefix: the archive's own layout is preserved under the destination.
    expect(readArtifact("port-out/a/b.txt")).toBe("hello");
  });

  it("prefers a runtime implementation when the host provides one", async () => {
    const port = createHarnessPortFromHost({
      appVersion: "archive-test",
      cliService: {
        async readWorkspaceArchive() {
          return { archivePath: "from-runtime.zip", entries: [], totalEntries: 0, truncated: false };
        },
      } as unknown as WebuiRuntimeCliService,
    });
    const listing = await port.readWorkspaceArchive({ workspaceDir: workspace, path: "port.zip" });
    expect(listing.archivePath).toBe("from-runtime.zip");
  });
});

// ---------------------------------------------------------------------------
// Client: the view
// ---------------------------------------------------------------------------

const READY_LISTING = {
  archivePath: "dist/bundle.zip",
  entries: [
    { path: "src", name: "src", isDirectory: true },
    { path: "readme.md", name: "readme.md", isDirectory: false, size: 2048 },
    { path: "empty.log", name: "empty.log", isDirectory: false, size: 0 },
  ],
  totalEntries: 3,
  truncated: false,
};

function renderListing(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkspaceArchiveListing, {
      archivePath: READY_LISTING.archivePath,
      prefix: "",
      destination: "dist/bundle",
      entries: READY_LISTING.entries,
      totalEntries: READY_LISTING.totalEntries,
      truncated: false,
      extractState: { status: "idle" },
      ...overrides,
    } as never),
  );
}

describe("workspace archive view", () => {
  it("paints the loading state on first render, before any effect has run", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceArchiveView, {
        workspaceDir: "/repo",
        path: "dist/bundle.zip",
        // A listing that never settles. Static rendering does not run the
        // effect, so this is the state a reader actually sees first.
        readWorkspaceArchive: () => new Promise(() => undefined),
      }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在读取压缩包");
  });

  it("says so when the service exposes no archive capability", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceArchiveView, { workspaceDir: "/repo", path: "dist/bundle.zip" }),
    );
    expect(markup).toContain("没有提供压缩包浏览能力");
  });

  it("names each entry with its size and a directory marker", () => {
    const markup = renderListing();
    expect(markup).toContain("src（目录）");
    expect(markup).toContain('data-testid="workspace-archive-directory"');
    expect(markup).toContain("readme.md");
    // 2 KB rather than 2048 B, and the zero-byte member is still 0 B instead of
    // losing its size to a falsy check.
    expect(markup).toContain("2.0 KB");
    expect(markup).toContain("0 B");
    expect(markup).toContain('data-testid="workspace-archive-size"');
  });

  it("distinguishes an empty level from a listing that has entries", () => {
    const empty = renderListing({ entries: [], totalEntries: 0 });
    expect(empty).toContain('data-testid="workspace-archive-empty"');
    expect(empty).not.toContain('data-testid="workspace-archive-entries"');
    expect(empty).not.toContain('data-testid="workspace-archive-truncated"');
  });

  it("shows a truncated listing as truncated instead of a complete one", () => {
    const markup = renderListing({ truncated: true, totalEntries: 9_000 });
    expect(markup).toContain('data-testid="workspace-archive-truncated"');
    expect(markup).toContain("共 9000 项");
    expect(markup).toContain("只显示了 3 项");
    // The rows are still there; the banner is what makes the limit legible.
    expect(markup).toContain('data-testid="workspace-archive-entries"');
  });

  it("offers the destination instead of a field the browser could type into", () => {
    const markup = renderListing();
    expect(markup).toContain('data-testid="workspace-archive-destination"');
    expect(markup).toContain("dist/bundle");
    expect(markup).toContain('data-testid="workspace-archive-extract"');
    expect(markup).not.toContain("<input");
    // No destination means no usable extract control rather than one pointed at "".
    const unusable = renderListing({ destination: "" });
    expect(unusable).toContain("没有可用的解压目标");
    expect(unusable).toContain('disabled=""');
  });

  it("only offers the way back up once inside a directory", () => {
    expect(renderListing()).not.toContain('data-testid="workspace-archive-up"');
    const nested = renderListing({ prefix: "src" });
    expect(nested).toContain('data-testid="workspace-archive-up"');
    expect(nested).toContain("bundle.zip › src");
  });

  it("reports an extraction result and an extraction failure differently", () => {
    const done = renderListing({
      extractState: {
        status: "done",
        result: { archivePath: "dist/bundle.zip", destination: "dist/bundle", writtenFiles: 3 },
      },
    });
    expect(done).toContain('data-testid="workspace-archive-extract-result"');
    expect(done).toContain("已解压 3 个文件");

    const partial = renderListing({
      extractState: {
        status: "done",
        result: { archivePath: "dist/bundle.zip", destination: "dist/bundle", writtenFiles: 3, truncated: true },
      },
    });
    expect(partial).toContain("仅解压了前一部分");

    const failed = renderListing({ extractState: { status: "error", error: "压缩包中存在不安全的条目" } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("不安全");

    const running = renderListing({ extractState: { status: "running" } });
    expect(running).toContain("正在解压");
    expect(running).toContain('disabled=""');
  });

  it("separates a failure from a state that was never available", () => {
    const notice = renderToStaticMarkup(createElement(WorkspaceArchiveNotice, { reason: "正在读取压缩包…" }));
    expect(notice).toContain('role="status"');
    expect(notice).not.toContain('role="alert"');
    const failure = renderToStaticMarkup(
      createElement(WorkspaceArchiveNotice, { reason: "这不是可识别的 ZIP 压缩包", role: "alert" }),
    );
    expect(failure).toContain('role="alert"');
  });

  it("derives a workspace-relative destination from the archive path", () => {
    expect(archiveDestinationFor("dist/bundle.zip")).toBe("dist/bundle");
    expect(archiveDestinationFor("bundle.tgz")).toBe("bundle");
    expect(archiveDestinationFor("dist/bundle.tar.gz")).toBe("dist/bundle");
    // Anything that would need re-validating to be safe is refused outright.
    expect(archiveDestinationFor("../evil.zip")).toBe("");
    expect(archiveDestinationFor("/etc/bundle.zip")).toBe("");
    expect(archiveDestinationFor("")).toBe("");
  });

  it("formats sizes in the units the listing shows them in", () => {
    expect(formatArchiveSize(0)).toBe("0 B");
    expect(formatArchiveSize(999)).toBe("999 B");
    expect(formatArchiveSize(1024)).toBe("1.0 KB");
    expect(formatArchiveSize(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatArchiveSize(1024 ** 4)).toBe("1.0 TB");
  });
});
