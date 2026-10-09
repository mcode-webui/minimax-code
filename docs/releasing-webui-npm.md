# WebUI package on the npm registry

The WebUI is packaged as `@fectivnfy112358/minimax-code-web` and published to
`https://registry.npmjs.org` under the `preview` dist-tag.

> **Preview publishing is currently OFF, and this section used to say
> otherwise.** As of 2026-10-05 the repository has **no Actions secret named
> `NPM_TOKEN`**, so `HAS_NPM_TOKEN` in `webui-npm-preview.yml` evaluates to
> `false` and **the publish step never runs**. The job still goes green — the
> steps emit `::warning::` instead of failing, so "no credential" and
> "published" are the same colour. Verified with `gh secret list` (empty) and
> `gh api .../branches/webui/protection` (404, so this job was never a merge
> gate either).
>
> To turn it back on: add the `NPM_TOKEN` secret, and nothing in the workflow
> needs to change. Be aware the first run with a real credential is a **cold
> start** — version resolution and `npm publish` have not been exercised since
> the gate was relaxed.

## How a release happens

`.github/workflows/webui-npm-preview.yml` runs on `push` to `webui` and on
`workflow_dispatch`. It:

1. installs the workspace with a frozen lockfile;
2. resolves the next version by reading the highest `<core>-preview.<n>`
   already on the registry and incrementing `n`;
3. builds the package with `scripts/package-webui-npm.mjs`;
4. inspects the tarball with `npm pack --dry-run`;
5. publishes, unless that version is already on the registry, in which case it
   exits successfully without publishing.

Because the version is derived from the registry rather than from a git tag or a
field in the repository, the `version` in `release/webui-npm/package.json` is
only the default for local builds. Editing it does not trigger or choose a
release.

The already-published check in step 5 is what makes reruns safe. A rerun of a
successful run recomputes the same version, sees it published, and no-ops.

## Credentials

The workflow authenticates with the repository secret `NPM_TOKEN`, which must be
a granular access token with **Read and write (publish and stage)** access to
`@fectivnfy112358`. It is read as `NODE_AUTH_TOKEN`, which `actions/setup-node`
turns into the `//registry.npmjs.org/:_authToken` entry the publish step needs.

Set it once:

```sh
gh secret set NPM_TOKEN --repo <owner>/<repo>
```

The workflow holds no npm token in the repository, and no token belongs in the
tracked `.npmrc`.

## Publishing attestations

The workflow does **not** pass `--provenance`, so published versions carry no
npm provenance attestation. Provenance requires npm trusted publishing (OIDC),
which in turn requires the package's trusted publisher to be configured on
npmjs.com. If that configuration is ever added, give the workflow
`permissions: id-token: write` and pass `--provenance` to the publish step;
`repository.url` in `release/webui-npm/package.json` must keep matching the
GitHub repository or attestation generation fails.

## Local builds

`release/webui-npm/package.json` carries the version a local build falls back to
when `--version` is omitted. npm never accepts a republished version, so a local
build that is meant to be published needs an explicit, unused version:

```sh
pnpm install --frozen-lockfile
pnpm run package:webui-npm -- --version 0.1.0-preview.4 --outdir /tmp/minimax-code-web
npm pack --dry-run /tmp/minimax-code-web
```

`publishConfig.access` in `release/webui-npm/package.json` already makes the
scoped package public.
