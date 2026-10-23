// The real-path fence that keeps a workspace write inside the workspace.
//
// The clauses these pin shut:
//   * a dangling symlink that points outside the workspace is refused, and the
//     file it points at is never created;
//   * a symlink that points inside the workspace keeps working — the fence
//     compares real locations, so an in-workspace link is inside by
//     definition;
//   * a workspace root that is itself a symlink still works;
//   * an ordinary path inside the workspace is accepted;
//   * a symlink cycle is refused rather than followed, and never loops.
//
// The fixtures are real directories and real symlinks in the OS temp dir: the
// bug this fence closes is about what the filesystem does with a link, so a
// mocked one would assert nothing.
//
// The harness half of the file proves the fence runs *before* the runtime is
// asked to write: the host is never called for a path that leaves the
// workspace, so the file it would have created outside cannot appear.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import { checkWorkspaceFence } from "../../src/runtime/workspace-real-path.js";

/** Fixtures live in the OS temp dir; nothing is written into the repo tree. */
let root = "";
let workspace = "";

const layout = { x: 0, y: 0, width: 1, height: 1, zIndex: 0 };

/**
 * The write the fence guards.
 *
 * `writeFile` on the lexical path is what the runtime's workspace writer does:
 * it opens the path as spelled, and the filesystem follows a symlink on the
 * way — creating the file a dangling link points at. The fence decides first;
 * the write itself is unchanged.
 */
async function writeWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = path.resolve(workspaceRoot, relativePath);
  const verdict = await checkWorkspaceFence(workspaceRoot, target);
  if (!verdict.allowed) {
    throw new Error(
      verdict.reason === "outside"
        ? `path escapes the workspace: ${relativePath}`
        : `path cannot be resolved: ${relativePath}`,
    );
  }
  await writeFile(target, content, "utf8");
}

beforeAll(() => {
  // `realpathSync` first: on macOS the temp dir is a symlink, and the fence
  // resolves the workspace root through `realpath`, so an unresolved fixture
  // path would not match what the fence compares against.
  root = mkdtempSync(path.join(realpathSync(tmpdir()), "webui-write-fence-"));
  workspace = path.join(root, "workspace");
  mkdirSync(workspace);
});

afterAll(() => {
  if (root) rmSync(root, { force: true, recursive: true });
});

describe("the workspace write fence", () => {
  it("refuses a dangling symlink that points outside the workspace, and writes nothing outside it", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const planted = path.join(outside, "planted.txt");
    symlinkSync(planted, path.join(workspace, "escape"));

    // The escape is real without the fence: writing through the dangling link
    // creates the file it points at, outside the workspace.
    await writeFile(path.join(workspace, "escape"), "planted", "utf8");
    expect(existsSync(planted)).toBe(true);
    rmSync(planted);

    await expect(
      checkWorkspaceFence(workspace, path.join(workspace, "escape")),
    ).resolves.toEqual({ allowed: false, reason: "outside" });

    await expect(
      writeWorkspaceFile(workspace, "escape", "planted"),
    ).rejects.toThrow("path escapes the workspace: escape");
    expect(existsSync(planted)).toBe(false);
  });

  it("keeps a symlink that points inside the workspace working", async () => {
    writeFileSync(path.join(workspace, "real.txt"), "real", "utf8");
    symlinkSync(
      path.join(workspace, "real.txt"),
      path.join(workspace, "inside-link"),
    );

    await expect(
      checkWorkspaceFence(workspace, path.join(workspace, "inside-link")),
    ).resolves.toEqual({ allowed: true });

    await writeWorkspaceFile(workspace, "inside-link", "written");
    expect(readFileSync(path.join(workspace, "real.txt"), "utf8")).toBe("written");
  });

  it("accepts a workspace root that is itself a symlink", async () => {
    const realRoot = path.join(root, "real-root");
    mkdirSync(realRoot, { recursive: true });
    const linkedRoot = path.join(root, "linked-root");
    symlinkSync(realRoot, linkedRoot);

    await expect(
      checkWorkspaceFence(linkedRoot, path.join(linkedRoot, "note.txt")),
    ).resolves.toEqual({ allowed: true });

    await writeWorkspaceFile(linkedRoot, "note.txt", "hello");
    expect(readFileSync(path.join(realRoot, "note.txt"), "utf8")).toBe("hello");
  });

  it("accepts an ordinary path inside the workspace", async () => {
    await expect(
      checkWorkspaceFence(workspace, path.join(workspace, "plain.txt")),
    ).resolves.toEqual({ allowed: true });

    await writeWorkspaceFile(workspace, "plain.txt", "plain");
    expect(readFileSync(path.join(workspace, "plain.txt"), "utf8")).toBe("plain");
  });

  it("refuses a symlink cycle instead of following it", async () => {
    symlinkSync(path.join(workspace, "cycle-b"), path.join(workspace, "cycle-a"));
    symlinkSync(path.join(workspace, "cycle-a"), path.join(workspace, "cycle-b"));

    await expect(
      checkWorkspaceFence(workspace, path.join(workspace, "cycle-a")),
    ).resolves.toEqual({ allowed: false, reason: "unresolvable" });
  });

  it("refuses a workspace root it cannot resolve", async () => {
    await expect(
      checkWorkspaceFence(
        path.join(root, "missing-root"),
        path.join(root, "missing-root", "file.txt"),
      ),
    ).resolves.toEqual({ allowed: false, reason: "unresolvable" });
  });
});

