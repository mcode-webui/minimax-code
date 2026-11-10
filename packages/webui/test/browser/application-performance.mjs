export const APPLICATION_BLOCK_MS = 50;
export const MEASURE_START = "webui-application-measure-start";
export const MEASURE_END = "webui-application-measure-end";
export const FRAME_MARK = "webui-application-frame";

export function attributeFrameWork(events) {
  const start = events.find((event) => event.name === MEASURE_START);
  const end = events.find((event) => event.name === MEASURE_END);
  if (!start || !end) throw new Error("application frame markers are missing");
  const marks = events.filter(
    (event) =>
      event.name === FRAME_MARK &&
      event.pid === start.pid &&
      event.tid === start.tid &&
      event.ts >= start.ts &&
      event.ts <= end.ts,
  );
  if (marks.length < 2 || marks.some((mark) => !Number.isFinite(mark.tts))) {
    throw new Error("application frame CPU timing is unavailable");
  }
  return marks.slice(1).map((mark, index) => {
    const previous = marks[index];
    if (mark.tts < previous.tts || mark.ts < previous.ts) throw new Error("application frame clock is inconsistent");
    return { wallMs: (mark.ts - previous.ts) / 1000, cpuMs: (mark.tts - previous.tts) / 1000 };
  });
}

export function attributeApplicationWork(events, frames) {
  const start = events.find((event) => event.name === MEASURE_START);
  const end = events.find((event) => event.name === MEASURE_END);
  if (!start || !end || end.ts <= start.ts || start.pid !== end.pid || start.tid !== end.tid) {
    throw new Error("application measurement markers are missing or inconsistent");
  }
  // 只计算该页面主线程中与实际测量窗口相交的根任务，不累加嵌套事件。
  const tasks = events.filter(
    (event) =>
      event.name === "ThreadControllerImpl::RunTask" &&
      event.ph === "X" &&
      event.pid === start.pid &&
      event.tid === start.tid &&
      event.ts < end.ts &&
      event.ts + event.dur > start.ts,
  );
  // Chromium 的部分微小合成任务没有线程时钟。墙钟已低于预算时用它作保守上界；
  // 必须存在真实 CPU 样本，任何达到预算却缺少 CPU 时钟的任务仍明确失败。
  if (
    !tasks.some((task) => Number.isFinite(task.tdur)) ||
    tasks.some((task) => task.tdur < 0 || (!Number.isFinite(task.tdur) && task.dur >= APPLICATION_BLOCK_MS * 1000))
  ) {
    throw new Error("application main-thread CPU timing is unavailable");
  }
  const scripts = frames.flatMap((frame) => frame.scripts);
  if (
    scripts.some(
      (script) =>
        !Number.isFinite(script.duration) || !Number.isFinite(script.pauseDuration) || script.pauseDuration < 0,
    )
  ) {
    throw new Error("application script timing is unavailable");
  }
  const pauses = new Map();
  for (const script of scripts.filter((script) => script.pauseDuration > 0)) {
    if (!Number.isFinite(start.args?.data?.startTime) || !Number.isFinite(script.startTime)) {
      throw new Error("application script clock mapping is unavailable");
    }
    const scriptStart = start.ts + (script.startTime - start.args.data.startTime) * 1000;
    const scriptEnd = scriptStart + script.duration * 1000;
    // LoAF 的毫秒精度比 trace 低，允许边界最多 0.2ms 的量化误差。
    const owner = tasks.find((task) => task.ts <= scriptStart + 200 && task.ts + task.dur >= scriptEnd - 200);
    if (!owner) throw new Error("application synchronous pause has no owning main-thread task");
    pauses.set(owner, (pauses.get(owner) ?? 0) + script.pauseDuration);
  }
  const blockedTasks = tasks.map((task) => {
    const cpuMs = (Number.isFinite(task.tdur) ? task.tdur : task.dur) / 1000;
    const pauseMs = pauses.get(task) ?? 0;
    return { task, cpuMs, pauseMs, applicationMs: cpuMs + pauseMs };
  });
  return {
    tasks,
    scripts,
    blockedTasks,
    // CPU 覆盖脚本、布局与绘制；浏览器记录的同步暂停另外计入，系统调度停顿保留诊断。
    cpuOverBudget: tasks.filter(
      (task) => (Number.isFinite(task.tdur) ? task.tdur : task.dur) / 1000 >= APPLICATION_BLOCK_MS,
    ),
    blockingOverBudget: blockedTasks.filter((task) => task.applicationMs >= APPLICATION_BLOCK_MS),
  };
}

export async function startApplicationTrace(page) {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  await cdp.send("Tracing.start", {
    categories: "toplevel,blink.user_timing",
    transferMode: "ReportEvents",
  });
  return async () => {
    try {
      const completed = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.end");
      await completed;
      return events;
    } finally {
      await cdp.detach();
    }
  };
}
