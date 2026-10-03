import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyWebuiActiveTurn,
  formatWebuiSessionAge,
  initialWebuiSessionActivity,
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
import type { WebuiClientSession } from "../../src/client/contracts.js";
import type { WebuiRuntimeEvent } from "../../src/server/port.js";

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
        projectRecords: [{ workspaceDir: "/tmp/project", name: "project" }],
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