// Acceptance rows for the ownership refactor that no other suite names
// directly: V30 (publication replaced the ledger), V41 (the delivery mechanism
// imports nothing from Turn) and V43 (composer's input policy is auditable in
// its controller and store, and separable from shell layout).
//
// They are gathered here rather than added to the suite that happens to sit
// nearby, because what each row asserts is about the *boundary* — which module
// owns which rule — and a boundary check reads better when the three of them
// stand together with what they say about each other.
//
// What this file deliberately does not do is assert behaviour the owner tests
// already own. V30 is not re-tested by running the dependency gate here: the
// gate is the check, and this file pins the facts that make the gate's silence
// mean something.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { WebuiAccountWorkflows } from "../../src/client/features/account/application/account-workflows.js";
import type { WebuiAccountWorkflowsConsumer } from "../../src/client/features/account/bindings/use-account-workflows.public.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const clientRoot = `${here}../../src/client/`;
const read = (relative: string): string => readFileSync(`${clientRoot}${relative}`, "utf8");
// Only real import statements. Matching bare `from "…"` picks up prose in a
// comment, and a boundary check that reports a sentence is worse than one that
// silently passes.
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^\s*import\s[^;]*?\bfrom\s+"([^"]+)"/gmu)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => specifier !== "");
}


describe("V30 · publication replaced the ledger, and nothing excuses a private import", () => {
  it("the approval ledger is gone from the tree and from the rules module", () => {
    // The baseline recorded which cross-business private imports were tolerated.
    // Every one of them has a published module to read instead, so the list had
    // nothing left to excuse — and leaving it would have meant a new entry could
    // always be added to make a new private import pass.
    const ledger = new URL("../../../../scripts/lib/webui-peer-imports.json", import.meta.url);
    expect(existsSync(ledger)).toBe(false);
    // And the rule module must not quietly retain a way to read one.
    const rules = readFileSync(
      new URL("../../../../scripts/lib/webui-dependency-rules.mjs", import.meta.url),
      "utf8",
    );
    expect(rules).not.toContain("webui-peer-imports.json");
    expect(rules).not.toContain("approvedPeerImports");
    // The remedy the violation message names is publication, not an entry.
    expect(rules).toContain(".public.ts");
  });

  it("every business that a peer reads publishes the symbol it publishes", () => {
    // The ledger is gone, so the only thing keeping a cross-business edge legal
    // is that its target carries the marker. This asserts the marker is a
    // property of real files rather than of a list the gate trusts: if a
    // published module is renamed, this case stops passing.
    const published = [
      "features/sessions/application/session-catalog.public.ts",
      "features/sessions/projection/action-requests.public.ts",
      "features/turn/projection/stream-state.public.ts",
      "features/workspace/projection/workspace-name.public.ts",
      "features/goal/bindings/goal-owner.public.ts",
      "features/interactions/bindings/interaction-owner.public.ts",
      "features/models/projection/thinking-control.public.ts",
      "features/models/projection/token-plan-model.public.ts",
      "features/models/ui/ModelPicker.public.tsx",
      "features/transcript/ui/markdown.public.tsx",
      "features/transcript/ui/OutputError.public.tsx",
      "features/goal/ui/GoalBanner.public.tsx",
      "features/review/ui/ReviewSettingsPage.public.tsx",
      "features/models/ui/ProviderFormPanel.public.tsx",
      "features/composer/application/composer-store.public.ts",
      "features/plugins/application/composer-catalogue.public.ts",
      "features/account/projection/usage.public.ts",
      "features/account/bindings/use-account-workflows.public.tsx",
      "features/terminal/projection/terminal-size.public.ts",
      "features/sessions/projection/worktree-state.public.ts",
      "features/workspace/ui/WebuiWorkspaceDirectoryBrowser.public.tsx",
    ];
    for (const relative of published) {
      expect(existsSync(`${clientRoot}${relative}`), relative).toBe(true);
    }
    // Both suffixes are in use, and the suffix says what the module is: a
    // `.public.tsx` is a component and a `.public.ts` is not.
    expect(published.some((entry) => entry.endsWith(".tsx"))).toBe(true);
    expect(published.some((entry) => entry.endsWith(".ts"))).toBe(true);
  });
});

