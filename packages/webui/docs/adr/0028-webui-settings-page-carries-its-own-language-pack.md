# The settings page carries its own language pack

**Status:** Accepted.
**Date:** 2026-10-24.

The settings page's copy lives in **two packs** — Chinese and English — inside the settings business.
The language is read from `mavis-locale`, the key the page already read and wrote, and a row in the
通用 page switches it. No new dependency, no client-wide i18n framework, and no other surface
changes.

This covers the settings page only. The conversation, the file panel, the workspace and the rest of
the client keep their own copy.

## What was already there

`client/features/settings/ui/SettingsModal.public.tsx` read `mavis-locale` into a `useState` that had
**no setter**, and wrote it back on every mount. The key existed, the read existed, and nothing a
user could do ever wrote a different value. The page's words were Chinese literals in the component
that rendered them.

The settings search made the gap visible. `filterSettingsTabs` matched a tab's **name and key**, so
a setting that lives on a row was only findable if the row's words happened to be the tab's words.
Asking the settings search for 「语言」 answered 「没有匹配的设置」 — the one question a language
switch would exist to answer.

## Why a pack in the settings business, and not a client-wide framework

- **The layer matrix already says where it goes.** A pack is a derivation — read, never written — so
  it is a **view** module. `client/features/<business>/projection/` is a view layer, and a view
  module may import another view module while a binding module may import a view module. The pack
  therefore reaches both the tab registry and the dialog without a new edge, and without the
  platform layer reaching down into a business.
- **The client-wide extraction is a different change.** The client's Chinese copy is roughly 8,600
  characters across 77 of its 109 client files. PR #33 measured this and deliberately deferred
  「多语言 (P-3)」 for exactly that reason: a full extraction is its own work, with its own cost and
  its own review. This decision does the part that is small enough to be correct — an entry point,
  a minimal pack, and a page that actually switches — and leaves the extraction to that change.
- **A framework would have been a dependency.** The pack is data and a lookup. Anything more would
  be a dependency the browser bundle carries, for two languages and one page.

## Why Chinese is the base language

The settings page was written in Chinese, and Chinese is what a reader who has the app open sees.
So Chinese is the base pack and a key the English pack does not carry **falls back to the Chinese
text** rather than to a raw key: a half-translated pack reads as Chinese instead of as a bug. The
English pack's type is the Chinese key set, so a key it is missing is a compile error, and the
unit suite asserts the same parity again for the case where the type is satisfied by a value the
pack does not really hold.

A stored value that is not a language at all resolves to Chinese rather than to English. A user
whose storage was written by a build that never had a setter has no opinion about the language, and
the page they know is the Chinese one.

## The search has to reach a row, not only a tab

A setting is found by the words **on its row** — 「语言」, 「外观」, 「文件预览自动换行」 — and a
name is not what a reader remembers about it. `filterSettingsTabs` therefore matches the row-level
copy of each tab's page as well as the tab's own name, and it searches **both packs**: a reader who
looks for 「语言」 in an English page, or for "Language" in a Chinese one, is looking for the same
setting, and a search that knew only the current language would answer 「没有匹配的设置」 to half of
its own users.

A search that matched a row also takes the reader to the page that owns it, and marks the row. A
tab match needs no help — the sidebar shows the tab and the reader clicks it — but a row match is
only half an answer without the page.

## Constraints this decision puts on later work

- **A second business that needs a language switch copies the shape; it does not import the
  settings pack.** The settings pack is the settings business's copy. The moment another business
  needs one, the shared part — the locale value, the lookup, the fallback rule — is what gets
  lifted into a client-wide module, and that lift is the extraction PR #33 deferred.
- **A page's own copy stays in its own component until it is translated.** The packs cover the
  settings page. The 浏览器, 用量与模型, 账户 and 工作树 pages keep their literals, and the search
  does not promise a row it cannot name.
- **The search matches both packs, so a language switch does not narrow the search.** Adding a
  language adds text to search, not text that hides.
- **`mavis-locale` stays the key.** A second key for the same choice would leave two answers to
  one question, and the one already written would be the one nobody reads.
