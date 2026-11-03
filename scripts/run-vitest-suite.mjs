import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { suiteFiles, repositoryRoot } from "./lib/vitest-suites.mjs";

const require = createRequire(import.meta.url);
const names = process.argv.slice(2);
if (names.length === 0) throw new Error("Usage: node scripts/run-vitest-suite.mjs <suite> [<suite>...]");
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

// Groups whose files launch a browser of their own or drive the production
// host. Two browsers on one runner take the machine from each other, and the
// case that drives the browser panel then runs past its own deadline — a
// failure that says nothing about the code under test. Those files run one at a
// time, and every deadline stays the one the case was written against.
//
// Everything else in a group is independent file-level work: no shared fixture,
// no shared port. One worker per spare core pair keeps a developer machine busy
// without starving the files that do spawn a process.
const serialGroups = new Set(["webui-host"]);
const parallelWorkers = String(Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2))));

function workerBudget(name) {
  // These suites create many SQLite databases and watched directories. On
  // Windows, concurrent files can exhaust the 5s test budget through I/O
  // contention.
  if (process.platform === "win32") return "1";
  return serialGroups.has(name) ? "1" : parallelWorkers;
}

let status = 0;
for (const name of names) {
  const files = suiteFiles(repositoryRoot, name);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "run",
      "--config",
      "vitest.oss.config.mjs",
      "--maxWorkers",
      workerBudget(name),
      ...files,
    ],
    { stdio: "inherit", cwd: repositoryRoot, env: environment },
  );
  if (result.error) throw result.error;
  // Keep going after a failed group so one run reports every red file rather
  // than ending at the first group.
  if (status === 0 && result.status !== 0) status = result.status ?? 1;
}
process.exitCode = status;
