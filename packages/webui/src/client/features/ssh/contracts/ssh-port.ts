// The SSH capability port.
//
// The transport seam of the SSH business. Every member stays optional: a build whose transport
// does not carry the SSH operations yet leaves the member `undefined`, and the owner turns that
// into one stated refusal instead of a crash or an empty list that reads as "you have no hosts".
//
// The request and response types are the shared wire DTOs. This file may not name the runtime's
// SSH records — `shared/contracts/ssh.ts` is what the browser is allowed to know, and the harness
// adapter is where the conversion happens.
import type {
  WebuiSshConnection,
  WebuiSshDiscovery,
  WebuiSshListDirectoriesRequest,
  WebuiSshListDirectoriesResult,
  WebuiSshProbeResult,
  WebuiSshProject,
  WebuiSshProjectRequest,
  WebuiSshProjectResult,
  WebuiSshRemoveResult,
  WebuiSshSaveConnectionRequest,
  WebuiSshSaveConnectionResult,
  WebuiSshSetEnabledRequest,
  WebuiSshTerminalSession,
} from "../../../../shared/contracts/ssh.js";

export interface SshPort {
  readonly listSshConnections?: () => Promise<readonly WebuiSshConnection[]>;
  readonly saveSshConnection?: (
    request: WebuiSshSaveConnectionRequest,
  ) => Promise<WebuiSshSaveConnectionResult>;
  readonly setSshConnectionEnabled?: (
    request: WebuiSshSetEnabledRequest,
  ) => Promise<WebuiSshSaveConnectionResult>;
  readonly removeSshConnection?: (request: {
    readonly alias: string;
  }) => Promise<WebuiSshRemoveResult>;
  readonly discoverSshHosts?: () => Promise<WebuiSshDiscovery>;
  readonly probeSshConnection?: (request: {
    readonly alias: string;
  }) => Promise<WebuiSshProbeResult>;
  readonly listSshDirectories?: (
    request: WebuiSshListDirectoriesRequest,
  ) => Promise<WebuiSshListDirectoriesResult>;
  readonly listSshProjects?: () => Promise<readonly WebuiSshProject[]>;
  readonly saveSshProject?: (request: WebuiSshProjectRequest) => Promise<WebuiSshProjectResult>;
  readonly removeSshProject?: (request: {
    readonly id: string;
  }) => Promise<WebuiSshProjectResult>;
  readonly openSshTerminal?: (request: {
    readonly alias: string;
    readonly path?: string;
  }) => Promise<WebuiSshTerminalSession>;
  readonly writeSshTerminal?: (request: {
    readonly terminalId: string;
    readonly data: string;
  }) => Promise<{ readonly accepted: boolean }>;
  readonly resizeSshTerminal?: (request: {
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  }) => Promise<{ readonly accepted: boolean }>;
  readonly closeSshTerminal?: (request: {
    readonly terminalId: string;
  }) => Promise<{ readonly accepted: boolean }>;
  /**
   * The remote terminal's output.
   *
   * A watch, not a promise of the server's envelope: the subscription outlives the render that
   * opened it, and detaching has to release the remote PTY rather than merely stop reading it.
   */
  readonly watchSshTerminal?: (
    request: { readonly terminalId: string },
    onFrame: (frame: { readonly data: string }) => void,
  ) => () => void;
}
