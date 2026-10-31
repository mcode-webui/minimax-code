// The browser panel's state transitions.
//
// These are the decisions the panel cannot make in a browser without a DOM:
// which frame survives, what happens when a tab navigates under it, and how much
// a live stream is allowed to accumulate. The view renders whatever this file
// returns, so every property asserted here is a property the panel has.

import { describe, expect, it } from "vitest";

import type {
  WebuiBrowserImageFrame,
  WebuiBrowserTargetId,
  WebuiBrowserTargetList,
} from "../../src/shared/contracts/browser.js";
import {
  initialWebuiBrowserPanelState,
  reduceWebuiBrowserPanelState,
  selectWebuiBrowserFrame,
  selectWebuiBrowserStreamTarget,
  webuiBrowserStreamTargetKey,
  selectedWebuiBrowserRunTarget,
  webuiBrowserFrameDataUrl,
} from "../../src/client/features/browser/projection/browser-state.js";
import {
  webuiBrowserFrameKey,
  type WebuiBrowserPanelState,
} from "../../src/client/features/browser/contracts/browser-panel.js";

function target(overrides: Partial<WebuiBrowserTargetId> = {}): WebuiBrowserTargetId {
  return {
    surface: "isolated-chromium",
    browserId: "chromium-1",
    targetId: "tab-1",
    generation: 3,
    ...overrides,
  };
}

function frame(overrides: Partial<WebuiBrowserImageFrame> = {}): WebuiBrowserImageFrame {
  return {
    target: target(),
    data: "AAAA",
    format: "png",
    sequence: 1,
    ...overrides,
  };
}

/**
 * A panel showing `page`, with one frame already delivered for it.
 *
 * `page` is the client's cell: the tab the person is looking at, which is what the
 * panel shows and what a gesture is bound to.
 */
function showingPage(page: WebuiBrowserTargetId = target()): WebuiBrowserPanelState {
  const viewing = reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
    type: "page-viewed",
    target: page,
  });
  return reduceWebuiBrowserPanelState(viewing, { type: "frame", frame: frame({ target: page }) });
}

describe("the frame buffer", () => {
  it("keeps only the newest frame per target", () => {
    // A live stream pushes a frame per visual change, so an append-only buffer
    // would grow for as long as the panel is open. The bound is structural here:
    // one entry per target key, whatever arrives afterwards.
    let state = showingPage();
    for (let sequence = 2; sequence <= 40; sequence += 1) {
      state = reduceWebuiBrowserPanelState(state, {
        type: "frame",
        frame: frame({ sequence, data: `QUJD${sequence}` }),
      });
    }

    expect(Object.keys(state.frames)).toHaveLength(1);
    expect(selectWebuiBrowserFrame(state)?.sequence).toBe(40);
    // Base64 alphabet only: the frame's bytes go into a `data:` URL verbatim, so
    // this is also the shape the panel is willing to render.
    expect(webuiBrowserFrameDataUrl(selectWebuiBrowserFrame(state))).toBe(
      "data:image/png;base64,QUJD40",
    );
  });

  it("holds one frame per target rather than one per target page", () => {
    // The key excludes the generation on purpose, so a tab that navigated
    // replaces its entry instead of adding a second one.
    const before = target({ generation: 3 });
    const after = target({ generation: 4 });
    let state = reduceWebuiBrowserPanelState(showingPage(before), {
      type: "frame",
      frame: frame({ target: before, sequence: 5 }),
    });
    state = reduceWebuiBrowserPanelState(state, {
      type: "frame",
      frame: frame({ target: after, sequence: 1 }),
    });

    expect(webuiBrowserFrameKey(before)).toBe(webuiBrowserFrameKey(after));
    expect(Object.keys(state.frames)).toHaveLength(1);
    expect(selectWebuiBrowserFrame(state)?.target.generation).toBe(4);
  });
});

