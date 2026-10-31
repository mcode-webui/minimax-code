// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * Largest compressed archive this module will read into memory.
 *
 * 200 MiB, the same figure `deployed-website-source.ts` uses for a *downloaded*
 * archive. The panel is previewing a file the user already has in their own
 * workspace tree, so nothing is arriving over a network, and a cap far below
 * this would refuse legitimate build outputs (`target/`, `.next/`) that are
 * routinely zipped up and opened for inspection.
 */

// ---------------------------------------------------------------------------
// The zip parser
// ---------------------------------------------------------------------------

/**
 * `yauzl`, loaded through `require` and typed here.
 *
 * yauzl ships no declarations, and an ambient `declare module "yauzl"` is
 * ignored while the specifier still resolves to the package's JavaScript — which
 * is why the type lives at the use site, shaped to what this module calls, the
 * same way the terminal manager types `node-pty`. The fields below were read
 * from `node_modules/yauzl/index.js` (v3.4.0).
 */
export type ZipParserEntry = {
  readonly fileName: string;
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  readonly externalFileAttributes: number;
  readonly versionMadeBy: number;
};

export type ZipParserFile = {
  readEntry(): void;
  openReadStreamPromise(entry: ZipParserEntry): Promise<NodeJS.ReadableStream>;
  close(): void;
  on(event: "entry", listener: (entry: ZipParserEntry) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  removeListener(
    event: "entry",
    listener: (entry: ZipParserEntry) => void,
  ): void;
  removeListener(event: "end", listener: () => void): void;
  removeListener(event: "error", listener: (error: Error) => void): void;
};

export type ZipParserModule = {
  fromBufferPromise(
    buffer: Buffer,
    options?: {
      readonly lazyEntries?: boolean;
      readonly decodeStrings?: boolean;
      readonly validateEntrySizes?: boolean;
      readonly autoClose?: boolean;
    },
  ): Promise<ZipParserFile>;
};

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

// ---------------------------------------------------------------------------
// Entry model
// ---------------------------------------------------------------------------

export type ArchiveEntry = {
  /** The name exactly as the container stored it, before normalisation. */
  readonly rawName: string;
  /**
   * Archive-internal POSIX path, absent when `unsafeReason` is set. An entry
   * without a path is never named to the client and never written.
   */
  readonly path?: string;
  readonly isDirectory: boolean;
  /** Size the container claims for this entry; the header may be lying. */
  readonly declaredSize: number;
  /** Compressed size, the denominator of the expansion-ratio ceiling. */
  readonly compressedSize: number;
  /** Why this entry is refused, in the panel's own words. */
  readonly unsafeReason?: string;
  /**
   * Materialises the entry's bytes, charged against `budget`.
   *
   * Carried by zip entries only: `yauzl` hands out a stream per entry and the
   * central directory is still open, so the bytes can be read after the walk.
   * `tar` cannot re-open an entry, so tar entries have no `read` — their bytes
   * are written by `writeTarSelection`'s own streaming pass.
   */
  read?(budget: ExpansionBudget): Promise<Buffer>;
};

export type ArchiveContents = {
  readonly entries: readonly ArchiveEntry[];
  /** Entries the archive holds, which may exceed `entries.length`. */
  readonly totalEntries: number;
  /** True when the entry ceiling cut the container short. */
  readonly truncated: boolean;
  /**
   * Releases the parser's handle. A zip's `ZipFile` must outlive every
   * `entry.read`, so the reader that opened it closes it here once the
   * operation is done; the tar half has nothing to release.
   */
  readonly close?: () => void;
};

/**
 * Byte budget shared by every entry in one operation, so neither the
 * per-entry ratio ceiling nor the total cap can be sidestepped by splitting a
 * bomb across many entries.
 */
export type ExpansionBudget = { remaining: number };

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Ported from `assertSafeZipEntry` in `deployed-website-source.ts`, widened from
 * zip to every container: no NUL, not absolute on any platform, no `..`
 * segment, and no Windows drive letter.
 *
 * Two deliberate differences from the sibling, both about not refusing archives
 * that are not attacks:
 *
 *   * A `.` segment is *dropped* rather than refused. `tar cf x.tar .` and
 *     `zip -r x.zip .` put `./` on every single member, so the sibling's rule
 *     would make the most common tarball in existence unreadable. A `.` cannot
 *     escape anything — `resolve` collapses it — and the traversal that matters,
 *     `..`, stays refused.
 *   * A name that normalises away to nothing (`./`, `.`) is reported as a *root
 *     marker* rather than as a refusal, because it is the container saying
 *     "this archive is rooted here", not content. Counting it as refused would
 *     mark every such archive truncated.
 *
 * The drive-letter clause is the one `win32.isAbsolute` does not cover on its
 * own — it accepts `C:\x` but not the drive-relative `C:x`, which resolves to
 * that drive's current directory on Windows.
 */
export type NormalizedName =
  | { readonly path: string }
  | { readonly root: true }
  | { readonly reason: string };

/** A normalised name resolved into what an entry should carry. */
export type NameVerdict = {
  readonly path?: string;
  readonly reason?: string;
  readonly drop?: boolean;
};

// ---------------------------------------------------------------------------
// The tar parser
// ---------------------------------------------------------------------------

/**
 * `tar`, loaded through `require` and typed here.
 *
 * Only the parser stream is used, so the shape below is what this module calls
 * rather than the library's whole option surface.
 */
export type TarParserRecord = NodeJS.ReadableStream & {
  readonly path: string;
  readonly type: string;
  readonly size: number;
};

/**
 * tar's warning surface is inconsistent: some paths hand the code over as an
 * object, others as the bare code string, so both are read.
 */
export type TarParserWarning =
  string | { readonly code?: string; readonly message?: string };

export type TarParserStream = {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end" | "close", listener: () => void): void;
  end(buffer: Buffer): void;
};

export type TarParserModule = {
  t(options: {
    readonly onentry: (record: TarParserRecord) => void;
    readonly onwarn: (warning: TarParserWarning) => void;
  }): TarParserStream;
};
