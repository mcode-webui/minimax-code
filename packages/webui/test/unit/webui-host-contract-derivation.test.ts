/**
 * The compile-time binding between the WebUI's host surface and the runtime
 * it talks to.
 *
 * `WebuiRuntimeCliService` is still hand-written: the WebUI declares the members
 * it forwards and the wire shape it expects back. That declaration is only worth
 * anything if a change on the runtime side reaches it, so this file pins the
 * three ways the two can drift, at the type level:
 *
 * - a member the WebUI forwards that the runtime no longer declares;
 * - a member the WebUI started or stopped forwarding;
 * - a forwarded result the runtime no longer hands back in the wire's shape.
 *
 * The three lists are `as const satisfies`: their element types are the exact
 * names *and* every name is checked against the union it claims to enumerate.
 * The `AssertEmpty` aliases then make the enumeration exhaustive in both
 * directions, so a name on one side only fails `pnpm typecheck:test` with that
 * name in the message. This file is in `tsconfig.test.json`'s `include` for
 * exactly that reason: a probe in a file no gate compiles proves nothing.
 *
 * `MISMATCHED_RESULT_NAMES` is now empty, and that is the point: every forwarded
 * result the runtime does not hand back in the wire's shape converts member by
 * member in `harness/result-conversion.ts` instead of passing through an
 * assertion. A name that stops belonging to this list is not a bookkeeping
 * detail — `pnpm typecheck:test` rejects it until its conversion lands, which is
 * what keeps the list honest instead of aspirational.
 *
 * `assembly.ts` no longer asserts. That needed this list *and* the requests to
 * agree: the mirror used to declare three members more loosely than the runtime
 * does, and a looser parameter is not assignable where the runtime wants a
 * specific one. Those are declared at the runtime's shape now and converted at
 * the boundary — a model-provider candidate's required `baseUrl`, a key reveal
 * that is synchronous, an OAuth cancel that takes the id itself. `assembly.ts`
 * says so at the line that used to hold the cast.
 */
import { describe, expect, it } from "vitest";

import type { CliService } from "@mavis/local-runtime-v2/cli-service";
import type { WebuiRuntimeCliService } from "../../src/runtime/harness/host-contract.js";

type Keys<T> = keyof T & string;
type ResultOf<M> = M extends (...args: never[]) => infer R ? Awaited<R> : never;

/** Members the WebUI forwards that the runtime's cliService does not declare. */
type WebuiOnlyNames = Exclude<Keys<WebuiRuntimeCliService>, Keys<CliService>>;
/** Members the runtime declares that the WebUI does not forward. */
type NotForwardedNames = Exclude<Keys<CliService>, Keys<WebuiRuntimeCliService>>;
/** Forwarded members whose result the runtime does not hand back in the wire's shape. */
type MismatchedResultNames = {
  [K in Keys<WebuiRuntimeCliService>]: K extends Keys<CliService>
    ? [ResultOf<CliService[K]>] extends [ResultOf<WebuiRuntimeCliService[K]>]
      ? never
      : K
    : never;
}[Keys<WebuiRuntimeCliService>];

/**
 * Forwarded members whose declared result is `unknown`.
 *
 * The runtime itself declares `unknown` for these ten — the provider-mutation
 * family, the permission-mode pair, `pluginManagement`, `upsertMiniMaxApiKey` and
 * `refreshModels` — so no derivation from its declaration is more precise than
 * `unknown`, and every comparison against `unknown` succeeds. They are named here so
 * the set is countable, and so a *new* member declared `unknown` (the mirror used to
 * declare 41 that way at once) fails this file by name instead of quietly making the
 * result check above vacuous.
 *
 * Each has an explicit conversion at the adapter (`harness/result-conversion.ts`) and
 * a WebUI-owned DTO in `shared/contracts/*`, which is where a field change is argued.
 */
type DeclaredUnknownResult = {
  [K in Keys<WebuiRuntimeCliService>]: unknown extends ResultOf<WebuiRuntimeCliService[K]>
    ? K
    : never;
}[Keys<WebuiRuntimeCliService>];

const UNKNOWN_RESULT_NAMES = [
  "pluginManagement",
  "getPermissionMode",
  "setPermissionMode",
  "createUserModelProvider",
  "updateUserModelProvider",
  "testUserModelProvider",
  "testUserModel",
  "upsertMiniMaxApiKey",
  "testUserModelCandidate",
  "refreshModels",
] as const satisfies readonly DeclaredUnknownResult[];

