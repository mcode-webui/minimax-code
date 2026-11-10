import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch({ channel: 'chromium', headless: process.env.WEBUI_BROWSER_HEADED !== '1' });
const output = [];
try {
  for (const scenario of ['idle', 'javascript', 'layout']) {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    const session = await page.context().newCDPSession(page);
    const events = [];
    session.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    await session.send('Tracing.start', { categories: 'toplevel,blink.user_timing', transferMode: 'ReportEvents' });
    const frames = await page.evaluate(async (kind) => {
      if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) throw new Error('LoAF unavailable');
      const entries = [];
      const observer = new PerformanceObserver(list => entries.push(...list.getEntries().map(entry => entry.toJSON())));
      observer.observe({ type: 'long-animation-frame' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      performance.mark('app-measure-start');
      await new Promise(resolve => setTimeout(() => {
        const start = performance.now();
        const main = document.querySelector('main');
        if (kind === 'layout') main.innerHTML = '<div style="width:50%">content</div>'.repeat(3000);
        if (kind !== 'idle') {
          let iteration = 0;
          while (performance.now() - start < 80) {
            if (kind === 'layout') {
              main.style.width = `${600 + iteration % 2}px`;
              main.getBoundingClientRect();
            }
            iteration++;
          }
        }
        resolve();
      }, 0));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      performance.mark('app-measure-end');
      await new Promise(resolve => setTimeout(resolve, 100));
      entries.push(...observer.takeRecords().map(entry => entry.toJSON()));
      observer.disconnect();
      return entries;
    }, scenario);
    const complete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.end');
    await complete;
    const start = events.find(event => event.name === 'app-measure-start');
    const end = events.find(event => event.name === 'app-measure-end');
    if (!start || !end) throw new Error('Measurement markers unavailable');
    const tasks = events.filter(event => event.name === 'ThreadControllerImpl::RunTask' && event.ph === 'X' && event.pid === start.pid && event.tid === start.tid && event.ts < end.ts && event.ts + event.dur > start.ts);
    if (!tasks.length || tasks.some(task => !Number.isFinite(task.tdur))) throw new Error('Task CPU timing unavailable');
    const cpuExceeded = tasks.some(task => task.tdur >= 50000);
    const scriptExceeded = frames.some(frame => frame.scripts.some(script => script.duration >= 50));
    const failed = cpuExceeded || scriptExceeded;
    output.push({ scenario, failed, cpuExceeded, scriptExceeded, tasks, frames });
    if (failed !== (scenario !== 'idle')) throw new Error(`Negative control mismatch: ${scenario}`);
    console.log(JSON.stringify({ scenario, failed, cpuExceeded, scriptExceeded, maxTaskCpuMs: Math.max(...tasks.map(task => task.tdur / 1000)) }));
    await page.close();
  }
} finally {
  writeFileSync(process.env.ATTRIBUTION_OUTPUT ?? 'attribution-negative-controls.json', JSON.stringify(output, null, 2));
  await browser.close();
}
