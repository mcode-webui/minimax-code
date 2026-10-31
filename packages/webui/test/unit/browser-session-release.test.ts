// A session's pages are released when the session ends.
//
// There is no per-session lifecycle signal in the runtime to hang this on: a
// session is removed by deletion, by archiving, and by a transfer away, and
// the three reach the runtime differently. The release is therefore keyed on
// the **session**, and this file is the evidence that all three paths reach
// it — and that a session that is still open keeps its pages.
//
// A page in the isolated Chromium is a live process with a live target, so a
// session that ends and leaves a page behind leaves a browser nobody can
// switch off.

import { describe, expect, it, vi } from "vitest";

import { WebuiBrowserService } from "../../src/runtime/browser/browser-service.js";
import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import { importWebuiSessionTransfer } from "../../src/runtime/session-transfer.js";
import type { WebuiBrowserSurfaceProvider } from "../../src/runtime/browser/isolated-chromium/provider.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserImageFrame,
  WebuiBrowserTargetId,
  WebuiBrowserTargetState,
} from "../../src/shared/contracts/browser.js";

const SESSION = "session-1";
const OTHER = "session-2";

/** A provider that records what it was asked to do. */
class RecordingProvider implements WebuiBrowserSurfaceProvider {
  readonly surface = "isolated-chromium" as const;
  readonly browserId = "browser-1";
  readonly commands: { command: string; params: Record<string, unknown> }[] = [];
  readonly startedStreams: string[] = [];
  readonly stoppedStreams: string[] = [];
  /** The pages this browser has, in the order they were opened. */
  readonly openedTabs: string[] = [];
  private readonly frameHandlers = new Map<string, (frame: WebuiBrowserImageFrame) => void>();

  async listTargets(): Promise<readonly WebuiBrowserTargetState[]> {
    return ["tab-1", ...this.openedTabs].map((targetId) => ({
      id: {
        surface: this.surface,
        browserId: this.browserId,
        targetId,
        generation: 1,
      },
      title: `Tab ${targetId}`,
      url: `https://example.test/${targetId}`,
      status: "open" as const,
      selected: false,
    }));
  }

  async sendCommand(
    _target: unknown,
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.commands.push({ command, params });
    if (command !== "open_tab") return undefined;
    // A command that opened a page answers with that page's identity, the way
    // the isolated provider answers: the surface, the browser, the target and
    // the generation the provider's own accounting gives it. Every page gets
    // its own target id, because a target id names one page.
    const targetId = `tab-${this.openedTabs.length + 2}`;
    this.openedTabs.push(targetId);
    return {
      surface: this.surface,
      browserId: this.browserId,
      targetId,
      generation: 1,
    } satisfies WebuiBrowserTargetId;
  }

  async sendInput(): Promise<void> {}

