/**
 * A minimal MCP server over stdio.
 *
 * The capability-surface gate needs a *real* MCP server: the surface it
 * pins is the one the model is offered, and an MCP tool only reaches the
 * model after a server was spawned, initialized and answered `tools/list`.
 * A stubbed tool list would not exercise that path, and the paths that broke
 * before — the stdio message limit and the discovery timeout — live exactly
 * there.
 *
 * The server speaks newline-delimited JSON-RPC directly instead of using the
 * MCP SDK, so the fixture cannot drift with the SDK version and the gate
 * stays hermetic. It answers the three methods a tool-listing session needs
 * and nothing else.
 */

/** The one tool this server exposes. The gate pins its projected name. */
export const FIXTURE_TOOL_NAME = "capability_probe";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  const { id, method, params } = request;
  // A notification carries no id and expects no answer.
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          // Echo the version the client asked for: the client rejects a
          // version it does not know, and the fixture must not pin one.
          protocolVersion:
            typeof params?.protocolVersion === "string"
              ? params.protocolVersion
              : "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "capability-fixture", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: FIXTURE_TOOL_NAME,
              description:
                "Echoes its argument back, so the gate can prove the tool reached the model.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
      break;
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: String(params?.arguments?.text ?? "") }],
          isError: false,
        },
      });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed line is not this fixture's contract to answer.
      }
    }
    newline = buffered.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
