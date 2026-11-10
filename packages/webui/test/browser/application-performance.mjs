export const APPLICATION_BLOCK_MS = 50;
export const MEASURE_START = "webui-application-measure-start";
export const MEASURE_END = "webui-application-measure-end";

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
  if (scripts.some((script) => !Number.isFinite(script.duration))) {
    throw new Error("application script timing is unavailable");
  }
  return {
    tasks,
    scripts,
    // CPU 覆盖脚本、布局与绘制的实际执行；脚本墙钟时间也保留门禁，避免漏掉同步等待。
    cpuOverBudget: tasks.filter(
      (task) => (Number.isFinite(task.tdur) ? task.tdur : task.dur) / 1000 >= APPLICATION_BLOCK_MS,
    ),
    scriptsOverBudget: scripts.filter((script) => script.duration >= APPLICATION_BLOCK_MS),
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