describe("the harness fences the workspace writes it forwards", () => {
  /** A host that writes the canvas path the way the runtime's writer does. */
  function canvasHost(workspaceDir: string) {
    const applyCanvas = vi.fn(
      async (input: { readonly operation: { readonly mutations: readonly { readonly kind: string; readonly relativePath?: string }[] } }) => {
        for (const mutation of input.operation.mutations) {
          if (mutation.kind !== "add_file" || mutation.relativePath === undefined)
            continue;
          await writeFile(
            path.resolve(workspaceDir, mutation.relativePath),
            "written by the host",
            "utf8",
          );
        }
        return {
          operationId: "op",
          document: {
            schemaVersion: 1 as const,
            canvasId: "canvas",
            sessionId: "s1",
            changeSeq: 1,
            nodes: [],
            updatedAtMs: 1,
          },
        };
      },
    );
    const getSession = vi.fn(async () => ({
      session: { sessionId: "s1", workspaceDir },
    }));
    return { applyCanvas, getSession };
  }

  it("refuses a canvas path that leaves the workspace before the runtime is called", async () => {
    const outside = path.join(root, "canvas-outside");
    mkdirSync(outside, { recursive: true });
    const planted = path.join(outside, "planted.txt");
    symlinkSync(planted, path.join(workspace, "canvas-escape"));

    const { applyCanvas, getSession } = canvasHost(workspace);
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: { applyCanvas, getSession } as never,
    });

    await expect(
      port.applyCanvas({
        sessionId: "s1",
        operation: {
          schemaVersion: 1,
          operationId: "op",
          mutations: [
            { kind: "add_file", nodeId: "n1", relativePath: "canvas-escape", layout },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_body",
      message: "Canvas file path escapes the workspace: canvas-escape",
    });
    expect(applyCanvas).not.toHaveBeenCalled();
    expect(existsSync(planted)).toBe(false);
  });

  it("forwards a canvas path that stays inside the workspace unchanged", async () => {
    const { applyCanvas, getSession } = canvasHost(workspace);
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: { applyCanvas, getSession } as never,
    });

    await port.applyCanvas({
      sessionId: "s1",
      operation: {
        schemaVersion: 1,
        operationId: "op",
        mutations: [
          { kind: "add_file", nodeId: "n1", relativePath: "plain.txt", layout },
        ],
      },
    });
    expect(applyCanvas).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(readFileSync(path.join(workspace, "plain.txt"), "utf8")).toBe(
      "written by the host",
    );
  });

  it("refuses an archive destination that leaves the workspace, and creates nothing outside it", async () => {
    const outside = path.join(root, "archive-outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(workspace, "archive-escape"));

    // The host creates the destination the way the archive reader does:
    // `mkdir -p` on the requested path, which follows a symlinked ancestor.
    const extractWorkspaceArchive = vi.fn(async (request: { readonly workspaceDir: string; readonly destination: string }) => {
      await mkdir(path.resolve(request.workspaceDir, request.destination), {
        recursive: true,
      });
      return { archivePath: request.destination, destination: request.destination, writtenFiles: [] };
    });
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: { extractWorkspaceArchive } as never,
    });

    // The destination names a directory *under* the symlink: creating it with
    // `mkdir -p` would create it outside the workspace, so the fence has to
    // run before the extraction creates anything.
    await expect(
      port.extractWorkspaceArchive({
        workspaceDir: workspace,
        path: "bundle.zip",
        destination: "archive-escape/extracted",
      }),
    ).rejects.toMatchObject({
      code: "invalid_body",
      message: "解压目标越界：archive-escape/extracted",
    });
    expect(extractWorkspaceArchive).not.toHaveBeenCalled();
    expect(existsSync(path.join(outside, "extracted"))).toBe(false);
  });

  it("refuses an archive destination that is itself a symlink out of the workspace", async () => {
    const outside = path.join(root, "archive-outside-direct");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(workspace, "archive-escape-direct"));

    const extractWorkspaceArchive = vi.fn();
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: { extractWorkspaceArchive } as never,
    });

    await expect(
      port.extractWorkspaceArchive({
        workspaceDir: workspace,
        path: "bundle.zip",
        destination: "archive-escape-direct",
      }),
    ).rejects.toMatchObject({
      code: "invalid_body",
      message: "解压目标越界：archive-escape-direct",
    });
    expect(extractWorkspaceArchive).not.toHaveBeenCalled();
  });

  it("forwards an archive destination that stays inside the workspace", async () => {
    const extractWorkspaceArchive = vi.fn(async () => ({
      archivePath: "bundle.zip",
      destination: "out",
      writtenFiles: [],
    }));
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: { extractWorkspaceArchive } as never,
    });

    await port.extractWorkspaceArchive({
      workspaceDir: workspace,
      path: "bundle.zip",
      destination: "out",
    });
    expect(extractWorkspaceArchive).toHaveBeenCalledExactlyOnceWith({
      workspaceDir: workspace,
      path: "bundle.zip",
      destination: "out",
    });
  });
});
