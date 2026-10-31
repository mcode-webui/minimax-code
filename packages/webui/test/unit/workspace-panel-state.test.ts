import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createWebuiWorkspacePanelOwner,
} from "../../src/client/features/workspace/application/workspace-panel-owner.js";
import { parseWebuiMessageFileReference } from "../../src/client/features/transcript/projection/message-file-reference.js";
import { WebuiMarkdown } from "../../src/client/features/transcript/ui/markdown.public.js";
import { mergeWorkspaceFileChildren, WebuiFilePreview } from "../../src/client/features/workspace/ui/WorkspacePanels.js";
import { webuiFileLanguage } from "../../src/client/features/workspace/projection/panel-projection.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getWorkspacePanelSessionState,
  initialWorkspacePanelSessionState,
  initialWorkspacePanelState,
  reduceWorkspacePanelSessionState,
  reduceWorkspacePanelState,
  setWorkspaceSessionProgressPanelOpen,
  webuiWorkspaceTabContentKey,
  webuiWorkspaceTabLabel,
  type WorkspacePanelSessionStates,
} from "../../src/client/features/workspace/projection/workspace-panel-state.js";
import { focusWebuiFileLine, webuiFileLineTargetId } from "../../src/client/bindings/browser-effects.js";

describe("right workspace panel navigation", () => {
  it("keeps workspace and progress visibility isolated per session", () => {
    let states: WorkspacePanelSessionStates = new Map();
    states = reduceWorkspacePanelSessionState(states, "session-a", {
      type: "open-primary-view",
      kind: "files",
      sessionId: "session-a",
      workspaceDir: "/repo-a",
    });

    expect(getWorkspacePanelSessionState(states, "session-a")).toMatchObject({
      workspacePanel: { open: true },
      progressPanelOpen: false,
    });
    expect(getWorkspacePanelSessionState(states, "session-b")).toBe(initialWorkspacePanelSessionState);

    states = reduceWorkspacePanelSessionState(states, "session-b", {
      type: "open-primary-view",
      kind: "files",
      sessionId: "session-b",
      workspaceDir: "/repo-b",
    });
    expect(getWorkspacePanelSessionState(states, "session-b")).toMatchObject({
      workspacePanel: { open: true },
      progressPanelOpen: false,
    });
    expect(getWorkspacePanelSessionState(states, "session-a").workspacePanel.tabs[0]?.content).toMatchObject({
      kind: "files",
      workspaceDir: "/repo-a",
    });
  });

  it("never opens progress over an open workspace and forgets session state on reload", () => {
    let states: WorkspacePanelSessionStates = new Map();
    states = reduceWorkspacePanelSessionState(states, "session-a", {
      type: "open-primary-view",
      kind: "files",
      sessionId: "session-a",
      workspaceDir: "/repo-a",
    });
    states = setWorkspaceSessionProgressPanelOpen(states, "session-a", true);
    expect(getWorkspacePanelSessionState(states, "session-a")).toMatchObject({
      workspacePanel: { open: true },
      progressPanelOpen: false,
    });

    const afterReload = new Map();
    expect(getWorkspacePanelSessionState(afterReload, "session-a")).toBe(initialWorkspacePanelSessionState);
    expect(initialWorkspacePanelState.open).toBe(false);
  });

  it("does not create a new session state when the review snapshot is unchanged", () => {
    let states = reduceWorkspacePanelSessionState(new Map(), "session-a", {
      type: "open-workspace-review",
      sessionId: "session-a",
      workspaceDir: "/repo-a",
    });
    const reviewTabId = getWorkspacePanelSessionState(states, "session-a").workspacePanel.activeTabId!;
    states = reduceWorkspacePanelSessionState(states, "session-a", {
      type: "set-review-snapshot",
      tabId: reviewTabId,
      reviewSnapshotId: "snapshot-a",
    });
    const afterSettingSnapshot = states;

    states = reduceWorkspacePanelSessionState(states, "session-a", {
      type: "set-review-snapshot",
      tabId: reviewTabId,
      reviewSnapshotId: "snapshot-a",
    });

    expect(states).toBe(afterSettingSnapshot);
  });

  it("inserts lazily loaded directory entries under the matching workspace folder", () => {
    const roots = [
      { path: "src", name: "src", type: "directory" },
      { path: "README.md", name: "README.md", type: "file" },
    ] as const;
    const children = [
      { path: "src/index.ts", name: "index.ts", type: "file" },
      { path: "src/components", name: "components", type: "directory" },
    ] as const;

    expect(mergeWorkspaceFileChildren(roots, "src", children)).toEqual([
      { ...roots[0], children },
      roots[1],
    ]);
    expect(mergeWorkspaceFileChildren(roots, "missing", children)).toEqual(roots);
  });

  it("opens the session plan file with its content attached", () => {
    // The plan lives in the session artifacts directory, outside the
    // workspace root, so the content rides along instead of being read back
    // through readWorkspaceFile — which would reject the path.
    const state = reduceWorkspacePanelState(initialWorkspacePanelState, {
      type: "open-plan-file",
      sessionId: "s1",
      workspaceDir: "/a",
      path: "/artifacts/plan.md",
      content: "# Plan\n\nbody",
    });
    expect(state.open).toBe(true);
    const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    expect(tab?.content).toMatchObject({ kind: "file-preview", path: "/artifacts/plan.md", content: "# Plan\n\nbody" });
  });

  it("keeps one active view while opening, switching and closing tabs", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-tab", kind: "files", sessionId: "s1", workspaceDir: "/a" });
    const filesTab = state.activeTabId;
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s1", workspaceDir: "/a", path: "src/index.ts", lineStart: 42 });
    const fileTab = state.activeTabId;
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s1", workspaceDir: "/a", path: "README.md" });
    const secondFileTab = state.activeTabId;
    expect(state.open).toBe(true);
    expect(state.tabs).toHaveLength(3);
    expect(state.tabs.find((tab) => tab.id === fileTab)?.content).toMatchObject({ kind: "file-preview", path: "src/index.ts", lineStart: 42 });
    state = reduceWorkspacePanelState(state, { type: "select-tab", tabId: filesTab! });
    expect(state.activeTabId).toBe(filesTab);
    state = reduceWorkspacePanelState(state, { type: "select-tab", tabId: secondFileTab! });
    expect(state.activeTabId).toBe(secondFileTab);
    state = reduceWorkspacePanelState(state, { type: "close-tab", tabId: filesTab! });
    expect(state.activeTabId).toBe(secondFileTab);
    state = reduceWorkspacePanelState(state, { type: "close-tab", tabId: secondFileTab! });
    expect(state.activeTabId).toBe(fileTab);
    state = reduceWorkspacePanelState(state, { type: "close-tab", tabId: fileTab! });
    expect(state.open).toBe(false);
    expect(state.tabs).toEqual([]);
  });

  it("gives two web tabs in one session two ids", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, {
      type: "open-web-tab",
      target: { surface: "isolated-chromium", browserId: "b", targetId: "t1", generation: 1 },
      title: "First",
      url: "https://example.test/one",
    });
    state = reduceWorkspacePanelState(state, {
      type: "open-web-tab",
      target: { surface: "isolated-chromium", browserId: "b", targetId: "t2", generation: 1 },
      title: "Second",
      url: "https://example.test/two",
    });
    // The id is the client's and says nothing about what the tab is showing,
    // so two web tabs in one session are two tabs.
    expect(state.tabs).toHaveLength(2);
    expect(new Set(state.tabs.map((tab) => tab.id)).size).toBe(2);
    expect(state.tabs.map((tab) => webuiWorkspaceTabLabel(tab))).toEqual(["First", "Second"]);
  });

  it("keeps one tab for a web tab that is already open", () => {
    let state = initialWorkspacePanelState;
    const target = { surface: "isolated-chromium", browserId: "b", targetId: "t1", generation: 1 } as const;
    state = reduceWorkspacePanelState(state, { type: "open-web-tab", target, title: "First", url: "https://example.test/one" });
    const firstId = state.activeTabId;
    // The runtime publishes a snapshot, and applying a snapshot twice changes
    // nothing: the same target is the same tab.
    state = reduceWorkspacePanelState(state, { type: "open-web-tab", target, title: "First", url: "https://example.test/one" });
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(firstId);
  });

  it("opens the new tab page when the strip asks for one", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-new-tab" });
    expect(state.open).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.content.kind).toBe("launcher");
    // An idle launcher carries no request: `request` is what it holds once it
    // has asked the runtime for a page.
    expect(state.tabs[0]?.content).toEqual({ kind: "launcher" });
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
  });

  it("opens a fresh new tab page every time the strip asks, rather than reusing one", () => {
    // The launcher is a tab's content, not a singleton the panel keeps. A person
    // who typed a url into the last one wants another, and the page they opened
    // must still be there beside it.
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-new-tab" });
    state = reduceWorkspacePanelState(state, { type: "open-new-tab" });
    state = reduceWorkspacePanelState(state, { type: "open-new-tab" });
    expect(state.tabs.filter((tab) => tab.content.kind === "launcher")).toHaveLength(3);
    expect(new Set(state.tabs.map((tab) => tab.id)).size).toBe(3);
  });

  it("leaves an idle launcher alone when a published page arrives for another tab", () => {
    // A page nothing asked for opens a tab of its own — the Agent's page — and
    // an untouched launcher is not a slot waiting for it.
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-new-tab" });
    const target = { surface: "isolated-chromium", browserId: "b", targetId: "t1", generation: 1 } as const;
    state = reduceWorkspacePanelState(state, { type: "open-web-tab", target, title: "Example", url: "https://example.test/" });
    expect(state.tabs.filter((tab) => tab.content.kind === "launcher")).toHaveLength(1);
    expect(state.tabs.filter((tab) => tab.content.kind === "web")).toHaveLength(1);
  });

  it("updates a web tab's content without moving the person off the tab they are on", () => {
    let state = initialWorkspacePanelState;
    const target = { surface: "isolated-chromium", browserId: "b", targetId: "t1", generation: 1 } as const;
    state = reduceWorkspacePanelState(state, { type: "open-web-tab", target, title: "First", url: "https://example.test/one" });
    const webTabId = state.activeTabId;
    // A tool tab the person is looking at.
    state = reduceWorkspacePanelState(state, { type: "open-tab", kind: "files", sessionId: "s1", workspaceDir: "/repo" });
    const filesTabId = state.activeTabId;

    // The page behind the web tab navigated: the title moved and the page got
    // a new generation. The web tab's content updates — and the person keeps
    // looking at the tab they were looking at.
    state = reduceWorkspacePanelState(state, {
      type: "open-web-tab",
      target: { ...target, generation: 2 },
      title: "Second",
      url: "https://example.test/two",
    });

    expect(state.activeTabId).toBe(filesTabId);
    const web = state.tabs.find((tab) => tab.id === webTabId);
    expect(web?.content).toMatchObject({ kind: "web", title: "Second", url: "https://example.test/two" });
    expect(web?.content.kind === "web" && web.content.target.generation).toBe(2);
  });

  it("labels a tab by its content, and a changed content changes the label", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s1", workspaceDir: "/repo", path: "src/index.ts" });
    expect(webuiWorkspaceTabLabel(state.tabs[0]!)).toBe("index.ts");
    // The content is mutable under a stable id, and the label follows it.
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s1", workspaceDir: "/repo", path: "README.md" });
    expect(state.tabs).toHaveLength(2);
    expect(webuiWorkspaceTabLabel(state.tabs[1]!)).toBe("README.md");
  });

  it("keys what a tab shows by its content, not by its slot", () => {
    const file = webuiWorkspaceTabContentKey({
      kind: "file-preview",
      sessionId: "s1",
      workspaceDir: "/repo",
      path: "src/index.ts",
    });
    const sameFile = webuiWorkspaceTabContentKey({
      kind: "file-preview",
      sessionId: "s1",
      workspaceDir: "/repo",
      path: "src/index.ts",
    });
    const otherFile = webuiWorkspaceTabContentKey({
      kind: "file-preview",
      sessionId: "s1",
      workspaceDir: "/repo",
      path: "README.md",
    });
    // The same file is the same thing, and a different file is a different
    // thing — which is what the cache needs, because a tab's id is stable and
    // its content is not.
    expect(file).toBe(sameFile);
    expect(file).not.toBe(otherFile);
  });

  it("keeps the add-menu file view and opened files in the same tab strip", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-primary-view", kind: "files", sessionId: "s1", workspaceDir: "/repo" });
    const filesTab = state.activeTabId;
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s1", workspaceDir: "/repo", path: "src/index.ts" });
    const fileTab = state.activeTabId;
    state = reduceWorkspacePanelState(state, { type: "open-tab", kind: "files", sessionId: "s1", workspaceDir: "/repo" });
    expect(state.tabs.map((tab) => tab.id)).toEqual([filesTab, fileTab]);
    expect(state.activeTabId).toBe(filesTab);
    state = reduceWorkspacePanelState(state, { type: "select-tab", tabId: fileTab! });
    expect(state.activeTabId).toBe(fileTab);
  });

  it("renders source files with syntax highlighting and preserves source text safely", () => {
    const tab = { id: "file:src/index.ts", kind: "file-preview" as const, sessionId: "s1", workspaceDir: "/repo", path: "src/index.ts" };
    const markup = renderToStaticMarkup(createElement(WebuiFilePreview, { tabId: tab.id, content: tab, codeMode: true, result: { loading: false, content: { type: "text", content: "const value = '<script>';\nreturn value;" } } }));
    expect(webuiFileLanguage(tab.path)).toBe("typescript");
    expect(markup).toContain("hljs-keyword");
    expect(markup).toContain("hljs-string");
    expect(markup).toContain('data-line-number="1"');
    expect(markup).not.toContain("<script>");
  });

  it("renders Markdown files as a document preview and keeps a source toggle", () => {
    const tab = { id: "file:README.md", kind: "file-preview" as const, sessionId: "s1", workspaceDir: "/repo", path: "README.md" };
    const preview = renderToStaticMarkup(createElement(WebuiFilePreview, { tabId: tab.id, content: tab, codeMode: false, result: { loading: false, content: { type: "text", content: "# Project guide" } } }));
    const source = renderToStaticMarkup(createElement(WebuiFilePreview, { tabId: tab.id, content: tab, codeMode: true, result: { loading: false, content: { type: "text", content: "# Project guide" } } }));
    expect(preview).toContain('data-webui-markdown="true"');
    expect(source).toContain('class="webui-file-code"');
  });

  it("isolates identical relative files by session and workspace and rejects traversal", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s1", workspaceDir: "/a", path: "index.ts" });
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s2", workspaceDir: "/b", path: "index.ts" });
    expect(state.tabs).toHaveLength(2);
    const before = state;
    state = reduceWorkspacePanelState(state, { type: "open-file", sessionId: "s2", workspaceDir: "/b", path: "../secret" });
    expect(state).toBe(before);
  });

  it("keeps the workspace review and the turn review in two tabs", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-workspace-review", sessionId: "s1", workspaceDir: "/repo" });
    state = reduceWorkspacePanelState(state, { type: "open-turn-review", sessionId: "s1", workspaceDir: "/repo", messageId: "group-1", assistantMessageId: "assistant-9", turnId: "turn-3", changeSetId: "change-7", files: [{ file: "a.ts", additions: 1, deletions: 0, diff: "+a" }] });
    // The two used to derive the same id, so opening one replaced the other.
    expect(state.tabs.map((tab) => tab.content.kind)).toEqual(["review", "review"]);
    expect(state.tabs.map((tab) => (tab.content.kind === "review" ? tab.content.source : undefined))).toEqual(["workspace", "turn"]);
    expect(state.tabs[1]?.content).toMatchObject({ source: "turn", messageId: "group-1", assistantMessageId: "assistant-9", turnId: "turn-3", changeSetId: "change-7" });
  });

  it("parses only safe workspace file references and preserves line ranges", () => {
    expect(parseWebuiMessageFileReference("src/index.ts:42-45")).toEqual({ path: "src/index.ts", lineStart: 42, lineEnd: 45 });
    expect(parseWebuiMessageFileReference("index.html")).toEqual({ path: "index.html" });
    expect(parseWebuiMessageFileReference("https://example.com/index.ts")).toBeUndefined();
    expect(parseWebuiMessageFileReference("../secret.ts")).toBeUndefined();
    expect(parseWebuiMessageFileReference("src/index.ts:0")).toBeUndefined();
  });

  it("renders assistant file references as navigable links while preserving ordinary URLs", () => {
    const markup = renderToStaticMarkup(createElement(WebuiMarkdown, { source: "Open `src/index.ts:42` and `index.html`, or visit https://example.com.", onOpenFile: () => undefined }));
    expect(markup).toContain('data-webui-file-reference="src/index.ts"');
    expect(markup).toContain('data-webui-file-reference="index.html"');
    expect(markup).toContain('href="https://example.com"');
  });

  it("does not wrap a Markdown file link in a second generated file link", () => {
    const markup = renderToStaticMarkup(createElement(WebuiMarkdown, { source: "[src/index.ts](src/index.ts)", onOpenFile: () => undefined }));
    expect(markup.match(/<a\b/gu)).toHaveLength(1);
    expect(markup).toContain('data-webui-file-reference="src/index.ts"><span aria-hidden="true">📘</span><span>index.ts</span></a>');
  });

  it("scrolls the requested file line into view and focuses it after loading", () => {
    const calls: unknown[][] = [];
    const target = {
      scrollIntoView: (options?: ScrollIntoViewOptions) => calls.push(["scroll", options]),
      focus: (options?: FocusOptions) => calls.push(["focus", options]),
    };
    focusWebuiFileLine(target);
    expect(calls).toEqual([
      ["scroll", { block: "center", behavior: "smooth" }],
      ["focus", { preventScroll: true }],
    ]);
    expect(webuiFileLineTargetId("preview-tab", 42)).toBe("webui-file-line-preview-tab-42");
  });
});

