import { describe, expect, it } from "vitest";
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
