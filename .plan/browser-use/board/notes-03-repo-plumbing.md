**Reference material for the WebUI Browser Use programme — not a work item.**

Captured before implementation, from the source at the current checkout. Path in the workspace: `.plan/browser-use/exploration/03-repo-plumbing.md` (gitignored, outside the published source projection).

---

# Repo plumbing map — WebUI Browser Use

Implementation-context notes for adding `packages/browser-extension/` and its verification gates.
Nothing here is implemented. Every claim below is backed by a `file:line` citation read from the
working tree at the time of writing. Items that could not be established from the repository are
marked **not verified — needs check**.

Legend: **[EXISTS]** is already in the repo today; **[CREATE]** must be added by the implementer.

---

## 1. Registering a new workspace package

### 1.1 `pnpm-workspace.yaml` — explicit path list, not a glob **[CREATE: one line]**

The file is a flat `packages:` list of explicit paths. There is **no** `packages/*` glob, so a new
package is not picked up automatically.

```yaml
# pnpm-workspace.yaml:1
packages:
  - "third_party/pi-mono/packages/agent"
  ...
  - "packages/browser-core"      # :11
  ...
  - "packages/local-runtime"     # :17
  - "packages/local-runtime-v2"  # :18
  ...
  - "packages/webui"
  - third_party/sandbox-runtime
  - "packages/oauth-core"
  - "packages/oauth-lease-protocol"
  - "packages/mcode-tools-host"
```

**Action:** add `  - "packages/browser-extension"` to this list. Ordering is not alphabetical
(it is historical), so append or insert near `packages/browser-core`; nothing validates the order.

### 1.2 `release/extraction.json` — `packageRoots` is the single source of package scope **[CREATE: one line]**

```json
// release/extraction.json:1-5
{
  "schemaVersion": 1,
  "sourceRevision": "9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee",
  "packageRoots": [
    "packages/agent-core",
```

`packages/browser-core` is listed at **`release/extraction.json:21`**:

```json
    "packages/browser-core",      // :21
    "packages/config",            // :22
```

The array is sorted (`:5`–`:37`, with `third_party/*` last), and the file also carries
`productBaseline` (`:38`) and `distribution` (`:39`) which the extension work does not change.

What else in the repo enumerates packages, per `AGENTS.md`:

| Concern | Declared in | Consumed by |
| --- | --- | --- |
| Package scope | `release/extraction.json` (`packageRoots`) | build, type-check paths, Vitest aliases, `check:source`, source sync |

Consumers of `packageRoots` that will pick the new package up automatically once it is added:

- `scripts/gen-tsconfig-paths.mjs:22` — `readExtraction(root).packageRoots`
- `scripts/source-inventory.mjs:71-77` — reads every `packageRoots` entry's `package.json`
- `scripts/package-webui-npm.mjs:34-40` — maps manifest name → workspace package
- `packages/webui/vite.config.ts:20-27` — Vite dev alias
- `vitest.oss.config.mjs:9-15` — Vitest resolve alias
- `scripts/build-webui.mjs` (same `sourcePlugin` mechanism)

### 1.3 What `check:source` enforces about a new `packageRoots` entry **[EXISTS — already coded]**

`scripts/source-inventory.mjs:71-105` runs per-package checks. A new entry **fails** unless all of
the following hold:

1. **`license` present and not `UNLICENSED`** — `:80-81`
   ```js
   if (!manifest.license || manifest.license === "UNLICENSED")
     violations.push(`${directory}: missing open-source license`);
   ```
2. **every `workspace:` dependency names a known `packageRoots` manifest** — `:82-91`
3. **every `exports` subpath's resolved source file exists on disk** — `:92-104`
   ```js
   if (!existsSync(path.resolve(root, directory, source)))
     violations.push(`${directory}: missing export ${name}`);
   ```

### 1.4 `release/dependency-licenses.json` — declaration inventory, not a gate **[EXISTS]**

```json
// release/dependency-licenses.json:1-3
{
  "generatedFrom": "pnpm licenses list --json",
  "packages": [
```

Shape: a flat `packages` array of `{ name, versions: string[], license, homepage }` — **704 entries**
as committed. It is produced by `pnpm licenses list --json`, and **nothing in `check:source` reads or
validates it** (verified: no script imports it for checking; it is only *copied* into a release by
`scripts/package-cli-release.mjs:29` and described in `docs/release-audit.md:13` and
`THIRD_PARTY_NOTICES.md:7`).

