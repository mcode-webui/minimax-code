// The plugin action inventory, applied and checked.
//
// `plugins` is sized by its **actions**, not by its port member: `plugin-port.ts` declares two
// members, of which `pluginManagement?` stands in front of 29 union values. The accepted inventory
// (`packages/webui/docs/reference/plugin-action-inventory.md`) is this business's population, and
// each action's business is verified against it — a count of port members is not enough.
//
// So the inventory file is this suite's authority, not a restatement of it: the names are read out of
// the document and compared as a SET against the four places they are carried. A fifth action added
// to any carrier without the document, or a name changed in one place, fails here.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = new URL("../../../../", import.meta.url);
const SRC = new URL("../../src/", import.meta.url);
const CLIENT = new URL("client/", SRC);
const read = (url: URL): string => readFileSync(fileURLToPath(url), "utf8");

/**
 * The source with its comments removed.
 *
 * These cases read source as text, and a file that explains what it stopped
 * doing will name that shape in a comment — the adapter quotes the `as never`
 * dispatch it replaced, and the composer says which props it used to hold. Those
 * are prose, not code, and a scan that counted them would fail on an accurate
 * explanation. Only the code is a constraint.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => (line.includes("://") ? line : line.replace(/\/\/.*$/u, "")))
    .join("\n");

const codeOf = (url: URL): string => stripComments(read(url));

const inventory = read(new URL("packages/webui/docs/reference/plugin-action-inventory.md", REPO));

/** The inventory table's action column: one row per action, numbered. */
const actions = [...inventory.matchAll(/^\|\s*\d+\s*\|\s*`(\w+)`\s*\|/gmu)].map((m) => m[1]!);
/** The rows the inventory records as having no client caller at all. */
const callerless = [...inventory.matchAll(/^\|\s*\d+\s*\|\s*`(\w+)`\s*\|([^|]*)\|/gmu)]
  .filter((m) => /no client caller/u.test(m[2] ?? ""))
  .map((m) => m[1]!);

const unionSrc = read(new URL("shared/plugin-management.ts", SRC));
const union = [...unionSrc.matchAll(/^\s*\|\s*"(\w+)"/gmu)].map((m) => m[1]!);

const serverSrc = read(new URL("server/operation/plugin-management.ts", SRC));
const serverActions = [...serverSrc.matchAll(/^\s*"(\w+)",?$/gmu)].map((m) => m[1]!);

const workflowSrc = read(new URL("features/plugins/application/plugin-workflows.ts", CLIENT));

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("the inventory is the population the carve covers", () => {
  it("enumerates 29 actions, and the union carries exactly those", () => {
    expect(sorted(actions)).toHaveLength(29);
    expect(sorted(union)).toEqual(sorted(actions));
  });

  it("finds the same 29 in the server's two carriers", () => {
    // The server names them twice more (the accepted-action set and the input shapes); the
    // inventory's own counting rule calls these its three witnesses.
    const named = serverActions.filter((name) => actions.includes(name));
    expect(sorted([...new Set(named)])).toEqual(sorted(actions));
  });

  it("is sized by actions, not by port members", () => {
    // The port declares two members: `pluginManagement` carries the 29 actions, and `listSkills`
    // carries the skill catalogue, which is filed under `plugins`. The point of this case is that
    // neither member's COUNT is the size of the business — 2 members, 29 actions — so a carve
    // driven by the member list under-scopes by an order of magnitude.
    const port = read(new URL("features/plugins/contracts/plugin-port.ts", CLIENT));
    const members = [...port.matchAll(/^  readonly (\w+)\??:/gmu)].map((m) => m[1]!);
    expect(members).toEqual(["pluginManagement", "listSkills"]);
    expect(members).toHaveLength(2);
    expect(actions).toHaveLength(29);
    // And the carrier the inventory counts is named as such where it is declared.
    expect(port).toContain("`pluginManagement` carries 29 actions behind its one member");
  });
});

