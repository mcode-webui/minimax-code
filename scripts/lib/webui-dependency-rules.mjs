// Pure-function WebUI internal dependency-direction rules.
//
// `scripts/check-webui-dependency.mjs` is the CLI entry; it builds the resolved
// source import graph and hands it to the rules below. Tests import the rules
// directly so this module stays free of side effects at import time: nothing
// here reads the filesystem or the repository until a function is called, and
// the only module-level state is the declared layer matrix and provenance table.
//
// This check is deliberately separate from `scripts/lib/webui-boundary.mjs`
// (the esbuild metafile check). The metafile cannot see `import type` edges —
// they are erased from build output — and it proves an input is *present*, not
// that its dependency *direction* is legal. The layer matrix and the allowed
// edges are ADR 0014's; the caller-role rules and the checks that enforce them
// are documented in `packages/webui/docs/architecture/boundaries.md`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";

// Registered Node builtin module names. Used by the node-builtin rule to
// detect `import "fs"`-style specifiers in client / shared code that the
// previous `node:`-prefixed rule missed.
const BUILTIN_NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

// The Typescript compiler drives parsing and module resolution. Importing it is
// side-effect-free; it is only *used* when `buildDependencyGraph` runs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// The publication predicate is shared, not reimplemented here: the layer rules
// and the visibility gate must agree about what counts as a published module,
// or one of them ends up enforcing a set the other has never heard of.
import { isPublicModulePath, publicationRule } from "./webui-publication.mjs";
/** @type {typeof import("typescript")} */
const ts = require("typescript");
// Names whose resolution to a TypeScript lib `*.d.ts` declaration is the
// signal of an ambient access. Local parameters or destructured fields with
// the same identifier are filtered out below; this set is the candidate set,
// not the verdict.
//
// `self` is the browser's other name for the global object (and the worker
// global). It is collected as a *base object* like `window`: a binding that
// registers `self.addEventListener(...)` stays legal, while the restricted
// members read off it are judged by their own policy below.
const BROWSER_GLOBAL_CANDIDATES = new Set([
  "document",
  "localStorage",
  "sessionStorage",
  "window",
  "globalThis",
  "self",
]);

/**
 * Ambient members whose **own** policy decides an access, wherever they are
 * read from. `window.localStorage` is a `localStorage` access: judging it by
 * `window`'s policy (allowed for bindings) let code reach the page's storage
 * through the base object — `window.localStorage`, `globalThis.localStorage`,
 * `self.localStorage`, `globalThis.window.localStorage`, `window["localStorage"]`
 * and `const { localStorage } = window` all passed. The base object's own
 * access is still recorded and still judged by the base policy, so a chain can
 * legitimately report both.
 *
 * Every name here needs its own entry in `BROWSER_GLOBAL_POLICY`; the two sets
 * are related but not interchangeable — `window`, `globalThis` and `self` are
 * base objects with broad layer sets, these three are the restricted members.
 */
const RESTRICTED_AMBIENT_MEMBERS = new Set([
  "document",
  "localStorage",
  "sessionStorage",
]);

/** Directory (repository-relative) whose source files this check covers. */
export const WEBUI_SOURCE_DIRECTORY = "packages/webui/src";

/** Source suffixes in scope. `.js` sources are excluded on purpose (plan §7.5). */
export const SOURCE_SUFFIXES = Object.freeze([".ts", ".tsx", ".d.ts"]);

// ---------------------------------------------------------------------------
// Layers and the allowed-edge matrix
// ---------------------------------------------------------------------------

/**
 * Declared target layers. Assignment is by *target* layer, never by the current
 * directory: `classifyLayers` maps each source path through the provenance table
 * in plan §7.1/§7.2/§7.3.
 */
export const LAYERS = Object.freeze([
  "root",
  "bindings",
  "application",
  "infrastructure",
  "mechanisms",
  "view",
  "domain",
  "contracts",
  "shared",
  "server",
  "runtime-port",
  "runtime",
  "unknown",
]);

/**
 * Allowed forward edges between declared layers. An edge is legal when the
 * target layer appears here for the source layer (identity is always allowed).
 * This is a matrix, not a directory-name denylist: nothing is forbidden merely
 * because a directory is called "components".
 *
 * Provenance for each denial is plan §3: domain/view must not reach React,
 * components, application, concrete transport, server or Node; application must
 * not reach components/React/DOM/concrete transport/server or the Node runtime
 * port; browser infrastructure must not reach components or application
 * implementation; Node runtime must not reach browser, React, DOM or storage;
 * shared contracts reach neither execution side; contract declarations are
 * leaves and cannot import projection implementation.
 *
 * `root` is the browser and server composition root and may join every layer.
 */
export const ALLOWED_EDGES = Object.freeze({
  root: Object.freeze([
    "bindings",
    "application",
    "infrastructure",
    "mechanisms",
    "view",
    "domain",
    "contracts",
    "shared",
    "server",
    "runtime-port",
    "runtime",
  ]),
  bindings: Object.freeze([
    "application",
    "view",
    "domain",
    "contracts",
    "shared",
    "infrastructure",
    "mechanisms",
  ]),
  application: Object.freeze([
    "view",
    "domain",
    "contracts",
    "shared",
    "mechanisms",
  ]),
  infrastructure: Object.freeze([
    "contracts",
    "shared",
    "mechanisms",
    "view",
    "domain",
  ]),
  mechanisms: Object.freeze(["contracts", "shared"]),
  view: Object.freeze(["domain", "contracts", "shared"]),
  domain: Object.freeze(["view", "contracts", "shared"]),
  contracts: Object.freeze(["shared"]),
  shared: Object.freeze([]),
  server: Object.freeze(["shared", "runtime-port"]),
  "runtime-port": Object.freeze(["shared", "runtime"]),
  runtime: Object.freeze(["shared", "runtime-port"]),
  unknown: Object.freeze([]),
});

/**
 * The files plan §7.5 marks as mixing responsibilities: their layer is
 * provisional and cannot be judged from the path alone until they are split.
 * They are still classified (by destination) so their existing edges are
 * counted, but the CLI reports every violation that touches one of them so a
 * reviewer can see the provisional judgement instead of a silent pass.
 *
 * The list is currently **empty**: every file that was listed here has either
 * been split or was re-read and found not to mix. The mechanism is kept — a
 * future file can be listed again, and `collectProvisionalJudgements` plus the
 * CLI's provisional section keep working for whoever adds it — but today no
 * entry reports.
 *
 * Every removal below records, in a comment, where that file actually mixed (or
 * why it never did). The judgement is **path-level** — a file is ambiguous or it
 * is not, and every violation touching one is surfaced. The **symbol-level**
 * ownership check §7.5 asks for still does not exist: nothing here can tell
 * which of a mixed file's symbols owns a given edge. An empty list is not that
 * capability having been built; it is there being nothing left to judge. If a
 * genuinely two-layer file appears, add it here *and* implement symbol-level
 * ownership — the list alone only surfaces the violation, it does not decide it.
 *
 * `client/features/turn/projection/stream-state.ts` used to be listed here. It has since
 * become a pure `view` projection: `classifyLayers` gives it exactly `view`,
 * its only imports are shared contracts, the leaf
 * `client/features/turn/contracts/stream-state.ts` declarations and the `workspace-progress`
 * projection, and no mechanism reaches into it any more. Listing it
 * contradicted that classification, so the entry was removed rather than left
 * asserting a mixture that no longer exists.
 *
 * `client/contracts.ts` used to be listed here. The stage-1 contracts split
 * replaced it with leaf `client/contracts/*.ts` capability/view modules, so
 * the path no longer exists to be judged and the entry was removed rather than
 * left pointing at a missing file.
 *
 * `client/session-runtime-store.ts` used to be listed here too. It had no
 * remaining importer, so the ticket-#45 slice deleted it and the entry was
 * removed for the same reason: there is no file left to judge.
 *
 * `client/connection-health.ts` and `server/session-transfer.ts` were the two
 * entries that outlived their files: `connection-health.ts` moved to
 * `client/infrastructure/` and `server/session-transfer.ts` became
 * `runtime/session-transfer.ts`. `client/stream-instrumentation.ts` moved to
 * `client/mechanisms/`, where the directory decides its layer, so its entry is
 * obsolete too. All three are removed here rather than left pointing at paths
 * that no longer exist.
 *
 * The same rule applied to `CLIENT_FILE_PROVENANCE`, now deleted along with
 * `PROJECTION_SPLIT`: an entry for a file that no longer sits at that path is
 * deleted, so a re-created file at the old path classifies as `unknown` and is
 * reported instead of silently inheriting a stale layer.
 *
 * `runtime/port.ts` used to be listed here. The entry claimed the module "pulls
 * the shared plugin-management / canvas / model contract shapes into the same
 * module", which is not what it does: every one of those shapes is imported
 * with `import type` from `shared/`, and the DTOs already live in `shared/` —
 * the port only *names* them. The only thing standing between the port and a
 * single-layer judgement was a four-line `export type { ... } from
 * "../shared/plugin-management.js"` forwarding shell, which was deleted; its one
 * consumer (`runtime/harness/host-contract.ts`) now names the shared module in
 * its inline type query. A type-only re-export is not a second layer either, so
 * the entry asserted a mixture that did not exist.
 *
 * `client/components/composer/slash-palette.ts` used to be listed here, and this one *was* a real
 * mixture: the module re-exported the leaf `contracts/slash-command.js` symbols
 * and imported React icon components in the same file, so it was simultaneously
 * a contract barrel and a presentation module. The two forwarding `export { }`
 * / `export type { }` blocks were deleted and every consumer now names
 * `contracts/slash-command.js` directly — one module, one path, no barrel. What
 * stays is presentation: `SlashCommandEntry`, the three display data pools
 * (`WEBUI_BUILTIN_COMMANDS`, `WEBUI_PLUGIN_REGISTRY`, `WEBUI_SKILL_FIXTURES`),
 * `slashSkillSummaryToEntry` and the icons.
 *
 * `server/envelope.ts` used to be listed here. The entry's stated worry was a
 * "server-path module holding frame-validation behaviour that the runtime is
 * meant to reach without depending on server code", but that is a forward-looking
 * concern about an edge that does not exist: no module under `runtime/` imports
 * `server/envelope.js` at all. The declarations (frame shape, protocol version,
 * error codes) live in `shared/envelope.ts` and the only thing here is the
 * `isWebuiFrame` validator, whose two importers are `server/index.ts` and
 * `server/operation/operation-dispatch.ts`. Both are server-path, both are legal,
 * so the path hides no edge.
 *
 * `server/service.ts` used to be listed here too. Re-read line by line, it holds
 * only what plan §7.1 leaves it — HTTP/WS assembly plus `start`/`close` — plus
 * composition-root work: it constructs the operation registry, projects the
 * harness port's methods into it, injects `WebuiTerminalManager` and the HTTP
 * listener / WebSocket server constructors, and shuts down in order. The
 * network lifecycle itself already lives in `http-server.ts`,
 * `websocket-server.ts`, `frame-handler.ts` and `access-policy.ts`. OAuth,
 * broker and browser-provider work is *named* but never implemented here: the
 * OAuth-shaped members (`getCodexOAuthStatus`, `startCodexOAuthLogin`,
 * `cancelCodexOAuthLogin`, …) are one-line forwards into `this.port`, so no
 * resource state machine is inlined. A composition root is the one place
 * §7.5 explicitly permits, and it is classified `server` by path, so the entry
 * asserted a mixture that the file does not have.
 */