**Implication:** a new package does **not** break a gate by omitting entries, but the file is a
published declaration record. **[CREATE]** whoever adds a dependency should regenerate it so the
declared licenses stay accurate — e.g. `pnpm licenses list --json` reformatted to this shape.
The exact regeneration command is **not verified — needs check** (no script owns the write).

### 1.5 Export subpath → source file mapping, and what `gen:tsconfig` writes **[EXISTS]**

The model package:

```json
// packages/browser-core/package.json:1-14
{
  "name": "@mavis/browser-core",
  "version": "0.2.1",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
```

Note `packages/browser-core` has **no** `scripts` block at all — it is a types/source-only package
that other packages consume through the workspace alias. `packages/shared` and `packages/protocol`
are the same shape.

The mapping rule, in one place:

```js
// scripts/lib/package-exports.mjs:9-14
function sourceOf(target) {
  return target
    .replace(/^\.\/dist\//u, "./src/")
    .replace(/\.d\.ts$/u, ".ts")
    .replace(/\.js$/u, ".ts");
}
```

`./dist/x.js` → `./src/x.ts`. `packageExportEntries()` (`:16-41`) walks `packageRoots`, reads each
`exports` subpath, picks `types ?? import ?? default`, and emits
`{ specifier: "<name><subpath>", directory, file }`. Non-`.`-prefixed subpaths are skipped (`:29`).

`scripts/gen-tsconfig-paths.mjs` derives **two** files from that table:

```js
// scripts/gen-tsconfig-paths.mjs:29-36
const targets = [
  { configPath: "tsconfig.standalone.json", baseUrl: "." },
  {
    configPath: "packages/webui/tsconfig.paths.json",
    baseUrl: "../..",
    template: { extends: "../../tsconfig.node.json" },
  },
];
```

It writes a **sorted** `paths` map, one entry per export, formatted as a multi-line array.
Example of what lands in `tsconfig.standalone.json`:

```json
// tsconfig.standalone.json:130-132
      "@mavis/browser-core": [
        "./packages/browser-core/src/index.ts"
      ],
```

**⚠️ GENERATED FILE — do not hand-edit.**
`tsconfig.standalone.json` (`paths` block) is regenerated by `pnpm gen:tsconfig`
(`package.json:22` → `node scripts/gen-tsconfig-paths.mjs --write`) and checked by
`pnpm check:tsconfig` (`package.json:21`). `check:tsconfig` fails closed on drift, including on a
path present in the file but no longer declared by any package in `extraction.json`
(`gen-tsconfig-paths.mjs:83-85`).

The standalone `tsconfig.standalone.json` `include` list is only TUI entry points
(`:401-405`), so **a new package is not type-checked by `pnpm typecheck`** — this is exactly the gap
`.plan/browser-use/browser-use-development-plan.md:182` names.

### 1.6 `scripts/source-inventory.mjs` — how a new file reaches the inventory **[EXISTS]**

Scan rules:

- Recursive walk from the repo root, symlinks throw (`:31-42`)
- `skipped` set (`:12-30`) excludes: `.git`, `node_modules`, `dist`, `dist-webui`
  (`WEBUI_DIST_DIRECTORY`), `.cache`, **`.plan`**, `.pnpm-store`, `.turbo`, `.idea`, `.DS_Store`,
  `.codegraph`; `*.tsbuildinfo` is skipped too
- **`.plan` is excluded** (`:19`), so this very notes directory cannot affect the inventory.
- Per-file checks (`:57-70`): retired source roots, `.env*` files, `INTERNAL_HOST_RE`,
  `CREDENTIAL_RE`
- License SHA-256 pin on root `LICENSE` (`:47-56`)
- Plugin contract validation (`:123-127`)

Write mode:

```js
// scripts/source-inventory.mjs:130-136
if (process.argv.includes("--write")) {
  const projected = [...new Set([...files, inventoryPath])].sort();
  writeFileSync(
    path.join(root, inventoryPath),
    JSON.stringify({ schemaVersion: 1, files: projected }, null, 2) + "\n",
  );
```

Check mode (default) diffs the working tree against the committed file and **fails on any added or
removed path** (`:138-148`).

