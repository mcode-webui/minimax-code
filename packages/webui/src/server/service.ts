// WebUI service: owns a runtime host, binds loopback, runs the wire
// envelope with access control, and shuts down in order.
//
// This is the server seam. It composes:
//   * a harness port (real: script of the host's `CliService` facade;
//     test: scripted stand-in),
//   * a per-start credential,
//   * the operation registry built from the port,
//   * the access control rules described in ADR 0004.
//
// Shutdown order matches step 13 of the assembly checklist: stop accepting
// new operations, then close every connection, then close the harness.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import {
  createOperationRegistry,
  type WebuiOperationRegistryEntry,
} from "./operation/operations.js";
import {
  createWebuiCredential,
  credentialMatches,
  type WebuiCredential,
} from "./credentials.js";
import {
  dispatchWebuiFrame,
  errorFrame,
  sendFrame,
} from "./operation/operation-dispatch.js";
import {
  WebuiErrorCode,
  WEBUI_PROTOCOL_VERSION,
} from "./envelope.js";
import type { WebuiHarnessPort, WebuiSessionInfo } from "./port.js";
import { WebuiTerminalManager } from "./terminal.js";
import { webuiSessionTransferFileName } from "./session-transfer.js";

export const WEBUI_MAX_MESSAGE_BYTES = 256 * 1024;
export const WEBUI_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Truthy env-var spellings that turn the development mode on. Anything that
 * is not on this list is ignored, so `WEBUI_DEV=0` / `WEBUI_DEV=false` /
 * unset all leave production semantics intact.
 */
function readEnvFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const trimmed = raw.trim().toLowerCase();
  return (
    trimmed === "1" ||
    trimmed === "true" ||
    trimmed === "yes" ||
    trimmed === "on"
  );
}

export interface WebuiServiceOptions {
  readonly port: WebuiHarnessPort;
  /** Defaults to the protocol version the wire envelope ships. */
  readonly protocolVersion?: number;
  /**
   * Loopback host the service binds to. The service refuses to start
   * when this is anything other than `127.0.0.1`, `localhost`, `::1` or
   * `[::1]`; remote or LAN access requires a separate decision (ADR
   * 0004), not a different bind address. Defaults to `127.0.0.1`.
   */
  readonly host?: string;
  /** TCP port; `0` asks the OS for a free port. Defaults to `0`. */
  readonly tcpPort?: number;
  /** Maximum WebSocket message size in bytes. */
  readonly maxMessageBytes?: number;
  /** Override the liveness sweep interval; tests use a short interval. */
  readonly webSocketHeartbeatIntervalMs?: number;
  /** Optional credential override; tests supply one to assert its shape. */
  readonly credential?: WebuiCredential;
  /** Optional server factory; tests inject an HTTP server without listening. */
  readonly httpServerFactory?: () => Server;
  /**
   * Development mode: when `true`, the HTTP and WebSocket paths do not
   * require a credential so a developer can open the served page in a
   * plain browser without scraping a per-start token out of the log.
   * Host and Origin discipline stay intact (ADR 0004). Default mode keeps
   * today's per-start credential requirement.
   *
   * The env var `WEBUI_DEV=1` (also accepts `true`/`yes`/`on`) turns it
   * on for the lifecycle of the process — there is no path that flips
   * it back to off without restarting the service, so a misconfigured
   * environment cannot be widened by accident. The option wins over the
   * env var so tests can pin the boot mode without touching the
   * environment.
   */
  readonly dev?: boolean;
  /**
   * Override the directory the service reads `index.html`, `client.js`
   * and `styles.css` from. Tests inject the built-artifact path
   * (`dist-webui/client`) so they can assert the assets the served page
   * references load without inventing tokens; the dev preview launcher
   * uses it to point at the same path. When unset the service picks the
   * first existing candidate under `findClientDirectory()`.
   */
  readonly clientDir?: string;
}

export interface WebuiServiceInfo {
  readonly host: string;
  readonly tcpPort: number;
  readonly protocolVersion: typeof WEBUI_PROTOCOL_VERSION;
  readonly credential: WebuiCredential;
  readonly boundUrl: string;
}

