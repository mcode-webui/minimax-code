import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyWebuiActiveTurn,
  applyWebuiUnreadCounts,
  formatWebuiSessionAge,
  initialWebuiSessionActivity,
  markWebuiSessionRead,
  readWebuiEventSessionId,
  reduceWebuiSessionActivity,
  seedWebuiSessionActivity,
  type WebuiSessionActivityMap,
} from "../../src/client/session-activity.js";
import {
  WebuiProjectList,
  WebuiSessionList,
} from "../../src/client/components/SessionRail.js";
import { WebuiClientFoundationApp } from "../../src/client/components/WebuiClientFoundationApp.js";
import {
  formatWebuiUnreadBadge,
  readWebuiUnreadCounts,
  SESSION_UNREAD_STORAGE_KEY,
  writeWebuiUnreadCounts,
} from "../../src/client/session-unread.js";
import type { WebuiClientSession } from "../../src/client/contracts/session-view.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";

function event(
  type: string,
  payload: Record<string, unknown>,
  timestamp = 1_000,
): WebuiRuntimeEvent {
  return { type, payload, timestamp, source: "test" };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("readWebuiEventSessionId", () => {
  it("reads the session id off the payload", () => {
    expect(readWebuiEventSessionId(event("session.start", { sessionId: "mvs_a" }))).toBe("mvs_a");
  });

  it("yields nothing for an event that names no session", () => {
    // Not an error: a global event simply cannot be attributed to a row.
    expect(readWebuiEventSessionId(event("quota.updated", {}))).toBeUndefined();
    expect(readWebuiEventSessionId(event("quota.updated", { sessionId: 42 }))).toBeUndefined();
    expect(readWebuiEventSessionId(event("quota.updated", { sessionId: "" }))).toBeUndefined();
  });
});

describe("reduceWebuiSessionActivity", () => {
  it("marks a session busy on session.start", () => {
    const next = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }),
    );
    expect(next.mvs_a).toEqual({ lastActivityAt: 1_000, busy: { turnId: "t1", busyReason: "turn" } });
  });

  it("clears busy on every terminal event, not just finish", () => {
    // A row that keeps spinning after an abort or an error is a lie the user
    // acts on, so all four endings have to settle it.
    for (const type of ["session.finish", "session.error", "session.abort", "session.aborted"]) {
      const started = reduceWebuiSessionActivity(
        initialWebuiSessionActivity,
        event("session.start", { sessionId: "mvs_a", turnId: "t1" }),
      );
      const ended = reduceWebuiSessionActivity(started, event(type, { sessionId: "mvs_a" }, 2_000));
      expect(ended.mvs_a?.busy, `${type} must clear busy`).toBeUndefined();
      expect(ended.mvs_a?.lastActivityAt).toBe(2_000);
    }
  });

  it("records activity without touching busy", () => {
    const started = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }),
    );
    const next = reduceWebuiSessionActivity(
      started,
      event("session.status_updated", { sessionId: "mvs_a" }, 5_000),
    );
    expect(next.mvs_a?.busy).toEqual({ turnId: "t1", busyReason: "turn" });
    expect(next.mvs_a?.lastActivityAt).toBe(5_000);
  });

  it("does not touch other sessions' rows", () => {
    // Isolation, not filtering: an event about B must never make A look busy
    // or move A's clock, or a single running turn would light up the whole
    // rail.
    const seeded = seedWebuiSessionActivity(initialWebuiSessionActivity, [
      { sessionId: "mvs_a", updatedAt: 500 },
    ]);
    const next = reduceWebuiSessionActivity(
      seeded,
      event("session.start", { sessionId: "mvs_b", turnId: "t9" }, 1_000),
    );
    expect(next.mvs_a).toEqual({ lastActivityAt: 500 });
    expect(next.mvs_a?.busy).toBeUndefined();
    expect(next.mvs_b?.busy).toEqual({ turnId: "t9", busyReason: "turn" });
  });

  it("ignores an event that names no session", () => {
    const next = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { turnId: "t1" }),
    );
    expect(next).toEqual({});
  });

  it("does not stamp a row for a subagent's todo event", () => {
    // `todo_updated` names the subagent, not the parent. Treating it as parent
    // activity would move the parent's "last active" to a moment the parent
    // was doing nothing.
    const next = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("todo_updated", { sessionId: "mvs_parent", todos: [] }),
    );
    expect(next).toEqual({});
  });

  it("never moves lastActivityAt backwards", () => {
    // An out-of-order or replayed event must not rewind a row to "now" and make
    // a busy session look like it has been idle for an hour.
    const first = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }, 9_000),
    );
    const late = reduceWebuiSessionActivity(first, event("session.status_updated", { sessionId: "mvs_a" }, 1_000));
    expect(late.mvs_a?.lastActivityAt).toBe(9_000);
  });

  it("returns the same object when nothing changed, so the host can skip a render", () => {
    const started = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }),
    );
    // Same type, same turn, same timestamp: no observable difference.
    const again = reduceWebuiSessionActivity(
      started,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }),
    );
    expect(again).toBe(started);
    // An unrelated event is also a no-op, and must not allocate.
    expect(reduceWebuiSessionActivity(started, event("quota.updated", {}))).toBe(started);
  });
});

