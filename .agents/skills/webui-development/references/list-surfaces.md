# Registry-driven lists: settings and searchable palettes

A list whose rows come from a registry, and a text box that filters it, are one seam seen twice:
`features/settings/projection/settings-view.ts` (`SETTINGS_GROUPS`, `filterSettingsTabs`) and
`features/composer/contracts/slash-command.ts` (`rankWebuiSlashPalette`). Read this before changing what the
settings column contains, hiding a section, adding a tab, or debugging a palette that "does not work".

Frames, atoms and row styling come from `packages/webui/docs/design/design-language.md` and
[guardrails.md](guardrails.md); where a new surface belongs is [business-maintenance.md](business-maintenance.md).

## One registry, five consumers

A settings tab is declared once and read five times. Know all five, or the change lands in some of them:

| Consumer | What it reads |
| --- | --- |
| `projection/settings-view.ts` | `SettingsTabKey`, the tab and group constants, `HIDDEN_SETTINGS_*`, `filterSettingsTabs` |
| `ui/SettingsModal.public.tsx` | the `ICONS` map, the sidebar composition, the `active === …` page branches |
| `ui/SettingsModal.tsx` | `SETTINGS_ICON_PATHS`, `GENERIC_SECTION_TEST_IDS` |
| Unit tests | the tab list, the group list, "is this tab gated" assertions |
| Browser specs | nav locators by `data-menu-key` |

## Hide, or remove

Default to hide. The user's standing instruction is 「隐藏即可，其他代码不用删除」: the column loses the
section, the registry keeps the entries and the pages stay mounted, so re-adding is one token. Remove only
when deletion was explicitly asked for.

**Hide** — add a constant beside the registry (`HIDDEN_SETTINGS_GROUPS: readonly SettingsTabGroupKey[]`) and
filter where the sidebar **composes groups**, not in the tabs array:
`SETTINGS_GROUPS.filter((g) => !HIDDEN.includes(g.key)).map(...)`. Filtering groups is what removes the
section *header*; filtering only tabs leaves an empty heading standing. Since the search walks the same
registry, hiding makes the box agree for free — searching the hidden name answers 「没有匹配的设置」 — and
asserting that is what catches the half-fix.

**Remove** — delete the entry and every keyed consumer: the `SettingsTabKey` member, the
`SETTINGS_ICON_PATHS` entry, the `ICONS` map entry (with its `@tabler` import when unused elsewhere), and any
`data-testid` branch keyed off the name. Then grep the key across `src/` and `test/`: a stale icon path fails
nothing, so nothing else will report it.

## Rows inside a page have a second declaration point

`GenericPage` (通用) is static JSX, not a registry: its sections are declared twice — in the JSX of
`ui/SettingsModal.public.tsx` **and** in `GENERIC_SECTION_TEST_IDS` in `ui/SettingsModal.tsx`, which the unit
file asserts as an exact array. Delete rows and their header, then update both.

A section whose every row is deleted goes with them (a `SettingsSection` with no rows renders a title over
nothing; unlike the sidebar there is no empty-group filter). The first row of a section carries no leading
`SettingsDivider`, so deleting the row above one leaves a divider hanging. And take the row's exclusive
helper with it: a local `Select`/`Button` wrapper only the deleted rows rendered becomes dead code that
nothing fails on, because `noUnusedLocals` is off.

## Specs assert the old truth

Rewrite, do not delete. "Hidden ≠ removed" in the unit file asserts the hidden list equals the expected keys
*and* that the registry still carries those tabs, so a later cleanup cannot turn a hide into a delete. A
browser case that proved "this tab is enabled where the placeholders are still disabled" loses its contrast
when the last placeholder goes — replace it with the new truth (no `[data-menu-key][disabled]`), don't drop
it. A tab that was clicked becomes an absence assertion: header count 0, item counts 0, and the same query
answering no-results — with one surviving surface in the same assertion, or three `toHaveCount(0)` lines on
a blank page pass for the wrong reason.

## A ranked list has three parts, and only one is the matcher

1. **The rank/filter function** — pure, in `contracts/` or `projection/`.
2. **The surface that feeds it the query and gates rendering** — the composer derives the query from the
   caret and maps ranked rows into the panel; the settings nav regroups the filtered tabs.
3. **The empty-query rule** — usually a whitelist beside the matcher, not part of it (the palette shows only
   goal/plan/compact/skills while the query is blank). Reading that list as evidence about ranking is a
   mistake.

A query matching nothing usually closes the popover, so "search is broken" and "nothing matched" render
identically, and a unit test of the matcher cannot say which part is wrong. Build first, then run one
throwaway spec that types each query and prints the visible row labels: `PROBE mdl []` while
`PROBE 模型 ["状态","模型"]` works means the matcher is narrow; every query empty including contiguous ones
means the surface never passes the query.

## Fix the rank, not the surface

Precedence, each strictly better, palette order preserved inside a rank: exact name → prefix → substring of
the name → substring across label, description and declared search terms → **subsequence of the names**. The
last rank is the "fuzzy" users mean; without it, `mdl` for `/model` and `crev` for `code-review` answer
nothing. Rules that keep it from becoming noise:

- **Subsequences only over identity strings** (name, displayName, label). Descriptions are prose — scattered
  hits there produce rows nobody asked for, while the substring rank still reads them deliberately.
- **Break ties by span, then by original index.** Span is the characters the greedy walk skipped; the tight
  hit is the one meant, and the index tiebreak keeps the list stable between keystrokes.
- **Lowercase both sides once, before scoring.** Do not `trim()` inside the matcher when the caller's
  empty-query gate is built on `query.trim()` — the two disagree on a lone space.
- **No pinyin or initials** unless the product already promises them; that needs a table, a dependency and a
  decision about which fields are transliterated. A declared-but-unpopulated field stays in the haystack.

Pin it with two tests: a unit test on minimal rows built in the test (one case per rank, one precedence case
where the fuzzy row sits first in the array, one proving a description is not fuzzy-searched), and one
browser case on a query no row contains literally — exactly one option, the expected row visible, a sibling
absent. The unit test passes with the wiring removed; the browser case is the only proof the panel is
connected to the matcher.

## Completing a row, not just listing it

- **Complete through the same handler Enter uses** — it already rewrites only the token under the caret,
  inserts the trailing space that closes the panel and restores the caret. A second completion path drifts
  from it on all three.
- **Gate the key, do not swallow it globally:** `event.key === "Tab" && !event.shiftKey &&
  !event.nativeEvent.isComposing`, inside the branch that runs only while a command is pending. Shift+Tab
  keeps focus traversal; an IME composition keeps Tab for its candidates.
- **Assert the result:** the draft equals the completed token including the trailing space, the panel count
  is 0, the input still has focus. A completion that leaves the caret inside the token reopens the palette;
  one that lets the default Tab fire loses the field — both pass an assertion that only checks the row
  disappeared.

## Row icons are part of the contract

One glyph per row class. A per-name icon table marks whichever names someone listed as special and leaves
every other row of the class looking different for a reason the reader cannot see — when asked why those
icons differ, the table is the defect: delete the mapping, keep the rows. Rows of another class keep their
glyph (a plugin entry in the default section is not a skill), so the test pinning a unification filters by
section or source field. Check the vocabulary before inventing a glyph
(`ls node_modules/@tabler/icons-react/dist/esm/icons | grep -i <concept>`), and pin it on the rendered svg
class (`svg.tabler-icon-puzzle`) plus where it must *not* appear.