**⚠️ GENERATED FILE — do not hand-edit.**
`release/public-source.json` is regenerated by `node scripts/source-inventory.mjs --write` and
checked by `pnpm check:source` (`package.json:35`). Per `AGENTS.md`, review the added/removed file
list before regenerating — recording a file does not make it suitable for publication.

---

## 2. New verification gates and test registration

### 2.1 `scripts/verify.mjs` — where a step is declared **[CREATE: one entry]**

The whole pipeline is one array literal:

```js
// scripts/verify.mjs:40-42
const steps = [
  { name: "check:source", script: "check:source", docs: true, windows: true },
  { name: "check:tsconfig", script: "check:tsconfig", docs: true, windows: true },
```

Representative WebUI steps and their exact placement:

```js
// scripts/verify.mjs:54-73
  { name: "typecheck", script: "typecheck", fullOnly: true },
  { name: "build", script: "build", windows: true },
  { name: "check:standalone", script: "check:standalone", windows: true },
  { name: "typecheck:webui", script: "typecheck:webui" },
  ...
  { name: "check:webui-dependency", script: "check:webui-dependency" },
  { name: "build:webui", script: "build:webui" },
  { name: "check:webui-boundary", script: "check:webui-boundary" },
  { name: "test:webui-package", script: "test:webui-package", platforms: ["linux", "darwin"] },
  { name: "test:webui", script: "test:webui" },
  { name: "test:webui-browser", script: "test:webui-browser", platforms: ["linux"] },
```

**Step shape:** `{ name, script?, command?, docs?, windows?, fullOnly?, packageOnly?, platforms? }`.
- `script` → runs `pnpm run <script>` (`:119-133`); `command` → `spawnSync(process.execPath, command)`
- `platforms` → only run on listed platforms (`:103-104`)
- `windows` → part of the Windows contract profile; `docs` → part of the docs-only profile;
  `fullOnly` → skipped under `--profile platform`; `packageOnly` → only under `--profile package`
- `--list` prints the planned gate names (`:111-114`)

**Where a "typecheck the extension package" step goes:** immediately **after** the
`typecheck:webui` line at **`scripts/verify.mjs:57`**, so TypeScript gates stay grouped before the
build. It must be declared with a `script:` (not `command:`) so it reuses the package.json script:

```js
  { name: "typecheck:browser-extension", script: "typecheck:browser-extension" },
```

`AGENTS.md` rule: *"Adding a verification gate: add a step to `scripts/verify.mjs`, with
`platforms` when it cannot run everywhere. Do not add steps to the workflow file."*

### 2.2 `test/vitest-suites.json` — registering a Vitest file **[CREATE: array entries]**

```json
// test/vitest-suites.json:1-3
{
  "comment": "Vitest suites for the standalone distribution, grouped by the gate that runs them. `vitest.oss.config.mjs` includes every group; `scripts/run-vitest-suite.mjs <group>` runs one. Add a test file here rather than in package.json or the Vitest config.",
  "suites": {
```

Six groups exist today:

| Group | Files | First entry |
| --- | ---: | --- |
| `windows` | 1 | `test/windows-contract.test.mjs` |
| `capability` | 227 | `packages/local-runtime-v2/test/integration/compaction-openai-transport.integration.test.ts` |
| `status-contract` | 1 | `packages/tui/test/unit/tui-build-mode-contract.test.ts` |
| `policy` | 1 | `packages/local-runtime/test/unit/local-permission-facade.test.ts` |
| `sandbox` | 2 | `packages/local-runtime-v2/src/service/sandbox/backend/srt-macos.test.ts` |
| `webui` | 180 | `packages/webui/test/unit/models-provider-intent.test.ts` |

A plain string per file; the `webui` group is one flat array ending at
**`test/vitest-suites.json:427`**.

**Registration is mandatory, not optional.** `scripts/lib/vitest-suites.mjs:42-54` scans the whole
inventory and fails any unregistered first-party test:

```js
    if (
      file.startsWith("packages/") &&
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
      !file.startsWith("packages/webui/test/browser/") &&
      !registered.has(file)
    )
      violations.push(
        `${file}: first-party test is absent from test/vitest-suites.json`,
      );
```

