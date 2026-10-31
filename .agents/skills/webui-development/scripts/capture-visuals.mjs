import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// 仅启动本次捕获拥有的 loopback fixture，使用已有构建产物。
const [repoArg, outputArg] = process.argv.slice(2);
if (!repoArg || !outputArg) throw new Error('Usage: node capture-visuals.mjs <repository> <output-directory>');
const repo = path.resolve(repoArg);
const output = path.resolve(outputArg);
if (output === repo || output.startsWith(repo + path.sep)) throw new Error('Choose an output directory outside the repository');
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('@playwright/test');
const { installFixtureTransport } = await import(pathToFileURL(path.join(repo, 'packages/webui/test/browser/fixture.mjs')));
const root = path.join(repo, 'dist-webui/client');
await readFile(path.join(root, 'client.js'));
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    let body = await readFile(target);
    if (name === 'index.html') body = Buffer.from(body.toString().replace('</head>', `<script>window.__WEBUI_CONFIG__={websocketUrl:"ws://fixture.invalid",token:"synthetic-token"};(${installFixtureTransport.toString()})();</script></head>`));
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
    response.writeHead(200, { 'content-type': types[path.extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
const captures = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const settingsVisible = await page.locator('[role="dialog"][aria-label="设置"]').isVisible();
    if (settingsVisible !== name.startsWith('settings-')) throw new Error(`Wrong surface for ${name}`);
    if (!(await page.locator('html').evaluate((element, theme) => element.classList.contains(theme), name.endsWith('-dark') ? 'dark' : 'light'))) throw new Error(`Wrong theme for ${name}`);
    await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
    captures.push({ file: name + '.png', viewport: page.viewportSize(), theme: await page.locator('html').getAttribute('class') });
  }
  await page.goto(base);
  await page.getByPlaceholder('输入消息…（输入 / 唤起命令）').waitFor();
  await page.waitForFunction(() => window.__fixture.requests.some(r => r.operation === 'listSessions'));
  await capture('home-light');
  await page.goto(base + '/#session=A');
  await page.reload();
  await page.getByText('History A synthetic', { exact: true }).waitFor();
  await capture('conversation-light');
  await page.getByTestId('sidebar-user-menu-trigger').click();
  await page.getByTestId('user-menu-settings').click();
  const dialog = page.locator('[role="dialog"][aria-label="设置"]');
  await dialog.waitFor();
  await capture('settings-light');
  await page.locator('.mavis-settings-theme-option').filter({ hasText: '深色模式' }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await capture('settings-dark');
  await page.goto(base + '/#session=A');
  await page.reload();
  await page.getByText('History A synthetic', { exact: true }).waitFor();
  await capture('conversation-dark');
  await page.goto(base);
  await page.getByPlaceholder('输入消息…（输入 / 唤起命令）').waitFor();
  await capture('home-dark');
  const inputHashes = {};
  for (const relative of ['dist-webui/client/client.js', 'dist-webui/client/styles.css', 'packages/webui/test/browser/fixture.mjs']) inputHashes[relative] = createHash('sha256').update(await readFile(path.join(repo, relative))).digest('hex');
  await writeFile(path.join(output, 'capture-manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), trackedChanges: execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }).trim(), evidence: 'Built client with repository synthetic browser fixture; no real host, account or provider', inputHashes, captures, pageErrors: errors }, null, 2) + '\n');
  if (errors.length) throw new Error('Browser page errors: ' + errors.join('; '));
  console.log(`Captured ${captures.length} synthetic reference screens in ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
