// The accessibility scan for the migrated surfaces (ADR 0028 § Accessibility).
//
// The scan answers one question — does a rendered state contain a violation of a
// pinned rule set — and it answers nothing else. A clean scan is not a finding of
// accessibility: keyboard reachability, focus containment and return, motion,
// announcement order and real interaction are verified by rendered interaction
// checks, not by this module, and every report it produces says so.
//
// Two limits are deliberate. A reviewed exception is permitted only when it names
// the rule, the surface and state, a bounded target, the reason, the owner and the
// removal condition; it records known debt or a justified false positive, and it
// does not make the surface accessible. A finding the engine cannot decide
// (`incomplete`) needs a recorded manual disposition, and an unresolved applicable
// finding keeps that state's review from being called complete — it is reported,
// never rounded up to a pass.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";

export const EXCEPTIONS_PATH = fileURLToPath(
  new URL("./accessibility-exceptions.json", import.meta.url),
);

/**
 * The pinned rule set.
 *
 * Pinned by tags rather than by "everything axe knows": a run that silently
 * widens its rule set turns every new upstream rule into a failure nobody
 * reviewed. The package version is pinned in the repository's `package.json`.
 */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** What this scan cannot decide, printed with every report. */
export const SCAN_BOUNDARY = [
  "keyboard reachability, focus containment and focus return",
  "motion and reduced-motion behaviour",
  "announcement order and duplicate announcements",
  "real interaction with the rendered surface",
];

/**
 * The recorded debt: every finding this suite knew about when the check landed.
 *
 * It is a ratchet, not an approval. A finding that is not recorded fails the run,
 * so the surface cannot get worse; a recorded finding that has gone fails it too,
 * so the list cannot quietly stay longer than the debt. The narrow, reviewed
 * exceptions above are the separate mechanism for a finding that is *accepted*
 * (with an owner and a removal condition); this file is what is merely known.
 */
export const BASELINE_PATH = fileURLToPath(
  new URL("./accessibility-baseline.json", import.meta.url),
);

export function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return { version: 1, findings: [] };
  }
}