This runs inside `check:source` (`scripts/source-inventory.mjs:44`). Note the only exemption is
`packages/webui/test/browser/` (Playwright-owned). **A Playwright spec under
`packages/browser-extension/test/browser/` would fail `check:source`** unless either (a) it goes in
the existing `packages/webui/test/browser/` Playwright dir, or (b) the exemption at
`vitest-suites.mjs:48` is widened. That is a decision the implementer must make explicitly.

**Group choice:** the `webui` group is the closest fit for extension-adjacent unit tests; a new
group (e.g. `browser-extension`) would need its own `pnpm test:*` script **and** a `verify.mjs` step.
Do not hard-code Vitest paths in `package.json` scripts or the Vitest config (`AGENTS.md`).

### 2.3 `package.json` script naming convention **[EXISTS]**

```json
// package.json:11-43 (relevant entries)
    "check:source": "node scripts/source-inventory.mjs",
    "check:tsconfig": "node scripts/gen-tsconfig-paths.mjs",
    "gen:tsconfig": "node scripts/gen-tsconfig-paths.mjs --write",
    "typecheck": "tsc -p tsconfig.standalone.json",
    "typecheck:webui": "pnpm --filter @mavis/webui typecheck:server && pnpm --filter @mavis/webui typecheck:client && pnpm --filter @mavis/webui typecheck:test",
    "check:webui-dependency": "node scripts/check-webui-dependency.mjs",
    "check:webui-boundary": "node scripts/check-webui-boundary.mjs",
    "build:webui": "node scripts/build-webui.mjs",
    "test:webui": "node scripts/run-vitest-suite.mjs webui",
    "test:webui-package": "node scripts/verify-webui-package.mjs",
    "test:webui-browser": "playwright install chromium && playwright test packages/webui/test/browser",
    "package:webui-npm": "node scripts/package-webui-npm.mjs",
    "verify": "node scripts/verify.mjs",
```

Convention: `<verb>:<subject>` with kebab-case subject. Verbs in use: `check:`, `typecheck:`,
`build:`, `test:`, `gen:`, `package:`, `dev:`, `lint:`. A new gate is therefore
`typecheck:browser-extension` / `build:browser-extension` / `test:browser-extension`.

Per-package scripts live in `packages/webui/package.json:10-21`
(`typecheck:server`, `typecheck:client`, `typecheck:test`, `test`) and are reached from the root by
`pnpm --filter @mavis/webui …` — the pattern a new package should mirror.

---

## 3. Dependency and licensing reality check

### 3.1 OS secure credential store — **DOES NOT EXIST in this repo today** **[CREATE]**

Searched for `keytar|keychain|libsecret|secret-service|dpapi|keyring|safeStorage`. Complete result:

| File | What it is |
| --- | --- |
| `packages/oauth-core/src/credential-store/types.ts` | The *contract*, file-store only |
| `packages/oauth-core/src/state-store.ts` | Legacy-kind string only |
| `packages/mcode-tools-host/test/unit/resource-manifest.test.ts` | Unrelated (`credential` in a name) |
| `packages/agent-modules/permission/src/tools/fs-permission.ts` | Unrelated (`credential` in a path pattern) |
| `packages/agent-modules/permission/src/classifier/dangerous-patterns.ts` | Unrelated (dangerous-path patterns) |
| `third_party/sandbox-runtime/vendor/srt-win-src/src/{dpapi,cert_store,reg,user,acl}.rs` | **Rust** Windows code, vendored, not callable from JS |
| `third_party/sandbox-runtime/src/sandbox/windows-sandbox-utils.ts` | Rust helper wrapper |
| `release/public-source.json` | The string `keyring` in the `os-keyring` type name |

The actual store — **a private-permission file, not an OS keystore**:

```ts
// packages/oauth-core/src/credential-store/types.ts:3-4
export type CredentialStoreKind = 'file';
export type LegacyCredentialStoreKind = 'os-keyring';
```

```ts
// packages/oauth-core/src/credential-store/factory.ts:6-8
export function createCredentialStore(options: CreateCredentialStoreOptions): CredentialStore {
  return new FileStore(options);
}
```

`FileStore` writes `join(this.authHome, 'auth.json')`
(`packages/oauth-core/src/credential-store/file-store.ts:55-56`), with mode hardening in
`packages/oauth-core/src/fs/atomic-write.ts`: directory `0o700` (`:5-6`), file `0o600` (`:13`, `:23`).

