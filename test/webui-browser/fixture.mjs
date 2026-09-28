export function installFixtureTransport() {
  const sessions = ["A", "B"].map((sessionId, index) => ({
    sessionId,
    agentName: `synthetic-${sessionId}`,
    title: `Synthetic ${sessionId}`,
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    workspaceDir: "/synthetic/workspace",
  }));
  const pages = {
    A: { messages: [{ msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 }], hasMore: false },
    B: { messages: [{ msgId: "history-B", role: "user", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 }], hasMore: false },
  };
  const pending = [];
  const delayed = [];
  const requests = [];
  const sockets = new Set();

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const matches = (body, condition) => Object.entries(condition).every(([key, value]) => body?.[key] === value);
  const responseFor = (operation, body) => {
    if (operation === "listSessions") return { sessions, hasMore: false };
    if (operation === "getSessionTree") return { sessions: [], hasMore: false };
    if (operation === "listVisibleProjects") return [];
    if (operation === "getMessages") {
      if (body?.before) return { messages: [{ msgId: `older-${body.before}`, role: "user", msgContent: "Older synthetic page", timestamp: 1_699_999_999_999 }], hasMore: false };
      return pages[body?.id] ?? { messages: [], hasMore: false };
    }
    if (operation === "version") return { version: "browser-fixture" };
    if (operation === "listSkills") return { skills: [] };
    if (operation === "listPendingPermissions") return { requests: [] };
    if (operation === "listQueueMessages") return { items: [] };
    if (operation === "listModels" || operation === "loadProjects") return [];
    if (operation === "getUsageQuota") return {};
    if (operation === "isGoalEnabled") return false;
    if (operation === "getPermissionMode") return { mode: "default" };
    if (operation === "getSessionUsage") return {};
    return {};
  };

  class FixtureWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      this.request = undefined;
      sockets.add(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(serialized) {
      const frame = JSON.parse(serialized);
      this.request = frame;
      requests.push({ operation: frame.operation, body: clone(frame.body ?? {}) });
      if (frame.operation === "watchEvents") {
        this.isWatcher = true;
        return;
      }
      if (["sendMessage", "resumeSession"].includes(frame.operation)) {
        this.isStream = true;
        this.streamFrame({ dataJson: JSON.stringify({ type: "heartbeat" }) });
        return;
      }
      if (frame.operation === "createSession") {
        const created = { sessionId: "created-C", agentName: "synthetic-created", title: "Synthetic created", createdAt: 1_700_000_000_010, updatedAt: 1_700_000_000_010, workspaceDir: "/synthetic/workspace" };
        sessions.push(created);
        queueMicrotask(() => this.respond(frame, created));
        return;
      }
      const waitIndex = delayed.findIndex((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
      if (waitIndex >= 0) {
        const [entry] = delayed.splice(waitIndex, 1);
        pending.push({ operation: frame.operation, body: clone(frame.body ?? {}), resolve: (result) => this.respond(frame, result) });
        entry.hit?.();
        return;
      }
      queueMicrotask(() => this.respond(frame, responseFor(frame.operation, frame.body)));
    }
    respond(request, body) {
      if (this.closed) return;
      this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "response", requestId: request.requestId, body }) });
    }
    streamFrame(body) {
      if (!this.closed && this.request)
        this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "event", requestId: this.request.requestId, body }) });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      sockets.delete(this);
      this.emit("close", {});
    }
  }

  window.__fixture = {
    requests,
    pending,
    delayNext(operation, condition) { delayed.push({ operation, condition }); },
    setPage(sessionId, page) { pages[sessionId] = clone(page); },
    resolve(operation, condition, result) {
      const index = pending.findIndex((entry) => entry.operation === operation && matches(entry.body, condition));
      if (index < 0) throw new Error(`No pending fixture request: ${operation} ${JSON.stringify(condition)}`);
      pending.splice(index, 1)[0].resolve(clone(result));
    },
    emitEvent(event) {
      for (const socket of sockets) if (socket.isWatcher && !socket.closed)
        socket.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "event", requestId: socket.request.requestId, body: clone(event) }) });
    },
    emitStream(sessionId, streamFrame) {
      for (const socket of sockets) if (socket.isStream && socket.request?.body?.id === sessionId && !socket.closed) socket.streamFrame(streamFrame);
    },
  };
  window.WebSocket = FixtureWebSocket;
}

export const fixtureTransportInit = `(${installFixtureTransport.toString()})();`;
