# WebUI capability gaps

Recorded 2026-10-09 from a read-only investigation of two failed image-generation
sessions. Every claim below cites the file and line that supports it, or is marked
as unverified.

Status: investigation only. Nothing here has been fixed.

## How this was found

Three sessions, same prompt (`帮我生成一张图片，新海诚风格…`), same machine:

| Session | Client | Outcome |
| --- | --- | --- |
| `mvs_22ce80b2a1ac47f5b92f35351031334d` | TUI | Image generated |
| `mvs_2b267ce8b95c46eaae1b06cccd2d181f` | Desktop | No image |
| `mvs_fa56d45bf03c440883bbb3653045a472` | WebUI | No image |

Read from `~/.minimax/v2/sqlite/runtime-state.sqlite`, table
`local_runtime_message_rows`. Both failing sessions contain no `<media` delivery
row, so "generated an image" is judged by the persisted transcript, not by the
model's own claim.

The TUI session reached `connector__matrix__generate_image` through
`mcode-tools connector`. The Desktop session reached the same CLI and was
rejected:

```
error: Embedded mcode-tools requires MCODE_AUTH_PROVIDER=shared-broker from the MCode host.
```

It then tried `MCODE_AUTH_PROVIDER=shared-broker` as an explicit prefix, scanned
`/proc/<pid>/environ` for the host's variables, ran `mcode-tools auth status`
("authentication is not configured"), and fell back to a keyless public
endpoint — where it hit an ignored `prompt` parameter and then a missing
PIL/numpy/ImageMagick. It never delivered an image.

## Gap 1 — connector/App tools are unreachable (unfixed, WebUI and Desktop alike)

**The injection code already exists. Nothing calls it.**

`packages/webui/src/server/mcode-tools-environment.ts` is a complete
implementation. `configureWebuiMcodeToolsChildEnvironment` (line 20) projects
five private host variables onto the CLI's public contract, including
`MCODE_AUTH_PROVIDER = "shared-broker"` (line 37) and the broker endpoint and
capability file (lines 38-39). `activateWebuiMcodeToolsEnvironment` (line 49)
installs them on `process.env` and prepends the command directory to `PATH`.

`packages/webui/src/server/mcode-tools-entry.ts:2` imports the child-environment
configuration. `packages/webui/src/server/mcode-tools.ts` and
`packages/webui/src/server/index.ts` both re-export from it.

The launcher is where the chain breaks. `scripts/run-webui-server.mjs` forwards
`process.env` verbatim to the child process (lines 14-22) and constructs the host
with only `dataDir` and `appVersion` (lines 40-43). It never sets any
`__MAVIS_MCODE_TOOLS_*` key.

A repository-wide search for `__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT` returns six
files: the two WebUI modules, the two TUI modules
(`packages/tui/src/cli/mcode-tools-environment.ts`, plus its two launchers), and
one test. **No launcher in `scripts/` produces those keys.** So
`configureWebuiMcodeToolsChildEnvironment` finds `values.every(v => !v)` true at
line 29 and returns `false` — the documented no-op path.

Net effect: WebUI's `mcode-tools` child process gets no broker environment, so
the CLI refuses every connector call.

### Two distinct failures, often conflated

The WebUI session also failed to *discover* the route. Its reasoning was:

> `I don't see one in my tool list.`

Connector tools are not injected into the tool list — they are discovered by
running `mcode-tools connector tools`. The model must first load the
`mcode-tools-master` skill to learn that. In the failing WebUI transcript the
agent instead loaded `minimax-code-product` and searched `~/.minimax/mcp.json`,
then `mmx` CLI credentials, i.e. it looked for MCP servers and API keys rather
than the connector registry.

Fixing only the broker environment would make the CLI work but would not tell the
model to use it. **Discovery and reachability are separate seams.**

### The `0b2ff19` premise

The claim that this worked before the harness added WebUI identity support
(`0b2ff19`, 2026-10-09) is **not supported by the transcript store.** WebUI
sessions are identifiable by `workspace_dir LIKE '%/.minimax/sessions/%'` (73
such rows). Only two ever reference `mcode-tools connector`:

- `mvs_2b267ce8b95c46eaae1b06cccd2d181f` — the failing Desktop session above.
- `mvs_5f3b89a7dfd34208a2647d03040f2ebc` — 2026-09-30, which does predate
  `0b2ff19`.

The 2026-09-30 session loaded `mcode-tools-master` and produced a local HTML page
delivered at `localhost:8099/index.html`, but its transcript contains no
`generate_image` result and no `<media` row; the assets were sourced, not
generated. It left a `/tmp/mcode-tools-1000/mcode-tools.log` trace, which is the
same directory the 2026-10-09 Desktop session went looking in.