/**
 * Forwarded members whose declared request the runtime member would not accept.
 *
 * These five former mismatches now have explicit adapter conversions:
 *
 *   * `applyCanvas` carries a canvas operation the panel built, which the runtime
 *     validates against its own canvas node type;
 *   * `replyPermission` and `replyQuestionnaire` carry the wire's *named* reply and the
 *     panel's flat answers, where the runtime takes its own enum and its own answer shape —
 *     `permissionReplyValue` is that mapping;
 *   * `testUserModelCandidate` carries the panel's candidate, which is validated
 *     (`baseUrl` made required) before it is forwarded;
 *   * `listSkills` is the one whose declared *parameters* differ rather than its shape: the
 *     runtime member takes the input as a required argument.
 *
 * Every other forwarded request is derived from the runtime's own declaration
 * (`WebuiHostRequest`) or rebuilt field by field at the binding that forwards it
 * (`runtime/harness/provider-input.ts`). A name leaves this list when its conversion
 * lands, and the compiler decides that: a name whose declaration already satisfies the
 * runtime member fails `pnpm typecheck:test` *as an extra*, so this list cannot be left
 * stale in the comfortable direction.
 */
/** A member's full parameter list, or `never` when the declaration is not callable. */
type ParamsOf<M> = M extends (...args: never[]) => unknown ? Parameters<M> : never;

/** Forwarded members whose declared parameters the runtime member would not accept. */
type MismatchedRequestNames = {
  [K in Keys<WebuiRuntimeCliService>]: K extends Keys<CliService>
    ? [ParamsOf<WebuiRuntimeCliService[K]>] extends [ParamsOf<CliService[K]>]
      ? never
      : K
    : never;
}[Keys<WebuiRuntimeCliService>];

const MISMATCHED_REQUEST_NAMES =
  [] as const satisfies readonly MismatchedRequestNames[];

/**
 * The two capabilities the WebUI's host adds on top of the runtime's service.
 * They are WebUI features, not a mirror of anything the runtime has.
 */
const WEBUI_ONLY_NAMES = [
  "readWorkspaceArchive",
  "extractWorkspaceArchive",
] as const satisfies readonly WebuiOnlyNames[];

/**
 * The forwarded results that still need an explicit runtime -> wire conversion.
 * This is the remaining work, named member by member.
 *
 * Six members have left it. `getSessionUsage`, `listProviderPresets` and
 * `getCodexOAuthStatus` are answers the WebUI contract declares as open records
 * and the runtime returns interfaces for; an interface is not assignable to an
 * index-signature type, so no spelling of the declaration could satisfy them and
 * the adapter now copies the fields instead. `listModels` is the same problem
 * with two required fields: the runtime lists untyped entries, and an entry with
 * no provider and model id is not one the picker could select, so the adapter
 * refuses it rather than rendering a row that fails when clicked.
 *
 * Seven more left it as one cause: the runtime declares its answers as
 * interfaces (`SessionInfoView`, `SessionMessageView`, `FileDiffInfoView`) and
 * the wire DTOs declare an index signature, and an interface is not assignable to
 * an index-signature type however alike the two look. `listSessions` also
 * translates the runtime's numeric `sessionType` into the wire's name, which is
 * the one genuinely semantic field in the family — the numbering is the runtime's
 * and a migration can renumber it. The four diff answers share one conversion
 * because they differ in what surrounds their `diffs` list, not in the list.
 *
 * Six more are the plain interface-to-record case: `createSession`,
 * `updateSession`, `forkSession` and `requestCompaction` answer with an
 * interface where the wire wants a record; `listPendingPermissions` needs every
 * required field rebuilt, and `listWorkspaceFileTree` is converted so the panel
 * can stat the files it keeps.
 *
 * `readCanvas` and `applyCanvas` are no longer on it: both now go through
 * `result-conversion.ts`, which reads the runtime's own canvas view and rebuilds
 * the WebUI's document field by field. They were on this list because the
 * runtime's node type is an interface, and an interface is not assignable to the
 * wire's `readonly Record<string, unknown>[]` — a difference a conversion has to
 * state rather than a declaration has to satisfy. A member leaves this list when
 * its conversion lands, and the compiler decides that: adding a name that already
 * satisfies the wire type fails `pnpm typecheck:test`.
 */
const MISMATCHED_RESULT_NAMES = [] as const satisfies readonly MismatchedResultNames[];

/** A sample of what the runtime declares and the WebUI deliberately does not forward. */
const NOT_FORWARDED_NAMES = [
  "steer",
  "steerSession",
  "getPeekContext",
  "listRuntimeSkills",
  "listBackgroundTasks",
  "getRuntimeDiagnostics",
  "collectSessionReport",
  "refreshPlugins",
  "setModelFavorite",
] as const satisfies readonly NotForwardedNames[];