describe("seedWebuiSessionActivity", () => {
  it("takes first-paint times from the list", () => {
    const next = seedWebuiSessionActivity(initialWebuiSessionActivity, [
      { sessionId: "mvs_a", updatedAt: 7_000 },
    ]);
    expect(next.mvs_a).toEqual({ lastActivityAt: 7_000 });
  });

  it("never invents a busy state", () => {
    // The list carries no turn id. A row that says "running" with nothing
    // behind it is a spinner the user cannot explain or clear.
    const next = seedWebuiSessionActivity(initialWebuiSessionActivity, [
      { sessionId: "mvs_a", updatedAt: 7_000 },
    ]);
    expect(next.mvs_a?.busy).toBeUndefined();
  });

  it("does not let a late list overwrite what the event stream knows", () => {
    // A refresh racing a live turn: the turn started a second ago, and the
    // list's `updatedAt` is older. Seeding blindly would make a running
    // session look idle.
    const live = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }, 9_000),
    );
    const next = seedWebuiSessionActivity(live, [{ sessionId: "mvs_a", updatedAt: 1_000 }]);
    expect(next.mvs_a?.lastActivityAt).toBe(9_000);
    expect(next.mvs_a?.busy).toEqual({ turnId: "t1", busyReason: "turn" });
  });

  it("keeps a busy state across a seed", () => {
    const live = reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }, 9_000),
    );
    const next = seedWebuiSessionActivity(live, [{ sessionId: "mvs_a", updatedAt: 20_000 }]);
    expect(next.mvs_a?.busy).toEqual({ turnId: "t1", busyReason: "turn" });
    expect(next.mvs_a?.lastActivityAt).toBe(20_000);
  });

  it("returns the same object when the list adds nothing new", () => {
    const seeded = seedWebuiSessionActivity(initialWebuiSessionActivity, [
      { sessionId: "mvs_a", updatedAt: 7_000 },
    ]);
    expect(seedWebuiSessionActivity(seeded, [{ sessionId: "mvs_a", updatedAt: 7_000 }])).toBe(seeded);
    expect(seedWebuiSessionActivity(seeded, [])).toBe(seeded);
  });
});

describe("applyWebuiActiveTurn", () => {
  const busy: WebuiSessionActivityMap = {
    mvs_a: { lastActivityAt: 5_000, busy: { turnId: "t1", busyReason: "turn" } },
  };

  it("drops a busy the server says is not there", () => {
    // The event stream left a spinner from a turn that ended while the client
    // was reconnecting. The probe is the only thing that can clear it.
    const next = applyWebuiActiveTurn(busy, "mvs_a", undefined, 9_000);
    expect(next.mvs_a?.busy).toBeUndefined();
    expect(next.mvs_a?.lastActivityAt).toBe(5_000);
  });

  it("adopts the server's reason, including compaction", () => {
    const next = applyWebuiActiveTurn(initialWebuiSessionActivity, "mvs_a", {
      turnId: "t2",
      busyReason: "compaction",
      locallyOwned: false,
    }, 9_000);
    expect(next.mvs_a?.busy).toEqual({ turnId: "t2", busyReason: "compaction" });
  });

  it("leaves lastActivityAt alone", () => {
    // The probe answers "is it running", not "when did it last run". A turn
    // that has been going for ten minutes started ten minutes ago.
    const next = applyWebuiActiveTurn(busy, "mvs_a", {
      turnId: "t1",
      busyReason: "turn",
      locallyOwned: true,
    }, 999_999);
    expect(next.mvs_a?.lastActivityAt).toBe(5_000);
  });

  it("returns the same object when the answer matches what is shown", () => {
    expect(
      applyWebuiActiveTurn(busy, "mvs_a", { turnId: "t1", busyReason: "turn", locallyOwned: true }, 9_000),
    ).toBe(busy);
    expect(applyWebuiActiveTurn(initialWebuiSessionActivity, "mvs_a", undefined, 9_000)).toBe(
      initialWebuiSessionActivity,
    );
  });
});