`os-keyring` survives **only as a migration-readable value**, never produced by the factory:

```ts
// packages/oauth-core/src/state-store.ts:76
      (state.storeKind === 'os-keyring' || state.storeKind === 'file')) ||
```

**Consequence for ADR 0019 / plan WP0.** ADR 0019 (`…/0019-…md:41-48`) requires OS secure storage
with explicit failure and **no plaintext fallback**; the plan repeats it at
`.plan/browser-use/browser-use-development-plan.md:129-130` and `:236-240`. Nothing in this repository
provides it today. Options — none of which exist yet — are: a new native module, or a per-OS helper.
Whatever is chosen must add itself to `package.json:66-70`:

```json
  "pnpm": {
    "onlyBuiltDependencies": [
      "better-sqlite3",
      "esbuild",
      "node-pty"
    ],
```

A native module that is not listed there will not be built by pnpm.

### 3.2 Node version support

| Declaration | Value | Location |
| --- | --- | --- |
| Root `engines` | `>=22.19 <23 \|\| >=24.2 <27` | `package.json:8-10` |
| `packages/webui` | `>=22.19 <23 \|\| >=24.2 <27` | `packages/webui/package.json:7-9` |
| `packages/tui` | `>=22.19 <23 \|\| >=24.2 <27` | — |
| `packages/oauth-core` | `>=20` | `packages/oauth-core/package.json` `engines` |
| `packages/mcode-tools-host` | `>=20` | — |
| `packages/oauth-lease-protocol` | `>=20` | — |
| `release/webui-npm` | `>=22.19 <23 \|\| >=24.2 <27` | `release/webui-npm/package.json:24-26` |

Docs agree: *"Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26"* — `README.md:52`, `README.md:260`,
`docs/installation.md:38`, `docs/installation.md:42`. `CONTRIBUTING.md:53` documents the weekly
compatibility matrix over Node 22.19.0 / 24.2.0 / 25 / 26 on macOS + Linux, "Dispatch it on the
selected branch for changes to supported Node versions, **native dependencies** or
compatibility-sensitive verification tooling". **Adding a native credential-store module triggers
that matrix.**

Note the three library packages declaring `>=20` is looser than the supported runtime floor; a new
package should follow the root range, not the `>=20` precedent.

### 3.3 The WebUI client bundle may not use native Node modules at all

Server vs client are two separate esbuild builds:

```js
// scripts/build-webui.mjs:77-101 (server)
const server = await build({
  absWorkingDir: packageDir,
  entryPoints: {
    server: "src/server/index.ts",
    runtime: "src/runtime/index.ts",
    "mcode-tools": "src/runtime/mcode-tools-entry.ts",
  },
  platform: "node",
  target: "node22",
  external: [
    "@mavis/local-runtime-v2",
    "@mavis/config",
    "@mavis/mcode-tools-host",
    "@mavis/agent-tools",
    "@mavis/agent-tools/desktop",
    "@mavis/oauth-core",
  ],
```

```js
// scripts/build-webui.mjs:107-112 (client)
const client = await build({
  absWorkingDir: packageDir,
  entryPoints: { client: "src/client/main.tsx" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
```

The client build has **no `external` array** — everything is bundled into a browser-target ESM
bundle. Native modules are already excluded by hand on the server side in the npm packager
(`scripts/package-webui-npm.mjs:71`: `external: ["better-sqlite3", "node-pty"]`).

Source-level enforcement (runs **before** the build, per `scripts/verify.mjs:66-68`):

```js
// scripts/lib/webui-dependency-rules.mjs:1782
const NODE_BUILTIN_ALLOWED_LAYERS = new Set(["server", "runtime", "runtime-port"]);
```

`forbiddenNodeBuiltinRule` (`:1792-1805`) flags any Node builtin import from a layer outside that
set — so `client`, `view`, `application`, `bindings`, `domain`, `contracts`, `shared` may not
import `fs`, `node:fs`, etc. `scripts/check-webui-dependency.mjs:86,92` scopes this check to
`packages/webui/src` only.

**⚠️ Critical for the extension's shared contracts.** The WebUI client may only depend on two
workspace packages:

```js
// scripts/lib/webui-dependency-rules.mjs:2268-2273
  for (const entry of graph.hostImports ?? []) {
    if (!entry.from.startsWith("client/") && !entry.from.startsWith("shared/")) continue;
    // 浏览器只消费可跨边界的 shared/protocol workspace 契约。
    if (!entry.workspacePath && !/^@mavis\//u.test(entry.specifier)) continue;
    if (entry.workspacePath ? /^packages\/(?:shared|protocol)\//u.test(entry.workspacePath) : /^@mavis\/(?:shared|protocol)(?:\/|$)/u.test(entry.specifier)) continue;
    violations.push({ kind: "workspace-host", … });
```

i.e. `client/**` and `shared/**` may import **only** `packages/shared` and `packages/protocol`
(`@mavis/shared*` / `@mavis/protocol*`). **`@mavis/browser-core` is NOT permitted from the client.**
Extension-facing DTOs must therefore live in `packages/shared` (or `packages/protocol`) with an
`exports` subpath — not in `packages/browser-core`.

**Therefore: the credential store must live in the server/runtime layer** (an
`external`-able `@mavis/*` package or the WebUI server tree), never in client code.

---

## 4. Extension packaging reality check

### 4.1 Nothing for MV3 exists today — it must all be created **[CREATE]**

Searched for `manifest_version|chrome-extension|web-ext|webextension|browser.runtime|browser.tabs|chrome.runtime`.
Only two files matched, and one is dead documentation:

- `packages/webui/docs/adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md` — the ADR
- `packages/shared/src/browser-manifest.ts` — a **Native Messaging** installer helper

Confirmed absent: no `extension/` directory, no `manifest.json`, no `scripts/verify-extension-id.sh`,
no `web-ext`, no esbuild extension plugin, no Playwright Chrome-extension fixture.

`packages/shared/src/browser-manifest.ts` is the one real find, and it points at paths that do not
exist in this public projection:

```ts
// packages/shared/src/browser-manifest.ts:16-18
 * `scripts/verify-extension-id.sh` guards this constant against drift.
 */
export const MAVIS_BROWSER_EXTENSION_ID = 'ppnnfacnjgokfmbngkgbdgiigpbfgdba';
```

Verified: `extension/manifest.json` and `scripts/verify-extension-id.sh` are **not present**. The
module itself is inert — it only generates Native Messaging host manifests and wrapper scripts
(`getNativeHostDirs()` `:85-127`, `generateHostWrapper()` `:146-171`, `getWindowsRegistryEntries()`
`:179-199`). Note ADR 0019 `:71-75` explicitly **rejected** Native Messaging in favour of a
loopback WebSocket, so this module is not a starting point for the chosen design.

Also note `packages/shared/src/browser-manifest.ts` has **no `exports` subpath** in
`packages/shared/package.json` (48 export subpaths declared; none is `./browser-manifest`), so it
is not consumable by another workspace package through the alias mechanism today.

### 4.2 Playwright Chromium is already provisioned **[EXISTS]**

```json
// package.json:33
    "test:webui-browser": "playwright install chromium && playwright test packages/webui/test/browser",
```

`playwright.config.mjs:19-22` pins `testDir: "./packages/webui/test/browser"`, `browserName: "chromium"`,
`headless: true`, `workers: 1`, `fullyParallel: false`, and starts its own fixture server via
`webServer` (`:33-38`). Loading a real unpacked MV3 extension requires a **persistent context**
(`chromium.launchPersistentContext`), which this config does not use — **not verified — needs check**
whether Playwright's installed Chromium here supports extension loading in this environment.

### 4.3 How `release/webui-npm` is packaged, and whether the extension belongs in it

Committed contents — three files only:

```
release/webui-npm/package.json
release/webui-npm/README.md
release/webui-npm/bin/mcode-webui.mjs
```

```json
// release/webui-npm/package.json:1-34
{
  "name": "@fectivnfy112358/minimax-code-web",
  "version": "0.1.0-preview.3",
  "type": "module",
  "bin": { "mcode-webui": "bin/mcode-webui.mjs" },
  "files": [
    "assets/", "bin/", "client/", "server/",
    "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md"
  ],
  "engines": { "node": ">=22.19 <23 || >=24.2 <27" },
  "dependencies": {
    "better-sqlite3": "12.11.1",
    "node-pty": "1.1.0"
  },
```

