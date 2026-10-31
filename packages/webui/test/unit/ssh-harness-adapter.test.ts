/**
 * The SSH cell of the harness port.
 *
 * The claims are about the boundary and about honesty:
 *
 *   * the runtime's own records convert into the wire DTOs — every optional field elided rather
 *     than emitted as `undefined`, and the status word carried as it is;
 *   * a host that cannot be reached is reported as `probe_failed`, never as a `connected` nobody
 *     verified. The transport is injected, so this is asserted without a network;
 *   * a host without a data directory answers with one stated refusal instead of an empty list
 *     that reads as "you have no hosts".
 *
 * The real adapter, the real repository and the real service run here; only the transport leaves
 * are scripted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSshAdapter } from "../../src/runtime/harness/ssh.js";
import type { WebuiRuntimeHostHandle } from "../../src/runtime/harness/host-contract.js";
import { createSshRuntime } from "../../src/runtime/ssh/index.js";
import type { SshTransport } from "../../src/runtime/ssh/transport.js";
import type { SshRuntime } from "../../src/runtime/ssh/index.js";

const directories: string[] = [];

function temporaryDataDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "webui-ssh-adapter-"));
  directories.push(directory);
  return directory;
}

/** A transport that reaches nothing: the host is genuinely unreachable. */
const unreachableTransport: SshTransport = {
  run: async () => ({
    stdout: "",
    stderr: "ssh: connect to host example.com port 22: Connection refused",
    code: 255,
    timedOut: false,
  }),
  spawnTerminal: () => {
    throw new Error("no terminal in this test");
  },
};

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("the SSH harness adapter", () => {
  it("refuses every member when the host exposes no data directory", async () => {
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle);
    await expect(adapter.listSshConnections()).rejects.toThrow(
      "runtime host does not expose a data directory",
    );
  });

  it("reports a host that cannot be reached as probe_failed", async () => {
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport: unreachableTransport,
    });
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });

    const saved = await adapter.saveSshConnection({
      alias: "build",
      endpoint: { kind: "manual", host: "example.com" },
    });

    expect(saved.success).toBe(true);
    expect(saved.probe?.status).toBe("probe_failed");
    expect(saved.connection?.status).toBe("probe_failed");
    expect(saved.connection?.lastError).toContain("Connection refused");

    const listed = await adapter.listSshConnections();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("probe_failed");
    expect(listed[0]?.enabled).toBe(true);
  });

  it("converts the runtime's records into the wire DTOs", async () => {
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport: unreachableTransport,
    });
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });

    await adapter.saveSshConnection({
      alias: "build",
      displayName: "Build machine",
      endpoint: { kind: "manual", host: "example.com", port: 2222, username: "builder" },
    });

    const listed = await adapter.listSshConnections();
    expect(listed).toHaveLength(1);
    const connection = listed[0];
    expect(connection?.alias).toBe("build");
    expect(connection?.displayName).toBe("Build machine");
    expect(connection?.endpoint).toEqual({
      kind: "manual",
      host: "example.com",
      port: 2222,
      username: "builder",
    });
    // An absent optional field is elided rather than sent as `undefined`.
    expect(Object.prototype.hasOwnProperty.call(connection?.endpoint ?? {}, "identityFile")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(connection ?? {}, "lastError")).toBe(true);
  });

  it("switches a host off and reports the disabled status", async () => {
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport: unreachableTransport,
    });
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });

    await adapter.saveSshConnection({
      alias: "build",
      endpoint: { kind: "manual", host: "example.com" },
    });
    const disabled = await adapter.setSshConnectionEnabled({ alias: "build", enabled: false });
    expect(disabled.success).toBe(true);
    expect(disabled.connection?.status).toBe("disabled");
    expect(disabled.connection?.enabled).toBe(false);
  });

  it("names the projects that a removal took with it", async () => {
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport: unreachableTransport,
    });
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });

    await adapter.saveSshConnection({
      alias: "build",
      endpoint: { kind: "manual", host: "example.com" },
    });
    const project = await adapter.saveSshProject({
      alias: "build",
      path: "/srv/app",
      displayName: "app",
    });
    expect(project.success).toBe(true);

    const removed = await adapter.removeSshConnection({ alias: "build" });
    expect(removed.success).toBe(true);
    expect(removed.removedProjectIds).toEqual([project.project?.id]);
    expect(await adapter.listSshProjects()).toEqual([]);
    expect(await adapter.listSshConnections()).toEqual([]);
  });

  it("refuses a host that is not there instead of reporting a removal that did not happen", async () => {
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport: unreachableTransport,
    });
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });
    const removed = await adapter.removeSshConnection({ alias: "ghost" });
    expect(removed.success).toBe(false);
    expect(removed.error).toBe("connection_not_found");
    expect(removed.removedProjectIds).toEqual([]);
  });

  it("answers a missing terminal with a refusal rather than an empty stream", async () => {
    const runtime = await createSshRuntime({
      dataDir: temporaryDataDir(),
      transport: unreachableTransport,
    });
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });
    const answer = await adapter.watchSshTerminal({ terminalId: "ssh-terminal-ghost" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.status).toBe(404);
      expect(answer.body.message).toContain("终端");
    }
  });

  it("forwards a discovery that the runtime answered", async () => {
    const runtime: SshRuntime = {
      ...(await createSshRuntime({
        dataDir: temporaryDataDir(),
        transport: unreachableTransport,
      })),
      discovery: async () => ({
        configFound: true,
        hosts: [{ alias: "build", hostname: "build.example.com", user: "builder", port: 2222 }],
      }),
    };
    const adapter = createSshAdapter({} as WebuiRuntimeHostHandle, { runtime });
    const discovery = await adapter.discoverSshHosts();
    expect(discovery.configFound).toBe(true);
    expect(discovery.hosts).toEqual([
      { alias: "build", hostname: "build.example.com", user: "builder", port: 2222 },
    ]);
  });
});
