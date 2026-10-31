// The composer's context ring.
//
// The ring is the composer's only readout of how much of the context window a
// session has used. It hangs off the toolbar, it is hidden by a setting the
// user can turn off, and it is otherwise shown whenever the session HAS
// context — a session that has produced anything at all has a window that is
// partly spent, and a reader who has to guess whether a session has any
// context is guessing about the thing the ring exists to say.
//
// These specs drive the real path a reloaded session takes: the transcript's
// history page carries the server's context snapshot, and the composer reads it
// out of that page.
//
// The usage records below are spelled the way the RUNTIME persists them —
// `totalTokens` / `contextWindow`, the names the session message's own view
// uses — because that is what a reloaded session actually answers with. A
// readout that only understood the protocol's snake_case pair drew nothing at
// all for every session the user opened.
//
// NOTE: the fixture setup runs INSIDE the page, so it may not call anything
// defined in this file — `configureFixture` stringifies the function and
// injects it, and a call to a module-scope helper is a ReferenceError there.
// Every staged object is written out in full.

import { expect } from "@playwright/test";

import { configureFixture, openApp, switchSession, test } from "./harness.mjs";

const ring = (page) => page.getByTestId("composer-context-usage");

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
});

test("the ring appears for a reloaded session whose usage is spelled the runtime's way", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { totalTokens: 12000, contextWindow: 200000 },
      },
    });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");

  await expect(ring(page)).toBeVisible();
  await expect(ring(page)).toHaveAttribute("aria-label", /上下文窗口使用 6%/u);
});

test("the ring appears for the protocol's snake_case spelling too", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { total_tokens: 12000, context_window: 200000 },
      },
    });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");

  await expect(ring(page)).toBeVisible();
});

test("the ring appears as soon as a session has any context at all", async ({ page }) => {
  // A single token spent is still a spent window, and a ring that only appears
  // once the session is "big enough" hides the answer exactly when the reader
  // has just asked the question.
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { totalTokens: 1, contextWindow: 200000 },
      },
    });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");

  await expect(ring(page)).toBeVisible();
  await expect(ring(page)).toHaveAttribute("aria-label", /上下文窗口使用 0%/u);
});

test("the ring appears when the window is unknown, and says so", async ({ page }) => {
  // A model whose window the runtime does not know still has a spent window.
  // The ring is the statement "this session has context", and that statement
  // does not need a percentage to be true.
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { totalTokens: 12000 },
      },
    });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");

  await expect(ring(page)).toBeVisible();
  await expect(ring(page)).toHaveAttribute("aria-label", /窗口大小未知/u);
});

test("the ring stays hidden for a session with no context at all", async ({ page }) => {
  // Nothing spent is nothing to report: there is no window to be partly full.
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: { status: "empty" },
    });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");

  await expect(ring(page)).toHaveCount(0);
});

test("the ring follows the history when the session's page is read again", async ({ page }) => {
  // The reading belongs to the session's history, and the ring shows what the
  // history says NOW.
  //
  // It used to be a copy: the composer read the page once and wrote the
  // reading into the live turn's record, so a second read of the same page
  // changed nothing on screen and the ring kept answering with a stale
  // number. A copy of a reading is only as fresh as the copy.
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { totalTokens: 12000, contextWindow: 200000 },
      },
    });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");
  await expect(ring(page)).toHaveAttribute("aria-label", /上下文窗口使用 6%/u);

  // The session's history now reports a bigger reading, and the page is read
  // again.
  await page.evaluate(() => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { totalTokens: 50000, contextWindow: 200000 },
      },
    });
  });
  await switchSession(page, "A");
  await switchSession(page, "B");

  await expect(ring(page)).toHaveAttribute("aria-label", /上下文窗口使用 25%/u);
});

test("the ring appears when the history page finally lands, and not before", async ({ page }) => {
  // The page is read late, and the reading has to arrive with it. A readout
  // that asked the page once, at mount, and gave up when the answer was not
  // there yet left the ring blank for the rest of the session's life.
  await configureFixture(page, () => {
    window.__fixture.setPage("B", {
      messages: [
        { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
      contextSnapshot: {
        status: "live",
        usage: { totalTokens: 12000, contextWindow: 200000 },
      },
    });
    // Every read of this session's page is held, so the page lands only when
    // the test says so.
    window.__fixture.delayEvery("getMessages", { id: "B" });
  });
  await openApp(page, "#session=A");
  await switchSession(page, "B");

  await expect(ring(page)).toHaveCount(0);

  await page.evaluate(() => {
    const held = window.__fixture.pending.filter(
      (entry) => entry.operation === "getMessages" && entry.body?.id === "B",
    );
    for (const entry of held) {
      entry.resolve({
        messages: [
          { msgId: "history-B", role: "assistant", msgContent: "History B synthetic", timestamp: 1_700_000_000_002 },
        ],
        hasMore: false,
        contextSnapshot: {
          status: "live",
          usage: { totalTokens: 12000, contextWindow: 200000 },
        },
      });
    }
  });

  await expect(ring(page)).toBeVisible();
  await expect(ring(page)).toHaveAttribute("aria-label", /上下文窗口使用 6%/u);
});
