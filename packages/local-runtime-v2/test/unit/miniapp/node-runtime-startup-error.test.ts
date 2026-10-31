import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  attachMiniAppRuntimeErrorDetail,
  MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES,
  readMiniAppRuntimeErrorDetail,
} from '../../../src/service/miniapp/errors.js';
import {
  attachStartupFailureDetail,
  captureStartupError,
  isRunnerErrorMessage,
  MiniAppNodeRuntimeError,
} from '../../../src/service/miniapp/process/node-runtime/node-runtime-startup-error.js';

describe('Mini App startup error boundary', () => {
  it('retains only the typed BUSY reason on Node runtime admission failures', () => {
    expect(
      new MiniAppNodeRuntimeError('BUSY', 'plugin root exists', {
        busyReason: 'operation_busy',
      }),
    ).toMatchObject({ code: 'BUSY', busyReason: 'operation_busy' });
    expect(
      new MiniAppNodeRuntimeError('RUNNER_START_FAILED', 'not an admission failure', {
        busyReason: 'capacity_busy',
      }),
    ).not.toHaveProperty('busyReason');
  });

  it.each([
    { value: undefined, valid: false },
    { value: null, valid: false },
    { value: [], valid: false },
    { value: { type: 'other', code: 'RUNNER_START_FAILED', errorText: 'failure' }, valid: false },
    { value: { type: 'miniapp:error', code: 500, errorText: 'failure' }, valid: false },
    {
      value: { type: 'miniapp:error', code: 'RUNNER_START_FAILED', errorText: 500 },
      valid: false,
    },
    {
      value: {
        type: 'miniapp:error',
        code: 'RUNNER_START_FAILED',
        errorText: 'failure',
      },
      valid: true,
    },
  ])('accepts only the complete runner error envelope', ({ value, valid }) => {
    expect(isRunnerErrorMessage(value)).toBe(valid);
  });

  it('copies an existing safe detail without reinterpreting it', () => {
    const source = new Error('source');
    attachMiniAppRuntimeErrorDetail(source, {
      errorText: 'safe startup error',
      stderr: 'safe stderr',
    });
    const target = new Error('target');

    attachStartupFailureDetail(source, target);

    expect(readMiniAppRuntimeErrorDetail(target)).toEqual({
      errorText: 'safe startup error',
      stderr: 'safe stderr',
    });
  });

  it('falls back to safe text for ordinary and non-convertible startup errors', () => {
    const ordinary = new Error('spawn failed');
    ordinary.stack = undefined;
    const ordinaryTarget = new Error('target');
    attachStartupFailureDetail(ordinary, ordinaryTarget);
    expect(readMiniAppRuntimeErrorDetail(ordinaryTarget)).toEqual({
      errorText: 'Error: spawn failed',
    });

    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('conversion failed');
      },
    };
    const hostileTarget = new Error('target');
    attachStartupFailureDetail(hostile, hostileTarget);
    expect(readMiniAppRuntimeErrorDetail(hostileTarget)).toEqual({
      errorText: 'Runtime startup error could not be converted to text',
    });
  });

  it('keeps the bounded stderr tail when successive chunks wrap the ring buffer', () => {
    const stderr = new PassThrough();
    const capture = captureStartupError({ stderr } as unknown as ChildProcess);
    stderr.emit('data', Buffer.alloc(MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES - 2, 0x61));
    stderr.emit('data', Buffer.from('TAIL'));
    const target = new Error('target');

    capture.attachFailure(target, new Error('startup failed'));

    const detail = readMiniAppRuntimeErrorDetail(target);
    expect(detail?.stderr).toMatch(/^\[\.\.\. stderr truncated from/u);
    expect(detail?.stderr?.endsWith('TAIL')).toBe(true);
    expect(Buffer.byteLength(detail?.stderr ?? '', 'utf8')).toBeLessThanOrEqual(
      MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES,
    );
    expect(stderr.listenerCount('data')).toBe(0);
  });

  it('accepts string stderr chunks and ignores empty chunks', () => {
    const stderr = new PassThrough();
    const capture = captureStartupError({ stderr } as unknown as ChildProcess);
    stderr.emit('data', Buffer.alloc(0));
    stderr.emit('data', 'string stderr');
    const target = new Error('target');

    capture.attachFailure(target, new Error('startup failed'));

    expect(readMiniAppRuntimeErrorDetail(target)?.stderr).toBe('string stderr');
  });

  it('starts an oversized single-chunk tail after a UTF-8 continuation boundary', () => {
    const stderr = new PassThrough();
    const capture = captureStartupError({ stderr } as unknown as ChildProcess);
    const prefixBytes = 16;
    const originalBytes = MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES + prefixBytes;
    const largestNotice = `[... stderr truncated from ${originalBytes} bytes; showing last ${MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES} bytes ...]\n`;
    const continuationOffset = Buffer.byteLength(largestNotice, 'utf8');
    const retained = Buffer.alloc(MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES, 0x61);
    retained[continuationOffset] = 0x80;
    retained[continuationOffset + 1] = 0xbf;
    stderr.emit('data', Buffer.concat([Buffer.alloc(prefixBytes, 0x62), retained]));
    const target = new Error('target');

    capture.attachFailure(target, new Error('startup failed'));

    const captured = readMiniAppRuntimeErrorDetail(target)?.stderr;
    expect(captured).toMatch(/^\[\.\.\. stderr truncated from/u);
    expect(captured).not.toContain('�');
    expect(Buffer.byteLength(captured ?? '', 'utf8')).toBeLessThanOrEqual(
      MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES,
    );
  });
});