export const KNOWN_AMBIGUOUS_FILES = Object.freeze([]);

/**
 * Baseline categories, each keyed to a migration stage from plan §7.7 (the
 * stage by which the exception must be gone). `stage` and `reason` are copied
 * into every baseline entry so a later slice is forced to delete it.
 */
export const CATEGORIES = Object.freeze({
  "client-to-server-port": Object.freeze({
    stage: 1,
    description:
      "A browser layer imports the Node capability port (`runtime/port.ts`). Stage 1 requires the client to import no server module; consumers move to client contracts or shared DTOs.",
  }),
  "projection-to-components": Object.freeze({
    stage: 1,
    description:
      "A pure view/domain projection imports a React component. Presentation-owned types must move below their consumers (plan §3), removing the component dependency.",
  }),
  "contract-to-projection": Object.freeze({
    stage: 1,
    description:
      "A leaf client contract imports projection implementation. Contract declarations are leaves; the stage-1 contracts split removes the edge.",
  }),
  "runtime-to-client-contracts": Object.freeze({
    stage: 2,
    description:
      "A runtime-mapped file pulls browser contract declarations into the Node graph. Runtime extraction plus shared DTO placement removes it.",
  }),
  "runtime-to-server-envelope": Object.freeze({
    stage: 2,
    description:
      "The runtime-mapped harness host reaches the server envelope module. After extraction the runtime depends on shared contracts, not server code.",
  }),
  "server-operation-to-runtime": Object.freeze({
    stage: 2,
    description:
      "A server operation module imports runtime implementation. After extraction the operations are protocol validators; the server consumes only runtime capabilities.",
  }),
  "server-barrel-to-runtime": Object.freeze({
    stage: 2,
    description:
      "The server public barrel re-exports runtime implementation. The barrel must export the network entry only.",
  }),
  "stream-loop-to-projection": Object.freeze({
    stage: 4,
    description:
      "The mechanism-mapped stream loop reaches into projection. Stage 4 injects the pure transforms (plan §7.2) so the mechanism no longer imports projection.",
  }),
  unclassified: Object.freeze({
    stage: 6,
    description:
      "A matrix violation that does not match a recorded category. Treat as a new direction failure.",
  }),
});

// ---------------------------------------------------------------------------
// Provenance: current path -> target layer(s)
// ---------------------------------------------------------------------------

// The provenance tables this section used to declare are gone (Phase 4, C-fin).
// Every entry of `CLIENT_FILE_PROVENANCE` had left `client/` root by the time it
// was deleted, and each of those files now classifies identically from its own
// prefix: `team-mode`/`no-project` under `client/infrastructure/`,
// `value-readers` under `client/contracts/`, `paths`/`rail-buckets`/`router`
// under `client/projection/` (a basename lookup that still finds them `view`),
// and `slash-palette`/`markdown`/`icons`/`ConnectionStatus` under
// `client/components/`. The two files that stay at the client root by plan §6.1
// carry an explicit path rule above instead. `PROJECTION_SPLIT` is gone for the
// same reason: `composer-history` and `effect-reducer` moved under
// `client/application/`, `transcript-request-ownership` with them, `stream-state`
// is `view` by the basename fallback, and `file-line-navigation` names no file
// in the package.

// `client/projection/*` classification, from plan §2's "Required module
// classification" table. Files not listed here are pure view projections.
// `session-activity` is the relocated pure activity rules (plan §7.3, ticket
// #49): it moved from `client/session-activity.ts` (classified `domain`) to
// `client/features/sessions/projection/session-activity.ts`, keeping that layer.
// `context-usage` and `event-parsers` are gone from the list: the first is now
// `client/features/composer/contracts/context-usage.ts`, which the contracts
// branch decides before any basename lookup, and the second was re-homed to
// `client/projection/common/` by T21 and decodes the shared wire contracts into
// shared view models with no business policy in it, so the view rule holds.
const PROJECTION_DOMAIN = new Set([
  "action-requests",
  "goal-state",
  "model-favorites",
  "model-reorder",
  "plan-mode",
  "questionnaire-state",
  "session-activity",
  "thinking-control",
  "token-plan-model",
  "workspace-progress",
  "worktree-state",
]);

// (No `server/*` provenance table remains: every file whose destination was
// `runtime/` has moved there, so what is left under `server/` is the loopback
// network layer and the path alone decides it.)

function basenameWithoutExtension(relative) {
  return path.basename(relative).replace(/\.(d\.ts|tsx|ts)$/u, "");
}

/**
 * Maps a source path (relative to `packages/webui/src`) to one or more target
 * layers. Both the current layout (via the provenance table above) and the
 * post-migration target layout (via directory) are recognised, so the same
 * checker works before, during and after the migration.
 *
 * @param {string} relative
 * @returns {string[]}
 */
export function classifyLayers(relative) {
  const normalized = relative.split(path.sep).join("/");

  // Composition root (browser) — explicit exception per plan §7.5. `main.tsx`
  // and `global.d.ts` are the two files plan §6.1 keeps at the client root, so
  // their layer has to be stated here; `global.d.ts` used to get it from
  // `CLIENT_FILE_PROVENANCE`, which C-fin deleted.
  if (normalized === "client/main.tsx") return ["root"];
  if (normalized === "client/global.d.ts") return ["root"];

  // Target layout (post-migration, and the layout fixtures use).
  //
  // The business-first homes (plan §5.1) carry the same layers their current
  // technical homes do, so a file keeps its layer when it moves and a direction
  // rule is not re-spelled. Without these the moved paths would classify
  // `unknown`, which reports rather than constrains — the gate would look green
  // while enforcing less than it did before the move.
  if (normalized.startsWith("client/features/")) {
    const [business, ...tail] = normalized.slice("client/features/".length).split("/");
    if (!business) return ["unknown"];
    const directory = tail[0];
    const entry = FEATURE_ROLE_DIRECTORIES[directory];
    if (!entry) {
      // A file at the feature root is its published surface; if it sits there it
      // declares something. Report anything deeper that has no role directory.
      return ["unknown"];
    }
    if (entry.layer !== null) return [entry.layer];
    // `projection/` is the one directory whose layer depends on the module: a
    // derivation carrying business policy is a `domain`, one that only reads is a
    // `view`. The `.public` suffix is a publication marker, not part of the name —
    // `workspace-name.public.ts` publishes the derivation `workspace-name.ts`
    // holds — so it is stripped before the lookup or a published derivation would
    // silently drop to `view`.
    const b = basenameWithoutExtension(normalized).replace(/\.public$/u, "");
    return PROJECTION_DOMAIN.has(b) ? ["domain"] : ["view"];
  }
  // Conversation substrate (plan §5.1) — the home of turn/history/stream
  // lifecycle, and the target for `client/mechanisms/` plus the history rules
  // that currently sit under `client/application/`.
  for (const [prefix, layer] of Object.entries(HOME_LAYERS)) {
    if (normalized.startsWith(prefix)) return [layer];
  }
  if (normalized.startsWith("shared/")) return ["shared"];
  if (normalized.startsWith("runtime/")) {
    if (normalized === "runtime/port.ts" || normalized.startsWith("runtime/harness/host-contract"))
      return ["runtime-port"];
    return ["runtime"];
  }

  // Current layout: provenance from plan §7.1/§7.2/§7.3.
  if (normalized === "server/envelope.ts") return ["server"];
  if (normalized.startsWith("server/operation/")) return ["server"];
  if (normalized.startsWith("server/projections/")) return ["server"];
  if (normalized.startsWith("server/")) return ["server"];
  if (normalized.startsWith("client/projection/")) {
    const b = basenameWithoutExtension(normalized);
    if (PROJECTION_DOMAIN.has(b)) return ["domain"];
    return ["view"];
  }
  // No provenance table remains for `client/` root files, so anything still
  // sitting at the root classifies `unknown` and is reported rather than
  // inheriting a layer a deleted entry used to assert.
  if (normalized.startsWith("client/")) return ["unknown"];
  return ["unknown"];
}

// ---------------------------------------------------------------------------
// Roles: the second, ownership-bearing dimension
// ---------------------------------------------------------------------------

/**
 * Target roles (plan §5.1/§5.3). A file's *layer* decides which direction an
 * edge may point; its *role* decides who owns the behaviour behind it. Both are
 * needed: `client/bindings/` and `client/components/` are the same layer
 * (`bindings`) but different roles, and `client/application/session-store.ts`
 * (assembly) and `client/application/models/...` (a business owner) are the same
 * path prefix but different roles.
 */
export const ROLES = Object.freeze([
  /** `client/main.tsx` — boot entry. */
  "entry",
  /** Application assembly, session-record repository, scope manager, routes. */
  "assembly",
  /** Conversation substrate: turn/history/stream lifecycle and lease primitives. */
  "conversation",
  /** A feature's published contracts (capability port, view types). */
  "feature-contracts",
  /** A feature's owner/workflows and use-case policy. */
  "feature-application",
  /** A feature's pure projections. */
  "feature-projection",
  /** A feature's React binding (the bridge that may hold capability objects). */
  "feature-bindings",
  /** A feature's React presentation. */
  "feature-ui",
  /** A file directly under a feature root, with no role directory of its own. */
  "feature-root",
  /** Browser IO: wire, storage, DOM, file and download adapters. */
  "platform",
  /** Reusable presentation mechanics with no business policy. */
  "ui",
  /** Shell layout and route-facing composition. */
  "shell",
  /** The current global React binding bridge, which has no target home. */
  "bindings",
  /** Pure projections no single business owns (the current `projection/common/`). */
  "projection-common",
  /** Browser contracts no single business owns (`contracts/transport.ts`, …). */
  "contracts-shared",
  /** Stylesheets. */
  "styles",
  /** A client path no rule recognises yet. */
  "unknown",
  /** Server, runtime or shared code, which carries no client role. */
  "outside",
]);

/** Which home a path sits in, so a rule can be scoped to the migrated part. */
export const HOMES = Object.freeze(["current", "target", "outside"]);

/**
 * One table for what a feature's role directory means.
 *
 * This used to be three tables plus a switch. `FEATURE_ROLE_DIRECTORIES` mapped
 * a directory name to a role; `CURRENT_HOME_ROLES` and `TARGET_HOME_ROLES`
 * mapped a path prefix to a role; and `classifyLayers` then re-derived the layer
 * from the directory name in a fourth place, with `if (role === "contracts") …
 * else if (role === "projection") …`. Four spellings of the same five
 * directories is how a table ends up disagreeing with itself the first time one
 * of them gains an entry.
 *
 * Each directory names one role, and the role names one layer. The layer is
 * derived here rather than written out per arm, so a new role directory is one
 * row rather than a row plus a switch arm plus a layer to keep in step.
 *
 * The layer is deliberately not one-per-role: `projection/` is `domain` for a
 * derivation carrying business policy and `view` for one that does not, which is
 * a property of the module's name rather than of its directory. That one case
 * consults `PROJECTION_DOMAIN`, and it is the only place it is consulted.
 */
const FEATURE_ROLE_DIRECTORIES = Object.freeze({
  application: { role: "feature-application", layer: "application" },
  projection: { role: "feature-projection", layer: null },
  bindings: { role: "feature-bindings", layer: "bindings" },
  ui: { role: "feature-ui", layer: "bindings" },
  contracts: { role: "feature-contracts", layer: "contracts" },
});

