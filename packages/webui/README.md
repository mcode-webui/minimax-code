# @mavis/webui

A browser client for the process-local harness layer, plus the loopback service that serves it and
forwards to the harness in process. It is a peer client of the terminal client: it builds on
`@mavis/local-runtime-v2` directly, imports no `packages/tui` internals and does not drive the CLI
binary (ADR 0001, ADR 0003).

The package is `private: true` in the workspace and is not published under that name. The standalone
npm package is `@minimax-webui/minimax-code`, which provides the `mcode-webui` command. The preview
release workflow is described in [`docs/releasing.md`](docs/releasing.md).

## Install and start

Use a supported Node.js version: `>=22.19 <23` or `>=24.2 <27`.

```sh
npm install --global @minimax-webui/minimax-code
mcode-webui
```

With npm 12 or later, explicitly allow the native dependency install scripts:

```sh
npm install --global @minimax-webui/minimax-code \
  --allow-scripts=better-sqlite3,bufferutil,koffi,node-pty,utf-8-validate
```

To install the preview channel, use `@minimax-webui/minimax-code@preview` instead.
A flag described here must be supported by the version you install; check `mcode-webui --help` and
`mcode-webui --version` when switching between a registry release and a local development package.

The default WebUI address is `http://127.0.0.1:2233/`; the shared Mini App listener uses port `49152`.
Startup prints the access URLs. The default data directory is `~/.minimax`, shared with the CLI.
The command opens the default browser when its output is a terminal. Press **Ctrl+C** to stop it.

## Command-line options

```text
mcode-webui [--full-access] [--help | --version]
```

| Option | Meaning |
| --- | --- |
| `--full-access` | Disable WebUI token authentication for HTTP routes, WebSocket channels and Mini App HTTP/WebSocket services |
| `-h`, `--help` | Print help and exit without starting the runtime or opening the database |
| `-v`, `--version` | Print the installed version and exit without starting the runtime or opening the database |

Host, port and data directory are environment variables, rather than `--host`, `--port` or
`--data-dir` options.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBUI_HOST` | `127.0.0.1` | Bind address for the WebUI and shared Mini App listener; `0.0.0.0` binds all IPv4 interfaces, `::` binds IPv6 interfaces |
| `WEBUI_SERVER_PORT` | `2233` | WebUI HTTP and WebSocket port; integer from `1` to `65535` |
| `WEBUI_MINIAPP_PORT` | `49152` | Shared Mini App HTTP and WebSocket port; integer from `1` to `65535`, distinct from the WebUI port |
| `MINIMAX_DATA_DIR` | `~/.minimax` | Runtime data directory; use an absolute path to keep a separate development profile |
| `WEBUI_OPEN_BROWSER` | Open only when stdout is a terminal | Set `0`, `false`, `no`, `off` or `never` to disable browser opening; `1` forces an attempt even when stdout is redirected |
| `LOG_LEVEL` | `info` | Shared runtime logger level, for example `debug`, `info`, `warn` or `error`; startup messages are still printed |

The examples below use POSIX shell syntax on Linux and macOS. PowerShell examples follow separately.

## Startup examples

### Local access

```sh
# Default ports, data directory and token policy.
mcode-webui

# Keep the server in the foreground without opening a browser.
WEBUI_OPEN_BROWSER=0 mcode-webui

# Choose different ports and a separate data directory.
MINIMAX_DATA_DIR="$HOME/.minimax-webui-dev" \
  WEBUI_SERVER_PORT=2234 WEBUI_MINIAPP_PORT=49153 mcode-webui

# Enable verbose runtime logging.
LOG_LEVEL=debug WEBUI_OPEN_BROWSER=0 mcode-webui
```

### LAN or remote server access with token authentication

```sh
WEBUI_HOST=0.0.0.0 WEBUI_OPEN_BROWSER=0 mcode-webui

# Bind a specific local interface instead of every interface.
WEBUI_HOST=192.168.1.10 WEBUI_OPEN_BROWSER=0 mcode-webui
```

Replace `192.168.1.10` with an address assigned to the server. Open the printed URL containing
`?token=...`; the credential changes on each start. Remote access requires that token unless
`--full-access` is enabled. A wildcard bind prints local and LAN addresses; for a public server,
substitute its reachable IP address or hostname while keeping the printed port and token.
The default policy permits requests arriving over loopback without a token.

Allow or forward both the WebUI port (`2233`) and Mini App port (`49152`) when accessing Mini Apps
from another machine. Set `WEBUI_MINIAPP_PORT` when a different externally reachable port is needed.

### Access without a WebUI token

```sh
# Local access without a WebUI token.
mcode-webui --full-access

# Remote server access without a WebUI token.
WEBUI_HOST=0.0.0.0 WEBUI_OPEN_BROWSER=0 mcode-webui --full-access

# Explicit ports and data directory for a remote server.
MINIMAX_DATA_DIR="$HOME/.minimax" \
  WEBUI_HOST=0.0.0.0 WEBUI_SERVER_PORT=2233 WEBUI_MINIAPP_PORT=49152 \
  WEBUI_OPEN_BROWSER=0 mcode-webui --full-access
