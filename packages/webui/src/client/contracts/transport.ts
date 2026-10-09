// Browser transport — the single bag of methods the foundation app and the
// composer consume.
//
// Composed from the eight capability ports, one per capability group. It
// declares no method of its own: every operation lives in exactly one port and
// this type only joins them. Every method stays optional — `undefined` means
// "the operation is not wired" (the panel renders the affected area
// conditionally), the transport itself is optional (so a test that renders the
// shell with no transport still gets a "no operations" view), and optional
// inputs stay optional.
//
// No React imports here — this is a pure type that lives in the contracts
// layer so the props layer (app.tsx) and the transport implementation
// (`client/transport.ts`) both import it without crossing boundaries.

import type { SessionPort } from "./session-port.js";
import type { ExecutionPort } from "./execution-port.js";
import type { InteractionPort } from "./interaction-port.js";
import type { WorkspacePort } from "./workspace-port.js";
import type { SettingsPort } from "./settings-port.js";
import type { AccountPort } from "./account-port.js";
import type { PluginPort } from "./plugin-port.js";
import type { TerminalPort } from "./terminal-port.js";

export interface WebuiTransport
  extends SessionPort,
    ExecutionPort,
    InteractionPort,
    WorkspacePort,
    SettingsPort,
    AccountPort,
    PluginPort,
    TerminalPort {}
