// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationFeed, NotificationRow } from '../../types/notifications';

const sound = vi.hoisted(() => ({ play: vi.fn(async (_name: string) => true) }));
vi.mock('../../utils/notificationSound', () => ({ playNotificationSound: sound.play }));

import { mayNotifyFromBrowser, useBrowserNotifier } from './useBrowserNotifier';

const row = (over: Partial<NotificationRow> = {}): NotificationRow =>
  ({
    id: 'r1',
    kind: 'question',
    needs: true,
    desktop: true,
    done: false,
    read: false,
    gone: false,
    snoozed: false,
    cleared: false,
    title: 'Dev An asks a question',
    body: 'Cursor or offset?',
    ticketId: 'KAN-215',
    lastEventId: 11,
    actions: [],
    ...over,
  }) as NotificationRow;

const feed = (items: NotificationRow[], over: Partial<NotificationFeed> = {}): NotificationFeed => ({
  head: 20,
  cursorTooOld: false,
  items,
  resolved: [],
  sound: true,
  soundName: 'chime',
  ...over,
});

// ── fakes for the browser ──────────────────────────────────────────────────────────────────────────────────────

interface Made {
  title: string;
  options: NotificationOptions;
  close: ReturnType<typeof vi.fn>;
  onclick: (() => void) | null;
  onclose: (() => void) | null;
}
let made: Made[] = [];

function installNotification(permission: NotificationPermission) {
  made = [];
  const Fake = function (this: Made, title: string, options: NotificationOptions) {
    this.title = title;
    this.options = options;
    this.close = vi.fn();
    this.onclick = null;
    this.onclose = null;
    made.push(this);
  } as unknown as { permission: NotificationPermission } & (new (...a: unknown[]) => Made);
  Fake.permission = permission;
  vi.stubGlobal('Notification', Fake);
}

/** Tabs share one lock name: the first to ask holds it until it releases. */
function installLocks() {
  const waiting: { cb: () => Promise<void>; signal?: AbortSignal; resolve: () => void }[] = [];
  let held = false;
  const grantNext = () => {
    if (held) return;
    const next = waiting.shift();
    if (!next) return;
    held = true;
    void next.cb().then(() => {
      held = false;
      next.resolve();
      grantNext();
    });
  };
  const request = (_name: string, opts: { signal?: AbortSignal }, cb: () => Promise<void>) =>
    new Promise<void>((resolve) => {
      waiting.push({ cb, signal: opts.signal, resolve });
      opts.signal?.addEventListener('abort', () => {
        const i = waiting.findIndex((w) => w.cb === cb);
        if (i >= 0) waiting.splice(i, 1);
        resolve();
      });
      grantNext();
    });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}

/** An in-memory BroadcastChannel: every channel of the name hears the others. */
class FakeChannel {
  static all: FakeChannel[] = [];
  listeners = new Set<(e: MessageEvent) => void>();
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this) c.listeners.forEach((l) => l({ data } as MessageEvent));
  }
  addEventListener(_: string, l: (e: MessageEvent) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_: string, l: (e: MessageEvent) => void) {
    this.listeners.delete(l);
  }
  close() {
    FakeChannel.all = FakeChannel.all.filter((c) => c !== this);
  }
}

