// Streaming-reply responsiveness in the built client.
//
// An agent reply arrives as a sequence of wire frames. Each frame is its own
// browser task, so the client gets one render opportunity per frame — and a
// turn that delivers a few hundred frames gives a few hundred renders. This
// spec measures what that costs the reader.
//
// 帧间隔包含 runner 的调度延迟，不能直接当成应用阻塞时间。
// 同页空闲基线校准帧间隔，应用长任务仍使用绝对 50ms 预算。
//
// Two scenarios, because they fail differently:
//   - a short reply in a short conversation (the everyday case);
//   - a long reply in a long conversation (the case where the per-frame work
//     scales with the conversation, and where the reader notices).
//
// The scenario size can be overridden so a sweep can find the breaking point
// without editing the spec: WEBUI_PERF_HISTORY_TURNS and WEBUI_PERF_CHUNKS.

import { expect } from "@playwright/test";

import { attachJsonEvidence, openApp, startTurn, test } from "./harness.mjs";
import {
  APPLICATION_BLOCK_MS,
  MEASURE_END,
  MEASURE_START,
  attributeApplicationWork,
  startApplicationTrace,
} from "./application-performance.mjs";

// Keep trace snapshots and screenshot capture outside the measured interval;
// a failure screenshot is taken only after the performance assertions.
test.use({ trace: "off", screenshot: "only-on-failure" });

/** A reply body that exercises the markdown path: prose, a list and a fence. */
function replyChunk(index) {
  return [
    `Paragraph ${index} of the streamed answer, with prose that the markdown lexer has to walk.`,
    "- first list item",
    "- second list item",
    "```ts",
    `export const value${index} = ${index};`,
    "```",
  ].join("\n\n");
}

/** A conversation that already has some history behind the live turn. */
function historyMessages(turns) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      msgId: `hist-user-${index}`,
      role: "user",
      msgContent: `历史提问 ${index}`,
      timestamp: 1_700_000_000_000 + index * 2_000,
    });
    messages.push({
      msgId: `hist-assistant-${index}`,
      role: "assistant",
      msgContent: `历史回答 ${index}\n\n- 项目一\n- 项目二`,
      thinkingContent: `历史思考 ${index}`,
      timestamp: 1_700_000_000_500 + index * 2_000,
    });
  }
  return messages;
}

/** A frame longer than this is a dropped frame at 60 Hz. */
const JANK_FRAME_MS = 50;
/** A frame longer than this is more than one dropped frame. */
const DROPPED_FRAME_MS = 100;

