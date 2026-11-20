#!/usr/bin/env node
// Build and publish a Feishu (Lark) interactive changelog card.
//
// The layout is the agreed release layout and must stay stable: a header, the
// optional screenshot, a version line, one divider, one block per feature, a
// divider, the install command and a trailing note. Each feature block is its
// own element so the card reads as a list instead of one dense paragraph.
//
// Usage:
//   node send-changelog-card.mjs --bullets bullets.json --image shot.png \
//     --title "..." --version "..." --date 2026-11-15 \
//     --install "npm install --global ..." --install "mcode-webui" \
//     --note "..." [--chat-id oc_xxx] [--recall om_xxx] [--dry-run]
//
// bullets.json is an array of { "emoji": "...", "title": "...", "body": "..." }.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_CHAT_ID = "oc_96f67e876fead7c7308dfe881f264fe3";

function parseArgs(argv) {
  const options = { install: [], chatId: DEFAULT_CHAT_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--title": options.title = value; index += 1; break;
      case "--version": options.version = value; index += 1; break;
      case "--date": options.date = value; index += 1; break;
      case "--image": options.image = value; index += 1; break;
      case "--bullets": options.bullets = value; index += 1; break;
      case "--install": options.install.push(value); index += 1; break;
      case "--note": options.note = value; index += 1; break;
      case "--chat-id": options.chatId = value; index += 1; break;
      case "--recall": options.recall = value; index += 1; break;
      case "--dry-run": options.dryRun = true; break;
      case "--help": options.help = true; break;
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (options.help) return options;
  if (!options.title) throw new Error("--title is required");
  if (!options.bullets) throw new Error("--bullets is required");
  return options;
}

function lark(args, options = {}) {
  const result = spawnSync("lark-cli", args, { encoding: "utf8", ...options });
  if (result.error?.code === "ENOENT") throw new Error("lark-cli not found on PATH");
  if (result.status !== 0) throw new Error(`lark-cli ${args[0]} failed: ${result.stdout}${result.stderr}`);
  const text = result.stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`lark-cli ${args[0]} returned no JSON: ${text}`);
  const payload = JSON.parse(text.slice(start));
  if (payload.ok === false) throw new Error(`lark-cli ${args[0]} failed: ${JSON.stringify(payload.error)}`);
  return payload;
}

// The image upload endpoint needs both the file part and the image_type part.
// The CLI's --file only opens a path relative to its own working directory,
// so the upload runs with the image's directory as the working directory.
function uploadImage(imagePath) {
  const directory = path.dirname(path.resolve(imagePath));
  const payload = lark(
    ["api", "POST", "/open-apis/im/v1/images", "--as", "bot", "--file", `image=${path.basename(imagePath)}`, "--data", JSON.stringify({ image_type: "message" })],
    { cwd: directory },
  );
  const imageKey = payload.data?.image_key;
  if (!imageKey) throw new Error("image upload returned no image_key");
  return imageKey;
}

function buildElements(options, imageKey) {
  const bullets = JSON.parse(readFileSync(options.bullets, "utf8"));
  if (!Array.isArray(bullets) || bullets.length === 0) throw new Error("bullets file must hold a non-empty array");

  const elements = [];
  if (imageKey) {
    elements.push({
      tag: "img",
      img_key: imageKey,
      alt: { tag: "plain_text", content: options.imageAlt ?? options.title },
    });
  }
  if (options.version) {
    const stamp = [options.date, options.version].filter(Boolean).join(" · ");
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**${stamp}**` } });
  }
  elements.push({ tag: "hr" });
  for (const bullet of bullets) {
    const emoji = bullet.emoji ? `${bullet.emoji} ` : "";
    const title = bullet.title ? `**${bullet.title}**` : "";
    const body = bullet.body ?? "";
    const content = [title, body].filter(Boolean).join("\n");
    elements.push({ tag: "div", text: { tag: "lark_md", content: `${emoji}${content}` } });
  }
  elements.push({ tag: "hr" });
  elements.push({ tag: "div", text: { tag: "lark_md", content: "🚀 **安装 / 升级**" } });
  elements.push({ tag: "div", text: { tag: "plain_text", content: options.install.join("\n") } });
  if (options.note) {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: options.note }] });
  }
  return elements;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  const lines = [
    'Usage: send-changelog-card.mjs --title <title> --bullets <file.json> [options]',
    '  --version <text>     version line, printed with the date',
    '  --date <text>        release date, printed with the version',
    '  --image <path>       screenshot uploaded and embedded at the top',
    '  --install <line>     install command line, repeatable',
    '  --note <text>        trailing note (requirements, npm caveats)',
    '  --chat-id <oc_xxx>   target chat, defaults to the release group',
    '  --recall <om_xxx>    recall this message before sending the new one',
    '  --dry-run            print the card JSON instead of sending it',
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}
// A dry run must not leave anything behind, so it never uploads the image.
const imageKey = options.dryRun
  ? options.image
    ? "<image_key: upload the image first>"
    : undefined
  : options.image
    ? uploadImage(options.image)
    : undefined;
const card = {
  config: { wide_screen_mode: true },
  header: { title: { tag: "plain_text", content: options.title }, template: "blue" },
  elements: buildElements(options, imageKey),
};
const cardJson = JSON.stringify(card);

if (options.dryRun) {
  console.log(cardJson);
  process.exit(0);
}

// Replacing an earlier card: recall it first so the group does not keep two
// versions of the same release note.
if (options.recall) {
  lark(["api", "DELETE", `/open-apis/im/v1/messages/${options.recall}`, "--as", "bot"]);
}

const sent = lark([
  "im", "+messages-send",
  "--chat-id", options.chatId,
  "--as", "bot",
  "--msg-type", "interactive",
  "--content", cardJson,
]);
console.log(JSON.stringify({ chat_id: sent.data?.chat_id, message_id: sent.data?.message_id, create_time: sent.data?.create_time }));
