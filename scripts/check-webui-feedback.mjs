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
// It counts every announcement channel, not only `role="alert"`. A surface that
// writes its own `aria-live` region or its own `role="status"` is the same
// escape as one that writes its own alert — it announces without the family
// deciding how, when and how loudly — and a gate that watched only the alert
// let nine of them through.
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

/**
 * The announcement channels a caller may not author for itself.
 *
 * Each is a way of telling a screen reader that something changed. The shared
 * family owns all of them: `FeedbackError` announces an error, `FeedbackBusy` and
 * `FeedbackSkeleton` announce a status, `FeedbackProgress` carries a value, and
 * `FeedbackAnnouncement` and `FeedbackLiveRegion` announce a message quietly.
 */
export const ANNOUNCEMENT_CHANNELS = [
  'role="alert"',
  'role="status"',
  'role="log"',
  'role="progressbar"',
  "aria-live",
];

/**
 * Surfaces that must keep their own alert, with the reason.
 *
 * Both render when the client has already failed: the boundary catches a render
 * error, the fallback renders when the app never mounted. Reaching for the shared
 * family from there would make the last resort depend on the thing that broke.
 */
const EXEMPT = {
  "shell/WebuiErrorBoundary.tsx": "the last-resort boundary around the whole client",
  "shell/StartupFallback.tsx": "renders when the client never mounted",
};

/**
 * How many places in one source author an announcement.
 *
 * Comments are stripped first: a file that *explains* why its alert is there does
 * not thereby author another one, and counting prose made the budget drift.
 */
export function scanSource(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  return countChannels(code).total;
}

/**
 * The announcement channels one source authors, per channel.
 *
 * `role="alertdialog"` is not `role="alert"`: the closing quote is part of the
 * pattern, so a dialog role does not read as an alert.
 */
export function countChannels(code) {
  const counts = {};
  let total = 0;
  for (const channel of ANNOUNCEMENT_CHANNELS) {
    // The channel names carry their own quotes, so a literal match already
    // tells `role="alert"` from `role="alertdialog"`.
    const pattern =
      channel === "aria-live"
        ? /aria-live\s*=\s*["'{]/gu
        : new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu");
    const found = (code.match(pattern) ?? []).length;
    if (found > 0) counts[channel] = found;
    total += found;
  }
  return { total, counts };
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
    // An exemption is a surface that must not depend on the family: the shell's
    // error boundary and startup fallback render when the client itself failed, so
    // they carry their own alert on purpose. Exempt does not mean free — the count
    // still may not grow.
    const exemption = budget.exempt?.[file];
    if (exemption !== undefined) {
      const count = scanned[file] ?? 0;
      const allowed = budget.files?.[file] ?? 0;
      if (count > allowed) problems.push(`${file}: ${count} announcement channel(s), exempted at ${allowed} — an exemption is not room to grow`);
      continue;
    }
    const count = scanned[file] ?? 0;
    const recorded = budget.files?.[file] ?? 0;

    if (count > recorded) {
      problems.push(`${file}: ${count} announcement channel(s), budget says ${recorded} — adopt the shared feedback family`);
    }
    if (count < recorded) {
      problems.push(`${file}: ${count} announcement channel(s) left, budget says ${recorded} — lower the entry`);
    }
  }

  return problems;
}

/** Every client source that authors an announcement, with its count. */
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

/** Every client source that authors an announcement, with the channels it authors. */
export async function scanClientByChannel(root = clientRoot) {
  const scanned = {};
  for await (const entry of glob("**/*.tsx", { cwd: root })) {
    const relative = entry.split(path.sep).join("/");
    if (ALLOWED.has(relative)) continue;
    const code = readFileSync(path.join(root, entry), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    const { counts } = countChannels(code);
    if (Object.keys(counts).length > 0) scanned[relative] = counts;
  }
  return scanned;
}

async function main() {
  const write = process.argv.includes("--write");
  const scanned = await scanClient();

  if (write) {
    // Exempt files stay in the list with the count they are allowed: an exemption
    // that allowed nothing would be indistinguishable from a mistake.
    const files = Object.fromEntries(Object.entries(scanned).sort(([a], [b]) => a.localeCompare(b)));
    const total = Object.values(files).reduce((sum, count) => sum + count, 0);
    const byChannel = await scanClientByChannel();
    const channelTotals = {};
    for (const counts of Object.values(byChannel)) {
      for (const [channel, count] of Object.entries(counts)) {
        channelTotals[channel] = (channelTotals[channel] ?? 0) + count;
      }
    }
    const payload = {
      $comment:
        "Business sources that still author their own announcement. The count may only go down: `pnpm check:webui-feedback` fails when a file starts authoring one, and when a migration lands without lowering the entry. Regenerate with --write after a migration.",
      channels: ANNOUNCEMENT_CHANNELS,
      total,
      byChannel: Object.fromEntries(Object.entries(channelTotals).sort(([a], [b]) => a.localeCompare(b))),
      exempt: EXEMPT,
      files,
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(budgetPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`recorded ${total} announcement channels across ${Object.keys(files).length} sources`);
    for (const [channel, count] of Object.entries(payload.byChannel)) console.log(`  ${channel}: ${count}`);
    return;
  }

  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const problems = compareFeedback(scanned, budget);
  const total = Object.values(scanned).reduce((sum, count) => sum + count, 0);
  console.log(`business-authored announcements: ${total} across ${Object.keys(scanned).length} sources (budget ${budget.total})`);

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
