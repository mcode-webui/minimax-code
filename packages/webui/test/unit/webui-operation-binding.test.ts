// Unit tests for the typed operation bindings and their executor.
//
// These pin the *declaration* surface: every operation is either a binding or
// one of the thirteen dedicated handlers, a binding calls exactly the runtime
// method it names with exactly the arguments its declaration computes, the
// receiver is preserved, a missing capability fails at invocation (never at
// assembly) with the historical error class and message, a capability
// exception passes through unchanged, and the result mapper wraps the value in
// the `{ body }` envelope. Compiler-negative cases prove a wrong group, method,
// argument tuple or response mapper is a type error.
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import {
  DEDICATED_OPERATION_NAMES,
  WEBUI_OPERATION_BINDINGS,
  bind,
  createBindingEntries,
  executeBinding,
} from "../../src/server/operation/bind-handlers.js";
import { archiveSessionOperation } from "../../src/server/operation/session.js";
import { getSigninPanelOperation } from "../../src/server/operation/account.js";
import { getUsageQuotaOperation } from "../../src/server/operation/account.js";
import { getPermissionModeOperation } from "../../src/server/operation/permission-mode.js";
import { listSessionsOperation } from "../../src/server/operation/session.js";

/** A port whose every method is a deterministic, self-describing function. */
function deterministicPort(): WebuiHarnessPort {
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  const port = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key === "__calls") return calls;
      if (typeof key !== "string") return undefined;
      return (...args: readonly unknown[]) => {
        calls.push({ method: key, args });
        return Promise.resolve({ method: key, args });
      };
    },
  });
  return port as unknown as WebuiHarnessPort;
}

describe("WebUI operation bindings", () => {
  it("covers every operation exactly once as a binding or a dedicated handler", () => {
    const bindingNames = Object.keys(WEBUI_OPERATION_BINDINGS);
    expect(bindingNames).toHaveLength(86);
    expect(DEDICATED_OPERATION_NAMES).toHaveLength(13);
    const all = new Set<string>([...bindingNames, ...DEDICATED_OPERATION_NAMES]);
    expect(all.size).toBe(99);
    for (const dedicated of DEDICATED_OPERATION_NAMES)
      expect(bindingNames).not.toContain(dedicated);
  });

  it("declares one binding per operation name constant", () => {
    expect(Object.keys(WEBUI_OPERATION_BINDINGS)).toContain("archiveSession");
    expect(Object.keys(WEBUI_OPERATION_BINDINGS)).toContain("getUsageQuota");
    expect(Object.keys(WEBUI_OPERATION_BINDINGS)).not.toContain("sendMessage");
    expect(Object.keys(WEBUI_OPERATION_BINDINGS)).not.toContain("getMessages");
  });

  it("invokes the declared method with the declared arguments and preserves the receiver", async () => {
    const port = deterministicPort();
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.archiveSession, port);
    const result = await entry.handle({ requestId: "r1" }, { id: "s1", archived: true });
    assert.deepEqual(result, {
      body: { method: "archiveSession", args: [{ id: "s1", archived: true }] },
    });
    const calls = (port as unknown as { __calls: Array<{ method: string; args: unknown[] }> })
      .__calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "archiveSession");
    assert.deepEqual(calls[0]?.args, [{ id: "s1", archived: true }]);
  });

  it("maps a spread argument tuple (deleteUserModelProvider takes the id string)", async () => {
    const port = deterministicPort();
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.deleteUserModelProvider, port);
    await entry.handle({ requestId: "r1" }, { providerId: "p1" });
    const calls = (port as unknown as { __calls: Array<{ args: unknown[] }> }).__calls;
    assert.deepEqual(calls[0]?.args, ["p1"]);
  });

  it("calls a no-argument method with no arguments", async () => {
    const port = deterministicPort();
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.getSigninPanel, port);
    await entry.handle({ requestId: "r1" }, {});
    const calls = (port as unknown as { __calls: Array<{ args: unknown[] }> }).__calls;
    assert.deepEqual(calls[0]?.args, []);
  });

  it("materialises every binding into a registry entry keyed by operation name", () => {
    const entries = createBindingEntries(deterministicPort());
    expect(entries.size).toBe(86);
    expect(entries.has("archiveSession")).toBe(true);
    expect(entries.has("sendMessage")).toBe(false);
    for (const entry of entries.values())
      expect(typeof entry.operation.validate).toBe("function");
  });
});

describe("WebUI operation binding missing capabilities", () => {
  it("does not fail at assembly when an optional capability is absent", () => {
    // `getPermissionMode` is optional on the port; materialising must succeed.
    const port = {} as unknown as WebuiHarnessPort;
    expect(() => executeBinding(WEBUI_OPERATION_BINDINGS.getPermissionMode, port)).not.toThrow();
  });

  it("raises the historical Error message at invocation for an absent optional capability", async () => {
    const port = {} as unknown as WebuiHarnessPort;
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.getPermissionMode, port);
    await expect(entry.handle({ requestId: "r1" }, {})).rejects.toThrow(
      "runtime host does not expose permission mode reads",
    );
  });

  it("raises a TypeError when a present capability is not callable", async () => {
    const port = { getPermissionMode: 5 } as unknown as WebuiHarnessPort;
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.getPermissionMode, port);
    await expect(entry.handle({ requestId: "r1" }, {})).rejects.toThrow(
      "port.getPermissionMode is not a function",
    );
  });

  it("raises the historical TypeError for a required capability that is absent", async () => {
    const port = {} as unknown as WebuiHarnessPort;
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.listSessions, port);
    await expect(
      entry.handle({ requestId: "r1" }, { name: "main" }),
    ).rejects.toThrow("port.listSessions is not a function");
  });

  it("leaves an exception thrown by a capability unchanged", async () => {
    const failure = new Error("harness blew up");
    failure.name = "HarnessError";
    const port = {
      archiveSession: () => Promise.reject(failure),
    } as unknown as WebuiHarnessPort;
    const entry = executeBinding(WEBUI_OPERATION_BINDINGS.archiveSession, port);
    await expect(entry.handle({ requestId: "r1" }, { id: "s1" })).rejects.toBe(failure);
  });
});

describe("WebUI operation binding compiler-negative cases", () => {
  it("rejects a wrong group, method, argument tuple and response mapper at compile time", () => {
    // @ts-expect-error getUsageQuota is not a member of the "sessions" group
    bind("sessions")("getUsageQuota")("getUsageQuota");
    // @ts-expect-error "notAMethod" is not a capability of any group
    bind("sessions")("notAMethod")("listSessions");
    bind("sessions")("archiveSession")("archiveSession")({
      operation: archiveSessionOperation,
      // @ts-expect-error the argument tuple must match archiveSession's parameters
      args: () => ["id"],
      result: (value) => value,
    });
    bind("sessions")("archiveSession")("archiveSession")({
      operation: archiveSessionOperation,
      args: (body) => [body],
      // @ts-expect-error the response mapper must produce the declared response
      result: () => ({ notTheResponse: true }),
    });
    bind("sessions")("archiveSession")("getSessionDiff")({
      operation: archiveSessionOperation,
      args: (body) => [body],
      // @ts-expect-error the descriptor's validator must produce the spec request
      result: (value) => value,
    });
    // Keep the referenced descriptors live so the imports are meaningful.
    expect(getSigninPanelOperation.name).toBe("getSigninPanel");
    expect(getUsageQuotaOperation.name).toBe("getUsageQuota");
    expect(getPermissionModeOperation.name).toBe("getPermissionMode");
    expect(listSessionsOperation.name).toBe("listSessions");
  });
});
