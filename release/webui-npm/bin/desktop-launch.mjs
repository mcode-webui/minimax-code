// Desktop-host handoff for the one-time native-directory grant.
//
// The grant rides in the page URL fragment. A host that embeds the page cannot
// rely on the system browser opening that URL, so it names a private file; the
// launcher writes the URL there with owner-only permissions and never logs it.
// The HTTP route still checks the grant, pairing cookie and browser key.

import { randomUUID } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nativeDirectoryLaunchUrl } from './native-directory-picker.mjs';

const FILE_MODE = 0o600;

export function browserOpenEnabled(setting, tty) {
  const normalized = setting?.trim().toLowerCase();
  return normalized === undefined || normalized === ''
    ? Boolean(tty)
    : !['0', 'false', 'no', 'off', 'never'].includes(normalized);
}

export async function writeLaunchUrlFile(file, url) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error('WEBUI_LAUNCH_URL_FILE must be an absolute path');
  }
  const temporary = path.join(
    path.dirname(file),
    '.' + path.basename(file) + '.' + randomUUID() + '.tmp',
  );
  try {
    await writeFile(temporary, url, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
    // POSIX mode is the contract; Windows keeps the file under the user
    // profile instead of exposing a group/other-readable location.
    await chmod(temporary, FILE_MODE);
    try {
      await rename(temporary, file);
    } catch (error) {
      // Windows rename does not replace an existing target.
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await rm(file, { force: true });
      await rename(temporary, file);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function handoffDesktopLaunchUrl({ desktopHost, picker, file, browserUrl }) {
  if (!desktopHost || !picker || !file) return { kind: 'skipped' };
  try {
    await writeLaunchUrlFile(file, nativeDirectoryLaunchUrl(browserUrl, picker.grant));
    return { kind: 'written' };
  } catch (error) {
    // A stale file would make the host open a launch URL with another process's
    // grant. Remove it so the host's missing-file fallback is unambiguous.
    if (path.isAbsolute(file)) await rm(file, { force: true }).catch(() => {});
    return { kind: 'failed', error };
  }
}