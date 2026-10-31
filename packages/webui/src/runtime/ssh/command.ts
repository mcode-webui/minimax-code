// How one SSH invocation is put together.
//
// The transport is the system `ssh` binary, exactly as in Desktop: there is no npm SSH client here,
// and there is no local shell either — the argument vector is passed to `spawn` as a vector, so a
// host name is never a word of a shell command line.
//
// Two rules shape this file:
//
//   * **The remote side is quoted, the local side is validated.** A remote path reaches the
//     remote shell through `quoteRemoteShellArg`, which is the POSIX single-quote rule.
//   * **No user-owned option reaches OpenSSH.** Every `-o` below is fixed here; the person's
//     hostname, port, user and identity file are arguments OpenSSH understands, never options.
import { isSafeSshHostname, isSafeSshPort, isSafeSshUser, isSafeAbsoluteLocalPath } from "./validators.js";
import type { SshEndpointRecord } from "./types.js";

/** Quote one argument for the remote POSIX shell used by OpenSSH. */
export function quoteRemoteShellArg(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

/**
 * The fixed OpenSSH options every invocation carries.
 *
 * `ControlMaster=no` matters: OpenSSH would otherwise join a multiplexed connection the user owns,
 * and this process would then be talking to a channel it does not control. The batch and
 * keep-alive options are Desktop's own.
 */
const SSH_BASE_OPTIONS: readonly string[] = [
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlPersist=no",
  "-o",
  "StrictHostKeyChecking=yes",
];

/** The options a password handshake needs: OpenSSH may ask, and only by password. */
const SSH_PASSWORD_OPTIONS: readonly string[] = [
  "-o",
  "BatchMode=no",
  "-o",
  "PreferredAuthentications=password",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "NumberOfPasswordPrompts=1",
];

/** The options a key-only handshake needs. */
const SSH_KEY_OPTIONS: readonly string[] = ["-o", "BatchMode=yes"];

export interface BuildSshArgsOptions {
  /** Whether a password is staged for this host. */
  readonly password?: boolean;
  /**
   * Whether the far side gets a pseudo-terminal.
   *
   * A command (`-T`) reads and writes plainly; a terminal (`-tt`) gets one, which is what makes
   * the remote shell interactive and what lets a later resize reach the remote pty.
   */
  readonly tty?: boolean;
}

/**
 * The argument vector for one `ssh` invocation.
 *
 * The destination is the alias for an `ssh_config` endpoint and `user@host` for a manual one. The
 * overrides a discovered endpoint carries are passed as OpenSSH options, so an alias in
 * `~/.ssh/config` still resolves through the config file.
 */
export function buildSshArgs(
  endpoint: SshEndpointRecord,
  options: BuildSshArgsOptions = {},
): string[] {
  const args: string[] = [options.tty ? "-tt" : "-T"];
  if (options.password) args.push(...SSH_PASSWORD_OPTIONS);
  else args.push(...SSH_KEY_OPTIONS);
  args.push(...SSH_BASE_OPTIONS);

  if (endpoint.kind === "ssh_config") {
    const alias = endpoint.alias;
    if (!alias) throw new Error("invalid_ssh_endpoint");
    if (endpoint.host) args.push("-o", `HostName=${endpoint.host}`);
    if (endpoint.port !== undefined) args.push("-p", String(endpoint.port));
    if (endpoint.identityFile) {
      args.push("-i", endpoint.identityFile, "-o", "IdentitiesOnly=yes");
    }
    args.push(alias);
    return args;
  }

  const host = endpoint.host;
  if (!host || !isSafeSshHostname(host)) throw new Error("invalid_ssh_endpoint");
  if (endpoint.username !== undefined && !isSafeSshUser(endpoint.username)) {
    throw new Error("invalid_ssh_endpoint");
  }
  if (endpoint.port !== undefined && !isSafeSshPort(endpoint.port)) {
    throw new Error("invalid_ssh_endpoint");
  }
  if (endpoint.identityFile !== undefined && !isSafeAbsoluteLocalPath(endpoint.identityFile)) {
    throw new Error("invalid_ssh_endpoint");
  }
  if (endpoint.port !== undefined) args.push("-p", String(endpoint.port));
  if (endpoint.identityFile) {
    args.push("-i", endpoint.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(endpoint.username ? `${endpoint.username}@${host}` : host);
  return args;
}

/** The marker a probe answer carries, so a banner or a MOTD cannot be read as a probe. */
export const SSH_PROBE_MARKER = "__WEBUI_SSH_PROBE_V1__";

/**
 * The remote command that answers a probe.
 *
 * It reports the host name, the login and the home directory, and nothing else: a probe verifies
 * that the SSH transport works, not what is installed on the far side.
 */
export function buildRemoteProbeCommand(): string {
  return [
    `printf '${SSH_PROBE_MARKER}\\n'`,
    `printf 'hostname=%s\\n' "$(hostname 2>/dev/null || true)"`,
    `printf 'remote_user=%s\\n' "$(id -un 2>/dev/null || true)"`,
    `printf 'home_dir=%s\\n' "$HOME"`,
  ].join("; ");
}

/** The marker a directory listing carries. */
export const SSH_DIRECTORY_MARKER = "__WEBUI_SSH_DIRECTORY_V1__";

/**
 * The remote command that lists one directory.
 *
 * The listing is NUL separated, so a file name with a space or a newline cannot forge a field.
 * The canonical path is resolved on the far side, so the browser shows the real path it got.
 */
export function buildRemoteDirectoryListCommand(path: string): string {
  const quotedPath = quoteRemoteShellArg(path);
  return [
    `printf '${SSH_DIRECTORY_MARKER}\\0'`,
    `if canonical="$(CDPATH= cd ${quotedPath} 2>/dev/null && pwd -P)"`,
    `then printf 'status=ready\\0path=%s\\0' "$canonical"`,
    `for entry in "$canonical"/* "$canonical"/.[!.]* "$canonical"/..?*`,
    `do`,
    `[ -e "$entry" ] || [ -L "$entry" ] || continue`,
    `if [ -L "$entry" ]; then kind=symlink`,
    `elif [ -d "$entry" ]; then kind=directory`,
    `elif [ -f "$entry" ]; then kind=file`,
    `else kind=other`,
    `fi`,
    `printf '%s\\0%s\\0' "$kind" "$entry"`,
    `done`,
    `else printf 'status=not_found\\0'`,
    `fi`,
  ].join("; ");
}

/**
 * The remote command a terminal runs.
 *
 * The shell is the login shell of the account, and the working directory is the folder the project
 * is rooted in. A path that no longer exists fails the session instead of opening a shell in the
 * home directory, because a terminal in the wrong folder looks like a working one. Without a
 * path the shell opens where the account's home directory is.
 */
export function buildRemoteTerminalCommand(path?: string): string {
  const steps: string[] = [];
  if (path) steps.push(`CDPATH= cd ${quoteRemoteShellArg(path)} || exit $?`);
  steps.push(`if [ -n "$SHELL" ] && [ -x "$SHELL" ]`);
  steps.push(`then exec "$SHELL" -l`);
  steps.push(`elif command -v bash >/dev/null 2>&1`);
  steps.push(`then exec bash -l`);
  steps.push(`else exec sh -l`);
  steps.push(`fi`);
  return steps.join("; ");
}