/** Target top-level homes that are not features. */
const TARGET_HOME_ROLES = Object.freeze({
  "client/conversation": { role: "conversation", business: null },
  "client/platform": { role: "platform", business: null },
  "client/ui": { role: "ui", business: null },
  "client/shell": { role: "shell", business: null },
  "client/main.tsx": { role: "entry", business: null },
});

/**
 * The top-level homes that carry no business, by layer.
 *
 * The two tables above answer "which role, and whose business"; this answers
 * "which layer", for the same prefixes. It is separate because that is the
 * dimension the direction matrix judges, and folding it into the role table
 * would make a role answer a question about reachability with a value the
 * reachability rules then have to know the meaning of.
 */
const HOME_LAYERS = Object.freeze({
  "client/conversation/": "mechanisms",
  "client/platform/": "infrastructure",
  "client/ui/": "bindings",
  "client/shell/": "bindings",
  "client/bindings/": "bindings",
  "client/application/": "application",
  "client/contracts/": "contracts",
});

/**
 * Current top-level homes → role + which path segment names the business.
 * `business: "none"` means the home carries no business; `business: "segment"`
 * means the first segment below the home is the business name unless
 * `businessless` lists an exception for that home.
 */
const CURRENT_HOME_ROLES = Object.freeze([
  { prefix: "client/application/", role: "feature-application", business: "segment", flat: { role: "assembly", business: null } },
  { prefix: "client/projection/", role: "feature-projection", business: "segment", businessless: { common: "projection-common" } },
  { prefix: "client/contracts/", role: "feature-contracts", business: "segment", flat: { role: "contracts-shared", business: null } },
  { prefix: "client/bindings/", role: "bindings", business: "none" },
  { prefix: "client/styles/", role: "styles", business: "none" },
]);

/**
 * Maps a source path (relative to `packages/webui/src`) to its role: the
 * behaviour it owns, the business that owns it (or `null`) and the home it sits
 * in. Both the current technical homes and the target business-first homes are
 * recognised, so one role rule holds before, during and after the migration —
 * a defect is not re-spelled when the file moves.
 *
 * @param {string} relative
 * @returns {{ readonly role: string, readonly business: string | null, readonly home: string }}
 */
export function classifyRole(relative) {
  const normalized = relative.split(path.sep).join("/");
  if (normalized === "client/global.d.ts") return { role: "entry", business: null, home: "current" };

  // A `.public` module is the business's published surface, and publishing is
  // what makes a cross-business import legal. The marker is carried on the role
  // rather than by making `published` a separate role: the module still occupies
  // its own role directory, and dropping that would lose the layer and duplicate-
  // owner judgements that apply to it. Only the *reachability* changes.
  if (normalized.startsWith("client/features/")) {
    const [business, ...tail] = normalized.slice("client/features/".length).split("/");
    if (!business) return { role: "unknown", business: null, home: "target" };
    if (tail.length === 0) return { role: "feature-root", business, home: "target" };
    const role = FEATURE_ROLE_DIRECTORIES[tail[0]]?.role ?? "feature-root";
    return {
      role: isPublicModulePath(normalized) ? `published-${role}` : role,
      business,
      home: "target",
    };
  }

  for (const [prefix, entry] of Object.entries(TARGET_HOME_ROLES)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return { role: entry.role, business: entry.business, home: "target" };
    }
  }

  for (const home of CURRENT_HOME_ROLES) {
    if (!normalized.startsWith(home.prefix)) continue;
    const rest = normalized.slice(home.prefix.length);
    const segments = rest.split("/");
    if (home.business === "none") return { role: home.role, business: null, home: "current" };
    // A file directly below the home (`application/query-store.ts`) is not a
    // business: the current layout keeps flat assembly / shared contract modules
    // there, and they have their own role.
    if (segments.length === 1) {
      const flat = home.flat ?? { role: home.role, business: null };
      return { role: flat.role, business: flat.business, home: "current" };
    }
    const segment = segments[0];
    const override = home.businessless?.[segment];
    if (override) return { role: override, business: null, home: "current" };
    return { role: home.role, business: segment, home: "current" };
  }

  if (normalized.startsWith("client/")) return { role: "unknown", business: null, home: "current" };
  return { role: "outside", business: null, home: "outside" };
}

/**
 * True when a path is presentation: a file that submits commands and receives
 * none of the capability objects those commands are reached through. This is the
 * call-site rule's missing half — `classifyLayers` maps `client/components/`
 * and `client/bindings/` to the same layer, so the layer set cannot tell the
 * shell and its panels from the bridge that legitimately holds a capability.
 *
 * It is a role judgement rather than a path prefix so it holds in both
 * spellings: `client/components/composer/` and `client/features/composer/ui/` are
 * the same presentation, and a file must not escape the rule by arriving at its
 * target home. Both spellings classify as presentation today, so the substitution
 * adds no violation to the current tree.
 */
export function isPresentationRole(relative) {
  const { role } = classifyRole(relative);
  return role === "feature-ui" || role === "ui" || role === "shell";
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

/**
 * Normalises an absolute path to the `packages/webui/src`-relative, POSIX form
 * the rules operate on, or returns `null` when the file is outside the package
 * source directory. This is the single place path shapes are reconciled.
 *
 * @param {string} repositoryRoot
 * @param {string} absolutePath
 * @returns {string | null}
 */
export function normaliseSourcePath(repositoryRoot, absolutePath) {
  const sourceRoot = path.join(repositoryRoot, WEBUI_SOURCE_DIRECTORY);
  const relative = path.relative(sourceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Matrix evaluation
// ---------------------------------------------------------------------------

/**
 * True when any (source target layer, destination target layer) pair is
 * permitted. A file that splits across layers may import a layer if *any* of
 * its destinations may; this is what lets a genuinely shared module keep a
 * legal edge while still forbidding the illegitimate one.
 *
 * @param {readonly string[]} fromLayers
 * @param {readonly string[]} toLayers
 * @returns {boolean}
 */
export function isAllowedEdge(fromLayers, toLayers) {
  for (const from of fromLayers) {
    for (const to of toLayers) {
      if (from !== to && !(ALLOWED_EDGES[from] ?? []).includes(to)) return false;
    }
  }
  return true;
}

const BROWSER_LAYERS = new Set([
  "root",
  "bindings",
  "application",
  "infrastructure",
  "mechanisms",
  "view",
  "domain",
  "contracts",
]);

/** True when either endpoint of a pair is a known-ambiguous file. */
export function touchesAmbiguousFile(from, to, ambiguousFiles = KNOWN_AMBIGUOUS_FILES) {
  return ambiguousFiles.includes(from) || ambiguousFiles.includes(to);
}

/**
 * Every measured violation whose judgement rests on a provisional layer, i.e.
 * one that touches a plan §7.5 mixed-responsibility file.
 *
 * These are reported, not enforced: the file's layer is an assumption until the
 * file is split, so a violation touching one may or may not be a real defect.
 * They therefore never feed the pass/fail condition — a reviewer reads them.
 * `violations` is the measured violation list (`result.direction`), so the
 * caller decides which subset to annotate.
 *
 * `ambiguousFiles` defaults to the real list and exists so the tests can drive
 * this with a fixture list. The real list is empty today, and a test that only
 * ever passed an empty list would pass even if the filter were deleted — the
 * parameter is what keeps the mechanism covered, not a way to reconfigure it.
 * Callers that omit it get exactly the shipped behaviour.
 */
export function collectProvisionalJudgements(
  violations,
  ambiguousFiles = KNOWN_AMBIGUOUS_FILES,
) {
  return violations
    .filter((violation) =>
      touchesAmbiguousFile(violation.from, violation.to, ambiguousFiles),
    )
    .map((violation) => ({
      from: violation.from,
      to: violation.to,
      category: violation.category,
      ambiguous: [
        ...(ambiguousFiles.includes(violation.from) ? [violation.from] : []),
        ...(ambiguousFiles.includes(violation.to) ? [violation.to] : []),
      ],
    }));
}

function allIn(values, set) {
  return values.every((value) => set.has(value));
}

/**
 * Annotates a matrix violation with the plan §7.5 category it belongs to. The
 * matrix decides *whether* an edge is a violation; this only names it so the
 * frozen baseline can carry a stage and a reason.
 */
export function categoriseViolation(from, to, fromLayers, toLayers) {
  if (toLayers.includes("runtime-port") && allIn(fromLayers, BROWSER_LAYERS))
    return "client-to-server-port";
  if (allIn(fromLayers, new Set(["view", "domain"])) && allIn(toLayers, new Set(["bindings"])))
    return "projection-to-components";
  if (allIn(fromLayers, new Set(["contracts"])) && allIn(toLayers, new Set(["view", "domain"])))
    return "contract-to-projection";
  if (
    allIn(fromLayers, new Set(["runtime", "runtime-port"])) &&
    allIn(toLayers, new Set(["contracts"]))
  )
    return "runtime-to-client-contracts";
  if (fromLayers.includes("runtime") && toLayers.includes("server") && /envelope\.ts$/u.test(to))
    return "runtime-to-server-envelope";
  if (
    allIn(fromLayers, new Set(["server"])) &&
    from.startsWith("server/operation/") &&
    toLayers.includes("runtime")
  )
    return "server-operation-to-runtime";
  if (from === "server/index.ts" && toLayers.includes("runtime"))
    return "server-barrel-to-runtime";
  if (from === "client/stream-loop.ts" && allIn(toLayers, new Set(["view", "domain"])))
    return "stream-loop-to-projection";
  return "unclassified";
}

// ---------------------------------------------------------------------------
// Source parsing and module resolution
// ---------------------------------------------------------------------------

/**
 * Collects every module reference in one source file: static imports,
 * re-exports, `import type`, type queries (`import("x")`) and dynamic imports.
 * Non-literal dynamic imports are returned separately because they cannot be
 * resolved and must not become an unchecked escape.
 *
 * Two non-import facts are also collected as text-anchored candidates and
 * resolved later against the TypeScript program: `browserGlobalCandidates`
 * records every identifier whose name matches an ambient browser global so a
 * subsequent symbol check can confirm the access reaches a `lib.dom.d.ts`
 * declaration (filtering out local parameters with the same name); and
 * `callCandidates` records the position of every call expression whose
 * callee is a property access (used to drive the writer-creation /
 * transport-RPC rule).
 *
 * @param {string} fileName
 * @param {string} sourceText
 * @returns {{
 *   references: Array<{specifier: string, line: number, kind: string}>,
 *   nonLiteralDynamic: Array<{line: number}>,
 *   browserGlobalCandidates: Array<{name: string, line: number, position: number}>,
 *   callCandidates: Array<{line: number, position: number, end: number}>,
 * }}
 */
export function collectModuleReferences(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const references = [];
  const nonLiteralDynamic = [];
  const browserGlobalCandidates = [];
  const callCandidates = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        kind: node.importClause?.isTypeOnly ? "import-type" : "import",
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        kind: node.isTypeOnly ? "export-type" : "export",
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        references.push({ specifier: argument.text, line: lineOf(node), kind: "dynamic" });
      } else {
        nonLiteralDynamic.push({ line: lineOf(node), expression: node.getText(sourceFile) });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length > 0 &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      references.push({ specifier: node.arguments[0].text, line: lineOf(node), kind: "require" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      references.push({ specifier: node.moduleReference.expression.text, line: lineOf(node), kind: "import-equals" });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      nonLiteralDynamic.push({ line: lineOf(node), expression: node.getText(sourceFile) });
    } else if (
      ts.isImportTypeNode(node) &&
      node.argument &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({
        specifier: node.argument.literal.text,
        line: lineOf(node),
        kind: "type-query",
      });
    }
    collectAmbientCandidate(node, browserGlobalCandidates, lineOf);
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression) || ts.isIdentifier(node.expression))) {
      // Three callee shapes are recorded, because a capability method can be
      // invoked through any of them: `port.m(...)`, `port["m"](...)` and a
      // binding or variable the caller took the method into (`const { m } = port`).
      // The program pass decides which ones actually name a capability method.
      //
      // The anchor is the node's whole span, not just its start. A capability
      // call whose result is chained (`port.m().then(cb)`) and the call it is
      // nested inside share a start offset — both begin at `port` — so a
      // start-only anchor made the later lookup resolve both candidates to the
      // outer chain and judge only `then`, leaving the capability call itself
      // unjudged and recorded twice. The end offset distinguishes them.
      callCandidates.push({
        line: lineOf(node),
        position: node.getStart(sourceFile),
        end: node.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { references, nonLiteralDynamic, browserGlobalCandidates, callCandidates };
}

// 冻结实际 loader 模块的 tokens；注释和空行不影响批准，URL 或接线变化会失效。
export function sourceFingerprint(fileName, sourceText) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sourceText);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) tokens.push([kind, scanner.getTokenText()]);
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

/**
 * Records every ambient-browser occurrence the later program pass has to judge.
 * Three shapes produce a candidate:
 *
 *   * a **base object** identifier (`window`, `globalThis`, `self`,
 *     `document`, `localStorage`, `sessionStorage`) wherever it is read as a
 *     value, including the base of a member expression (`window.document.title`
 *     records `window`); local declarations and property names are excluded
 *     here and the ambient-vs-local judgement is left to the pass that consults
 *     the TypeScript symbol's source file;
 *   * a **restricted member** named as the property of an access
 *     (`window.localStorage`, `g.localStorage`, `globalThis.window.localStorage`),
 *     as the literal key of an element access (`window["localStorage"]`) or as
 *     the binding of an object pattern (`const { localStorage } = window`).
 *     These are anchored on the *naming* node, which for an element access is a
 *     string literal, so this collector is not identifier-only.
 *
 * `access` says which of the two the pass must resolve: a member's symbol is
 * reached through the object it is read off (its own identifier is a property
 * name or a fresh local binding), a base object's through the identifier
 * itself.
 */
function collectAmbientCandidate(node, out, lineOf) {
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    isMemberKeyLiteral(node.argumentExpression) &&
    RESTRICTED_AMBIENT_MEMBERS.has(node.argumentExpression.text)
  ) {
    out.push({
      name: node.argumentExpression.text,
      line: lineOf(node),
      position: node.argumentExpression.getStart(),
      access: "member",
    });
    return;
  }
  if (!ts.isIdentifier(node)) return;
  if (restrictedMemberKeyPosition(node)) {
    out.push({ name: node.text, line: lineOf(node), position: node.getStart(), access: "member" });
    return;
  }
  if (!BROWSER_GLOBAL_CANDIDATES.has(node.text)) return;
  if (isDeclarationOrPropertyName(node)) return;
  out.push({ name: node.text, line: lineOf(node), position: node.getStart(), access: "base" });
}

/**
 * True when the identifier names a restricted member as the **source key** of an
 * access, rather than reading a value:
 *
 *   * the property of a property access (`window.localStorage`);
 *   * the source key of an object pattern element (`{ localStorage }`,
 *     `{ localStorage: ls }`, and the same shapes nested inside another pattern);
 *   * the source key of an assignment pattern's element
 *     (`({ localStorage: s } = window)`).
 *
 * Source key, not local name: `const { name: localStorage } = window` reads
 * `window.name` and only *binds* it to a local called `localStorage`, so the
 * local name alone never makes an access restricted. The identifier's own symbol
 * is a property name or a local binding in every one of these shapes, which is
 * why the member resolution cannot start from it.
 */
function restrictedMemberKeyPosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node)
    return RESTRICTED_AMBIENT_MEMBERS.has(node.text);
  if (!isPatternElement(parent)) return false;
  const key = sourceKeyOf(parent);
  if (!key || key.node !== node || !RESTRICTED_AMBIENT_MEMBERS.has(node.text)) return false;
  // An object *literal* names its own properties; only a pattern that reads from
  // an object is an access. `({ localStorage: s } = window)` is a pattern,
  // `{ localStorage: s }` on its own is not.
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent))
    return isAssignmentPatternKey(node);
  return true;
}

