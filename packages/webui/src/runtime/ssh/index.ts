// The SSH runtime, composed.
//
// The whole vertical lives here: the saved hosts, the projects rooted on them, the remote folder
// browser and the remote terminal. The service owns the data directory and the transport; the
// harness adapter in `runtime/harness/ssh.ts` forwards to what this module returns and converts
// the records into the wire DTOs.
//
// Nothing in this module is reachable from the browser: the browser never sees a credential, never
// spawns a process and never names a path on a remote machine.
import path from "node:path";

import { createSshAskpassService, type SshAskpassService } from "./askpass.js";
import { createSshConnectionService, type SshConnectionService } from "./connection-service.js";
import {
  createSshConnectionRepository,
  sshConnectionStorePath,
  type SshConnectionRepository,
} from "./connection-repository.js";
import { createSshCredentialStore, type SshCredentialStore } from "./credentials.js";
import {
  DEFAULT_SSH_DISCOVERY_DEPENDENCIES,
  discoverSshHosts,
  type SshDiscoveryDependencies,
} from "./host-discovery.js";
import { createSshProjectService, type SshProjectService } from "./project-service.js";
import {
  createSshProjectRepository,
  sshProjectStorePath,
  type SshProjectRepository,
} from "./project-repository.js";
import { createSshTerminalService, type SshTerminalService } from "./terminal.js";
import { createSystemSshTransport, type SshTransport } from "./transport.js";
import type { SshDiscoveryRecord } from "./types.js";

export interface SshRuntime {
  readonly connections: SshConnectionService;
  readonly projects: SshProjectService;
  readonly terminals: SshTerminalService;
  /** The hosts in `~/.ssh/config`. */
  readonly discovery: () => Promise<SshDiscoveryRecord>;
  /** Release the terminals and the askpass helper. */
  readonly dispose: () => Promise<void>;
}

export interface CreateSshRuntimeOptions {
  /** The runtime's data directory. The stores live in its `ssh/` subdirectory. */
  readonly dataDir: string;
  /** The transport. Defaults to the system `ssh` binary. */
  readonly transport?: SshTransport;
  /** The dependencies the discovery reads `~/.ssh/config` with. */
  readonly discovery?: SshDiscoveryDependencies;
}

export async function createSshRuntime(options: CreateSshRuntimeOptions): Promise<SshRuntime> {
  const transport = options.transport ?? createSystemSshTransport();
  const credentials: SshCredentialStore = createSshCredentialStore();

  // The askpass helper needs a directory of its own and a socket, so it is created once and
  // shared. A platform that cannot run it still serves every host that does not need a password.
  let askpass: SshAskpassService | undefined;
  try {
    askpass = await createSshAskpassService({
      rootDir: path.join(options.dataDir, "ssh"),
      credentials,
    });
  } catch {
    askpass = undefined;
  }

  const connectionRepository: SshConnectionRepository = createSshConnectionRepository(
    sshConnectionStorePath(options.dataDir),
  );
  const projectRepository: SshProjectRepository = createSshProjectRepository(
    sshProjectStorePath(options.dataDir),
  );

  const connections = createSshConnectionService({
    repository: connectionRepository,
    projects: projectRepository,
    transport,
    credentials,
    ...(askpass ? { askpass } : {}),
  });
  const projects = createSshProjectService({
    repository: projectRepository,
    connections: connectionRepository,
    transport,
    credentials,
    ...(askpass ? { askpass } : {}),
  });
  const terminals = createSshTerminalService({
    connections: connectionRepository,
    projects: projectRepository,
    transport,
    credentials,
    ...(askpass ? { askpass } : {}),
  });

  return {
    connections,
    projects,
    terminals,
    discovery: () => discoverSshHosts(options.discovery ?? DEFAULT_SSH_DISCOVERY_DEPENDENCIES),
    dispose: async () => {
      terminals.dispose();
      credentials.clear();
      await askpass?.dispose();
    },
  };
}

export type { SshConnectionService, SshProjectService, SshTerminalService };
export type { SshConnectionRecord, SshDiscoveryRecord, SshEndpointRecord, SshProbeRecord, SshProjectRecord, SshTerminalSessionRecord } from "./types.js";
