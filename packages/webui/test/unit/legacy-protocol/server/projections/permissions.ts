export interface WebuiSessionProjection {
  readonly permissions: readonly Record<string, unknown>[];
  readonly questionnaire?: Record<string, unknown>;
}

export interface WebuiProjectionState {
  readonly sessions: Readonly<Record<string, WebuiSessionProjection>>;
}

export const initialProjectionState: WebuiProjectionState = { sessions: {} };

export function projectPermissionEvent(
  state: WebuiProjectionState,
  event: { readonly type: string; readonly payload: Record<string, unknown> },
): WebuiProjectionState {
  const sessionId = readString(event.payload, "sessionId");
  // A session-less interaction cannot be associated safely when two browser
  // sessions are active, so it must not mutate global state.
  if (!sessionId) return state;
  const current = state.sessions[sessionId] ?? { permissions: [] };
  let permissions = current.permissions;
  let questionnaire = current.questionnaire;

  if (event.type === "permission.ask") {
    permissions = [...current.permissions, { ...event.payload, sessionId }];
  } else if (event.type === "permission.resolved") {
    const requestId = readString(event.payload, "requestId");
    if (!requestId) return state;
    permissions = current.permissions.filter(
      (permission) => readString(permission, "requestId") !== requestId,
    );
  } else if (event.type === "questionnaire.ask") {
    const requestId =
      readString(event.payload, "requestId") ?? readString(event.payload, "id");
    questionnaire = {
      ...event.payload,
      sessionId,
      ...(requestId ? { requestId } : {}),
    };
  } else if (
    event.type === "questionnaire.dismiss" ||
    event.type === "questionnaire.superseded"
  ) {
    const requestId =
      readString(event.payload, "requestId") ?? readString(event.payload, "id");
    if (!requestId) return state;
    const currentRequestId = current.questionnaire
      ? readString(current.questionnaire, "requestId") ??
        readString(current.questionnaire, "id")
      : undefined;
    if (currentRequestId !== requestId) return state;
    questionnaire = undefined;
  } else {
    return state;
  }

  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        permissions,
        ...(questionnaire ? { questionnaire } : {}),
      },
    },
  };
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