/** A node that names a property inside an object pattern or assignment pattern. */
function isPatternElement(node) {
  return (
    ts.isBindingElement(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node)
  );
}

/** A string-like key: `x`, `"x"` or `` `x` ``. */
function keyOf(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name)) return { text: name.text, node: name };
  if (isMemberKeyLiteral(name)) return { text: name.text, node: name };
  return undefined;
}

/**
 * The **source** key of a pattern element — what the pattern reads off the
 * object, which is the property name when the element renames its binding
 * (`{ name: localStorage }` reads `name`) and the shorthand name otherwise.
 */
function sourceKeyOf(element) {
  if (ts.isBindingElement(element))
    return element.propertyName ? keyOf(element.propertyName) : keyOf(element.name);
  return keyOf(element.name);
}

/**
 * True when the enclosing object literal is the target of an assignment
 * (`({ localStorage: s } = window)`), so its elements read properties instead of
 * building an object.
 */
function isAssignmentPatternKey(node) {
  let current = node;
  while (current.parent && (isPatternElement(current.parent) || ts.isObjectLiteralExpression(current.parent)))
    current = current.parent;
  let outer = current.parent;
  if (outer && ts.isParenthesizedExpression(outer)) outer = outer.parent;
  return Boolean(
    outer &&
      ts.isBinaryExpression(outer) &&
      outer.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      outer.left === current,
  );
}

/**
 * The property path a pattern element reads and the expression it reads from:
 * `{ window: { localStorage } } = globalThis` is `["window", "localStorage"]`
 * read from `globalThis`. Returns `undefined` for a shape that is not a
 * destructuring of some expression, so an element can never be judged against a
 * path the checker cannot follow.
 */
function destructuredMemberPath(keyNode) {
  const keys = [];
  let element = keyNode.parent;
  while (element && isPatternElement(element)) {
    const key = sourceKeyOf(element);
    if (!key) return undefined;
    keys.unshift(key.text);
    const pattern = element.parent;
    if (!pattern) return undefined;
    const outer = pattern.parent;
    if (!outer) return undefined;
    if (ts.isVariableDeclaration(outer))
      return outer.initializer ? { keys, source: outer.initializer } : undefined;
    if (ts.isBinaryExpression(outer) && outer.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return { keys, source: outer.right };
    if (ts.isParenthesizedExpression(outer)) {
      const assignment = outer.parent;
      if (assignment && ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return { keys, source: assignment.right };
      return undefined;
    }
    if (!isPatternElement(outer)) return undefined;
    element = outer;
  }
  return undefined;
}

/** A key literal: `"localStorage"` or the no-substitution template `` `localStorage` ``. */
function isMemberKeyLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isDeclarationOrPropertyName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    return true;
  return false;
}

/**
 * Browser-only host modules. A layer other than the React presentation layer
 * (bindings) or a composition root must not import these. DOM globals are held
 * out by the TypeScript `lib` split (`tsconfig.client.json` includes DOM,
 * `tsconfig.server.json` does not); this rule covers the React import edge that
 * the lib split cannot see.
 */
export const BROWSER_ONLY_MODULES_RE = /^(?:react|react-dom)(?:\/|$)/u;

/**
 * The same modules as they appear in a **resolved** path. `target` is an
 * absolute file (`…/node_modules/react/index.d.ts`), so the package has to be
 * matched inside a `node_modules` segment: the hoisted layout and pnpm's
 * `…/.pnpm/react@18/node_modules/react/…` both end with one. A path alias that
 * resolves to React is a browser-only dependency even though the authored
 * specifier names nothing of the sort, and this is the only place that can see
 * it.
 *
 * The declaration package counts here for the same reason the runtime one does:
 * an alias that resolves into `@types/react` reached a browser-only module from
 * a layer that may not have one, and a type-only edge is still source coupling
 * (E16). The specifier pattern below stays narrower because nobody authors
 * `import … from "@types/react"`.
 */
const BROWSER_ONLY_TARGET_RE = /\/node_modules\/(?:@types\/)?(?:react|react-dom)\//u;

/** Whether a host import names a browser-only module, by specifier or by target. */
function isBrowserOnlyHostImport(entry) {
  if (BROWSER_ONLY_MODULES_RE.test(entry.specifier)) return true;
  if (typeof entry.target !== "string") return false;
  return BROWSER_ONLY_TARGET_RE.test(entry.target.replaceAll("\\", "/"));
}

const BROWSER_HOST_LAYERS = new Set(["root", "bindings"]);

function isConfiguredPathAlias(specifier, options) {
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0) return specifier === pattern;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length;
  });
}

function isSourceFile(absolutePath) {
  return SOURCE_SUFFIXES.some((suffix) => absolutePath.endsWith(suffix));
}

function walkSourceFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (isSourceFile(full)) out.push(full);
  }
  return out;
}

/**
 * Builds the resolved, intra-package source import graph.
 *
 * Module specifiers are resolved with the repository's real TypeScript
 * resolver (`ts.resolveModuleName`) using the supplied compiler options, so the
 * result matches what the compiler actually links — including `.js` specifiers
 * that map to `.ts` sources and workspace-path aliases. Only edges whose target
 * is another source file inside `sourceDirectory` are edges; workspace-package
 * and Node builtins are outside this package's boundary.
 *
 * `references` counts every relative reference that resolves to a file inside
 * `sourceDirectory` (module edges plus resource imports such as `.json`), which
 * is the occurrence count the plan's baseline records. `edges` holds only the
 * source-to-source edges the direction matrix is evaluated over.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {import("typescript").CompilerOptions} [options.compilerOptions]
 * @param {(relativePath: string) => import("typescript").CompilerOptions} [options.compilerOptionsFor]
 * @param {string} [options.sourceDirectory]
 * @param {string[]} [options.files] absolute file list (defaults to a walk)
 * @returns {{sourceDirectory: string, files: string[], references: Array<object>, edges: Array<object>, unresolved: Array<object>, nonLiteralDynamic: Array<object>}}
 */
