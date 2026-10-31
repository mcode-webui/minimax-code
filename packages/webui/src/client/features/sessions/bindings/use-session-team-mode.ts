// The Agent Team choice as Sessions owns it.
//
// It used to be three pieces of shell state plus a platform type import: the
// default flag, the per-session choices and a write-back effect, read straight
// off the browser storage adapter. The value decides how a session is created
// and the rail badges a row with it, so the state belongs to the business that
// owns the catalogue and the read belongs behind its own surface; the adapter
// arrives as the injected capability. The transitions are unchanged, including
// the write-back of the default on every change.
import { useCallback, useEffect, useState } from "react";

/** `sessionId → team-mode-off`, as persisted for the sessions the user chose. */
export type WebuiTeamModeChoices = Readonly<Record<string, boolean>>;

/** What the choice needs from browser storage, satisfied by that adapter. */
export interface WebuiTeamModeStorage {
  readonly readTeamModeOff: () => boolean;
  readonly writeTeamModeOff: (value: boolean) => void;
  readonly readTeamModeSessionChoices: () => WebuiTeamModeChoices;
  readonly writeTeamModeSessionChoice: (
    sessionId: string,
    value: boolean,
  ) => void;
}

export interface SessionTeamMode {
  /** The persisted default, used by a slot that has no recorded choice. */
  readonly teamModeOff: boolean;
  /** The choice in force for one slot: the session's own, else the default. */
  readonly teamModeOffFor: (sessionId: string | undefined) => boolean;
  /**
   * Record the choice a creation was submitted with. The value is the request's
   * captured one rather than the default read at completion: changing the default
   * while a creation is in flight must not rewrite what the session was created
   * with. Storage first, then the state the rail renders from, exactly as
   * the shell's create effect did in that order.
   */
  readonly recordSessionTeamMode: (sessionId: string, teamModeOff: boolean) => void;
}

export function useSessionTeamMode(storage: WebuiTeamModeStorage): SessionTeamMode {
  const [teamModeOff, setTeamModeOff] = useState(storage.readTeamModeOff);
  const [choices, setChoices] = useState<WebuiTeamModeChoices>(
    storage.readTeamModeSessionChoices,
  );
  useEffect(() => {
    storage.writeTeamModeOff(teamModeOff);
  }, [storage, teamModeOff]);
  const teamModeOffFor = useCallback(
    (sessionId: string | undefined) =>
      sessionId ? choices[sessionId] ?? teamModeOff : teamModeOff,
    [choices, teamModeOff],
  );
  const recordSessionTeamMode = useCallback(
    (sessionId: string, off: boolean) => {
      storage.writeTeamModeSessionChoice(sessionId, off);
      setChoices((current) => ({ ...current, [sessionId]: off }));
    },
    [storage],
  );
  return { teamModeOff, teamModeOffFor, recordSessionTeamMode };
}