This is a **staging manifest**, not a published artifact. `scripts/package-webui-npm.mjs` reads its
version (`:25-27`, which must match `/^\d+\.\d+\.\d+-preview\.\d+$/`, `:30-32`), builds styles +
server + client into `--outdir`, and the real tarball is produced elsewhere
(`package:webui-npm` at `package.json:27`). Its `files` list is the **shipped npm artifact layout**
— `client/`, `server/`, `assets/`.

**A browser extension is not an npm package.** It is a store artifact (ADR 0019 `:84-90`: Chrome
Web Store + Edge Add-ons, generated from the same source package as separate submissions). So:

- It should **not** be added to `release/webui-npm/package.json` `files` or `dependencies`.
- It **should** appear in `release/public-source.json` — ADR 0019 `:87-88` states verbatim:
  *"Include `packages/browser-extension/` in this repository's public-source projection and register
  it through the normal workspace and source-inventory process."*
- The only `release/webui-npm` entries in the inventory are the three source files above
  (`release/public-source.json:4285-4287`) — the built `client/`/`server/` output is not inventoried
  (`dist-webui` is in the inventory `skipped` set, `scripts/source-inventory.mjs:17`).

### 4.4 Retired-source list is clean for this work **[EXISTS]**

`scripts/lib/retired-sources.mjs:9-40` lists retired paths; none concerns `packages/browser-extension/`.
It does contain seven retired model-picker paths under
`packages/webui/src/client/features/models/` (`:30-36`) — relevant only as a reminder that the
working tree currently has live edits in that feature area.

---

## 5. Consolidated checklist for the implementer

Order matters; `check:source` and `check:tsconfig` fail closed on drift.

| # | File | Action | Kind |
| --- | --- | --- | --- |
| 1 | `pnpm-workspace.yaml` | add `"packages/browser-extension"` | hand edit |
| 2 | `release/extraction.json` | add `"packages/browser-extension"` to `packageRoots` | hand edit |
| 3 | `packages/browser-extension/package.json` | create; `license` **must** be set or `check:source` fails (`source-inventory.mjs:80`) | create |
| 4 | `tsconfig.standalone.json` + `packages/webui/tsconfig.paths.json` | **regenerate**: `pnpm gen:tsconfig` | ⚠️ generated |
| 5 | `release/public-source.json` | **regenerate**: `node scripts/source-inventory.mjs --write` (review the diff first) | ⚠️ generated |
| 6 | `test/vitest-suites.json` | register every `packages/browser-extension/**/*.test.ts` — mandatory (`vitest-suites.mjs:42-54`) | hand edit |
| 7 | root `package.json` | add `typecheck:browser-extension` (+ `build:`/`test:` as needed) | hand edit |
| 8 | `scripts/verify.mjs` | add step after line 57 (`typecheck:webui`) | hand edit |
| 9 | `release/dependency-licenses.json` | regenerate from `pnpm licenses list --json` if deps added — **not gate-enforced**; exact command **not verified** | best effort |
| 10 | root `package.json` `pnpm.onlyBuiltDependencies` | add any new native credential-store module | hand edit |
| 11 | `release/webui-npm/` | **nothing** — the extension is a store artifact, not an npm file | no-op |

### Blocking constraints discovered

1. **No OS secure credential store exists.** ADR 0019 forbids plaintext fallback; the only store
   today is a `0600` JSON file (`oauth-core`). This is net-new work, not wiring.
2. **The WebUI client may only import `@mavis/shared` / `@mavis/protocol`**
   (`webui-dependency-rules.mjs:2272`). Extension DTOs must be published from `packages/shared`.
3. **No MV3 tooling exists** — manifest, build, bundler config, ID-drift guard are all net-new.
4. **`check:source` will reject a Playwright spec outside `packages/webui/test/browser/`**
   (`vitest-suites.mjs:48`) — decide placement before writing the first extension test.

---

## Working-tree state

Pre-existing, unrelated to this work — left untouched:
`packages/webui/src/client/features/models/{projection/effort-scale.ts, ui/ModelEffortSlider.tsx,
ui/ModelListPanel.tsx, ui/ModelPanel.tsx, ui/models.css}`, `packages/webui/src/client/shell/icons.tsx`,
`packages/webui/test/unit/model-effort-scale.test.ts`.