export function buildDependencyGraph(options) {
  const {
    repositoryRoot,
    compilerOptions,
    compilerOptionsFor,
    sourceDirectory = WEBUI_SOURCE_DIRECTORY,
    files,
  } = options;
  if (!compilerOptions && !compilerOptionsFor)
    throw new Error(
      "buildDependencyGraph requires compilerOptions or compilerOptionsFor",
    );
  const optionsFor =
    compilerOptionsFor ?? (() => compilerOptions);
  const sourceRoot = path.join(repositoryRoot, sourceDirectory);
  const sourceFiles = files ? [...files] : walkSourceFiles(sourceRoot);
  const references = [];
  const edges = [];
  const unresolved = [];
  const nonLiteralDynamic = [];
  const hostImports = [];
  // Text-only candidates; the ambient-or-local judgement is resolved once the
  // TypeScript program is built, in `resolveAmbientBrowserGlobals`.
  const browserGlobalCandidates = [];
  // File-anchored receiver calls — methods invoked through a typed expression
  // (`transport.sendMessage(...)`, `store.createSessionWriter(...)`). Resolved
  // by the same program-driven pass; the rule consults the *declared* type of
  // the receiver to decide whether the call is a writer-creation or RPC action.
  const callCandidates = [];

  for (const absoluteFile of sourceFiles) {
    const from = normaliseSourcePath(repositoryRoot, absoluteFile);
    if (from === null) continue;
    const text = readFileSync(absoluteFile, "utf8");
    const {
      references: fileReferences,
      nonLiteralDynamic: nonLiteral,
      browserGlobalCandidates: globalCandidates,
      callCandidates: calls,
    } = collectModuleReferences(absoluteFile, text);
    for (const entry of globalCandidates) {
      browserGlobalCandidates.push({ file: from, absoluteFile, ...entry });
    }
    for (const entry of calls) {
      callCandidates.push({ file: from, absoluteFile, ...entry });
    }
    for (const entry of nonLiteral)
      nonLiteralDynamic.push({ file: from, ...entry, sourceFingerprint: sourceFingerprint(absoluteFile, text) });
    for (const reference of fileReferences) {
      const compilerOptions = optionsFor(from);
      const resolved = ts.resolveModuleName(
        reference.specifier,
        absoluteFile,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      const target = resolved?.resolvedFileName;
      if (!target && (reference.specifier.startsWith(".") || isConfiguredPathAlias(reference.specifier, compilerOptions))) {
        unresolved.push({
          file: from,
          specifier: reference.specifier,
          line: reference.line,
          kind: reference.kind,
        });
        continue;
      }
      if (!target) {
        hostImports.push({ from, specifier: reference.specifier, line: reference.line, kind: reference.kind });
        continue;
      }
      const to = normaliseSourcePath(repositoryRoot, target);
      if (to === null) {
        // Resolved package imports are still host dependencies. Resolution is
        // useful for following source aliases, but must not make a React or
        // Node capability disappear from the host-import rules.
        const repositoryRelative = path.relative(repositoryRoot, target).replaceAll("\\", "/");
        hostImports.push({ from, specifier: reference.specifier, line: reference.line, kind: reference.kind, target,
          ...(repositoryRelative.startsWith("packages/") ? { workspacePath: repositoryRelative } : {}),
        });
        continue;
      }
      references.push({
        from,
        to,
        line: reference.line,
        kind: reference.kind,
        specifier: reference.specifier,
      });
      if (!isSourceFile(target)) continue; // resource import (e.g. .json), not a module edge
      edges.push({
        from,
        to,
        line: reference.line,
        kind: reference.kind,
        specifier: reference.specifier,
      });
    }
  }

  const { browserGlobalUses, callSites } = resolveAmbientFacts(
    sourceFiles,
    repositoryRoot,
    optionsFor,
    browserGlobalCandidates,
    callCandidates,
  );

  return {
    sourceDirectory,
    files: sourceFiles
      .map((file) => normaliseSourcePath(repositoryRoot, file))
      .filter((value) => value !== null),
    references,
    edges,
    unresolved,
    nonLiteralDynamic,
    hostImports,
    browserGlobalUses,
    callSites,
  };
}

/**
 * The symbol of the ambient member a restricted-member candidate names,
 * resolved through the object it is read off rather than through the identifier
 * itself.
 *
 * The identifier in `window.localStorage` is a property name; in
 * `const { localStorage } = window` it is a fresh local binding. Neither
 * resolves to the `lib.dom.d.ts` declaration of the member on its own, which is
 * why the previous identifier-only pass could not see these accesses at all.
 * Asking about the *receiver's* type property also covers the two shapes a
 * special case would otherwise need: an alias (`const g = window; g.localStorage`)
 * and a chain (`globalThis.window.localStorage`) both flow the `Window` type
 * through, and a member read off a locally typed object resolves to a local
 * declaration, so it is dropped by the caller's lib check.
 */
function ambientMemberSymbol(node, checker) {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node)
    return propertyOf(parent.expression, node.text, checker);
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
    return propertyOf(parent.expression, node.text, checker);
  if (isPatternElement(parent) && sourceKeyOf(parent)?.node === node) {
    const path = destructuredMemberPath(node);
    if (!path) return undefined;
    return propertyAlongPath(path, checker);
  }
  return undefined;
}

/**
 * The property `path.keys` names, starting from the type of `path.source`. Each
 * step is a `getPropertyOfType` on the previous step's type, so a nested pattern
 * (`{ window: { localStorage } } = globalThis`) resolves through `window` to the
 * `localStorage` declared in `lib.dom.d.ts` rather than stopping at the outer
 * key. The returned symbol is the member itself, which is what the caller's lib
 * check needs.
 */
function propertyAlongPath(path, checker) {
  let symbol = checker.getPropertyOfType(
    checker.getTypeAtLocation(path.source),
    path.keys[0],
  );
  for (const key of path.keys.slice(1)) {
    if (!symbol) return undefined;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return undefined;
    symbol = checker.getPropertyOfType(
      checker.getTypeOfSymbolAtLocation(symbol, declaration),
      key,
    );
  }
  return symbol ?? undefined;
}

/** The property `name` of `expression`'s declared type, if it has one. */
function propertyOf(expression, name, checker) {
  return checker.getPropertyOfType(checker.getTypeAtLocation(expression), name) ?? undefined;
}

/**
 * The capability method a call invokes, resolved to the *declaration* rather
 * than to whatever the caller happens to hold:
 *
 *   * `port.m(...)` — the property-access name;
 *   * `port["m"](...)` — the element-access key;
 *   * `const { m } = port; m(...)` and `const f = port.m; f(...)` — the binding's
 *     source key or the variable's initializer, resolved through the pattern's
 *     source expression.
 *
 * Resolving the method symbol is what makes an alias work: a
 * `Pick<SessionPort, "deleteSession">` holder has the same property symbol as
 * `SessionPort`, so the declaration still names the interface the method belongs
 * to however the caller reached it. Identifier callees that name no capability
 * member (local functions, imports) resolve to no member and are skipped.
 */
function invokedMemberOf(callee, checker) {
  if (ts.isPropertyAccessExpression(callee)) {
    return {
      name: callee.name.text,
      symbol: checker.getSymbolAtLocation(callee.name),
      receiver: callee.expression,
    };
  }
  if (
    ts.isElementAccessExpression(callee) &&
    callee.argumentExpression &&
    isMemberKeyLiteral(callee.argumentExpression)
  ) {
    const name = callee.argumentExpression.text;
    return {
      name,
      symbol: propertyOf(callee.expression, name, checker),
      receiver: callee.expression,
    };
  }
  if (ts.isIdentifier(callee)) return boundMemberOf(callee, checker);
  return undefined;
}

/**
 * Resolves the capability member a bare identifier call invokes. It has to be a
 * member the caller took out of a capability object — by destructuring
 * (`const { deleteSession } = port`) or by assignment into a variable
 * (`const drop = port.deleteSession`). Anything else (a local function, an
 * import) has no capability member behind it, and no receiver to name.
 */
function boundMemberOf(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;
  if (isPatternElement(declaration)) {
    const key = sourceKeyOf(declaration);
    const path = key ? destructuredMemberPath(key.node) : undefined;
    if (path) {
      const member = propertyAlongPath(path, checker);
      if (!member) return undefined;
      return { name: path.keys[path.keys.length - 1], symbol: member, receiver: path.source };
    }
    // Component parameters can destructure a capability directly, e.g.
    // `function View({ sendMessage }: WebuiTransport)`. There is no source
    // expression to walk, so resolve the binding's function type back to the
    // property signature that declared it.
    const callSignature = checker
      .getNonNullableType(checker.getTypeAtLocation(identifier))
      .getCallSignatures()[0];
    const functionType = callSignature?.declaration;
    const property = functionType && ts.isFunctionTypeNode(functionType) ? functionType.parent : undefined;
    if (property && ts.isPropertySignature(property) && property.name) {
      const member = checker.getSymbolAtLocation(property.name);
      if (member) return { name: property.name.getText(), symbol: member, receiver: undefined };
    }
    const bindingPattern = declaration.parent;
    const parameter = bindingPattern.parent;
    const propertyName = declaration.propertyName ?? declaration.name;
    if (ts.isParameter(parameter) && ts.isIdentifier(propertyName)) {
      const parameterType = checker.getTypeAtLocation(parameter);
      const member = checker.getPropertyOfType(parameterType, propertyName.text);
      if (member) return { name: propertyName.text, symbol: member, receiver: undefined };
    }
    return undefined;
  }
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  const initializer = declaration.initializer;
  if (ts.isPropertyAccessExpression(initializer)) {
    return {
      name: initializer.name.text,
      symbol: checker.getSymbolAtLocation(initializer.name),
      receiver: initializer.expression,
    };
  }
  if (
    ts.isElementAccessExpression(initializer) &&
    initializer.argumentExpression &&
    isMemberKeyLiteral(initializer.argumentExpression)
  ) {
    const name = initializer.argumentExpression.text;
    return { name, symbol: propertyOf(initializer.expression, name, checker), receiver: initializer.expression };
  }
  return undefined;
}

/**
 * The name of the interface or class a member was declared in. Type aliases such
 * as `Pick<T, K>` resolve their properties to the original declaration, so this
 * names the capability interface even when the caller holds an alias.
 */
function declaringInterfaceName(declaration) {
  const parent = declaration?.parent;
  if (!parent) return "";
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) return parent.name?.text ?? "";
  return "";
}

/**
 * Resolves text-only candidates against the TypeScript program. Two distinct
 * results come out of one program build:
 *
 *  * `browserGlobalUses` keeps only the candidates whose symbol's *declaration*
 *    lives inside a TypeScript lib `*.d.ts` (`lib.dom.d.ts`, `lib.es5.d.ts`).
 *    Local parameters and member-access names never produce such a
 *    declaration, so they are filtered out by construction.
 *  * `callSites` records the calls whose receiver's declared type is one of
 *    the writer-factory / transport-RPC interfaces the plan lists (§7.5,
 *    §7.7). Each entry keeps the method name, the receiver's declared
 *    interface name, and the source file of the declaration so a stale-rename
 *    or an accidentally-shared interface surfaces immediately.
 */