describe("V41 · the delivery mechanism imports nothing from Turn", () => {
  it("the stream loop reaches only shared contracts and its own lease", () => {
    // The mechanism is reusable conversation composition; Turn is one business
    // that happens to use it. A Turn import here would make the mechanism
    // unusable by anything else, and would put the loop's shape under Turn's
    // control — which is the coupling this row exists to keep out.
    const loop = read("conversation/stream-loop.ts");
    const specifiers = [...loop.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier, specifier).not.toContain("features/turn");
      expect(specifier, specifier).not.toContain("/turn/");
      // The two things it may reach: shared wire contracts, and the lease it
      // implements against.
      const allowed = specifier.startsWith("../../shared/contracts/") || specifier.startsWith("./");
      expect(allowed, specifier).toBe(true);
    }
  });

  it("the lease it implements against reaches only shared types, never Turn at all", () => {
    // The mechanism's lease is generation bookkeeping: a counter and "is this
    // still the newest claim". It needs no business vocabulary to say that, so it
    // imports nothing from Turn — not its implementation, and not its contracts
    // either. Naming a business aggregate in the mechanism was the remaining half
    // of the coupling this row exists to keep out: the aggregate's claim and
    // scoped release live in `features/turn/application/stream-lease.ts`, which is
    // where the business transform belongs.
    const lease = read("conversation/stream-lease.ts");
    const specifiers = importSpecifiers(lease);
    expect(specifiers).toEqual([]);
    // And no business vocabulary in the source at all — not as a type, not as a
    // helper. A comment may name where the transform now lives; the code may not
    // name the aggregate.
    expect(lease).not.toContain("WebuiStreamState");
    expect(lease).not.toContain("WebuiStreamSubscription");
  });
});

describe("V30 · the two lifetime composition seams are dependencies, not constructions", () => {
  it("Workspace composes the review resource it is handed instead of building one", () => {
    // The peer-import plan's entry 13 said "construct at the lifetime site and
    // hand Workspace a semantic interface". The corrective slice here is the
    // difference between importing a peer's *factory* (a second construction site
    // for one owner) and importing its *interface* (a resource to compose).
    const source = read("features/workspace/application/workspace-queries.ts");
    // The interface may be reached — it is the published surface — but the
    // factory may not: a value import of it is what made Workspace a second
    // construction site for the review owner.
    expect(source).toMatch(/import type \{ WebuiWorkspaceReviewOwner \}/u);
    expect(source).not.toMatch(/import\s*\{[^}]*createWebuiWorkspaceReviewOwner/u);
    expect(source).toContain("readonly review: WebuiWorkspaceReviewOwner;");
    expect(source).toContain("const review = deps.review;");
    // And it composes the interface, not the resource that carries teardown: the
    // life of the owner belongs to whoever built it.
    expect(source).not.toContain("WebuiWorkspaceReviewResource");
  });

  it("the composition root builds that resource once and fences it", () => {
    const application = read("application/create-application.ts");
    expect(application).toContain("const workspaceReview = createWebuiWorkspaceReviewOwner({");
    expect(application).toContain("review: workspaceReview,");
    expect(application).toContain('shutDown("workspace review resource", () => workspaceReview.dispose());');
  });

  it("the interaction owners take Sessions' commands instead of composing them", () => {
    // Peer-import plan entry 29: compose the session-scoped semantic commands at
    // the existing lifetime seam and inject them, the way Turn's phase intents
    // already are. An owner registry that built them itself was reaching into a
    // peer's factory and supplying its own writer.
    const source = read("features/interactions/application/interaction-session-owners.ts");
    expect(source).toContain("readonly commandsFor: (sessionId: string) => WebuiInteractionCommands;");
    expect(source).toContain("const commands = deps.commandsFor(sessionId);");
    for (const specifier of importSpecifiers(source)) {
      // The interface may be reached; the factory may not.
      expect(specifier, specifier).not.toContain("/sessions/application/session-commands.js");
    }
    const application = read("application/create-application.ts");
    expect(application).toContain("commandsFor: (sessionId) =>");
  });
});

describe("ST1 · a published binding does not carry the owner's life", () => {
  it("narrows Account's consumer surface so teardown is not reachable", () => {
    // `peer-imports-plan.md` requires the account binding's consumer type to omit
    // disposal while keeping instance identity. Publishing the full owner made the
    // edge legal without performing that authority correction.
    type HasDispose<T> = "dispose" extends keyof T ? true : false;
    // The owner does carry teardown — that is what the narrowing is against.
    const ownerCarriesTeardown: HasDispose<WebuiAccountWorkflows> = true;
    // And the consumer type does not. This is a compile-time assertion: if
    // `dispose` appeared on the published surface, `false` would not be assignable
    // and this file would not compile.
    const consumerDoesNot: HasDispose<WebuiAccountWorkflowsConsumer> = false;
    expect(ownerCarriesTeardown).toBe(true);
    expect(consumerDoesNot).toBe(false);

    const binding = read("features/account/bindings/use-account-workflows.public.tsx");
    expect(binding).toContain('Omit<WebuiAccountWorkflows, "dispose">');
    expect(binding).toContain("useWebuiAccountWorkflows(): WebuiAccountWorkflowsConsumer | undefined");
    // A forwarding object would be a different fix: the instance a consumer
    // receives must be the one the root built.
    expect(binding).not.toContain("WebuiAccountWorkflowsConsumer = {");
  });
});

