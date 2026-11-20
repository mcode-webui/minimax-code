// Real runtime, persistence, event stream and built client with a local
// deterministic model endpoint; no external provider calls or substitute ports.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createNativeDesignExecution } from "../../../../local-runtime-v2/src/application/agent/native-design-execution.js";
import { HostConnectorGateway } from "../../../../local-runtime-v2/src/service/host-connector-system/gateway.js";
import { createWebuiRuntimeHost } from "../../../src/runtime/assembly.js";
import { createHarnessPortFromHost } from "../../../src/runtime/harness/adapter.js";
import { WebuiTerminalManager } from "../../../src/runtime/terminal.js";
import { WebuiService, createOperationRegistry } from "../../../src/server/index.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const scratchRoot = process.env.WEBUI_DESIGN_BROWSER_DATA_DIR;
if (!scratchRoot) throw new Error("WEBUI_DESIGN_BROWSER_DATA_DIR must name an isolated browser acceptance artifact directory");
await mkdir(scratchRoot, { recursive: true });
const directory = await mkdtemp(path.join(scratchRoot, "webui-design-browser-"));
const workspaceDir = path.join(directory, "workspace");
const clientDir = path.join(directory, "client");
await mkdir(workspaceDir);
await mkdir(clientDir);
interface AcceptanceToolCall { input: Readonly<Record<string, unknown>>; callId: string; dispatched: boolean; admitted: boolean; result?: Record<string, unknown>; error?: string }
let pendingTool: AcceptanceToolCall | undefined;
let observedToolNames: readonly string[] = [];
/** The tool table of the most recent model request, for node-execution admission evidence. */
let lastModelToolNames: readonly string[] = [];
let lastModelPrompt = "";
/** Tool tables keyed by an explicit probe marker carried in the node prompt. */
const probeToolTables = new Map<string, readonly (readonly string[])[]>();
/** Whether the runtime ever handed a result for the deliberately unlisted tool call. */
let forbiddenToolResultSeen = false;
let forbiddenToolResultContent = "";
interface AcceptanceScenario { tool: string; arguments: Readonly<Record<string, unknown>>; modelToolNames: readonly string[]; result?: string; latestUserReply?: string }
const scenarios = new Map<string, AcceptanceScenario>();
const model = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  request.on("end", () => {
    if (request.url?.startsWith("/mavis/api/")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"pass":true,"safe":true,"action":1,"errorCode":0}'); return; }
    // A hanging turn is a real in-flight model request the acceptance can cancel.
    if (body.includes("DESIGN_ACCEPTANCE_HANG")) return;
    const input = JSON.parse(body) as { tools?: readonly { function?: { name?: string } }[]; messages?: readonly { role?: string; tool_call_id?: string; content?: unknown }[] };
    modelRequestCount += 1;
    lastModelToolNames = input.tools?.map((tool) => tool.function?.name ?? "") ?? [];
    const textContent = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((item: { text?: string }) => item.text ?? "").join("\n") : "";
    lastModelPrompt = input.messages?.filter((message) => message.role === "user").map((message) => textContent(message.content)).join("\n") ?? "";
    const probe = /NODE_TOOLS_PROBE:([A-Za-z0-9_-]+)/.exec(lastModelPrompt)?.[1];
    if (probe) probeToolTables.set(probe, [...(probeToolTables.get(probe) ?? []), lastModelToolNames]);
    const marker = [...(input.messages?.filter((message) => message.role === "user").map((message) => textContent(message.content)).join("\n") ?? "").matchAll(/DESIGN_ACCEPTANCE_(QUESTION|PERMISSION):([a-zA-Z0-9_-]+)/g)].at(-1);
    const scenarioKey = marker?.[2];
    const scenarioCallId = scenarioKey ? `design_scenario_${scenarioKey}` : undefined;
    const scenarioTool = marker?.[1] === "QUESTION" ? "ask_user" : "bash";
    const priorScenario = scenarioKey ? scenarios.get(scenarioKey) : undefined;
    const scenarioResult = scenarioCallId && input.messages?.findLast((message) => message.role === "tool" && message.tool_call_id === scenarioCallId);
    if (priorScenario && scenarioResult) priorScenario.result = textContent(scenarioResult.content);
    if (priorScenario) priorScenario.latestUserReply = textContent(input.messages?.findLast((message) => message.role === "user")?.content);
    const scenarioArguments = marker?.[1] === "QUESTION" ? { title: "Design 原生问卷验收", steps: [{ id: "design-choice", question: "请选择这次本地 Design 任务的处理方式", selectionMode: "multiple", options: [{ id: "keep", label: "保留当前素材" }, { id: "review", label: "先检查结果" }] }] } : { command: "printf design-permission-accepted", description: "Run the harmless isolated Design permission acceptance command" };
    const scenarioCall = Boolean(scenarioKey && !priorScenario && input.tools?.some((tool) => tool.function?.name === scenarioTool));
    const admitted = input.tools?.some((tool) => tool.function?.name === "design");
    if (admitted) observedToolNames = input.tools!.map((tool) => tool.function?.name ?? "");
    const call = admitted && pendingTool && !pendingTool.dispatched;
    if (pendingTool?.dispatched) {
      const completed = input.messages?.findLast((message) => message.role === "tool" && message.tool_call_id === pendingTool!.callId);
      if (completed) {
        const content = typeof completed.content === "string" ? completed.content : Array.isArray(completed.content) ? completed.content.map((item: { text?: string }) => item.text ?? "").join("\n") : "";
        try {
          const value = JSON.parse(content) as Record<string, unknown>;
          if (!value || !Array.isArray(value.documents)) pendingTool.error = `Native Design tool did not succeed: ${content}`;
          else pendingTool.result = value;
        } catch { pendingTool.error = `Native Design tool returned an invalid result: ${content}`; }
      }
    }
    const forbidden = body.includes("DESIGN_ACCEPTANCE_FORBIDDEN_TOOL");
    const forbiddenCallId = "forbidden_bash";
    const forbiddenResultMessage = input.messages?.find(
      (message) => message.role === "tool" && message.tool_call_id === forbiddenCallId,
    );
    const forbiddenResultSeen = Boolean(forbiddenResultMessage);
    if (forbiddenResultSeen) {
      forbiddenToolResultSeen = true;
      forbiddenToolResultContent =
        typeof forbiddenResultMessage?.content === "string"
          ? forbiddenResultMessage.content
          : JSON.stringify(forbiddenResultMessage?.content ?? null);
    }
    const forbiddenCall = forbidden && !forbiddenResultSeen;
    const forbiddenDelta = forbiddenCall
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: forbiddenCallId,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: `touch ${path.join(directory, "forbidden-tool-ran")}`,
                }),
              },
            },
            {
              index: 1,
              id: "forbidden_design",
              type: "function",
              function: {
                name: "design",
                arguments: JSON.stringify({
                  action: "add_node",
                  nodeType: "text",
                  title: "forbidden-design-write",
                }),
              },
            },
          ],
        }
      : undefined;
    const delta = forbiddenDelta ?? (scenarioCall ? { role: "assistant", tool_calls: [{ index: 0, id: scenarioCallId, type: "function", function: { name: scenarioTool, arguments: JSON.stringify(scenarioArguments) } }] } : call ? { role: "assistant", tool_calls: [{ index: 0, id: pendingTool!.callId, type: "function", function: { name: "design", arguments: JSON.stringify(pendingTool!.input) } }] } : { role: "assistant", content: priorScenario?.result ? `Design scenario completed. Actual ${priorScenario.tool} result: ${priorScenario.result}` : "Design operation completed." });
    if (scenarioCall) scenarios.set(scenarioKey!, { tool: scenarioTool, arguments: scenarioArguments, modelToolNames: input.tools!.map((tool) => tool.function?.name ?? "") });
    if (call) { pendingTool!.dispatched = true; pendingTool!.admitted = true; }
    const frame = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "design-browser", object: "chat.completion.chunk", created: 1, model: "design-stub", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame(delta, null) + frame({}, call || scenarioCall ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("Design local model did not bind");
const modelBase = `http://127.0.0.1:${modelAddress.port}`;
await writeFile(path.join(directory, "config.yaml"), [
  "defaultModel: custom_provider:design-local/design-stub", "contentReview:", `  testBaseURL: ${modelBase}`,
  "custom_provider:", "  design-local:", "    name: Local Design Acceptance", "    api: openai-completions", "    options:", `      baseURL: ${modelBase}/v1`, "      apiKey: synthetic-local-key",
  "    models:", "      design-stub:", "        id: design-stub", "        name: Local Design Acceptance", "        tool_call: true", "        limit:", "          context: 100000", "          output: 4096", "        modalities:", "          input: [text]", "          output: [text]", "",
].join("\n"), { mode: 0o600 });
process.env.MAVIS_BUILD_ENV = "test";
process.env.MAVIS_REGION = "cn";
process.env.MINIMAX_DATA_DIR = directory;
// A real stored ask rule exercises the ordinary production approval owner.
await writeFile(path.join(directory, "permission.json"), JSON.stringify({ ask: ["bash"], defaultMode: "default" }), { mode: 0o600 });
(await import("@mavis/config")).resetConfig();
for (const name of ["index.html", "client.js", "styles.css"]) {
  let body = await readFile(path.join(root, "dist-webui/client", name));
  if (name === "index.html") body = Buffer.from(body.toString().replace("</head>", `<script>window.__WEBUI_TEST_SERVER_ID__=${JSON.stringify(process.env.WEBUI_BROWSER_SERVER_ID)};</script></head>`));
  await writeFile(path.join(clientDir, name), body);
}
await cp(path.join(root, "dist-webui/client/assets"), path.join(clientDir, "assets"), { recursive: true });
const assembled = await createWebuiRuntimeHost({
  dataDir: directory, appVersion: "webui-design-browser-acceptance",
  mcodeTools: { prepare: async () => ({ requested: false, ready: false, category: "disabled" as const, ensureCommandPath: () => undefined, dispose: async () => undefined }) },
});
// Test-only provider understanding. The host has no account, so the real
// connector discovery is "not connected"; this wrapper is enabled only for the
// acceptance that proves a connected image's understood content reaches the
// text model. It never calls a real provider and never changes the product
// tool admission.
let syntheticUnderstanding = false;
let slowUnderstanding = false;
let understandingAborted = false;
let modelRequestCount = 0;
let designModelCalls = 0;
const uploads: Array<{
  readonly mime: string;
  readonly filename: string;
  readonly bytes: number;
  readonly magic: string;
}> = [];
let uploadError = "";
const providerPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const uploadServer = createServer(async (request, response) => {
  if (request.method === "GET" && (request.url === "/generated.png" || request.url === "/uploaded.png")) {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(providerPng);
    return;
  }
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  } catch (error) {
    uploadError = error instanceof Error ? error.message : String(error);
  }
  // The multipart body is read here rather than through a `Request` whose
  // `formData()` parses it: that parser is the one dependency in this path
  // that behaves differently across platforms, and the provider waits for an
  // answer it never gets when it does. The body is a small, known shape, so
  // it is read directly.
  const file = parseMultipartFile(
    Buffer.concat(chunks),
    String(request.headers["content-type"] ?? ""),
  );
  if (file) uploads.push(file);
  else if (!uploadError) uploadError = "multipart did not carry a file field";
  response.writeHead(200);
  response.end();
});

