// The per-business port slices.
//
// This file is the slice mapping in executable form. The key lists in
// `application/port-slices.ts` are the old-to-new optional capability mapping,
// and every assertion here checks that the built slice is exactly that list:
// nothing dropped, nothing widened, and no member of another business reachable
// from it.
//
// Two modes are tested throughout, because that is the risk the slices carry: a
// **wired** member must pass through by identity, and an **unwired** one must be
// `undefined` in the slice exactly as it was `undefined` on the composed
// transport. A slice that turned `undefined` into a defined no-op would change
// behaviour silently — the "not wired" branches would stop being taken.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createWebuiPortSlices,
  type WebuiPortSliceSource,
  type WebuiPortSlices,
} from "../../src/client/application/port-slices.js";
import type { WebuiAccountSlice } from "../../src/client/application/port-slices.js";
import {
  WebuiPortSlicesProvider,
  useWebuiPortSlice,
} from "../../src/client/bindings/port-slices-context.js";

/** The members each slice must carry, as the mapping records them. */
const EXPECTED: Record<
  Exclude<keyof WebuiPortSlices, "turn">,
  readonly string[]
> = {
  sessions: [
    "loadProjects", "listArchivedSessions", "loadSessions", "loadSessionTree",
    "createSession", "archiveSession", "deleteSession", "updateSession",
    "getSessionForkOptions", "forkSession", "getSessionUsage",
  ],
  transcript: [
    "loadMessages", "getSessionDiff", "getTurnDiff", "revertTurnDiff",
    "reapplyTurnDiff", "getSessionRewindPreview", "rewindSession",
    "editSessionMessage",
  ],
  workspace: [
    "listWorkspaceFileTree", "browseWorkspaceDirs", "readWorkspaceFile",
    "getWorkspaceEnvironment", "mutateWorkspaceGit", "getWorkspaceReviewSummary",
    "listWorkspaceReviewFileDiffs", "getWorkspaceReviewFileContent",
    "searchWorkspaceReviewDiffs", "readCanvas", "applyCanvas", "workspaceFileUrl",
    "readWorkspaceArchive", "extractWorkspaceArchive",
    "createTerminal", "listTerminals", "writeTerminal", "resizeTerminal",
    "disposeTerminal", "watchTerminal",
  ],
  browser: [
    "getBrowserAuthorization", "setBrowserAuthorization", "listBrowserTargets",
    "selectBrowserTarget", "sendBrowserInput", "sendBrowserCommand",
    "watchBrowserFrames", "watchBrowserWebTabs", "openBrowserWebTab", "closeBrowserWebTab",
    "listBrowserCapabilities",
    "getBrowserInstallationKey",
  ],
  miniapp: [
    "listMiniApps", "openMiniApp", "stopMiniApp",
    // ADR 0020's standalone presentation: the lease this document holds, and the
    // deep link that opens one. Both belong to this business because both are
    // Mini App presentation facts, not layout ones.
    "watchMiniAppPresentation", "miniappStandaloneUrl",
    // The presenter's asks come back to this client as a stream: the host
    // decides to show a Mini App's session, and the client enacts it.
    "watchMiniAppPresenter",
    // A Mini App is a plugin, so the catalogue's apps area writes the package
    // lifecycle through the same member the plugin manager does.
    "pluginManagement",
  ],
  composer: ["runCommand", "enqueueMessage", "listQueueMessages", "deleteQueueItem"],
  interactions: [
    "listPendingPermissions", "getPendingQuestionnaire", "replyPermission",
    "replyQuestionnaire", "dismissQuestionnaire",
  ],
  goal: ["isGoalEnabled", "getGoal", "createGoal", "patchGoal", "clearGoal"],
  models: [
    "listModels", "selectModel", "listUserModelProviders", "createUserModelProvider",
    "updateUserModelProvider", "deleteUserModelProvider", "testUserModelProvider",
    "testUserModel", "discoverUserModelsCandidate", "saveUserModelProviderCandidate",
    "listProviderPresets", "upsertMiniMaxApiKey", "testUserModelCandidate",
    "revealModelProviderApiKey", "refreshModels",
  ],
  plugins: ["pluginManagement", "listSkills"],
  settings: [
    "version", "getPermissionMode", "setPermissionMode", "getGlobalInstructions",
    "setGlobalInstructions", "getAgentMemory", "setAgentMemory", "getUserProfile",
    "setUserProfile", "getMemorySettings", "setMemorySettings",
    "getMiniMaxApiKeyStatus", "getCodexOAuthStatus", "getMiniMaxModelSource",
    "setMiniMaxModelSource", "startCodexOAuthLogin", "cancelCodexOAuthLogin",
  ],
  account: [
    "getUsageQuota", "getCreditFallback", "setCreditFallback", "listResetCards",
    "useResetCard", "queryResetCardFlows", "getAccountUsageSummary",
    "getAccountProfile", "getSigninPanel", "claimSignin",
    "beginAccountLogin", "getAccountLoginStatus", "cancelAccountLogin",
    "getAccountStatus", "signOut",
  ],
  scheduling: [
    "listCronTasks", "createCronTask", "updateCronTask", "deleteCronTask",
    "runCronTaskNow", "listCronTaskRuns",
  ],
  shell: ["watchEvents"],
};

