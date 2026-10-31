// `turn`'s four prohibition assertions.
//
// They are a different claim from the four substrate fences
// (`turn-substrate-fences.test.ts`): a fence asserts that a mechanism holds; a
// prohibition asserts that one business cannot reach another's state.
//
// They are source-level assertions, and that is deliberate: the dependency
// checker holds **no** business-boundary rule, so the machine half of the
// prohibitions is these tests — a reading, made repeatable. Each one states what
// it cannot see.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const CLIENT_ROOT = new URL("../../src/client/", import.meta.url);

/** Every `.ts`/`.tsx` module under `src/client`, as a repo-relative path. */
function clientModules(): string[] {
  const out: string[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(child, `${path}/`);
      else if (/\.tsx?$/u.test(entry.name)) out.push(path);
    }
  };
  walk(CLIENT_ROOT, "");
  return out;
}

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, CLIENT_ROOT), "utf8");
}

/** The modules `turn` owns: its capability slice, commands, loop and lease. */
const TURN_MODULES = [
  "features/turn/application/turn-capabilities.ts",
  "features/turn/application/turn-commands.ts",
  "features/turn/application/turn-coordinator.ts",
  "features/sessions/application/session-commands.ts",
  "features/turn/application/stream-state-bundle.ts",
  "features/turn/application/stream-lease-controller.ts",
  "features/turn/application/stream-lease.ts",
  "conversation/stream-loop.ts",
  "conversation/stream-lease.ts",
];

describe("prohibition 1 — turn holds no writer for another business's state", () => {
  it("writes the store through its own writer, its own read, and one stream-only patch", () => {
    for (const modulePath of TURN_MODULES) {
      const source = read(modulePath);
      // The only store entry points a turn module may use. Anything else is a
      // second writer for a slice `turn` does not own. Matched as *calls*, so
      // an import specifier like `"./session-store.js"` is not mistaken for one.
      const members = [...source.matchAll(/\bstore\.([A-Za-z_$][\w$]*)\s*\(/gu)].map(
        (match) => match[1],
      );
      expect(
        members.every((member) =>
          ["createSessionWriter", "readSession", "updateSession"].includes(member!),
        ),
      ).toBe(true);
      // `updateSession` is the one generic write, and it exists in exactly one
      // turn module: the lease controller, which patches the `stream` field and
      // nothing else.
      if (members.includes("updateSession")) {
        expect(modulePath).toBe("features/turn/application/stream-lease-controller.ts");
        const calls = source.split("store.updateSession(").slice(1);
        expect(calls).toHaveLength(2);
        for (const call of calls) {
          // The written field set of each patch, read off the callback's object
          // literal: `stream` and nothing else.
          const body = call.slice(0, call.indexOf("}))"));
          const keys = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/gu)].map(
            (match) => match[1],
          );
          expect(keys).toEqual(["stream"]);
        }
      }
    }
  });

  it("takes its interaction targets as injected functions rather than importing an owner", () => {
    // `session-commands.ts` declares `setPermissions` / `setQuestionnaire` /
    // `setGoal` as *parameter types* of the interaction command factory. The
    // writer behind them belongs to `interactions`; this module must not be able
    // to reach it.
    const source = read("features/sessions/application/session-commands.ts");
    expect(source).not.toMatch(/from "\.\.?\/[^"]*session-store\.js"/u);
    expect(source).not.toMatch(/createInteractionWriter/u);
    expect(source).not.toMatch(/updateSession\(/u);
  });
});