```

Open `http://<server-address>:2233/`, without `?token=...`. The flag covers all WebUI HTTP routes
(including files, session transfer/import and extension downloads), WebSocket channels, and the
Mini App proxy's HTTP and WebSocket services. Startup prints token-free URLs. Anyone who can reach
these services can use their WebUI operations.

`--full-access` leaves Host/Origin checks, Chrome/Edge extension pairing, account/provider
credentials and Agent tool permission settings in force. It does not change the bind address;
`WEBUI_HOST` controls where the service listens. Omit the flag to retain the default token policy.

### Run in the background on Linux or macOS

```sh
mkdir -p "$HOME/.local/state/mcode-webui"
nohup env WEBUI_HOST=0.0.0.0 WEBUI_OPEN_BROWSER=0 \
  mcode-webui --full-access \
  > "$HOME/.local/state/mcode-webui/server.log" 2>&1 < /dev/null &
echo "$!" > "$HOME/.local/state/mcode-webui/server.pid"

# Follow startup and runtime output.
tail -f "$HOME/.local/state/mcode-webui/server.log"
```

Omit `--full-access` for token authentication. Stop this instance with `kill -TERM <pid>`, using
the PID in `server.pid` after checking that it still belongs to this WebUI process. Restart by
waiting for it to exit, then running the startup command again. For a persistent server, a service
supervisor can run the same foreground command and manage logs and restarts.

### Windows PowerShell

```powershell
# These settings apply to processes started from this PowerShell session.
$env:WEBUI_HOST = "0.0.0.0"
$env:WEBUI_SERVER_PORT = "2233"
$env:WEBUI_MINIAPP_PORT = "49152"
$env:WEBUI_OPEN_BROWSER = "0"
$env:MINIMAX_DATA_DIR = "$env:USERPROFILE\.minimax"
mcode-webui --full-access
```

Omit `--full-access` for token authentication. Press **Ctrl+C** to stop. Remove an override with,
for example, `Remove-Item Env:WEBUI_HOST` to restore its default on the next start.

## Run from source

Run these commands from the repository root. Install workspace dependencies first:

```sh
pnpm install --frozen-lockfile
```

For browser client development, use two terminals:

```sh
# Terminal 1: the runtime service, port 2233.
pnpm --filter @mavis/webui dev:server

# Terminal 2: the Vite dev server, port 5173.
pnpm dev:webui
```

Open `http://localhost:5173/`. Vite serves `src/client/` and proxies `/ws`, `/session-transfer`
and `/session-import` to the service. To change the service port, set `WEBUI_SERVER_PORT` to the
same value in both terminals. `WEBUI_VITE_PORT` changes Vite's own port.

To serve the built client directly from the runtime service:

```sh
pnpm build:webui
pnpm --filter @mavis/webui dev:server
```

Open the access URL printed by the service on port `2233`. The build writes `dist-webui/`
(client, server and the esbuild metafile). The source launcher does not parse the packaged
`--full-access` flag; use an installed development package to exercise that startup mode.

### Build and install a local development package

Use a dedicated output directory outside the checkout; the packaging script replaces its output
directory on each build. From the repository root:

```sh
node scripts/package-webui-npm.mjs --version 0.1.6-dev.1 \
  --outdir ../minimax-code-webui-build/package
npm pack ../minimax-code-webui-build/package --pack-destination ../minimax-code-webui-build
npm install --global ../minimax-code-webui-build/minimax-webui-minimax-code-0.1.6-dev.1.tgz \
  --allow-scripts=better-sqlite3,bufferutil,koffi,node-pty,utf-8-validate
mcode-webui --version
WEBUI_OPEN_BROWSER=0 mcode-webui --full-access
```

The npm 12 allow-list flag can be omitted with npm 11 or earlier. Stop an existing instance before
starting its replacement on the same ports. A global package update does not restart an existing
WebUI process. Building, packing and installing locally do not publish anything to npm.

## Documentation

- [`AGENTS.md`](AGENTS.md) — the operating guide: layering rules, the gates each change needs, test
  conventions, the fork's issue and branch workflow. Read it before changing code.
- [`docs/README.md`](docs/README.md) — the index of the technical documentation set, with the
  authority order: the source and its tests, then `docs/adr/`, then the prose.
- [`docs/known-gaps.md`](docs/known-gaps.md) — what this client does not do yet, verified against the
  tree.
- `CONTEXT.md` at the repository root — the project glossary.

## Layout

| Path | Holds |
| --- | --- |
| `src/client/` | The browser: business state, presentation, browser IO. Its businesses are the directories under `src/client/features/` |
| `src/server/` | Network ingress: authentication, envelope validation, dispatch, wire projection, static assets |
| `src/runtime/` | Harness capability adaptation and every Node-side process resource |
| `src/shared/` | Cross-process wire contracts and shared constants |
| `test/` | All WebUI tests, grouped into `unit/`, `integration/`, `browser/` and `gates/` |
| `docs/` | Architecture, client, runtime, design, verification, reference and the decision log |

[`docs/architecture/module-map.md`](docs/architecture/module-map.md) maps the client's businesses and
their roles; [`docs/architecture/layered-model.md`](docs/architecture/layered-model.md) explains how a
request travels from a React component to the harness.

## Contributing

See the repository [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for review requirements, and
[`AGENTS.md`](AGENTS.md) for what a WebUI change has to pass.
