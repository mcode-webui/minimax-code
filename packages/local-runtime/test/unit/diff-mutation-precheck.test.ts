// D-1 — the revert/reapply snapshot mutation is all-or-nothing, and it refuses
// paths outside the workspace.
//
// Two real defects, both in `applyLocalTurnDiffSnapshotMutation`:
//
//  1. No containment check. `normalizeCapturePath` hands back the *absolute*
//     path for anything resolving outside the workspace — that return is how
//     the capture layer records out-of-workspace writes — and the mutation
//     accepted it via `safeCapturedPath`, so a revert/reapply would write or
//     `fs.rm` a file outside the workspace.
//  2. The checks sat inside the write loop. A refused entry left the run
//     half-applied: earlier entries were already written or removed when a
//     later one was judged unsafe or un-snapshottable.
//
// The fix resolves and validates every target in a full precheck before the
// first write. The fixtures below are built so the OLD code reaches the write
// loop (the conflict precheck passes, because the on-disk contents match the
// `after` hashes), which is what makes "the first file is untouched" a real
// assertion rather than a vacuous one: with the checks back inside the loop,
// the first file is written before the second is refused.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  LocalTurnDiffRecord,
  LocalTurnDiffSnapshotEntry,
  LocalTurnDiffUndoEntry,
} from '../../src/persistence/ports.js';
import { applyLocalTurnDiffSnapshotMutation } from '../../src/turns/file-changes.js';

let root: string;
let workspaceDir: string;
let outsidePath: string;

/** The hash `snapshotCapturedFile` computes for a small text file. */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function snapshot(file: string, content: string): LocalTurnDiffSnapshotEntry {
  return { file, exists: true, hash: contentHash(content), content };
}

/** A snapshot for a file the capture layer could not read (oversized/binary):
 *  it exists, but there is no content to restore. */
function unreadableSnapshot(file: string): LocalTurnDiffSnapshotEntry {
  return { file, exists: true, oversized: true };
}

function undoEntry(
  file: string,
  before: LocalTurnDiffSnapshotEntry,
  after: LocalTurnDiffSnapshotEntry,
): LocalTurnDiffUndoEntry {
  return { file, before, after };
}

function record(undo: readonly LocalTurnDiffUndoEntry[]): LocalTurnDiffRecord {
  return {
    changeSetId: 'changes-1',
    sessionId: 'test-session',
    turnId: 'turn-1',
    workspaceDir,
    capturedAtMs: 1_700_000_000_000,
    status: 'active',
    fileChanges: [],
    undo: [...undo],
    undoable: true,
  };
}

async function read(file: string): Promise<string> {
  return readFile(path.join(workspaceDir, file), 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mcode-diff-precheck-'));
  workspaceDir = path.join(root, 'workspace');
  outsidePath = path.join(root, 'outside.ts');
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, 'one.ts'), 'one-v1');
  await writeFile(path.join(workspaceDir, 'two.ts'), 'two-v1');
  await writeFile(outsidePath, 'outside-v1');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 4 });
});

