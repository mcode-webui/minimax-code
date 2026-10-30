#!/usr/bin/env node
// Every floating layer in the client, inventoried against the overlay
// coordinator (ADR 0028 § Overlay coordination, #290).
//
// A layer is one of:
//   managed        registers with the coordinator and attaches no listener
//   borrows-role   renders `role="dialog"` for labelling but is not a layer
//   exception      cannot join, with its interaction boundary written down
//
// The check scans the client's sources for the two shapes that produce a floating
// layer — a `<WebuiDropdown` and a `role="dialog"` element — and compares them
// with the inventory in both directions. A new dialog or dropdown fails until it
// is classified, and an entry whose source has gone fails too.
//
// What it proves: every floating layer has a decision. What it does not prove:
// that the decision is right, or that a managed layer behaves — the browser suite
// measures the behaviour.

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const clientRoot = path.join(repoRoot, "packages/webui/src/client");
const inventoryPath = path.join(repoRoot, "scripts/lib/webui-overlay-inventory.json");

const DISPOSITIONS = new Set(["managed", "borrows-role", "exception", "pending"]);

/** The floating layers a source file produces. */
export function scanSource(text) {
  const dropdowns = (text.match(/<WebuiDropdown\b/gu) ?? []).length;
  const dialogs = (text.match(/role="dialog"/gu) ?? []).length;
  const managed = (text.match(/\bmanaged\b(?=[=\s>/])/gu) ?? []).length;
  return { dropdowns, dialogs, managed };
}

/**
 * The differences between the sources and the inventory, in both directions.
 *
 * An entry that says `managed` while its source never passes `managed` is the
 * drift this check exists for: the classification would otherwise record an
 * intention rather than the code.
 */
export function compareOverlays(scanned, inventory) {
  const problems = [];
  const files = new Set([...Object.keys(scanned), ...Object.keys(inventory.files ?? {})]);

  for (const file of [...files].sort()) {
    const source = scanned[file] ?? { dropdowns: 0, dialogs: 0, managed: 0 };
    const entry = inventory.files?.[file];

    if (!entry) {
      if (source.dropdowns > 0 || source.dialogs > 0) problems.push(`${file}: has a floating layer but is not inventoried`);
      continue;
    }
    if (!DISPOSITIONS.has(entry.disposition)) {
      problems.push(`${file}: "${entry.disposition}" is not one of ${[...DISPOSITIONS].join(", ")}`);
      continue;
    }
    if (source.dropdowns === 0 && source.dialogs === 0) problems.push(`${file}: inventoried but produces no floating layer`);
    if (entry.disposition === "pending" && entry.reason === undefined) {
      problems.push(`${file}: pending needs the reason it is not migrated yet`);
    }
    if (entry.disposition === "managed" && source.managed === 0) {
      problems.push(`${file}: says managed but no layer registers with the coordinator`);
    }
    if (entry.disposition === "exception" && !entry.boundary) {
      problems.push(`${file}: an exception needs its interaction boundary stated`);
    }
    if (entry.disposition === "managed" && entry.boundary) {
      problems.push(`${file}: a managed surface is not an exception; drop the boundary note`);
    }
  }

  return problems;
}

/** Every client source that can produce a floating layer, keyed by path. */
export async function scanClient(root = clientRoot) {
  const scanned = {};
  for await (const entry of glob("**/*.tsx", { cwd: root })) {
    const text = readFileSync(path.join(root, entry), "utf8");
    const result = scanSource(text);
    if (result.dropdowns === 0 && result.dialogs === 0) continue;
    scanned[entry.split(path.sep).join("/")] = result;
  }
  return scanned;
}

async function main() {
  const strict = process.argv.includes("--strict");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const scanned = await scanClient();
  const problems = compareOverlays(scanned, inventory);

  const files = Object.values(inventory.files ?? {});
  const byDisposition = files.reduce((counts, entry) => {
    counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
    return counts;
  }, {});
  console.log(`scanned ${Object.keys(scanned).length} client sources with a floating layer`);
  for (const [disposition, count] of Object.entries(byDisposition).sort()) {
    console.log(`  ${disposition}: ${count}`);
  }
  const exceptions = files.filter((entry) => entry.disposition === "exception");
  if (exceptions.length > 0) {
    console.log(`  reviewed exceptions: ${exceptions.length} — none of them is evidence that nesting it inside a managed surface is safe`);
  }

  const pending = files.filter((entry) => entry.disposition === "pending");
  console.log(
    pending.length === 0
      ? "migration: complete — every floating layer is managed, excluded or a labelling role"
      : `migration: incomplete — ${pending.length} surfaces still answer their own events`,
  );
  if (strict && pending.length > 0) {
    problems.push(`${pending.length} surfaces are still pending; the compatibility path cannot be removed yet`);
  }

  if (problems.length > 0) {
    console.error(`\noverlay inventory is out of date (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("every floating layer has a recorded decision");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
