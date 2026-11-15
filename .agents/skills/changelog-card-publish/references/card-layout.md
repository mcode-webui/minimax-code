# Changelog card layout

## Element schema

Card 1.0. `config.wide_screen_mode` gives the wide layout; the header
template is `blue`.

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "MiniMax Code WebUI 0.1.9 发布说明" },
    "template": "blue"
  },
  "elements": [
    { "tag": "img", "img_key": "img_v3_…", "alt": { "tag": "plain_text", "content": "…" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "**2026-11-15 · @minimax-webui/minimax-code@0.1.9**" } },
    { "tag": "hr" },
    { "tag": "div", "text": { "tag": "lark_md", "content": "🎨 **首页品牌字标**\n标题区换成像素动画字标，跨平台字形一致。" } },
    { "tag": "hr" },
    { "tag": "div", "text": { "tag": "lark_md", "content": "🚀 **安装 / 升级**" } },
    { "tag": "div", "text": { "tag": "plain_text", "content": "npm install --global @minimax-webui/minimax-code\nmcode-webui" } },
    { "tag": "note", "elements": [{ "tag": "plain_text", "content": "npm 12+ 需加 --allow-scripts=…" }] }
  ]
}
```

- `lark_md` renders bold, emoji, bullets and line breaks. Use it for prose.
- `plain_text` renders monospace. Use it for the install command so the
  command can be read (and copied) as a command.
- `note` is the small print line at the bottom. It is the right home for
  version requirements and npm caveats.

## Copy template

```json
[
  { "emoji": "🎨", "title": "首页品牌字标", "body": "标题区换成像素动画字标，配套品牌字体随客户端发布，跨平台字形一致。" },
  { "emoji": "📂", "title": "绝对路径文件", "body": "对话里引用工作区外的文件，现在能直接打开预览。" },
  { "emoji": "🌐", "title": "内置浏览器", "body": "启动失败会说明原因，帧流加了超时与记录，失败时不再只显示一个空面板。" },
  { "emoji": "🧩", "title": "会话侧栏", "body": "点当前会话可回到对话，操作按钮不再遮住会话名。" },
  { "emoji": "👤", "title": "用户菜单", "body": "可以直接停掉本地服务，账号行显示套餐名。" },
  { "emoji": "🔧", "title": "稳定性", "body": "Windows 路径别名、SSH 存储重试、拖拽宽度样式污染等问题一并修掉。" }
]
```

Emoji act as anchors for the eye; reuse the same set across releases so the
reader learns to skim by icon.

## Commands

Upload a screenshot and keep the key:

```bash
cd /path/to/image/directory
lark-cli api POST /open-apis/im/v1/images --as bot --file "image=screenshot.png" --data "{"image_type":"message"}"
```

Send the card:

```bash
lark-cli im +messages-send --chat-id oc_96f67e876fead7c7308dfe881f264fe3 --as bot --msg-type interactive --content "$(cat card.json)"
```

Withdraw a superseded card:

```bash
lark-cli api DELETE /open-apis/im/v1/messages/<om_xxx> --as bot
```

Read one message back:

```bash
lark-cli api GET /open-apis/im/v1/messages/<om_xxx> --as bot
```

## Errors seen in practice

| Code | Meaning | Action |
| --- | --- | --- |
| `234001` | image upload rejected: the `image_type` part was missing | pass `--data` with the image type next to `--file` |
| `cannot open file: …` | `--file` got an absolute path | run from the file's directory and pass the bare name |
| `230027` / `99991672` | the bot lacks chat/message read scopes | verify the sent message by id instead of listing the chat |
| permission error on send | the bot is not in that chat | invite the app to the group first, or use the release group |

