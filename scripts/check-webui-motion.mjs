#!/usr/bin/env node
// Every duration and keyframe in the client's stylesheets is a named motion
// family or a recorded distinct effect (ADR 0028 § Shared contracts, #284).
//
// The check reads the stylesheets and the inventory and compares them in both
// directions: a duration or keyframe the inventory does not know fails, and a
// recorded entry that has stopped appearing fails, so the inventory describes
// the stylesheets rather than an idea of them.
//
// What it proves: every timing value has an owner. What it does not prove: that
// the recorded family is the right one, or that a surface actually looks right
// while it moves — the browser check in `motion.spec.mjs` measures that.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const clientRoot = path.join(repoRoot, "packages/webui/src/client");
const inventoryPath = path.join(repoRoot, "packages/webui/docs/design/motion-inventory.json");

const DURATION = /(?<![\w-])(\d*\.?\d+)(ms|s)\b/u;
const TIMING_RULE = /(?:transition|animation)(?:-duration)?\s*:[^;]+;/gu;
const KEYFRAMES = /@keyframes\s+([A-Za-z0-9_-]+)/gu;

/** Every duration a stylesheet uses in a transition or an animation. */
export function scanStylesheet(text) {
  const durations = new Set();
  for (const rule of text.match(TIMING_RULE) ?? []) {
    for (const match of rule.matchAll(new RegExp(DURATION, "gu"))) {
      durations.add(`${match[1]}${match[2]}`);
    }
  }
  return { durations: [...durations].sort(), keyframes: [...new Set([...text.matchAll(KEYFRAMES)].map((m) => m[1]))].sort() };
}

/**
 * The differences between the stylesheets and the inventory, in both directions.
 *
 * `adopted` must equal the token value it names: an entry that says "feedback"
 * while carrying 200ms is a distinct effect wearing a family's name, and that is
 * exactly the drift this check exists to catch.
 */
export function compareMotion(scannedByFile, inventory) {
  const tokens = inventory.tokens ?? {};
  const problems = [];
  const files = new Set([...Object.keys(scannedByFile), ...Object.keys(inventory.files ?? {})]);

  for (const file of [...files].sort()) {
    const scanned = scannedByFile[file] ?? { durations: [], keyframes: [] };
    const recorded = inventory.files?.[file] ?? { durations: [], keyframes: [] };

    const knownDurations = new Map((recorded.durations ?? []).map((entry) => [entry.value, entry]));
    for (const value of scanned.durations) {
      const entry = knownDurations.get(value);
      if (!entry) problems.push(`${file}: ${value} is not in the motion inventory`);
      else if (entry.family !== "distinct" && tokens[entry.family] !== value) {
        problems.push(`${file}: ${value} claims ${entry.family} but that token is ${tokens[entry.family] ?? "(missing)"}`);
      }
    }
    for (const [value, entry] of knownDurations) {
      if (!scanned.durations.includes(value)) problems.push(`${file}: recorded ${value} no longer appears`);
      if (entry.family === "distinct" && !entry.reason) problems.push(`${file}: ${value} is recorded as distinct with no reason`);
    }

    const knownKeyframes = new Map((recorded.keyframes ?? []).map((entry) => [entry.name, entry]));
    for (const name of scanned.keyframes) {
      const entry = knownKeyframes.get(name);
      if (!entry) problems.push(`${file}: @keyframes ${name} is not in the motion inventory`);
      else if (entry.family === "distinct" && !entry.reason) problems.push(`${file}: @keyframes ${name} is distinct with no reason`);
    }
    for (const name of knownKeyframes.keys()) {
      if (!scanned.keyframes.includes(name)) problems.push(`${file}: recorded @keyframes ${name} no longer appears`);
    }
  }

  return problems;
}

/** Every stylesheet in the client, keyed by its path under `src/client`. */
export async function scanClient(root = clientRoot) {
  const scanned = {};
  for await (const entry of glob("**/*.css", { cwd: root })) {
    const text = readFileSync(path.join(root, entry), "utf8");
    const result = scanStylesheet(text);
    if (result.durations.length === 0 && result.keyframes.length === 0) continue;
    scanned[entry.split(path.sep).join("/")] = result;
  }
  return scanned;
}

async function main() {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const scanned = await scanClient();
  const problems = compareMotion(scanned, inventory);
  const durations = Object.values(scanned).reduce((sum, entry) => sum + entry.durations.length, 0);
  const keyframes = Object.values(scanned).reduce((sum, entry) => sum + entry.keyframes.length, 0);

  console.log(`scanned ${Object.keys(scanned).length} stylesheets: ${durations} durations, ${keyframes} keyframes`);
  console.log(`families: ${Object.keys(inventory.families ?? {}).join(", ")}`);
  const distinct = Object.values(inventory.files ?? {}).reduce(
    (sum, entry) => sum + (entry.durations ?? []).filter((each) => each.family === "distinct").length,
    0,
  );
  console.log(`distinct effects with a recorded reason: ${distinct}`);

  if (problems.length > 0) {
    console.error(`\nmotion inventory is out of date (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("every duration and keyframe has a named family or a recorded reason");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
