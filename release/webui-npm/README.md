# MiniMax Code WebUI package

This package runs the MiniMax Code WebUI and its local runtime on your machine.
It is published to the public npm registry. No GitHub account or personal access
token is required to install it.

```sh
npm install --global @minimax-webui/minimax-code
mcode-webui
```

With npm 12 and later, the modules this package builds have to be allowed
explicitly — npm 12 blocks dependency install scripts unless they are named:

```sh
npm install --global @minimax-webui/minimax-code \
  --allow-scripts=better-sqlite3,bufferutil,koffi,node-pty,utf-8-validate
```

Or allow them for every global install:

```sh
npm config set allow-scripts=better-sqlite3,bufferutil,koffi,node-pty,utf-8-validate --location=user
```

An install that skipped them leaves a native module (`better-sqlite3` or
`koffi`) without its binding, and `mcode-webui` then stops at startup and prints
the reinstall command instead of running. npm 11 and earlier print the same
warning but still run the scripts.

The server listens on `http://127.0.0.1:2233/`. Set `WEBUI_SERVER_PORT` to
change the port or `MINIMAX_DATA_DIR` to change the local data directory. The
default data directory is `~/.minimax`.

Use `mcode-webui --help` or `mcode-webui --version` without starting the runtime
or opening the database.

To allow access without the WebUI's per-start token, start with:

```sh
mcode-webui --full-access
```

This disables token authentication for all WebUI HTTP routes and WebSocket channels,
including files, session transfer/import, extension downloads and the Mini App proxy's
HTTP and WebSocket services. The printed access URLs omit the token. To bind on all
interfaces as well, set `WEBUI_HOST=0.0.0.0`; the flag itself does not change the bind
address. Anyone who can reach these services has access to their WebUI operations.
Host and Origin checks, Chrome/Edge extension pairing, account/provider credentials
and Agent tool permission settings retain their existing behavior. Without the flag,
the existing token authentication applies.

When a schema migration or compatibility repair is needed, startup first creates
and verifies a SQLite backup. It prints the copy progress and the start of the
integrity check. The copy uses a stable WAL read snapshot so another host's writes
do not restart it. A copy with no progress for 60 seconds, or taking more than
10 minutes, stops before schema migration and removes its incomplete backup.
Check available disk space and storage performance before retrying. The read
snapshot can temporarily retain WAL pages while other hosts continue writing.

`mcode-webui` opens the page in your default browser once the server is
listening. Set `WEBUI_OPEN_BROWSER=0` to keep it from doing that; with the
variable unset it stays quiet when the command's output is not a terminal, so a
script, a service supervisor or a CI job never takes over the desktop.

### Desktop host handoff

A local desktop host that embeds the page cannot rely on the system browser to
open the one-time native-directory grant URL. It can start the launcher with
`WEBUI_DESKTOP_HOST=1` and `WEBUI_LAUNCH_URL_FILE=<absolute path>`; after the
server is listening, the launcher writes the page URL with its
`#nativeDirectoryGrant` fragment to that private file with owner-only access
(0600 on POSIX; the user-profile ACL on Windows) and does not log it. The host
opens that URL in its own embedded page, and the existing grant/cookie/browserKey
pairing completes. The file contains only the URL — no JSON, no extra fields.

`WEBUI_DESKTOP_HOST=1` also lets the native-directory picker be created without
an interactive TTY; ordinary launches still require one. `WEBUI_OPEN_BROWSER=0`
still only means "do not open the system browser" and never disables the picker.
The HTTP route's loopback, Host, Origin, `Sec-Fetch-Site`, cookie, grant and
browserKey checks are unchanged. If the handoff file cannot be written, the
launcher logs the path and the host should fall back to the printed bare WebUI
URL; the native picker may then be unavailable.

The package requires a supported Node.js version shown in its `engines` field.