describe('applyLocalTurnDiffSnapshotMutation precheck', () => {
  it('refuses a second entry resolving outside the workspace and touches nothing', async () => {
    // The reported defect: the relative path resolves to `root/outside.ts`,
    // one level above the workspace. The conflict precheck passes (the disk
    // contents match the `after` hashes), so the OLD code reached the write
    // loop, wrote `one.ts`, and then acted on the out-of-workspace path.
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry('one.ts', snapshot('one.ts', 'one-v0'), snapshot('one.ts', 'one-v1')),
        undoEntry(
          path.relative(workspaceDir, outsidePath),
          snapshot(outsidePath, 'outside-v0'),
          snapshot(outsidePath, 'outside-v1'),
        ),
      ]),
      'revert',
    );

    expect(result).toEqual({ success: false, reason: 'unsafe_path' });
    // All-or-nothing: the first file is still its post-turn content, and the
    // file outside the workspace was neither written nor removed.
    expect(await read('one.ts')).toBe('one-v1');
    expect(await readFile(outsidePath, 'utf8')).toBe('outside-v1');
  });

  it('refuses an absolute path outside the workspace even when it is spelled absolutely', async () => {
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry('one.ts', snapshot('one.ts', 'one-v0'), snapshot('one.ts', 'one-v1')),
        undoEntry(outsidePath, snapshot(outsidePath, 'outside-v0'), snapshot(outsidePath, 'outside-v1')),
      ]),
      'revert',
    );

    expect(result).toEqual({ success: false, reason: 'unsafe_path' });
    expect(await read('one.ts')).toBe('one-v1');
    expect(await readFile(outsidePath, 'utf8')).toBe('outside-v1');
  });

  it('refuses the in-workspace paths the capture layer filters, as before', async () => {
    // `.git/` and `.harness-def/` normalize to `undefined` — the pre-existing
    // refusal, kept: a revert must never write repository internals. Both
    // snapshots are absent so the conflict precheck passes on the old code
    // too, which is what makes this a behaviour-preserving assertion rather
    // than one that only the new order can satisfy.
    //
    // Note on scope: the filter set on this baseline is exactly `.git` and
    // `.harness-def` (plus `<app-dir>/plans|handoffs`). `node_modules` is NOT
    // filtered here, so a `node_modules` entry is a contained path and the
    // mutation treats it like any other — widening the capture filter is a
    // separate decision this change does not make.
    for (const file of ['.git/config', '.harness-def/state.json']) {
      const result = await applyLocalTurnDiffSnapshotMutation(
        record([undoEntry(file, { file, exists: false }, { file, exists: false })]),
        'revert',
      );
      expect(result).toEqual({ success: false, reason: 'unsafe_path' });
    }
    expect(await read('one.ts')).toBe('one-v1');
  });

  it('refuses an un-snapshottable second entry before writing the first', async () => {
    // The second half of the all-or-nothing defect: the second entry exists
    // but has no content to restore. The conflict precheck passes (its `after`
    // matches the disk), so the OLD code wrote `one.ts` and only then
    // refused — leaving the half-applied state the user was never told about.
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry('one.ts', snapshot('one.ts', 'one-v0'), snapshot('one.ts', 'one-v1')),
        undoEntry('two.ts', unreadableSnapshot('two.ts'), snapshot('two.ts', 'two-v1')),
      ]),
      'revert',
    );

    expect(result).toEqual({ success: false, reason: 'not_undoable' });
    expect(await read('one.ts')).toBe('one-v1');
    expect(await read('two.ts')).toBe('two-v1');
  });

  it('still refuses a conflicted entry before writing anything', async () => {
    // The pre-existing conflict precheck, preserved: the second entry's
    // post-turn hash no longer matches the disk, so nothing is written.
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry('one.ts', snapshot('one.ts', 'one-v0'), snapshot('one.ts', 'one-v1')),
        undoEntry('two.ts', snapshot('two.ts', 'two-v0'), snapshot('two.ts', 'two-drifted')),
      ]),
      'revert',
    );

    expect(result).toEqual({ success: false, reason: 'conflict' });
    expect(await read('one.ts')).toBe('one-v1');
    expect(await read('two.ts')).toBe('two-v1');
  });

  it('applies a fully safe revert and reapply, including a deleted file', async () => {
    // The happy path, so the precheck is not a refusal machine. The turn
    // deleted `gone.ts` (its `after` is `exists: false`, and the disk agrees),
    // so revert recreates it from `before`; reapply then sees the disk back at
    // the `before` state and removes it again.
    const entries = [
      undoEntry('one.ts', snapshot('one.ts', 'one-v0'), snapshot('one.ts', 'one-v1')),
      undoEntry('gone.ts', snapshot('gone.ts', 'gone-v0'), { file: 'gone.ts', exists: false }),
    ];

    const reverted = await applyLocalTurnDiffSnapshotMutation(record(entries), 'revert');
    expect(reverted).toEqual({ success: true });
    expect(await read('one.ts')).toBe('one-v0');
    expect(await read('gone.ts')).toBe('gone-v0');

    const reapplied = await applyLocalTurnDiffSnapshotMutation(record(entries), 'reapply');
    expect(reapplied).toEqual({ success: true });
    expect(await read('one.ts')).toBe('one-v1');
    await expect(readFile(path.join(workspaceDir, 'gone.ts'), 'utf8')).rejects.toThrow();
  });

  it('reverts a file in a nested directory', async () => {
    // The precheck resolves the absolute target; a nested relative path is
    // contained and reverts like any other.
    await mkdir(path.join(workspaceDir, 'nested', 'deep'), { recursive: true });
    await writeFile(path.join(workspaceDir, 'nested', 'deep', 'file.ts'), 'file-v1');
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry(
          'nested/deep/file.ts',
          snapshot('nested/deep/file.ts', 'file-v0'),
          snapshot('nested/deep/file.ts', 'file-v1'),
        ),
      ]),
      'revert',
    );
    expect(result).toEqual({ success: true });
    expect(await read('nested/deep/file.ts')).toBe('file-v0');
  });

  it('refuses a record with nothing undoable, as before', async () => {
    expect(await applyLocalTurnDiffSnapshotMutation(record([]), 'revert')).toEqual({
      success: false,
      reason: 'not_undoable',
    });
  });

  it('refuses a single entry that resolves outside the workspace', async () => {
    // The out-of-workspace case on its own, not only as the second entry of a
    // longer record. The precheck refuses the run before it reads or writes
    // anything, so the file outside the workspace is left alone.
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry(
          path.relative(workspaceDir, outsidePath),
          snapshot(outsidePath, 'outside-v0'),
          snapshot(outsidePath, 'outside-v1'),
        ),
      ]),
      'revert',
    );

    expect(result).toEqual({ success: false, reason: 'unsafe_path' });
    expect(await readFile(outsidePath, 'utf8')).toBe('outside-v1');
  });

  it('refuses an out-of-workspace entry on the reapply path too', async () => {
    // `revert` and `reapply` are the same operation with the two snapshots
    // swapped, and the containment check reads the entry's path — not the
    // action — so the refusal has to be the same on both.
    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry(
          path.relative(workspaceDir, outsidePath),
          snapshot(outsidePath, 'outside-v0'),
          snapshot(outsidePath, 'outside-v1'),
        ),
      ]),
      'reapply',
    );

    expect(result).toEqual({ success: false, reason: 'unsafe_path' });
    expect(await readFile(outsidePath, 'utf8')).toBe('outside-v1');
  });

  it('refuses a sibling directory whose name starts with the workspace name', async () => {
    // The containment check compares the resolved path against the workspace
    // root, not against the root's name: a plain `startsWith(root)` would
    // accept `root/workspace-other/sibling.ts`, because that string starts
    // with the root's string. The check appends the separator, so the sibling
    // is refused like any other path outside the workspace.
    const siblingDir = path.join(root, 'workspace-other');
    await mkdir(siblingDir, { recursive: true });
    const siblingPath = path.join(siblingDir, 'sibling.ts');
    await writeFile(siblingPath, 'sibling-v1');

    const result = await applyLocalTurnDiffSnapshotMutation(
      record([
        undoEntry(
          path.relative(workspaceDir, siblingPath),
          snapshot(siblingPath, 'sibling-v0'),
          snapshot(siblingPath, 'sibling-v1'),
        ),
      ]),
      'revert',
    );

    expect(result).toEqual({ success: false, reason: 'unsafe_path' });
    expect(await readFile(siblingPath, 'utf8')).toBe('sibling-v1');
  });
});