describe("each action's business is the one the inventory records", () => {
  it("is invoked by the plugin owner", () => {
    // `plugins'` owner names every action it publishes. The one exception is the action the
    // inventory records as having no client surface to carve — declaring it beats inventing one.
    // The owner names them through its two dispatch helpers — `call` for reads, `mutate` for
    // writes — so both forms count as naming the action.
    const notInOwner = actions.filter(
      (action) => !new RegExp(`(?:call|mutate)\\(\\s*"${action}"`, "u").test(workflowSrc),
    );
    expect(sorted(notInOwner)).toEqual(sorted(callerless));
    expect(sorted(callerless)).toEqual(["listRuntimeSkills"]);
  });

  it("is reached from no client module outside the plugin business", () => {
    // The allowance is per module and each entry states its reason; a new module reaching this port
    // fails the case rather than passing a count. The composer is NOT on it any more: it used to be
    // the declared reader of `listInstalledPlugins`, dispatching that wire verb from its own effect.
    // It now asks the composer catalogue for installed plugins, so it no longer touches the
    // port at all — the next case says so.
    const allowed = [
      "features/plugins/application/plugin-workflows.ts", // the owner
      "features/plugins/application/composer-catalogue.ts", // the composer-facing read model
      "features/plugins/contracts/plugin-actions.ts", // the typed action adapter
      "application/port-slices.ts", // the slice's cut
      "features/plugins/contracts/plugin-port.ts", // the declaration
      "platform/transport.ts", // the wire
      "shell/WebuiClientFoundationApp.tsx", // the composition root that builds the slice
    ];
    const reach = [..."application contracts platform shell bindings projection".split(" ")]
      .flatMap((layer) => {
        const dir = fileURLToPath(new URL(layer + "/", CLIENT));
        return listFiles(dir).filter((file) => /pluginManagement/u.test(stripComments(readSafe(file))));
      });
    expect(reach.length).toBeGreaterThan(0);
    // `fileURLToPath` ends in the platform separator, and `join`-built paths
    // carry it throughout on Windows, so slicing off a `/`-anchored base both
    // clips a character and leaves `\` separators that match no allowance.
    // Compare through `relative` and speak the allowance's `/` dialect.
    const base = fileURLToPath(CLIENT).replace(/[\\/]+$/u, "");
    for (const file of reach) {
      const rel = relative(base, file).split(sep).join("/");
      expect(allowed, `${rel} reaches the plugin port`).toContain(rel);
    }
  });

  it("keeps the composer's read of installed plugins, but through the read model", () => {
    // The composer still gets exactly what it needs — the installed plugins for
    // the `@` menu — but it no longer names a wire verb to get them. Naming one is
    // the defect this case guards against, so both halves are asserted: the menu
    // is still wired, and the verb is gone from the composer.
    const composer = codeOf(new URL("features/composer/ui/WebuiComposer.tsx", CLIENT));
    expect(composer).toContain("pluginCatalogue");
    expect(composer).not.toMatch(/listInstalledPlugins/u);
    // The port's own name must not survive in code. A mention in a comment is
    // allowed — that comment is what explains the change.
    expect(composer).not.toMatch(/pluginManagement/u);
  });
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      // `join` rather than a template: the directory handed in ends in a separator, and
      // `\${dir}/\${entry}` would produce `application//file.ts`, which matches no allowance.
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/u.test(path)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// The three authoritative action populations, and the typed adapter that consumed
// them, proved to agree exhaustively and without duplicates. The adapter is the
// fourth witness added here, because a fourth carrier that disagreed would be the
// defect this suite exists to catch.
describe("the action populations are exhaustive and non-duplicated", () => {
  /** The server's accepted-action set, parsed on its own, not merged with the shapes. */
  const acceptedActions = [...serverSrc.matchAll(/^\s{2}"(\w+)",$/gmu)].map((m) => m[1]!);
  /** The server's per-action input shapes, parsed on their own. */
  const inputShapeKeys = [
    ...serverSrc
      .slice(serverSrc.indexOf("const INPUT_SHAPES"))
      .matchAll(/^\s{4}(\w+):\s*\{/gmu),
  ].map((m) => m[1]!);
  /** The adapter's typed input map — one entry per action, the new carrier. */
  const adapterKeys = [
    ...read(new URL("features/plugins/contracts/plugin-actions.ts", CLIENT)).matchAll(
      /^ {2}(\w+):\s*(?:undefined|\{)/gmu,
    ),
  ].map((m) => m[1]!);

  it("names the same 29 in every carrier, with no duplicates in any of them", () => {
    for (const [name, population] of [
      ["the shared union", union],
      ["the accepted-action set", acceptedActions],
      ["the input-shape map", inputShapeKeys],
      ["the typed adapter", adapterKeys],
    ] as const) {
      expect(population, `${name} size`).toHaveLength(29);
      // A duplicate would make the count pass while covering fewer actions, and
      // a missing one would hide behind a name the other carriers still have.
      expect(new Set(population).size, `${name} has duplicates`).toBe(29);
      expect(sorted(population), `${name} disagrees with the inventory`).toEqual(
        sorted(actions),
      );
    }
  });

  it("keeps the adapter's only-cast claim honest: one widening cast, on the input", () => {
    // The adapter is allowed exactly one cast, and it is the input widening on
    // the open wire envelope — never on the action name. A cast on the action
    // would reinstate the defect this file exists to catch.
    const adapterSrc = codeOf(new URL("features/plugins/contracts/plugin-actions.ts", CLIENT));
    const casts = [...adapterSrc.matchAll(/\bas\s+[A-Za-z<>[\]\s{},;"'|.]+\bnever\b/gmu)];
    expect(casts.map((m) => m[0])).toEqual([]);
    expect(adapterSrc).not.toMatch(/action\s+as\b/u);
    expect(adapterSrc).toContain("K extends WebuiPluginManagementAction");
  });

  it("dispatches from the owner through a typed call, not a bare string", () => {
    // `call` and `mutate` keep their literal call sites — the inventory case
    // above reads them — but the helper itself is constrained to the union, so a
    // misspelled action cannot compile.
    expect(workflowSrc).toMatch(
      /const call = <K extends WebuiPluginManagementAction>\(/u,
    );
    expect(workflowSrc).toMatch(
      /const mutate = async <K extends WebuiPluginManagementAction>\(/u,
    );
    expect(workflowSrc).not.toMatch(/action as never/u);
  });
});

describe("the typed adapter's inputs are the validator's inputs, field for field", () => {
  /**
   * Brace-counted readers, not a regex over the whole file: an action's shape
   * spans several lines and contains nested `{}`, so a lazy match across the
   * block silently pairs one action's name with the next action's fields. That
   * failure mode was hit while writing this and produced seven phantom
   * mismatches, which is why the fields are read by walking the braces.
   */
  const adapterSrc = read(new URL("features/plugins/contracts/plugin-actions.ts", CLIENT));

  /** The `{ actionName: { … } }` entries of one source block, by brace counting. */
  function entriesOf(text: string, indent: number): Record<string, string> {
    const out: Record<string, string> = {};
    const re = new RegExp(`^ {${indent}}(\\w+):\\s*\\{`, "gmu");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const open = text.indexOf("{", match.index);
      let depth = 0;
      let index = open;
      for (; index < text.length; index += 1) {
        if (text[index] === "{") depth += 1;
        else if (text[index] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out[match[1]!] = text.slice(open + 1, index);
      re.lastIndex = index + 1;
    }
    return out;
  }

  const queryFieldsBlock = serverSrc.slice(
    serverSrc.indexOf("const queryFields"),
    serverSrc.indexOf("const INPUT_SHAPES"),
  );
  const queryFields = [...queryFieldsBlock.matchAll(/^\s{2}(\w+):\s*"(\w+)",$/gmu)].map(
    (m) => [m[1]!, m[2]!] as const,
  );

  const shapeBlock = serverSrc.slice(
    serverSrc.indexOf("const INPUT_SHAPES"),
    serverSrc.indexOf("function matchesField"),
  );
  const validatorFields: Record<string, string[]> = {};
  for (const [action, body] of Object.entries(entriesOf(shapeBlock, 4))) {
    const fields = new Set<string>();
    // `optional: queryFields` is a shorthand for the three paging fields, and a
    // reader that missed it would report a false mismatch on three actions.
    if (/optional:\s*queryFields/u.test(body)) for (const [key] of queryFields) fields.add(key);
    for (const group of body.matchAll(/(required|optional):\s*\{([\s\S]*?)\}/gu)) {
      for (const field of group[2]!.matchAll(/(\w+):\s*"(\w+)"/gu)) fields.add(field[1]!);
      if (group[2]!.includes("...queryFields")) for (const [key] of queryFields) fields.add(key);
    }
    validatorFields[action] = [...fields];
  }

  const typedBlock = adapterSrc.slice(
    adapterSrc.indexOf("export interface WebuiPluginActionInputs"),
    adapterSrc.indexOf("export type WebuiPluginActionInput"),
  );
  const typedFields: Record<string, string[]> = {};
  const re = /^ {2}(\w+):\s*(undefined|\{)/gmu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(typedBlock)) !== null) {
    if (match[2] === "undefined") {
      typedFields[match[1]!] = [];
      continue;
    }
    const open = typedBlock.indexOf("{", re.lastIndex - 1);
    let depth = 0;
    let index = open;
    for (; index < typedBlock.length; index += 1) {
      if (typedBlock[index] === "{") depth += 1;
      else if (typedBlock[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // Not anchored to a line start: several actions declare their fields on one
    // line, and anchoring there silently reported them as absent.
    typedFields[match[1]!] = [
      ...new Set([...typedBlock.slice(open + 1, index).matchAll(/readonly (\w+)\??:/gu)].map((m) => m[1]!)),
    ];
    re.lastIndex = index + 1;
  }

  it("names exactly the fields the validator accepts, for all 29 actions", () => {
    expect(Object.keys(validatorFields)).toHaveLength(29);
    expect(Object.keys(typedFields)).toHaveLength(29);
    for (const action of Object.keys(validatorFields)) {
      expect(sorted(typedFields[action] ?? []), `${action} fields`).toEqual(
        sorted(validatorFields[action]!),
      );
    }
  });
});
