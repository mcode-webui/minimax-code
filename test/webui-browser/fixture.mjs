export function installFixtureTransport() {
  const sessions = [
    { id: "A", title: "绿川椒 Demo 订货小程序" },
    { id: "B", title: "灵动岛卡住问题" },
  ].map(({ id, title }, index) => ({
    sessionId: id,
    agentName: `synthetic-${id}`,
    title,
    createdAt: 1_700_000_000_000 + index,
    // B is the newer one on purpose: the rail orders by `updatedAt`, newest
    // first, and a fixture where both rows tie would let an ordering assertion
    // pass for the wrong reason -- the same trap the view-sorting unit test
    // fell into once already.
    updatedAt: 1_700_000_000_000 + index,
    workspaceDir: "/synthetic/workspace",
  }));
  // The rail builds its project rows from this, not from the session list:
  // `WebuiProjectList` groups `page.sessions` under the records here, so an
  // empty answer renders no project row, no session row, and no search box.
  // Returning `[]` is a valid server answer and a useless fixture.
  const projects = [
    {
      projectId: 1,
      projectKind: "workspace",
      workspaceDir: "/synthetic/workspace",
      pinned: false,
      hidden: false,
      orderIndex: 0,
      recentAtMs: 1_700_000_000_001,
      latestActivityAtMs: 1_700_000_000_001,
      sessionCount: sessions.length,
    },
  ];
  const child = {
    sessionId: "C",
    agentName: "synthetic-C",
    title: "子任务 C",
    createdAt: 1_700_000_000_002,
    updatedAt: 1_700_000_000_002,
    workspaceDir: "/synthetic/workspace",
    parentSessionId: "A",
  };
  // A child, so the rail's third row shape exists at all. It is deliberately
  // NOT in `sessions`: the rail draws child rows from the tree and only after
  // the parent is expanded, so leaving it out of the list keeps every count,
  // ordering and search assertion in the other specs exactly as they were.
  // With the tree answering `[]` the disclosure button never renders and the
  // child row is unreachable in a browser -- the same "valid server answer,
  // useless fixture" trap the project list was.
  let tree = {
    sessions: [{ session: sessions[0], childSessions: [child] }],
    hasMore: false,
  };
  const pages = {
    A: { messages: [{ msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 }], hasMore: false },
    B: { messages: [{ msgId: "history-B", role: "user", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 }], hasMore: false },
  };
  const pending = [];
  const delayed = [];
  const held = [];
  // See the constructor: open = sockets behave normally; closed = new sockets
  // die on arrival.
  let socketGateOpen = true;
  // The questionnaire the pending-questionnaire poll will answer. Mutable for
  // the same reason `setPage` is: the composer polls `getPendingQuestionnaire`
  // on mount and on every session switch, so a test that wants to stage a
  // questionnaire has no other way to say what the server answers on the NEXT
  // poll. `undefined` keeps the old "no pending questionnaire" answer.
  let questionnaire;
  // Per-action results for the plugin-management facade. The panel asks for
  // one action at a time (`{action, input}`), so a test stages exactly the
  // listing it wants (an MCP server list with connection states, say) and
  // every other action keeps the empty default.
  const pluginManagementResults = {};
  // Account login state machine for the three login operations. `begin`
  // starts "pending" with a deterministic prompt; a test flips the state
  // (authenticated / error) with setAccountLoginState to drive the dialog's
  // poll — the real server observes the credential; the fixture observes
  // the test.
  let accountLoginState = { state: "idle" };
  let accountLoginSequence = 0;
  // The usage quota answer, overridable so a test can stage the signed-out
  // block (`{}` — the default — has no signedIn field and reads as signed
  // in but quota-less, not as signed out).
  let usageQuotaResult = {};
  // The composer's permission-mode write is verified by reading it back
  // (`setPermissionMode` then `getPermissionMode`, compared in
  // `SessionComposer.changePermissionMode`). With the old pair — a
  // no-op write and a `getPermissionMode` that always answered "default" —
  // every mode other than `default` raised 「授权模式未能保存，请重试」, so the
  // read-back could never pass. Store it, so the verification can pass.
  let permissionMode = "default";
  // A seven-day sign-in panel, shaped exactly like the server's
  // `validateSigninPanel` output. The empty default has no `days`, and
  // `SigninProgress` does `[...days]` with no guard, so a fixture that answered
  // `{}` crashed the whole app the first time a human opened the sign-in row.
  // Day 3 is today and claimable; days 1-2 are behind us and claimed; 4-7 are
  // still ahead. `SigninDayStatus`: 1 Upcoming, 2 Claimable, 3 Claimed.
  const signinPanel = {
    scene: 2,
    days: Array.from({ length: 7 }, (_, index) => {
      const dayNo = index + 1;
      return {
        day_no: dayNo,
        points: 10,
        bonus_points: dayNo === 3 ? 400 : 0,
        is_today: dayNo === 3,
        status: dayNo < 3 ? 3 : dayNo === 3 ? 2 : 1,
      };
    }),
  };
  let activeTurn;
  const requests = [];
  const sockets = new Set();

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const matches = (body, condition) => Object.entries(condition).every(([key, value]) => body?.[key] === value);
  const responseFor = (operation, body) => {
    if (operation === "listSessions") return { sessions, hasMore: false };
    if (operation === "getSessionTree") return clone(tree);
    if (operation === "listVisibleProjects") return projects;
    if (operation === "getMessages") {
      if (body?.before) return { messages: [{ msgId: `older-${body.before}`, role: "user", msgContent: "Older synthetic page", timestamp: 1_699_999_999_999 }], hasMore: false };
      return pages[body?.id] ?? { messages: [], hasMore: false };
    }
    if (operation === "version") return { version: "browser-fixture" };
    if (operation === "listSkills") return { skills: [] };
    if (operation === "listPendingPermissions") return { requests: [] };
    if (operation === "getActiveTurn") return activeTurn;
    if (operation === "getPendingQuestionnaire") return questionnaire ? { request: questionnaire } : {};
    if (operation === "beginAccountLogin") {
      accountLoginState = {
        state: "pending",
        prompt: {
          userCode: "TEST-CODE",
          verificationUri: "https://example.invalid/device",
          verificationUriComplete: "https://example.invalid/device?code=TEST-CODE",
          expiresAtMs: Date.now() + 600_000,
        },
      };
      return clone(accountLoginState);
    }
    if (operation === "getAccountLoginStatus") return clone(accountLoginState);
    if (operation === "cancelAccountLogin") {
      accountLoginState = { state: "idle" };
      return { ok: true };
    }
    if (operation === "pluginManagement") {
      const action = typeof body?.action === "string" ? body.action : "";
      return pluginManagementResults[action] ?? {};
    }
    if (operation === "dismissQuestionnaire") return { ok: true };
    if (operation === "replyQuestionnaire") return { ok: true };
    if (operation === "listQueueMessages") return { items: [] };
    if (operation === "listModels" || operation === "loadProjects") return [];
    if (operation === "getUsageQuota") return clone(usageQuotaResult);
    if (operation === "isGoalEnabled") return false;
    if (operation === "getPermissionMode") return { mode: permissionMode };
    if (operation === "setPermissionMode") {
      if (typeof body?.mode === "string") permissionMode = body.mode;
      return { mode: permissionMode };
    }
    // A directory listing with an EMPTY `entries` array, not the `{}` default:
    // `WebuiWorkspaceDirectoryBrowser` reads `listing?.entries.length` and the
    // missing array threw `Cannot read properties of undefined (reading
    // 'length')` on every open of the workspace picker.
    if (operation === "browseWorkspaceDirs")
      return {
        dir: typeof body?.dir === "string" ? body.dir : "",
        entries: [],
        truncated: false,
      };
    if (operation === "getSigninPanel") return clone(signinPanel);
    if (operation === "getSessionUsage") return {};
    return {};
  };

  class FixtureWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      this.request = undefined;
      // The gate simulates a dead server for NEW connections: the socket
      // errors and closes without ever opening, which is exactly what a
      // real WebSocket to a downed backend does. Existing sockets are
      // unaffected until `dropAll()` closes them — that pair is what an
      // "idle disconnect" is: everything was healthy, then the server went
      // away between turns.
      if (!socketGateOpen) {
        queueMicrotask(() => {
          this.emit("error", {});
          this.close();
        });
        return;
      }
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
        // The real server registers its watcher when it *answers* the
        // request, and the client treats that answer as the signal that it
        // is safe to ask "is a turn running?". A fixture that accepted the
        // request silently would make every readiness-gated recovery path
        // untestable.
        queueMicrotask(() =>
          this.emit("message", {
            data: JSON.stringify({
              protocolVersion: 1,
              kind: "response",
              requestId: frame.requestId,
              body: { ok: true },
            }),
          }),
        );
        return;
      }
      if (["sendMessage", "resumeSession"].includes(frame.operation)) {
        this.isStream = true;
        // The hold/delay check comes BEFORE the auto-answer so a stream
        // operation can be parked too: the transient states between a send
        // and its answer (the client's `reconnecting` window, most notably)
        // are otherwise unobservable — the auto-answer closes them within a
        // microtask. A held stream still marks `isStream`, so after
        // `resolve(...)` the socket receives `emitStream` frames like any
        // other stream socket.
        const isHeld = held.some((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
        const waitIndex = delayed.findIndex((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
        if (isHeld || waitIndex >= 0) {
          if (!isHeld) delayed.splice(waitIndex, 1);
          pending.push({ operation: frame.operation, body: clone(frame.body ?? {}), resolve: (result) => this.respond(frame, result) });
          return;
        }
        // The server acknowledges a stream before pumping it. Stream
        // consumers ignore the acknowledgement and act on `event` frames,
        // so the fixture sends it to keep the wire shape faithful.
        this.respond(frame, { stream: true });
        this.streamFrame({ dataJson: JSON.stringify({ type: "heartbeat" }) });
        return;
      }
      if (frame.operation === "createSession") {
        const created = { sessionId: "created-C", agentName: "synthetic-created", title: "Synthetic created", createdAt: 1_700_000_000_010, updatedAt: 1_700_000_000_010, workspaceDir: "/synthetic/workspace" };
        sessions.push(created);
        queueMicrotask(() => this.respond(frame, created));
        return;
      }
      const isHeld = held.some((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
      const waitIndex = delayed.findIndex((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
      if (isHeld || waitIndex >= 0) {
        if (!isHeld) delayed.splice(waitIndex, 1);
        pending.push({ operation: frame.operation, body: clone(frame.body ?? {}), resolve: (result) => this.respond(frame, result) });
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
    // Holds EVERY matching request, not just the next one. A session switch
    // fans out into several concurrent `getMessages` for the same session
    // (transcript first page, context usage, workspace history progress), so
    // `delayNext` alone does not decide which one the test is actually
    // blocking — the transcript's own request is the second of the three.
    delayEvery(operation, condition) { held.push({ operation, condition }); },
    setPage(sessionId, page) { pages[sessionId] = clone(page); },
    // The tree projection the rail and the composer both read. Mutable for the
    // same reason `setPage` is: the app fetches it on boot, so a test that only
    // wants to poison it later has no other way to say what the server answers
    // on the NEXT request.
    setTree(next) { tree = clone(next); },
    // The server's authoritative view of what is running right now. A
    // client whose `session.start` was missed reads this to recover.
    setActiveTurn(turn) { activeTurn = turn ? clone(turn) : undefined; },
    // The pending questionnaire the next poll answers. The goal auto-reply
    // scheduler lives in the real runtime, not here: the fixture's transport
    // is inert on purpose, so a staged questionnaire stays pending until the
    // test answers, dismisses, or replaces it.
    setQuestionnaire(request) { questionnaire = request ? clone(request) : undefined; },
    setAccountLoginState(state) { accountLoginState = clone(state); },
    setUsageQuotaResult(result) { usageQuotaResult = clone(result); },
    setPluginManagementResult(action, result) {
      pluginManagementResults[action] = result === undefined ? undefined : clone(result);
    },
    // Kill every live socket (the "server went away" moment) and/or decide
    // whether new connections may form. Between a dropAll() and reopening
    // the gate, the client is fully disconnected — with no turn running,
    // which is the idle-disconnect shape.
    gateSockets(open) { socketGateOpen = open; },
    dropAll() { for (const socket of [...sockets]) if (!socket.closed) socket.close(); },
    resolve(operation, condition, result) {
      const index = pending.findIndex((entry) => entry.operation === operation && matches(entry.body, condition));
      if (index < 0) throw new Error(`No pending fixture request: ${operation} ${JSON.stringify(condition)}`);
      pending.splice(index, 1)[0].resolve(clone(result));
    },
    resolveAllPending(operation, condition, result) {
      let released = 0;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const entry = pending[index];
        if (entry.operation !== operation || !matches(entry.body, condition)) continue;
        pending.splice(index, 1)[0].resolve(clone(result));
        released += 1;
      }
      return released;
    },
    emitEvent(event) {
      for (const socket of sockets) if (socket.isWatcher && !socket.closed)
        socket.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "event", requestId: socket.request.requestId, body: clone(event) }) });
    },
    emitStream(sessionId, streamFrame) {
      for (const socket of sockets) if (socket.isStream && socket.request?.body?.id === sessionId && !socket.closed) socket.streamFrame(streamFrame);
    },
    // Simulate a mid-turn socket drop. The transport rejects the stream
    // promise, which is what drives `runWebuiStreamLoop` into its
    // `resumeSession({ afterCursor })` path.
    dropStream(sessionId) {
      for (const socket of sockets) if (socket.isStream && socket.request?.body?.id === sessionId && !socket.closed) socket.emit("close", {});
    },
    activeStreamSessionIds() {
      return [...sockets]
        .filter((socket) => socket.isStream && !socket.closed)
        .map((socket) => socket.request?.body?.id);
    },
  };
  window.WebSocket = FixtureWebSocket;
}

export const fixtureTransportInit = `(${installFixtureTransport.toString()})();`;
