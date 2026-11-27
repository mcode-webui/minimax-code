import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

const projectButton = '[data-webui-workspace-picker="true"]';

// Browser errors can contain the launch URL, including its credential.
function publicMessage(error) {
  return String(error?.message ?? error)
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/giu, '[URL]')
    .replace(/((?:token|nativeDirectoryGrant|browserKey)=)[^\s&"']+/giu, '$1[redacted]');
}

async function chooseFromHome({ page, directory, action, driveDialog, beforeChoose, timeoutMs }) {
  await page.bringToFront();
  await page.locator(projectButton).click({ timeout: timeoutMs });
  const origin = new URL(page.url()).origin;
  const controller = new AbortController();
  let request;
  let response;
  let failedRequest = false;
  let drive;
  let driverDone = false;
  let driverError;
  let duplicate = false;
  const onRequest = (outgoing) => {
    const url = new URL(outgoing.url());
    if (outgoing.method() !== 'POST' || url.origin !== origin || url.pathname !== '/native-directory-picker') return;
    if (request) { duplicate = true; return; }
    request = outgoing;
    drive = Promise.resolve().then(() => driveDialog({ action, directory, signal: controller.signal }))
      .then(() => { driverDone = true; }, (error) => { driverError = publicMessage(error); });
  };
  const onResponse = (incoming) => { if (incoming.request() === request) response = incoming; };
  const onFailed = (failed) => { if (failed === request) failedRequest = true; };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  const toast = page.locator('[data-webui-toast-tone="error"] .webui-toast-message:visible')
    .filter({ hasText: /系统(?:文件夹选择器|目录选择)/u }).last();
  const deadline = Date.now() + timeoutMs;
  try {
    await beforeChoose?.();
    await page.getByRole('option', { name: '选择新项目', exact: true }).click({ timeout: timeoutMs });
    while (Date.now() < deadline) {
      if (duplicate) throw new Error('One project selection sent multiple chooser requests.');
      if (response && !response.ok()) {
        // Wait for React to render the actual failure, including failures before a window opens.
        const message = await toast.innerText({ timeout: 3000 }).catch(() => '(no visible picker error)');
        throw new Error(`Native folder ${action} returned HTTP ${response.status()}. ${message}`);
      }
      if (await toast.isVisible()) {
        const message = await toast.innerText({ timeout: 1000 });
        throw new Error(`Native folder ${action}: ${response ? 'HTTP ' + response.status() : 'no HTTP response'}. ${message}`);
      }
      if (failedRequest) throw new Error(`Native folder ${action} failed before an HTTP response.`);
      if (driverError !== undefined) throw new Error(`Native folder ${action} could not operate the OS window: ${driverError}`);
      if (response && driverDone) {
        // The leaf must answer the expected action as well as the UI displaying its result.
        const result = await response.json();
        assert.equal(response.status(), 200);
        if (action === 'cancel') assert.deepEqual(result, { kind: 'cancelled' });
        else assert.deepEqual(result, { kind: 'selected', directory });
        return;
      }
      await delay(75);
    }
    throw new Error(`Native folder ${action} timed out (request=${Boolean(request)}, HTTP=${response?.status() ?? 'none'}, native driver finished=${driverDone}).`);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
    controller.abort();
    // The platform driver owns its helper process and must terminate it on abort.
    if (drive) await drive;
  }
}

// /new is the shipped local command. It creates a real session with the home
// composer's chosen workspace, without a model turn or a provider credential.
async function createAndReadSession(page, directory, timeoutMs) {
  const project = page.locator('[data-webui-project-link]').and(page.getByTitle(directory, { exact: true }));
  await expect(project, 'Use a fresh acceptance directory with no previous session.').toHaveCount(0);
  const editor = page.getByPlaceholder('输入消息…（输入 / 唤起命令）');
  await editor.fill('/new', { timeout: timeoutMs });
  await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: timeoutMs });
  await expect(page.locator('[data-webui-command-output]')).toHaveText('New session created.', { timeout: timeoutMs });
  const session = project.locator('xpath=ancestor::li[1]').locator('[data-webui-session-link]');
  async function expectSessionInRail(stage) {
    await expect(project, `The chosen project must appear in the rail ${stage}.`).toBeVisible({ timeout: timeoutMs });
    if (await project.getAttribute('aria-expanded') !== 'true') await project.click({ timeout: timeoutMs });
    await expect(session, `The chosen project must contain its new session ${stage}.`).toHaveCount(1, { timeout: timeoutMs });
    await expect(session).toBeVisible({ timeout: timeoutMs });
  }
  await expectSessionInRail('before reload');
  const sessionId = await session.getAttribute('data-webui-session-link');
  assert.ok(sessionId, 'The live rail did not identify its new session.');
  // Reload only after observing the live update, then verify the same session survived.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await expectSessionInRail('after reload');
  await expect(session).toHaveAttribute('data-webui-session-link', sessionId, { timeout: timeoutMs });
  return sessionId;
}

/**
 * Use a launcher-opened page with isolated data and a fresh test directory.
 * driveDialog must operate the real OS chooser and release its resources on abort.
 * initialProject, when provided, is the expected text of the initial home project button.
 */
export async function verifyNativeProjectJourney({ page, directory, driveDialog, beforeChoose, initialProject, timeoutMs = 45000 }) {
  try {
    assert.ok(path.isAbsolute(directory), 'Expected an absolute test folder on the executing platform.');
    const row = page.locator(projectButton);
    await expect(row).toBeVisible({ timeout: timeoutMs });
    const before = (await row.innerText()).trim();
    if (initialProject !== undefined) assert.equal(before, initialProject);
    const label = directory.split(/[\\/]/u).filter(Boolean).at(-1) || directory;
    assert.notEqual(before, label, 'Choose a folder whose label differs from the initial workspace.');
    for (const action of ['select', 'cancel']) {
      await chooseFromHome({ page, directory, action, driveDialog, beforeChoose, timeoutMs });
      await expect(row).toHaveText(label, { timeout: timeoutMs });
    }
    const sessionId = await createAndReadSession(page, directory, timeoutMs);
    return { directory, sessionId };
  } catch (error) {
    throw new Error(publicMessage(error));
  }
}
