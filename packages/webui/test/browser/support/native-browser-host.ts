// Browser acceptance host: real assembly, loopback service and native PTYs.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createWebuiRuntimeHost } from "../../../src/runtime/assembly.js";
import { createHarnessPortFromHost } from "../../../src/runtime/harness/adapter.js";
import { WebuiTerminalManager } from "../../../src/runtime/terminal.js";
import { WebuiService, createOperationRegistry } from "../../../src/server/index.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "webui-native-"));
const workspaceDir = path.join(directory, "workspace");
const clientDir = path.join(directory, "client");
await mkdir(workspaceDir);
await mkdir(clientDir);
await writeFile(path.join(directory, "config.yaml"), "# isolated WebUI native acceptance; no credentials\n");
process.env.MINIMAX_DATA_DIR = directory;
(await import("@mavis/config")).resetConfig();
// Serve this exact build with the browser harness identity. Config and WebSocket
// are still injected by the production service; no synthetic transport is installed.
for (const name of ["index.html", "client.js", "styles.css"]) {
  let body = await readFile(path.join(root, "dist-webui/client", name));
  if (name === "index.html") body = Buffer.from(body.toString().replace("</head>",
    `<script>window.__WEBUI_TEST_SERVER_ID__=${JSON.stringify(process.env.WEBUI_BROWSER_SERVER_ID)};</script></head>`));
  await writeFile(path.join(clientDir, name), body);
}
// The split bundle's chunks live under assets/ — the entry imports them, so a
// copy without the directory cannot boot at all (#webui-root never appears).
// Copy it wholesale, matching what the loopback resolver serves and the
// packaged release ships.
await cp(path.join(root, "dist-webui/client/assets"), path.join(clientDir, "assets"), { recursive: true });
const assembled = await createWebuiRuntimeHost({
  dataDir: directory, appVersion: "webui-native-acceptance",
  mcodeTools: { prepare: async () => ({ requested: false, ready: false, category: "disabled" as const,
    ensureCommandPath: () => undefined, dispose: async () => undefined }) },
});
const port = createHarnessPortFromHost(assembled.host);
const initialSession = await port.createSession({ name: "main", workspaceDir });
const sessionId = initialSession.session?.sessionId;
if (!sessionId) throw new Error("Native acceptance session was not created");
type NativePtyModule = ReturnType<NonNullable<ConstructorParameters<typeof WebuiTerminalManager>[0]>>;
const native = createRequire(import.meta.url)("node-pty") as NativePtyModule;
const exits: Promise<void>[] = [];
const terminal = new WebuiTerminalManager(() => ({ spawn: (shell, args, options) => {
  const pty = native.spawn(shell, args, options);
  exits.push(new Promise<void>((resolve) => { pty.onExit(resolve); }));
  return pty;
} }));
const operations = new Map(createOperationRegistry(port, terminal));
let releaseCreate: (() => void) | undefined;
let pausedCreate: Promise<void> | undefined;
const create = operations.get("createTerminal")!;
operations.set("createTerminal", { ...create, handle: async (...args) => {
  const result = await create.handle(...args);
  if (pausedCreate) { process.send?.({ created: true }); await pausedCreate; }
  return result;
} });
const service = new WebuiService({ port, operations, terminal,
  tcpPort: 0, credential: { token: "native-acceptance-synthetic-token" }, clientDir, dev: true });
const info = await service.start();
process.send?.({ url: `http://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}#session=${sessionId}`, workspaceDir, sessionId });
let closing: Promise<void> | undefined;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await service.close();
    await Promise.all(exits);
    await assembled.host.apiHost.close();
    if (terminal.list().length !== 0) throw new Error("Native terminal service leaked processes");
    await rm(directory, { recursive: true, force: true });
    process.send?.({ closed: true, terminals: 0, exited: exits.length });
    process.disconnect?.();
  })();
  return closing;
}
process.on("message", (message) => {
  if (message === "hold-create") {
    pausedCreate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    process.send?.({ holding: true });
  } else if (message === "release-create") {
    releaseCreate?.(); pausedCreate = undefined;
    process.send?.({ released: true });
  } else {
    void close().catch((error) => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
  }
});
process.on("SIGTERM", () => { void close(); });