function resolveAmbientFacts(sourceFiles, repositoryRoot, optionsFor, globalCandidates, callCandidates) {
  if (sourceFiles.length === 0) {
    return { browserGlobalUses: [], callSites: [] };
  }
  const groups = new Map();
  const globalByFile = new Map();
  for (const entry of globalCandidates) {
    if (!globalByFile.has(entry.absoluteFile)) globalByFile.set(entry.absoluteFile, []);
    globalByFile.get(entry.absoluteFile).push(entry);
  }
  const callsByFile = new Map();
  for (const entry of callCandidates) {
    if (!callsByFile.has(entry.absoluteFile)) callsByFile.set(entry.absoluteFile, []);
    callsByFile.get(entry.absoluteFile).push(entry);
  }
  for (const absoluteFile of sourceFiles) {
    const relative = normaliseSourcePath(repositoryRoot, absoluteFile) ?? absoluteFile.replaceAll("\\", "/");
    const compilerOptions = optionsFor(relative);
    const signature = JSON.stringify({
      configFilePath: compilerOptions.configFilePath,
      module: compilerOptions.module,
      moduleResolution: compilerOptions.moduleResolution,
      target: compilerOptions.target,
      paths: compilerOptions.paths,
      baseUrl: compilerOptions.baseUrl,
      types: compilerOptions.types,
    });
    if (!groups.has(signature)) groups.set(signature, { options: compilerOptions, files: [] });
    groups.get(signature).files.push(absoluteFile);
  }

  const browserGlobalUses = [];
  const callSites = [];

  for (const { options, files: rootNames } of groups.values()) {
    const program = ts.createProgram({
      rootNames,
      options: { ...options, noEmit: true, skipLibCheck: true },
    });
    const checker = program.getTypeChecker();
    for (const absoluteFile of rootNames) {
      const sourceFile = program.getSourceFile(absoluteFile);
      if (!sourceFile) throw new Error(`Dependency analysis did not load ${absoluteFile}`);
      const relative = normaliseSourcePath(repositoryRoot, absoluteFile) ?? absoluteFile.replaceAll("\\", "/");
      const findNodeAt = (position) => {
        let match;
        const visit = (node) => {
          if (match) return;
          // A restricted member can be named by a string literal
          // (`window["localStorage"]`) or a no-substitution template
          // (`` window[`localStorage`] ``), so the anchor is not always an
          // identifier.
          if (
            node.getStart(sourceFile) === position &&
            (ts.isIdentifier(node) || isMemberKeyLiteral(node))
          ) {
            match = node;
            return;
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);
        return match;
      };
      const isLibDeclaration = (symbol) => {
        if (!symbol) return false;
        const declarations = symbol.declarations ?? [];
        // `globalThis` is synthesised inside the TypeScript checker rather
        // than declared in any `lib.*.d.ts`. A local user declaration (very
        // rare) shadows it; otherwise the access is ambient.
        if (symbol.name === "globalThis") {
          return !declarations.some((decl) => !decl.getSourceFile().isDeclarationFile);
        }
        return declarations.some((declaration) => {
          const fileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
          return declaration.getSourceFile().isDeclarationFile
            && /\/typescript\/lib\/lib\.(?:dom|es5|webworker|scripthost|es2020|esnext(?:\.full)?)\.d\.ts$/u.test(fileName);
        });
      };
      for (const candidate of globalByFile.get(absoluteFile) ?? []) {
        const node = findNodeAt(candidate.position);
        if (!node) continue;
        // A base object is resolved through the identifier's own symbol; a
        // restricted member through the object it is read off, because its own
        // identifier is a property name or a fresh local binding whose
        // declaration is never the `lib.dom.d.ts` one.
        const symbol =
          candidate.access === "member"
            ? ambientMemberSymbol(node, checker)
            : checker.getSymbolAtLocation(node);
        if (isLibDeclaration(symbol)) {
          browserGlobalUses.push({ file: relative, name: candidate.name, line: candidate.line });
        }
      }
      for (const candidate of callsByFile.get(absoluteFile) ?? []) {
        // The candidate.position recorded here is the *call expression* start;
        // recurse one step to recover the property-access expression so we can
        // ask the checker about the receiver's declared type. Without this
        // indirection the receiver and method names cannot be resolved.
        const findCallExpression = () => {
          let match;
          const visit = (node) => {
            if (match) return;
            // The span, not the start offset alone: a chained call
            // (`port.m().then(cb)`) and the capability call nested inside it
            // begin at the same character, so a start-only match resolved both
            // candidates to the outer chain. Matching the end offset as well
            // recovers exactly the node the collector saw, however deeply it is
            // nested in a chain, an `await`, an optional call or an assignment.
            if (
              node.getStart(sourceFile) === candidate.position &&
              node.getEnd() === candidate.end &&
              ts.isCallExpression(node)
            ) {
              match = node;
              return;
            }
            ts.forEachChild(node, visit);
          };
          ts.forEachChild(sourceFile, visit);
          return match;
        };
        const call = findCallExpression();
        if (!call) continue;
        // 用声明身份识别直接调用与 import 别名，避免工厂绕开方法规则。
        let direct = checker.getSymbolAtLocation(call.expression);
        if (direct?.flags & ts.SymbolFlags.Alias) direct = checker.getAliasedSymbol(direct);
        const directDeclaration = direct?.valueDeclaration ?? direct?.declarations?.[0];
        const directType = directDeclaration ? checker.getTypeOfSymbolAtLocation(direct, directDeclaration) : undefined;
        const ownsLifetime = directType?.getCallSignatures().some((signature) => {
          const returned = checker.getReturnTypeOfSignature(signature);
          return /(?:Owner|Coordinator|Store|Application)$/u.test(returned.aliasSymbol?.name ?? returned.getSymbol()?.name ?? "") || returned.getProperties().some((property) => property.name === "dispose");
        });
        if (directDeclaration && (ts.isFunctionDeclaration(directDeclaration) || ts.isVariableDeclaration(directDeclaration)) && (/^(?:create.*(?:Owner|Coordinator|Application|Store|Writer|Workflow)|register.*(?:Writer|Reconciler|Handler))$/u.test(direct.name) || ownsLifetime) && /\/client\/(?:features\/[^/]+\/)?application\//u.test(directDeclaration.getSourceFile().fileName.replaceAll("\\", "/"))) {
          callSites.push({ file: relative, line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1, method: direct.name, receiver: "WebuiOwnerFactory", declaringInterface: "WebuiOwnerFactory", methodSource: directDeclaration.getSourceFile().fileName });
        }
        const invoked = invokedMemberOf(call.expression, checker);
        if (!invoked) continue;
        const methodDeclaration = invoked.symbol?.valueDeclaration ?? invoked.symbol?.declarations?.[0];
        const methodSource = methodDeclaration?.getSourceFile().fileName.replaceAll("\\", "/") ?? "";
        const receiverType = invoked.receiver
          ? checker.getTypeAtLocation(invoked.receiver)
          : undefined;
        const receiverSymbol = receiverType ? receiverType.aliasSymbol ?? receiverType.getSymbol() : undefined;
        const receiverName = receiverSymbol?.name ?? "";
        callSites.push({
          file: relative,
          line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1,
          method: invoked.name,
          receiver: receiverName,
          methodSource,
          declaringInterface: declaringInterfaceName(methodDeclaration),
        });
      }
    }
  }
  return { browserGlobalUses, callSites };
}

// ---------------------------------------------------------------------------
// Rules (mirror the boundary module's `rules` array shape)
// ---------------------------------------------------------------------------

function directionRule(graph) {
  const violations = [];
  for (const edge of graph.edges) {
    const fromLayers = classifyLayers(edge.from);
    const toLayers = classifyLayers(edge.to);
    if (isAllowedEdge(fromLayers, toLayers)) continue;
    const category = categoriseViolation(edge.from, edge.to, fromLayers, toLayers);
    violations.push({
      kind: "direction",
      from: edge.from,
      to: edge.to,
      line: edge.line,
      referenceKind: edge.kind,
      layerFrom: fromLayers,
      layerTo: toLayers,
      rule: `${fromLayers.join("|")} -> ${toLayers.join("|")}`,
      category,
      detail: `${edge.from} -> ${edge.to}: ${fromLayers.join("|")} may not import ${toLayers.join("|")}`,
    });
  }
  return { pass: violations.length === 0, violations };
}

function browserOnlyRule(graph) {
  const violations = [];
  for (const entry of graph.hostImports) {
    // Both the authored specifier and the resolved target decide: a path alias
    // (`@webui/react`) resolves to React without ever naming it, and before this
    // test consulted `target` such an import produced no host-import match at
    // all. See `isBrowserOnlyHostImport` for why the two patterns differ.
    if (!isBrowserOnlyHostImport(entry)) continue;
    const layers = classifyLayers(entry.from);
    // Allowed when *any* target layer of the importing file may use the host
    // module (e.g. a file that is both application logic and a React binding).
    if (layers.some((layer) => BROWSER_HOST_LAYERS.has(layer))) continue;
    violations.push({
      kind: "browser-only",
      file: entry.from,
      line: entry.line,
      specifier: entry.specifier,
      layerFrom: layers,
      rule: `${layers.join("|")} -> host:${entry.specifier}`,
      category: "browser-only-host-import",
      detail: `${entry.from}:${entry.line}: ${layers.join("|")} may not import browser-only module "${entry.specifier}"`,
    });
  }
  return { pass: violations.length === 0, violations };
}

function unresolvedRule(graph) {
  const violations = graph.unresolved.map((entry) => ({
    kind: "unresolved",
    file: entry.file,
    line: entry.line,
    detail: `${entry.file}:${entry.line}: unresolved intra-package import "${entry.specifier}"`,
  }));
  return { pass: violations.length === 0, violations };
}

function nonLiteralDynamicRule(graph) {
  const violations = graph.nonLiteralDynamic.map((entry) => ({
    kind: "non-literal-dynamic",
    file: entry.file,
    line: entry.line,
    expression: entry.expression,
    sourceFingerprint: entry.sourceFingerprint,
    detail: `${entry.file}:${entry.line}: non-literal dynamic import cannot be checked`,
  }));
  return { pass: violations.length === 0, violations };
}

// Per-name exemption policy for ambient browser globals. Each candidate has
// its own allowed layer set (and an optional path allowlist) so the rule can
// permit bindings that legitimately listen to `window` events without
// letting arbitrary `localStorage` access slip into a component.
//
// `window`/`self`/`globalThis` are legitimate in bindings (hashchange, online
// event reconnection), root (composition) and infrastructure (browser IO). Local
// parameters with the same name are still filtered by the AST ambient check.
// `document`/`localStorage`/`sessionStorage` are restricted to a narrow IO
// owner list — they are what the lead flagged as application/projection
// violations and what the storage injection refactor removed from bindings.
//
// These entries are consulted per *name*, and a restricted member is judged by
// its own entry wherever it is read from: allowing `window` for bindings does
// not allow `window.localStorage`, which resolves to the `localStorage` entry
// below (`RESTRICTED_AMBIENT_MEMBERS`).
const BROWSER_GLOBAL_POLICY = {
  window: { layers: new Set(["root", "bindings", "infrastructure"]) },
  // `self` is the browser's other name for the global object (and the worker
  // global), so it carries `window`'s layers: a binding may register an event
  // listener on it, and a member read off it is judged by that member's own
  // policy. It is deliberately *not* allowed for the Node layers — unlike
  // `globalThis`, which is the Node global too and stays allowed for
  // `runtime`/`runtime-port` below, `self` has no Node meaning.
  self: { layers: new Set(["root", "bindings", "infrastructure"]) },
  // `globalThis` is also the Node-side ambient object — the runtime and
  // runtime-port layers may legitimately read platform properties from it
  // (fetch, crypto, performance). The browser-specific globals below stay
  // restricted to the browser IO surface.
  globalThis: {
    layers: new Set(["root", "bindings", "infrastructure", "runtime", "runtime-port"]),
  },
  document: {
    layers: new Set(["root", "infrastructure"]),
    files: new Set(["client/platform/storage.ts"]),
  },
  localStorage: {
    layers: new Set(["root", "infrastructure"]),
    files: new Set(["client/platform/storage.ts"]),
  },
  sessionStorage: {
    layers: new Set(["root", "infrastructure"]),
    files: new Set(["client/platform/storage.ts"]),
  },
};

function isBrowserGlobalAllowed(name, file, layers) {
  const policy = BROWSER_GLOBAL_POLICY[name];
  if (!policy) return false;
  if (policy.files?.has(file)) return true;
  return layers.some((layer) => policy.layers.has(layer));
}

function forbiddenGlobalRule(graph) {
  const violations = graph.browserGlobalUses.filter((entry) => {
    const layers = classifyLayers(entry.file);
    // The candidates passed through `resolveAmbientFacts` are already filtered
    // to those whose symbols live in lib.dom.d.ts / lib.es5.d.ts. Local
    // parameters and member-access names never produce such declarations, so
    // they have been dropped before this rule runs.
    return !isBrowserGlobalAllowed(entry.name, entry.file, layers);
  }).map((entry) => ({
    kind: "browser-global",
    file: entry.file,
    line: entry.line,
    global: entry.name,
    detail: `${entry.file}:${entry.line}: ${classifyLayers(entry.file).join("|")} may not access ambient browser capability "${entry.name}" directly`,
  }));
  return { pass: violations.length === 0, violations };
}

// Layers whose modules may import Node builtins directly. Everything else —
// including `client/` packages and `shared/` contracts — must reach the host
// through the harness port / runtime adapter, never through `import "fs"`.
const NODE_BUILTIN_ALLOWED_LAYERS = new Set(["server", "runtime", "runtime-port"]);

function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith("node:")) return true;
  // Bare specifier; only a Node builtin if its name is registered as one and
  // no relative/file path is implied.
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  return BUILTIN_NODE_MODULES.has(specifier);
}