  async startImageStream(
    targetId: string,
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void> {
    this.startedStreams.push(targetId);
    this.frameHandlers.set(targetId, onFrame);
  }

  frameHandlerFor(targetId: string): ((frame: WebuiBrowserImageFrame) => void) | undefined {
    return this.frameHandlers.get(targetId);
  }

  async stopImageStream(targetId: string): Promise<void> {
    this.stoppedStreams.push(targetId);
    this.frameHandlers.delete(targetId);
  }

  onTargetChanged(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {}
}

function tab(targetId: string, generation = 1): WebuiBrowserTargetId {
  return {
    surface: "isolated-chromium",
    browserId: "browser-1",
    targetId,
    generation,
  };
}

/**
 * A browser service, a harness port, and the edge that joins them.
 *
 * The edge is the composition root's: it is the only place that holds both
 * the harness port and the browser service, so it is the place that can wire
 * a session's end to the release of that session's pages.
 */
function createReleaseHarness(): {
  service: WebuiBrowserService;
  provider: RecordingProvider;
  port: ReturnType<typeof createHarnessPortFromHost>;
} {
  const provider = new RecordingProvider();
  const authorization: WebuiBrowserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    fullCdp: false,
  };
  const service = new WebuiBrowserService({
    authorization: {
      read: async () => authorization,
      write: async () => authorization,
    },
    dataDir: "/tmp/webui-session-release-test",
    createIsolatedProvider: async () => provider,
  });
  const port = createHarnessPortFromHost(
    {
      apiHost: { close: async () => undefined },
      cliService: {
        archiveSession: async () => ({ success: true }),
        deleteSession: async () => ({ success: true }),
        createSession: async () => ({ sessionId: "imported-session" }),
        getBrowserAuthorization: async () => authorization,
        setBrowserAuthorization: async () => authorization,
      } as never,
    },
    { onSessionEnded: (sessionId) => service.releaseSession(sessionId) },
  );
  return { service, provider, port };
}

/** Gives one session a page of its own and selects it. */
async function openPageFor(
  service: WebuiBrowserService,
  sessionId: string,
): Promise<WebuiBrowserTargetId> {
  await service.listTargets("isolated-chromium", sessionId);
  await service.selectTarget(tab("tab-1"), sessionId);
  const opened = await service.sendCommandToSelection(
    "isolated-chromium",
    sessionId,
    "open_tab",
    { url: "https://example.test/opened" },
  );
  return opened.result as WebuiBrowserTargetId;
}

describe("a session's pages are released when the session ends", () => {
  it("releases a deleted session's page, target and selection", async () => {
    const { service, provider, port } = createReleaseHarness();
    const opened = await openPageFor(service, SESSION);

    await port.deleteSession({ id: SESSION });

    // The page is closed rather than left running in the browser.
    expect(
      provider.commands.some((entry) => entry.command === "Target.closeTarget"),
    ).toBe(true);
    // The target is gone from the registry, so it can no longer be selected.
    await expect(service.selectTarget(opened, SESSION)).rejects.toMatchObject({
      code: "browser_target_unknown",
    });
    // And the run's selection went with it.
    const list = await service.listTargets("isolated-chromium", SESSION);
    expect(list.targets.some((entry) => entry.selected)).toBe(false);
    await service.close();
  });

  it("releases an archived session's page, target and selection", async () => {
    const { service, provider, port } = createReleaseHarness();
    const opened = await openPageFor(service, SESSION);

    await port.archiveSession({ id: SESSION });

    expect(
      provider.commands.some((entry) => entry.command === "Target.closeTarget"),
    ).toBe(true);
    await expect(service.selectTarget(opened, SESSION)).rejects.toMatchObject({
      code: "browser_target_unknown",
    });
    const list = await service.listTargets("isolated-chromium", SESSION);
    expect(list.targets.some((entry) => entry.selected)).toBe(false);
    await service.close();
  });

  it("releases a session that was transferred away", async () => {
    const { service, provider, port } = createReleaseHarness();
    await openPageFor(service, "imported-session");

    // The import fails, so the runtime removes the session it created. That
    // removal is the same `deleteSession` the release is wired to, so the
    // session's pages go with it.
    const outcome = await importWebuiSessionTransfer(port, {
      file: { session: { sessionId: "source-session" } },
      agentName: "imported",
    });
    expect(outcome.kind).toBe("import-failed");

    expect(
      provider.commands.some((entry) => entry.command === "Target.closeTarget"),
    ).toBe(true);
    await service.close();
  });

  it("keeps the pages of a session that is still open", async () => {
    const { service, provider, port } = createReleaseHarness();
    const released = await openPageFor(service, SESSION);
    const kept = await openPageFor(service, OTHER);

    await port.deleteSession({ id: SESSION });

    // Only the released session's page was closed. The other session's page
    // is still there, because that session is still open.
    const closed = provider.commands.filter(
      (entry) => entry.command === "Target.closeTarget",
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.params.targetId).toBe(released.targetId);
    await expect(service.selectTarget(kept, OTHER)).resolves.toBeDefined();
    await service.close();
  });

  it("stops the frames of a released page", async () => {
    const { service, provider, port } = createReleaseHarness();
    const opened = await openPageFor(service, SESSION);

    const frames: WebuiBrowserImageFrame[] = [];
    const controller = new AbortController();
    const stream = (async () => {
      for await (const frame of service.watchFrames(
        "isolated-chromium",
        opened,
        controller.signal,
      )) {
        frames.push(frame);
      }
    })();
    await vi.waitFor(() => expect(provider.startedStreams).toContain(opened.targetId));
    const lateFrame = provider.frameHandlerFor(opened.targetId);
    expect(lateFrame).toBeTypeOf("function");

    await port.deleteSession({ id: SESSION });

    // The screencast for the released page is stopped rather than left
    // running for a page that no longer exists.
    expect(provider.stoppedStreams).toContain(opened.targetId);
    // A provider callback that was already in flight at release cannot
    // reintroduce a frame for the target after the registry forgets it.
    lateFrame?.({ target: opened, data: "AAAA", format: "png", sequence: 1 });
    expect(frames).toHaveLength(0);
    controller.abort();
    await stream.catch(() => undefined);
    await service.close();
  });
});
