// The WebUI application state container (plan §7.1 `client/application/`).
//
// This module declares the *shape* of the state the application owns and the
// initial value. It is deliberately free of React (the layer matrix forbids
// `application` from importing the presentation host) and of any concrete
// transport: the store that mutates it and the coordinators that decide *when*
// live in sibling modules.
//
// Write authority lives with the store, not here; this file only says what a
// session's application state is. The session's live execution facts reuse the
// existing mechanism/view types (`WebuiStreamState`) and the existing domain
// activity map (`WebuiSessionActivityMap`) rather than re-declaring them, which
// is what keeps a single projection of each fact.

import type { WebuiGoal } from "../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import type { WebuiSessionActivityMap } from "../session-activity.js";
import { initialWebuiSessionActivity } from "../session-activity.js";
import { initialWebuiStreamState } from "../stream.js";
import type { WebuiStreamState } from "../stream.js";

/**
 * The application's per-session record: the slices the effect reducer already
 * owns (`WebuiEffectState`) plus the `sending` flag the composer renders from.
 * The effect coordinator writes all of these through the store's writers, so
 * one session has exactly one writer of record.
 */
export interface WebuiApplicationSessionState {
  readonly stream: WebuiStreamState;
  readonly sending: boolean;
  readonly permissions: readonly WebuiPendingPermission[];
  readonly questionnaire: WebuiQuestionnaireRequest | undefined;
  readonly goal: WebuiGoal | undefined;
}

export const initialWebuiApplicationSessionState: WebuiApplicationSessionState =
  {
    stream: initialWebuiStreamState,
    sending: false,
    permissions: [],
    questionnaire: undefined,
    goal: undefined,
  };

/**
 * The whole application snapshot. `sessions` is the single map of per-session
 * runtime state — the store never keeps a second copy — and `activity` is the
 * retained domain reduction over the process-event stream.
 */
export interface WebuiApplicationState {
  readonly sessions: ReadonlyMap<string, WebuiApplicationSessionState>;
  readonly activity: WebuiSessionActivityMap;
  readonly selectedSessionId?: string;
}

export const initialWebuiApplicationState: WebuiApplicationState = {
  sessions: new Map(),
  activity: initialWebuiSessionActivity,
};

/** Key a turn started on the home screen uses until its session exists. */
export const WEBUI_HOME_SESSION_KEY = "__webui-home__";
