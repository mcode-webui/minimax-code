# WebUI development guide

`packages/webui` is a browser client for the process-local harness layer, plus the loopback service
that serves it and forwards to the harness in process. `docs/README.md` indexes what the system is;
this file is how to change it. Read `docs/architecture/design.md` for the design as a whole, with
`docs/architecture/layered-model.md` (the boundaries and how a request travels), `module-map.md`
(where code lives) and `boundaries.md` (the enforced import rules) as its facets. Read them before a
structural change.

## Where a change goes

A file's directory fixes its layer, and its layer fixes the imports it may have. The matrix is
`ALLOWED_EDGES` in `scripts/lib/webui-dependency-rules.mjs`; `pnpm check:webui-dependency` fails on a
forbidden edge, including `import type` edges that the build erases.

| Directory | Layer | May import |
| --- | --- | --- |
| `src/client/main.tsx`, `src/client/global.d.ts` | root (composition) | anything |
| `src/client/platform/` | infrastructure | view, domain, contracts, shared, mechanisms |
| `src/client/conversation/` | mechanisms | contracts, shared |
| `src/client/application/`, `src/client/features/*/application/` | application | view, domain, contracts, shared, mechanisms |
| `src/client/ui/`, `src/client/shell/`, `src/client/features/*/ui/`, `src/client/features/*/bindings/` | bindings | application, view, domain, contracts, shared, infrastructure, mechanisms |
| `src/client/projection/`, `src/client/features/*/projection/` | view, or domain when the file basename is in `PROJECTION_DOMAIN` | domain, contracts, shared |
| `src/client/contracts/`, `src/client/features/*/contracts/` | contracts | shared |
| `src/shared/` | shared | nothing |
| `src/server/` | server | shared, runtime-port |
| `src/runtime/` | runtime | shared, runtime-port |

Identity is always legal, so each row reads "these targets, plus the same layer". Four consequences
decide most arguments:

- **A workspace package is a peer, not a layer.** `src/client/` and `src/shared/` may import only
  `@mavis/shared` and `@mavis/protocol`; the dependency gate rejects any other workspace dependency
  from them. `src/server/` and `src/runtime/` may import `@mavis/browser-core`, which owns the
  semantics of a browser action. See `docs/browser-use/10-browser-core-integration.md`.
- **A business publishes through a module it owns.** A peer imports its `contracts/` declarations, and
  additionally any `*.public.ts` / `*.public.tsx` module — an owner-role module whose marker publishes
  **every** explicit export to eligible peers, so a later export is a public-interface change that gets
  ordinary review. Nothing else is reachable: a peer never imports another business's plain
  `application/`, `ui/` or `projection/` module. Publication carries visibility only, never authority:
  layer, browser/runtime, command-writer and lifecycle rules apply to a published module exactly as
  they do to a private one, and a binding published for a peer still must not hand it the owner's
  teardown. `docs/architecture/boundaries.md` states the rule and the gate implements it.
- **The browser never reaches the Node side.** No client layer lists `server/`, `runtime/` or
  `runtime-port`; a client module importing `runtime/port.ts` is a violation, and the fix is a client
  contract or a shared DTO.
- **Presentation does not own state.** A component submits a command to the application owner that
  holds the slice (`docs/client/ownership.md`, ADR 0016, ADR 0017) instead of writing a store.
- **A file with no role directory classifies `unknown`** and the check reports it. A business role is
  one of `contracts/`, `application/`, `projection/`, `bindings/`, `ui/` under
  `src/client/features/<business>/`; a file at the feature root is reported rather than guessed.

## Common changes

**Adding a business.** Create `src/client/features/<business>/` with only the roles it needs — a
business with no screen has no `ui/`, and empty directories are not created. Nothing registers a
business: the directories are the list, and `pnpm check:webui-dependency` proves each role has one
home. Worked example of what a business owns: `docs/client/ownership.md`.

**Adding or changing a wire operation.** Five edits, in this order:

1. `src/shared/operation-names.ts` — the canonical name and its `OperationSpec` row (request type in,
   response body type out). This is the single declaration point.
2. `src/server/operation/<domain>.ts` — the descriptor with its `validate`.
3. `src/server/operation/bind-handlers.ts` — the binding from operation to one runtime capability
   method. The declaration helper type-checks the argument tuple and the response mapper, so a wrong
   group, method or mapper fails to compile. An operation that shapes its response, degrades when a
   capability is absent, or carries a stream, terminal or command shape keeps a dedicated handler in
   `src/server/operation/handlers/` instead.
