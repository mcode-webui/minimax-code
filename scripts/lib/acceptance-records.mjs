// The browser acceptance records, and putting them back.
//
// A record file is tracked: the plan's `complete/` directory is where the
// accepted evidence lives, and the file in the checkout is the record of the
// run that was accepted. A run rewrites it — every record carries the time and
// the machine it ran on — so the working tree is dirty once the suite is over.
//
// That dirt is not a source change, and the release packaging refuses to run
// with a dirty tree ("Packaging requires a clean committed working tree"), so
// a CI run has to put the records back before it is over.
//
// The restore is git-based, and it restores the committed content of every
// record file. The suites that write a record live in their own processes and
// each of them restores what it wrote from the copy it kept in memory
// (`restoreAcceptanceRecords` in the acceptance-record module); this one does
// not depend on which process wrote what, so a suite that forgot to restore
// its own cannot leave the tree dirty for the packaging step.
//
// Locally the records stay: they are what the run just produced, and the
// published matrix is written from them.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

// The tracked acceptance record files, wherever the plans put them. A plan that
// adds a suite gets its record file covered without this file knowing the
// suite's name.
const RECORD_PATHSPEC = ":(glob).plan/*/complete/*.acceptance.json";

/**
 * Whether this is a CI run.
 *
 * `CI` is the variable the suites already test, and `GITHUB_ACTIONS` is the
 * one the runner always sets; either is enough to say the run's own records
 * are throwaway and the committed ones are the evidence.
 */
function isCi() {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

/**
 * The path as the filesystem sees it.
 *
 * Git answers with the real path, and a checkout reached through a symbolic
 * link — a temporary directory on macOS, for one — is not the same string as
 * the one the caller passed. Comparing the two as written would decide that
 * the checkout is somewhere else, and nothing would be restored.
 */
function realPath(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Whether `root` is the top of a git checkout.
 *
 * An exported source archive has no repository at all, and there is nothing to
 * restore there. A directory that merely happens to sit inside some other
 * repository is worse than that: git would answer for the wrong tree, so the
 * top level has to be this tree before anything is restored.
 */
function isCheckoutRoot(root) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  if (top.status !== 0) return false;
  return realPath(top.stdout.trim()) === realPath(root);
}

/**
 * The acceptance record files this checkout tracks.
 *
 * Read from the index rather than from a list of suite names, so a plan that
 * adds a suite is covered without this file being told about it.
 */
export function acceptanceRecordFiles(root) {
  if (!isCheckoutRoot(root)) return [];
  const listed = spawnSync("git", ["ls-files", "-z", "--", RECORD_PATHSPEC], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.status !== 0) return [];
  return listed.stdout.split("\0").filter((file) => file !== "");
}

/**
 * Puts the acceptance records back the way the checkout had them.
 *
 * On CI only: locally the records are what the run just produced and they are
 * kept. Returns the files it restored.
 */
export function restoreAcceptanceRecords(root) {
  if (!isCi()) return [];
  const files = acceptanceRecordFiles(root);
  if (files.length === 0) return [];
  const restored = spawnSync(
    "git",
    ["restore", "--source=HEAD", "--worktree", "--", ...files],
    { cwd: root, encoding: "utf8" },
  );
  if (restored.status !== 0) {
    throw new Error(
      `Could not restore the acceptance records: ${restored.stderr.trim()}`,
    );
  }
  return files;
}
