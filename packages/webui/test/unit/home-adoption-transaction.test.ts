// Home adoption as one committed transaction.
//
// The transaction moves four things at once: the home record (stream, sending,
// interaction slices), the composer's home slot (draft and recorded turns), the
// selected session, and the scope's selected-view lease. It is driven here by the
// production path — the task use case's `submit`, which is what a first message
// and a plugin-chat creation both call — followed by the selection the caller
// makes, because the selection belongs to composition.
//
// Two properties matter to a subscriber and both are asserted here: it notifies
// ONCE, and no notified snapshot is a mixed identity — the selected session and
// the record that holds the turn agree in every one of them.

import { describe, expect, it } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiPortSlices } from "../../src/client/application/port-slices.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../../src/client/features/composer/application/composer-history.js";
import type { WebuiApplicationState } from "../../src/client/application/state.js";
import type { WebuiClientSessionResumer } from "../../src/client/features/turn/contracts/execution-port.js";

function application() {
  const app = createWebuiApplication({
    openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
    turns: { resumeSession: (async () => undefined) as unknown as WebuiClientSessionResumer },
    // The creation capability the use case drives. Nothing else is wired, so the
    // completion stops at the transfer and the composer slot — no catalogue read,
    // exactly the shape the assertion below is about.
    slices: createWebuiPortSlices({
      createSession: async () => ({ sessionId: "s1" }),
    }),
  });
  return app;
}

/** The production completion: the use case creates and adopts, the caller selects. */
async function createFirstSession(app: ReturnType<typeof application>): Promise<void> {
  const outcome = await app.taskSessions.submit({ name: "main" });
  expect(outcome.kind).toBe("created");
  // Selection belongs to composition, and the use case says whether the
  // navigation claim that started the creation is still current.
  app.select("s1");
}

/** Every snapshot a subscriber was told about, in order. */
function observe(app: ReturnType<typeof application>) {
  const seen: WebuiApplicationState[] = [];
  const detach = app.subscribe(() => {
    seen.push(app.getSnapshot());
  });
  return { seen, detach };
}

describe("home adoption", () => {
  it("moves the record, the draft and the selection in one notification", async () => {
    const app = application();
    app.start({ initialSessionId: undefined });

    // A turn that belongs to the home slot, and a draft beside it.
    app.store.updateSession(WEBUI_HOME_SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    app.composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "half-written");
    const { seen } = observe(app);

    await createFirstSession(app);

    // One notification: nothing renders a half-moved state.
    expect(seen).toHaveLength(1);

    const after = seen[0]!;
    const home = after.sessions.get(WEBUI_HOME_SESSION_KEY);
    const adopted = after.sessions.get("s1");
    // The live record moved onto the created session…
    expect(adopted?.sending).toBe(true);
    // …the home slot no longer carries it (migration clears the source)…
    expect(home?.sending ?? false).toBe(false);
    // …and the selection moved with it, in the same snapshot.
    expect(after.selectedSessionId).toBe("s1");
    app.dispose();
  });

  it("never notifies a snapshot whose selection and record disagree", async () => {
    const app = application();
    app.start({ initialSessionId: undefined });
    app.store.updateSession(WEBUI_HOME_SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    const { seen } = observe(app);

    await createFirstSession(app);

    for (const snapshot of seen) {
      const selected = snapshot.selectedSessionId;
      if (selected === undefined) continue;
      // A mixed identity is a snapshot that says the user is on a session whose
      // record does not (yet) hold the turn being adopted.
      const carriesTurn = snapshot.sessions.get(selected)?.sending === true;
      const homeStillCarriesIt =
        snapshot.sessions.get(WEBUI_HOME_SESSION_KEY)?.sending === true;
      expect(carriesTurn || !homeStillCarriesIt).toBe(true);
    }
    app.dispose();
  });

  it("adopts the composer draft and releases the home scope", async () => {
    const app = application();
    app.start({ initialSessionId: undefined });
    app.composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "half-written");

    await createFirstSession(app);

    expect(app.composer.readDraft("s1")).toBe("half-written");
    expect(app.composer.readDraft(WEBUI_COMPOSER_HOME_KEY)).toBe("");
    // The selection's lease moved with the selection, so the adopted session is
    // the one the scope recognises as selected.
    expect(app.sessionScope.selected()).toBe("s1");
    expect(app.sessionScope.kinds("s1")).toContain("selected-view");
    app.dispose();
  });
});