describe("prohibition 2 — turn's rules are filed inside turn", () => {
  it("declares the loop and the lease in conversation/, never in a component", () => {
    const declarations = [
      { symbol: "function runWebuiStreamLoop", owner: "conversation/stream-loop.ts" },
      // The sink is `turn`'s, not the mechanism's: it is the one module that
      // turns an attempt's frames into the session's stream record.
      { symbol: "function buildWebuiStreamLoopSink", owner: "features/turn/application/stream-loop-sink.ts" },
      { symbol: "function nextWebuiLeaseGeneration", owner: "conversation/stream-lease.ts" },
      { symbol: "function isWebuiLeaseGenerationCurrent", owner: "conversation/stream-lease.ts" },
      // The aggregate transforms are Turn's, not the mechanism's: a claim writes
      // the session's subscription and a scoped release compares against it, so
      // the module that knows that record is the one that owns these.
      { symbol: "function claimWebuiLease", owner: "features/turn/application/stream-lease.ts" },
      { symbol: "function releaseWebuiSubscription", owner: "features/turn/application/stream-lease.ts" },
    ];
    const modules = clientModules();
    for (const { symbol, owner } of declarations) {
      const sites = modules.filter((modulePath) => read(modulePath).includes(symbol));
      expect(sites).toEqual([owner]);
    }
    // And no component so much as names them: a component that reached the
    // mechanism directly would be holding the loop rather than submitting an
    // intent to it. Presentation lives in `client/shell/`, `client/ui/` and each
    // feature's `ui/`; a scan of one spelling alone finds nothing and would pass
    // for the wrong reason, so the guard below pins that something was scanned.
    const isPresentation = (path: string): boolean =>
      path.startsWith("shell/") || path.startsWith("ui/") || /^features\/[^/]+\/ui\//u.test(path);
    const presentations = modules.filter(isPresentation);
    expect(presentations.length).toBeGreaterThan(0);
    for (const modulePath of presentations) {
      const source = read(modulePath);
      for (const { symbol } of declarations) expect(source).not.toContain(symbol);
      expect(source).not.toMatch(/(?:mechanisms|conversation)\/stream-(loop|lease)\.js/u);
    }
  });
});

describe("prohibition 3 — the stream-phase value set is enumerated exactly once", () => {
  const PHASES = ["idle", "streaming", "waiting", "reconnecting", "refused", "done"];

  it("keeps the union in features/turn/contracts/stream-state.ts and nowhere else", () => {
    const enumerations = clientModules().filter((modulePath) => {
      const source = read(modulePath);
      return PHASES.every((phase) => new RegExp(`"${phase}"`, "u").test(source));
    });
    // `WebuiConnectionState` also says "reconnecting", which is a *different*
    // closed set — a connection state, not a stream phase. Only the stream
    // phase's six values together identify the one enumeration.
    expect(enumerations).toEqual(["features/turn/contracts/stream-state.ts"]);
  });

  it("derives the phase type from the union instead of re-listing it", () => {
    // The derivation lives with the narrow intents, which declare the phase
    // vocabulary first; the full view re-exports it rather than deriving it a
    // second time.
    expect(read("features/turn/contracts/interaction-phase-intents.ts")).toContain(
      'WebuiStreamState["phase"]',
    );
    expect(read("features/turn/contracts/turn-command-views.ts")).not.toContain("WebuiStreamState");
  });
});

describe("prohibition 4 — turn's shared rules have exactly one owner", () => {
  it("has one generation counter, and every reader imports it", () => {
    const modules = clientModules();
    for (const symbol of [
      "nextWebuiLeaseGeneration",
      "isWebuiLeaseGenerationCurrent",
    ]) {
      const declaring = modules.filter((modulePath) =>
        new RegExp(`function ${symbol}\\b`, "u").test(read(modulePath)),
      );
      expect(declaring).toEqual(["conversation/stream-lease.ts"]);

      const users = modules.filter((modulePath) => read(modulePath).includes(symbol));
      for (const user of users) {
        if (user === "conversation/stream-lease.ts") continue;
        // A second copy is what prohibition 4 forbids; a reader must import the
        // owner's rule. Both specifier shapes count: the module itself sits
        // beside `stream-lease.ts` (`./`), every other layer reaches it from one
        // level (or more) below the substrate's home.
        expect(read(user)).toMatch(
          /from "(\.\/(?:\.\.\/)*|.*?\/conversation\/)stream-lease\.js"/u,
        );
      }
      expect(users.length).toBeGreaterThan(1);
    }
  });
});

