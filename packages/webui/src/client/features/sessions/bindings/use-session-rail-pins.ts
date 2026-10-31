// The rail's pins: the pinned sessions, and the pins and names of projects.
//
// "Pin" is the word for this everywhere now (ADR 0028 § Further Notes): an
// *overlay* in this client is a floating layer above the page, and a pinned
// session is not one. The module was called `use-session-rail-overlays` while the
// glossary still used the word for both, which is exactly the collision the
// decision record resolves.
//
// It used to live in the shell's rail hook, which read the platform storage
// adapter for it. The state belongs to Sessions — the pins are part of the
// catalogue the rail presents — and the read belongs behind the feature's own
// surface, so both moved here; the adapter arrives as the injected capability
// the composition root supplies.
//
// The storage keys, the stored format and the normalization stay in the
// platform adapter (`platform/storage.ts`) — they are the persisted
// contract with earlier builds, not this feature's invention. What this module
// states is the surface it needs, so neither it nor the shell names a platform
// module. The behaviour is unchanged: a toggle writes through and returns the
// whole map, and the state starts from what storage already holds.
import { useCallback, useState } from "react";

/** The per-session overlay retained by the rail. */
export type WebuiSessionPinKind = "pins";

/** What the overlays need from browser storage, satisfied by that adapter. */
export interface WebuiRailPinStorage {
  readonly readSessionPins: (
    kind: WebuiSessionPinKind,
  ) => Record<string, boolean>;
  readonly toggleSessionPins: (
    kind: WebuiSessionPinKind,
    sessionId: string,
  ) => Record<string, boolean>;
  readonly readProjectPins: () => Record<string, boolean>;
  readonly toggleProjectPin: (projectKey: string) => Record<string, boolean>;
  readonly readProjectNames: () => Record<string, string>;
  readonly writeProjectName: (
    projectKey: string,
    name: string,
  ) => Record<string, string>;
}

export interface SessionRailPins {
  readonly pinnedSessions: Record<string, boolean>;
  readonly pinnedProjects: Record<string, boolean>;
  readonly projectNames: Record<string, string>;
  /** Toggle one session's pin and take the persisted map as truth. */
  readonly toggleSessionPins: (
    kind: WebuiSessionPinKind,
    sessionId: string,
  ) => void;
  readonly toggleProjectPin: (projectKey: string) => void;
  /** Persist a project's display name. The prompt that asks for it stays UI. */
  readonly renameProject: (projectKey: string, name: string) => void;
}

export function useSessionRailPins(
  storage: WebuiRailPinStorage,
): SessionRailPins {
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, boolean>>(
    () => storage.readSessionPins("pins"),
  );
  const [pinnedProjects, setPinnedProjects] = useState<Record<string, boolean>>(
    () => storage.readProjectPins(),
  );
  const [projectNames, setProjectNames] = useState<Record<string, string>>(
    () => storage.readProjectNames(),
  );
  const toggleSessionPins = useCallback(
    (kind: WebuiSessionPinKind, sessionId: string) => {
      const toggled = storage.toggleSessionPins(kind, sessionId);
      setPinnedSessions(toggled);
    },
    [storage],
  );
  const toggleProjectPin = useCallback(
    (projectKey: string) => {
      setPinnedProjects(storage.toggleProjectPin(projectKey));
    },
    [storage],
  );
  const renameProject = useCallback(
    (projectKey: string, name: string) => {
      setProjectNames(storage.writeProjectName(projectKey, name));
    },
    [storage],
  );
  return {
    pinnedSessions,
    pinnedProjects,
    projectNames,
    toggleSessionPins,
    toggleProjectPin,
    renameProject,
  };
}
