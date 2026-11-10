import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const watcherModule = path.join(
  repoRoot,
  "packages/agent-modules/skills/src/directory-watcher.ts",
);

/**
 * The child subscribes to the directory and writes into it.
 *
 * The watch and the write have to disagree about how the path is spelled,
 * because that is the whole defect: on Windows the filesystem reports a
 * changed file under its long name, and libuv compares that name against the
 * directory string it was given. Watching the 8.3 short alias and writing
 * through the long path makes the two names differ, and libuv's own
 * assertion (`!_wcsnicmp(filename, dir, dirlen)`) aborts the process.
 *
 * The child runs in its own process on purpose: that assertion is not a
 * catchable error, it takes the whole process down. Isolating it here means
 * a regression is a failed assertion instead of a dead test worker.
 */
const CHILD = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { subscribeToSkillDirectory } = await import(process.argv[2]);

const directory = process.argv[3];
// Ask Windows for the 8.3 alias of the directory. The path is passed to cmd
// without quotes: an embedded quote is mangled by the way a Windows child
// process receives its command line, and the alias is then spelled wrong.
let watchPath = directory;
if (process.platform === "win32" && !directory.includes(" ")) {
  try {
    watchPath = execFileSync(
      "cmd.exe",
      ["/d", "/c", \`for %I in (\${directory}) do @echo %~sI\`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    watchPath = directory;
  }
}

let changed = false;
const subscription = subscribeToSkillDirectory(
  { targetPath: watchPath, dev: 0, ino: 0 },
  { onChange: () => { changed = true; }, onError: () => {} },
);
writeFileSync(join(directory, "probe.md"), "probe");
const deadline = Date.now() + 8000;
while (!changed && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
subscription.close();
process.stdout.write(JSON.stringify({ watchPath, directory, changed }));
process.exit(changed ? 0 : 3);
`;

describe("the skill directory watcher", () => {
  it("reports a change when the watch and the write spell the path differently", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "skills-watcher-"));
    const childPath = path.join(scratch, "child.mts");
    writeFileSync(childPath, CHILD, "utf8");

    let stdout = "";
    let status: number | null = null;
    let stderr = "";
    try {
      const result = execFileSync(
        process.execPath,
        ["--import", "tsx", childPath, `file:///${watcherModule.replace(/\\/gu, "/")}`, scratch],
        { cwd: repoRoot, encoding: "utf8", timeout: 40_000 },
      );
      stdout = result;
      status = 0;
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? null;
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? "";
    }

    expect(
      { status, stdout, stderr },
      `the child must survive and report the change; stderr was:\n${stderr}`,
    ).toMatchObject({ status: 0 });
    expect(JSON.parse(stdout).changed).toBe(true);
  });
});