describe("generation awareness", () => {
  it("drops a frame older than the generation being shown", () => {
    // The panel moved to generation 4; a frame for generation 3 is a picture of
    // the page that has already been replaced. Displaying it is the exact
    // failure ADR 0019 names: the panel shows one page while the Agent drives
    // another.
    const shown = target({ generation: 4 });
    const state = reduceWebuiBrowserPanelState(showingPage(shown), {
      type: "frame",
      frame: frame({ target: target({ generation: 3 }), sequence: 9 }),
    });

    expect(selectWebuiBrowserFrame(state)?.target.generation).toBe(4);
    expect(state.droppedFrameCount).toBe(1);
  });

  it("drops a reordered frame rather than going backwards in the stream", () => {
    const held = reduceWebuiBrowserPanelState(showingPage(), {
      type: "frame",
      frame: frame({ sequence: 12 }),
    });
    const state = reduceWebuiBrowserPanelState(held, {
      type: "frame",
      frame: frame({ sequence: 11, data: "STALE" }),
    });

    expect(selectWebuiBrowserFrame(state)?.data).toBe("AAAA");
    expect(state.droppedFrameCount).toBe(1);
  });

  it("reports a newer generation from the target list as a changed target", () => {
    // The Agent's run navigated the tab. The panel must say so: the page the
    // person was clicking is not the page that is there now, so their previous
    // input is no longer valid and the buffered picture of it must go.
    const before = target({ generation: 3 });
    const after = target({ generation: 4 });
    const list: WebuiBrowserTargetList = {
      surface: "isolated-chromium",
      targets: [{ id: after, title: "Example", url: "https://example.test/", status: "open", selected: false }],
    };

    const state = reduceWebuiBrowserPanelState(showingPage(before), {
      type: "targets-loaded",
      list,
    });

    expect(state.targetChange).toEqual({ target: after, previousGeneration: 3 });
    expect(state.viewedPage).toEqual(after);
    // The buffered frame belonged to generation 3.
    expect(selectWebuiBrowserFrame(state)).toBeUndefined();
  });

  it("clears the page in front rather than promoting another tab when its page is gone", () => {
    // Never silently switch to another tab. An empty panel says what happened; a
    // different page would not, and it would be a page nobody chose.
    const other = target({ targetId: "tab-2" });
    const state = reduceWebuiBrowserPanelState(showingPage(), {
      type: "targets-loaded",
      list: {
        surface: "isolated-chromium",
        targets: [{ id: other, title: "Other", url: "https://other.test/", status: "open", selected: false }],
      },
    });

    expect(state.viewedPage).toBeUndefined();
    expect(selectWebuiBrowserFrame(state)).toBeUndefined();
    expect(state.targets[0]?.selected).toBe(false);
    expect(state.status).toBe("empty");
  });

  it("records the run's own page moving on without touching the page in front", () => {
    // The runtime's cell moves; the client's cell does not. The Agent navigating
    // its own tab must not change which tab the person is looking at, and must
    // not drop the picture they are looking at either.
    const person = target({ targetId: "tab-person" });
    const runPage = target({ targetId: "tab-agent" });
    const loaded = reduceWebuiBrowserPanelState(showingPage(person), {
      type: "targets-loaded",
      list: listOf([person, runPage], runPage),
      selected: runPage,
    });

    const moved = reduceWebuiBrowserPanelState(loaded, {
      type: "target-changed",
      target: target({ targetId: "tab-agent", generation: 4 }),
    });

    expect(moved.runSelection).toEqual(target({ targetId: "tab-agent", generation: 4 }));
    expect(moved.viewedPage).toEqual(person);
    expect(selectWebuiBrowserFrame(moved)?.target).toEqual(person);
  });
});