function looking(at: boolean) {
  Object.defineProperty(document, 'visibilityState', { value: at ? 'visible' : 'hidden', configurable: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(at);
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeChannel.all = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  installLocks();
  installNotification('granted');
  looking(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

const mount = (onOpen = vi.fn()) => renderHook(() => useBrowserNotifier(onOpen));
const flush = () => act(async () => void (await Promise.resolve()));

describe('mayNotifyFromBrowser', () => {
  it('needs the permission and a browser, not the desktop app', () => {
    expect(mayNotifyFromBrowser()).toBe(true);
    installNotification('default');
    expect(mayNotifyFromBrowser()).toBe(false);
    installNotification('granted');
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    expect(mayNotifyFromBrowser()).toBe(false);
  });
});

describe('useBrowserNotifier', () => {
  it('shows a system notification for a Needs you while no tab is being looked at, with our sound', async () => {
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()], { soundName: 'drop' })));
    expect(made).toHaveLength(1);
    expect(made[0].title).toBe('Dev An asks a question');
    expect(made[0].options).toMatchObject({
      body: 'KAN-215 · Cursor or offset?',
      tag: 'r1',
      requireInteraction: true,
    });
    expect(sound.play).toHaveBeenCalledWith('drop');
  });

  it('keeps the system sound out when the page plays its own', async () => {
    Object.defineProperty(navigator, 'userActivation', { value: { hasBeenActive: true }, configurable: true });
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()])));
    expect(made[0].options.silent).toBe(true);
  });

  it('lets the system sound stand in when the browser would keep the page silent (nobody clicked yet)', async () => {
    Object.defineProperty(navigator, 'userActivation', { value: { hasBeenActive: false }, configurable: true });
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()])));
    expect(made[0].options.silent).toBe(false);
  });

  it('is silent with the sound off', async () => {
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()], { sound: false })));
    expect(made[0].options.silent).toBe(true);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it('is silent for information even with the sound on (never a sound for information)', async () => {
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row({ needs: false, kind: 'ai_finished' })])));
    expect(made).toHaveLength(1);
    expect(made[0].options.silent).toBe(true);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it('says nothing while this tab is being looked at', async () => {
    looking(true);
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()])));
    expect(made).toHaveLength(0);
  });

  it('says nothing while another tab of the board is being looked at', async () => {
    const { result } = mount();
    await flush();
    const other = new FakeChannel('kanban-board-notifier');
    act(() => other.postMessage({ id: 'tab-b', focused: true }));
    act(() => result.current(feed([row()])));
    expect(made).toHaveLength(0);
  });

  it('notifies again once that other tab is no longer in front', async () => {
    const { result } = mount();
    await flush();
    const other = new FakeChannel('kanban-board-notifier');
    act(() => other.postMessage({ id: 'tab-b', focused: true }));
    act(() => other.postMessage({ id: 'tab-b', focused: false }));
    act(() => result.current(feed([row()])));
    expect(made).toHaveLength(1);
  });

  it('only one tab sends: the second waits for the lock', async () => {
    const a = mount();
    const b = mount();
    await flush();
    act(() => a.result.current(feed([row()])));
    act(() => b.result.current(feed([row()])));
    expect(made).toHaveLength(1);
  });

  it('the next tab takes over when the notifier tab closes', async () => {
    const a = mount();
    const b = mount();
    await flush();
    a.unmount();
    await flush();
    act(() => b.result.current(feed([row()])));
    expect(made).toHaveLength(1);
  });

  it('works without Web Locks (better two notices than none)', async () => {
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()])));
    expect(made).toHaveLength(1);
  });

  it('clicking the notice focuses the tab, closes it and opens the thing', async () => {
    const onOpen = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { result } = mount(onOpen);
    await flush();
    act(() => result.current(feed([row()])));
    act(() => made[0].onclick?.());
    expect(focus).toHaveBeenCalled();
    expect(made[0].close).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', ticketId: 'KAN-215' }));
  });

  it('withdraws the notice when the question is answered somewhere else', async () => {
    const { result } = mount();
    await flush();
    act(() => result.current(feed([row()])));
    act(() => result.current(feed([], { resolved: ['r1'] })));
    expect(made[0].close).toHaveBeenCalled();
  });

  it('does nothing until the person allowed notifications, and never in the desktop app', async () => {
    installNotification('default');
    const a = mount();
    await flush();
    act(() => a.result.current(feed([row()])));
    expect(made).toHaveLength(0);
    cleanup();
    installNotification('granted');
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    const b = mount();
    await flush();
    act(() => b.result.current(feed([row()])));
    expect(made).toHaveLength(0);
  });

  it('survives a browser that throws when it is asked to show a notice', async () => {
    const Thrower = function () {
      throw new Error('no');
    } as unknown as { permission: NotificationPermission };
    Thrower.permission = 'granted';
    vi.stubGlobal('Notification', Thrower);
    const { result } = mount();
    await flush();
    expect(() => act(() => result.current(feed([row()])))).not.toThrow();
  });
});
