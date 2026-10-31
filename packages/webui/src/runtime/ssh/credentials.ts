// The staged password.
//
// Desktop keeps a password in its encrypted store and hands it to OpenSSH through an askpass
// helper. The WebUI service has no OS keychain to encrypt into — it is a loopback service, not an
// Electron main process — so the password is staged **in memory only**:
//
//   * it is never written to the data directory,
//   * it never travels back to the browser, and
//   * it disappears with the process.
//
// The consequence is stated rather than hidden: a host that needs a password has to be handed one
// again after the service restarts. Storing it in plaintext on disk to avoid that would be a worse
// trade than asking once more.
import { SshRuntimeError } from "./errors.js";
import { isValidSshPassword } from "./validators.js";

export interface SshCredentialStore {
  /** Stage a password for one host. The previous one, if any, is replaced. */
  stage(alias: string, password: string): void;
  /** The staged password for one host, if there is one. */
  get(alias: string): string | undefined;
  /** Forget one host's password. */
  remove(alias: string): void;
  /** Forget every password. */
  clear(): void;
}

export function createSshCredentialStore(): SshCredentialStore {
  const staged = new Map<string, string>();
  return {
    stage(alias, password) {
      if (!isValidSshPassword(password)) {
        throw new SshRuntimeError(
          "credential_unavailable",
          "密码不可用：密码不能为空、不能包含换行，且不能超过 1023 字节。",
        );
      }
      staged.set(alias, password);
    },
    get: (alias) => staged.get(alias),
    remove: (alias) => {
      staged.delete(alias);
    },
    clear: () => staged.clear(),
  };
}
