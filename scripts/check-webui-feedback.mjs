#!/usr/bin/env node
// Business-authored feedback surfaces, ratcheted against the shared family
// (ADR 0028 § Shared contracts, #292).
//
// The family exists so that an error is announced once and is addressable, a bar
// carries a value and a spinner does not. Sixty call sites still write their own
// `role="alert"`; the migration cannot land in one pass, and a checklist in a
// ticket is not a mechanism. This is: every file that still authors one is
// recorded, the count may only go down, and a file that starts authoring one
// fails.
//
// What it proves: the list only shrinks and no new surface invents its own. What
// it does not prove: that the recorded ones are the right shape — a browser check
// has to look at the announcement.

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const clientRoot = path.join(repoRoot, "packages/webui/src/client");
const budgetPath = path.join(repoRoot, "scripts/lib/webui-feedback-budget.json");

/** The shared layer itself is where these are allowed, and where nothing else is. */
const ALLOWED = new Set(["ui/feedback.tsx", "ui/field.tsx", "ui/content-page.tsx"]);

/** How many places in one source author an alert or a busy status. */
export function scanSource(text) {
  return (text.match(/role="alert"/gu) ?? []).length;
}

/**
 * The differences between the sources and the budget, in both directions.
 *
 * A file that grew is a new surface inventing its own feedback; a file that shrank
 * is a migration that has landed and whose entry must be lowered, so the budget
 * records today rather than an intention.
 */
export function compareFeedback(scanned, budget) {
  const problems = [];
  const files = new Set([...Object.keys(scanned), ...Object.keys(budget.files ?? {})]);

  for (const file of [...files].sort()) {
    if (ALLOWED.has(file)) continue;
    const count = scanned[file] ?? 0;
    const recorded = budget.files?.[file] ?? 0;

    if (count > recorded) {
      problems.push(`${file}: ${count} alert(s), budget says ${recorded} — adopt the shared feedback family`);
    }
    if (count < recorded) {
      problems.push(`${file}: ${count} alert(s) left, budget says ${recorded} — lower the entry`);
    }
  }

  return problems;
}

/** Every client source that authors an alert, with its count. */
export async function scanClient(root = clientRoot) {
  const scanned = {};
  for await (const entry of glob("**/*.tsx", { cwd: root })) {
    const relative = entry.split(path.sep).join("/");
    if (ALLOWED.has(relative)) continue;
    const count = scanSource(readFileSync(path.join(root, entry), "utf8"));
    if (count > 0) scanned[relative] = count;
  }
  return scanned;
}

async function main() {
  const write = process.argv.includes("--write");
  const scanned = await scanClient();

  if (write) {
    const files = Object.fromEntries(Object.entries(scanned).sort(([a], [b]) => a.localeCompare(b)));
    const total = Object.values(files).reduce((sum, count) => sum + count, 0);
    const payload = {
      $comment:
        "Business sources that still author their own role=\"alert\". The count may only go down: `pnpm check:webui-feedback` fails when a file starts authoring one, and when a migration lands without lowering the entry. Regenerate with --write after a migration.",
      total,
      files,
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(budgetPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`recorded ${total} alerts across ${Object.keys(files).length} sources`);
    return;
  }

  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const problems = compareFeedback(scanned, budget);
  const total = Object.values(scanned).reduce((sum, count) => sum + count, 0);
  console.log(`business-authored alerts: ${total} across ${Object.keys(scanned).length} sources (budget ${budget.total})`);

  if (problems.length > 0) {
    console.error(`\nfeedback budget is out of date (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("no surface added its own feedback, and no migration went unrecorded");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