describe("prohibition 5 — a submit carries intent, never a setter", () => {
  it("publishes a send intent with no business setter on it", () => {
    // The public intent is what a surface submits. A setter here means the
    // caller has to know which branch fires which write, and a submission that
    // does not know about it can change a business field it never named.
    const source = read("features/turn/contracts/turn-commands.ts");
    const intent = source.slice(
      source.indexOf("export interface WebuiTurnSendIntent"),
    );
    // Take only the interface, not the module below it.
    const body = intent.slice(0, intent.indexOf("\n}"));
    for (const setter of [
      "onDraftChange",
      "onSessionCreated",
      "onNeedsSession",
      "onQueued",
      // The staging setter left the public intent: staging is the composer's own
      // input and it consumes it, so a caller-supplied callback cannot reappear
      // here without failing this assertion.
      "onAttachmentsSubmitted",
      "setDraft",
      "setSending",
      "setRefusal",
      "resetStreamForTurn",
      "createSink",
    ]) {
      expect(body).not.toContain(setter);
    }
    // And the ticket carries no setter either: an admission and a completion
    // are the whole protocol.
    const submission = read("features/turn/contracts/submission.ts");
    const ticket = submission.slice(
      submission.indexOf("export interface WebuiSubmissionTicket"),
    );
    expect(ticket.slice(0, ticket.indexOf("\n}"))).not.toMatch(/set[A-Z]/u);
  });

  it("leaves draft consumption to the composer, on both sides of the boundary", () => {
    // Consuming the submitted input is the composer's, because only the composer holds
    // the identity the input was captured under. A writer installed at the composition
    // root — or handed in per send — clears a slot without knowing whether it is still
    // the revision that was submitted, which is how newer typing got erased. The
    // positive half is in the controller; the negative half is here.
    const application = read("application/create-application.ts");
    expect(application).not.toContain("clearDraft");
    expect(application).not.toContain("onDraftChange");
    const context = read("features/turn/application/turn-commands.ts");
    expect(context).not.toContain("clearDraft");
    expect(context).not.toContain("onDraftChange");
    const controller = read("features/composer/application/composer-controller.ts");
    expect(controller).toContain("consumeDraft(captured)");
    expect(controller).toContain("consumeAdoptedDraft(created.sessionId, created.adoptedRevision)");
  });
});

describe("prohibition 6 — a workspace reader takes the resource it renders", () => {
  const read = (relativePath: string): string =>
    readFileSync(new URL(relativePath, CLIENT_ROOT), "utf8");

  it("declares one contract per resource, and no reader's contract is another's", () => {
    // The point of the split: a capability added to Archive widens Archive and
    // the panel, and touches nothing else. A contract that re-declared a
    // sibling's member would put it back on every reader that took it.
    const source = read("features/workspace/application/workspace-owner-contracts.ts");
    const contracts = [
      "WebuiWorkspaceFilesCommands",
      "WebuiWorkspaceEnvironmentCommands",
      "WebuiWorkspaceReviewCommands",
      "WebuiWorkspaceArchiveCommands",
      "WebuiWorkspaceCanvasCommands",
    ];
    for (const name of contracts) {
      expect(source).toContain(`export interface ${name}`);
    }
    // Mutating git belongs to the environment alone.
    expect(source).toContain("mutateGit");
    expect(source.match(/mutateGit/gu)).toHaveLength(1);
    // Reading a canvas belongs to the canvas alone.
    expect(source.match(/readCanvas/gu)).toHaveLength(1);
  });

  it("keeps cross-owner work on the composition root, not on a resource", () => {
    const root = read("features/workspace/application/workspace-queries.ts");
    // The git fan-out is the one thing that crosses resources, so it lives on
    // the root: it must not be reachable through any single resource's contract.
    const contracts = read("features/workspace/application/workspace-owner-contracts.ts");
    expect(root).toContain("invalidateWorkspaceGit");
    expect(contracts).not.toContain("invalidateWorkspaceGit");
    // And disposal is coordinated once, by the root that built the owners.
    expect(root).toContain("dispose");
    expect(contracts).not.toContain("dispose");
  });

  it("gives each consumer the hook for the resource it renders", () => {
    // A consumer reaching for the whole facade is how the split decays: the
    // types stop narrowing and every capability is everyone's again.
    const expectations: readonly [string, string][] = [
      ["features/composer/ui/WebuiComposer.tsx", "useWebuiWorkspaceFiles"],
      ["features/review/ui/ReviewSettingsPage.public.tsx", "useWebuiWorkspaceReview"],
      ["features/workspace/ui/WorkspaceArchiveView.tsx", "useWebuiWorkspaceArchive"],
      ["features/workspace/ui/WorkspaceCanvas.tsx", "useWebuiWorkspaceCanvas"],
      ["features/workspace/ui/WebuiWorkspaceDirectoryBrowser.public.tsx", "useWebuiWorkspaceFiles"],
      // The panel is the one surface whose presentation IS the composition.
      ["features/workspace/ui/WorkspacePanels.tsx", "useWebuiWorkspacePanelSurface"],
    ];
    for (const [modulePath, hook] of expectations) {
      const source = read(modulePath);
      expect(source).toContain(hook);
    }
  });
});
