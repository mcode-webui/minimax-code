export function installFixtureTransport() {
  const sessions = [
    { id: "A", title: "Synthetic session A" },
    { id: "B", title: "Synthetic session B" },
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
  let projects = [
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
  // ADR 0027: the scheduled-task fixture. Three rows on purpose — one this client holds, one it
  // does not, one paused — so the panel's three labels are all visible instead of one row that would
  // render the same whatever the labels said. The mutations below change this list, which is why it
  // is `let`: the panel re-reads after every write, and the browser test asserts the new state.
  let cronTasks = [
    {
      cronId: "cron-fixture-held",
      name: "队列摘要",
      agentName: "synthetic-A",
      prompt: "Summarize the queue.",
      enabled: true,
      heldByThisClient: true,
      schedule: { kind: "recurring", expression: "0 9 * * *" },
      sessionTarget: { mode: "new" },
      project: null,
      model: null,
      nextRunAtMs: 1_700_003_600_000,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
    },
    {
      cronId: "cron-fixture-unheld",
      name: "工作区周报",
      agentName: "synthetic-A",
      prompt: "Write the weekly report.",
      enabled: true,
      heldByThisClient: false,
      schedule: { kind: "recurring", expression: "*/30 * * * *" },
      sessionTarget: { mode: "new" },
      project: null,
      model: null,
      nextRunAtMs: 1_700_001_800_000,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
    },
    {
      cronId: "cron-fixture-paused",
      name: "队列周报",
      agentName: "synthetic-A",
      prompt: "Sync overnight.",
      enabled: false,
      heldByThisClient: false,
      schedule: { kind: "recurring", expression: "0 2 * * *" },
      sessionTarget: { mode: "new" },
      project: null,
      model: null,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
    },
  ];
  let cronTaskSeq = 0;
  // Run history for the scheduled-task fixture. The manual trigger below appends to it, so the
  // browser test can assert what the panel shows after asking for a run.
  // One run that the schedule produced, so the journey shows a 定时 row beside the 手动 one the
  // run-now action creates. A timer is not what this fixture is for; the label is.
  let cronRuns = [
    {
      runId: "run-fixture-scheduled",
      cronId: "cron-fixture-held",
      triggerSource: "scheduled",
      status: "delivered",
      sessionId: "A",
      createdAtMs: 1_700_002_400_000,
      deliveredAtMs: 1_700_002_400_400,
    },
  ];
  let cronRunSeq = 0;
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
  // The workspace panel renders its tree on open, so an unanswered read is not
  // an option. Settable because a surface's layout has to be measured with the
  // content extremes it can actually show — an empty tree, one file, the most it
  // lists, and the longest name — not only with a representative pair of rows.
  let workspaceFileTree = [
    { path: "a.ts", name: "a.ts", type: "file", size: 120, modifiedAt: 1_700_000_000_000 },
    { path: "src", name: "src", type: "directory", children: [] },
  ];
  // The composer's permission-mode write is verified by reading it back
  // (`setPermissionMode` then `getPermissionMode`, compared in
  // `SessionComposer.changePermissionMode`). With the old pair — a no-op
  // write and a `getPermissionMode` that always answered "default" — every
  // mode other than `default` raised 「授权模式未能保存，请重试」, so the
  // read-back could never pass. Store it, so the verification can pass.
  let permissionMode = "default";
  // A seven-day sign-in panel, shaped exactly like the server's
  // `validateSigninPanel` output. The empty default has no `days`, and the
  // sign-in view does `[...days]` with no guard, so a fixture that answered
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
  // The custom-provider surface. `listUserModelProviders` answers the closed read
  // view the models workflow consumes, so a spec seeds the providers it wants. The
  // candidate operations answer synthetic success and are asserted through
  // `requests`: after a write the workflow reloads the truth, so a fixture that
  // mutated its own list would be asserting a server the client cannot have.
  let modelProviders = [];
  let providerPresets = [];
  let candidateTestResult = { ok: true };
  let candidateSaveResult = { success: true, providerId: "provider-synthetic" };
  let discoveredModels = [];
  let models = [];
  let activeTurn;
  // Archived session ids. `archiveSession` is one operation for both directions
  // (`{id}` archives, `{id, archived: false}` takes it back), and the archived
  // page is the same `listSessions` call with `onlyArchived`.
  let archivedIds = [];
  // The review families' answers. T10's consumers read them: the transcript's diff
  // card asks for a turn's diff and can revert it, and the workspace review panel
  // asks for the working tree's summary.
  let turnDiff = {
    status: "active",
    changeSetId: "cs-1",
    sourceMessageId: "assistant-diff",
    canUndo: true,
    canReapply: false,
    fileChanges: [{ file: "a.ts", additions: 2, deletions: 1 }],
  };
  const workspaceReviewSummary = {
    repositoryId: "repo-1",
    reviewSnapshotId: "snap-1",
    files: [{ fileId: "a.ts", path: "a.ts", additions: 2, deletions: 1 }],
    totals: { files: 1, additions: 2, deletions: 1 },
  };
  // The browser family.
  //
  // The workspace's browser half -- the strip's web tabs, the toolbar, the
  // page -- is driven entirely by the runtime's answers. A fixture that cannot
  // answer the browser's operations leaves that half untested: the launcher
  // cannot open a tab, the toolbar never renders, and the page never arrives.
  //
  // So the fixture answers them with a synthetic browser: pages it paints
  // itself, tabs a test stages, and a run's selection it marks. What the
  // fixture does NOT do is prove the runtime's behaviour -- the real browser
  // is the isolated Chromium, and `browser-bridge-real-*.spec.ts` and the
  // runtime's own integration tests are where that is proven. What the
  // fixture proves is the client's half: that the panel draws a window, that
  // the strip and the toolbar follow what the runtime published, and that a
  // gesture lands on the page in front.
  const browserSurface = "isolated-chromium";
  const browserBrowserId = "browser-fixture";
  let browserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    fullCdp: false,
  };
  /** The session's web tabs, as the runtime publishes them. */
  let browserTabs = [];
  let browserTabSequence = 0;
  let browserFrameSequence = 0;

  const browserTargetId = (targetId, generation = 1) => ({
    surface: browserSurface,
    browserId: browserBrowserId,
    targetId,
    generation,
  });

  /** A web tab in the runtime's shape, from the short form a test writes. */
  const toBrowserTab = (entry) => ({
    id: String(entry.id ?? `tab-${(browserTabSequence += 1)}`),
    target: browserTargetId(String(entry.id ?? `tab-${browserTabSequence}`), entry.generation ?? 1),
    title: entry.title ?? "",
    url: entry.url ?? "",
    selected: entry.selected === true,
  });

  const browserSnapshot = () => ({
    surface: browserSurface,
    tabs: browserTabs.map((tab) => clone(tab)),
  });

  const browserTargetList = () => ({
    surface: browserSurface,
    targets: browserTabs.map((tab) => ({
      id: clone(tab.target),
      title: tab.title,
      url: tab.url,
      status: "open",
      selected: tab.selected,
    })),
  });

  /**
   * A page the fixture paints itself.
   *
   * The panel draws a page as an image, so the fixture has to hand it one. A
   * one-pixel image would prove that the image path works and nothing else: a
   * screenshot of the panel would show a grey box. So the page is drawn -- the
   * tab's title and url on a white sheet -- and a test that looks at the
   * panel sees the page it asked for.
   */
  const paintBrowserPage = (title, url) => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#eef0f2";
    context.fillRect(0, 0, canvas.width, 36);
    context.fillStyle = "#5b6473";
    context.font = "13px sans-serif";
    context.fillText(url || "about:blank", 12, 23);
    context.fillStyle = "#1f2328";
    context.font = "26px sans-serif";
    context.fillText(title || "about:blank", 24, 110);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  };

  /**
   * Pushes the tab snapshot to every watcher of the surface.
   *
   * The strip and the panel read the same publication, so a fixture that
   * answered one and not the other would show a browser whose tabs disagree
   * with themselves.
   */
  const publishBrowserTabs = () => {
    const snapshot = browserSnapshot();
    for (const socket of sockets) {
      if (!socket.isBrowserTabWatch || socket.closed) continue;
      if (socket.request?.body?.surface !== snapshot.surface) continue;
      socket.streamFrame(snapshot);
    }
  };

  const requests = [];
  const replies = [];
  const sockets = new Set();
  // Synthetic PTY records are shared by same-origin fixture pages through
  // local storage, rather than being held by the socket that created them.
  const terminalStoreKey = `webui-browser:${window.__WEBUI_TEST_SERVER_ID__}:terminals`;
  const terminalSequenceKey = `${terminalStoreKey}:sequence`;
  const readTerminals = () => {
    const stored = window.localStorage.getItem(terminalStoreKey);
    return stored ? JSON.parse(stored) : [];
  };
  const writeTerminals = (value) => window.localStorage.setItem(terminalStoreKey, JSON.stringify(value));

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const matches = (body, condition) => Object.entries(condition).every(([key, value]) => body?.[key] === value);
  /** Operations the fixture deliberately answers with nothing, so a case can see
   *  what the client does with a runtime that does not know them. */
  const unanswered = new Set();
  const responses = new Map();
  const refusals = new Map();
  const responseFor = (operation, body) => {
    if (responses.has(operation)) return clone(responses.get(operation));
    if (unanswered.has(operation)) return {};
    if (operation === "listSessions") {
      if (body?.onlyArchived) {
        return {
          sessions: sessions.filter((item) => archivedIds.includes(item.sessionId)),
          hasMore: false,
        };
      }
      if (body?.includeArchived) return { sessions, hasMore: false };
      return {
        sessions: sessions.filter((item) => !archivedIds.includes(item.sessionId)),
        hasMore: false,
      };
    }
    if (operation === "archiveSession") {
      const id = String(body?.id ?? "");
      archivedIds =
        body?.archived === false
          ? archivedIds.filter((candidate) => candidate !== id)
          : [...new Set([...archivedIds, id])];
      return { success: true };
    }
    if (operation === "getSessionTree") return clone(tree);
    if (operation === "listVisibleProjects") return projects;
    if (operation === "getMessages") {
      if (body?.before) return { messages: [{ msgId: `older-${body.before}`, role: "user", msgContent: "Older synthetic page", timestamp: 1_699_999_999_999 }], hasMore: false };
      return pages[body?.id] ?? { messages: [], hasMore: false };
    }
    if (operation === "version") return { version: "browser-fixture", protocolVersion: 1 };
    if (operation === "listSkills") return { skills: [] };
    if (operation === "listCronTasks") return { items: clone(cronTasks), hasMore: false };
    if (operation === "createCronTask") {
      cronTaskSeq += 1;
      const created = {
        cronId: `cron-fixture-new-${String(cronTaskSeq)}`,
        name: String(body?.name ?? ""),
        agentName: String(body?.agentName ?? ""),
        prompt: String(body?.prompt ?? ""),
        enabled: body?.enabled !== false,
        heldByThisClient: true,
        schedule: clone(body?.schedule ?? { kind: "recurring", expression: "0 9 * * *" }),
        sessionTarget: clone(body?.sessionTarget ?? { mode: "new" }),
        project: body?.project ?? null,
        model: body?.model ?? null,
        nextRunAtMs: 1_700_005_400_000,
        createdAtMs: 1_700_004_000_000,
        updatedAtMs: 1_700_004_000_000,
      };
      cronTasks = [...cronTasks, created];
      return clone(created);
    }
    if (operation === "updateCronTask") {
      const index = cronTasks.findIndex((task) => task.cronId === String(body?.cronId ?? ""));
      if (index < 0) throw new Error("unknown cron task");
      const patch = body ?? {};
      const current = cronTasks[index];
      const next = {
        ...current,
        ...(patch.name === undefined ? {} : { name: String(patch.name) }),
        ...(patch.prompt === undefined ? {} : { prompt: String(patch.prompt) }),
        ...(patch.schedule === undefined ? {} : { schedule: clone(patch.schedule) }),
        ...(patch.sessionTarget === undefined ? {} : { sessionTarget: clone(patch.sessionTarget) }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.project === undefined ? {} : { project: patch.project }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled === true }),
      };
      // A disabled task is not armed; that absence is what the panel renders as 未安排下一次执行.
      if (next.enabled === false) delete next.nextRunAtMs;
      else next.nextRunAtMs = current.nextRunAtMs ?? 1_700_005_400_000;
      cronTasks = cronTasks.map((task, at) => (at === index ? next : task));
      return clone(next);
    }
    if (operation === "runCronTaskNow") {
      cronRunSeq += 1;
      const run = {
        runId: `run-fixture-${String(cronRunSeq)}`,
        cronId: String(body?.cronId ?? ""),
        triggerSource: "manual",
        status: "delivered",
        sessionId: "A",
        createdAtMs: 1_700_006_000_000 + cronRunSeq,
        deliveredAtMs: 1_700_006_000_500 + cronRunSeq,
      };
      cronRuns = [run, ...cronRuns];
      return clone(run);
    }
    if (operation === "listCronTaskRuns") {
      const cronId = String(body?.cronId ?? "");
      return { items: clone(cronRuns.filter((run) => run.cronId === cronId)), hasMore: false };
    }
    if (operation === "deleteCronTask") {
      cronTasks = cronTasks.filter((task) => task.cronId !== String(body?.cronId ?? ""));
      return { success: true };
    }
    // ADR 0027: the scheduled-task panel reads one page. Three rows on purpose — one this client
    // holds, one it does not, one paused — so the panel's three labels are all visible in the
    // baseline instead of a single row that would render the same whatever the labels said.
    if (operation === "listCronTasks") {
      return {
        items: [
          {
            cronId: "cron-fixture-held",
            name: "队列摘要",
            agentName: "synthetic-A",
            prompt: "Summarize the queue.",
            enabled: true,
            heldByThisClient: true,
            schedule: { kind: "recurring", expression: "0 9 * * *" },
            sessionTarget: { mode: "new" },
            project: null,
            model: null,
            nextRunAtMs: 1_700_003_600_000,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
          },
          {
            cronId: "cron-fixture-unheld",
            name: "工作区周报",
            agentName: "synthetic-A",
            prompt: "Write the weekly report.",
            enabled: true,
            heldByThisClient: false,
            schedule: { kind: "recurring", expression: "*/30 * * * *" },
            sessionTarget: { mode: "new" },
            project: null,
            model: null,
            nextRunAtMs: 1_700_001_800_000,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
          },
          {
            cronId: "cron-fixture-paused",
            name: "队列周报",
            agentName: "synthetic-A",
            prompt: "Sync overnight.",
            enabled: false,
            heldByThisClient: false,
            schedule: { kind: "recurring", expression: "0 2 * * *" },
            sessionTarget: { mode: "new" },
            project: null,
            model: null,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
          },
        ],
        hasMore: false,
      };
    }
    if (operation === "listPendingPermissions") return { requests: [] };
    if (operation === "getActiveTurn") return activeTurn;
    if (operation === "getTurnDiff") return clone(turnDiff);
    if (operation === "revertTurnDiff") {
      turnDiff = { ...turnDiff, status: "reverted", canUndo: false, canReapply: true };
      return { success: true, turnDiff: clone(turnDiff) };
    }
    if (operation === "reapplyTurnDiff") {
      turnDiff = { ...turnDiff, status: "active", canUndo: true, canReapply: false };
      return { ...clone(turnDiff), success: true };
    }
    if (operation === "getWorkspaceReviewSummary") return clone(workspaceReviewSummary);
    // ---- the browser family
    if (operation === "getBrowserAuthorization") return clone(browserAuthorization);
    if (operation === "setBrowserAuthorization") {
      const next = body?.authorization ?? body ?? {};
      browserAuthorization = { ...browserAuthorization, ...clone(next) };
      return clone(browserAuthorization);
    }
    if (operation === "listBrowserCapabilities") {
      return {
        entries: [
          {
            surface: "isolated-chromium",
            bridged: false,
            liveImages: browserAuthorization.isolatedChromium,
            input: browserAuthorization.isolatedChromium,
            agentTools: browserAuthorization.isolatedChromium,
            fullCdpApplies: true,
          },
          {
            surface: "edge",
            bridged: true,
            liveImages: browserAuthorization.edge,
            input: browserAuthorization.edge,
            agentTools: browserAuthorization.edge,
            fullCdpApplies: true,
          },
          {
            surface: "chrome",
            bridged: true,
            liveImages: browserAuthorization.chrome,
            input: browserAuthorization.chrome,
            agentTools: browserAuthorization.chrome,
            fullCdpApplies: true,
          },
        ],
      };
    }
    if (operation === "listBrowserTargets") return browserTargetList();
    if (operation === "selectBrowserTarget") {
      // The run's selection is the runtime's cell. The fixture marks it, and
      // the client's read of it is what the panel reports.
      const wanted = body?.target?.targetId;
      for (const tab of browserTabs) tab.selected = tab.target.targetId === wanted;
      publishBrowserTabs();
      return { ok: true };
    }
    if (operation === "openBrowserWebTab") {
      // The person opening a page from the launcher. A surface that is
      // switched off is refused before the page is created; that refusal is
      // sent as a frame in `send`, where a refusal belongs.
      const url = typeof body?.url === "string" ? body.url : "";
      const tab = toBrowserTab({
        id: `tab-${(browserTabSequence += 1)}`,
        title: url,
        url,
        selected: false,
      });
      browserTabs = [...browserTabs, tab];
      publishBrowserTabs();
      return { accepted: true, target: clone(tab.target) };
    }
    if (operation === "closeBrowserWebTab") {
      const targetId = body?.target?.targetId ?? body?.targetId;
      browserTabs = browserTabs.filter((tab) => tab.target.targetId !== targetId);
      publishBrowserTabs();
      return { accepted: true, targetId: String(targetId) };
    }
    if (operation === "sendBrowserInput" || operation === "sendBrowserCommand") {
      // The fixture does not drive a page, so a gesture has nothing to land on.
      // It records the request, which is what a test asserts: that the
      // gesture named the page in front rather than the Agent's page.
      return { ok: true };
    }
    if (operation === "getBrowserInstallationKey") {
      return { present: false, surface: browserSurface };
    }
    // The synthetic terminal bridge stores process records in same-origin local
    // storage, NOT in the socket that created them: `listTerminals` answers from this
    // catalogue long after the creating page's socket is gone, which is the
    // whole point of the row. A fixture that kept the catalogue on the socket
    // would make every terminal vanish with the page that opened it, and the
    // cross-page assertion would then be asserting the fixture rather than the
    // client. The runtime's own shape is reproduced exactly — `{terminalId,
    // status, output, workspaceTabId}` per `server/operation/handlers/terminal.ts`
    // — because a roster that answered `{}` would only be testing the client's
    // tolerance. The `workspaceTabId` is the tab the terminal was opened for:
    // the client binds a terminal to the workspace tab that asked for it, and
    // reads that binding back out of the roster.
    if (operation === "createTerminal") {
      const sequence = Number(window.localStorage.getItem(terminalSequenceKey) ?? "0") + 1;
      window.localStorage.setItem(terminalSequenceKey, String(sequence));
      const terminalId = `term-${sequence}`;
      const terminals = readTerminals();
      terminals.push({
        terminalId,
        status: "running",
        // The synthetic process returns a banner so the client can distinguish
        // an opened terminal from an empty xterm host.
        output: `synthetic shell ${terminalId}\r\n$ `,
        ...(typeof body?.workspaceTabId === "string" ? { workspaceTabId: body.workspaceTabId } : {}),
      });
      writeTerminals(terminals);
      return { terminalId, status: "running" };
    }
    if (operation === "listTerminals")
      return readTerminals().map(({ terminalId, status, output, workspaceTabId }) => ({
        terminalId,
        status,
        output,
        ...(typeof workspaceTabId === "string" ? { workspaceTabId } : {}),
      }));
    if (operation === "writeTerminal") {
      // The echo is what makes a written byte observable in the browser: the
      // client sends it, and only a process that answers with it can prove the
      // write reached the PTY rather than being swallowed by the owner.
      const terminals = readTerminals();
      const terminal = terminals.find((entry) => entry.terminalId === body?.terminalId);
      if (!terminal) return {};
      terminal.output += `${String(body?.data ?? "")}`;
      writeTerminals(terminals);
      return { success: true };
    }
    if (operation === "resizeTerminal") return { success: true };
    if (operation === "disposeTerminal") {
      const terminals = readTerminals();
      const index = terminals.findIndex((entry) => entry.terminalId === body?.terminalId);
      if (index >= 0) terminals.splice(index, 1);
      writeTerminals(terminals);
      // The watcher's frame source ends with the process, exactly as the
      // runtime's async iterable does. A watch left open over a dead terminal
      // would keep a client's buffer growing and would hide the difference
      // between "the terminal ended" and "the watch was released".
      for (const socket of [...sockets])
        if (socket.isTerminalWatch && socket.request?.body?.terminalId === body?.terminalId && !socket.closed) socket.close();
      return { success: true };
    }
    // The workspace file tree. The panel renders it on open, so an unanswered
    // read is not an option: the runtime answers an array of nodes.
    if (operation === "listWorkspaceFileTree")
      return clone(workspaceFileTree);
    // The bytes behind a tree row. Same reason as the tree above: the panel
    // renders this on open, and a preview that can only ever say the read is
    // unavailable cannot tell a working file panel from a broken one.
    if (operation === "readWorkspaceFile")
      return {
        type: "text",
        content: "export const answer = 42;\n",
        resolvedPath: body?.path ?? "a.ts",
        mimeType: "text/plain; charset=utf-8",
      };
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
    if (operation === "signOut") {
      accountLoginState = { state: "idle" };
      return { success: true };
    }
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
    if (operation === "listModels") return clone(models);
    if (operation === "loadProjects") return [];
    if (operation === "getUsageQuota") return clone(usageQuotaResult);
    if (operation === "getGoal") return undefined;
    if (operation === "isGoalEnabled") return false;
    if (operation === "getPermissionMode") return { mode: permissionMode };
    if (operation === "setPermissionMode") {
      if (typeof body?.mode === "string") permissionMode = body.mode;
      return { mode: permissionMode };
    }
    // A directory listing with an EMPTY `entries` array, not the `{}` default:
    // the workspace directory browser reads `listing?.entries.length` and the
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
    if (operation === "listUserModelProviders") return clone(modelProviders);
    if (operation === "listProviderPresets") return clone(providerPresets);
    // Synthetic on purpose: the real server's answer is a credential, and the
    // suite never needs a real one to see that reveal-on-open reaches the field.
    if (operation === "revealModelProviderApiKey") return "synthetic-revealed-key";
    if (operation === "testUserModelCandidate") return clone(candidateTestResult);
    if (operation === "saveUserModelProviderCandidate") return clone(candidateSaveResult);
    if (operation === "discoverUserModelsCandidate") return { ok: true, models: clone(discoveredModels) };
    if (["createUserModelProvider", "updateUserModelProvider", "deleteUserModelProvider"].includes(operation)) return { ok: true };
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
      if (refusals.has(frame.operation)) {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({ protocolVersion: 1, kind: "error", requestId: frame.requestId, ...refusals.get(frame.operation) }) }));
        return;
      }
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
      if (frame.operation === "openBrowserWebTab" && !browserAuthorization.isolatedChromium) {
        // The switch is off: the runtime refuses the surface before it opens
        // a page, and the refusal names the switch rather than the selection.
        queueMicrotask(() =>
          this.emit("message", {
            data: JSON.stringify({
              protocolVersion: 1,
              kind: "error",
              requestId: frame.requestId,
              code: "browser_capability_denied",
              message: 'Browser surface "isolated-chromium" is not authorized.',
            }),
          }),
        );
        return;
      }
      if (frame.operation === "watchBrowserWebTabs") {
        // The web-tab snapshot. The strip and the panel read the same
        // publication, so it goes to every watcher of the surface.
        this.isBrowserTabWatch = true;
        this.respond(frame, { stream: true });
        this.streamFrame(browserSnapshot());
        return;
      }
      if (frame.operation === "watchBrowserFrames") {
        // The page, as an image. The panel draws what it is given, so the
        // fixture paints a page for the target that was asked for.
        this.isBrowserFrameWatch = true;
        this.respond(frame, { stream: true });
        const targetId = frame.body?.target?.targetId;
        const tab = browserTabs.find((entry) => entry.target.targetId === targetId);
        this.streamFrame({
          target: clone(tab?.target ?? frame.body?.target),
          data: paintBrowserPage(tab?.title, tab?.url),
          format: "png",
          sequence: (browserFrameSequence += 1),
        });
        return;
      }
      if (frame.operation === "watchMiniAppPresentation") {
        // ADR 0020's lease: one frame, and then the socket is held open for as
        // long as the document lives. A fixture cannot observe a real socket
        // close, so the release half is proven in `miniapp-operations.test.ts`;
        // what this proves is the client's half — a standalone document takes the
        // lease, and the inline document reads `detached` off the catalogue.
        const scripted = responses.get("watchMiniAppPresentation");
        this.respond(frame, { stream: true });
        this.streamFrame({
          pluginId: frame.body?.pluginId,
          sessionId: frame.body?.sessionId,
          presentationRevision: scripted?.presentationRevision ?? 1,
          session: scripted?.session ?? "live",
        });
        return;
      }
      if (frame.operation === "watchMiniAppPresenter") {
        this.isMiniAppPresenterWatch = true;
        this.respond(frame, { stream: true });
        const intent = responses.get("watchMiniAppPresenter");
        if (intent) this.streamFrame(intent);
        return;
      }
      if (frame.operation === "watchTerminal") {
        // The terminal watch is a stream of `WebuiTerminalFrame`s, and unlike a
        // turn stream it stays open for the life of the process. It is marked
        // separately from `isStream` so `disposeTerminal` can end exactly the
        // watchers of one process, and so `emitTerminalFrame` can reach the
        // socket watching a given terminal even while other streams are open.
        this.isTerminalWatch = true;
        const terminalId = frame.body?.terminalId;
        const known = readTerminals().find((entry) => entry.terminalId === terminalId);
        // The real bridge refuses to watch a terminal it does not have. A
        // fixture that answered every watch would let a client attach to a
        // process that never existed and the roster assertion would prove
        // nothing about ids being real.
        if (!known) {
          queueMicrotask(() => this.respond(frame, { ok: false, error: "unknown terminal" }));
          return;
        }
        this.respond(frame, { stream: true });
        // The backlog the client missed while it was not watching. A PTY that
        // only spoke to whoever happened to be attached would drop output across
        // the very navigation this row is about.
        this.streamFrame({ terminalId, data: known.output, exited: false });
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
        const isHeld = held.some((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
        const waitIndex = delayed.findIndex((entry) => entry.operation === frame.operation && matches(frame.body, entry.condition));
        if (isHeld || waitIndex >= 0) {
          if (!isHeld) delayed.splice(waitIndex, 1);
          pending.push({
            operation: frame.operation,
            body: clone(frame.body ?? {}),
            resolve: (result) => {
              sessions.push({ ...created, ...clone(result) });
              this.respond(frame, result);
            },
          });
          return;
        }
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
      replies.push({
        operation: request.operation,
        requestBody: clone(request.body ?? {}),
        body: body === undefined ? undefined : clone(body),
      });
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
    replies,
    pending,
    setResponse(operation, value) { responses.set(operation, clone(value)); },
    refuseOperation(operation, code, message) { refusals.set(operation, { code, message }); },
    /**
     * Answers an operation again after `refuseOperation`.
     *
     * A runtime refusal is a condition, not a latch: a capacity refusal ends
     * when a slot is freed, and the next start then succeeds. A fixture that
     * could only refuse forever would make "stop one, then retry" untestable.
     */
    allowOperation(operation) { refusals.delete(operation); },
    setSessions(next) { sessions.splice(0, sessions.length, ...clone(next)); },
    setProjects(next) { projects = clone(next); },
    delayNext(operation, condition) { delayed.push({ operation, condition }); },
    // Holds EVERY matching request, not just the next one. A session switch
    // fans out into several concurrent `getMessages` for the same session
    // (transcript first page, context usage, workspace history progress), so
    // `delayNext` alone does not decide which one the test is actually
    // blocking — the transcript's own request is the second of the three.
    delayEvery(operation, condition) { held.push({ operation, condition }); },
    setPage(sessionId, page) { pages[sessionId] = clone(page); },
    setModels(next) { models = clone(next); },
    /**
     * The session's web tabs, as the runtime publishes them.
     *
     * A test writes the short form -- an id, a title, a url, and whether the
     * Agent is on that page -- and the fixture fills in the target the
     * runtime would have published. The tabs are published to the watchers
     * at once, so the strip and the panel see the same browser.
     */
    setBrowserTabs(next) {
      browserTabs = (next ?? []).map((entry) => toBrowserTab(entry));
      publishBrowserTabs();
    },
    /** The browser's switches, so a test can turn the surface off. */
    setBrowserAuthorization(next) {
      browserAuthorization = { ...browserAuthorization, ...clone(next ?? {}) };
    },
    /** The page the Agent is on: the tab the runtime marks as the selection. */
    setBrowserSelection(targetId) {
      for (const tab of browserTabs) tab.selected = tab.target.targetId === targetId;
      publishBrowserTabs();
    },
    /** What the fixture's browser currently holds. */
    browserTabs() {
      return browserTabs.map((tab) => clone(tab));
    },
    /** Which sessions the fixture currently holds as archived. */
    setArchived(ids) { archivedIds = [...ids]; },
    archived() { return [...archivedIds]; },
    /** What the runtime answers for a turn's diff, and what a revert returns. */
    setTurnDiff(next) { turnDiff = clone(next); },
    /** Answer this operation with an empty object, as an unknown op would be. */
    unanswer(operation) { unanswered.add(operation); },
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
    setWorkspaceFileTree(nodes) { workspaceFileTree = clone(nodes); },
    setModelProviders(providers) { modelProviders = clone(providers); },
    setProviderPresets(presets) { providerPresets = clone(presets); },
    setCandidateTestResult(result) { candidateTestResult = clone(result); },
    setCandidateSaveResult(result) { candidateSaveResult = clone(result); },
    setDiscoveredModels(models) { discoveredModels = clone(models); },
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
    emitMiniAppPresenter(intent) {
      for (const socket of sockets) {
        if (socket.isMiniAppPresenterWatch && !socket.closed) socket.streamFrame(clone(intent));
      }
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
    /** The PTY processes the runtime currently holds. */
    terminals() {
      return readTerminals().map(({ terminalId, status, output, workspaceTabId }) => ({
        terminalId,
        status,
        output,
        ...(typeof workspaceTabId === "string" ? { workspaceTabId } : {}),
      }));
    },
    /** Which terminals have at least one live watcher attached right now. */
    watchedTerminalIds() {
      return [...sockets]
        .filter((socket) => socket.isTerminalWatch && !socket.closed)
        .map((socket) => socket.request?.body?.terminalId);
    },
    /**
     * Push one `WebuiTerminalFrame` to every watcher of `terminalId`.
     *
     * Sent to all watchers rather than the first: two panels watching one PTY
     * is the cross-page shape, and a fixture that fed only one of them would
     * let the other look broken when it is the fixture that is.
     */
    emitTerminalFrame(terminalId, frame) {
      const delivered = [];
      for (const socket of sockets) {
        if (!socket.isTerminalWatch || socket.closed) continue;
        if (socket.request?.body?.terminalId !== terminalId) continue;
        socket.streamFrame({ terminalId, data: "", exited: false, ...frame });
        delivered.push(terminalId);
      }
      return delivered.length;
    },
    /**
     * End a process the way a shell that exits does: the roster keeps the row
     * with `exited`, and the watchers get a final frame then a closed stream.
     * The row staying behind is what `WebuiTerminalRecord.status` exists for.
     */
    exitTerminal(terminalId) {
      const terminals = readTerminals();
      const terminal = terminals.find((entry) => entry.terminalId === terminalId);
      if (!terminal) return false;
      terminal.status = "exited";
      terminal.output += "\r\n[process exited]\r\n";
      writeTerminals(terminals);
      for (const socket of [...sockets]) {
        if (!socket.isTerminalWatch || socket.closed) continue;
        if (socket.request?.body?.terminalId !== terminalId) continue;
        socket.streamFrame({ terminalId, data: "\r\n[process exited]\r\n", exited: true });
        socket.close();
      }
      return true;
    },
  };

  // A scripted host broadcast shared by fixture pages. Each page still receives
  // the fact through its production WebSocket ingress; no application store is patched.
  const factsKey = `webui-browser:${window.__WEBUI_TEST_SERVER_ID__}:session-fact`;
  const applyPublishedFact = ({ sessionId, patch, event }) => {
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (session) Object.assign(session, clone(patch));
    for (const item of tree.sessions) {
      if (item.session.sessionId === sessionId) Object.assign(item.session, clone(patch));
    }
    window.__fixture.emitEvent(event);
  };
  window.addEventListener("storage", (event) => {
    if (event.key === factsKey && event.newValue) applyPublishedFact(JSON.parse(event.newValue));
  });
  window.__fixture.publishSessionFact = (sessionId, patch, event) => {
    const published = { sessionId, patch, event };
    applyPublishedFact(published);
    window.localStorage.setItem(factsKey, JSON.stringify(published));
  };
  window.WebSocket = FixtureWebSocket;
}

export const fixtureTransportInit = `(${installFixtureTransport.toString()})();`;