describe("the panel's status", () => {
  it("is ready only while the page in front holds a frame of that generation", () => {
    const viewed = target({ generation: 2 });
    const empty = reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
      type: "page-viewed",
      target: viewed,
    });
    expect(empty.status).toBe("loading");

    const ready = showingPage(viewed);
    expect(ready.status).toBe("ready");
  });

  it("reports an empty surface rather than an empty frame", () => {
    const state = reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
      type: "targets-loaded",
      list: { surface: "edge", targets: [] },
    });

    expect(state.status).toBe("empty");
    expect(state.targets).toEqual([]);
  });

  it("carries the stable error code the panel branches on", () => {
    const state = reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
      type: "failed",
      error: { code: "browser_pairing_rejected", message: "配对被拒绝。", retryable: false },
    });

    expect(state.status).toBe("error");
    expect(state.error?.code).toBe("browser_pairing_rejected");
  });
});

/** A target list, as the host's read for one run returns it. */
function listOf(
  targets: readonly WebuiBrowserTargetId[],
  selected?: WebuiBrowserTargetId,
): WebuiBrowserTargetList {
  return {
    surface: "isolated-chromium",
    targets: targets.map((id) => ({
      id,
      title: "Example",
      url: "https://example.test/",
      status: "open" as const,
      selected: selected !== undefined && webuiBrowserFrameKey(id) === webuiBrowserFrameKey(selected),
    })),
  };
}

/**
 * The panel follows the active run (ADR 0019).
 *
 * The selection belongs to a run, so these are the decisions the projection
 * makes when runs take over from each other: whose target is marked, and what
 * the panel shows while it waits for the new run's answer.
 */
describe("following the active run", () => {
  const first = target({ targetId: "tab-1" });
  const second = target({ targetId: "tab-2" });

  it("reads the run's own selected flag rather than the panel's memory", () => {
    // The list is what the service answered for the run the panel asked as. A
    // run that has selected nothing answers with nothing selected.
    expect(selectedWebuiBrowserRunTarget(listOf([first, second], second))).toEqual(second);
    expect(selectedWebuiBrowserRunTarget(listOf([first, second]))).toBeUndefined();
  });

  it("marks the active run's target and follows it when the run changes", () => {
    const showingFirst = reduceWebuiBrowserPanelState(
      reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
        type: "targets-loaded",
        list: listOf([first, second], first),
        selected: first,
      }),
      { type: "frame", frame: frame({ target: first }) },
    );
    expect(showingFirst.targets.map((entry) => entry.selected)).toEqual([true, false]);

    // The next read is for the run that took over, and its answer is tab-2.
    const following = reduceWebuiBrowserPanelState(showingFirst, {
      type: "targets-loaded",
      list: listOf([first, second], second),
      selected: second,
    });
    expect(following.runSelection).toEqual(second);
    expect(following.targets.map((entry) => entry.selected)).toEqual([false, true]);
  });

  it("forgets the previous run's target when the active run changes", () => {
    const showingFirst = reduceWebuiBrowserPanelState(
      reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
        type: "targets-loaded",
        list: listOf([first, second], first),
        selected: first,
      }),
      { type: "page-viewed", target: first },
    );
    // Between the two runs' answers the panel claims no run target: showing the
    // previous run's page as if it were the new run's is the disagreement the
    // ADR names. The buffered frames stay — they are per tab, not per run — and
    // so does the page the person is looking at, which is not the run's.
    const withFrame = reduceWebuiBrowserPanelState(showingFirst, {
      type: "frame",
      frame: frame({ target: first }),
    });
    const between = reduceWebuiBrowserPanelState(withFrame, { type: "run-changed" });
    expect(between.runSelection).toBeUndefined();
    expect(between.viewedPage).toEqual(first);
    expect(between.targets.every((entry) => !entry.selected)).toBe(true);
    expect(Object.keys(between.frames)).toHaveLength(1);

    // A new run that picks the same tab is marked at once, without a new frame.
    const resumed = reduceWebuiBrowserPanelState(between, {
      type: "targets-loaded",
      list: listOf([first, second], first),
      selected: first,
    });
    expect(resumed.runSelection).toEqual(first);
    expect(selectWebuiBrowserFrame(resumed)?.target).toEqual(first);
  });

  it("shows nothing selected while the active run has selected nothing", () => {
    // The panel with no run behind it: the no-run list has no selected target,
    // and the panel must not keep the previous run's selection in its place.
    const previous = reduceWebuiBrowserPanelState(
      reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
        type: "targets-loaded",
        list: listOf([first, second], first),
        selected: first,
      }),
      { type: "run-changed" },
    );
    const idle = reduceWebuiBrowserPanelState(previous, {
      type: "targets-loaded",
      list: listOf([first, second]),
    });

    expect(idle.runSelection).toBeUndefined();
    expect(idle.targets.every((entry) => !entry.selected)).toBe(true);
  });
});