export function saveBaseline(findings) {
  const deduped = new Map();
  for (const finding of findings) {
    for (const node of finding.nodes) {
      const key = `${finding.rule}|${finding.surface}|${finding.state}|${finding.theme}|${node.stable}`;
      deduped.set(key, {
        rule: finding.rule,
        surface: finding.surface,
        state: finding.state,
        theme: finding.theme,
        target: node.stable,
      });
    }
  }
  const ordered = [...deduped.values()].sort((left, right) =>
    `${left.rule}|${left.surface}|${left.state}|${left.theme}|${left.target}` <
    `${right.rule}|${right.surface}|${right.state}|${right.theme}|${right.target}`
      ? -1
      : 1,
  );
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ version: 1, findings: ordered }, null, 2)}\n`, "utf8");
  return ordered.length;
}

/** Split measured findings into what the recording knows and what it does not. */
export function compareBaseline(recorded, findings) {
  const key = (entry) => `${entry.rule}|${entry.surface}|${entry.state}|${entry.theme}|${entry.target}`;
  const recordedKeys = new Set(recorded.map(key));
  const measured = [];
  for (const finding of findings) {
    for (const node of finding.nodes) {
      measured.push({
        rule: finding.rule,
        surface: finding.surface,
        state: finding.state,
        theme: finding.theme,
        target: node.stable,
      });
    }
  }
  const measuredKeys = new Set(measured.map(key));
  return {
    newFindings: measured.filter((entry) => !recordedKeys.has(key(entry))),
    staleEntries: recorded.filter((entry) => !measuredKeys.has(key(entry))),
  };
}

export function loadExceptions() {
  try {
    return JSON.parse(readFileSync(EXCEPTIONS_PATH, "utf8"));
  } catch {
    return { version: 1, exceptions: [] };
  }
}

/**
 * Scan one rendered state.
 *
 * The whole document is scanned on purpose: the overlays these surfaces render
 * portal into the document body, so scoping the scan to the surface would skip
 * the portal host that holds them.
 */
export async function scanSurface(page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  // One entry per *node*, carrying every selector axe produced for it. A node is
  // reported under both its class and, when it has one, a generated id; splitting
  // those into separate findings would let an exception cover the class and leave
  // the id behind as a second, unreviewable finding.
  const nodesOf = (entry) =>
    entry.nodes.map((node) => {
      const selectors = (node.target ?? []).map((target) => String(target));
      const html = String(node.html ?? "");
      const stripped = selectors
        .map((selector) => selector.replace(/#\\:[a-z0-9]+\\:/giu, "").trim())
        .filter((selector) => selector.length > 0)
        .join(" ");
      // An element whose only selector was a generated id needs an identity from
      // somewhere else, or the recording would key every such defect on the empty
      // string and one entry could hide the next.
      const marker = /class="([^"]+)"/u.exec(html)?.[1]?.split(/\s+/u)[0];
      return {
        selectors,
        stable: stripped.length > 0 ? stripped : (marker ? `.${marker}` : "id-only"),
        html: html.slice(0, 160),
      };
    });
  return {
    violations: results.violations.map((violation) => ({
      rule: violation.id,
      impact: violation.impact ?? "unknown",
      help: violation.help,
      nodes: nodesOf(violation),
    })),
    incomplete: results.incomplete.map((entry) => ({
      rule: entry.id,
      help: entry.help,
      nodes: nodesOf(entry),
    })),
    passes: results.passes.length,
  };
}

function exceptionMatchesNode(exception, { surface, state }, violation, node) {
  if (exception.rule !== violation.rule) return false;
  if (exception.surface !== surface && exception.surface !== "*") return false;
  if (exception.state !== state && exception.state !== "*") return false;
  return node.selectors.some((selector) => selector.includes(exception.target));
}

/**
 * Split the findings into what an exception covers and what it does not.
 *
 * `stale` is the other half of the ratchet: an exception whose finding has gone
 * is rejected, so a temporary exemption cannot outlive the thing it excused.
 */
export function classifyFindings({ surface, state, findings, exceptions }) {
  const applicable = exceptions.filter(
    (exception) => exception.surface === surface && (exception.state === state || exception.state === "*"),
  );
  const unexcepted = findings
    .map((finding) => ({
      ...finding,
      nodes: finding.nodes.filter(
        (node) => !applicable.some((exception) => exceptionMatchesNode(exception, { surface, state }, finding, node)),
      ),
    }))
    .filter((finding) => finding.nodes.length > 0);
  const stale = applicable.filter((exception) =>
    exception.rule === "*"
      ? false
      : !findings.some((finding) => finding.nodes.some((node) => exceptionMatchesNode(exception, { surface, state }, finding, node))),
  );
  return { unexcepted, stale };
}

/** The report every run prints, including the limits of what it proved. */
export function formatReport({ scanned, findings, unexcepted, stale, incomplete }) {
  const lines = ["WebUI accessibility scan (axe-core, pinned rule set)"];
  lines.push(`  states scanned: ${scanned}`);
  lines.push(`  violations: ${findings.length}, unexcepted: ${unexcepted.length}`);
  lines.push(`  exceptions in force: ${new Set(findings.map((finding) => finding.surface)).size === 0 ? 0 : undefined}`);
  lines.push(`  incomplete findings needing a manual disposition: ${incomplete.length}`);
  if (unexcepted.length > 0) {
    lines.push("");
    lines.push("UNEXCEPTED VIOLATIONS:");
    for (const finding of unexcepted) {
      lines.push(`  [${finding.impact}] ${finding.rule} at ${finding.surface}/${finding.state}: ${finding.help}`);
      for (const node of finding.nodes.slice(0, 3)) {
        lines.push(`    ${node.selectors.join(", ")}`);
        if (node.html) lines.push(`      ${node.html}`);
      }
    }
  }
  if (stale.length > 0) {
    lines.push("");
    lines.push("STALE EXCEPTIONS (the finding has gone; delete the entry):");
    for (const exception of stale) lines.push(`  ${exception.rule} ${exception.surface}/${exception.state} ${exception.target}`);
  }
  lines.push("");
  lines.push("This scan does NOT verify:");
  for (const boundary of SCAN_BOUNDARY) lines.push(`  - ${boundary}`);
  return lines.join("\n");
}
