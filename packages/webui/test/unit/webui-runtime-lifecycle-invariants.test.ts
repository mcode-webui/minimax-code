// The WebUI runtime's three single-owner invariants (plan section 7.1, the
// `runtime/` exit condition): exactly one OAuth core, exactly one refresh-timer
// owner and exactly one close owner, with a single host close that is not
// double-wrapped and a re-close that is idempotent.
//
// These are asserted as *behaviour* through the real factory
// (`createWebuiRuntimeHost`), not as a snapshot of the source. The OAuth-core
// and auth-session constructions are counted by intercepting the modules that
// perform them and delegating to the real implementations, so the test sees an
// extra construction (of either) as a failure. The close owner is counted the
// way a caller sees it: both public close entry points go through one wrapper,
// so the factory-supplied `apiHost.close` runs exactly once for however many
// times the runtime is closed.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resetDefaultLocalRuntimeConfig } from "@mavis/local-runtime-v2";

import { createWebuiRuntimeHost } from "../../src/runtime/index.js";

// `vi.mock` factories are hoisted above the imports, so the counters they
// close over must be hoisted too.
const counters = vi.hoisted(() => ({
  oauthCoreConstructions: 0,
  authSessionCreations: 0,
  authDisposeCalls: 0,
}));

// Count `MCodeOAuthCore` constructions while keeping the real core: the
// subclass delegates to the upstream implementation, so the runtime behaves
// exactly as it does in production and only the construction count is
// observed. A second OAuth core anywhere in the graph increments this.
vi.mock("@mavis/oauth-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mavis/oauth-core")>();
  class CountingOAuthCore extends actual.MCodeOAuthCore {
    constructor(options: ConstructorParameters<typeof actual.MCodeOAuthCore>[0]) {
      super(options);
      counters.oauthCoreConstructions += 1;
    }
  }
  return { ...actual, MCodeOAuthCore: CountingOAuthCore };
});

// Count the one refresh-timer owner. The refresh timer lives in the auth
// session (`runtime/auth-session.ts`); a second auth session would be a second
// timer owner, so its construction is counted and its `dispose` (the timer's
// teardown, run by the close owner) is counted too.
vi.mock("../../src/runtime/auth-session.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/runtime/auth-session.js")
  >();
  return {
    ...actual,
    createWebuiAuthSession: (
      options: Parameters<typeof actual.createWebuiAuthSession>[0],
    ) => {
      counters.authSessionCreations += 1;
      const session = actual.createWebuiAuthSession(options);
      const realDispose = session.dispose;
      return {
        ...session,
        dispose: () => {
          counters.authDisposeCalls += 1;
          realDispose();
        },
      };
    },
  };
});

describe("WebUI runtime single-owner invariants", () => {
  it("constructs one OAuth core and one refresh-timer owner, and one idempotent close owner", async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-runtime-invariants-"),
    );
    let runtimeCloseCalls = 0;
    try {
      // Keep the runtime's config read hermetic: without these the cold config
      // load performs git auto-config, which is slow and unrelated to the
      // invariants under test.
      vi.stubEnv("MINIMAX_DATA_DIR", dataDir);
      vi.stubEnv("DISABLE_GIT_AUTO_CONFIG", "1");
      resetDefaultLocalRuntimeConfig();

      const assembled = await createWebuiRuntimeHost({
        dataDir,
        // The broker is orthogonal to these invariants; keep its preparation
        // scripted so the test does not depend on a bundled resource.
        mcodeTools: {
          prepare: async () => ({
            requested: false,
            ready: false,
            category: "disabled" as const,
            ensureCommandPath: () => undefined,
            dispose: async () => undefined,
          }),
        },
        factory: async (options) => ({
          apiHost: {
            async close(): Promise<void> {
              runtimeCloseCalls += 1;
            },
          },
          dataDir: options.dataDir,
        }),
      });

      // (1) Exactly one OAuth core construction.
      expect(counters.oauthCoreConstructions).toBe(1);
      // (2) Exactly one refresh-timer owner (the single auth session).
      expect(counters.authSessionCreations).toBe(1);

      // (3) Exactly one close owner. Both public entry points reach the same
      // wrapper, so the factory host's close runs once — two independent close
      // owners would each invoke it and the count would be two.
      await assembled.host.apiHost.close();
      await assembled.harnessPort.close();
      expect(runtimeCloseCalls).toBe(1);
      // The refresh-timer owner's teardown ran exactly once, through that same
      // single close owner.
      expect(counters.authDisposeCalls).toBe(1);

      // Idempotent re-close: nothing runs a second time.
      await assembled.host.apiHost.close();
      await assembled.harnessPort.close();
      expect(runtimeCloseCalls).toBe(1);
      expect(counters.authDisposeCalls).toBe(1);
    } finally {
      resetDefaultLocalRuntimeConfig();
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