4. `src/server/operation/operations.ts` — `registerOperation(registry, entry("<name>"))`. The call
   order is the registry order and is observable on the wire: append rather than reorder.
5. `src/runtime/port.ts` — the capability member the binding targets, with its adapter body under
   `src/runtime/harness/`. A port member without a stub or a binding fails `pnpm typecheck:webui`.

`docs/runtime/harness-boundary.md` states what the port and the registry must agree on;
`test/integration/loopback-harness-path.test.ts` is the level-3 evidence for the new operation.

**Changing runtime host events.** After reviewing a producer change, run
`pnpm --filter @mavis/webui gen:host-events` to refresh the generated event-name catalogue. Route each
new catalogue fact in the production session-fact decoder or record an explicit unhandled rationale;
server typecheck checks generated-file freshness and rejects an unaccounted fact. The generator does
not edit host sources or WebUI DTOs. Details: `docs/runtime/harness-boundary.md`.

**Changing styles or bundled assets.** `src/client/styles/*.css` and `tailwind.config.cjs` are the
source; `pnpm build:webui` compiles the stylesheet that both the dev server and the built client
serve. `webui-design-tokens.test.ts` hard-asserts the semantic tokens and named component classes, so
a removed token fails the suite rather than silently restyling. Rules:
`docs/design/design-language.md`.

**Adopting a shared control.** Render the component — `WebuiButton`, `WebuiIconButton`,
`SettingsButton`, `IconButton` — never its class string. The classes are `client/ui/`'s detail; a
`.tsx` file outside that directory that names one fails a gate, and a caller that cannot use the
component records the reason at the call site and in the presentation inventory. Renaming a
stylesheet selector to a named class so the stylesheet stops addressing raw elements is a separate
job: it makes the ratchet possible, and it does not count as adopting the component.

**Adding a client UI module.** A new file under `features/*/ui/`, `shell/` or the shared `ui/` must
be classified in `scripts/lib/webui-presentation-inventory.json`: one entry with its label, whether
it is a surface or a concern, at least one of the eight families, and one of the four dispositions.
`pnpm check:webui-presentation` fails until it is there, and reports a module whose rendered
vocabulary changed since it was classified; record that with `--accept-review` after looking at the
change. ADR 0028 states the obligation and its two limits.

**Moving, adding or deleting a file.** Run `node scripts/source-inventory.mjs --write`, then
`pnpm check:source`. Review the added, removed and renamed paths before regenerating: recording a file
does not make it publishable.

## Verification

Run only the smallest gates that directly cover the changed files and behavior; name them when you
report. Do not run aggregate or full WebUI gates by default. The latest direct user instruction
overrides older repository or skill wording that asks for broader verification. Run a full gate only
when the user explicitly requests it.

**Reuse passing gate evidence.** Before starting a gate, check whether it has already passed for the
same commit, gate and platform. Run each applicable gate once for unchanged inputs; after a passing
`pnpm verify`, do not rerun its constituent gates just for reassurance. Rerun only when relevant
source, configuration or generated inputs have changed, the prior result failed or did not finish,
the needed platform is not covered, or CI requires a result for a newer commit. When only one gate
needs a rerun, run that gate instead of repeating the full suite.

| Change | Run |
| --- | --- |
| Client TypeScript | `pnpm --filter @mavis/webui typecheck:client` |
| Server/runtime TypeScript | `pnpm --filter @mavis/webui typecheck:server` |
| Changed TypeScript tests | `pnpm --filter @mavis/webui typecheck:test` |
| Client behaviour | the focused Vitest file: `pnpm exec vitest run --config vitest.oss.config.mjs <test-file>` |
| Built-client interaction | `pnpm build:webui`, then only the relevant Playwright spec |
| Imports, roles, moves | `pnpm check:webui-dependency` |
| A client UI module added, moved or reclassified | `pnpm check:webui-presentation` |
| A duration, easing or `@keyframes` added or changed | `pnpm check:webui-motion` |
| Entries, bundling, packaging | `pnpm build:webui` then `pnpm check:webui-boundary`; `pnpm test:webui-package` only when packaging is in scope |
| Anything file-level | `node scripts/source-inventory.mjs --write`, then `pnpm check:source` |
| Full aggregate verification | `pnpm verify` only when the user explicitly asks for it |