describe("formatWebuiSessionAge", () => {
  const now = 10 * DAY;

  it("renders the compact units the rail has room for", () => {
    expect(formatWebuiSessionAge(now - 30_000, now)).toBe("now");
    expect(formatWebuiSessionAge(now - 21 * MINUTE, now)).toBe("21m");
    expect(formatWebuiSessionAge(now - 5 * HOUR, now)).toBe("5h");
    expect(formatWebuiSessionAge(now - 3 * DAY, now)).toBe("3d");
  });

  it("falls back to a date past a month", () => {
    expect(formatWebuiSessionAge(now - 90 * DAY, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("does not render a negative age when the clock is behind", () => {
    expect(formatWebuiSessionAge(now + 5 * MINUTE, now)).toBe("now");
  });

  it("truncates rather than rounds, so a row never claims to be older than it is", () => {
    expect(formatWebuiSessionAge(now - 119_000, now)).toBe("1m");
    expect(formatWebuiSessionAge(now - 59 * MINUTE - 59_000, now)).toBe("59m");
  });
});

describe("rail rendering", () => {
  const NOW = 10 * DAY;
  const session = (over: Partial<WebuiClientSession> & { sessionId: string }): WebuiClientSession => ({
    agentName: "main",
    createdAt: 1,
    updatedAt: NOW - 5 * HOUR,
    workspaceDir: "/tmp/project",
    ...over,
  });

  it("shows a spinner and an age on a project row", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiProjectList, {
        page: { sessions: [session({ sessionId: "mvs_a" })] , hasMore: false },
        // `loading` only reaches the "Load more" button, which needs
        // `hasMore && onLoadMore`; this page is neither. Passed explicitly so
        // the fixture is complete rather than accidentally short.
        loading: false,
        // A complete record, not a loose bag. The rail filters on `hidden`,
        // sorts on `pinned`, and derives `updatedAt` from
        // `recentAtMs ?? latestActivityAtMs` — so a partial fixture would let
        // the row keep passing if any of those three were read wrongly. The
        // record's own activity is deliberately 5h old, the same stale figure
        // the session's `updatedAt` carries, which is what makes the `>2h` /
        // not-`>5h` pair below discriminating: the age has to come from the
        // activity map because the project record offers a competing 5h.
        projectRecords: [
          {
            projectId: 1,
            projectKind: "workspace",
            workspaceDir: "/tmp/project",
            pinned: false,
            hidden: false,
            orderIndex: 0,
            recentAtMs: null,
            latestActivityAtMs: NOW - 5 * HOUR,
            sessionCount: 1,
          },
        ],
        // Deliberately NOT the session's `updatedAt`: the row must read the
        // activity map, or a session that ran since the list was fetched would
        // still show the stale time -- and this assertion would not notice.
        activity: { mvs_a: { lastActivityAt: NOW - 2 * HOUR, busy: { turnId: "t1", busyReason: "turn" } } },
        now: NOW,
      }),
    );
    expect(html).toMatch(/webui-rail-spinner/u);
    expect(html).toMatch(/data-webui-session-age="true"/u);
    expect(html).toMatch(/>2h</u);
    expect(html).not.toMatch(/>5h</u);
  });

  it("distinguishes a running session from an idle one", () => {
    const render = (busy: boolean) =>
      renderToStaticMarkup(
        createElement(WebuiSessionList, {
          page: { sessions: [session({ sessionId: "mvs_a" })], hasMore: false },
          loading: false,
          activity: {
            mvs_a: { lastActivityAt: NOW - 5 * HOUR, ...(busy ? { busy: { turnId: "t1", busyReason: "turn" as const } } : {}) },
          },
          now: NOW,
        }),
      );
    // Same row, same age; only the spinner differs. Without the spinner the two
    // states are indistinguishable, which is the whole feature.
    expect(render(true)).toMatch(/webui-rail-spinner/u);
    expect(render(false)).not.toMatch(/webui-rail-spinner/u);
  });

  it("renders nothing extra when the host supplies no activity or clock", () => {
    // The rail is also rendered outside the app (SSR fixtures, snapshots), where
    // there is no subscription. Passing no props must leave those byte-identical.
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [session({ sessionId: "mvs_a" })], hasMore: false },
        loading: false,
      }),
    );
    expect(html).not.toMatch(/webui-rail-session-meta/u);
    expect(html).not.toMatch(/data-webui-session-age/u);
  });

  it("reaches the rail through the app shell, not just through the rail's own props", () => {
    // The wiring test. Every assertion above passes even if the app stops
    // passing `activity`/`now` down, because they hand the props to the rail
    // themselves. Rendering the real shell is what proves the connection.
    const html = renderToStaticMarkup(
      createElement(WebuiClientFoundationApp, {
        label: "webui-foundation",
        sessionPage: {
          sessions: [session({ sessionId: "mvs_a" })],
          hasMore: false,
        },
      }),
    );
    expect(html).toMatch(/data-webui-session-age="true"/u);
  });
});
describe("spinner colour", () => {
  const shellCss = readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "client", "styles", "shell.css"),
    "utf8",
  );
  const start = shellCss.indexOf(".webui-rail-spinner {");
  // Comments are stripped before the "must not contain" assertions: this rule
  // explains in prose why it is not `currentColor` and why not 1.5px, so the
  // rule body without that prose is the only thing those assertions can be
  // about. Matching the raw text would fail on the explanation of the change
  // rather than on the change.
  const rule = shellCss
    .slice(start, shellCss.indexOf("}", start))
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .trim();

  it("is drawn in the accent colour, not the inherited grey", () => {
    // `currentColor` resolves to `--text_default_tertiary`, and a 10px grey
    // ring on a grey rail does not read at all. This is what keeps a later
    // edit from quietly putting the spinner back to inheriting, which is
    // exactly what it was before anyone looked at a screenshot.
    expect(rule).toMatch(/border:\s*2px solid var\(--icon_default_accent\)/u);
    expect(rule).not.toMatch(/currentColor/u);
  });

  it("draws a ring thick enough to see rather than a hairline", () => {
    expect(rule).not.toMatch(/1\.5px/u);
  });

  it("does not reach for a raw hex, which would not follow the theme", () => {
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});

