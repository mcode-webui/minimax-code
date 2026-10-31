# Boundaries and gates

One facet of the architecture design: [`design.md`](design.md) is the whole. This document covers the
rules that keep the four boundaries from collapsing, and the generated artifacts that depend on them.

## Dependency rules

These are ownership rules as well as import rules. Judge an edge by the role of the target module; a
cross-feature call through an approved public contract or command is not automatically a violation.

| Caller role | May depend on | Boundary |
| --- | --- | --- |
| `client/shell/` and `client/ui/` | feature public UI/bindings and shared contracts | Compose or present; do not create owners, call transport business methods or write application state. |
| Feature `ui/` | its own public bindings/contracts and explicitly approved peer public UI/commands | Present data and dispatch application commands; do not call IO ports, instantiate owners or access generic store writers. |
| Feature `application/` | its own contracts/projections, conversation public APIs, injected capabilities and approved peer contracts | Own business workflows and state; do not depend on browser globals or concrete transport. |
| `client/application/` | feature application APIs, platform adapters and shared contracts | Compose owners and bind transport capabilities to application commands. |
| `client/platform/` and `client/bindings/` | browser APIs and capability contracts | Adapt IO and React/browser effects; business decisions stay with application owners. |
| `server/` | `runtime/port.ts`, `shared/` and server modules | Validate and dispatch loopback requests without importing runtime implementations. |
| `runtime/` | `runtime/port.ts`, `shared/` and runtime modules | Implement the process-local host adapter without depending on browser or server implementation. |
| `shared/` | leaf dependencies only | Wire contracts and shared values import neither execution side. |

### Workspace packages are not layers

A workspace package is a **peer**, not one of the four layers. `@mavis/shared`, `@mavis/protocol`,
`@mavis/browser-core` and `@mavis/local-runtime-v2` are separate packages with their own boundaries,
and importing one is not an edge between two WebUI layers.

| Package | May be imported by | Why |
| --- | --- | --- |
| `@mavis/shared` | `client/`, `server/`, `runtime/`, `shared/` | it holds the wire contracts and the runtime boundary contracts |
| `@mavis/protocol` | `client/`, `server/`, `runtime/` | it holds the generated protocol |
| `@mavis/browser-core` | `runtime/`, `server/` | it owns the semantics of a browser action and reaches a browser through a `BrowserTransport` |
| `@mavis/local-runtime-v2` | `runtime/` | it is the harness host the adapter drives |
| `@mavis/oauth-core`, `@mavis/mcode-tools-host` | `runtime/` | the account and the tools host are reached through the runtime adapter |

`src/client/` and `src/shared/` may import **only** `@mavis/shared` and `@mavis/protocol`. The gate is
`scripts/lib/webui-dependency-rules.mjs`, which reports any workspace dependency from `client/` or
`shared/` that is not one of those two. The browser-core restriction is not a preference: the browser
bundle must not carry the core, because the core reaches a browser through a transport, and a
browser-side copy of the core would be a second, unreachable definition of what an action means.
This is why the restricted command vocabulary is duplicated in `src/shared/contracts/browser.ts` rather
than read from `@mavis/browser-core` — the shared layer cannot import the core, so it states the
vocabulary itself, and a test asserts the two lists cannot drift.

`packages/webui/src/server/browser-bridge/` is the one place where a `server/` module imports
`@mavis/browser-core`. That is allowed: the bridge is a Node-side surface that drives a browser, not
an inbound network endpoint.

Within a layer, feature implementation is private by default. A feature may use another feature's
public `contracts/`, or a module that feature published as its surface: a `.public.ts` for a
derivation or interface, a `.public.tsx` for a component. Everything else in another feature is
private, and there is no exception list — a cross-business edge that reaches a private module is
the defect it always was, and publishing the symbol is the fix.

A published module is held to what a published surface may contain: every explicit export is
public, no export-star, no foreign re-export, and no foreign namespace, default or dynamic access.
That way a `.public` marker cannot become an alias for the private module next to it.

### Telling business logic from presentation derivation

The question "is this business logic or presentation?" is answered by the directory the file is in,
not by reading it:

