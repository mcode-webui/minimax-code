// Development-only WebUI runtime server. Vite serves the browser client; this
// process owns the loopback WebSocket service on WEBUI_SERVER_PORT.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.WEBUI_SERVER_TSX) {
  const tsconfigPath = fileURLToPath(
    new URL("../tsconfig.standalone.json", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: tsconfigPath,
        WEBUI_SERVER_TSX: "1",
      },
    },
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const os = await import("node:os");
  const path = await import("node:path");
  const { createWebuiRuntimeHost } = await import(
    "../packages/webui/src/runtime/index.ts"
  );
  const { createHarnessPortFromHost, WebuiService } = await import(
    "../packages/webui/src/server/index.ts"
  );
  const dataDir =
    process.env.MINIMAX_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax");
  const tcpPort = Number(process.env.WEBUI_SERVER_PORT ?? 8787);
  const clientDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist-webui/client",
  );
  const assembled = await createWebuiRuntimeHost({
    dataDir,
    appVersion: "webui-dev",
  });
  const service = new WebuiService({
    port: createHarnessPortFromHost(assembled.host),
    tcpPort,
    dev: true,
    clientDir,
  });
  const info = await service.start();
  console.log(`[webui] server listening at ${info.boundUrl}`);
  const close = async () => {
    await service.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
