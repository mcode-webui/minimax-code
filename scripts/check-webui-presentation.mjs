// Presentation-coverage gate for the WebUI client (ADR 0028).
//
// The check reads `scripts/lib/webui-presentation-inventory.json`, discovers
// every client UI source module on disk, and fails when a module is not
// classified, when an entry names a module that no longer exists, or when an
// entry's disposition, kind or family list is invalid.
//
// A change to a classified module's rendered vocabulary is reported, not
// failed: the ADR admits that the gate cannot see a surface added inside an
// already classified module, so the reviewer is told which modules moved.
// `--accept-review` records the current signature for the reported modules and
// changes nothing else — the classification itself is only ever a reviewed
// edit.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CLIENT_SOURCE_DIRECTORY,
  INVENTORY_FILE,
  discoverPresentationModules,
  evaluatePresentationCoverage,
  parseInventory,
  recordReviewedSignatures,
  serializeInventory,
  sharedHomeValueImports,
  surfaceSignature,
} from "./lib/webui-presentation-coverage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    "accept-review": { type: "boolean", default: false },
    inventory: { type: "string" },
    "client-root": { type: "string" },
  },
  allowPositionals: true,
});

const inventoryPath = path.resolve(root, values.inventory ?? INVENTORY_FILE);
const clientRoot = path.resolve(root, values["client-root"] ?? path.join(CLIENT_SOURCE_DIRECTORY));

const modules = discoverPresentationModules(clientRoot).map((relativePath) => {
  const source = readFileSync(path.join(clientRoot, relativePath), "utf8");
  return {
    path: relativePath,
    signature: surfaceSignature(source, relativePath),
    sharedHomeValues: sharedHomeValueImports(source, relativePath),
  };
});

const inventory = parseInventory(readFileSync(inventoryPath, "utf8"));
const { failures, reviews, summary } = evaluatePresentationCoverage({ modules, inventory });

if (values["accept-review"]) {
  if (failures.length > 0) {
    process.stderr.write(
      "check:webui-presentation: cannot accept a review while the classification fails\n",
    );
    process.exit(1);
  }
  const next = recordReviewedSignatures(
    inventory,
    modules,
    reviews.map((review) => review.path),
  );
  writeFileSync(inventoryPath, serializeInventory(next), "utf8");
  process.stdout.write(
    `check:webui-presentation: recorded ${reviews.length} reviewed module signature(s)\n`,
  );
  process.exit(0);
}

if (values.json) {
  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, summary, failures, reviews }, null, 2)}\n`);
} else {
  const lines = ["WebUI presentation coverage check"];
  lines.push(
    `  scanned ${summary.modules} client UI modules; ${summary.entries} entries classify ${summary.classifiedModules}`,
  );
  lines.push(
    `  dispositions: existing shared contract ${summary.dispositions["existing-shared-contract"]}, newly adopted ${summary.dispositions["newly-adopted-contract"]}, business exception ${summary.dispositions["business-exception"]}, pending ${summary.dispositions["pending-contract-decision"]}`,
  );
  lines.push(
    `  families: ${Object.entries(summary.families)
      .map(([family, count]) => `${family} ${count}`)
      .join(", ")}`,
  );
  lines.push(
    `  inventory complete: ${summary.inventoryComplete ? "yes" : "no"} (every client UI module is classified)`,
  );
  // The gate proves the inventory, not the unification: a zero pending count is
  // necessary and not sufficient, and #294's coverage review confirms the rest.
  lines.push(
    summary.unificationComplete
      ? "  unification: no pending contract decision — confirmed by the coverage review, not by this check"
      : `  unification: incomplete — ${summary.pending} entries carry a pending contract decision`,
  );
  if (failures.length) {
    lines.push("");
    lines.push(`FAILURES (${failures.length}):`);
    for (const failure of failures) lines.push(`  [${failure.kind}] ${failure.path} — ${failure.detail}`);
  }
  if (reviews.length) {
    lines.push("");
    lines.push(
      `REVIEW REQUIRED (${reviews.length}) — classified, but its rendered vocabulary changed; review the change, then run with --accept-review:`,
    );
    const shown = reviews.slice(0, 25);
    for (const review of shown) lines.push(`  ${review.path} — ${review.detail}`);
    if (reviews.length > shown.length) {
      lines.push(`  … and ${reviews.length - shown.length} more`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

process.exit(failures.length === 0 ? 0 : 1);
