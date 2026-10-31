import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = path.resolve(packageRoot, "../local-runtime-v2/src");
const output = path.join(packageRoot, "src/shared/contracts/host-event-types.generated.ts");
const eventName = /^(?:session|message|agent|rotation|content|turn|stream|permission|questionnaire)\.[a-z_.]+$/u;
/**
 * The Mini App agent module declares and emits its own run-event vocabulary
 * (`turn.started`, `message.committed`, `permission.requested`, ...). Those events are
 * projected to the Mini App page bridge, never written to the host event bus, so a name
 * shared with a host event does not make one. Excluded per file, not per directory: a
 * genuine host producer added to the same folder must still be catalogued.
 */
const excludedSources = [
  path.join("service", "miniapp", "agent", "contracts.ts"),
  path.join("service", "miniapp", "agent", "gateway.ts"),
  path.join("service", "miniapp", "agent", "session-ports.ts"),
  path.join("service", "miniapp", "agent", "session-ports-projection.ts"),
  // The child IPC connector answers those same run frames over the parent/child channel.
  path.join("service", "miniapp", "process", "host-connector", "host-connector-agent.ts"),
];


/** Collect actual literal declarations with the TypeScript parser, including typed producers. */
export function collectHostEventTypes(root = hostRoot, read = readFileSync) {
  const names = new Set();
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filename);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      if (excludedSources.includes(path.relative(root, filename))) continue;
      files.push(filename);
    }
  }
  walk(root);
  const configPath = path.resolve(packageRoot, "../../tsconfig.standalone.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const host = ts.createCompilerHost(parsed.options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (filename) => files.includes(filename) ? read(filename, "utf8") : originalRead(filename);
  const program = ts.createProgram(files, parsed.options, host);
  const checker = program.getTypeChecker();
  function collect(type) {
    if (type.isUnion()) { for (const member of type.types) collect(member); return; }
    if (type.isStringLiteral() && eventName.test(type.value)) names.add(type.value);
  }
  for (const filename of files) {
      const source = program.getSourceFile(filename);
      if (!source) throw new Error(`Unable to parse host source: ${filename}`);
      function visit(node) {
        if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) && node.name.getText(source).replaceAll('"', '').replaceAll("'", '') === "type") {
          const value = ts.isPropertyAssignment(node) ? node.initializer : node.type;
          if (value) collect(checker.getTypeAtLocation(value));
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
  }
  if (names.size === 0) throw new Error("Host event catalogue is empty");
  return [...names].sort();
}

export function renderHostEventTypes(names) {
  return "// Generated from local-runtime-v2 event producers; do not edit by hand.\n" +
    "// Regenerate: pnpm --filter @mavis/webui gen:host-events\n\n" +
    "export const HOST_PUBLISHED_EVENT_TYPES = [\n" + names.map((name) => `  ${JSON.stringify(name)},\n`).join("") +
    "] as const;\n\nexport type HostPublishedEventType = (typeof HOST_PUBLISHED_EVENT_TYPES)[number];\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputRoot = process.argv.find((arg) => arg.startsWith("--host-root="))?.slice("--host-root=".length) ?? hostRoot;
  const target = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? output;
  const expected = renderHostEventTypes(collectHostEventTypes(inputRoot));
  if (process.argv.includes("--write")) {
    writeFileSync(target, expected);
    console.log("Generated WebUI host event catalogue");
  } else {
    if (readFileSync(target, "utf8") !== expected) throw new Error("WebUI host event catalogue is stale; run pnpm --filter @mavis/webui gen:host-events, then decide every new event route before compiling");
    console.log("WebUI host event catalogue matches host producers");
  }
}
