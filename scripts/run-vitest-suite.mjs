import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { suiteFiles, repositoryRoot } from "./lib/vitest-suites.mjs";

const require = createRequire(import.meta.url);
const name = process.argv[2];
if (!name) throw new Error("Usage: node scripts/run-vitest-suite.mjs <suite>");
const files = suiteFiles(repositoryRoot, name);
const manifestPath = require.resolve("vitest/package.json");
const cli = path.resolve(path.dirname(manifestPath), require(manifestPath).bin.vitest);
// Windows runners expose TEMP through an 8.3 alias (RUNNER~1). Native
// fs.watch can abort inside libuv when events use the corresponding long path:
// https://github.com/libuv/libuv/issues/5010. Keep real filesystem watching in
// the tests, but create their temporary fixtures beneath the canonical path.
const environment = { ...process.env };
// Product copy follows the host locale, but tests assert a deliberate default
// language and cover localized rendering through explicit locale inputs. Pin
// every locale source before Vitest starts so both workers and subprocesses are
// deterministic on developer machines and in CI.
environment.LANG = "C";
environment.LANGUAGE = "C";
environment.LC_ALL = "C";
environment.LC_MESSAGES = "C";
if (process.platform === "win32") {
  environment.TEMP = environment.TMP = realpathSync.native(tmpdir());
}
const result = spawnSync(
  process.execPath,
  [
    cli,
    "run",
    "--config",
    "vitest.oss.config.mjs",
    // These suites create many SQLite databases and watched directories. On
    // Windows, concurrent files can exhaust the 5s test budget through I/O
    // contention. The WebUI group drives real browsers as well: two of its
    // files launch a browser of their own, and two browsers on one runner
    // take the machine from each other. The case that drives the browser
    // panel then runs past its own deadline — a failure that says nothing
    // about the code under test. Serialize the files rather than relax any
    // deadline: every file gets the machine to itself, and the deadlines stay
    // the ones the cases were written against.
    ...(process.platform === "win32" || name === "webui" ? ["--maxWorkers", "1"] : []),
    ...files,
  ],
  { stdio: "inherit", cwd: repositoryRoot, env: environment },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