/**
 * Two cells, one writer each (ADR 0022).
 *
 * The run's selection is the runtime's and the page in front is the client's. What
 * is asserted here is not that both are present — it is that neither write reaches
 * across, because the whole shape of the failure the ADR exists to prevent is a
 * client's write landing in the runtime's cell or the other way round.
 */
describe("the two cells", () => {
  const person = target({ targetId: "tab-person", generation: 1 });
  const agent = target({ targetId: "tab-agent", generation: 1 });

  it("holds both at once, each written by its own side", () => {
    // The run's answer arrives from the runtime's list; the person's arrives from
    // the strip. Neither one implies the other.
    const afterRun = reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
      type: "targets-loaded",
      list: listOf([person, agent], agent),
      selected: agent,
    });
    expect(afterRun.runSelection).toEqual(agent);
    expect(afterRun.viewedPage).toBeUndefined();

    const afterPerson = reduceWebuiBrowserPanelState(afterRun, {
      type: "page-viewed",
      target: person,
    });
    expect(afterPerson.viewedPage).toEqual(person);
    expect(afterPerson.runSelection).toEqual(agent);
  });

  it("does not move the run's selection when the person changes tab", () => {
    const state = reduceWebuiBrowserPanelState(
      reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
        type: "targets-loaded",
        list: listOf([person, agent], agent),
        selected: agent,
      }),
      { type: "page-viewed", target: person },
    );
    const switched = reduceWebuiBrowserPanelState(state, {
      type: "page-viewed",
      target: agent,
    });

    expect(switched.viewedPage).toEqual(agent);
    // The run's selection was already `agent` and is still `agent`: the person
    // looked at the Agent's page, which is a coincidence, not a write.
    expect(switched.runSelection).toEqual(agent);
  });

  it("keeps the page in front when the run's selection moves somewhere else", () => {
    const state = reduceWebuiBrowserPanelState(
      reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
        type: "page-viewed",
        target: person,
      }),
      { type: "frame", frame: frame({ target: person }) },
    );
    const moved = reduceWebuiBrowserPanelState(state, {
      type: "targets-loaded",
      list: listOf([person, agent], agent),
      selected: agent,
    });

    expect(moved.runSelection).toEqual(agent);
    expect(moved.viewedPage).toEqual(person);
    expect(selectWebuiBrowserFrame(moved)?.target).toEqual(person);
  });

  it("keeps the page in front when the active run changes", () => {
    const state = reduceWebuiBrowserPanelState(
      reduceWebuiBrowserPanelState(initialWebuiBrowserPanelState, {
        type: "page-viewed",
        target: person,
      }),
      { type: "frame", frame: frame({ target: person }) },
    );
    const nextRun = reduceWebuiBrowserPanelState(state, { type: "run-changed" });

    expect(nextRun.runSelection).toBeUndefined();
    expect(nextRun.viewedPage).toEqual(person);
    expect(selectWebuiBrowserFrame(nextRun)?.target).toEqual(person);
  });
});

