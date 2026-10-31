# The composer follows the bindings the settings page stores

**Status:** Accepted and implemented.
**Date:** 2026-10-26.

The settings page's **快捷键** tab was a label with no panel behind it: `shortcuts` was the one
preference entry declared `disabled: true` next to 语音 and 连接, and the composer decided what
Enter meant in code — `resolveWebuiComposerEnterAction` answered "submit" or "newline" from the
modifier flags alone. A user could not see that rule, could not change it, and a page that lists
actions it cannot bind is a page that lies.

The settings page now **lists the composer's keyboard actions, shows the key each one is bound to,
and changes the binding**. Two actions are bindable, because two actions have keyboard meaning
today:

| Action | Built-in binding |
| --- | --- |
| 发送消息 — send the message | `Enter` |
| 换行 — break the line | `Shift+Enter` |

## What a binding is

A binding is **one canonical string**: the modifiers in a fixed order, then the base key —
`Control+Shift+Enter`. The same string is what the browser stores, what the page shows and what the
composer matches against, so a binding cannot mean one thing on the page and another in the
composer. The notation, the matching, the conflict rule and the fallback to the built-in bindings
live in one module (`client/projection/common/shortcuts.ts`) that both sides read, because both sides
have to agree on what a binding is.

The string is not a keymap. It is the smallest representation that lets a stored preference and a
key press be compared without either side inventing its own vocabulary.

## Who owns the change, and who reads it

The **settings page owns the change**: it is the only surface that rebinds an action, and it hands
the result to the settings owner, which persists it under `webui-shortcuts.v1` — the same habit as
`webui-theme`, `mavis-locale` and `file_line_wrap`, and a key of its own so it cannot collide with
the language preference.

The **composer reads it when a key is pressed**, not when it renders. The settings page and the
composer are open at the same time, and a binding changed in the page has to be the binding the
next key press obeys; a value read at press time is that, and a value held in component state would
be whatever it was when the composer last rendered.

The composer therefore keeps no shortcut state of its own. What it owns is the rule: a press that
names the send binding submits, a press that names the newline binding breaks the line, and a press
that names neither is left to the browser — which is why a key the user unbound stops doing the
composer's business and starts doing the textarea's.

## What the page refuses

- **A modifier on its own.** A binding is a combination; capturing `Shift` alone would leave a
  shortcut that fires whenever the user holds a key down.
- **A combination another action already holds.** The page says which action holds it and keeps
  both bindings as they were.

## What this is not

- **Not a keybinding framework.** Two actions, one notation, one page. The voice, connection and
  personalization tabs stay disabled, and nothing here changes the server or the runtime.
- **Not a new binding for stopping a generation.** 停止生成 is a button and nothing else, and the
  page says so. `Escape` is already spoken for by the menus it closes — the mention menu, the slash
  menu, the permission menu, goal mode and plan mode all claim it — so a shortcut for it would
  fight them rather than serve the user.
- **Not the language pack.** This page's strings are hard-coded Chinese, like the rest of the
  settings page on this baseline. Where the settings page's language pack lands, these strings move
  with the others; the two changes touch the same tab table and nothing else.

## Consequences

- The composer no longer hard-codes what Enter means. `resolveWebuiComposerEnterAction` is retired:
  the rule it encoded is the default configuration, expressed as the same values the page shows.
- The built-in behaviour is unchanged. With nothing stored, `Enter` sends and `Shift+Enter` breaks
  the line, and a press that names neither binding is left to the browser — which is what the
  retired rule did with every modified Enter.
- A newline bound to a key the browser does not break the line on (`Control+J`, say) is broken by
  the composer itself, because a binding the user can set is a binding the user can rely on.
