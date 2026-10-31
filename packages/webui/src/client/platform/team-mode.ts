/**
 * Client-side state for the create-time Agent Team choice.
 *
 * The protocol exposes only `teamModeOff` on create. The WebUI therefore
 * keeps the choice locally for the composer and for the session-list badge;
 * there is no later server signal to reconstruct it.
 */

export interface TeamModeSession {
  readonly id: string;
  readonly teamModeOff?: boolean;
}

export type TeamModeChildSessionReader = (
  sessionId: string,
) => readonly unknown[];

export function isTeamModeLocked(
  session: TeamModeSession,
  getChildSessions: TeamModeChildSessionReader,
): boolean {
  return (
    session.teamModeOff === false || getChildSessions(session.id).length > 0
  );
}

export function parseTeamModeOff(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "boolean" ? value : true;
  } catch {
    return true;
  }
}

export type TeamModeSessionChoices = Readonly<Record<string, boolean>>;

export function parseTeamModeSessionChoices(
  raw: string | null | undefined,
): TeamModeSessionChoices {
  if (raw === null || raw === undefined) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return {};
    const choices: Record<string, boolean> = {};
    for (const [sessionId, choice] of Object.entries(value)) {
      if (typeof choice === "boolean") choices[sessionId] = choice;
    }
    return choices;
  } catch {
    return {};
  }
}

export function teamModeCopy(locale?: string): {
  readonly label: string;
  readonly lockedTip: string;
} {
  const isChinese = (locale ?? "").toLowerCase().startsWith("zh");
  return isChinese
    ? { label: "Agent 团队", lockedTip: "本对话已锁定 Agent 团队" }
    : { label: "Agent Team", lockedTip: "Agent Team locked for this chat" };
}
