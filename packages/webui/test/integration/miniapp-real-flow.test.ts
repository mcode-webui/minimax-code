// The Mini App business flow, against the real host.
//
// The Mini App gates that exist today prove the wire and the protocol: the
// page bridge's operations run against a scripted port, and the browser specs
// run against a fixture transport with a stub page. Both say so in their own
// headers. Neither one starts a Mini App, so the part of the product a person
// actually touches — a package becomes installed, it appears in the list, it
// starts, its own page answers, it stops, it is disabled, it is uninstalled —
// had no gate at all. A runner that cannot start (RUNNER_EXITED) therefore
// passed every one of them.
//
// This file closes that gap at the wire level. It boots the production
// assembly (`createWebuiRuntimeHost`, whose default factory is the real
// `createLocalRuntimeHostV2`), so the Mini App supervisor, the plugin system,
// the node runtime and the runner child process are the shipped ones. It
// installs a real Mini App package into an isolated data directory, drives the
// real operations over a real loopback socket, and reads the Mini App's own
// page back through the real proxy.
//
// The boundary, stated rather than implied:
//
//   * The publication of a package is the file move the real importer performs
//     (a rename out of the import staging area into the local plugin root). The
//     network fetch that precedes it in the product — the marketplace, or a
//     GitHub clone — is out of scope for a hermetic gate, and the enable that
//     follows it is driven through the real `pluginManagement` operation.
//   * Everything after the publication is the product's own code: the
//     catalogue projection, the supervisor, the node runtime, the runner child
//     process, the Mini App's HTTP server, the loopback guard and the proxy.
//
// The browser half of the same flow — the buttons a person actually clicks —
// is `miniapp-ui-flow.test.ts`. The data directory is a temporary one, so a
// run can never reach the operator's own `~/.minimax`.

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_SOURCE,
  PAGE_MARKER,
  bodyOf,
  bootRealHost,
  closeAllBootedHosts,
  connect,
  expectAnswered,
  openCause,
  publishLocalPackage,
  rowsOf,
  runtimeStatusOf,
  waitFor,
} from "./miniapp-real-flow-support.js";

afterEach(async () => {
  await closeAllBootedHosts();
});

