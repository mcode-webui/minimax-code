import { realpathSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

interface DirectoryIdentity {
  targetPath: string;
  dev: number;
  ino: number;
}

interface Subscriber {
  onChange(): void;
  onError(): void;
}

interface SharedWatcher {
  watcher: FSWatcher;
  subscribers: Set<Subscriber>;
}

// Registries differ by workspace and selectors but commonly watch the same
// global Skill directories. Native watcher teardown can block the JS thread
// on macOS; evicting one registry must only release its own subscriptions.
const sharedWatchers = new Map<string, SharedWatcher>();

/**
 * The path the watcher is bound to.
 *
 * Windows reports a changed file under its long name, and libuv compares that
 * name against the directory string the watch was given. A directory reached
 * through its 8.3 short alias — which is what a temp directory under a
 * short-named home directory spells — therefore fails libuv's own
 * `!_wcsnicmp(filename, dir, dirlen)` assertion, and that assertion takes the
 * process down rather than raising an error.
 *
 * `realpathSync.native` resolves the alias to the long path; the JavaScript
 * implementation of `realpathSync` does not, so the native one is the one that
 * matters here. A directory that cannot be resolved (it does not exist yet)
 * falls back to the resolved path it was given.
 */
function watchableDirectory(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function subscribeToSkillDirectory(
  target: DirectoryIdentity,
  subscriber: Subscriber,
): { close(): void } {
  const watchPath = watchableDirectory(target.targetPath);
  // Include filesystem identity so replacing a directory at the same path
  // never reuses a watcher still bound to the removed directory.
  const key = JSON.stringify([watchPath, target.dev, target.ino]);
  let shared = sharedWatchers.get(key);
  if (!shared) {
    const subscribers = new Set<Subscriber>();
    const watcher = watch(watchPath, { persistent: false }, () => {
      for (const current of [...subscribers]) current.onChange();
    });
    shared = { watcher, subscribers };
    const created = shared;
    watcher.on('error', () => {
      if (sharedWatchers.get(key) !== created) return;
      sharedWatchers.delete(key);
      const currentSubscribers = [...subscribers];
      subscribers.clear();
      watcher.close();
      for (const current of currentSubscribers) current.onError();
    });
    sharedWatchers.set(key, shared);
  }
  const subscription = shared;
  subscription.subscribers.add(subscriber);
  return {
    close() {
      if (!subscription.subscribers.delete(subscriber)) return;
      if (subscription.subscribers.size > 0) return;
      if (sharedWatchers.get(key) === subscription) sharedWatchers.delete(key);
      subscription.watcher.close();
    },
  };
}