Unverified: whether that session had a working broker that failed for an unrelated
reason, or never had one. Its logs are outside this investigation's scope.

### Access-control note

WebUI is a loopback-reachable browser surface. Granting it the connector broker
means an agent running in that browser can call every App the user has connected
on this machine. That is the same class of concern the identity plan recorded for
Computer Use ("a single local user is not the same thing as no access control",
`docs/webui/webui-client-identity-plan.md`). No decision has been recorded for
connector. Do not treat this as a mechanical fix.

## Gap 2 — declared identity cells are never consumed by the WebUI package

The identity work (`0b2ff19`, then `3f9c01d`) gave WebUI its own row in
`packages/local-runtime/src/runtime/runtime-owner-policy.ts`. The resolver now
reports `runtimeOwnerKind: "webui"` with a `webui` row whose cells differ from
`tui` in six places. Measured by invoking the resolver directly:

```
wiring.schedulerHost:            false -> true
wiring.cronService:              false -> true
execution.restricted:            true  -> false
execution.memoryFeature:         false -> true
execution.mavisFeatureBundle:    false -> true
execution.executesTerminalControl: true -> false
```

Seven cells are inherited unchanged from `tui` (verified in the same run).

Searching `packages/webui/src` for each cell name returns **zero files for all
thirteen**. That is expected and correct: these cells are consumed by the
harness, not by the client. They are recorded here so the list is not mistaken
for a wiring gap.

Two follow-on observations that are *not* covered by the six changed cells:

- `promptProfile` stays `'tui'`, so WebUI loads
  `packages/local-runtime-v2/assets/agents/_v2/tui/SYSTEM.md.hbs`. That asset
  states `You are a coding agent running in the MiniMax Code terminal` (line 2)
  and, on the `surface.cli` branch, `You are the user's active MiniMax Code
  terminal conversation` (line 27). It also lacks the `## Media Output` section
  (~30 lines) that `coding/SYSTEM.md.hbs` carries, which is the section that
  governs how deliverables are surfaced to a user. `catalog.ts:341` throws when a
  `promptProfile === 'tui'` surface prompt is missing, so WebUI is a hard
  dependency on that asset.
- `packages/local-runtime/src/api/hosted-agent-capability-factory.ts:34` is the
  only remaining production branch on `capabilityProfile`. It sits inside
  `execution.restricted ? {…} : undefined`, and WebUI's `restricted` is `false`,
  so it is structurally unreachable for WebUI. It is still required by the TUI
  client and must not be deleted.

## Gap 3 — services gated to `electron`, unreachable by any non-Desktop client

These branch on `runtimeOwnerKind` outside the policy system. They cost WebUI
the capability today and are invisible in the thirteen-cell table.

| Site | Gate | What WebUI loses |
| --- | --- | --- |
| `local-runtime-v2/src/service/miniapp/composition.ts:32` | `runtimeOwnerKind !== undefined && !== 'electron'` → `undefined` | miniapp service |
| `local-runtime-v2/src/runtime.ts:879` | `greetingEnabled: runtimeOwnerKind === 'electron'` | startup greeting |
| `local-runtime-v2/src/service/llm-context-inspector/initialize.ts:36-37` | `!== 'electron' && !forceCaptureEnabled` → `undefined` (TUI can opt in via `MAVIS_TUI_LLM_CONTEXT_INSPECTOR=1`) | context inspector |
| `local-runtime-v2/src/application/session/session-title-policy.ts:31` | `titleSafetyBypass` defaults to `'tui' \|\| 'cli'` | see below |
| `local-runtime/src/runtime/host-factory.ts` | `=== "electron" \|\| …` | V1 compatibility surface |

The miniapp and inspector gates are intentional — the plan classifies them as
service availability rather than client policy (`webui-client-identity-plan.md`,
"Cut — `miniapp`"). Recording them here so a future reader does not rediscover
them.

`session-title-policy.ts:31` is different in kind: it reads `input.ownerPolicy
?.execution.titleSafetyBypass` first and only falls back to the owner-kind test.
WebUI's row sets `titleSafetyBypass: true`, so it is unaffected. Verified by
reading the fallback chain, not by execution.

## Not investigated

- Whether Desktop has the same launcher gap. Its transcript shows the same CLI
  rejection, but Desktop's launcher is outside this repository.
- Live behaviour. All findings above are read from source and persisted
  transcripts. No WebUI host was started and no tool call was executed.
- Whether `mcode-tools` supports a non-broker authentication mode that would
  avoid the access-control question in Gap 1.