describe("the panel owner holds the panel state per session", () => {
  it("keeps each session's slice, and notifies on a change", () => {
    const owner = createWebuiWorkspacePanelOwner();
    let notifications = 0;
    owner.subscribe(() => {
      notifications += 1;
    });

    owner.dispatch("A", { type: "open-tab", kind: "files", workspaceDir: "/w" });
    expect(owner.stateFor("A").workspacePanel.open).toBe(true);
    // The session that was not touched still shows its own state.
    expect(owner.stateFor("B").workspacePanel.open).toBe(false);
    expect(notifications).toBe(1);

    // Closing it again leaves the panel closed; whether the reducer hands back the
    // same object is its own business, so the claim here is the state, not identity.
    owner.dispatch("A", { type: "close-panel" });
    owner.dispatch("A", { type: "close-panel" });
    expect(owner.stateFor("A").workspacePanel.open).toBe(false);
  });

  it("gives an unknown session the initial slice", () => {
    const owner = createWebuiWorkspacePanelOwner();
    expect(owner.stateFor("never-seen")).toEqual(initialWorkspacePanelSessionState);
    expect(owner.stateFor("")).toEqual(initialWorkspacePanelSessionState);
  });

  it("keeps the two right-side panels from being open together", () => {
    const owner = createWebuiWorkspacePanelOwner();
    owner.dispatch("A", { type: "open-tab", kind: "files", workspaceDir: "/w" });
    owner.setProgressPanelOpen("A", true);
    // Opening the progress panel while the workspace panel is open is refused, the
    // same invariant the reducer keeps.
    expect(owner.stateFor("A").progressPanelOpen).toBe(false);
    owner.dispatch("A", { type: "close-panel" });
    owner.setProgressPanelOpen("A", true);
    expect(owner.stateFor("A").progressPanelOpen).toBe(true);
  });
});