/**
 * Read the one file part out of a multipart body.
 *
 * The bytes are kept as they arrived: the evidence the acceptance checks is
 * the part's own type, name and leading bytes, so the parser reads the
 * headers and leaves the content alone.
 */
function parseMultipartFile(
  body: Buffer,
  contentType: string,
): { readonly mime: string; readonly filename: string; readonly bytes: number; readonly magic: string } | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const delimiter = boundary ? `--${(boundary[1] ?? boundary[2] ?? "").trim()}` : "";
  if (!delimiter) return undefined;
  const raw = body.toString("latin1");
  for (const part of raw.split(delimiter)) {
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? "";
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? "";
    if (name !== "file") continue;
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? "";
    const mime = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() ?? "";
    const content = Buffer.from(part.slice(separator + 4).replace(/\r\n$/, ""), "latin1");
    return {
      mime,
      filename,
      bytes: content.length,
      magic: content.subarray(0, 8).toString("hex"),
    };
  }
  return undefined;
}
await new Promise<void>((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
const uploadAddress = uploadServer.address();
if (!uploadAddress || typeof uploadAddress === "string") throw new Error("Synthetic provider upload did not bind");
const uploadPort = uploadAddress.port;
const realDesignExecution = assembled.host.designExecution;
const designService = assembled.host.design;
let syntheticExecution: ReturnType<typeof createNativeDesignExecution> | undefined;
let syntheticGateway: HostConnectorGateway | undefined;
const countedAgent = realDesignExecution
  ? {
      ...realDesignExecution.agent,
      run: (input: Parameters<typeof realDesignExecution.agent.run>[0], options?: Parameters<typeof realDesignExecution.agent.run>[1]) => {
        designModelCalls += 1;
        return realDesignExecution.agent.run(input, options);
      },
    }
  : undefined;
if (realDesignExecution && designService && countedAgent) {
  // The real native execution and its real gateway stay attached unless a
  // synthetic acceptance explicitly needs a connected account. No test
  // replaces the native hostConnector abstraction itself.
  await designService.attachExecution({ ...realDesignExecution, agent: countedAgent });
}
async function enableSyntheticExecution(): Promise<void> {
  if (!realDesignExecution || !designService || !countedAgent || syntheticExecution) return;
  const credentials = { accessToken: "design-browser-synthetic", realUserID: "design-browser-synthetic", authState: "authenticated" as const };
  const tools = [
    { provider: "matrix", providerToolName: "upload_temp_url", runtimeToolName: "matrix_upload_temp_url", inputSchemaJson: '{"type":"object"}' },
    { provider: "matrix", providerToolName: "describe_images", runtimeToolName: "matrix_describe_images", inputSchemaJson: '{"type":"object"}' },
    { provider: "matrix", providerToolName: "generate_image", runtimeToolName: "matrix_generate_image", inputSchemaJson: '{"type":"object"}' },
    { provider: "matrix", providerToolName: "get_asset_url", runtimeToolName: "matrix_get_asset_url", inputSchemaJson: '{"type":"object"}' },
  ];
  const uploadedTempUrl = `http://127.0.0.1:${uploadPort}/uploaded.png`;
  const generatedUrl = `http://127.0.0.1:${uploadPort}/generated.png`;
  syntheticGateway = new HostConnectorGateway({
    credentialGetter: () => credentials,
    client: {
      listConnectedTools: async () => ({ tools, providerFailures: [], partial: false }),
      callTool: async ({ providerToolName, arguments: args, signal, onDispatch }) => {
        onDispatch();
        if (providerToolName === "upload_temp_url") {
          return { resultJson: JSON.stringify({ upload_host: `http://127.0.0.1:${uploadPort}/upload`, temp_url: uploadedTempUrl, fields: {} }) };
        }
        if (providerToolName === "describe_images") {
          const info = (args as { readonly image_info?: readonly { readonly url?: string }[] }).image_info;
          const imageUrl = String(info?.[0]?.url ?? "");
          const last = uploads.at(-1);
          if (imageUrl !== uploadedTempUrl || !last || last.mime !== "image/png" || !last.magic.startsWith("89504e47")) {
            return {
              resultJson: JSON.stringify({
                results: [{ success: false, error: `synthetic describe received a non-image media: ${imageUrl} mime=${last?.mime ?? "none"}` }],
              }),
            };
          }
          if (slowUnderstanding) {
            await new Promise<void>((resolve) => {
              const finish = () => { understandingAborted = true; resolve(); };
              if (signal?.aborted) finish();
              else signal?.addEventListener("abort", finish, { once: true });
            });
            return { resultJson: JSON.stringify({ results: [{ success: true, description: "late synthetic understanding" }] }) };
          }
          return { resultJson: JSON.stringify({ results: [{ success: true, description: "合成理解：一只橘猫坐在窗台上，午后侧光" }] }) };
        }
        if (providerToolName === "generate_image") {
          return { resultJson: JSON.stringify({ success_items: [{ url: generatedUrl }], node_id: "synthetic-generated-node" }) };
        }
        if (providerToolName === "get_asset_url") {
          return { resultJson: JSON.stringify({ url: generatedUrl }) };
        }
        throw new Error(`unexpected synthetic connector tool ${providerToolName}`);
      },
    },
  });
  syntheticExecution = createNativeDesignExecution(countedAgent, syntheticGateway, "design-browser-synthetic");
  await designService.attachExecution(syntheticExecution);
}
const port = createHarnessPortFromHost(assembled.host);
const initial = await port.createSession({ name: "main", workspaceDir });
const sessionId = initial.session?.sessionId;
if (!sessionId) throw new Error("Native Design acceptance session was not created");
const terminal = new WebuiTerminalManager();
const service = new WebuiService({ port, operations: createOperationRegistry(port, terminal), terminal, tcpPort: 0, credential: { token: "design-browser-synthetic-token" }, clientDir, dev: true });
const info = await service.start();
process.send?.({ url: `http://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}#session=${sessionId}`, sessionId, directory });
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  return closing ??= (async () => {
    await syntheticExecution?.close();
    await syntheticGateway?.close();
    await service.close();
    await assembled.host.apiHost.close();
    await new Promise<void>((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => model.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    process.send?.({ closed: true }, () => { process.disconnect?.(); process.exit(0); });
  })();
}
process.on("message", async (message: unknown) => {
  if (message && typeof message === "object" && "requestId" in message && "enableSlowUnderstanding" in message) {
    slowUnderstanding = true;
    understandingAborted = false;
    modelRequestCount = 0;
    designModelCalls = 0;
    const request = message as { requestId: string };
    process.send?.({ requestId: request.requestId, result: { enabled: true } });
  } else if (message && typeof message === "object" && "requestId" in message && "readUnderstandingState" in message) {
    const request = message as { requestId: string };
    process.send?.({ requestId: request.requestId, result: { aborted: understandingAborted, modelRequests: modelRequestCount, designModelCalls } });
  } else if (message && typeof message === "object" && "requestId" in message && "readUploadEvidence" in message) {
    const request = message as { requestId: string };
    process.send?.({ requestId: request.requestId, result: { uploads, error: uploadError } });
  } else if (message && typeof message === "object" && "requestId" in message && "enableSyntheticUnderstanding" in message) {
    await enableSyntheticExecution();
    syntheticUnderstanding = true;
    const request = message as { requestId: string };
    process.send?.({ requestId: request.requestId, result: { enabled: true } });
  } else if (message && typeof message === "object" && "requestId" in message && "readModelPrompt" in message) {
    const request = message as { requestId: string };
    process.send?.({ requestId: request.requestId, result: lastModelPrompt });
  } else if (message && typeof message === "object" && "requestId" in message && "readForbiddenToolResult" in message) {
    const request = message as { requestId: string };
    process.send?.({
      requestId: request.requestId,
      result: { seen: forbiddenToolResultSeen, content: forbiddenToolResultContent },
    });
  } else if (message && typeof message === "object" && "requestId" in message && "readNodeRunTools" in message) {
    const request = message as { requestId: string; readNodeRunTools: string };
    process.send?.({ requestId: request.requestId, result: probeToolTables.get(request.readNodeRunTools) ?? null });
  } else if (message && typeof message === "object" && "requestId" in message && "readModelTools" in message) {
    const request = message as { requestId: string };
    process.send?.({ requestId: request.requestId, result: lastModelToolNames });
  } else if (message && typeof message === "object" && "requestId" in message && "scenarioId" in message) {
    const request = message as { requestId: string; scenarioId: string };
    process.send?.({ requestId: request.requestId, result: scenarios.get(request.scenarioId) ?? null });
  } else if (message && typeof message === "object" && "requestId" in message && "input" in message) {
    const request = message as { requestId: string; input: Readonly<Record<string, unknown>> };
    const execute = async () => {
      if (pendingTool) throw new Error("A browser acceptance tool turn is already running");
      const current: AcceptanceToolCall = { input: request.input, callId: `design_${randomUUID().replaceAll("-", "")}`, dispatched: false, admitted: false };
      pendingTool = current;
      try {
        const turn = await port.sendMessage({ id: sessionId, content: "Execute the requested native Design operation." });
        if (!turn.ok) throw new Error("Production Design acceptance turn was rejected");
        for await (const _event of turn.source) void _event;
        if (!current.admitted || !current.dispatched) throw new Error("Production tool table did not admit native Design");
        if (current.error) throw new Error(current.error);
        if (!current.result) throw new Error("Production turn ended without a successful result for this Design tool call");
        return { ...current.result, modelToolNames: observedToolNames, acceptance: { registeredTool: true, productionTurn: true } };
      } finally { pendingTool = undefined; }
    };
    void execute().then(
      (result) => process.send?.({ requestId: request.requestId, result }),
      (error: unknown) => process.send?.({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error) }),
    );
  } else {
    void close().catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
  }
});
process.on("SIGTERM", () => { void close(); });
