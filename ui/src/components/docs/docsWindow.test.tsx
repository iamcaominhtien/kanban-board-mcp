// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A BroadcastChannel shared by the module copies of one test, delivering to every other instance (as browsers do). */
class FakeChannel {
  static all: FakeChannel[] = [];
  private fns: ((e: MessageEvent) => void)[] = [];
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  addEventListener(_t: string, fn: (e: MessageEvent) => void) {
    this.fns.push(fn);
  }
  postMessage(data: unknown) {
    for (const ch of FakeChannel.all) {
      if (ch !== this && ch.name === this.name) {
        queueMicrotask(() => ch.fns.forEach((f) => f({ data } as MessageEvent)));
      }
    }
  }
  close() {
    FakeChannel.all = FakeChannel.all.filter((c) => c !== this);
  }
}

/** Two windows of the app: each its own copy of the modules (its own channel and window id). */
async function twoWindows() {
  vi.resetModules();
  const board = await import('./useDocsWindow');
  vi.resetModules();
  const docs = await import('./useDocsWindow');
  const urls = await import('./docsWindow');
  return { board, docs, urls };
}

describe('Docs in its own window', () => {
  beforeEach(() => {
    vi.useRealTimers();
    FakeChannel.all = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    localStorage.clear();
    localStorage.setItem('docsPage:p1', 'pg1');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds the window and board addresses from the current one', async () => {
    const { urls } = await twoWindows();
    const base = 'http://127.0.0.1:5173/?proj=old&ticket=KAN-1#x';
    const docsUrl = new URL(urls.docsWindowUrl('p1', 'pg1', base));
    expect(Object.fromEntries(docsUrl.searchParams)).toEqual({ proj: 'p1', docs: 'pg1', docsWindow: '1' });
    expect(docsUrl.hash).toBe('');
    expect(urls.isDocsWindow(docsUrl.search)).toBe(true);
    const back = new URL(urls.boardUrl('p1', null, docsUrl.toString()));
    expect(Object.fromEntries(back.searchParams)).toEqual({ proj: 'p1', docs: '' });
    expect(urls.isDocsWindow(back.search)).toBe(false);
    expect(urls.docsWindowName('a b/c')).toBe('kanban-docs-abc');
  });

  it('the board sees the Docs window and its page, and docks it back on that page', async () => {
    const { board, docs } = await twoWindows();
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const onDock = vi.fn();
    const host = renderHook(() => board.useDocsWindowHost('p1', onDock));
    const guest = renderHook(() => docs.useDocsWindowGuest('p1'));
    await waitFor(() => expect(host.result.current.popped?.pageId).toBe('pg1'));

    // the board's "Dock back here" asks the window, which docks itself
    act(() => host.result.current.dockBack());
    await waitFor(() => expect(onDock).toHaveBeenCalledWith('pg1'));
    await waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 2000 });
    expect(host.result.current.popped).toBeNull();
    guest.unmount();
  });

  it('a page opened on the board goes to the Docs window, a ticket opened there to the board', async () => {
    const { board, docs } = await twoWindows();
    const onOpenTicket = vi.fn();
    const onOpenPage = vi.fn();
    const host = renderHook(() => board.useDocsWindowHost('p1', vi.fn(), onOpenTicket));
    const guest = renderHook(() => docs.useDocsWindowGuest('p1', onOpenPage));
    await waitFor(() => expect(host.result.current.popped).not.toBeNull());
    act(() => host.result.current.openPage('pg2'));
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith('pg2'));
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => guest.result.current.openTicket('KAN-7'));
    await waitFor(() => expect(onOpenTicket).toHaveBeenCalledWith('KAN-7'));
    await new Promise((r) => setTimeout(r, 800));
    expect(open).not.toHaveBeenCalled(); // the board answered: no new window
  });

  it('with no board to dock into, the Docs window becomes the board itself', async () => {
    const { docs } = await twoWindows();
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace, href: 'http://127.0.0.1:5173/?proj=p1&docsWindow=1' });
    const guest = renderHook(() => docs.useDocsWindowGuest('p1'));
    act(() => guest.result.current.dock());
    await waitFor(() => expect(replace).toHaveBeenCalled(), { timeout: 2000 });
    const to = new URL(replace.mock.calls[0][0] as string);
    expect(to.searchParams.get('docsWindow')).toBeNull();
    expect(to.searchParams.get('docs')).toBe('pg1');
  });
});
