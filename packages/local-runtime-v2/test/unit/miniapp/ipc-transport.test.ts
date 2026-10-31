import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MiniAppIpcMessage } from '../../../src/service/miniapp/contracts.js';
import {
  bindMiniAppIpcChannel,
  encodeMiniAppIpcMessage,
  sendMiniAppIpcMessage,
} from '../../../src/service/miniapp/process/node-runtime/ipc-transport.js';

class FakeIpc extends EventEmitter {
  connected = true;
  send = vi.fn<(message: MiniAppIpcMessage, callback: (error: Error | null) => void) => boolean>();
}

describe('Mini App IPC transport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies JSON payloads before queuing and enforces the UTF-8 payload byte limit', () => {
    const payload = { arguments: { text: '你好' } };
    const encoded = encodeMiniAppIpcMessage('miniapp:connector', payload, 256);
    payload.arguments.text = 'changed';
    expect(encoded.payload).toEqual({ arguments: { text: '你好' } });
    expect(() => encodeMiniAppIpcMessage('miniapp:connector', payload, 8)).toThrow('byte limit');
    expect(() => encodeMiniAppIpcMessage('miniapp:connector', { number: 1n }, 256)).toThrow(
      'valid JSON',
    );
    expect(() => encodeMiniAppIpcMessage('miniapp:connector', undefined, 256)).toThrow(
      'valid JSON',
    );
  });

  it.each([
    ['request', 256 * 1024],
    ['response', 8 * 1024 * 1024],
  ] as const)('preserves the full %s payload byte budget in both directions', (_kind, maxBytes) => {
    // {"text":""} is 11 bytes, and the first character contributes three UTF-8 bytes.
    const payload = { text: `界${'a'.repeat(maxBytes - 14)}` };
    const oversized = { text: `${payload.text}a` };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(maxBytes);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBe(maxBytes + 1);
    expect(encodeMiniAppIpcMessage('miniapp:connector', payload, maxBytes)).toEqual({
      type: 'miniapp:connector',
      payload,
    });
    expect(() => encodeMiniAppIpcMessage('miniapp:connector', oversized, maxBytes)).toThrow(
      'byte limit',
    );

    const transport = new FakeIpc();
    const onMessage = vi.fn();
    const onFatal = vi.fn();
    const detach = bindMiniAppIpcChannel(transport, {
      type: 'miniapp:connector',
      maxBytes,
      onMessage,
      onFatal,
    });
    transport.emit('message', { type: 'miniapp:connector', payload });
    expect(onMessage).toHaveBeenCalledWith(payload);
    expect(onFatal).not.toHaveBeenCalled();
    transport.emit('message', { type: 'miniapp:connector', payload: oversized });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('byte limit') }),
    );
    detach();
  });

  it('routes messages by type, checks envelope and size, and removes channel listeners', () => {
    const transport = new FakeIpc();
    const onMessage = vi.fn();
    const onFatal = vi.fn();
    const detach = bindMiniAppIpcChannel(transport, {
      type: 'miniapp:connector',
      maxBytes: 128,
      onMessage,
      onFatal,
    });
    transport.emit('message', { type: 'miniapp:log', message: 'ignored' });
    transport.emit('message', { type: 'miniapp:started' });
    transport.emit('message', { type: 'miniapp:connector', payload: { ok: true } });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ ok: true });
    transport.emit('message', { type: 'miniapp:connector', payload: null, extra: true });
    transport.emit('message', { type: 'miniapp:connector', payload: '界'.repeat(128) });
    transport.emit('disconnect');
    transport.emit('error', new Error('native IPC failed'));
    expect(onFatal).toHaveBeenCalledTimes(4);
    detach();
    expect(transport.eventNames()).toEqual([]);
  });

  it.each([true, false])('waits for the send callback when accepted=%s', async (accepted) => {
    vi.useFakeTimers();
    const transport = new FakeIpc();
    let complete!: (error: Error | null) => void;
    transport.send.mockImplementation((_message, callback) => {
      complete = callback;
      return accepted;
    });
    const onSend = vi.fn();
    let resolved = false;
    const pending = (async () => {
      await sendMiniAppIpcMessage(transport, { type: 'miniapp:connector', payload: {} }, onSend);
      resolved = true;
    })();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(onSend).toHaveBeenCalledOnce();
    complete(null);
    await pending;
    expect(resolved).toBe(true);
    expect(transport.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('bounds a stalled send callback when accepted=%s', async (accepted) => {
    vi.useFakeTimers();
    const transport = new FakeIpc();
    let complete!: (error: Error | null) => void;
    transport.send.mockImplementation((_message, callback) => {
      complete = callback;
      return accepted;
    });
    const onSend = vi.fn();
    let outcome: unknown = 'pending';
    const observed = (async () => {
      try {
        await sendMiniAppIpcMessage(transport, { type: 'miniapp:connector', payload: {} }, onSend);
        outcome = 'resolved';
      } catch (error) {
        outcome = error;
      }
    })();
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual(new Error('Mini App IPC send timed out'));
      expect(onSend).toHaveBeenCalledOnce();
      expect(transport.send).toHaveBeenCalledOnce();
      expect(transport.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      const timeout = outcome;
      complete(null);
      complete(new Error('late callback failure'));
      await observed;
      expect(outcome).toBe(timeout);
    } finally {
      complete(null);
      await observed;
    }
  });

  it('removes attempted channel listeners when registration throws midway', () => {
    const transport = new FakeIpc();
    const existing = vi.fn();
    transport.on('message', existing);
    const originalOn = transport.on.bind(transport);
    vi.spyOn(transport, 'on').mockImplementation((event, listener) => {
      originalOn(event, listener);
      if (event === 'disconnect') throw new Error('private native registration failure');
      return transport;
    });
    const onFatal = vi.fn();
    expect(() =>
      bindMiniAppIpcChannel(transport, {
        type: 'miniapp:connector',
        maxBytes: 128,
        onMessage: vi.fn(),
        onFatal,
      }),
    ).toThrow('Mini App IPC channel registration failed');
    expect(transport.listeners('message')).toEqual([existing]);
    expect(transport.listenerCount('disconnect')).toBe(0);
    expect(transport.listenerCount('error')).toBe(0);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'error', 'callback'] as const)(
    'settles pending sends on %s',
    async (failure) => {
      vi.useFakeTimers();
      const transport = new FakeIpc();
      let complete!: (error: Error | null) => void;
      transport.send.mockImplementation((_message, callback) => {
        complete = callback;
        return false;
      });
      const pending = sendMiniAppIpcMessage(transport, { type: 'miniapp:connector', payload: {} });
      const rejected = expect(pending).rejects.toThrow();
      if (failure === 'callback') complete(new Error('native callback failed'));
      else transport.emit(failure);
      await rejected;
      expect(transport.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      complete(null);
    },
  );

  it('does not claim a handoff when send throws or the channel is already closed', async () => {
    vi.useFakeTimers();
    const transport = new FakeIpc();
    const onSend = vi.fn();
    transport.send.mockImplementation(() => {
      throw new Error('native send threw');
    });
    const message = { type: 'miniapp:connector' as const, payload: {} };
    await expect(sendMiniAppIpcMessage(transport, message, onSend)).rejects.toThrow('send failed');
    expect(onSend).not.toHaveBeenCalled();
    expect(transport.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    transport.connected = false;
    await expect(sendMiniAppIpcMessage(transport, message)).rejects.toThrow('closed');
    expect(transport.send).toHaveBeenCalledOnce();
  });
});
