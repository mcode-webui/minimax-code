# WebUI Composer — Module B closure spec (roadmap 2026-10-03)

Baseline: `webui` branch HEAD `83321d0`. Scope: the four remaining Module B
(Composer 输入区) rows from the team roadmap (`mcode-webui-roadmap`), following
the same workflow the Module C closure used: spec first, TDD, browser-harness
end-to-end run, then report with evidence.

| Roadmap row | Today | Target |
|---|---|---|
| 输入历史/草稿 (codex ↑ recall; cross-session drafts) | ❌ | ✅ |
| 斜杠命令面板 (dev `/` does not open) | 🟡 | ✅ (verify or fix) |
| 文件/图片/多文件上传与预览 | ➖ | ✅ (verified) |
| 文件夹上传 / @ 引用 | ➖ | ✅ (verified) |

## B-1 输入历史/草稿

Codex parity: the composer recalls previously submitted inputs with ↑/↓, and
an unsent draft survives both session switches and a page reload.

### Behavior

1. **Recording.** Every committed composer submission — `submit-turn` (send or
   queue), `submit-goal`, and `run-command` — records the submitted text in a
   per-session input history. Mode activations (`/goal`, `/plan` bare) record
   nothing. Recording happens at commit time (after intent resolution), not on
   transport success: a refused send must not silently eat the user's input
   history. The home composer (no session yet) records into the `home` slot;
   when the silent first-session creation commits, the entry moves to the
   created session's history.
2. **Normalization.** Entries are trimmed; blank entries are not recorded; an
   entry identical to the current newest entry collapses (no consecutive
   duplicates); history is capped at 100 entries per session (oldest dropped).
3. **Recall.** With the caret on the first line (selectionStart 0 or within
   the first line) and no slash popover / mention menu open:
   - ↑ steps to the previous (older) entry and replaces the draft;
   - ↓ steps forward; stepping past the newest restores the pre-browse draft
     and exits browse mode;
   - Escape during browse exits and restores the pre-browse draft;
   - any manual edit exits browse mode;
   - ↑ on a non-first-line caret keeps the caret's default behavior (the
     textarea's own intra-draft navigation must not be hijacked).
4. **Cross-session drafts.** Drafts are per session (home has its own slot).
   Switching sessions saves the outgoing draft and restores the incoming one.
   Drafts persist to `localStorage` and survive a reload. `新建任务` keeps its
   existing clearing semantics. The home → silently-created-session draft
   carry-over (existing behavior, see `SessionComposer` props comment) is
   preserved.
5. **Persistence shape.** One key, `webui.composer.state.v1`, holding
   `{ drafts: Record<sessionKey, string>, history: Record<sessionKey, string[]> }`.
   Limits: 50 draft slots / 100 history slots / 64 KiB (UTF-8 bytes, not
   characters) per stored value; the persisted blob is pruned to the newest
   slots when over budget, with the live session's slot pinned so the prune
   can never evict it. Storage failures (privacy mode, quota) degrade
   silently to in-memory state — same convention as `no-project.ts`.

### Units (pure, unit-tested before wiring)

New module `packages/webui/src/client/projection/composer-history.ts`:

- `recordWebuiInputHistory(history, input) → string[]`
- `startWebuiHistoryBrowse(history, currentDraft) → browse | undefined`
- `stepWebuiHistoryBrowse(browse, direction, history) → browse | undefined`
  (`undefined` = exit and restore the stashed draft)
- `shouldRecallWebuiHistory(value, caret) → boolean` (first-line rule)
- `loadWebuiComposerPersisted(storage?) / saveWebuiComposerPersisted(state,
  storage?, keepKeys?)` with sanitize + prune; `keepKeys` pins the live
  session's slot so an insertion-order prune can never evict it
- `migrateWebuiHomeComposerState(state, targetKey)` — home slot → created
  session key (recorded under home before the session existed)

Wiring: the shell owns the persisted store (drafts + history) keyed by
`selectedSessionId ?? "home"`; `SessionComposer` receives `history`,
`onInputSubmitted`, and the per-session `draft`/`onDraftChange` it has today.

## B-2 斜杠命令面板 (dev `/` trigger)

`slash-palette.ts`, `composer-interactions.ts` (`findWebuiSlashRange`) and the
`SessionComposer` popover wiring all read complete at `83321d0`; the roadmap's
"dev 输入 `/` 未触发" therefore needs reproduction before any fix is assumed.
Plan: a browser-harness spec types `/` into the built client's composer and
asserts the palette rows render (goal / plan / deploy-website / skills). If it
reproduces, fix the root cause (suspects: module-level `await` fallback path,
`slashSkills` initial state, popover positioning) and re-run; if it does not
reproduce on the built client, verify once on `pnpm dev` and record the dev
observation as the evidence line, closing the row as a stale report.

## B-3 上传预览 / B-4 文件夹上传与 @ 引用

Both rows are "链路验收通过, 未逐项实测". Closure = browser-harness specs driving
the built client: attach a file through the hidden input, assert the attachment
chip (name + size) and its removal; add a folder via the directory input and
assert the folder chip; type `@` and assert the mention menu offers 添加本地文件
/ 添加本地文件夹 rows and that choosing one opens the corresponding picker.
These ride the existing fixture transport (attachments are client-side state
until submit; the fixture accepts the submit envelope).

## Verification gates (all must pass before reporting)

1. `pnpm --filter @mavis/webui test` — full webui unit suite green, including
   the new `composer-history` tests.
2. `node scripts/run-vitest-suite.mjs` suites that exist for webui stay green
   (no regressions in the shared suites).
3. `pnpm build:webui` + `pnpm test:webui-browser` — existing three specs plus
   the new composer spec green.
4. One manual `pnpm dev` pass for the slash palette observation (B-2) and a
   reload/switch pass for drafts + ↑ recall.
