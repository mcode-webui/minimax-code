// The harness's host-slot guards (U21).
//
// Every optional host slot used to be guarded by hand — `if (!host.x) throw new
// Error("runtime host does not expose …")` — and three call sites had no guard
// at all, only a non-null assertion, so a host missing that slot produced a
// `TypeError: … is not a function` instead of the uniform message. One
// `requireHostSlot` now serves them all.
//
// The message text is the contract this file pins: it reaches the user. The
// `/compact` case is the one the code comments call out — folding it into the
// CLI-service error would tell a user with a host that supports compaction
// nothing about why their command failed.
import { describe, expect, it } from "vitest";

import { createExecutionAdapter } from "../../src/runtime/harness/execution.js";
import {
  requireCliService,
  requireDataDir,
  requireHostSlot,
} from "../../src/runtime/harness/requirements.js";
import type { WebuiRuntimeHostHandle } from "../../src/runtime/harness/host-contract.js";

/** A host with nothing filled in: every slot this file asks for is absent. */
const EMPTY_HOST = {} as WebuiRuntimeHostHandle;

describe("requireHostSlot", () => {
  it("returns the slot when it is present", () => {
    const slot = () => 1;
    expect(requireHostSlot(slot, "a thing")).toBe(slot);
  });

  it("names the missing slot in the uniform message", () => {
    expect(() => requireHostSlot(undefined, "the usage quota client")).toThrow(
      "runtime host does not expose the usage quota client",
    );
  });
});

describe("the named slots on top of it", () => {
  it("keeps the CLI service and data directory messages", () => {
    expect(() => requireCliService(EMPTY_HOST)).toThrow(
      "runtime host does not expose the CLI service",
    );
    expect(() => requireDataDir(EMPTY_HOST)).toThrow(
      "runtime host does not expose a data directory",
    );
  });
});

describe("an adapter's guards reach the caller with their own name", () => {
  it("reports the missing CLI service for compaction", async () => {
    const adapter = createExecutionAdapter(EMPTY_HOST);
    await expect(adapter.requestCompaction({} as never)).rejects.toThrow(
      "runtime host does not expose the CLI service",
    );
  });

  it("reports requestCompaction by name when only that slot is missing", async () => {
    // The whole point of the separate name: this host HAS a CLI service, so
    // "does not expose the CLI service" would be false as well as unhelpful.
    const host = { cliService: {} } as unknown as WebuiRuntimeHostHandle;
    const adapter = createExecutionAdapter(host);
    await expect(adapter.requestCompaction({} as never)).rejects.toThrow(
      "runtime host does not expose requestCompaction",
    );
  });
});