describe("V43 · composer's input rules live with the composer, not with the shell", () => {
  it("the controller's whole dependency surface is its own business plus contracts", () => {
    // Reading the input rules must not require reading the shell, and changing
    // them must not require reading the layout. The controller is where they
    // live, so this is the file that has to be readable on its own: it may reach
    // shared wire contracts, its own business, and Turn's *contracts* — never a
    // Turn application module, never the shell, never a concrete transport.
    const controller = read("features/composer/application/composer-controller.ts");
    const specifiers = importSpecifiers(controller);
    expect(specifiers.length).toBeGreaterThan(0);

    // The whole surface, stated as what it is allowed to be rather than as a
    // list of things it must not reach — a denylist is what a new import slips
    // past, an allowlist is what it has to be argued into.
    //
    // The specifiers are relative to `features/composer/application/`, so:
    //   `./`                      its own application modules
    //   `../contracts|projection/` its own contracts and derivations
    //   `../../../contracts/`      the client-wide shared contract layer
    //   `../../../../shared/`     the cross-execution wire contracts
    //   `../../turn/contracts/`   Turn's published submission surface (#160)
    const ALLOWED_PREFIXES = [
      "./",
      "../contracts/",
      "../projection/",
      "../../../contracts/",
      "../../../../shared/contracts/",
      "../../turn/contracts/",
    ];
    for (const specifier of specifiers) {
      expect(
        ALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
        `${specifier} is not one of the composer's own modules or a published contract`,
      ).toBe(true);
    }
    // And the two directions the row actually cares about, said directly: no
    // implementation module of any other business, and nothing that decides
    // layout.
    expect(
      specifiers.filter((specifier) =>
        /\.\.\/(\.\.\/)?\.\.\/(?:turn|sessions|models|goal|workspace|review|plugins|account|settings|transcript)\/(?:application|projection|bindings|ui)\//u.test(specifier),
      ),
    ).toEqual([]);
    expect(specifiers.filter((specifier) => /(shell|platform)\//u.test(specifier))).toEqual([]);
  });

  it("the store owns the input state the controller decides on", () => {
    // A row about auditability is satisfied when the rules and the state they
    // read are both in the composer's own tree — so a reader auditing "what does
    // the composer consider a sendable message" reaches exactly two files.
    const controller = read("features/composer/application/composer-controller.ts");
    const store = read("features/composer/application/composer-store.ts");
    expect(controller).toContain("./composer-store.js");
    // The store holds the draft/history/slot state the input policy gates on,
    // and reaches for no projection to decide what those are.
    expect(store).toContain("purgeSlot");
    const storeSpecifiers = importSpecifiers(store);
    expect(storeSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of storeSpecifiers) {
      const own =
        specifier.startsWith("./") ||
        specifier.startsWith("../contracts/") ||
        specifier.startsWith("../projection/");
      expect(own, specifier).toBe(true);
    }
  });

  it("the shell composes the composer without holding an input rule", () => {
    // The other half of separability: the layout host must not have absorbed
    // any of the rules it lays out. It renders the composer and passes it
    // props; it does not compute what may be sent.
    const frame = read("shell/WebuiClientFoundationApp.tsx");
    // No input-policy call sites live in the frame. `submitWebuiTurn` is the
    // one that would mean the shell deciding a submission.
    expect(frame).not.toContain("submitWebuiTurn");
    expect(frame).not.toContain("planWebuiSubmission");
    // And the layout host does not reach into the composer's own application
    // modules either.
    // The one reach into the composer's application layer is a shared key — the
    // home session's draft key, which the rail has to address too. A constant is
    // not an input rule, so the constraint is narrower than "imports nothing":
    // every module it takes from there must be named, so a second import fails
    // the case until it is argued for.
    const composerReaches = importSpecifiers(frame).filter((specifier) =>
      specifier.includes("features/composer/application/") ||
      specifier.includes("features/composer/projection/"),
    );
    expect(composerReaches).toEqual(["../features/composer/application/composer-history.js"]);
  });
});