export class WebuiService {
  private readonly port: WebuiHarnessPort;
  private readonly host: string;
  private readonly tcpPort: number;
  private readonly maxMessageBytes: number;
  private readonly webSocketHeartbeatIntervalMs: number;
  private readonly credential: WebuiCredential;
  private readonly protocolVersion: number;
  private readonly dev: boolean;
  private readonly clientDirOverride: string | undefined;
  private readonly operations: ReadonlyMap<string, WebuiOperationRegistryEntry>;
  private readonly httpServer: Server;
  private readonly wsServer: WebSocketServer;
  private readonly terminalManager = new WebuiTerminalManager();
  private readonly connections = new Set<WebSocket>();
  private readonly connectionSignals = new Map<WebSocket, AbortController>();
  private readonly connectionAlive = new WeakMap<WebSocket, boolean>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private accepting = true;
  private startedPromise: Promise<WebuiServiceInfo> | undefined;
  private bound: { info: WebuiServiceInfo } | undefined;

  constructor(options: WebuiServiceOptions) {
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    if (!isLoopbackBindAddress(this.host))
      throw new Error(
        `WebUI service may only bind to a loopback address; received ${JSON.stringify(this.host)}`,
      );
    this.tcpPort = options.tcpPort ?? 0;
    this.maxMessageBytes = options.maxMessageBytes ?? WEBUI_MAX_MESSAGE_BYTES;
    this.webSocketHeartbeatIntervalMs =
      options.webSocketHeartbeatIntervalMs ?? WEBUI_WEBSOCKET_HEARTBEAT_INTERVAL_MS;
    this.credential = options.credential ?? createWebuiCredential();
    this.protocolVersion = options.protocolVersion ?? WEBUI_PROTOCOL_VERSION;
    // The option is the source of truth for tests; the env var is the
    // convenience for the dev preview launcher. The option must win
    // when both are set so a test that pins `dev: false` cannot be
    // widened by a stray `WEBUI_DEV=1` in the environment.
    this.dev = options.dev ?? readEnvFlag("WEBUI_DEV");
    this.clientDirOverride = options.clientDir;
    this.operations = createOperationRegistry({
      version: () => ({
        version: this.port.version().version,
        protocolVersion: this.port.version().protocolVersion,
      }),
      listSessions: (request) => this.port.listSessions(request),
      getActiveTurn: (request) => this.port.getActiveTurn(request),
      listVisibleProjects: (request) => {
        if (!this.port.listVisibleProjects) throw new Error("runtime host does not expose project listing");
        return this.port.listVisibleProjects(request);
      },
      getSessionTree: (request) => this.port.getSessionTree(request),
      archiveSession: (request) => this.port.archiveSession(request),
      deleteSession: (request) => this.port.deleteSession(request),
      updateSession: (request) => this.port.updateSession(request),
      getSessionForkOptions: (request) => this.port.getSessionForkOptions(request),
      forkSession: (request) => this.port.forkSession(request),
      createSession: (request) => this.port.createSession(request),
      getSession: (request) => this.port.getSession(request),
      getMessages: (request) => this.port.getMessages(request),
      getSessionDiff: (request) => this.port.getSessionDiff(request),
      getTurnDiff: (request) => this.port.getTurnDiff(request),
      revertTurnDiff: (request) => this.port.revertTurnDiff(request),
      reapplyTurnDiff: (request) => this.port.reapplyTurnDiff(request),
      getSessionRewindPreview: (request) => this.port.getSessionRewindPreview(request),
      rewindSession: (request) => this.port.rewindSession(request),
      editSessionMessage: (request) => this.port.editSessionMessage(request),
      isGoalEnabled: () => this.port.isGoalEnabled(),
      getGoal: (request) => this.port.getGoal(request),
      createGoal: (request) => this.port.createGoal(request),
      patchGoal: (request) => this.port.patchGoal(request),
      clearGoal: (request) => this.port.clearGoal(request),
      // The cron store is reached through `apiHost.cronRuntime`, which is an
      // optional field on the runtime host handle: a test double or a host built
      // without the scheduled-task surface leaves the port method undefined. Each
      // forward therefore fails closed with one message rather than failing as an
      // undefined call, so "this host has no cron" is legible in the wire error
      // instead of a TypeError.
      listCrons: () => {
        if (!this.port.listCrons) throw new Error("runtime host does not expose cron");
        return this.port.listCrons();
      },
      createCron: (request) => {
        if (!this.port.createCron) throw new Error("runtime host does not expose cron");
        return this.port.createCron(request);
      },
      updateCron: (request) => {
        if (!this.port.updateCron) throw new Error("runtime host does not expose cron");
        return this.port.updateCron(request);
      },
      deleteCron: (request) => {
        if (!this.port.deleteCron) throw new Error("runtime host does not expose cron");
        return this.port.deleteCron(request);
      },
      triggerCron: (request) => {
        if (!this.port.triggerCron) throw new Error("runtime host does not expose cron");
        return this.port.triggerCron(request);
      },
      listWorkspaceFileTree: (request) => this.port.listWorkspaceFileTree(request),
      readWorkspaceFile: (request) => this.port.readWorkspaceFile(request),
      getWorkspaceEnvironment: (request) => this.port.getWorkspaceEnvironment(request),
      mutateWorkspaceGit: (request) => this.port.mutateWorkspaceGit(request),
      getWorkspaceReviewSummary: (request) => this.port.getWorkspaceReviewSummary(request),
      listWorkspaceReviewFileDiffs: (request) => this.port.listWorkspaceReviewFileDiffs(request),
      getWorkspaceReviewFileContent: (request) => this.port.getWorkspaceReviewFileContent(request),
      searchWorkspaceReviewDiffs: (request) => this.port.searchWorkspaceReviewDiffs(request),
      readCanvas: (request) => this.port.readCanvas(request),
      applyCanvas: (request) => this.port.applyCanvas(request),
      readWorkspaceArchive: (request) => this.port.readWorkspaceArchive(request),
      extractWorkspaceArchive: (request) => this.port.extractWorkspaceArchive(request),
      sendMessage: (request, signal) => this.port.sendMessage(request, signal),
      enqueueMessage: (request) => this.port.enqueueMessage(request),
      resumeSession: (request, signal) =>
        this.port.resumeSession(request, signal),
      watchEvents: (signal) => this.port.watchEvents(signal),
      listPendingPermissions: () => this.port.listPendingPermissions(),
      getPendingQuestionnaire: (request) =>
        this.port.getPendingQuestionnaire(request),
      replyPermission: (request) => this.port.replyPermission(request),
      replyQuestionnaire: (request) => this.port.replyQuestionnaire(request),
      dismissQuestionnaire: (request) =>
        this.port.dismissQuestionnaire(request),
      abortSession: (request) => this.port.abortSession(request),
      listQueueMessages: (request) => this.port.listQueueMessages(request),
      deleteQueueItem: (request) => this.port.deleteQueueItem(request),
      listModels: (request) => this.port.listModels(request),
      selectModel: (request) => this.port.selectModel(request),
      listSkills: (request) => this.port.listSkills(request),
      pluginManagement: (request) => {
        if (!this.port.pluginManagement) throw new Error("runtime host does not expose plugin management");
        return this.port.pluginManagement(request);
      },
      getPermissionMode: () => {
        if (!this.port.getPermissionMode) throw new Error("runtime host does not expose permission mode reads");
        return this.port.getPermissionMode();
      },
      setPermissionMode: (request) => {
        if (!this.port.setPermissionMode) throw new Error("runtime host does not expose permission mode updates");
        return this.port.setPermissionMode(request);
      },
      getSessionUsage: (request) => this.port.getSessionUsage(request),
      getUsageQuota: (request) => this.port.getUsageQuota(request),
      getSigninPanel: () => this.port.getSigninPanel(),
      claimSignin: () => this.port.claimSignin(),
      getAccountStatus: (request) => this.port.getAccountStatus(request),
      listUserModelProviders: () => this.port.listUserModelProviders(),
      createUserModelProvider: (request) => this.port.createUserModelProvider(request),
      updateUserModelProvider: (request) => this.port.updateUserModelProvider(request),
      deleteUserModelProvider: (providerId) => this.port.deleteUserModelProvider(providerId),
      testUserModelProvider: (request) => this.port.testUserModelProvider(request),
      testUserModel: (request) => this.port.testUserModel(request),
      discoverUserModelsCandidate: (request) => this.port.discoverUserModelsCandidate(request),
      saveUserModelProviderCandidate: (request) => this.port.saveUserModelProviderCandidate(request),
      listProviderPresets: () => this.port.listProviderPresets(),
      getMiniMaxApiKeyStatus: () => this.port.getMiniMaxApiKeyStatus(),
      upsertMiniMaxApiKey: (request) => this.port.upsertMiniMaxApiKey(request),
      getCodexOAuthStatus: () => this.port.getCodexOAuthStatus(),
      getMiniMaxModelSource: () => this.port.getMiniMaxModelSource(),
      setMiniMaxModelSource: (request) => this.port.setMiniMaxModelSource(request),
      testUserModelCandidate: (request) => this.port.testUserModelCandidate(request),
      revealModelProviderApiKey: (request) => this.port.revealModelProviderApiKey(request),
      startCodexOAuthLogin: (request) => this.port.startCodexOAuthLogin(request),
      cancelCodexOAuthLogin: (request) => this.port.cancelCodexOAuthLogin(request),
      refreshModels: () => this.port.refreshModels(),
      requestCompaction: (request) => this.port.requestCompaction(request),
      invalidateAuth: () => this.port.invalidateAuth(),
    }, this.terminalManager);
    const factory = options.httpServerFactory ?? (() => createServer());
    this.httpServer = factory();
    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxMessageBytes,
    });
    this.httpServer.on("upgrade", this.#onUpgrade);
    this.httpServer.on("request", this.#onRequest);
    this.wsServer.on("connection", this.#onConnection);
  }

  #onRequest = (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void => {
    void this.#serveClient(request, response);
  };

  async #serveClient(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const requestHost = (request.headers.host ?? "").toLowerCase();
    const requestOrigin = (request.headers.origin ?? "").toLowerCase();
    if (!requestHost || !isLoopbackHost(requestHost.split(":")[0] ?? "")) {
      rejectHttp(response, 403, "Forbidden Host");
      return;
    }
    if (
      requestOrigin &&
      !isAllowedOrigin(requestOrigin, this.host, this.bound?.info.tcpPort)
    ) {
      rejectHttp(response, 403, "Forbidden Origin");
      return;
    }
    const url = parseHttpUrl(request.url);
    const presented = url?.searchParams.get("token");
    if (!this.dev && !credentialMatches(this.credential, presented)) {
      rejectHttp(response, 401, "Unauthorized");
      return;
    }
    if (!url) {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    if (request.method === "GET" && url.pathname === "/session-transfer") {
      await this.handleSessionTransfer(url, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/session-import") {
      await this.handleSessionImport(request, url, response);
      return;
    }
    // Ahead of the GET-only gate below because this route also answers HEAD:
    // `#serveWorkspaceFile` reports the byte range and content length with no
    // body. It sits after the loopback, origin and credential checks, so it
    // inherits them rather than re-implementing them.
    if (url.pathname === "/workspace-file") {
      await this.#serveWorkspaceFile(request, response, url);
      return;
    }
    if (request.method !== "GET") {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    const name =
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/archon"
        ? "index.html"
        : url.pathname === "/client.js"
          ? "client.js"
          : url.pathname === "/styles.css"
          ? "styles.css"
          : url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")
            ? url.pathname.slice(1)
          : undefined;
    if (!name) {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    try {
      const clientDir = findClientDirectory(this.clientDirOverride);
      const fileName = resolveClientAsset(clientDir, url.pathname, name);
      if (!fileName) {
        rejectHttp(response, 404, "Not Found");
        return;
      }
      let body = await readFile(fileName);
      if (name === "index.html") {
        const config = JSON.stringify({
          websocketUrl: `ws://${this.host}:${this.bound?.info.tcpPort ?? this.tcpPort}`,
          token: this.credential.token,
          dataDir: this.port.version().dataDir,
        }).replace(/</gu, "\\u003c");
        body = Buffer.from(body.toString("utf8").replace(
          "</head>",
          `<script>window.__WEBUI_CONFIG__=${config};</script></head>`,
        ));
      }
      response.writeHead(200, {
        "Content-Type": contentType(fileName),
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      rejectHttp(response, 404, "Not Found");
    }
  }

  /**
   * Serve a session as a file that `/session-import` can read back.
   *
   * An HTTP route rather than a WebSocket operation because the file is
   * unbounded: one real session on this machine serialises to 50 MB, and the
   * envelope carries a `payload_too_large` code. Producing the body here also
   * keeps it out of the browser's heap, which is the other half of why the
   * client-side export cannot be reused for this.
   *
   * The payload comes from the runtime rather than from here. An earlier
   * version read `messages.jsonl` off disk and walked `getMessages` for the
   * display side, which needed no port change -- and silently lost the
   * canonical receipts on roughly 1% of rows, because `getMessages` returns a
   * view prepared for rendering, not the stored record.
   */
  private async handleSessionTransfer(url: URL, response: ServerResponse): Promise<void> {
    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      rejectHttp(response, 400, "Bad Request");
      return;
    }
    // `getSession` rejects for an unknown id rather than returning an empty
    // result, so both the rejection and an empty `session` mean "no such
    // session". Letting the rejection reach the outer catch answered 500 for a
    // request that was simply asking about something that is not there.
    let session: WebuiSessionInfo;
    try {
      const found = await this.port.getSession({ id: sessionId });
      if (!found.session) {
        rejectHttp(response, 404, "Not Found");
        return;
      }
      session = found.session;
    } catch {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    try {
      const file = await this.port.exportSessionTransfer({ id: sessionId });
      const body = Buffer.from(`${JSON.stringify(file)}\n`, "utf8");
      const exportedAt = file.exportedAt || new Date().toISOString();
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.byteLength,
        "Content-Disposition":
          `attachment; filename*=UTF-8''${encodeURIComponent(webuiSessionTransferFileName(sessionId, session, exportedAt))}`,
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      rejectHttp(response, 500, "Internal Server Error");
    }
  }

  /**
   * Recreate a session from a transfer file.
   *
   * `WebuiCreateSessionRequest.name` is the *agent* to run under, not a title.
   * Both the agent and the working directory therefore come from the query
   * string -- the context the user is importing into -- and never from the
   * payload. A downloaded file is untrusted input: if its session block could
   * name an agent or a workspace, importing a file could aim a session at an
   * arbitrary directory on this machine, or ask for an agent that does not
   * exist and take the whole import down with it. The file contributes its
   * history and its title; the caller contributes who and where.
   *
   * The title is applied after the history lands. The session is created
   * first and the history written into it second, so a malformed payload
   * leaves nothing behind: the failure path deletes the session it just made
   * rather than leaving an empty shell in the sidebar for every bad file the
   * user tries.
   */
  private async handleSessionImport(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    let file: unknown;
    try {
      const raw = await readRequestBody(request);
      const parsed = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8"));
      // Accept either the bare transfer file or `{ file: <transfer file> }`,
      // so the client does not have to know which one this route prefers.
      file = (parsed as { readonly file?: unknown } | undefined)?.file ?? parsed;
    } catch {
      rejectHttp(response, 400, "Bad Request");
      return;
    }

    const agentName = url.searchParams.get("agentName")?.trim() || WEBUI_DEFAULT_IMPORT_AGENT;
    const workspaceDir = url.searchParams.get("workspaceDir")?.trim() || undefined;

    let sessionId: string;
    try {
      const created = await this.port.createSession({
        name: agentName,
        ...(workspaceDir ? { workspaceDir } : {}),
      });
      const id = created.sessionId ?? created.session?.sessionId;
      if (!id) throw new Error("Session creation returned no id");
      sessionId = id;
    } catch (error) {
      // The caller gets a status code, not a stack trace, so the reason has
      // to land somewhere or a 500 here is undiagnosable. Only the message:
      // the payload is untrusted and the error can quote it back.
      console.error(`[webui] session import could not create a session: ${describeError(error)}`);
      rejectHttp(response, 500, "Internal Server Error");
      return;
    }

    try {
      const result = await this.port.importSessionTransfer({
        targetSessionId: sessionId,
        sourceSessionId: readImportSourceId(file),
        file,
      });
      const title = readImportTitle(file);
      if (title) await this.port.updateSession({ id: result.sessionId, title });
      respondJson(response, 200, {
        sessionId: result.sessionId,
        canonicalMessages: result.canonicalMessages,
        displayMessages: result.displayMessages,
        revision: result.revision,
      });
    } catch (error) {
      await this.port.deleteSession({ id: sessionId }).catch(() => undefined);
      // "Not a transfer file at all" is the user's mistake and worth saying so;
      // anything else means the file parsed but could not be replayed.
      const foreign = (error as { readonly code?: unknown } | undefined)?.code === "not-a-transfer-file";
      console.error(`[webui] session import failed: ${describeError(error)}`);
      respondJson(response, foreign ? 400 : 422, {
        error: foreign ? "Not a session transfer file" : "Session import failed",
      });
    }
  }

  /**
   * Serve one workspace file as a byte-range-capable HTTP resource.
   *
   * Media preview and HTML preview both need a URL the browser streams rather
   * than a base64 payload inside a JSON reply: `<video>` and `<audio>` cannot
   * scrub a progress bar without `Range`, and inlining a large file inflates
   * every response that merely mentions it.
   *
   * Dispatch happens after the loopback, origin and credential checks above,
   * so this inherits them instead of re-implementing them: a workspace file is
   * served to whoever holds the per-start token and to nobody else.
   */
  async #serveWorkspaceFile(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      rejectHttp(response, 405, "Method Not Allowed");
      return;
    }
    const dir = url.searchParams.get("dir");
    const relative = url.searchParams.get("path");
    if (!dir || !relative) {
      rejectHttp(response, 400, "Missing dir or path");
      return;
    }
    const root = path.resolve(dir);
    const target = path.resolve(root, relative);
    // `path.resolve` has already collapsed every `..`, so what is left to
    // reject is the cases that survive it: an absolute `path`, or a sibling
    // that merely shares a prefix (`/repo-evil` against root `/repo`).
    if (target !== root && !target.startsWith(root + path.sep)) {
      rejectHttp(response, 403, "Forbidden Path");
      return;
    }
    let stats;
    try {
      stats = await stat(target);
    } catch {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    if (!stats.isFile()) {
      rejectHttp(response, 404, "Not Found");
      return;
    }
    const total = stats.size;
    const range = parseByteRange(request.headers.range, total);
    if (range === "invalid") {
      response.writeHead(416, { "Content-Range": `bytes */${total}` });
      response.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    const headers: Record<string, string> = {
      "Content-Type": workspaceContentType(target),
      "Content-Length": String(end - start + 1),
      // A partial body is only correct for the bytes it was cut from, so a
      // later edit must not let a cached range be replayed against.
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      // Without allow-same-origin the document runs in an opaque origin, so
      // script inside a previewed artifact cannot read the page that framed
      // it — including `window.__WEBUI_CONFIG__.token`, which would hand it
      // the whole WebUI session.
      "Content-Security-Policy": workspaceContentType(target).startsWith("text/html")
        ? "sandbox allow-scripts"
        : "sandbox",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    // A zero-byte file has no last byte, so `end` above is -1 and there is no
    // legal `end` to hand a read stream: `createReadStream` rejects it with
    // ERR_OUT_OF_RANGE, which rejects this promise and — since the caller only
    // `void`s the dispatch — surfaces as an unhandled rejection and takes the
    // process down. The `Content-Length: 0` already sent above is the whole
    // body, so just end the response.
    if (total === 0) {
      response.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(target, { start, end });
      stream.on("error", () => {
        response.destroy();
        resolve();
      });
      stream.on("close", resolve);
      stream.pipe(response);
    });
  }

  /**
   * Bind the server and resolve once it is listening. Resolves with the
   * address the kernel actually allocated so tests can reach it.
   */
  start(): Promise<WebuiServiceInfo> {
    if (this.startedPromise) return this.startedPromise;
    this.startedPromise = new Promise<WebuiServiceInfo>((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        try {
          const address = this.httpServer.address();
          if (!address || typeof address === "string")
            throw new Error("WebUI service bound to a non-TCP socket");
          const tcpPort = (address as AddressInfo).port;
          const info: WebuiServiceInfo = {
            host: this.host,
            tcpPort,
            protocolVersion: WEBUI_PROTOCOL_VERSION,
            credential: this.credential,
            boundUrl: `ws://${this.host}:${tcpPort}`,
          };
          this.bound = { info };
          resolve(info);
        } catch (error) {
          reject(error);
        }
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(this.tcpPort, this.host);
    });
    return this.startedPromise;
  }

  info(): WebuiServiceInfo {
    if (!this.bound) throw new Error("WebUI service is not started");
    return this.bound.info;
  }

  /**
   * Stop accepting new operations, drain every connection, then close
   * the harness port. The order is the one step 13 of the assembly
   * checklist requires: refuse new work first, then release resources,
   * then tear down the host.
   */
  async close(): Promise<void> {
    this.terminalManager.disposeBySession();
    if (!this.accepting && !this.bound) return;
    this.accepting = false;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // Force-terminate every connection before the server closes; otherwise
    // `wsServer.close()` waits for the client to ack the close handshake
    // and can hang for the duration of the platform TCP timeout.
    for (const connection of this.connections) {
      this.connectionSignals.get(connection)?.abort();
      try {
        connection.terminate();
      } catch {
        // ignore: the connection is already torn down.
      }
    }
    this.connections.clear();
    this.connectionSignals.clear();
    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
    await this.port.close();
  }

  #onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (!this.accepting) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          "Connection: close\r\n" +
          "\r\n",
      );
      socket.destroy();
      return;
    }
    const url = parseWebSocketUrl(request.url);
    if (!url) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const urlHost = url.hostname.toLowerCase();
    const requestHost = (request.headers.host ?? "").toLowerCase();
    const requestOrigin = (request.headers.origin ?? "").toLowerCase();
    if (!requestHost || !isLoopbackHost(requestHost.split(":")[0] ?? "")) {
      rejectUpgrade(socket, 403, "Forbidden Host");
      return;
    }
    if (urlHost !== "127.0.0.1" && urlHost !== "localhost") {
      rejectUpgrade(socket, 403, "Forbidden Host");
      return;
    }
    if (
      requestOrigin &&
      !isAllowedOrigin(requestOrigin, this.host, this.bound?.info.tcpPort)
    ) {
      rejectUpgrade(socket, 403, "Forbidden Origin");
      return;
    }
    const presented = url.searchParams.get("token");
    if (!this.dev && !credentialMatches(this.credential, presented)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit("connection", ws, request);
    });
  };

  #onConnection = (ws: WebSocket): void => {
    if (!this.accepting) {
      ws.close(1001, "service shutting down");
      return;
    }
    this.connections.add(ws);
    this.connectionAlive.set(ws, true);
    if (this.heartbeatTimer === undefined) {
      this.heartbeatTimer = setInterval(() => {
        for (const connection of this.connections) {
          if (this.connectionAlive.get(connection) === false) {
            connection.terminate();
            continue;
          }
          this.connectionAlive.set(connection, false);
          try {
            connection.ping();
          } catch {
            connection.terminate();
          }
        }
      }, this.webSocketHeartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
    const connectionController = new AbortController();
    this.connectionSignals.set(ws, connectionController);
    ws.on("pong", () => this.connectionAlive.set(ws, true));
    ws.on("close", () => {
      this.connections.delete(ws);
      connectionController.abort();
      this.connectionSignals.delete(ws);
    });
    ws.on("error", () => {
      this.connections.delete(ws);
      connectionController.abort();
      this.connectionSignals.delete(ws);
    });
    ws.on("message", (raw, isBinary) => {
      void this.#handleMessage(ws, raw, isBinary);
    });
  };

  async #handleMessage(
    ws: WebSocket,
    raw: import("ws").RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      sendFrame(
        ws,
        errorFrame(
          "anonymous",
          WebuiErrorCode.invalidEnvelope,
          "binary frames are not accepted",
        ),
      );
      return;
    }
    const text = raw.toString("utf8");
    if (Buffer.byteLength(text, "utf8") > this.maxMessageBytes) {
      sendFrame(
        ws,
        errorFrame(
          "anonymous",
          WebuiErrorCode.payloadTooLarge,
          "frame exceeds the message size limit",
        ),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendFrame(
        ws,
        errorFrame(
          "anonymous",
          WebuiErrorCode.invalidEnvelope,
          "frame is not valid JSON",
        ),
      );
      return;
    }
    await dispatchWebuiFrame(
      ws,
      parsed,
      this.operations,
      this.accepting,
      () => this.connectionSignals.get(ws)?.signal,
    );
  }
}


function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const reasonLine = reason.replace(/[\r\n]/gu, " ");
  socket.write(`HTTP/1.1 ${status} ${reasonLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function rejectHttp(
  response: import("node:http").ServerResponse,
  status: number,
  reason: string,
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    Connection: "close",
  });
  response.end(reason);
}

/**
 * The import body is a whole session and real ones run to tens of megabytes,
 * so the cap has to clear the largest export the export route can produce
 * while still refusing a body that is not a session file.
 */
const WEBUI_MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/** The agent an import lands under when the caller names none. */
const WEBUI_DEFAULT_IMPORT_AGENT = "main";

/**
 * `maxBytes` is a parameter rather than a constant so the cap can be tested
 * without allocating a quarter of a gigabyte in a unit test.
 */
export function readRequestBody(
  request: IncomingMessage,
  maxBytes: number = WEBUI_MAX_IMPORT_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.byteLength,
    "Cache-Control": "no-store",
  });
  response.end(encoded);
}

function readImportSession(file: unknown): Record<string, unknown> | undefined {
  const session = (file as { readonly session?: unknown } | undefined)?.session;
  return typeof session === "object" && session !== null && !Array.isArray(session)
    ? (session as Record<string, unknown>)
    : undefined;
}

/** Trimmed, length-capped strings only -- the payload is untrusted. */
function readImportString(file: unknown, key: "title" | "agentName" | "workspaceDir"): string | undefined {
  const value = readImportSession(file)?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function readImportTitle(file: unknown): string | undefined {
  return readImportString(file, "title");
}

function readImportSourceId(file: unknown): string | undefined {
  const value = readImportSession(file)?.sessionId;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

function parseHttpUrl(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return undefined;
  }
}

function contentType(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".woff2")) return "font/woff2";
  if (name.endsWith(".woff")) return "font/woff";
  if (name.endsWith(".ttf")) return "font/ttf";
  return name.endsWith(".css")
    ? "text/css; charset=utf-8"
    : name.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
}

function resolveClientAsset(
  clientDir: string,
  pathname: string,
  fallbackName: string,
): string | undefined {
  if (fallbackName === "index.html" || fallbackName === "client.js" || fallbackName === "styles.css")
    return path.join(clientDir, fallbackName);
  const prefix = pathname.startsWith("/assets/")
    ? "/assets/"
    : pathname.startsWith("/fonts/")
      ? "/fonts/"
      : undefined;
  if (!prefix) return undefined;
  const relativeName = pathname.slice(prefix.length);
  if (!relativeName || relativeName.includes("\\") || relativeName.split("/").includes(".."))
    return undefined;
  const candidate = path.resolve(clientDir, prefix.slice(1), relativeName);
  const root = path.resolve(clientDir) + path.sep;
  return candidate.startsWith(root) ? candidate : undefined;
}

function findClientDirectory(override: string | undefined): string {
  // Caller-supplied override wins so tests pin the served directory and the
  // dev preview launcher can point at the built artifacts; if it does not
  // exist we fall back to the discovery below rather than 404 the page.
  if (override && existsSync(override)) return override;
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client"),
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../dist-webui/client",
    ),
  ];
  // The built server uses the first path; source tests and development use the second.
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

function parseWebSocketUrl(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  try {
    const base = "ws://127.0.0.1";
    return new URL(rawUrl, base);
  } catch {
    return undefined;
  }
}

const WORKSPACE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".csv": "text/csv; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function workspaceContentType(name: string): string {
  return WORKSPACE_MEDIA_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

function parseByteRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return undefined;
  // No byte of a zero-length representation can be selected, so any range
  // against one is unsatisfiable. Handled here rather than in the two
  // branches below because the suffix branch would otherwise answer with
  // `{start: 0, end: -1}` — a range whose header cannot even be spelled.
  if (size === 0) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    // Suffix form `bytes=-500`: the final N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return "invalid";
  if (start >= size) return "invalid";
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isLoopbackBindAddress(host: string): boolean {
  // The service binds loopback only. `0.0.0.0` and any LAN address are
  // rejected before the HTTP server is constructed so the misconfiguration
  // surfaces at boot, not at the first upgrade.
  if (isLoopbackHost(host)) return true;
  // IPv6 zone IDs (`fe80::1%lo0`, `::1%1`) are loopback-shaped for the
  // purpose of the bind; strip the zone before re-checking.
  const stripped = host.split("%")[0] ?? host;
  return isLoopbackHost(stripped);
}

function isAllowedOrigin(origin: string, host: string, port?: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  if (port === undefined) return true;
  const portNumber = parsed.port
    ? Number(parsed.port)
    : defaultPortForProtocol(protocol);
  return portNumber === port && parsed.hostname === host;
}

function defaultPortForProtocol(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}