describe("unread badge styling", () => {
  const shellCss = readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "client", "styles", "shell.css"),
    "utf8",
  );
  const start = shellCss.indexOf(".webui-rail-unread-badge {");
  // Same reasoning as the spinner rule: the comment above the badge explains in
  // prose why red is allowed here, so the "no raw hex" assertion is only about
  // the rule body.
  const rule = start < 0
    ? ""
    : shellCss
        .slice(start, shellCss.indexOf("}", start))
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .trim();

  it("exists at all", () => {
    // Without this the three assertions below pass on an empty string, which
    // is the state of the file when the rule is deleted or renamed.
    expect(start).toBeGreaterThan(-1);
    expect(rule.length).toBeGreaterThan(0);
  });

  it("fills with the danger token, not a neutral surface", () => {
    // The whole point of the feature is that it reads as a count. A grey pill
    // with a number on it is a label, and nobody scans the rail for labels.
    expect(rule).toMatch(/background-color:\s*var\(--bg_interaction_danger_primary_default\)/u);
  });

  it("puts the digits on the inverted token so they stay legible", () => {
    expect(rule).toMatch(/color:\s*var\(--text_default_inverted\)/u);
  });

  it("does not reach for a raw hex, which would not follow the theme", () => {
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
describe("unread counts", () => {
  const started = () =>
    reduceWebuiSessionActivity(
      initialWebuiSessionActivity,
      event("session.start", { sessionId: "mvs_a", turnId: "t1" }),
    );

  it("counts a turn that finished in another session", () => {
    const next = reduceWebuiSessionActivity(
      started(),
      event("session.finish", { sessionId: "mvs_a" }, 2_000),
      { activeSessionId: "mvs_other" },
    );
    expect(next.mvs_a?.unread).toBe(1);
  });

  it("restores a stored count that is ahead of the live one", () => {
    // The badge survived a reload and the page is now being rebuilt from a
    // list that knows nothing about counts. Storage is the only thing that
    // still remembers.
    const next = applyWebuiUnreadCounts(
      seedWebuiSessionActivity(initialWebuiSessionActivity, [
        { sessionId: "mvs_a" },
      ] as never),
      { mvs_a: 3 },
      "mvs_other",
    );
    expect(next.mvs_a?.unread).toBe(3);
  });

  it("never lets a restore shrink a count the live stream has reached", () => {
    // The defect. The stored value is written by an earlier run of this same
    // code, so it is only as fresh as the last successful write, while the live
    // value has been counting events since. Overwriting with it let a badge go
    // *down* on its own the moment the rail re-rendered, and a failed write --
    // quota, private mode -- made the stored value permanently behind, so the
    // badge shrank every time the user refreshed or typed in the search box.
    const live = reduceWebuiSessionActivity(
      reduceWebuiSessionActivity(
        started(),
        event("session.finish", { sessionId: "mvs_a" }, 2_000),
        { activeSessionId: "mvs_other" },
      ),
      event("session.start", { sessionId: "mvs_a", turnId: "t2" }),
    );
    const afterTwo = reduceWebuiSessionActivity(
      live,
      event("session.finish", { sessionId: "mvs_a" }, 3_000),
      { activeSessionId: "mvs_other" },
    );
    expect(afterTwo.mvs_a?.unread).toBe(2);

    // Storage still holds the value from before the second turn.
    const restored = applyWebuiUnreadCounts(afterTwo, { mvs_a: 1 }, "mvs_other");
    expect(restored.mvs_a?.unread).toBe(2);
  });

  it("does not count the session the user is sitting in", () => {
    // A badge over the row being read is the fastest way to make a badge stop
    // being read at all.
    const next = reduceWebuiSessionActivity(
      started(),
      event("session.finish", { sessionId: "mvs_a" }, 2_000),
      { activeSessionId: "mvs_a" },
    );
    expect(next.mvs_a?.unread).toBeUndefined();
  });

  it("accumulates across turns", () => {
    let state = started();
    for (const [index, turnId] of ["t1", "t2", "t3"].entries()) {
      state = reduceWebuiSessionActivity(state, event("session.start", { sessionId: "mvs_a", turnId }, 3_000 + index), { activeSessionId: "other" });
      state = reduceWebuiSessionActivity(state, event("session.finish", { sessionId: "mvs_a" }, 3_100 + index), { activeSessionId: "other" });
    }
    expect(state.mvs_a?.unread).toBe(3);
  });

  it("does not count a turn that failed or was aborted", () => {
    // "3 new messages" after a crash is not news, and a run of aborts would
    // otherwise accumulate a count no user can clear by reading.
    for (const type of ["session.error", "session.abort", "session.aborted"]) {
      const next = reduceWebuiSessionActivity(
        started(),
        event(type, { sessionId: "mvs_a" }, 2_000),
        { activeSessionId: "other" },
      );
      expect(next.mvs_a?.unread, type).toBeUndefined();
    }
  });

  it("keeps the count when a status event lands afterwards", () => {
    const finished = reduceWebuiSessionActivity(started(), event("session.finish", { sessionId: "mvs_a" }, 2_000), { activeSessionId: "other" });
    const next = reduceWebuiSessionActivity(finished, event("session.status_updated", { sessionId: "mvs_a" }, 3_000), { activeSessionId: "other" });
    expect(next.mvs_a?.unread).toBe(1);
  });

  it("clears when the user opens the session", () => {
    let state = reduceWebuiSessionActivity(started(), event("session.finish", { sessionId: "mvs_a" }, 2_000), { activeSessionId: "other" });
    state = markWebuiSessionRead(state, "mvs_a");
    expect(state.mvs_a?.unread).toBeUndefined();
    // The rest of the entry survives; reading a session is not forgetting it.
    expect(state.mvs_a?.lastActivityAt).toBe(2_000);
  });

  it("returns the same object when there is nothing to clear", () => {
    const state = started();
    expect(markWebuiSessionRead(state, "mvs_a")).toBe(state);
    expect(markWebuiSessionRead(initialWebuiSessionActivity, "nope")).toBe(
      initialWebuiSessionActivity,
    );
  });

  it("restores stored counts onto a rebuilt map", () => {
    const next = applyWebuiUnreadCounts(initialWebuiSessionActivity, { mvs_a: 3 }, undefined);
    expect(next.mvs_a?.unread).toBe(3);
  });

  it("never restores a badge onto the open session", () => {
    const next = applyWebuiUnreadCounts(initialWebuiSessionActivity, { mvs_a: 3 }, "mvs_a");
    expect(next).toBe(initialWebuiSessionActivity);
  });

  it("ignores non-positive stored counts", () => {
    const next = applyWebuiUnreadCounts(
      initialWebuiSessionActivity,
      { mvs_a: 0, mvs_b: -2 },
      undefined,
    );
    expect(next).toBe(initialWebuiSessionActivity);
  });

  // The three tests below all cover the same contract from different angles: a
  // write that rebuilds an entry to change one field must not drop the others.
  // `busy` already had to be carried across the seed and the status event; the
  // count is the same field with the same obligation, and forgetting it is
  // invisible in a single-turn test.
  const finishedElsewhere = () =>
    reduceWebuiSessionActivity(
      started(),
      event("session.finish", { sessionId: "mvs_a" }, 2_000),
      { activeSessionId: "other" },
    );

  it("keeps the count when the next turn starts", () => {
    const next = reduceWebuiSessionActivity(
      finishedElsewhere(),
      event("session.start", { sessionId: "mvs_a", turnId: "t2" }, 3_000),
      { activeSessionId: "other" },
    );
    expect(next.mvs_a?.unread).toBe(1);
  });

  it("keeps the count when the probe says the session is busy", () => {
    // The probe runs on a timer for every row and its reply can land after a
    // turn has already finished. It exists to repair `busy`; it is not evidence
    // that the user went back and read the session.
    const next = applyWebuiActiveTurn(
      finishedElsewhere(),
      "mvs_a",
      { turnId: "t9", busyReason: "turn", locallyOwned: false },
      3_000,
    );
    expect(next.mvs_a?.unread).toBe(1);
  });

  it("keeps the count when a late list refreshes the row", () => {
    const next = seedWebuiSessionActivity(finishedElsewhere(), [
      { sessionId: "mvs_a", updatedAt: 9_000 },
    ]);
    expect(next.mvs_a?.unread).toBe(1);
  });
});

describe("unread storage", () => {
  function fakeStorage(): Storage & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage & { store: Map<string, string> };
  }

  it("round-trips counts", () => {
    const storage = fakeStorage();
    writeWebuiUnreadCounts({ mvs_a: 2, mvs_b: 0 }, storage);
    expect(readWebuiUnreadCounts(storage)).toEqual({ mvs_a: 2 });
  });

  it("removes the key rather than storing an empty object", () => {
    const storage = fakeStorage();
    writeWebuiUnreadCounts({ mvs_a: 1 }, storage);
    expect(storage.store.size).toBe(1);
    writeWebuiUnreadCounts({}, storage);
    expect(storage.store.size).toBe(0);
  });

  it("drops values that are not positive integers", () => {
    // `unread: NaN` would render a row claiming to be waiting on nothing, so a
    // stored float or string is dropped rather than coerced.
    const storage = fakeStorage();
    storage.setItem(SESSION_UNREAD_STORAGE_KEY, JSON.stringify({ a: 1.5, b: "2", c: -1, d: 3, e: null }));
    expect(readWebuiUnreadCounts(storage)).toEqual({ d: 3 });
  });

  it("survives corrupt storage", () => {
    const storage = fakeStorage();
    storage.setItem(SESSION_UNREAD_STORAGE_KEY, "{not json");
    expect(readWebuiUnreadCounts(storage)).toEqual({});
    storage.setItem(SESSION_UNREAD_STORAGE_KEY, "[1,2,3]");
    expect(readWebuiUnreadCounts(storage)).toEqual({});
  });

  it("degrades to no counts when storage is absent", () => {
    expect(readWebuiUnreadCounts(undefined)).toEqual({});
    expect(() => writeWebuiUnreadCounts({ a: 1 }, undefined)).not.toThrow();
  });

  it("formats the badge, capping past 99", () => {
    expect(formatWebuiUnreadBadge(undefined)).toBe("");
    expect(formatWebuiUnreadBadge(0)).toBe("");
    expect(formatWebuiUnreadBadge(1)).toBe("1");
    expect(formatWebuiUnreadBadge(99)).toBe("99");
    expect(formatWebuiUnreadBadge(100)).toBe("99+");
  });
});

describe("unread badge rendering", () => {
  const NOW = 10 * DAY;
  const session = (over: Partial<WebuiClientSession> & { sessionId: string }): WebuiClientSession => ({
    agentName: "main",
    createdAt: 1,
    updatedAt: NOW - 5 * HOUR,
    workspaceDir: "/tmp/project",
    ...over,
  });

  it("renders a red count instead of the spinner once a turn has finished", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [session({ sessionId: "mvs_a" })], hasMore: false },
        loading: false,
        activity: { mvs_a: { lastActivityAt: NOW - 2 * HOUR, unread: 1 } },
        now: NOW,
      }),
    );
    expect(html).toMatch(/webui-rail-unread-badge/u);
    expect(html).toMatch(/data-webui-unread-badge="1"/u);
    // The spinner is driven by `busy` and not by the count, so a session whose
    // turns have all finished shows the badge and nothing else. (A count and a
    // spinner *do* coexist -- that is the next test's case, a new turn starting
    // on a session that already had unread turns.)
    expect(html).not.toMatch(/webui-rail-spinner/u);
  });

  it("shows the count and the spinner together while a new turn runs", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [session({ sessionId: "mvs_a" })], hasMore: false },
        loading: false,
        activity: {
          mvs_a: { lastActivityAt: NOW, unread: 3, busy: { turnId: "t2", busyReason: "turn" } },
        },
        now: NOW,
      }),
    );
    expect(html).toMatch(/webui-rail-unread-badge/u);
    expect(html).toMatch(/webui-rail-spinner/u);
  });

  it("renders no badge for a read session", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [session({ sessionId: "mvs_a" })], hasMore: false },
        loading: false,
        activity: { mvs_a: { lastActivityAt: NOW - 2 * HOUR, unread: 0 } },
        now: NOW,
      }),
    );
    expect(html).not.toMatch(/webui-rail-unread-badge/u);
  });

  it("caps what the row draws, not just what the formatter returns", () => {
    // The cap is asserted on `formatWebuiUnreadBadge` above, which proves
    // nothing about the row: a rail that interpolated the count itself would
    // render every one of those cases correctly until the 100th. A four-digit
    // pill is also wide enough to shove the session name out of the rail.
    const html = renderToStaticMarkup(
      createElement(WebuiSessionList, {
        page: { sessions: [session({ sessionId: "mvs_a" })], hasMore: false },
        loading: false,
        activity: { mvs_a: { lastActivityAt: NOW - 2 * HOUR, unread: 150 } },
        now: NOW,
      }),
    );
    expect(html).toMatch(/>99\+</u);
    expect(html).not.toMatch(/>150</u);
  });
});

