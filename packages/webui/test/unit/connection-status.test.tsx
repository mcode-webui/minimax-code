import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectionStatus,
  projectWebuiConnectionState,
} from "../../src/client/ConnectionStatus.js";
import { updateSessionRuntimeState } from "../../src/client/session-runtime-store.js";
import type { WebuiStreamState } from "../../src/client/stream.js";

/**
 * The store is module-level, so each case claims its own session key rather
 * than sharing one and inheriting the previous case's phase.
 */
function seed(
  sessionId: string,
  patch: Partial<Pick<WebuiStreamState, "phase" | "refusal" | "status">>,
): string {
  updateSessionRuntimeState(sessionId, (current) => ({
    ...current,
    stream: { ...current.stream, ...patch },
  }));
  return sessionId;
}

describe("projectWebuiConnectionState", () => {
  it("maps the reconnect phase to reconnecting", () => {
    expect(projectWebuiConnectionState("reconnecting")).toBe("reconnecting");
  });

  it("maps both terminal failure phases to failed", () => {
    expect(projectWebuiConnectionState("error")).toBe("failed");
    expect(projectWebuiConnectionState("refused")).toBe("failed");
  });

  it("treats every working-subscription phase as connected", () => {
    for (const phase of ["idle", "streaming", "waiting", "done"] as const)
      expect(projectWebuiConnectionState(phase)).toBe("connected");
  });
});

describe("ConnectionStatus", () => {
  it("reads a default session as connected", () => {
    const markup = renderToStaticMarkup(<ConnectionStatus sessionId="cs-default" />);
    expect(markup).toContain('data-connection-state="connected"');
    expect(markup).toContain("已连接");
  });

  it("announces the region politely so a change is read without stealing focus", () => {
    const markup = renderToStaticMarkup(<ConnectionStatus sessionId="cs-a11y" />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-testid="webui-connection-status"');
  });

  it("shows the reconnecting state once the stream enters that phase", () => {
    const sessionId = seed("cs-reconnect", { phase: "reconnecting" });
    const markup = renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />);
    expect(markup).toContain('data-connection-state="reconnecting"');
    expect(markup).toContain("正在重连");
  });

  it("shows the failed state for an errored phase", () => {
    const sessionId = seed("cs-error", { phase: "error" });
    expect(renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />))
      .toContain('data-connection-state="failed"');
  });

  it("prefers the server's refusal reason over the generic failure detail", () => {
    const sessionId = seed("cs-refused", { phase: "refused", refusal: "凭据已失效" });
    const markup = renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />);
    expect(markup).toContain("凭据已失效");
    expect(markup).not.toContain("已停止接收更新");
  });

  it("falls back to the status string when no refusal was recorded", () => {
    const sessionId = seed("cs-status", { phase: "error", status: "会话已被服务端关闭" });
    expect(renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />))
      .toContain("会话已被服务端关闭");
  });

  it("keeps the generic detail when a failure recorded no reason at all", () => {
    const sessionId = seed("cs-bare", { phase: "error" });
    const markup = renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />);
    expect(markup).toContain("已停止接收更新");
  });

  it("keys the home screen when no session is selected", () => {
    const markup = renderToStaticMarkup(<ConnectionStatus />);
    expect(markup).toContain('data-connection-state="connected"');
  });

  it("tracks a phase change through the store subscription", () => {
    const sessionId = "cs-live";
    expect(renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />))
      .toContain('data-connection-state="connected"');
    updateSessionRuntimeState(sessionId, (current) => ({
      ...current,
      stream: { ...current.stream, phase: "reconnecting" },
    }));
    expect(renderToStaticMarkup(<ConnectionStatus sessionId={sessionId} />))
      .toContain('data-connection-state="reconnecting"');
  });

  it("appends a host class name without dropping its own", () => {
    const markup = renderToStaticMarkup(<ConnectionStatus sessionId="cs-class" className="ml-2" />);
    expect(markup).toContain("ml-2");
    expect(markup).toContain("webui-connection-status");
  });
});

describe("ConnectionStatus host layout calls", () => {
  it("collapses the connected state when the host asks it to", () => {
    // The shell's usage: 已连接 earns zero pixels. The null return (not an
    // empty div) is the contract — a zero-height leftover would still claim
    // the banner slot's gap and nudge the transcript on every state change.
    const markup = renderToStaticMarkup(
      <ConnectionStatus sessionId="cs-hide-connected" hideWhenConnected />,
    );
    expect(markup).toBe("");
  });

  it("still renders the attention states under hideWhenConnected", () => {
    // The prop is a layout call on the healthy state only: both states that
    // need the reader collapse for nobody.
    const reconnecting = seed("cs-hide-reconnect", { phase: "reconnecting" });
    expect(
      renderToStaticMarkup(<ConnectionStatus sessionId={reconnecting} hideWhenConnected />),
    ).toContain('data-connection-state="reconnecting"');
    const failed = seed("cs-hide-failed", { phase: "refused", refusal: "连接被重置" });
    expect(
      renderToStaticMarkup(<ConnectionStatus sessionId={failed} hideWhenConnected />),
    ).toContain('data-connection-state="failed"');
  });

  it("offers the retry button only in the failed state, and only when wired", () => {
    const retry = () => {};
    // No callback, no button — a host without a recovery path must not offer
    // one (the same rule the rail's pin/star buttons follow).
    const failedUnwired = seed("cs-retry-unwired", { phase: "refused" });
    expect(
      renderToStaticMarkup(<ConnectionStatus sessionId={failedUnwired} onRetry={retry} />),
    ).toContain('data-testid="webui-connection-status-retry"');
    expect(
      renderToStaticMarkup(<ConnectionStatus sessionId={failedUnwired} />),
    ).not.toContain("webui-connection-status-retry");
    // Reconnecting is the automatic loop mid-attempt; a button there would
    // race the recovery it duplicates.
    const reconnecting = seed("cs-retry-reconnect", { phase: "reconnecting" });
    expect(
      renderToStaticMarkup(<ConnectionStatus sessionId={reconnecting} onRetry={retry} />),
    ).not.toContain("webui-connection-status-retry");
    // The healthy state never carries it either.
    expect(
      renderToStaticMarkup(<ConnectionStatus sessionId="cs-retry-ok" onRetry={retry} />),
    ).not.toContain("webui-connection-status-retry");
  });

  it("is mounted by the shell with the collapsed-when-healthy layout call", () => {
    // Source-level, the same convention the child-row meta and rail wiring
    // tests use: `renderToStaticMarkup` cannot fire the store subscription a
    // real mount needs, and the browser spec proves the placed region for
    // real. What this pins is that the shell actually renders the component —
    // before Q-1 the component existed with zero consumers, which is exactly
    // the gap that made every connection state invisible.
    const source = readFileSync(
      new URL("../../src/client/components/WebuiClientFoundationApp.tsx", import.meta.url),
      "utf8",
    );
    const mountAt = source.indexOf("<ConnectionStatus");
    expect(mountAt, "the shell no longer mounts ConnectionStatus").toBeGreaterThanOrEqual(0);
    const mount = source.slice(mountAt, mountAt + 300);
    expect(mount).toContain("hideWhenConnected");
    expect(mount).toContain("onRetry={retrySessionStream}");
    expect(mount).toContain('sessionId={selectedSessionId}');
  });
});
