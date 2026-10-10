import { describe, expect, it } from "vitest";
import { parseWebuiMessageFileReference } from "../../src/client/projection/message-file-reference.js";
import { WebuiMarkdown } from "../../src/client/markdown.js";
import { mergeWorkspaceFileChildren, WebuiFilePreview, webuiFileLanguage } from "../../src/client/components/WorkspacePanels.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getWorkspacePanelSessionState,
  initialWorkspacePanelSessionState,
  initialWorkspacePanelState,
  reduceWorkspacePanelSessionState,
  reduceWorkspacePanelState,
  setWorkspaceSessionProgressPanelOpen,
  type WorkspacePanelSessionStates,
} from "../../src/client/projection/workspace-panel-state.js";
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
    expect(getWorkspacePanelSessionState(states, "session-a").workspacePanel.tabs[0]).toMatchObject({
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
    expect(tab).toMatchObject({ kind: "file-preview", path: "/artifacts/plan.md", content: "# Plan\n\nbody" });
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
    expect(state.tabs.find((tab) => tab.id === fileTab)).toMatchObject({ kind: "file-preview", path: "src/index.ts", lineStart: 42 });
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
    const markup = renderToStaticMarkup(createElement(WebuiFilePreview, { tab, codeMode: true, result: { loading: false, content: { type: "text", content: "const value = '<script>';\nreturn value;" } } }));
    expect(webuiFileLanguage(tab.path)).toBe("typescript");
    expect(markup).toContain("hljs-keyword");
    expect(markup).toContain("hljs-string");
    expect(markup).toContain('data-line-number="1"');
    expect(markup).not.toContain("<script>");
  });

  it("renders Markdown files as a document preview and keeps a source toggle", () => {
    const tab = { id: "file:README.md", kind: "file-preview" as const, sessionId: "s1", workspaceDir: "/repo", path: "README.md" };
    const preview = renderToStaticMarkup(createElement(WebuiFilePreview, { tab, codeMode: false, result: { loading: false, content: { type: "text", content: "# Project guide" } } }));
    const source = renderToStaticMarkup(createElement(WebuiFilePreview, { tab, codeMode: true, result: { loading: false, content: { type: "text", content: "# Project guide" } } }));
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

  it("routes workspace and turn review through the same CHANGES tab identity", () => {
    let state = initialWorkspacePanelState;
    state = reduceWorkspacePanelState(state, { type: "open-workspace-review", sessionId: "s1", workspaceDir: "/repo" });
    state = reduceWorkspacePanelState(state, { type: "open-turn-review", sessionId: "s1", workspaceDir: "/repo", messageId: "group-1", assistantMessageId: "assistant-9", turnId: "turn-3", changeSetId: "change-7", files: [{ file: "a.ts", additions: 1, deletions: 0, diff: "+a" }] });
    expect(state.tabs.map((tab) => tab.kind)).toEqual(["review"]);
    expect(state.tabs[0]).toMatchObject({ source: "turn", messageId: "group-1", assistantMessageId: "assistant-9", turnId: "turn-3", changeSetId: "change-7" });
  });

  it("parses only safe workspace file references and preserves line ranges", () => {
    expect(parseWebuiMessageFileReference("src/index.ts:42-45")).toEqual({ path: "src/index.ts", lineStart: 42, lineEnd: 45 });
    expect(parseWebuiMessageFileReference("index.html")).toEqual({ path: "index.html" });
    expect(parseWebuiMessageFileReference("https://example.com/index.ts")).toBeUndefined();
    expect(parseWebuiMessageFileReference("../secret.ts")).toBeUndefined();
    expect(parseWebuiMessageFileReference("src/index.ts:0")).toBeUndefined();
  });

  it("renders assistant file references as navigable links while preserving ordinary URLs", () => {
    const markup = renderToStaticMarkup(createElement(WebuiMarkdown, { source: "Open src/index.ts:42 and `index.html`, or visit https://example.com.", onOpenFile: () => undefined }));
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
