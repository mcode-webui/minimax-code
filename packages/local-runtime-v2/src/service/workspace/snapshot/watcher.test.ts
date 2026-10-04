import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceGitWatcher } from './watcher.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('createWorkspaceGitWatcher', () => {
  it('does not add redundant Git watchers when the workspace watcher already covers a standard repository', async () => {
    const workspace = await createWorkspace();
    const watchedDirectories: Array<{ directory: string; recursive: boolean }> = [];
    const onChange = vi.fn();
    let watchWorkspacePath: ((fileName: string | Buffer | null) => void) | undefined;
    const watcher = await createWorkspaceGitWatcher(
      {
        workspace,
        callbacks: {
          onPotentialChange: vi.fn(),
          onIgnoredOnly: vi.fn(),
          onChange,
          onError: vi.fn(),
        },
        classifyIgnored: async () => false,
      },
      {
        watchDirectory: (directory, recursive, listener) => {
          watchedDirectories.push({ directory, recursive });
          if (directory === workspace) watchWorkspacePath = listener;
          return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
        },
      },
    );

    expect(watchedDirectories).toEqual([{ directory: workspace, recursive: true }]);
    watchWorkspacePath?.('.git/index');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('repository'));
    watcher.close();
  });
});

async function createWorkspace(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'workspace-git-watcher-'));
  temporaryDirectories.push(created);
  // macOS: `tmpdir()` is `/var/folders/...` and `/var` is a symlink to
  // `/private/var`. `mkdtemp` hands back the UNRESOLVED path; the watcher
  // realpaths before it watches, which is the correct behaviour — a filesystem
  // watch on the symlink spelling is not reliably the same inode.
  //
  // Comparing the unresolved path against the resolved one is not only a
  // failing assertion: the helper closure picks the listener with
  // `directory === workspace`, so that comparison never matched, the listener
  // stayed undefined, and the `?.()` call after it silently did nothing. The
  // test was not failing because of a path bug. It was passing over nothing.
  const workspace = await realpath(created);
  await mkdir(join(workspace, '.git', 'refs', 'heads'), { recursive: true });
  await mkdir(join(workspace, '.git', 'info'), { recursive: true });
  return workspace;
}