describe("the terminal roster is read before it is shown", () => {
  const panelSource = readFileSync(
    new URL("../../src/client/features/workspace/ui/WorkspacePanels.tsx", import.meta.url),
    "utf8",
  );

  it("does not paint an empty roster before the first answer lands", () => {
    // On a reload whose sessions still hold PTYs, an empty first paint reads as
    // "all my terminals exited" and invites a create that would exceed the
    // limit. The panel waits for the roster instead.
    expect(panelSource).toContain("terminalsReady");
    expect(panelSource).toContain("{!terminalsReady ? DESKTOP_COPY.terminalLoading");
    // The create waits for the roster too: the panel opens a terminal only once
    // the first answer has landed, so a reload cannot open a second shell
    // before the roster has said what is already running.
    expect(panelSource).toContain("!terminalsReady || terminalTargetId");
  });

  it("drops a roster read that a later read has superseded", () => {
    // Switching workspaces starts a second read. The first resolving late would
    // otherwise overwrite the newer answer with the previous workspace's
    // terminals — a stale roster that looks live.
    expect(panelSource).toContain("const read = ++rosterRead.current;");
    expect(panelSource).toContain("if (rosterRead.current !== read) return;");
  });

  it("states what the terminal service says rather than discovering a refusal", () => {
    // The limit is the process half's rule now, so the panel keeps no copy of
    // it. It asks the owner what it can do and says that answer — an absent
    // service, a service that is not ready, an interface that does not match —
    // instead of letting a refused create speak for itself.
    expect(panelSource).toContain("terminalSupport");
    expect(panelSource).toContain("terminalAvailability");
    expect(panelSource).toContain("terminalError");
    // The panel publishes the service's answer as a marker on the line it
    // shows. The shared feedback contract carries a surface's own attributes
    // through `dataAttributes`, so the marker may be written as a JSX
    // attribute or as an entry of that record — what matters is that it is
    // bound to the service's answer.
    expect(panelSource).toMatch(/data-webui-terminal-availability["']?\s*[:=]\s*\{?\s*terminalSupport/);
    // The create is gated by what the owner can do, so the panel never opens a
    // terminal the service would refuse.
    expect(panelSource).toContain("!terminalOwner?.canCreate");
    // One create call, not a copy per button.
    const createCalls = panelSource.split("terminalOwner.create(").length - 1;
    expect(createCalls).toBe(1);
  });
});