| Directory | Holds | A pure derivation here is a |
| --- | --- | --- |
| `features/<business>/application/` | The business's own state, reducers and workflows | not a derivation — this is where rules live |
| `features/<business>/projection/` | Deriving a view model from what the business already knows | `domain` if the name is in `PROJECTION_DOMAIN`, `view` otherwise |
| `features/<business>/bindings/` | React hooks that read an owner and dispatch its commands | not a derivation |
| `features/<business>/ui/` | The business's own components | not a derivation |
| `features/<business>/contracts/` | The capability port and view types other businesses may use | not a derivation |

`projection/` is the one directory where the *layer* depends on the module rather than on where it
sits, and the rule is deliberately explicit rather than inferred from the file's imports: a
`domain` derivation carries a business rule (a normalisation, a classification, a decision about
what counts as active), while a `view` derivation only reads and shapes (`model-picker-rows`,
`session-lookups`). Adding a projection means adding its basename to `PROJECTION_DOMAIN` in
`scripts/lib/webui-dependency-rules.mjs` if it carries a rule — that list is the whole decision, and
`classifyLayers` consults it for both the `features/*/projection/` and `client/projection/` spellings
so the two layouts cannot drift.

Presentation derivation outside a feature — `client/ui/`, `client/shell/` — has no business to carry a
rule for, so it is never a `domain`.

A business that decides *when* another business's state moves is handed that business's published
narrow contract, and the composition that holds the writer builds it. The interaction flow is the
worked example: it drives `WebuiInteractionPhaseIntents` (published from `features/turn/contracts/`)
and never sees Turn's stream state or the factories that need Turn's transforms.

Hard rules:

- **Never import `packages/tui`** (ADR 0003). Read it as a specification, compose the equivalent here.
- Client and server source must keep their dependency direction. `pnpm check:webui-dependency`
  enforces this against the resolved source graph, including type-only imports. The separate esbuild
  outputs are combined into one metafile input set, so `pnpm check:webui-boundary` does not check
  per-output client/server membership; it checks the combined graph's allowed inputs and required
  entries.
- **One module, one path.** When a file moves, repoint every importer (including relative `../`
  specifiers, which a naive grep misses) and delete any `export * from` shim.
- Application modules own business RPCs and writable state. Components must not call transport
  methods for business workflows or receive a generic store writer.
- Storage and DOM access live in `client/platform/` or `client/bindings/`; application and projection
  modules receive capabilities or values instead.
- No new module imports the shell, and no two modules own the same Map or state.

## Role enforcement

Roles are checked, not just layers. `classifyRole` in `scripts/lib/webui-dependency-rules.mjs` reads
the role a file owns (assembly, conversation, a feature's `application` / `projection` / `bindings` /
`ui` / `contracts`, platform, generic ui, shell, entry), the business that owns it and its home, and
reports zero violations today. It fails on:

- a business holding the same role in two homes at once — a move that left its previous copy behind;
- the conversation substrate reaching feature implementation, the assembly or `client/platform/`;
  presentation or shell reaching the assembly or the platform adapters; `client/ui/` reaching any
  business at all;
- a feature reaching another business's *private* role. A feature's `contracts/` and the modules it
  publishes (`.public.ts` / `.public.tsx`) are public and need nothing further; anything else has to
  be published first, and nothing excuses it.

`pnpm check:webui-dependency` runs this over the source, so it sees `import type` edges that the
metafile check cannot (type-only edges are erased from build output). Its exception baseline is
`scripts/lib/webui-dependency-baseline.json` and is currently empty apart from one declared
`non-literal-dynamic-import` allowance at `runtime/mcode-tools-entry.ts`, whose runtime URL targets a
generated embedded artifact with no source-tree path for the resolver.

## Build outputs and generated artifacts

| Artifact | Produced by | Checked by |
| --- | --- | --- |
| `dist-webui/` incl. `metafile.json` | `pnpm build:webui` (`scripts/build-webui.mjs`) | `pnpm check:webui-boundary` |
| `release/public-source.json` | `node scripts/source-inventory.mjs --write` | `pnpm check:source` |

`pnpm build:webui` prints its server/client input counts; a new file that does not raise them has been
written but never wired. [`../verification/gates.md`](../verification/gates.md) states what each gate proves.