Most deterministic suites use a scripted leaf behind the harness port (evidence level 3).
The native browser scenario additionally runs the production runtime host, loopback service and
real PTYs in isolated temporary data. It proves the terminal lifecycle on the executing platform;
it does not prove external provider execution. Say which seam a claim exercises and name any
remaining boundary. `docs/verification/browser-suite.md` describes both harnesses.

There is no ESLint gate for this package (`pnpm lint` covers `packages/tui`), so typecheck and tests
carry what a linter would otherwise catch.

## Tests

- Unit suites are in `packages/webui/test/unit/`; integration suites are in
  `packages/webui/test/integration/`; Playwright browser suites are in
  `packages/webui/test/browser/`; tests for verification gates are in
  `packages/webui/test/gates/`.
- **Register every new Vitest file** in the `webui` group of `test/vitest-suites.json`. It is an
  explicit list, not a glob: an unregistered file never runs.
- **No DOM framework.** Do not add jsdom, happy-dom or `@testing-library/*`, and do not change the
  repository-root `vitest.oss.config.mjs` (`environment: "node"` is shared by every suite). Interaction
  coverage takes two shapes: extract the transitions into exported pure functions and test those, and
  assert each render branch through `renderToStaticMarkup`. What SSR cannot reach belongs in the
  untested-boundary section of your report.
- **Assert the observable outcome.** An assertion that a testid string exists survives every mutation
  and reads as manufactured coverage. When you touch a validator, pin its message text with
  `assert.deepEqual` — `webui-service.test.ts` checks error codes only, so a changed message or a
  relaxed predicate is otherwise invisible.
- **The browser suite** is `test/browser/`, one `*.spec.mjs` per surface. Import `test` from
  `./harness.mjs`, not from `@playwright/test`: the harness registers the run-id assertion, so a spec
  cannot omit it. `docs/verification/browser-suite.md` has the fixture, determinism and server
  behaviour.

## Documentation

A behaviour change updates the document that owns it; `docs/README.md` says which document owns what.
A decision someone would otherwise re-litigate becomes an ADR in `docs/adr/` under the next free
number, and a decision that is no longer in force is deleted rather than kept as "superseded" — a
retired record reads as current. A new domain term goes into `CONTEXT.md` at the repository root,
which is the glossary every client shares. Documentation and commit messages are English.

This package's documents are the WebUI half of the repository's single-context documentation;
`docs/agents/domain.md` states which document a skill should read first.

## Fork workflow

- Work on a feature branch and open a pull request; do not push to `webui` or `main` directly, and
  never to upstream. Branch names are `<type>/<short-description>` in lowercase kebab-case with
  `feat`, `fix`, `docs`, `refactor`, `test` or `chore` as the type.
- **Issues and specs are GitHub issues on `origin` = `mcode-webui/minimax-code`, and every `gh` call
  passes `--repo mcode-webui/minimax-code`.** Without it `gh` resolves this checkout to the public
  upstream `MiniMax-AI/minimax-code`, where nothing from this repository may appear: upstream
  synchronization runs by three-way merge, so anything filed or pushed there lands in the public
  projection. Conventions: `docs/agents/issue-tracker.md`; the five triage roles and their label
  strings: `docs/agents/triage-labels.md`.
- **After a merge** — yours or someone else's — realign the checkout, the roadmap baseline and what
  the team was told: `.agents/skills/merge-and-baseline/SKILL.md`. Branch from an explicit ref, never
  from wherever `HEAD` happens to be.
- **Keep work material outside the repository.** `release/public-source.json` lists every delivered
  file and the inventory scans the working tree, so scratch committed here becomes a publication
  problem.

## Guardrails

- `release/public-source.json` and the `paths` block of `tsconfig.standalone.json` are generated:
  regenerate them, never hand-edit. The repository-level rules are in the root `AGENTS.md`.
- Add a dependency only with a reason a review can check; the client ships as a browser bundle.
- Reference no internal host, generated IDL, credential or private service. `pnpm check:source`
  catches known patterns and does not replace publication review.
- Do not commit account data, sessions, logs or real user content; use a temporary data directory and
  synthetic inputs.
- `third_party/` is vendored with its own licenses and its tests are outside this distribution's
  verification.