describe("the Mini App business flow against the real host", () => {
  it("lists no Mini App before one is installed", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);

    const listed = await client.call("listMiniApps");
    expect(listed.kind).toBe("response");
    expect(rowsOf(listed)).toEqual([]);
  }, 60_000);

  it("installs a Mini App, lists it, opens it, serves its page and stops it", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);
    const name = "flow.miniapp";

    await publishLocalPackage(host.dataDir, name);
    const enabled = await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    expectAnswered(enabled);

    // The catalogue is a projection of the runtime's own snapshot, so the row
    // appears when the runtime has rebuilt it — not when the file was moved.
    const row = await waitFor(
      async () =>
        rowsOf(await client.call("listMiniApps")).find((entry) => entry.pluginId === name),
      `${name} to appear in the catalogue`,
    );
    expect(row.runtime).toMatchObject({ kind: "process" });
    expect(runtimeStatusOf(row)).toBe("stopped");
    // The row says where the package came from. A local package and an
    // official one are changed by different paths, and the surface cannot
    // choose without this — without it every mutation of a local Mini App is
    // read as an official one and refused.
    expect(row.source).toBe("local");

    const opened = await client.call("openMiniApp", { pluginId: name });
    if (opened.kind !== "response") {
      const cause = await openCause(host, name);
      throw new Error(
        `openMiniApp failed: ${JSON.stringify(opened)} — cause: ${cause.join(" <- ")}`,
      );
    }
    const view = bodyOf(opened);
    expect(view.pluginId).toBe(name);
    expect(typeof view.viewUrl).toBe("string");

    // The Mini App's own page, read back through the service's own proxy. A
    // stubbed runtime cannot answer this: the page is produced by the child
    // process the runner started.
    const page = await fetch(String(view.viewUrl));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(PAGE_MARKER);

    const stopped = await client.call("stopMiniApp", { pluginId: name });
    expectAnswered(stopped);
    await waitFor(
      async () => {
        const current = rowsOf(await client.call("listMiniApps")).find(
          (entry) => entry.pluginId === name,
        );
        return runtimeStatusOf(current) === "stopped" ? current : undefined;
      },
      `${name} to report that it stopped`,
    );
  }, 120_000);

  it("refuses to open a Mini App that is not installed", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);

    const opened = await client.call("openMiniApp", { pluginId: "absent.miniapp" });
    // A refusal is an answer: the frame carries a code, and the gate reads
    // that code rather than the kind, because a dropped connection and a
    // refusal would otherwise look the same.
    expect(opened.kind).toBe("error");
    expect(opened.code).toBeTruthy();
    // Nothing was started, so nothing appears in the catalogue.
    expect(rowsOf(await client.call("listMiniApps"))).toEqual([]);
  }, 60_000);

  it("keeps a Mini App that failed to start out of the running set", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);
    const name = "broken.miniapp";

    await publishLocalPackage(host.dataDir, name, { broken: true });
    await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    await waitFor(
      async () =>
        rowsOf(await client.call("listMiniApps")).find((entry) => entry.pluginId === name),
      `${name} to appear in the catalogue`,
    );

    const opened = await client.call("openMiniApp", { pluginId: name });
    // The failure is answered, not left hanging: a start that cannot succeed
    // says so instead of leaving the person waiting.
    expect(opened.kind).toBe("error");
    expect(opened.code).toBe("MINIAPP_PREPARATION_FAILED");

    // The runtime's own reason is behind that code, and it is the one the
    // person has to act on: the entry refused to start.
    const cause = await openCause(host, name);
    expect(cause.join(" <- ")).toContain("RUNNER_START_FAILED");

    // And the Mini App is not left claiming to be running: the row says the
    // start failed, and names the reason, instead of reading as a Mini App
    // that was stopped and can be started again.
    const row = rowsOf(await client.call("listMiniApps")).find(
      (entry) => entry.pluginId === name,
    );
    expect(runtimeStatusOf(row)).toBe("failed");
    const runtime = row?.runtime as { readonly errorCode?: unknown } | undefined;
    expect(runtime?.errorCode).toBeTruthy();
  }, 120_000);

  it("disables an installed Mini App, keeps it listed and enables it again", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);
    const name = "toggle.miniapp";

    await publishLocalPackage(host.dataDir, name);
    await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    await waitFor(
      async () =>
        rowsOf(await client.call("listMiniApps")).find((entry) => entry.pluginId === name),
      `${name} to appear in the catalogue`,
    );

    const disabled = await client.call("pluginManagement", {
      action: "disablePlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    expectAnswered(disabled);

    // A disabled Mini App stays visible — the management surface has to offer
    // to enable it — and it is marked as not startable.
    const row = await waitFor(
      async () => {
        const current = rowsOf(await client.call("listMiniApps")).find(
          (entry) => entry.pluginId === name,
        );
        return current?.enabled === false ? current : undefined;
      },
      `${name} to report that it is disabled`,
    );
    expect(row.enabled).toBe(false);

    const enabled = await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    expectAnswered(enabled);
    await waitFor(
      async () => {
        const current = rowsOf(await client.call("listMiniApps")).find(
          (entry) => entry.pluginId === name,
        );
        return current?.enabled === true ? current : undefined;
      },
      `${name} to report that it is enabled again`,
    );
  }, 120_000);

  it("uninstalls a Mini App and drops it from the catalogue", async () => {
    const host = await bootRealHost();
    const client = await connect(host.url);
    const name = "removable.miniapp";

    await publishLocalPackage(host.dataDir, name);
    await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    await waitFor(
      async () =>
        rowsOf(await client.call("listMiniApps")).find((entry) => entry.pluginId === name),
      `${name} to appear in the catalogue`,
    );

    const uninstalled = await client.call("pluginManagement", {
      action: "uninstallPlugin",
      input: { pluginName: name, source: LOCAL_SOURCE },
    });
    expectAnswered(uninstalled);

    await waitFor(
      async () => {
        const rows = rowsOf(await client.call("listMiniApps"));
        return rows.every((entry) => entry.pluginId !== name) ? rows : undefined;
      },
      `${name} to leave the catalogue`,
    );
  }, 120_000);
});
