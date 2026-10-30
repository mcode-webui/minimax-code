// Browser transport — the single bag of methods the foundation app and the
// composer consume.
//
// Composed from the fifteen business capability ports. It
// declares no method of its own: every operation lives in exactly one port and
// this type only joins them. Every method stays optional — `undefined` means
// "the operation is not wired" (the panel renders the affected area
// conditionally), the transport itself is optional (so a test that renders the
// shell with no transport still gets a "no operations" view), and optional
// inputs stay optional.
//
// No React imports here — this is a pure type that lives in the contracts
// layer so the props layer and the transport implementation
// (`client/platform/transport.ts`) both import it without crossing
// boundaries.

import type { SessionPort } from "../features/sessions/contracts/session-port.js";
import type { TurnExecutionPort } from "../features/turn/contracts/execution-port.js";
import type { ComposerPort } from "../features/composer/contracts/command-port.js";
import type { ShellEventPort } from "../features/shell/contracts/watch-port.js";
import type { InteractionPort } from "../features/interactions/contracts/interaction-port.js";
import type { GoalPort } from "../features/goal/contracts/goal-port.js";
import type { WorkspacePort } from "../features/workspace/contracts/workspace-port.js";
import type { SettingsPort } from "../features/settings/contracts/settings-port.js";
import type { ModelsPort } from "../features/models/contracts/provider-port.js";
import type { TranscriptPort } from "../features/transcript/contracts/session-read-port.js";
import type { AccountPort } from "../features/account/contracts/account-port.js";
import type { PluginPort } from "../features/plugins/contracts/plugin-port.js";
import type { SchedulingPort } from "../features/scheduling/contracts/scheduling-port.js";
import type { TerminalPort } from "../features/terminal/contracts/terminal-port.js";
import type { BrowserPort } from "../features/browser/contracts/browser-port.js";
import type { MiniAppPort } from "../features/miniapp/contracts/miniapp-port.js";
import type { ChannelPort } from "../features/channel/contracts/channel-port.js";
import type { RemoteControlPort } from "../features/remote-control/contracts/remote-control-port.js";
import type { SshPort } from "../features/ssh/contracts/ssh-port.js";

export interface WebuiTransport
  extends SessionPort,
    TranscriptPort,
    TurnExecutionPort,
    ComposerPort,
    ShellEventPort,
    InteractionPort,
    GoalPort,
    WorkspacePort,
    SettingsPort,
    ModelsPort,
    AccountPort,
    PluginPort,
    SchedulingPort,
    TerminalPort,
    BrowserPort,
    MiniAppPort,
    ChannelPort,
    RemoteControlPort,
    SshPort {}
