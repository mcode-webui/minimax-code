<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/wordmark-light.svg">
    <img src="docs/assets/wordmark-light.svg" alt="MiniMax Code" width="760">
  </picture>
</p>

<h1 align="center">MiniMax Code WebUI</h1>
<p align="center">Turn a prompt into something that works. Build, review, and keep iterating in your browser—with MiniMax or your own model.</p>
<p align="center">
  <a href="#quick-start">Get started</a> ·
  <a href="packages/webui/README.md">Documentation</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>
<p align="center">
  <img src="docs/assets/source-preview.svg" alt="Source preview">
  <img src="docs/assets/node.svg" alt="Compatibility: Node.js 22.19+, 24.2+, 25, and 26">
  <a href="LICENSE-STATUS.md"><img src="docs/assets/license.svg" alt="First-party default license: MIT"></a>
</p>

Choose a project folder, describe a task, and follow the agent's work in one browser workspace. Keep the conversation, files, terminal, changes, and previews together as you iterate.

![MiniMax Code WebUI home and task composer](docs/assets/webui/home.png)

<p align="center"><a href="#quick-start">Run it locally →</a> · <a href="packages/webui/README.md">Configuration and deployment →</a></p>

**A browser interface with a local runtime.** The server runs on your computer or a machine you manage; the browser connects to that server. Model calls use your MiniMax account or configured provider and may incur charges. This repository is the WebUI fork of [MiniMax Code](https://github.com/MiniMax-AI/minimax-code), retaining its TUI, headless CLI, and ACP sources.

## Quick start

### 1. Install the WebUI

Install a supported **Node.js version: 22.19+ (22.x), 24.2+ (24.x), 25, or 26**, then run:

```bash
npm install --global @minimax-webui/minimax-code
mcode-webui
```

With **npm 12 or later**, explicitly allow the native dependency install scripts:

```bash
npm install --global @minimax-webui/minimax-code --allow-scripts=better-sqlite3,bufferutil,koffi,node-pty,utf-8-validate
```

The service listens on `http://127.0.0.1:2233/` and opens your default browser when launched in an interactive terminal. If it does not open, use the address printed in the terminal. Keep the process running while you work; press **Ctrl+C** to stop it.

Check the installed command without starting the runtime:

```bash
mcode-webui --version
mcode-webui --help
```

The WebUI has its own npm package and launcher. The upstream CLI installer installs `mcode`; use the command above to install `mcode-webui`.

### 2. Sign in or bring your own model

Open the account menu in the lower-left corner to sign in to MiniMax. An existing CLI login can be reused when both clients use the same data directory. Account models and managed services require the corresponding account access and available quota.

For your own model, open **Settings → Usage & models → Custom models**, add a provider, enter its endpoint and API key, and choose a model. Supported API formats include `openai-completions`, `openai-responses`, and `anthropic-messages`. The model settings also offer the official MiniMax API source.

Model selection lives in the composer. Available models can expose thinking controls and context-window choices:

![Model selection, thinking controls, and context-window choices](docs/assets/webui/model-controls.png)

The default data directory is `~/.minimax`, shared with the CLI. It contains account state, model configuration, and session history. Set `MINIMAX_DATA_DIR` before starting the server to use a separate directory.

### 3. Work in your own project

Click **Select folder**, choose a project on the machine running the server, and describe your task. For example:

> Find a failing test, explain the cause, fix the implementation, and run the relevant tests.

Follow responses and tool activity, review file changes, and use the workspace panels for files, diffs, terminals, and previews. Choose the permission mode in the composer to control how the agent requests approval.

When connecting from another computer, the project folder and terminal belong to the **server's machine**.

### Continue your work

Use the sidebar to reopen projects and conversations, import session bundles, queue follow-up messages, and inspect task progress. Use **Scheduled tasks** to create recurring or one-time work; keep the WebUI runtime running for scheduled execution.

### Connect from another device

The server binds to loopback by default. To make it reachable on your LAN:

**macOS / Linux / WSL**

```bash
WEBUI_HOST=0.0.0.0 WEBUI_OPEN_BROWSER=0 mcode-webui
```

**Windows (PowerShell)**

```powershell
$env:WEBUI_HOST = "0.0.0.0"
$env:WEBUI_OPEN_BROWSER = "0"
mcode-webui
```

Open the printed LAN URL, including its per-start token. When using Mini Apps remotely, the shared Mini App port must also be reachable. See [startup examples and access options](packages/webui/README.md#startup-examples).

The **Remote** page also offers MiniMax App pairing and IM connections, subject to account and service availability:

![Remote connection page in MiniMax Code WebUI](docs/assets/webui/remote-control.png)

## Uninstall

Stop the running WebUI with **Ctrl+C**, then use the same npm installation used to install it:

```bash
npm uninstall --global @minimax-webui/minimax-code
```

Uninstalling leaves the runtime data directory in place. Back up account configuration and sessions before removing data. Check `MINIMAX_DATA_DIR` and whether another CLI or WebUI installation shares the directory before deleting anything.

## What you can do

| Task | Capabilities |
| --- | --- |
| **Edit and verify code** | Ask the agent to inspect projects, edit files, run commands and tests, and present changes for review. |
| **Review work in context** | Keep files, diffs, terminal sessions, rendered documents, and previews beside the conversation. |
| **Choose your model** | Use MiniMax account models, the official MiniMax API, custom compatible providers, and supported OAuth providers. Adjust the controls each model exposes. |
| **Extend the workspace** | Install and manage plugins, Skills, MCP servers, and browser-capable Mini Apps. |
| **Use the browser** | Configure Browser Use with isolated Chromium or a paired Chrome/Edge extension; availability depends on the selected provider and setup. |
| **Keep work moving** | Reopen conversations, use subagents, queue follow-ups, and create scheduled tasks. |
| **Connect remotely** | Access a server-hosted WebUI in your browser, or use the Remote page for supported mobile and IM integrations. |

![Plugin and Skill marketplace](docs/assets/webui/plugins.png)

Plugins and Mini Apps can depend on platform capabilities, additional setup, or external accounts. Managed search, media, and connector tools require the relevant beta setting, authorization, and service access. See [known gaps and service boundaries](packages/webui/docs/known-gaps.md) for current limits.

## Build from source

You need Git, a supported Node.js version, and **pnpm 10.34.9**. On Windows, keep the checkout on a local NTFS volume outside cloud-synced folders.

```bash
git clone https://github.com/mcode-webui/minimax-code.git
cd minimax-code
git switch main
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build:webui
pnpm --filter @mavis/webui dev:server
```

Open the address printed by the server. It serves the built client on port `2233`. The first build requires network access to download dependencies and build resources.

For client hot reload, keep the runtime service running and start Vite in a second terminal:

```bash
pnpm dev:webui
```

Open `http://localhost:5173/`. See [the WebUI development guide](packages/webui/README.md#run-from-source) for port overrides and local npm package builds.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBUI_HOST` | `127.0.0.1` | Server bind address. |
| `WEBUI_SERVER_PORT` | `2233` | WebUI HTTP and WebSocket port. |
| `WEBUI_MINIAPP_PORT` | `49152` | Shared Mini App HTTP and WebSocket port. |
| `MINIMAX_DATA_DIR` | `~/.minimax` | Account, configuration, and session data. |
| `WEBUI_OPEN_BROWSER` | Open when stdout is a terminal | Set `0` to prevent automatic browser opening. |

The packaged launcher also supports `--full-access`, which disables WebUI token authentication for HTTP, WebSocket, and Mini App services. Anyone who can reach those services can use their WebUI operations. It does not change Agent tool permissions or the bind address. Omit it to retain the default token policy; see [access options](packages/webui/README.md#access-without-a-webui-token).

## Documentation and contributing

- [Install, configure, and run the WebUI](packages/webui/README.md)
- [WebUI architecture and technical documentation](packages/webui/docs/README.md)
- [Contributor guide](CONTRIBUTING.md) · [WebUI development rules](packages/webui/AGENTS.md)
- [Upstream CLI and shared runtime documentation](docs/README.md)

English is the primary documentation language. The [Chinese README](README_ZH.md) mirrors this page. See the contributor guide for contribution and review requirements.

## Feedback and contact

| Channel | Use it for |
| --- | --- |
| [WebUI GitHub Issues](https://github.com/mcode-webui/minimax-code/issues) | WebUI bug reports, feature requests, and questions. |
| [Upstream MiniMax Code](https://github.com/MiniMax-AI/minimax-code) | Upstream CLI, desktop product information, and the original project. |
| [Security policy](SECURITY.md) | Vulnerability reporting guidance. Keep exploit details and credentials out of public issues. |

For a WebUI bug, include `mcode-webui --version`, your operating system and Node.js version, the installation method, and a minimal reproduction. Remove credentials, account details, and private project content from reports.

## License

First-party code defaults to [MIT](LICENSE). Existing file-level and package-level licenses remain in place. See [third-party notices](THIRD_PARTY_NOTICES.md) and [license status](LICENSE-STATUS.md) for dependencies, assets, and `mcode-tools`.
