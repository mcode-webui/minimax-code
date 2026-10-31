# @mavis/webui

A browser client for the process-local harness layer, plus the loopback service that serves it and
forwards to the harness in process. It is a peer client of the terminal client: it builds on
`@mavis/local-runtime-v2` directly, imports no `packages/tui` internals and does not drive the CLI
binary (ADR 0001, ADR 0003).

The package is `private: true` in the workspace and is not published under that name. A standalone
preview build is published as `@fectivnfy112358/minimax-code-web` under the `preview` dist-tag on
every push to the `webui` branch — see [`docs/releasing.md`](docs/releasing.md).

## Run it

Two processes, in two terminals:

```sh
pnpm --filter @mavis/webui dev:server   # the loopback service, port 8787
pnpm dev:webui                          # the Vite dev server, port 5173
```

Vite serves the browser client from `src/client/` and proxies `/ws`, `/session-transfer` and
`/session-import` to the service. Build the shipped artefacts with `pnpm build:webui`, which writes
`dist-webui/` (client, server and the esbuild metafile).

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
