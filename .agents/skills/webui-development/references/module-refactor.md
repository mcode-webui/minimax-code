# Structural refactors

Two jobs that look alike and are not: carving one responsibility out of a module that has grown past what
one reader holds, and a whole-package cleanup whose bottom line is that animation, visuals, business logic,
interaction logic and the runtime layer do not change. Both need the same thing first — a claim about what
must stay identical, and something comparable behind it. "The tests still pass" is not that claim.

Layer and role rules: `packages/webui/docs/architecture/{module-map,boundaries,layered-model}.md`. Gates
each move triggers: [verification.md](verification.md).

## Carving a responsibility out of a client module

Prefer a responsibility over a line count: a file that is long because it renders one dense surface is not
a candidate, and a split that moves lines sideways leaves the coupling intact.

1. **Pick the owner by layer, then check what it may import.** A flow with state and effects belongs in
   `features/<business>/bindings/`, a pure derivation in `projection/`, a content view in `ui/`, a settled
   policy in `application/`. Moving code under a layer that cannot reach its dependencies fails
   `check:webui-dependency`, including `import type` edges the build erases. Reaching into a peer business's
   private `application/` module is a role violation: derive what you need off its published owner
   (`Pick<ReturnType<typeof useWebuiGoalOwner>, "isGoalEnabled" | "createGoal">`) instead of importing the
   coordinator type.
2. **Grep the test tree for source-shape assertions naming the file you are shrinking — both directions.**
   Some prohibitions assert the module still *contains* a symbol, others that it must *not*, and neither
   failure reads as a behaviour change. Point importers at the new module instead of re-exporting the
   symbol from the old one: a re-export hides where the code lives. A claim spanning both modules is
   distributed, not dropped — the half the surface still renders stays asserted against the surface, the
   half the binding owns is asserted against the binding, same strings and strength.
3. **Move the state a helper depends on with the helper.** A lookup consulting a registry another module
   populated at import time answers `undefined` for a test that imports only the projection — the same
   latent ordering bug, now in two files.
4. **Keep effect dependency identity when effects move into a hook.** Rename the value the effect read
   (`tab`) rather than narrowing it (`active = tab === "terminal"`): the dependency array decides when the
   effect re-runs, cleanup fires and a read is re-issued.
5. **Return a small interface, not the internals.** `{ hostRef, ready, hasTerminal, support, availability }`
   is a responsibility removed; a hook handing back refs, counters and latches moved code one file
   sideways. Pass the values and refs the hook reads, not the component's whole state.
6. **Delete the moved block in one pass and let the compiler name the rest.** `typecheck:client` lists every
   dangling reference more completely than pruning by eye; remove only the imports your change orphaned.
7. **Prove it by construction, then by the gates it triggers.** `typecheck:client`, `typecheck:test` once
   test imports move, the affected Vitest files, `check:webui-dependency` for the new edges. A new `ui/`
   module needs a presentation-inventory entry and makes the shrunken parent report `REVIEW REQUIRED`; any
   new file needs `node scripts/source-inventory.mjs --write` then `check:source`.

## A whole-package refactor: evidence before the first edit

```bash
LC_ALL=C LANG=C pnpm typecheck:webui
LC_ALL=C LANG=C pnpm test:webui          # record file and case counts
pnpm build:styles                        # the tokens test reads dist-webui/client/styles.css
sha256sum dist-webui/client/styles.css
```

A red suite on a fresh worktree is usually a missing build, not a code problem.

**Markup.** For every component about to move, render a props/state matrix through `renderToStaticMarkup`
into fixtures outside the repository, one file per (component, case), then re-render after the move and
diff byte for byte. Choose the matrix from the branches — empty, loading, error, disabled, expanded,
active, selected, and the states that must render nothing.

**What SSR cannot reach.** Effect ordering and cleanup, handler wiring, the session store's migration
semantics and every browser side effect (`localStorage`, clipboard, `history.replaceState`, portals) are
invisible to a snapshot. Extract each decision into an exported pure function and pin its transition table.
`application/session-store.ts` documents two behaviour contracts — a key migration does not notify
listeners, and a write follows the key currently on screen rather than the one captured at submit. Replacing
that hand-rolled store with `useSyncExternalStore` changes flush ordering, which is what those contracts are
about: a behaviour change, not a refactor.

**CSS.** Parse the compiled `dist-webui/client/styles.css` into `(selector, property) -> winning value`,
resolving the cascade, and diff the two maps: zero differences except an explicit exception list. A textual
diff flags every legitimate dedup, and a set diff cannot tell a shadowed declaration from the winning one —
common here, because these stylesheets carry two generations of the same component's rules. Rebuild before
the after-snapshot and keep `test/unit/webui-design-tokens.test.ts` green.

**Dead code.**

| Judgement | How |
| --- | --- |
| Reachable | import graph from the three `scripts/build-webui.mjs` entries |
| Test-pinned | grep the test tree for the symbol before deleting it |
| Deliberate parity placeholder | a comment saying the class must exist to match a desktop class name — leave it |
| Fork-only | `git ls-tree -r --name-only upstream/main <path>` — empty means the path is ours alone |

**Exception list.** Anything that does change a visual, business or interaction decision gets its own
entry: current value, why it is wrong, fixed value, blast radius. Admit it only when the current value can
be shown wrong by a measurable artifact — a `getComputedStyle`/`getBoundingClientRect` number, or the
desktop implementation's own rule for that element.

## Moving code in bulk

Do not run a dozen blind `patch` calls: slice anchor to anchor in one script, asserting each anchor occurs
exactly once before cutting. A "could not find a match" means the region drifted from an earlier edit —
re-read and match what is there. Rewriting TSX through a shell heredoc mangles backslash counts; check the
bytes with `sed -n 'Np' file | od -c` before theorising, since Python's `repr` doubles them.