function forbiddenNodeBuiltinRule(graph) {
  const violations = graph.hostImports.filter((entry) => {
    if (!isNodeBuiltinSpecifier(entry.specifier)) return false;
    const layers = classifyLayers(entry.from);
    return layers.every((layer) => !NODE_BUILTIN_ALLOWED_LAYERS.has(layer));
  }).map((entry) => ({
    kind: "node-builtin",
    file: entry.from,
    line: entry.line,
    specifier: entry.specifier,
    detail: `${entry.from}:${entry.line}: ${classifyLayers(entry.from).join("|")} may not import Node builtin "${entry.specifier}"`,
  }));
  return { pass: violations.length === 0, violations };
}

/**
 * Capability interface names whose method invocations are reserved for
 * application / infrastructure code. A `bindings` or `view` layer
 * performing one of these calls is reaching for a writer or a business RPC
 * that belongs inside the application.
 */
const FORBIDDEN_RECEIVER_INTERFACES = new Map([
  ["WebuiSessionWriter", null],
  ["WebuiHomeSessionWriter", null],
  ["WebuiInteractionWriter", null],
  ["WebuiOwnerFactory", null],
  // [declaredReceiverName, forbiddenMethodNames]
  ["WebuiSessionStore", new Set(["createSessionWriter", "createInteractionWriter"])],
  ["WebuiTransport", null], // any method call is a business RPC; null = wildcard
  // The capability ports. The names are the ones the port re-file produced
  // (plan §9, ticket #59): `ExecutionPort` no longer exists, and the interfaces
  // it and `settings-port`/`session-port`/`interaction-port` were split into
  // each carry their own members now. A name missing here is silent lost
  // coverage — the rule falls through to the receiver-type lookup, which has no
  // entry for a slice alias — so the list has to track the declarations.
  ["SessionPort", null],
  ["TranscriptPort", null],
  ["TurnExecutionPort", null],
  ["ComposerPort", null],
  ["ShellEventPort", null],
  ["InteractionPort", null],
  ["GoalPort", null],
  ["WorkspacePort", null],
  ["TerminalPort", null],
  ["SettingsPort", null],
  ["ModelsPort", null],
  ["AccountPort", null],
  ["PluginPort", null],
]);

// Layers that must *not* invoke a writer-factory or a business-RPC method.
// The `bindings` layer is intentionally absent: it is the legitimate bridge
// that turns a writer into a command surface (plan §7.2
// `client/features/sessions/bindings/use-session-state.ts`). Lower-level layers
// (view/domain/contracts/shared/mechanisms) do not own capability
// interactions, so a writer or RPC call there is treated as a sign the
// application contract has slipped.
//
// Presentation is the one case the layer set cannot express. `classifyLayers`
// maps `client/components/` to `bindings` — the same layer as the bridge — so a
// layer-only test would exempt every component along with it.
// `CALL_PRESENTATION_PREFIX` below carries that half of the judgement by path.
const CALL_FORBIDDEN_LAYERS = new Set([
  "view",
  "domain",
  "contracts",
  "shared",
  "mechanisms",
]);

/**
 * The policy governing a call site. The invoked method's own declaration names
 * the interface it belongs to, and that name is authoritative: a type alias such
 * as `Pick<SessionPort, "deleteSession">` (or any other holder whose property
 * resolves to the same declaration) is caught however the caller reached the
 * method. The *receiver's* type name stays as a fallback for members the checker
 * cannot attribute to a named interface declaration. `undefined` from the
 * declaration path means "no opinion", never "allowed" — a `null` entry is the
 * wildcard policy, so the two must not be collapsed.
 */
function forbiddenPolicyFor(site) {
  const byDeclaration = site.declaringInterface
    ? FORBIDDEN_RECEIVER_INTERFACES.get(site.declaringInterface)
    : undefined;
  if (byDeclaration !== undefined) return byDeclaration;
  return FORBIDDEN_RECEIVER_INTERFACES.get(site.receiver);
}

function forbiddenActualCallRule(graph) {
  const violations = [];
  for (const site of graph.callSites ?? []) {
    const allowed = forbiddenPolicyFor(site);
    if (allowed === undefined) continue;
    if (allowed !== null && !allowed.has(site.method)) continue;
    const layers = classifyLayers(site.file);
    // A call site fails when the file carries *any* forbidden target layer, or
    // when it is presentation. "Any" is the judgement the previous
    // `layers.every(!has)` test made — `!every(!has)` is `some(has)` — so the
    // split-file behaviour is unchanged; no file currently classifies to more
    // than one target layer, and `classifyLayers` is the only place that could
    // grow a second one.
    const forbiddenLayer = layers.some((layer) => CALL_FORBIDDEN_LAYERS.has(layer));
    const presentation = isPresentationRole(site.file);
    if (!forbiddenLayer && !presentation) continue;
    // Name the interface the method was declared in when that is known, so the
    // message points at the capability contract rather than at whatever local
    // alias the caller held it through.
    const holder = site.declaringInterface || site.receiver || "unknown";
    violations.push({
      kind: "forbidden-call",
      file: site.file,
      line: site.line,
      target: `${holder}.${site.method}`,
      detail: `${site.file}:${site.line}: ${layers.join("|")}${presentation ? " (presentation)" : ""} may not invoke writer or business-RPC method "${holder}.${site.method}"`,
    });
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Roles that belong to a business. `duplicateOwnerRule` uses this set to group
 * files by owner; `roleRule` uses it to tell a peer business import from an
 * import of shared mechanics.
 */
export const BUSINESS_BEARING_ROLES = new Set([
  "feature-contracts",
  "feature-application",
  "feature-projection",
  "feature-bindings",
  "feature-ui",
  "feature-root",
]);

/**
 * Whether a role names a published surface rather than a private one.
 *
 * `classifyRole` records publication as a `published-` prefix on the role rather
 * than as a separate role, so the module still occupies its own role directory
 * and the layer and duplicate-owner judgements apply to it unchanged. Every
 * judgement that asks "is this private?" asks it here instead of comparing the
 * role against a set, so publication cannot be forgotten by one of them.
 *
 * @param {string} role
 * @returns {boolean}
 */
export function isPublishedRole(role) {
  return role.startsWith("published-");
}

/** The role a published module occupies, for judgements about what it is. */
export function baseRole(role) {
  return isPublishedRole(role) ? role.slice("published-".length) : role;
}

/**
 * Business roles a feature may not reach into at all.
 * `feature-contracts` is absent on purpose: a feature's contracts are its
 * published capability port and view types (plan §5.1), which is exactly what a
 * peer is allowed to consume.
 */
const FEATURE_PRIVATE_ROLES = new Set([
  "feature-application",
  "feature-projection",
  "feature-bindings",
  "feature-ui",
  "feature-root",
]);

/**
 * Destination roles a migrated source role may not import at all — no peer
 * approval can grant these, because the defect is the kind of thing being
 * reached for, not which business owns it.
 *
 * - `conversation` (plan §5.1, §5.3.3): depends on pure shared DTOs and injected
 *   IO/writer contracts, so the assembly and the concrete browser adapters are
 *   both out of reach.
 * - `feature-ui` (plan §5.3.1): invokes its own public binding/commands; a
 *   feature's presentation does not call an IO port or the assembly.
 * - `shell` (plan §5.1): composes feature public UI/bindings, so the assembly
 *   and the transport are not its to construct.
 */
const ROLE_FORBIDDEN_TARGETS = Object.freeze({
  conversation: new Set(["assembly", "platform", ...FEATURE_PRIVATE_ROLES]),
  "feature-ui": new Set(["assembly", "platform"]),
  shell: new Set(["assembly", "platform"]),
});


export function validateExceptionLedger(entries, required) {
  if (!Array.isArray(entries)) throw new Error("WebUI exception ledger must contain an entries array");
  const seen = new Set();
  for (const entry of entries) {
    for (const field of ["from", "to", ...required]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`WebUI exception requires ${field}`);
    }
    const key = pairKey(entry.from, entry.to);
    if (seen.has(key)) throw new Error(`Duplicate WebUI exception: ${key}`);
    seen.add(key);
  }
}

/**
 * The role rules: who may reach whom, judged by role rather than by directory.
 *
 * Three judgements, and they are deliberately different in kind:
 *
 * 1. **Duplicate live owner.** One business may have one authoritative home per
 *    role. A business holding the same role in both a current technical home and
 *    its target feature home is two live owners, which is what the migration is
 *    supposed to remove atomically (plan §9 W6, Spec decision 20). This one
 *    applies to every home, because it is the rule that makes the *other* two
 *    enforceable during the migration.
 * 2. **Forbidden by kind.** A migrated source role reaching a role it never
 *    owns (`ROLE_FORBIDDEN_TARGETS`, plus `client/ui/` reaching any business at
 *    all).
 * 3. **Private peer import.** A feature reaching another business's private
 *    role. Contracts need nothing; everything else has to be published first,
 *    and there is no list that can excuse it.
 *
 * All three judgements apply in every home.
 *
 * @param {object} graph
 * @returns {{ pass: boolean, violations: Array<object> }}
 */
export function roleRule(graph) {
  const violations = [];
  const files = graph.files ?? [];

  // 1. Duplicate live owner: same business, same role, both homes.
  const owners = new Map();
  for (const file of files) {
    const { role, business, home } = classifyRole(file);
    if (!business || home === "outside" || !BUSINESS_BEARING_ROLES.has(role)) continue;
    const key = `${business} ${role}`;
    if (!owners.has(key)) owners.set(key, { current: [], target: [] });
    owners.get(key)[home === "target" ? "target" : "current"].push(file);
  }
  for (const [key, homes] of owners) {
    if (homes.current.length === 0 || homes.target.length === 0) continue;
    const [business, role] = key.split(" ");
    violations.push({
      kind: "role",
      rule: "duplicate-owner",
      file: homes.target[0],
      from: homes.current[0],
      to: homes.target[0],
      detail:
        `${business}/${role} has two live owners: ${homes.current.join(", ")} and ` +
        `${homes.target.join(", ")}. Move the behaviour and delete the previous home in one change; ` +
        `two homes may not both write it.`,
    });
  }

  // 2. and 3. Role edges, judged in every home (see the comment inside the loop).
  //
  // There is no approval list any more. The baseline recorded which cross-business
  // private imports were tolerated; once every one of them had a published module
  // to read instead, the list had nothing left to excuse, and keeping it would
  // have meant a new entry could always be added to make a new private import
  // pass. A cross-business import of a private module is now simply the defect it
  // always was, and the fix is to publish the symbol.
  for (const edge of graph.edges ?? []) {
    const from = classifyRole(edge.from);
    const to = classifyRole(edge.to);
    // Judged in every home, not only in a target home: whether a role edge is
    // forbidden cannot depend on which of the two directory spellings the file
    // happens to use (gate review G-005).
    if (to.home === "outside") continue;

    const forbidden = ROLE_FORBIDDEN_TARGETS[from.role];
    // A published target is reachable from presentation: that is what a published
    // component is for. The forbidden-kind rule still applies above it.
    const uiReachesBusiness =
      baseRole(from.role) === "ui" &&
      !isPublishedRole(to.role) &&
      FEATURE_PRIVATE_ROLES.has(baseRole(to.role));
    if (forbidden?.has(to.role) || uiReachesBusiness) {
      violations.push({
        kind: "role",
        rule: "role-import",
        file: edge.from,
        line: edge.line,
        from: edge.from,
        to: edge.to,
        detail:
          `${edge.from}:${edge.line}: ${from.role} may not import ${to.role} (${edge.to}). ` +
          `Take the capability as an injected contract instead (plan §5.3).`,
      });
      continue;
    }

    // Only a feature reaching across businesses is judged here. The entry, the
    // shell, the assembly and the conversation substrate each have their own
    // composition contract, and the one for their *kind* of dependency is
    // `ROLE_FORBIDDEN_TARGETS` above.
    //
    // A published target is the way across, so it is not judged here at all: the
    // owner put it there for exactly this. The publication gate is what holds it
    // to being a real surface — a published module that forwards, re-exports or
    // reaches outward fails there rather than being excused here.
    if (
      from.business === null ||
      isPublishedRole(to.role) ||
      !FEATURE_PRIVATE_ROLES.has(baseRole(to.role)) ||
      to.business === null ||
      to.business === from.business
    )
      continue;

    violations.push({
      kind: "role",
      rule: "private-peer-import",
      file: edge.from,
      line: edge.line,
      from: edge.from,
      to: edge.to,
      detail:
        `${edge.from}:${edge.line}: imports ${to.business}'s private ${to.role} (${edge.to}). ` +
        `Consume the owner's published contract instead: a \`.public.ts\` for a derivation ` +
        `or interface, a \`.public.tsx\` for a component. There is no exception list — ` +
        `publishing the symbol is the fix, and it is the only one.`,
    });
  }

  return { pass: violations.length === 0, violations };
}

/**
 * Returns cycles as canonical rotations (smallest path first, closed back to
 * itself) so a cycle compares stably regardless of where traversal entered.
 */
export function detectCycles(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from).add(edge.to);
  }
  const colour = new Map();
  const seen = new Set();
  const cycles = [];
  const stack = [];
  const visit = (node) => {
    colour.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (colour.get(next) === 1) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        const key = canonicalCycle(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!colour.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(node, 2);
  };
  for (const node of adjacency.keys()) if (!colour.has(node)) visit(node);
  return cycles;
}