describe("host wiring", () => {
  // Block comments are stripped because this file explains the wiring in prose
  // right above the code, and an assertion that can be satisfied by the prose
  // is not an assertion. Line comments are stripped too, for the `$` anchors
  // below to see the end of an effect; there is no `//` inside any string
  // literal here, which is what makes that safe.
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const appSource = strip(
    readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "client",
        "components",
        "WebuiClientFoundationApp.tsx",
      ),
      "utf8",
    ),
  );
  // The activity slice now lives in the application layer. Its half of each
  // guarantee is asserted alongside the shell's delegation, so neither side can
  // be emptied — the shell stops calling in, or the module stops doing the
  // work — without a red test.
  const railSource = strip(
    readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "client",
        "application",
        "rail-activity.ts",
      ),
      "utf8",
    ),
  );
  // The shell's event handling moved onto the application event coordinator in
  // the atomic ingress flip; its half of the guarantee (the activity reduction)
  // is asserted against the coordinator, the one consumer of the channel.
  const coordinatorSource = strip(
    readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "client",
        "application",
        "event-coordinator.ts",
      ),
      "utf8",
    ),
  );

  /**
   * The `useEffect` block that mentions `marker`, from its `useEffect(` up to
   * the next one.
   *
   * These four are the only assertions in the file that are not behavioural,
   * and the reason is worth stating rather than working around: the webui suite
   * runs in `environment: "node"` with no jsdom, so `renderToStaticMarkup`
   * never runs an effect at all. The unread behaviour itself is covered above
   * against the pure functions; what is left is whether the shell still calls
   * them, and that is a question about the source.
   */
  const effect = (marker: string): string => {
    const at = appSource.indexOf(marker);
    if (at < 0) return "";
    const open = appSource.lastIndexOf("useEffect(", at);
    const close = appSource.indexOf("useEffect(", at);
    return appSource.slice(open < 0 ? 0 : open, close < 0 ? undefined : close).trim();
  };

  it("hands the single event ingress to the application coordinator", () => {
    // The shell no longer opens a `watchEvents` subscription of its own. The
    // application event coordinator is the channel's single consumer and
    // reduces each event into the retained activity slice, so the old
    // "one subscription across session switches" shape is replaced by one
    // subscription that belongs to the application (ticket #45, atomic flip).
    expect(appSource).toMatch(/createWebuiApplication\(/u);
    expect(appSource).toMatch(/createWebuiOpenEventChannel\(watchEvents\)/u);
    // No call site opens a second channel.
    expect(appSource).not.toMatch(/watchEvents\?\.\(/u);

    // The activity reduction lives in the coordinator now, over the same
    // retained reducer the shell used.
    expect(coordinatorSource).toMatch(/reduceWebuiSessionActivity\(/u);

    // And the ref is kept current, so the single subscription always judges
    // the turn against the session the user has open.
    expect(appSource).toMatch(
      /selectedSessionIdRef\.current\s*=\s*selectedSessionId\s*;/u,
    );
  });

  it("clears the count when the user opens a session", () => {
    expect(effect("activityCommands.markRead(")).toMatch(
      /activityCommands\.markRead\(\s*selectedSessionId\s*\)/u,
    );
    expect(railSource).toMatch(
      /markWebuiSessionRead\(\s*current\s*,\s*sessionId\s*\)/u,
    );
  });

  it("persists the counts on every change", () => {
    expect(effect("activityCommands.persistUnreadCounts(")).toMatch(
      /activityCommands\.persistUnreadCounts\(\s*writeWebuiUnreadCounts\s*\)\s*;/u,
    );
    // The positive-count filter moved below the boundary with the writer.
    expect(railSource).toMatch(/write\(\s*counts\s*\)\s*;/u);
  });

  it("re-applies stored counts when the open session changes", () => {
    // The active session is excluded from the restore, so the restore has to
    // run again when the user moves: opening a session marks it read, and
    // arriving at a different one must not inherit that.
    const block = effect("readWebuiUnreadCounts()");
    expect(block).toMatch(/readWebuiUnreadCounts\(\s*\)/u);
    expect(block).toMatch(/activityCommands\.restoreUnreadCounts/u);
    expect(railSource).toMatch(/applyWebuiUnreadCounts/u);
  });

  it("does not re-run the restore every time the rail re-renders", () => {
    // `railPage` is a new object on every refresh and on every keystroke in the
    // search box. With it in this effect's dependencies, each of those re-read
    // storage and re-applied it over the live counts -- so a badge that had
    // counted three turns dropped back to whatever was last written, and a
    // failed write (quota, private mode) made the stored value permanently
    // stale, which turned it into a badge that shrank while the user typed.
    //
    // The re-read is still needed, so the assertion is that the trigger is the
    // session and not the list. Seeding the list is a separate effect that does
    // depend on `railPage`, and is asserted to still exist.
    const block = effect("readWebuiUnreadCounts()");
    expect(block).toMatch(/\}\s*,\s*\[\s*selectedSessionId\s*,?\s*\]\s*\)\s*;?\s*$/u);
    expect(block).not.toMatch(/railPage/u);
    expect(effect("activityCommands.seed(")).toMatch(/railPage/u);
    expect(railSource).toMatch(/seedWebuiSessionActivity/u);
  });

  it("never writes the empty map before the stored counts are read back", () => {
    // This one is a real bug that shipped once and was caught only in a browser.
    // Effects run in declaration order inside a commit, so a writer sitting
    // above the restore serialises the empty map it sees on the first render,
    // `removeItem`s the key, and the restore two lines later reads back nothing.
    // The badge then survives exactly zero reloads, which is the one case
    // persistence exists for. The gate is asserted on both halves: the early
    // return in the writer, and the flag being raised by the restore.
    const writer = effect("activityCommands.persistUnreadCounts(");
    expect(writer).toMatch(/if\s*\(\s*!unreadCountsReady\s*\)\s*return\s*;/u);
    expect(writer).toMatch(/\[\s*sessionActivity\s*,\s*unreadCountsReady\s*,?\s*\]/u);
    const restore = effect("readWebuiUnreadCounts()");
    expect(restore).toMatch(/setUnreadCountsReady\(\s*true\s*\)/u);
  });
});