/** A source with nothing wired: every port member absent. */
const unwired = (): WebuiPortSliceSource => ({});

describe("every slice carries exactly the members its key list names", () => {
  it("is a partition of the recorded mapping, per business", () => {
    const slices = createWebuiPortSlices(unwired());
    for (const [business, members] of Object.entries(EXPECTED)) {
      expect(
        Object.keys(slices[business as keyof WebuiPortSlices]).sort(),
        business,
      ).toEqual([...members].sort());
    }
  });

  it("carries no member of another business", () => {
    const slices = createWebuiPortSlices(unwired());
    // A slice for one business must not reach another's capability. These pairs
    // are the ones the carves depend on being separate.
    expect(slices.sessions).not.toHaveProperty("sendMessage");
    expect(slices.sessions).not.toHaveProperty("getTurnDiff");
    expect(slices.transcript).not.toHaveProperty("forkSession");
    expect(slices.transcript).not.toHaveProperty("sendMessage");
    expect(slices.goal).not.toHaveProperty("replyPermission");
    expect(slices.interactions).not.toHaveProperty("patchGoal");
    expect(slices.settings).not.toHaveProperty("listModels");
    expect(slices.models).not.toHaveProperty("setGlobalInstructions");
    expect(slices.composer).not.toHaveProperty("getTurnDiff");
    expect(slices.shell).not.toHaveProperty("loadSessions");
    expect(slices.sessions).not.toHaveProperty("pluginManagement");
    expect(slices.plugins).not.toHaveProperty("listSkills2");
  });

  it("is a new object, so the rest of the composed transport is unreachable", () => {
    const source: WebuiPortSliceSource = {
      loadSessions: async () => ({ sessions: [], hasMore: false }),
    };
    const slices = createWebuiPortSlices(source);
    // Not the same object: a cast would have left every other member reachable
    // at runtime, which is the property this module exists to remove.
    expect(slices.sessions).not.toBe(source as unknown);
    expect(Object.keys(slices.sessions)).toHaveLength(EXPECTED.sessions.length);
  });
});

describe("turn's slice attaches a member only when the source carries it", () => {
  // `turn` is the one slice built by its own factory rather than by `cut`, and
  // that factory *drops* an absent member instead of storing `undefined` under
  // it. A consumer reads `slice.send === undefined` either
  // way, so the not-wired branch is identical; what differs is that the key is
  // absent rather than present-and-undefined. Pinned here so the difference
  // stays a decision instead of drifting into an accident.
  it("has no keys at all when nothing is wired", () => {
    const slices = createWebuiPortSlices(unwired());
    expect(Object.keys(slices.turn)).toEqual([]);
    expect(slices.turn.send).toBeUndefined();
    expect(slices.turn.stop).toBeUndefined();
  });

  it("attaches exactly the members the source carries", () => {
    const sendMessage = async () => {};
    const abortSession = async () => ({ success: true });
    const slices = createWebuiPortSlices({ sendMessage, abortSession });
    expect(Object.keys(slices.turn).sort()).toEqual(["send", "stop"]);
    expect(slices.turn.send).toBe(sendMessage);
    expect(slices.turn.stop).toBe(abortSession);
    expect(slices.turn.resume).toBeUndefined();
    expect(slices.turn.load).toBeUndefined();
  });
});