function percentile(values, fraction) {
  if (!values.length) throw new Error("performance measurement collected no frame samples");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function frameBudget(idleBefore, idleAfter) {
  // 显示器与 runner 的空闲帧周期不占用应用的 50ms 额外开销预算。
  return Math.max(percentile(idleBefore, 0.95), percentile(idleAfter, 0.95)) + APPLICATION_BLOCK_MS;
}

async function measureIdleFrames(page, durationMs) {
  return page.evaluate(async (duration) => {
    const gaps = [];
    let previous;
    const deadline = performance.now() + duration;
    await new Promise((resolve) => {
      const sample = () => {
        const now = performance.now();
        if (previous !== undefined) gaps.push(now - previous);
        previous = now;
        if (now < deadline) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return gaps;
  }, durationMs);
}

/**
 * The streaming measurement, run inside the page.
 *
 * Returns the frame-gap distribution the reader sees, plus the main thread's
 * own account of how long it was blocked. The rAF loop and the zero-delay
 * timer both run while the frames are delivered, so they observe exactly the
 * window the reader is watching.
 */
async function measureStreamedReply(page, options) {
  const { historyTurns, chunks } = options;
  // The history has to exist before the transcript asks for its first page,
  // so it is staged through the fixture's boot-time setup hook.
  await page.addInitScript((messages) => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => window.__fixture.setPage("A", { messages, hasMore: false }));
  }, historyMessages(historyTurns));
  await openApp(page);
  await startTurn(page, "A", "Stream a long answer");

  // The runtime replays the user's own message on the stream before the
  // assistant answers, exactly as the server does. Without it the live answer
  // has no user turn to sit under.
  await page.evaluate(() => {
    window.__fixture.emitStream("A", {
      dataJson: JSON.stringify({
        type: "agent_message",
        agent_message: {
          msg_id: "msg-user-1",
          msg_content: "Stream a long answer",
        },
      }),
    });
  });

  const chunkTexts = Array.from({ length: chunks }, (_value, index) => replyChunk(index));
  const idleBefore = await measureIdleFrames(page, 2000);

  // Optional CPU profile of the streaming window, so the cost of one frame can
  // be attributed to functions instead of guessed at.
  const cdp = process.env.WEBUI_PERF_PROFILE ? await page.context().newCDPSession(page) : undefined;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await cdp.send("Profiler.start");
  }

  const finishTrace = await startApplicationTrace(page);
  let traceEvents;
  let metrics;
  try {
    metrics = await page.evaluate(
      async ({ chunkTextsIn, measureStart, measureEnd }) => {
        if (
          !["longtask", "long-animation-frame"].every((type) => PerformanceObserver.supportedEntryTypes.includes(type))
        ) {
          throw new Error("application performance observers are unavailable");
        }
        const count = chunkTextsIn.length;
        const longTasks = [];
        const longTaskDetails = [];
        const observer = new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) {
            longTasks.push(entry.duration);
            longTaskDetails.push(entry.toJSON());
          }
        });
        observer.observe({ type: "longtask" });
        const longAnimationFrames = [];
        const frameObserver = new PerformanceObserver((entries) => {
          longAnimationFrames.push(...entries.getEntries().map((entry) => entry.toJSON()));
        });
        frameObserver.observe({ type: "long-animation-frame" });

        // A rAF loop records the frame pacing the reader actually sees.
        const frameGaps = [];
        let previousFrame = performance.now();
        let running = true;
        const sample = () => {
          if (!running) return;
          const now = performance.now();
          frameGaps.push(now - previousFrame);
          previousFrame = now;
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);

        // A zero-delay timer is the cheapest honest probe of "can the main thread
        // still answer me": a busy renderer pushes it late.
        const timerDelays = [];
        let timerRunning = true;
        const probe = () => {
          if (!timerRunning) return;
          const requested = performance.now();
          setTimeout(() => {
            timerDelays.push(performance.now() - requested);
            probe();
          }, 0);
        };
        probe();

        performance.mark(measureStart);
        const started = performance.now();
        for (let index = 0; index < count; index += 1) {
          window.__fixture.emitStream("A", {
            cursor: `cursor-${index}`,
            dataJson: JSON.stringify({
              type: "agent_message_chunk",
              agent_message_chunk: {
                msg_id: "a-turn-1",
                msg_content: `${chunkTextsIn[index]}\n\n`,
              },
            }),
          });
          // Each frame is its own browser task in production, so the render
          // opportunity is per frame. A macrotask boundary reproduces that.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const emitted = performance.now();

        await new Promise((resolve) => {
          const deadline = performance.now() + 20_000;
          const check = () => {
            const text = document.querySelector('[data-webui-assistant-body="a-turn-1"]')?.textContent ?? "";
            if (text.includes(`Paragraph ${count - 1} of the streamed answer`)) return resolve();
            if (performance.now() > deadline) return resolve();
            requestAnimationFrame(check);
          };
          check();
        });
        // 最终文本进入 DOM 后仍需完成绘制；与拖拽一样覆盖提交后的两帧。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const settled = performance.now();
        performance.mark(measureEnd);
        running = false;
        timerRunning = false;
        const records = observer.takeRecords();
        longTaskDetails.push(...records.map((entry) => entry.toJSON()));
        observer.disconnect();
        longAnimationFrames.push(...frameObserver.takeRecords().map((entry) => entry.toJSON()));
        frameObserver.disconnect();
        return {
          emitted: emitted - started,
          settled: settled - started,
          longTasks: [...longTasks, ...records.map((entry) => entry.duration)],
          longTaskDetails,
          longAnimationFrames,
          frameGaps: frameGaps.slice(1),
          timerDelays,
          liveBodyFound: Boolean(document.querySelector('[data-webui-assistant-body="a-turn-1"]')),
        };
      },
      {
        chunkTextsIn: chunkTexts,
        measureStart: MEASURE_START,
        measureEnd: MEASURE_END,
      },
    );
  } finally {
    traceEvents = await finishTrace();
  }
  await attachJsonEvidence("application-task-trace.json", traceEvents);
  const idleAfter = await measureIdleFrames(page, Math.max(2000, metrics.settled));
  // 即使归因数据不完整也先保留原始样本，便于定位采样失败。
  await attachJsonEvidence("stream-performance-samples.json", { historyTurns, chunks, idleBefore, active: metrics, idleAfter });
  const applicationWork = attributeApplicationWork(traceEvents, metrics.longAnimationFrames);
  await attachJsonEvidence("stream-performance-raw.json", {
    historyTurns,
    chunks,
    idleBefore,
    active: metrics,
    idleAfter,
    applicationWork,
  });

  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let index = 0; index < samples.length; index += 1) {
      const node = byId.get(samples[index]);
      if (!node) continue;
      const frame = node.callFrame;
      const key = `${frame.functionName || "(anonymous)"} @ ${frame.url.split("/").pop() ?? ""}:${frame.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0));
    }
    const ranked = [...self.entries()].sort((left, right) => right[1] - left[1]).slice(0, 25);
    console.info("=== CPU profile (top self time, ms) ===");
    for (const [key, micros] of ranked) console.info(`${(micros / 1000).toFixed(1).padStart(8)} ms  ${key}`);
  }

  const gaps = [...metrics.frameGaps].sort((left, right) => left - right);
  const summary = {
    ...metrics,
    worstFrameGap: gaps.at(-1) ?? 0,
    p95FrameGap: percentile(gaps, 0.95),
    medianFrameGap: percentile(gaps, 0.5),
    allowedP95FrameGap: frameBudget(idleBefore, idleAfter),
    jankFrames: gaps.filter((gap) => gap >= JANK_FRAME_MS).length,
    droppedFrames: gaps.filter((gap) => gap >= DROPPED_FRAME_MS).length,
    worstTimerDelay: Math.max(0, ...metrics.timerDelays),
    longTaskCount: metrics.longTasks.filter((duration) => duration >= APPLICATION_BLOCK_MS).length,
    applicationOverBudget: applicationWork.cpuOverBudget.length + applicationWork.scriptsOverBudget.length,
  };
  console.info(
    [
      `streamed reply: ${chunks} frames over ${summary.emitted.toFixed(0)} ms`,
      `settled after ${summary.settled.toFixed(0)} ms`,
      `frame gap: median ${summary.medianFrameGap.toFixed(1)} ms`,
      `p95 ${summary.p95FrameGap.toFixed(1)} ms`,
      `idle-calibrated p95 budget ${summary.allowedP95FrameGap.toFixed(1)} ms`,
      `worst ${summary.worstFrameGap.toFixed(1)} ms`,
      `jank frames(>=${JANK_FRAME_MS}ms): ${summary.jankFrames}`,
      `dropped frames(>=${DROPPED_FRAME_MS}ms): ${summary.droppedFrames}`,
      `worst timer delay: ${summary.worstTimerDelay.toFixed(1)} ms`,
      `long tasks: ${summary.longTaskCount}`,
      `application tasks/scripts over budget: ${summary.applicationOverBudget}`,
      `max task CPU: ${(Math.max(...applicationWork.tasks.map((task) => Number.isFinite(task.tdur) ? task.tdur : task.dur)) / 1000).toFixed(1)} ms`,
      `max script: ${Math.max(0, ...applicationWork.scripts.map((script) => script.duration)).toFixed(1)} ms`,
    ].join(" | "),
  );
  return summary;
}

/**
 * The answer must be RENDERED, not merely present: the block reuse means the
 * first block of the answer is rendered from the cache on every later frame,
 * so it is the one a broken reuse would corrupt.
 */
async function expectRenderedAnswer(page, chunks) {
  const body = page.locator('[data-webui-assistant-body="a-turn-1"]');
  // The markdown itself: the body also carries the diff card, whose own file
  // list would otherwise be counted as answer content.
  const answer = body.locator(".webui-markdown");
  await expect(answer).toHaveCount(1);
  // The oldest block, the one every later frame reused.
  await expect(answer.locator("p").first()).toContainText("Paragraph 0 of the streamed answer");
  // Every block that arrived: one list of two items and one fenced code block
  // per chunk, all of them rendered.
  await expect(answer.locator(".webui-code-block")).toHaveCount(chunks);
  await expect(answer.locator("ul li")).toHaveCount(chunks * 2);
  // The reused block kept its content and its highlighting rather than
  // losing either.
  const firstFence = answer.locator(".webui-code-block").first();
  await expect(firstFence.locator("code.hljs")).toContainText("export const value0 = 0;");
}

test("a streamed reply keeps the page responsive", async ({ page }) => {
  const summary = await measureStreamedReply(page, {
    historyTurns: Number(process.env.WEBUI_PERF_HISTORY_TURNS ?? 12),
    chunks: Number(process.env.WEBUI_PERF_CHUNKS ?? 120),
  });

  // The reply must reach the screen, in its own turn block.
  expect(summary.liveBodyFound, "the live reply did not render its own assistant body").toBe(true);
  await expectRenderedAnswer(page, Number(process.env.WEBUI_PERF_CHUNKS ?? 120));
  expect(
    summary.p95FrameGap,
    `stream p95 ${summary.p95FrameGap} ms exceeds same-page idle budget ${summary.allowedP95FrameGap} ms`,
  ).toBeLessThan(summary.allowedP95FrameGap);
  // 原始停顿保留诊断；实际主线程执行与脚本阻塞分别执行 50ms 预算。
  expect(
    summary.applicationOverBudget,
    `the streamed reply produced ${summary.applicationOverBudget} application tasks/scripts over budget`,
  ).toBe(0);
});

test("a long reply in a long conversation does not drop frames", async ({ page }) => {
  // The heavy case: the per-frame work scales with the conversation, so this
  // is where a per-frame regression shows up as dropped frames rather than as
  // a slower reply.
  const summary = await measureStreamedReply(page, {
    historyTurns: Number(process.env.WEBUI_PERF_HEAVY_HISTORY_TURNS ?? 40),
    chunks: Number(process.env.WEBUI_PERF_HEAVY_CHUNKS ?? 400),
  });

  expect(summary.liveBodyFound, "the live reply did not render its own assistant body").toBe(true);
  await expectRenderedAnswer(page, Number(process.env.WEBUI_PERF_HEAVY_CHUNKS ?? 400));
  expect(
    summary.p95FrameGap,
    `stream p95 ${summary.p95FrameGap} ms exceeds same-page idle budget ${summary.allowedP95FrameGap} ms`,
  ).toBeLessThan(summary.allowedP95FrameGap);
  expect(
    summary.applicationOverBudget,
    `the streamed reply produced ${summary.applicationOverBudget} application tasks/scripts over budget`,
  ).toBe(0);
});

for (const scenario of ["idle", "javascript", "layout", "synchronous-wait"]) {
  test(`application attribution detects real blocking: ${scenario}`, async ({ page }) => {
    await openApp(page);
    await page.route("**/__application_wait", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ status: 200, body: "ok" });
    });
    const finishTrace = await startApplicationTrace(page);
    let events;
    let frames;
    try {
      frames = await page.evaluate(
        async ({ scenario, start, end }) => {
          if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
            throw new Error("application performance observers are unavailable");
          }
          const frames = [];
          const observer = new PerformanceObserver((list) =>
            frames.push(...list.getEntries().map((entry) => entry.toJSON())),
          );
          observer.observe({ type: "long-animation-frame" });
          const content = document.createElement("div");
          document.body.append(content);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          performance.mark(start);
          await new Promise((resolve) =>
            setTimeout(() => {
              const started = performance.now();
              if (scenario === "synchronous-wait") {
                const request = new XMLHttpRequest();
                request.open("GET", "/__application_wait", false);
                request.send();
                if (request.status !== 200) throw new Error("synchronous wait control failed");
              }
              if (scenario === "layout") content.innerHTML = '<div style="width:50%">layout control</div>'.repeat(3000);
              let iteration = 0;
              while (scenario !== "idle" && performance.now() - started < 80) {
                if (scenario === "layout") {
                  content.style.width = `${600 + (iteration % 2)}px`;
                  content.getBoundingClientRect();
                }
                iteration += 1;
              }
              resolve();
            }, 0),
          );
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          performance.mark(end);
          await new Promise((resolve) => setTimeout(resolve, 100));
          frames.push(...observer.takeRecords().map((entry) => entry.toJSON()));
          observer.disconnect();
          content.remove();
          return frames;
        },
        { scenario, start: MEASURE_START, end: MEASURE_END },
      );
    } finally {
      events = await finishTrace();
    }
    const work = attributeApplicationWork(events, frames);
    await attachJsonEvidence("application-attribution-control.json", {
      scenario,
      work,
      frames,
    });
    expect(work.cpuOverBudget.length + work.scriptsOverBudget.length > 0).toBe(scenario !== "idle");
    if (scenario !== "idle") expect(work.scriptsOverBudget.length).toBeGreaterThan(0);
  });
}

test("missing application timing fails instead of passing with zero work", async ({ page }) => {
  await openApp(page);
  expect(() => attributeApplicationWork([], [])).toThrow("markers are missing");
  const markers = [
    { name: MEASURE_START, ts: 1, pid: 1, tid: 1 },
    { name: MEASURE_END, ts: 100, pid: 1, tid: 1 },
  ];
  expect(() => attributeApplicationWork(markers, [])).toThrow("CPU timing is unavailable");
  expect(() =>
    attributeApplicationWork(
      [
        ...markers,
        {
          name: "ThreadControllerImpl::RunTask",
          ph: "X",
          pid: 1,
          tid: 1,
          ts: 2,
          dur: 70,
        },
      ],
      [],
    ),
  ).toThrow("CPU timing is unavailable");
  const measured = {
    name: "ThreadControllerImpl::RunTask",
    ph: "X",
    pid: 1,
    tid: 1,
    ts: 2,
    dur: 10,
    tdur: 10,
  };
  expect(() =>
    attributeApplicationWork(
      [
        ...markers,
        measured,
        {
          ...measured,
          ts: 3,
          dur: 70_000,
          tdur: undefined,
        },
      ],
      [],
    ),
  ).toThrow("CPU timing is unavailable");
  const shortSynthetic = { ...measured, ts: 3, dur: 1, tdur: undefined };
  expect(attributeApplicationWork([...markers, measured, shortSynthetic], []).cpuOverBudget).toEqual([]);
});

test("frame calibration distinguishes scheduler outliers from sustained application delay", async ({ page }) => {
  await openApp(page);
  const smooth = Array(120).fill(1000 / 60);
  const outlier = [...smooth, 100];
  expect(percentile(outlier, 0.95)).toBeLessThan(frameBudget(smooth, smooth));
  const delayed = Array(120).fill(70);
  expect(percentile(delayed, 0.95)).toBeGreaterThan(frameBudget(smooth, smooth));
  const slowRunner = Array(120).fill(40);
  expect(percentile(slowRunner, 0.95)).toBeLessThan(frameBudget(slowRunner, slowRunner));
  expect(percentile(Array(120).fill(70), 0.95)).toBeLessThan(frameBudget(slowRunner, slowRunner));
  expect(percentile(Array(120).fill(100), 0.95)).toBeGreaterThan(frameBudget(slowRunner, slowRunner));
  expect(() => frameBudget([], smooth)).toThrow("no frame samples");
});

test("continuous chunks remain visible before the stream ends and the final chunk is retained", async ({ page }) => {
  await openApp(page);
  await startTurn(page, "A", "Stream a progressively visible answer");
  const progress = await page.evaluate(async () => {
    const snapshots = [];
    for (let index = 0; index < 80; index += 1) {
      window.__fixture.emitStream("A", {
        dataJson: JSON.stringify({
          type: "agent_message_chunk",
          agent_message_chunk: {
            msg_id: "progressive-answer",
            msg_content: `Visible chunk ${index}.\n\n`,
          },
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (index === 20 || index === 40 || index === 60) {
        const text = document.querySelector('[data-webui-assistant-body="progressive-answer"]')?.textContent ?? "";
        snapshots.push(text.includes(`Visible chunk ${index - 10}.`));
      }
    }
    return snapshots;
  });
  expect(progress).toEqual([true, true, true]);
  await expect(page.locator('[data-webui-assistant-body="progressive-answer"]')).toContainText("Visible chunk 79.");
  await page.evaluate(() => {
    window.__fixture.emitStream("A", {
      dataJson: JSON.stringify({
        type: "agent_message_chunk",
        agent_message_chunk: {
          msg_id: "progressive-answer",
          msg_content: "Final chunk before DONE.",
        },
      }),
    });
    window.__fixture.emitStream("A", { dataJson: "[DONE]" });
  });
  await expect(page.locator('[data-webui-assistant-body="progressive-answer"]')).toContainText(
    "Final chunk before DONE.",
  );
});