// Exhaustive in both directions, so growth fails as loudly as a swap. The aliases
// are referenced in the first test below: an unreferenced type alias is not
// resolved, and a probe nobody resolves proves nothing.
type AssertEmpty<T extends never> = T;
type WebuiOnlyMissing = AssertEmpty<Exclude<WebuiOnlyNames, (typeof WEBUI_ONLY_NAMES)[number]>>;
type WebuiOnlyExtra = AssertEmpty<Exclude<(typeof WEBUI_ONLY_NAMES)[number], WebuiOnlyNames>>;
type MismatchedMissing = AssertEmpty<
  Exclude<MismatchedResultNames, (typeof MISMATCHED_RESULT_NAMES)[number]>
>;
type MismatchedExtra = AssertEmpty<
  Exclude<(typeof MISMATCHED_RESULT_NAMES)[number], MismatchedResultNames>
>;

// The obligations the `unknown`-declared members used to escape, both exact in both
// directions: no forwarded result may be declared `unknown` beyond the ten named
// above, and no forwarded request may be one the runtime member would refuse beyond
// the nine named above.
type NoUnknownResults = AssertEmpty<
  Exclude<DeclaredUnknownResult, (typeof UNKNOWN_RESULT_NAMES)[number]>
>;
type NoUnknownResultsExtra = AssertEmpty<
  Exclude<(typeof UNKNOWN_RESULT_NAMES)[number], DeclaredUnknownResult>
>;
type NoMismatchedRequests = AssertEmpty<
  Exclude<MismatchedRequestNames, (typeof MISMATCHED_REQUEST_NAMES)[number]>
>;
type NoMismatchedRequestsExtra = AssertEmpty<
  Exclude<(typeof MISMATCHED_REQUEST_NAMES)[number], MismatchedRequestNames>
>;

describe("the WebUI host surface against the runtime it forwards to", () => {
  it("leaves no forwarded result for the assembly to assert about", () => {
    // The cast this list used to stand behind is gone, and the reason it can
    // stay gone is that this list is empty: every answer converts at the
    // boundary that owns it. A member added to the mirror without a conversion
    // lands here and fails `pnpm typecheck:test` before it can reach a cast.
    expect(MISMATCHED_RESULT_NAMES).toEqual([]);
  });

  it("names each union exactly, in both directions", () => {
    const missing: readonly WebuiOnlyMissing[] = [];
    const extra: readonly WebuiOnlyExtra[] = [];
    const mismatchedMissing: readonly MismatchedMissing[] = [];
    const mismatchedExtra: readonly MismatchedExtra[] = [];
    const unknownResults: readonly NoUnknownResults[] = [];
    const unknownResultsExtra: readonly NoUnknownResultsExtra[] = [];
    const mismatchedRequests: readonly NoMismatchedRequests[] = [];
    const mismatchedRequestsExtra: readonly NoMismatchedRequestsExtra[] = [];
    // Empty by construction: the eight aliases above are `never`, so a name that
    // stopped belonging — or started belonging, or that was declared `unknown`, or
    // that narrowed a request — is a compile error here.
    expect([
      missing,
      extra,
      mismatchedMissing,
      mismatchedExtra,
      unknownResults,
      unknownResultsExtra,
      mismatchedRequests,
      mismatchedRequestsExtra,
    ]).toHaveLength(8);
  });

  it("adds exactly two capabilities of its own", () => {
    expect(WEBUI_ONLY_NAMES).toHaveLength(2);
    // The membership check has teeth: a name the runtime does declare is not
    // WebUI-only.
    // @ts-expect-error the runtime declares `listSessions`
    const notWebuiOnly: WebuiOnlyNames = "listSessions";
    expect(notWebuiOnly).toBe("listSessions");
  });

  it("names every forwarded result that still needs a conversion", () => {
    expect(MISMATCHED_RESULT_NAMES).toHaveLength(0);
    // A compatible result is not in the list, so the list cannot be padded.
    // @ts-expect-error `archiveSession`'s result already satisfies the wire type
    const alreadyCompatible: MismatchedResultNames = "archiveSession";
    expect(alreadyCompatible).toBe("archiveSession");
    // And a converted one left it: the canvas members now have an explicit
    // runtime -> wire conversion, so the compiler no longer reports them.
    // @ts-expect-error `readCanvas` is converted, not merely forwarded
    const converted: MismatchedResultNames = "readCanvas";
    expect(converted).toBe("readCanvas");
    // @ts-expect-error `listModels` has an explicit conversion too
    const convertedList: MismatchedResultNames = "listModels";
    expect(convertedList).toBe("listModels");
    // @ts-expect-error `listSessions` translates the runtime's numeric session type
    const convertedSession: MismatchedResultNames = "listSessions";
    expect(convertedSession).toBe("listSessions");
  });

  it("forwards a subset, and every forwarded name still exists on the runtime", () => {
    // The WebUI deliberately forwards a subset of the runtime's service; what it
    // must not do is forward a name the runtime has dropped, which the
    // exhaustive lists above catch.
    expect(NOT_FORWARDED_NAMES.length).toBeGreaterThan(0);
  });
});
