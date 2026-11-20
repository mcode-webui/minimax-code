---
name: changelog-card-publish
description: Publish a release changelog as a Feishu (Lark) interactive card to the release group, with the install command and an optional screenshot. Use whenever the user asks to send, publish, update or re-send a changelog, release note or version announcement card — including phrasings such as "发个 changelog 卡片", "把版本更新发到飞书群", "publish the release notes to Feishu", or "把上次那条卡片改一下再发". Use it also when a version has just been published and the commit range still needs to be turned into user-facing copy.
---

# Publish a changelog card

The card is the only artifact an end user reads. A dense paragraph renders
badly in Feishu, so the layout below is a contract with the team: keep the
element order, keep one block per feature, keep the emoji.

## The fixed target

| | |
| --- | --- |
| Group | 卡片消息验证 |
| `chat_id` | `oc_96f67e876fead7c7308dfe881f264fe3` |
| Sending app | `cli_aa66ac74e9b85cf7` (贾晓源的飞书 CLI) |

Two Feishu rules decide what is possible here. A bot can only post into chats
it is a member of, and a chat belongs to exactly one application. The
"my agent" conversation is a different application, so nothing sent from
this CLI can appear there — do not chase it, and do not promise a card landed
somewhere else.

## The layout

| # | Element | Content |
| --- | --- | --- |
| 1 | `img` | the screenshot, uploaded to an `image_key` first |
| 2 | `div` (`lark_md`) | `**2026-11-15 · @scope/package@1.2.3**` — date and version |
| 3 | `hr` | divider |
| 4..n | one `div` per feature | `emoji + bold title` on the first line, one sentence below |
| n+1 | `hr` | divider |
| n+2 | `div` (`lark_md`) | `🚀 **安装 / 升级**` |
| n+3 | `div` (`plain_text`) | the install command, monospace |
| last | `note` | requirements and caveats |

One feature per element is what makes the card readable. A single element
holding every feature collapses into a wall of text on narrow screens, which
is exactly the layout that was rejected before.

## Copy rules

- **Start from the commit the user names.** Compute the range from that commit
  to the current HEAD; do not default to the last published version.
- **Do not state the previous version number.** The card says what is new, not
  what came before.
- **At most six features, one sentence each.** Each sentence names the change
  and what a user can now see or do. Group the rest; a card is not a git log.
- **One emoji per feature**, at the start of the line, as a visual anchor.
- **The install command is part of the card**, not a reply afterwards.
- Write the copy in the language the readers use (Chinese for this product);
  keep this file itself in English.

## Workflow

1. **Pick the range.** `git merge-base <start> HEAD` first — a commit from a
   side branch is not an ancestor, and the diff against it is the real change
   set. Then `git log --oneline --no-merges <base>..HEAD` and
   `git diff --stat <base>..HEAD`.

2. **Separate user-visible from internal.** Baseline re-records, CI timeout
   budgets and test-only refactors are not release news; a new home hero, a
   new install path or a fixed crash are. Read the diff of the files that
   carry the change before writing a sentence about it.

3. **Draft the bullets** into a JSON file:

   ```json
   [
     { "emoji": "🎨", "title": "首页品牌字标", "body": "标题区换成像素动画字标，跨平台字形一致。" }
   ]
   ```

4. **Send** with the bundled script, which builds the layout, uploads the
   screenshot and sends the card:

   ```bash
   node .agents/skills/changelog-card-publish/scripts/send-changelog-card.mjs --title "MiniMax Code WebUI 0.1.9 发布说明" --version "@minimax-webui/minimax-code@0.1.9" --date "2026-11-15" --image /path/to/screenshot.png --bullets /path/to/bullets.json --install "npm install --global @minimax-webui/minimax-code" --install "mcode-webui" --note "npm 12+ 需加 --allow-scripts=… ｜ 要求 Node 22.19+ / 24.2+ / 25 / 26"
   ```

   Add `--dry-run` to print the card JSON instead of sending it, and
   `--recall <om_xxx>` to withdraw an earlier card of the same release first
   so the group does not keep two versions of the same note.

5. **Verify by message id**, not by looking at the group:

   ```bash
   lark-cli api GET /open-apis/im/v1/messages/<om_xxx> --as bot
   ```

   `msg_type` must be `interactive`, and the body must carry the title and
   the image. Feishu rewrites rich text into text runs on read, so compare
   the structure, not the prose.

## Pitfalls

- The image upload needs the file part *and* the type part together:
  `--file "image=<name>"` and `--data "{"image_type":"message"}"`. The
  `--file` flag only opens a path relative to the CLI's working directory, so
  run it from the image's directory. The bundled script already does this.
- The bot identity can send but cannot read chat history or chat details
  (`230027` / `99991672`). Verify the sent message by id; do not try to list
  the group's history to confirm.
- Card JSON with a stray shell quote fails into a malformed payload. Build the
  card in a file and pass it as one argument — that is what the script does.
- Sending a card into a chat the bot is not in fails with a permission error.
  The bot is only in the release group; invite it before sending elsewhere.

See [references/card-layout.md](references/card-layout.md) for the element
schema, the full example and the copy template.

