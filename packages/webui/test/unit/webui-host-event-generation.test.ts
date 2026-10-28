import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const script = path.join(root, "packages/webui/scripts/host-event-catalogue.mjs");

describe("host-derived event types", () => {
  it("rejects stale source projection and requires regenerating a new host event", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "webui-event-types-"));
    try {
      const source = path.join(directory, "producer.ts");
      const output = path.join(directory, "events.ts");
      const args = [script, `--host-root=${directory}`, `--output=${output}`];
      writeFileSync(source, 'declare function publish(value: object): void; publish({type: "session.created" as const}); // type: "session.fake_comment"\n');
      execFileSync(process.execPath, [...args, "--write"]);
      expect(readFileSync(output, "utf8")).toContain('"session.created"');
      expect(readFileSync(output, "utf8")).not.toContain("fake_comment");
      writeFileSync(source, 'const future = "session.future_fact"; declare function publish(value: object): void; publish({type: "session.created" as const}); publish({type: future}); interface TypedProducer {type: "session.union_a" | "session.union_b";}');
      expect(() => execFileSync(process.execPath, args, { stdio: "pipe" })).toThrow();
      execFileSync(process.execPath, [...args, "--write"]);
      expect(readFileSync(output, "utf8")).toContain('"session.future_fact"');
      expect(readFileSync(output, "utf8")).toContain('"session.union_a"');
      expect(readFileSync(output, "utf8")).toContain('"session.union_b"');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps Mini App agent run frames out of the catalogue while scanning the rest of the host", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "webui-event-types-"));
    try {
      const output = path.join(directory, "events.ts");
      const agent = path.join(directory, "service/miniapp/agent");
      const sibling = path.join(directory, "service/miniapp");
      mkdirSync(agent, { recursive: true });
      writeFileSync(
        path.join(directory, "producer.ts"),
        'declare function publish(value: object): void; publish({type: "session.published" as const});\n',
      );
      // Mini App Agent run frames: declared and emitted in the agent subtree, never host-bus facts.
      writeFileSync(
        path.join(agent, "contracts.ts"),
        'export interface Frame { readonly type: "turn.started" | "turn.finished" | "message.committed"; }\n',
      );
      writeFileSync(
        path.join(agent, "gateway.ts"),
        'declare function emit(value: object): void; emit({type: "permission.requested" as const});\n',
      );
      // The exclusion is one subtree, not the whole Mini App service.
      writeFileSync(
        path.join(sibling, "contracts.ts"),
        'declare function publish(value: object): void; publish({type: "message.miniapp_owned" as const});\n',
      );

      // The child IPC connector answers the same run frames the agent session declares.
      const connector = path.join(directory, "service/miniapp/process/host-connector");
      mkdirSync(connector, { recursive: true });
      writeFileSync(
        path.join(connector, "host-connector-agent.ts"),
        'declare function emit(value: object): void; emit({type: "permission.requested" as const}); emit({type: "question.requested" as const});\n',
      );
      writeFileSync(
        path.join(connector, "host-connector.ts"),
        'declare function publish(value: object): void; publish({type: "stream.connector_opened" as const});\n',
      );
      // The exclusion is per file, so a host producer in the same folder is still catalogued.
      writeFileSync(
        path.join(agent, "surface-host-producer.ts"),
        'declare function publish(value: object): void; publish({type: "session.from_agent_dir" as const});\n',
      );
      execFileSync(process.execPath, [script, `--host-root=${directory}`, `--output=${output}`, "--write"]);
      const catalogue = readFileSync(output, "utf8");
      expect(catalogue).toContain('"session.published"');
      expect(catalogue).toContain('"message.miniapp_owned"');
      expect(catalogue).toContain('"session.from_agent_dir"');
      expect(catalogue).toContain('"stream.connector_opened"');
      for (const frame of [
        "turn.started",
        "turn.finished",
        "message.committed",
        "permission.requested",
        "question.requested",
      ]) {
        expect(catalogue).not.toContain(`"${frame}"`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails compilation at the production decoder when a generated host fact has no decision", () => {
    const configPath = path.join(root, "packages/webui/tsconfig.client.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    // TypeScript addresses program files in the `/` dialect even on Windows
    // (`getSourceFiles()` names prove it), so the mutation hook below — which
    // compares by strict equality — must speak it too, or the rewrite never
    // lands and the case asserts against an unmutated program.
    const generated = path.join(root, "packages/webui/src/shared/contracts/host-event-types.generated.ts").split(path.sep).join("/");
    const reader = path.join(root, "packages/webui/src/client/features/turn/application/session-fact.ts").split(path.sep).join("/");
    function diagnostics(mutate: boolean) {
      const host = ts.createCompilerHost(parsed.options);
      const read = host.readFile.bind(host);
      host.readFile = (filename) => {
        const source = read(filename);
        return mutate && filename === generated && source !== undefined
          ? source.replace("] as const;", '  "session.future_fact",\n] as const;')
          : source;
      };
      const program = ts.createProgram(parsed.fileNames, parsed.options, host);
      return program.getSemanticDiagnostics(program.getSourceFile(reader)!);
    }
    expect(diagnostics(false)).toEqual([]);
    const failures = diagnostics(true).map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toContain('"session.future_fact"');
  }, 30_000);
});