describe("optionality is carried verbatim — the wired and not-wired modes", () => {
  it("passes a wired member through by identity", async () => {
    const loadSessions = async () => ({ sessions: [], hasMore: false });
    const signOut = async () => ({ success: true });
    const slices = createWebuiPortSlices({ loadSessions, signOut });
    expect(slices.sessions.loadSessions).toBe(loadSessions);
    expect(slices.account.signOut).toBe(signOut);
    await expect(slices.sessions.loadSessions?.()).resolves.toEqual({
      sessions: [],
      hasMore: false,
    });
  });

  it("leaves an unwired member undefined rather than substituting a no-op", () => {
    const slices = createWebuiPortSlices(unwired());
    // Every one of these is read as `slice?.X` by the consumer that takes it
    // over, so a defined stand-in would silently change which branch runs.
    expect(slices.sessions.loadSessions).toBeUndefined();
    expect(slices.sessions.deleteSession).toBeUndefined();
    expect(slices.turn.send).toBeUndefined();
    expect(slices.turn.resume).toBeUndefined();
    expect(slices.shell.watchEvents).toBeUndefined();
    expect(slices.account.signOut).toBeUndefined();
    expect(slices.workspace.createTerminal).toBeUndefined();
  });

  it("keeps a wired member wired while its neighbours stay absent", () => {
    const signOut = async () => ({ success: true });
    const slices = createWebuiPortSlices({ signOut });
    expect(slices.account.signOut).toBe(signOut);
    expect(slices.account.getUsageQuota).toBeUndefined();
  });
});

describe("the slices are injectable", () => {
  function probeRead(business: Parameters<typeof useWebuiPortSlice>[0]) {
    let captured: unknown;
    function Probe() {
      captured = useWebuiPortSlice(business);
      return null;
    }
    return {
      render: (slices?: WebuiPortSlices) =>
        renderToStaticMarkup(
          slices
            ? createElement(WebuiPortSlicesProvider, {
                slices,
                children: createElement(Probe),
              })
            : createElement(Probe),
        ),
      get captured() {
        return captured;
      },
    };
  }

  it("hands a consumer the slice it asked for", async () => {
    const signOut = async () => ({ success: true });
    const slices = createWebuiPortSlices({ signOut });
    const probe = probeRead("account");
    probe.render(slices);
    expect(probe.captured).toBe(slices.account);
    const account = probe.captured as WebuiAccountSlice | undefined;
    await expect(account?.signOut?.()).resolves.toEqual({ success: true });
  });

  it("returns undefined with no provider, which is the not-wired mode", () => {
    const probe = probeRead("goal");
    probe.render();
    expect(probe.captured).toBeUndefined();
  });
});

/**
 * The slice types, checked as types. A slice must not admit another business's
 * member: if one is ever added the `const` stops compiling under
 * `pnpm typecheck:webui-full`.
 */
type SessionsReachesTransport = Extract<
  keyof WebuiPortSlices["sessions"],
  "sendMessage" | "getTurnDiff" | "pluginManagement" | "watchEvents"
>;
type GoalReachesPermissions = Extract<
  keyof WebuiPortSlices["goal"],
  "replyPermission" | "listPendingPermissions"
>;
type OnlyTrue<T extends true> = T;

const slicesAreNarrow: OnlyTrue<SessionsReachesTransport extends never ? true : never> =
  true;
const goalIsNarrow: OnlyTrue<GoalReachesPermissions extends never ? true : never> = true;

describe("the slice types are narrow", () => {
  it("shares no member name with another business's capability", () => {
    expect(slicesAreNarrow).toBe(true);
    expect(goalIsNarrow).toBe(true);
  });
});
