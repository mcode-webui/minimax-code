import { describe, expect, it, vi } from 'vitest';

import {
  createMiniAppPresenter,
  followSelection,
} from '../../src/server/miniapp/presenter.js';

function build(onClosed?: (input: { readonly pluginId: string }) => void) {
  const selected: Array<{ sessionId: string; pluginId: string }> = [];
  const view = createMiniAppPresenter({
    selectSession: (input) => selected.push({ ...input }),
    ...(onClosed ? { onClosed } : {}),
  });
  return { view, selected };
}

describe('Mini App presenter', () => {
  it('selects the session and records what the panel is showing', async () => {
    const { view, selected } = build();
    const intents: unknown[] = [];
    const unsubscribe = view.subscribe((intent) => intents.push(intent));

    expect(view.presented()).toBeUndefined();
    await view.presenter.open({ sessionId: 'session-1', pluginId: 'fixture.miniapp' });

    expect(selected).toEqual([{ sessionId: 'session-1', pluginId: 'fixture.miniapp' }]);
    expect(view.presented()).toEqual({ sessionId: 'session-1', pluginId: 'fixture.miniapp' });
    expect(view.snapshot()).toEqual({
      epoch: expect.any(String),
      revision: 1,
      action: 'open',
      sessionId: 'session-1',
      pluginId: 'fixture.miniapp',
    });
    expect(intents).toEqual([view.snapshot()]);
    unsubscribe();
  });

  it('refuses to open when the caller has already aborted', async () => {
    const { view, selected } = build();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      view.presenter.open({ sessionId: 'session-1', pluginId: 'p', signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(selected).toHaveLength(0);
    expect(view.presented()).toBeUndefined();
  });

  it('uses a new epoch when a replacement service creates the presenter', async () => {
    const previous = build().view;
    await previous.presenter.open({ sessionId: 'session-1', pluginId: 'fixture.miniapp' });
    const previousEpoch = previous.snapshot()?.epoch;

    const replacement = build().view;
    await replacement.presenter.open({ sessionId: 'session-2', pluginId: 'fixture.miniapp' });

    expect(previousEpoch).toEqual(expect.any(String));
    expect(replacement.snapshot()?.epoch).toEqual(expect.any(String));
    expect(replacement.snapshot()?.epoch).not.toBe(previousEpoch);
  });

  it('keeps one presentation: a second open replaces the first', async () => {
    const { view } = build();

    await view.presenter.open({ sessionId: 'session-1', pluginId: 'first' });
    await view.presenter.open({ sessionId: 'session-2', pluginId: 'second' });

    expect(view.presented()).toEqual({ sessionId: 'session-2', pluginId: 'second' });
  });

  it('closes only the Mini App it is showing, and only once', async () => {
    const onClosed = vi.fn();
    const { view } = build(onClosed);
    const intents: unknown[] = [];
    view.subscribe((intent) => intents.push(intent));
    await view.presenter.open({ sessionId: 'session-1', pluginId: 'shown' });

    await view.presenter.close({ pluginId: 'other' });
    expect(view.presented()).toEqual({ sessionId: 'session-1', pluginId: 'shown' });
    expect(onClosed).not.toHaveBeenCalled();

    await view.presenter.close({ pluginId: 'shown' });
    expect(view.presented()).toBeUndefined();
    expect(view.snapshot()).toEqual({
      epoch: expect.any(String),
      revision: 2,
      action: 'close',
      sessionId: 'session-1',
      pluginId: 'shown',
    });
    expect(intents).toEqual([
      { epoch: expect.any(String), revision: 1, action: 'open', sessionId: 'session-1', pluginId: 'shown' },
      { epoch: expect.any(String), revision: 2, action: 'close', sessionId: 'session-1', pluginId: 'shown' },
    ]);
    expect(onClosed).toHaveBeenCalledTimes(1);

    await view.presenter.close({ pluginId: 'shown' });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('carries the path the Agent named onto the open intent', async () => {
    const { view } = build();

    await view.presenter.open({
      sessionId: 'session-1',
      pluginId: 'fixture.miniapp',
      path: '/items/42?tab=details',
    });

    expect(view.snapshot()).toEqual({
      epoch: expect.any(String),
      revision: 1,
      action: 'open',
      sessionId: 'session-1',
      pluginId: 'fixture.miniapp',
      path: '/items/42?tab=details',
    });
  });

  it('names no path when the Agent named none', async () => {
    const { view } = build();

    await view.presenter.open({ sessionId: 'session-1', pluginId: 'fixture.miniapp' });

    expect(view.snapshot()).not.toHaveProperty('path');
  });

  it('stops showing the Mini App when the person selects another session', async () => {
    const closed: string[] = [];
    const { view } = build((input) => closed.push(input.pluginId));
    await view.presenter.open({ sessionId: 'session-1', pluginId: 'fixture.miniapp' });

    followSelection({ view, selectedSessionId: 'session-1' });
    expect(view.presented()).toBeDefined();
    expect(closed).toHaveLength(0);

    followSelection({ view, selectedSessionId: 'session-2' });
    expect(closed).toEqual(['fixture.miniapp']);
  });
});
