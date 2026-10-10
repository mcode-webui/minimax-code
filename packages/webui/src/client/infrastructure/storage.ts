// Browser storage IO (plan §7.2 `client/infrastructure/storage.ts`; ticket #49
// criterion 6).
//
// The browser persistence half of the former `client/session-unread.ts`: the
// storage key, the read that validates every stored value, and the write that
// keeps only positive counts. It decides no unread business rule — the badge
// format lives in `projection/unread-badge.ts` and the ordering lives with the
// commands that call this module — it only reads and writes what it is given.
//
// Every access is wrapped: storage may be absent (SSR, private mode) or throw
// on quota, and a failure degrades to "no counts" rather than taking the rail
// down with it.

import { isNoProjectFlag } from "../no-project.js";
import {
  parseTeamModeOff,
  parseTeamModeSessionChoices,
  type TeamModeSessionChoices,
} from "../team-mode.js";

export const SESSION_UNREAD_STORAGE_KEY = "mavis-session-unread";
export const MODEL_FAVORITES_KEY = "webui:model-favorites:v1";
export const NO_PROJECT_STORAGE_KEY = "mavis-no-project";
export const TEAM_MODE_STORAGE_KEY = "mavis-team-mode";
export const TEAM_MODE_SESSION_STORAGE_KEY = "mavis-team-mode:sessions:v1";
export const WEBUI_COMPOSER_STATE_KEY = "webui.composer.state.v1";

function browserStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export interface WebuiBrowserStorage {
  readonly readFavoriteModels: (normalize: (value: unknown) => string[]) => string[];
  readonly writeFavoriteModels: (ids: readonly string[], normalize: (value: unknown) => string[]) => void;
  readonly readNoProjectFlag: () => boolean;
  readonly writeNoProjectFlag: (value: boolean) => void;
  readonly readTeamModeOff: () => boolean;
  readonly writeTeamModeOff: (value: boolean) => void;
  readonly readTeamModeSessionChoices: () => TeamModeSessionChoices;
  readonly writeTeamModeSessionChoice: (sessionId: string, value: boolean) => void;
  readonly loadComposer: <T>(parse: (raw: string | null | undefined) => T) => T;
  readonly saveComposer: <T>(state: T, serialize: (state: T, keepKeys?: readonly string[]) => string, keepKeys?: readonly string[]) => void;
}

/** Browser persistence boundary. Pure parsing and pruning remain in projection/value modules. */
export function createWebuiBrowserStorage(
  storage: Storage | undefined = browserStorage(),
): WebuiBrowserStorage {
  const readFavoriteModels = (normalize: (value: unknown) => string[]): string[] => {
    if (!storage) return [];
    try {
      const raw = storage.getItem(MODEL_FAVORITES_KEY);
      return raw ? normalize(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  };
  const readTeamChoices = (): TeamModeSessionChoices => {
    if (!storage) return {};
    return parseTeamModeSessionChoices(storage.getItem(TEAM_MODE_SESSION_STORAGE_KEY));
  };
  return {
    readFavoriteModels,
    writeFavoriteModels: (ids, normalize) => {
      if (!storage) return;
      try {
        storage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(normalize(ids)));
      } catch {
        // Preferences are best-effort; the in-memory selection remains usable.
      }
    },
    readNoProjectFlag: () => {
      if (!storage) return false;
      try {
        return isNoProjectFlag(storage.getItem(NO_PROJECT_STORAGE_KEY));
      } catch {
        return false;
      }
    },
    writeNoProjectFlag: (value) => {
      if (!storage) return;
      try {
        if (value) storage.setItem(NO_PROJECT_STORAGE_KEY, "true");
        else storage.removeItem(NO_PROJECT_STORAGE_KEY);
      } catch {
        // Storage can be unavailable or full; retain the in-memory choice.
      }
    },
    readTeamModeOff: () => storage ? parseTeamModeOff(storage.getItem(TEAM_MODE_STORAGE_KEY)) : true,
    writeTeamModeOff: (value) => storage?.setItem(TEAM_MODE_STORAGE_KEY, JSON.stringify(value)),
    readTeamModeSessionChoices: readTeamChoices,
    writeTeamModeSessionChoice: (sessionId, value) => {
      if (!storage) return;
      storage.setItem(TEAM_MODE_SESSION_STORAGE_KEY, JSON.stringify({ ...readTeamChoices(), [sessionId]: value }));
    },
    loadComposer: (parse) => {
      if (!storage) return parse(undefined);
      try {
        return parse(storage.getItem(WEBUI_COMPOSER_STATE_KEY));
      } catch {
        return parse(undefined);
      }
    },
    saveComposer: (state, serialize, keepKeys) => {
      if (!storage) return;
      try {
        storage.setItem(WEBUI_COMPOSER_STATE_KEY, serialize(state, keepKeys));
      } catch {
        // Draft/history persistence is best-effort; the live composer keeps working.
      }
    },
  };
}

export function readWebuiUnreadCounts(
  storage: Storage | undefined = browserStorage(),
): Record<string, number> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SESSION_UNREAD_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const counts: Record<string, number> = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A stored value is only a count if it is a finite non-negative integer.
      // Anything else -- an object, a string, a negative, a float -- is dropped
      // rather than coerced, because `unread: NaN` would render a row that
      // claims to be waiting on nothing.
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        counts[sessionId] = value;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

export function writeWebuiUnreadCounts(
  counts: Readonly<Record<string, number>>,
  storage: Storage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    const entries = Object.entries(counts).filter(([, count]) => count > 0);
    if (entries.length === 0) storage.removeItem(SESSION_UNREAD_STORAGE_KEY);
    else storage.setItem(SESSION_UNREAD_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable or over quota; the in-memory count still shows.
  }
}