/** Canonical, rotation-stable string for a closed cycle path. */
export function canonicalCycle(cycle) {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return "";
  let best = 0;
  for (let i = 1; i < body.length; i += 1) {
    if (body[i] < body[best]) best = i;
  }
  const rotated = body.slice(best).concat(body.slice(0, best));
  return rotated.concat(rotated[0]).join(" -> ");
}

function cycleRule(graph) {
  const violations = detectCycles(graph.edges).map((cycle) => ({
    kind: "cycle",
    cycle,
    canonical: canonicalCycle(cycle),
    detail: `import cycle: ${canonicalCycle(cycle)}`,
  }));
  return { pass: violations.length === 0, violations };
}

/** All rules, in the order the CLI applies them. */
export const rules = Object.freeze([
  directionRule,
  browserOnlyRule,
  forbiddenGlobalRule,
  forbiddenNodeBuiltinRule,
  forbiddenActualCallRule,
  roleRule,
  unresolvedRule,
  nonLiteralDynamicRule,
  cycleRule,
]);

/**
 * Runs every rule against a graph and returns a flat, structured result.
 *
 * @param {object} graph
 * @returns {{
 *   pass: boolean,
 *   violations: Array<object>,
 *   direction: Array<object>,
 *   unresolved: Array<object>,
 *   nonLiteralDynamic: Array<object>,
 *   cycles: Array<object>,
 *   nodeBuiltins: Array<object>,
 *   forbiddenCalls: Array<object>,
 *   roleViolations: Array<object>,
 *   publicationViolations: Array<object>,
 * }}
 */
export function evaluateGraph(graph, options = {}) {
  const results = rules.map((rule) => rule(graph));
  const direction = results[0].violations;
  const browserOnly = results[1].violations;
  const browserGlobals = results[2].violations;
  const nodeBuiltins = results[3].violations;
  const forbiddenCalls = results[4].violations;
  const roleViolations = results[5].violations;
  const unresolved = results[6].violations;
  const nonLiteralDynamic = results[7].violations;
  const cycles = results[8].violations;
  // The publication gate judges a published module's own surface, so it runs
  // over the file list rather than the graph: the edges it rejects are edges
  // inside a module, and the graph only records edges between files.
  //
  // `options.sourceRoot` is how a caller that already knows where the package
  // lives hands that in. A fixture graph without one supplies no reader, and a
  // gate with nothing to read reports nothing rather than guessing a path and
  // reading the wrong tree.
  //
  // The foreign-access judgement needs two facts the graph already holds: which
  // business owns a path (`classifyRole`, the same classifier every other rule
  // uses) and where one of a module's specifiers resolves to. Both are derived
  // here rather than re-implemented in the gate, so the publication rule and the
  // direction rules cannot disagree about what "the same business" means.
  const resolvedByFile = new Map();
  for (const reference of graph.references ?? []) {
    let resolved = resolvedByFile.get(reference.from);
    if (!resolved) {
      resolved = new Map();
      resolvedByFile.set(reference.from, resolved);
    }
    resolved.set(reference.specifier, reference.to);
  }
  const publication = publicationRule({
    files: graph.files ?? [],
    businessOf: (relative) => classifyRole(relative).business,
    resolveSpecifier: (from, specifier) => resolvedByFile.get(from)?.get(specifier) ?? null,
    ...(options.sourceRoot
      ? {
          absolute: (relative) => path.join(options.sourceRoot, relative),
          readFile: (absolutePath) => readFileSync(absolutePath, "utf8"),
        }
      : {}),
  });
  const violations = [
    ...direction,
    ...browserOnly,
    ...browserGlobals,
    ...nodeBuiltins,
    ...forbiddenCalls,
    ...roleViolations,
    ...publication.violations,
    ...unresolved,
    ...nonLiteralDynamic,
    ...cycles,
  ];
  for (const file of graph.files ?? []) {
    if (!classifyLayers(file).includes("unknown") && classifyRole(file).role !== "unknown") continue;
    violations.push({ kind: "unclassified", file, detail: `Unclassified WebUI source: ${file}` });
  }
  for (const entry of graph.hostImports ?? []) {
    if (!entry.from.startsWith("client/") && !entry.from.startsWith("shared/")) continue;
    // 浏览器只消费可跨边界的 shared/protocol workspace 契约。
    if (!entry.workspacePath && !/^@mavis\//u.test(entry.specifier)) continue;
    if (entry.workspacePath ? /^packages\/(?:shared|protocol)\//u.test(entry.workspacePath) : /^@mavis\/(?:shared|protocol)(?:\/|$)/u.test(entry.specifier)) continue;
    violations.push({ kind: "workspace-host", file: entry.from, line: entry.line, detail: `${entry.from}:${entry.line}: browser/shared source may not depend on runtime workspace module ${entry.specifier}` });
  }
  return {
    pass: violations.length === 0,
    violations,
    direction,
    browserOnly,
    browserGlobals,
    nodeBuiltins,
    forbiddenCalls,
    roleViolations,
    publicationViolations: publication.violations,
    sharedNodeBuiltins: nodeBuiltins,
    unresolved,
    nonLiteralDynamic,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

/** Stable key for a direction violation / baseline entry. */
export function pairKey(from, to) {
  return `${from} -> ${to}`;
}

/**
 * Compares measured direction violations against the frozen baseline. A
 * violation absent from the baseline is a *new* violation; a baseline entry no
 * longer violated is *stale*. Both fail the check — a stale entry is what
 * forces each migration slice to delete the exception it removed.
 *
 * @param {Array<object>} violations direction violations
 * @param {Array<object>} entries baseline entries
 */
export function compareBaseline(violations, entries) {
  const baseline = new Map(entries.map((entry) => [pairKey(entry.from, entry.to), entry]));
  const measured = new Set();
  const newViolations = [];
  for (const violation of violations) {
    const key = pairKey(violation.from, violation.to);
    // A pair can violate once per reference; collapse to one key.
    if (measured.has(key)) continue;
    measured.add(key);
    if (!baseline.has(key)) newViolations.push(violation);
  }
  const staleEntries = entries.filter(
    (entry) => !measured.has(pairKey(entry.from, entry.to)),
  );
  return { newViolations, staleEntries };
}

/**
 * Collapses measured direction violations to one representative per file pair
 * (occurrence counts are kept), which is the granularity of the baseline.
 *
 * `occurrences` starts at 1 on the entry that represents the pair and is
 * incremented for every further violation of it. The base is set here, at the
 * single insertion point, rather than derived from whatever the entry already
 * held: `undefined + 1` is `NaN`, `NaN + 1` stays `NaN`, and `NaN` has no JSON
 * form (`JSON.stringify` writes `null`), so an entry built that way could never
 * survive a round trip and any equality-based reader saw a field that kept
 * changing. No coalescing fallback (`Number(x) || 0`, `?? 0`) is needed for the
 * same reason it would be harmful: it would turn "an entry was inserted without
 * the count" — a programming error this single insertion point rules out — into
 * a silently wrong number rather than a visible one.
 *
 * @param {Array<object>} violations
 * @returns {Array<object>}
 */
export function toBaselineShape(violations) {
  const byPair = new Map();
  for (const violation of violations) {
    const key = pairKey(violation.from, violation.to);
    const existing = byPair.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const category = CATEGORIES[violation.category] ?? CATEGORIES.unclassified;
    byPair.set(key, {
      from: violation.from,
      to: violation.to,
      layerFrom: violation.layerFrom.join("|"),
      layerTo: violation.layerTo.join("|"),
      rule: violation.rule,
      category: violation.category,
      stage: category.stage,
      reason: category.description,
      occurrences: 1,
    });
  }
  return [...byPair.values()].sort((a, b) =>
    pairKey(a.from, a.to) < pairKey(b.from, b.to) ? -1 : 1,
  );
}