describe("webuiBrowserFrameDataUrl", () => {
  it("builds a data URL for a frame it can render", () => {
    expect(webuiBrowserFrameDataUrl(frame({ data: "QUJD", format: "jpeg" }))).toBe(
      "data:image/jpeg;base64,QUJD",
    );
  });

  it("refuses a payload outside the base64 alphabet instead of handing it to src", () => {
    // A `data:` URL is built from the payload verbatim, so anything that is not
    // image bytes must not reach `src` at all.
    expect(webuiBrowserFrameDataUrl(frame({ data: "<svg onload=alert(1)>" }))).toBeUndefined();
    expect(webuiBrowserFrameDataUrl(frame({ data: "" }))).toBeUndefined();
  });

  it("refuses a format outside the two the contract allows", () => {
    const forged = { ...frame(), format: "svg+xml" } as unknown as WebuiBrowserImageFrame;
    expect(webuiBrowserFrameDataUrl(forged)).toBeUndefined();
  });
});

describe("the target the live image stream is open for", () => {
  it("is the page the person is looking at, not the run's selection", () => {
    const state = reduceWebuiBrowserPanelState(
      initialWebuiBrowserPanelState,
      {
        type: "targets-loaded",
        list: {
          surface: "isolated-chromium",
          targets: [
            {
              id: {
                surface: "isolated-chromium",
                browserId: "browser-1",
                targetId: "tab-1",
                generation: 1,
              },
              title: "Example",
              url: "https://example.test",
              status: "open",
              selected: false,
            },
          ],
        },
      },
    );
    const selected = {
      surface: "isolated-chromium" as const,
      browserId: "browser-1",
      targetId: "tab-1",
      generation: 1,
    };
    const afterRunLoaded = reduceWebuiBrowserPanelState(state, {
      type: "targets-loaded",
      list: {
        surface: "isolated-chromium",
        targets: [
          {
            id: selected,
            title: "Example",
            url: "https://example.test",
            status: "open",
            selected: true,
          },
        ],
      },
      selected,
    });
    // The run has a selection and the person is looking at the same page: the
    // stream is opened for the page, and the two cells happen to agree.
    const viewing = reduceWebuiBrowserPanelState(afterRunLoaded, {
      type: "page-viewed",
      target: selected,
    });
    expect(selectWebuiBrowserStreamTarget(viewing)).toEqual(selected);

    // The Agent moves to another tab. The stream stays on the page in front —
    // that is what the person is watching, and the picture of the Agent's page
    // is not what this tab shows.
    const agentElsewhere = target({ targetId: "tab-2" });
    const followed = reduceWebuiBrowserPanelState(viewing, {
      type: "targets-loaded",
      list: listOf([selected, agentElsewhere], agentElsewhere),
      selected: agentElsewhere,
    });
    expect(followed.runSelection).toEqual(agentElsewhere);
    expect(selectWebuiBrowserStreamTarget(followed)).toEqual(selected);
  });

  it("is nothing when no tab is in front", () => {
    // Nothing is being looked at, so there is no page to stream. The panel opens
    // no subscription: one that can never deliver a frame leaves the panel blank,
    // and one for somebody else's page shows the Agent's work under this tab.
    expect(selectWebuiBrowserStreamTarget(initialWebuiBrowserPanelState)).toBeUndefined();
  });

  it("names the browser, the tab and the generation, so a replaced page re-opens the stream", () => {
    const target = {
      surface: "isolated-chromium" as const,
      browserId: "browser-1",
      targetId: "tab-1",
      generation: 1,
    };
    expect(webuiBrowserStreamTargetKey(target)).toBe("browser-1:tab-1:1");
    // A tab that was replaced is a different page even though it is the same
    // tab, so the key has to change with the generation.
    expect(webuiBrowserStreamTargetKey({ ...target, generation: 2 })).toBe("browser-1:tab-1:2");
    expect(webuiBrowserStreamTargetKey(undefined)).toBeUndefined();
  });
});
