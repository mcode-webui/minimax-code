/**
 * The unary request interface derives its types from `OperationSpec`, and the
 * stream family is not part of it.
 *
 * Three things are pinned here, each by the seam that can actually fail:
 *
 *   * the **positive** relation — a call's argument and result types come from
 *     the operation name, not from a caller-supplied generic;
 *   * the **negative** relation — a wrong body, a wrong assumed result and a
 *     stream name passed to `request` are all compile errors, proven with a
 *     compiled test program rather than by reading the declaration;
 *   * the **shared stream set** against the server's registered stream
 *     descriptors, so a newly added stream cannot silently stay callable
 *     through the unary interface.
 *
 * The type-level assertions only mean something because this file is in
 * `tsconfig.test.json`'s `include` and in `test/vitest-suites.json` — a probe in
 * a file no gate compiles proves nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { WebuiWire } from "../../src/client/platform/wire.js";
import {
  WEBUI_OPERATION_BINDINGS,
} from "../../src/server/operation/bind-handlers.js";
import type { WebuiOperationPort } from "../../src/server/operation/bind-handlers.js";
import { createStreamHandlerEntries } from "../../src/server/operation/handlers/stream.js";
import { createRemoteControlHandlerEntries } from "../../src/server/operation/handlers/remote-control.js";
import { createSshHandlerEntries } from "../../src/server/operation/handlers/ssh.js";
import { watchTerminalOperation } from "../../src/server/operation/workspace.js";
import { watchBrowserFramesOperation, watchBrowserWebTabsOperation } from "../../src/server/operation/browser.js";
import { watchMiniAppPresentationOperation, watchMiniAppPresenterOperation } from "../../src/server/operation/miniapp.js";
import { watchMiniAppAgentTurnOperation } from "../../src/server/operation/miniapp-agent.js";
import {
  WEBUI_STREAM_OPERATION_NAMES,
  type OperationSpec,
  type WebuiStreamOperationName,
  type WebuiUnaryOperationName,
} from "../../src/shared/operation-names.js";
import type { WebuiVersionInfo } from "../../src/shared/contracts/version.js";
import type { WebuiGoal } from "../../src/shared/contracts/goal.js";

/** A compile-time assertion: instantiation only compiles when `T` is `true`. */
type Expect<T extends true> = T;
/** Type identity, not mutual assignability. */
type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
/** Fails with the offending member in the message when the union is not empty. */
type AssertEmpty<T extends never> = T;

/* ------------------------------------------------------------------ *
 * The positive relation: the operation name decides body and result.
 * ------------------------------------------------------------------ */

const callVersion = (wire: WebuiWire) => wire.request("version", undefined);
type VersionResult = Expect<
  Eq<Awaited<ReturnType<typeof callVersion>>, WebuiVersionInfo>
>;

const callGetGoal = (wire: WebuiWire) => wire.request("getGoal", { sessionId: "s" });
type GetGoalResult = Expect<
  Eq<Awaited<ReturnType<typeof callGetGoal>>, WebuiGoal | undefined>
>;

/* ------------------------------------------------------------------ *
 * The negative relation.
 * ------------------------------------------------------------------ */

const wrongBody = (wire: WebuiWire) => {
  // @ts-expect-error — createSession's declared request is WebuiCreateSessionRequest; `name` must be a string.
  return wire.request("createSession", { name: 1 });
};

const wrongResultAssumption = async (wire: WebuiWire) => {
  // @ts-expect-error — `version` answers with WebuiVersionInfo, not a goal.
  const goal: WebuiGoal | undefined = await wire.request("version", undefined);
  return goal;
};

const streamThroughUnary = (wire: WebuiWire) => {
  // @ts-expect-error — sendMessage is a stream; it is not in the unary name set.
  return wire.request("sendMessage", { id: "s", content: "hi" });
};

const unknownOperation = (wire: WebuiWire) => {
  // @ts-expect-error — an operation name outside OperationSpec is not a unary name.
  return wire.request("notAnOperation", undefined);
};

/* ------------------------------------------------------------------ *
 * The stream set is disjoint from the unary set, and its responses
 * really are stream envelopes.
 * ------------------------------------------------------------------ */

type StreamInUnary = AssertEmpty<
  Extract<WebuiUnaryOperationName, WebuiStreamOperationName>
>;
type EverySpecKeyIsClassified = AssertEmpty<
  Exclude<keyof OperationSpec, WebuiUnaryOperationName | WebuiStreamOperationName>
>;

const inertPort = {} as unknown as WebuiOperationPort;

describe("the unary request interface over OperationSpec", () => {
  it("keeps the compile-time probes compiling (they are the assertions)", () => {
    // The probes above are executed only for their types; the values are unused.
    assert.equal(typeof callVersion, "function");
  });

  it("classifies every operation as unary or stream, with no overlap", () => {
    const unary: readonly WebuiUnaryOperationName[] = [];
    const streams: readonly WebuiStreamOperationName[] = [...WEBUI_STREAM_OPERATION_NAMES];
    for (const name of streams) {
      assert.equal(
        (unary as readonly string[]).includes(name),
        false,
        `${name} is a stream and must not be unary`,
      );
    }
    assert.equal(streams.length, 11);
  });

  it("matches the server's registered stream descriptors exactly", () => {
    const registered = [
      ...createStreamHandlerEntries(inertPort).keys(),
      // The two host-side streams: the phone link's live state and the remote
      // terminal's output. Both keep a dedicated handler — their frames are the
      // host's own, not the generic stream factory's.
      ...createRemoteControlHandlerEntries(inertPort).keys(),
      ...createSshHandlerEntries(inertPort).keys(),
      watchTerminalOperation.name,
      watchBrowserFramesOperation.name,
      watchBrowserWebTabsOperation.name,
      watchMiniAppPresentationOperation.name,
      // The presenter's own requests are a stream as well, and they keep a
      // dedicated handler: the frames are the host's show/close asks, which the
      // generic stream factory does not shape.
      watchMiniAppPresenterOperation.name,
      // The page bridge's turn is a stream too, and it keeps a dedicated handler:
      // its frames are the runtime's run events plus one settlement, which the
      // generic stream factory does not shape.
      watchMiniAppAgentTurnOperation.name,
    ].sort();
    assert.deepEqual(registered, [...WEBUI_STREAM_OPERATION_NAMES].sort());
  });

  it("leaves no stream operation reachable through a static binding", () => {
    for (const name of WEBUI_STREAM_OPERATION_NAMES) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(WEBUI_OPERATION_BINDINGS, name),
        false,
        `${name} is a stream and must not have a unary binding`,
      );
    }
  });
});
