#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebuiService } from "../server/server.js";
import {
  createHarnessPortFromHost,
  createWebuiRuntimeHost,
} from "../server/runtime.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(packageRoot, "server/package-info.json"), "utf8"));
const portValue = process.env.WEBUI_SERVER_PORT?.trim() || "8787";
const tcpPort = Number(portValue);
if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
  throw new Error("WEBUI_SERVER_PORT must be an integer between 1 and 65535");
}

const dataDir = process.env.MINIMAX_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax");
process.env.MAVIS_BUILTIN_AGENTS_V2_DIR ??= path.join(packageRoot, "assets/agents");
process.env.MAVIS_BUILTIN_AGENTS_DIR ??= path.join(packageRoot, "assets/agents");
const assembled = await createWebuiRuntimeHost({ dataDir, appVersion: version });
const service = new WebuiService({
  port: createHarnessPortFromHost(assembled.host),
  host: "127.0.0.1",
  tcpPort,
  dev: true,
  clientDir: path.join(packageRoot, "client"),
});

let closing;
const close = () => {
  closing ??= (async () => {
    await service.close();
    await assembled.host.apiHost.close();
  })();
  return closing;
};

try {
  const info = await service.start();
  // dev mode keeps the per-start credential off, so the shell page and its
  // assets load without a query token. info.boundUrl is the bare ws://
  // endpoint; browsers need the http:// origin.
  const browserUrl = `http://${info.host}:${info.tcpPort}/`;
  console.log(`[mcode-webui] WebUI running at ${browserUrl}`);
  console.log("Press Ctrl+C to stop the server.");
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
} catch (error) {
  await close();
  throw error;
}
