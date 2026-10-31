# Runtime owner identity

The WebUI is a declared client identity, not a borrowed `tui` row: `runtimeOwnerKind: "webui"`
resolves its own row in `packages/local-runtime/src/runtime/runtime-owner-policy.ts` (ADR 0013 makes
harness code editable for this work; ADR 0007's read-only reasoning assumed the work would go
upstream).

The `webui` row is the Desktop (`electron`) row. Every cell carries Desktop's value except
`wiring.channelService`, which stays off until the browser client has a surface to bind an IM
channel with. The two rows are kept in step by
`packages/local-runtime/test/unit/runtime-owner-policy.test.ts`, which asserts that they differ on
exactly that one cell.

| Cell | `tui` | `webui` (= Desktop) | Why |
| --- | --- | --- | --- |
| `wiring.schedulerHost` | false | true | The runtime host exposes scheduler capability, and the WebUI's `scheduling` business is the surface that uses it ([ADR 0027](../adr/0027-the-webui-is-a-scheduler-host-for-scheduled-tasks.md)) |
| `wiring.cronService` | false | true | The runtime host exposes cron capability without the Electron owner, and the WebUI reaches it through the six `*CronTask*` operations |
| `execution.restricted` | true | false | The WebUI is not a restricted runtime |
| `execution.memoryFeature` | false | true | The memory collection opens for this client |
| `execution.mavisFeatureBundle` | false | true | Same class of feature bundle as the terminal client |
| `execution.executesTerminalControl` | true | false | A browser client cannot run terminal control sequences |
| `wiring.browserActivation` | explicit-config | desktop-plugin | Browser control comes from the installed `browser-use` plugin's `browser.use` host binding, and the built-in `browser` tool is exposed under the `mcp_browser` alias |
| `wiring.remoteSkillHub` | false | true | The skill market reads the remote catalogue the way Desktop does. The gate used to compare owner kinds inline, so every browser client fell back to the local install ledger and showed no browsable skills |
| `execution.promptProfile` | tui | desktop | The WebUI loads the shared `_v2/<appMode>/SYSTEM.md.hbs` asset and the workspace prompt context, like Desktop |
| `execution.promptSurfaceDefault` | cli | interactive | The WebUI has a browser panel, a workspace panel and a Mini App presenter; `cli` told the agent it had no interactive surface |
| `execution.reviewPolicy` | tui | neither | A browser client takes neither the command-line nor the terminal review bundle |
| `execution.titleSafetyBypass` | true | false | Generated titles go through the safety filter again, like every non-terminal client |

`ownsV2Runtime` is set explicitly rather than inherited: `tui` gets it from a `cli || tui` clause the
`webui` row is not in. Both expressions answer `true` for this client.

`wiring.channelService` is the one cell that still differs from Desktop: the runtime assembles the
IM channel service for a desktop owner, but the WebUI has no screen to bind a channel with, so
turning it on would start a service nobody can configure. The runtime capabilities the WebUI does
not expose are recorded in `.temp/desktop-webui-capability-gaps.md`.

Two consequences of the Desktop alignment are worth stating here, because they are visible to the
person using the browser:

- Browser control is now plugin-gated, exactly as on Desktop. The `browser-use` plugin supplies the
  `browser.use` host binding; without it installed, the Agent has no browser tool. The runtime
  injects `DESKTOP_PLUGIN_DISABLED_GUIDANCE` into the prompt in that case.
- The Agent's prompt is the shared desktop one, so the prompt context flag `profile.tui` is false and
  the surface reads as `interactive`.

The Mini App service cell (ADR 0020) is implemented: `wiring.miniAppService` is `true` here, and the
capability gate reads it instead of comparing owner kinds.

## Two smaller facts the row system carries

- `RuntimeOwnerRow` has three states, not two: `absent` (no kind declared), a declared kind, and
  `unknown` (a kind string that is not in `RUNTIME_OWNER_KINDS`), which resolves a distinct row. The
  service gates and the compatibility gate disagree about what an absent owner means; the explicit
  rows are what keeps that disagreement from reaching the WebUI.
- **Identity is not access control.** The WebUI is a loopback-reachable browser surface, and enabling
  memory, cron or Computer Use for it means an agent running in that browser can act on this machine.
  That is the same class of concern ADR 0004 addresses by binding loopback-only; a single local user
  is not the same thing as no access control.

The cells themselves are read by the harness, not by this package. Searching `packages/webui/src` for
each cell name returns nothing, and that is correct — see [`../known-gaps.md`](../known-gaps.md).
