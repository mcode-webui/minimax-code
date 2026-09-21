# @mavis/webui

Browser client for the harness layer. This package is the foundation slice
described in [GitHub issue #2](https://github.com/Fectivnfy112357/minimax-code/issues/2);
later tickets add server transport, the WebSocket envelope, React UI and the
end-to-end loopback setup.

## Boundaries

- Server code and client code each type-check under their own
  `tsconfig.server.json` and `tsconfig.client.json`. The standalone
  `tsconfig.standalone.json` does not cover either.
- The browser bundle has its own metafile under `dist-webui/metafile.json`
  and is checked by `scripts/check-webui-boundary.mjs`.
- The terminal renderer (`packages/tui/src/tui/`) must not appear in the
  WebUI build graph.

## Scripts

- `pnpm --filter @mavis/webui typecheck:server`
- `pnpm --filter @mavis/webui typecheck:client`
