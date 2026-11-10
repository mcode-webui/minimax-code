// The browser the browser suites drive.
//
// The repository already knows where a browser lives: the provider's own
// candidate table. These suites read that table instead of keeping a copy of
// it, because a copy is a second truth — and a copy that only knows the Linux
// paths skips the whole suite on a Mac, which is where the coverage quietly
// disappears rather than fails.
//
// The suites still skip themselves when there is no browser: "the browser is
// missing" is not a defect in the provider.

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { defaultChromeCandidates } from "../../src/runtime/browser/isolated-chromium/provider.js";

/**
 * The browser on this machine that can actually be run.
 *
 * A candidate has to be **executable**, not merely present: a directory, or a
 * file without the execute bit, is not a browser, and launching it fails
 * later with a much less useful message.
 */
export async function resolveChromeExecutable(): Promise<string | undefined> {
  for (const candidate of defaultChromeCandidates()) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

/**
 * The browser's own version.
 *
 * Read from the binary rather than assumed: an acceptance record that says
 * "Chrome" without saying which Chrome is not a record.
 */
export function chromeExecutableVersion(path: string): string {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    return "unknown";
  }
}
