/**
 * The SSH business owner.
 *
 * Two claims:
 *
 *   * an unwired transport is not an empty list — "this host cannot manage SSH hosts" and "you
 *     have no SSH hosts" are different answers, and only the second belongs in the empty state;
 *   * the terminal's output arrives through the watch's frame callback, and the watch's
 *     unsubscribe function is what the owner keeps — a terminal that is detached must not keep
 *     writing into a panel that is gone.
 */
import { describe, expect, it } from "vitest";

import { createWebuiSshOwner } from "../../src/client/features/ssh/application/ssh-owner.js";
import { WEBUI_SSH_UNAVAILABLE } from "../../src/client/features/ssh/projection/ssh-panel.js";
import type { SshPort } from "../../src/client/features/ssh/contracts/ssh-port.js";
import type { WebuiSshConnection } from "../../src/shared/contracts/ssh.js";

function connection(overrides: Partial<WebuiSshConnection> = {}): WebuiSshConnection {
  return {
    alias: "build",
    displayName: "Build machine",
    endpoint: { kind: "manual", host: "example.com" },
    enabled: true,
    status: "connected",
    ...overrides,
  };
}

describe("the SSH owner", () => {
  it("refuses one stated way when the transport carries no SSH operations", async () => {
    const owner = createWebuiSshOwner({ port: {} });
    await owner.load();
    expect(owner.getSnapshot().status).toBe("error");
    expect(owner.getSnapshot().error).toBe(WEBUI_SSH_UNAVAILABLE);
  });

  it("keeps the last good rows when a read fails", async () => {
    let fail = false;
    const port: SshPort = {
      listSshConnections: async () => {
        if (fail) throw new Error("读取 SSH 主机失败。");
        return [connection()];
      },
      listSshProjects: async () => [],
    };
    const owner = createWebuiSshOwner({ port });
    await owner.load();
    expect(owner.getSnapshot().status).toBe("ready");

    fail = true;
    await owner.load();
    expect(owner.getSnapshot().status).toBe("error");
    expect(owner.getSnapshot().connections).toHaveLength(1);
  });

  it("takes the output through the watch's frame callback and keeps the unsubscribe", async () => {
    let deliver: ((frame: { readonly data: string }) => void) | undefined;
    let unsubscribed = false;
    const port: SshPort = {
      listSshConnections: async () => [connection()],
      listSshProjects: async () => [],
      openSshTerminal: async () => ({ terminalId: "t1", alias: "build", status: "running" }),
      watchSshTerminal: (_request, onFrame) => {
        deliver = onFrame;
        return () => {
          unsubscribed = true;
        };
      },
    };
    const owner = createWebuiSshOwner({ port });
    await owner.load();
    const opened = await owner.openTerminal("build");
    expect(opened.ok).toBe(true);

    const stop = owner.watchTerminal();
    deliver?.({ data: "hello" });
    deliver?.({ data: " world" });
    expect(owner.getTerminalSnapshot().output).toBe("hello world");
    expect(owner.getTerminalSnapshot().status).toBe("running");

    stop();
    expect(unsubscribed).toBe(true);
  });

  it("reports a terminal the host cannot host as a failed opening", async () => {
    const port: SshPort = {
      listSshConnections: async () => [],
      listSshProjects: async () => [],
      openSshTerminal: async () => ({
        terminalId: "",
        alias: "build",
        status: "failed",
        error: "这个主机已停用。",
      }),
    };
    const owner = createWebuiSshOwner({ port });
    const opened = await owner.openTerminal("build");
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.message).toBe("这个主机已停用。");
    expect(owner.getTerminalSnapshot().status).toBe("failed");
  });

  it("names the projects a removal took with it", async () => {
    const port: SshPort = {
      listSshConnections: async () => [],
      listSshProjects: async () => [],
      removeSshConnection: async () => ({ success: true, removedProjectIds: ["p1", "p2"] }),
    };
    const owner = createWebuiSshOwner({ port });
    const removed = await owner.removeConnection("build");
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.removedProjectIds).toEqual(["p1", "p2"]);
  });
});
