// The value checks every SSH input passes before it reaches a command line.
//
// These are Desktop's own checks (`ssh-runtime/config.js`): a host name, a user name, a port, a
// local path and a remote path each have a shape, and a value outside that shape is rejected
// instead of quoted. Nothing here builds a shell string — the remote side is quoted by
// `quoteRemoteShellArg` in `command.ts` — but a value that is not a host name has no business
// becoming an argument either.
import { SshRuntimeError } from "./errors.js";

/** OpenSSH's askpass reads at most 1024 bytes, including the terminating newline. */
const MAX_PASSWORD_BYTES = 1023;

/** A control character would end a line OpenSSH reads, or hide one from the person reading it. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A saved host's alias: the same shape a `Host` entry may carry in `~/.ssh/config`. */
export function isSafeSshAlias(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(value);
}

/** A host name or an IP address, as OpenSSH accepts it. */
export function isSafeSshHostname(value: string): boolean {
  if (value.length === 0 || value.length > 255 || value.startsWith("-")) return false;
  if (/[^A-Za-z0-9.:[\]_-]/u.test(value)) return false;
  return !hasControlCharacter(value);
}

/** A login name. */
export function isSafeSshUser(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(value);
}

export function isSafeSshPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A path on this machine: absolute, printable, no control characters. */
export function isSafeAbsoluteLocalPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (hasControlCharacter(value)) return false;
  return /^(?:\/[\s\S]+|[A-Za-z]:[\\/][\s\S]+)$/u.test(value);
}

/**
 * A path on the remote machine.
 *
 * `..` is refused rather than resolved: the path is a folder the person picked in the remote
 * browser, and a path that walks out of the folder it was picked in is not one they picked.
 */
export function isSafeAbsoluteRemotePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096 || !value.startsWith("/")) return false;
  if (hasControlCharacter(value)) return false;
  return !value.split("/").some((segment) => segment === "..");
}

/** A staged password: no newline, no NUL, and inside OpenSSH's askpass limit. */
export function isValidSshPassword(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\r\n]/u.test(value) &&
    value.indexOf(String.fromCharCode(0)) === -1 &&
    Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES
  );
}

export function requireSafeAlias(value: string): string {
  if (!isSafeSshAlias(value)) {
    throw new SshRuntimeError("invalid_input", "主机别名只能包含字母、数字、点、下划线和连字符。");
  }
  return value;
}
