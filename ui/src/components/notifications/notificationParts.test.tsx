// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow as Row } from '../../types/notifications';
import { DayCard } from './DayCard';
import { EmptyState, LoadingRows, OfflineNotice } from './NotificationStates';
import {
  Icon,
  avatarColors,
  currentActor,
  dayLabel,
  groupActors,
  groupByDay,
  initialsOf,
  inElectron,
  openActionOf,
  relTime,
  rowTime,
  snoozeChoices,
  snoozeText,
  visualOf,
} from './notificationUi';
import { useReadWhenVisible } from './useReadWhenVisible';
import { isTyping, useRowKeys } from './useRowKeys';
import { useTabTitle } from './useTabTitle';

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'r1',
    kind: 'question',
    kindLabel: 'A question',
    needs: true,
    projectId: 'p1',
    title: 'Title',
    body: 'Body',
    targetKind: 'run',
    targetId: 'run_1',
    ticketId: null,
    pageId: null,
    memberId: null,
    memberName: null,
    actor: null,
    count: 1,
    items: [],
    data: {},
    inapp: true,
    desktop: true,
    read: false,
    done: false,
    doneText: null,
    gone: false,
    goneReason: null,
    snoozed: false,
    snoozedUntil: null,
    cleared: false,
    eventId: 1,
    lastEventId: 1,
    createdAt: '2026-10-31T10:00:00Z',
    updatedAt: '2026-10-31T11:00:00Z',
    actions: [],
    dismissable: false,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { electronAPI?: unknown }).electronAPI;
  localStorage.clear();
});

describe('notificationUi helpers', () => {
  const now = new Date('2026-10-31T12:00:00').getTime();

  it('relTime is relative under a day, then a date, and empty for nothing', () => {
    expect(relTime(null)).toBe('');
    expect(relTime('nope')).toBe('');
    expect(relTime(new Date(now - 10_000).toISOString(), now)).toBe('now');
    expect(relTime(new Date(now - 41 * 60000).toISOString(), now)).toBe('41 min');
    expect(relTime(new Date(now - 3 * 3600000).toISOString(), now)).toBe('3 h');
    expect(relTime(new Date(now - 3 * 86400000).toISOString(), now)).toMatch(/\d/);
  });

  it('labels days and groups without repeating a label', () => {
    expect(dayLabel(new Date(now).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(now - 86400000).toISOString(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(now - 5 * 86400000).toISOString(), now)).not.toBe('Today');
    const a = row({ id: 'a', updatedAt: new Date(now).toISOString() });
    const b = row({ id: 'b', updatedAt: new Date(now - 1000).toISOString() });
    const c = row({ id: 'c', updatedAt: new Date(now - 86400000).toISOString() });
    const d = row({ id: 'd', updatedAt: new Date(now).toISOString() });
    const g = groupByDay([a, b, c, d], now, (r) => r.updatedAt);
    expect(g.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'Today']);
    expect(new Set(g.map((x) => x.key)).size).toBe(3);
    expect(g[0].rows).toHaveLength(2);
    expect(groupByDay([a], now)).toHaveLength(1);
    expect(rowTime(row({ needs: true }))).toBe('2026-10-31T10:00:00Z');
    expect(rowTime(row({ needs: false }))).toBe('2026-10-31T11:00:00Z');
  });

  it('finds the action that opens a row, null for gone rows', () => {
    expect(openActionOf(row({ gone: true }))).toBeNull();
    expect(openActionOf(row({ actions: [{ id: 'review', label: 'R' }] }))).toBe('review');
    expect(openActionOf(row({ ticketId: 'K-1' }))).toBe('open_ticket');
    expect(openActionOf(row({ kind: 'day_card' }))).toBe('open');
    expect(openActionOf(row())).toBeNull();
  });

  it('gives each kind an icon and a fallback', () => {
    expect(visualOf('question').icon).toBe('bubble');
    expect(visualOf('run_failed').icon).toBe('triangle');
    expect(visualOf('ai_finished').icon).toBe('check');
    expect(visualOf('unknown').icon).toBe('bell');
    const { container } = render(<Icon name="bell" />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('names people, snoozes and the actor', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('dev')).toBe('DE');
    expect(initialsOf('Dev An')).toBe('DA');
    expect(avatarColors('x')).toEqual(avatarColors('x'));
    expect(
      groupActors(row({ items: [{ actor: 'A' }, { actor: 'A' }, { actor: null }, { actor: 'B' }] as never })),
    ).toEqual(['A', 'B']);
    const n = new Date('2026-10-31T08:00:00');
    expect(snoozeChoices(n).map((c) => c.label)).toEqual(['1 hour', 'This evening 18:00', 'Tomorrow morning 09:00']);
    expect(snoozeChoices(new Date('2026-10-31T20:00:00'))).toHaveLength(2);
    const t = n.getTime();
    expect(snoozeText(new Date(t + 30 * 60000).toISOString(), t)).toMatch(/back in 30 minutes/);
    expect(snoozeText(new Date(t + 60 * 60000).toISOString(), t)).toMatch(/back in 1 hour\./);
    expect(snoozeText(new Date(t + 5 * 3600000).toISOString(), t)).toMatch(/5 hours/);
    expect(snoozeText(new Date(t + 3 * 86400000).toISOString(), t)).toMatch(/3 days/);
    expect(currentActor()).toBe('user');
    localStorage.setItem('kanbanActor', 'Mai');
    expect(currentActor()).toBe('Mai');
    expect(inElectron()).toBe(false);
    window.electronAPI = {} as never;
    expect(inElectron()).toBe(true);
  });
});

describe('NotificationStates', () => {
  it('renders an empty state, loading rows and the offline notice', () => {
    render(<EmptyState icon="bell" title="No notifications yet" text="Soon" />);
    expect(screen.getByText('No notifications yet')).toBeTruthy();
    render(<LoadingRows rows={2} />);
    expect(screen.getByLabelText('Loading notifications').children).toHaveLength(2);
    cleanup();
    const retry = vi.fn();
    const { rerender } = render(<OfflineNotice at={null} onRetry={retry} />);
    expect(screen.getByText(/There is no list to show yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    rerender(<OfflineNotice at={Date.now()} onRetry={retry} />);
    expect(screen.getByText(/The list is what it was at \d/)).toBeTruthy();
  });
});

describe('DayCard', () => {
  const card = (data: Row['data'], over: Partial<Row> = {}) =>
    row({ id: 'dc', kind: 'day_card', needs: false, title: 'Today on your boards', body: 'Fri', data, ...over });

  it('shows the numbers, lines and buttons, and retries once', () => {
    const onAction = vi.fn();
    const onShowNeeds = vi.fn();
    render(
      <DayCard
        row={card({
          finished: 4,
          failed: 2,
          failedRuns: ['a', 'b'],
          waiting: 3,
          spent: 1.5,
          lines: [
            { kind: 'project', text: 'Kanban Board: 14 tickets moved' },
            { kind: 'waiting', text: '3 still wait for you, oldest 2 h' },
            { kind: 'failed', text: 'plain line' },
            { kind: 'other', text: 'a, b' },
          ],
        })}
        onAction={onAction}
        onShowNeeds={onShowNeeds}
      />,
    );
    expect(screen.getByText('$1.50')).toBeTruthy();
    expect(screen.getByText('Kanban Board')).toBeTruthy();
    expect(screen.getByText('plain line')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open the 3 waiting/ }));
    expect(onShowNeeds).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry both failed' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'retry_failed');
    const done = screen.getByRole('button', { name: 'Retried 2' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Board health' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'board_health');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'open');
  });

  it('words the retry button for one, many, and failed counts without a list', () => {
    const { unmount } = render(<DayCard row={card({ failed: 1, failedRuns: ['a'] })} onAction={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry the failed run' })).toBeTruthy();
    unmount();
    render(<DayCard row={card({ failed: 5 })} onAction={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry the 5 failed' })).toBeTruthy();
  });

  it('keeps a quiet day small', () => {
    render(
      <DayCard
        row={card({ quiet: true, lines: [{ kind: 'quiet', text: 'A quiet day' }] }, { read: true })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('A quiet day')).toBeTruthy();
    expect(screen.queryByText('AI runs finished')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Board health' })).toBeNull();
  });
});

describe('useTabTitle', () => {
  beforeEach(() => {
    document.title = 'Kanban Board';
  });

  it('puts the count in front of the title and restores it', () => {
    const { rerender, unmount } = renderHook(({ n }) => useTabTitle(n), { initialProps: { n: 5 } });
    expect(document.title).toBe('(5) Kanban Board');
    rerender({ n: 0 });
    expect(document.title).toBe('Kanban Board');
    rerender({ n: 2 });
    unmount();
    expect(document.title).toBe('Kanban Board');
  });

  it('puts the count back when something else rewrites the title', async () => {
    renderHook(() => useTabTitle(3));
    document.title = 'Other';
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe('(3) Other');
  });

  it('leaves the title alone in the desktop app', () => {
    window.electronAPI = {} as never;
    renderHook(() => useTabTitle(5));
    expect(document.title).toBe('Kanban Board');
  });
});

describe('useRowKeys', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
  const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
    });

  it('moves with J and K, opens, reads and snoozes the selected row', () => {
    const run = vi.fn();
    const { result } = renderHook(() => useRowKeys(true, rows, run));
    key('Enter');
    expect(run).not.toHaveBeenCalled();
    key('j');
    expect(result.current).toBe('a');
    key('j');
    key('j');
    key('j');
    expect(result.current).toBe('c');
    key('k');
    expect(result.current).toBe('b');
    key('Enter');
    expect(run).toHaveBeenLastCalledWith(rows[1], 'open');
    key('e');
    expect(run).toHaveBeenLastCalledWith(rows[1], 'read');
    key('s');
    expect(run).toHaveBeenLastCalledWith(rows[1], 'snooze');
    key('k');
    key('k');
    key('k');
    expect(result.current).toBe('a');
  });

  it('starts K on the first row, ignores modifiers, typing, buttons and empty lists', () => {
    const run = vi.fn();
    const { result } = renderHook(() => useRowKeys(true, rows, run));
    key('k');
    expect(result.current).toBe('a');
    key('j', { ctrlKey: true });
    key('J', { shiftKey: true });
    expect(result.current).toBe('a');
    const input = document.createElement('input');
    document.body.appendChild(input);
    key('j', {}, input);
    expect(result.current).toBe('a');
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    key('Enter', {}, btn);
    expect(run).not.toHaveBeenCalled();
    input.remove();
    btn.remove();
    const empty = renderHook(() => useRowKeys(true, [], run));
    key('j');
    expect(empty.result.current).toBeNull();
  });

  it('does nothing while inactive; isTyping knows inputs', () => {
    const { result } = renderHook(() => useRowKeys(false, rows, vi.fn()));
    key('j');
    expect(result.current).toBeNull();
    expect(isTyping(null)).toBe(false);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.createElement('div'))).toBe(false);
  });
});

describe('useReadWhenVisible', () => {
  type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;
  let cb: Cb;
  const observed: Element[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    observed.length = 0;
    class IO {
      constructor(c: Cb) {
        cb = c;
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IO);
  });
  afterEach(() => vi.unstubAllGlobals());

  function setup(enabled = true) {
    const box = document.createElement('div');
    box.innerHTML =
      '<div data-row-id="a" data-unread="true"></div><div data-unread="true"></div><div data-row-id="c"></div>';
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
    ref.current = box;
    const onRead = vi.fn();
    const hook = renderHook(() => useReadWhenVisible(ref, enabled, 'sig', onRead));
    return { box, onRead, hook };
  }

  it('reads a row after it has been visible for a second, once', () => {
    const { box, onRead } = setup();
    expect(observed).toHaveLength(2);
    const a = box.querySelector('[data-row-id="a"]')!;
    act(() => cb([{ target: a, isIntersecting: true }]));
    act(() => cb([{ target: a, isIntersecting: true }]));
    act(() => void vi.advanceTimersByTime(999));
    expect(onRead).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2));
    expect(onRead).toHaveBeenCalledWith(['a']);
    act(() => cb([{ target: a, isIntersecting: true }]));
    act(() => void vi.advanceTimersByTime(2000));
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it('does not read a row that scrolls out, or one without an id (a placeholder)', () => {
    const { box, onRead } = setup();
    const a = box.querySelector('[data-row-id="a"]')!;
    const noId = box.querySelectorAll('[data-unread]')[1];
    act(() => cb([{ target: a, isIntersecting: true }]));
    act(() => cb([{ target: a, isIntersecting: false }]));
    act(() => cb([{ target: noId, isIntersecting: true }]));
    act(() => void vi.advanceTimersByTime(3000));
    expect(onRead).not.toHaveBeenCalled();
  });

  it('observes nothing when disabled, and clears pending timers on unmount', () => {
    const off = setup(false);
    expect(observed).toHaveLength(0);
    off.hook.unmount();
    const { box, onRead, hook } = setup();
    act(() => cb([{ target: box.querySelector('[data-row-id="a"]')!, isIntersecting: true }]));
    hook.unmount();
    act(() => void vi.advanceTimersByTime(3000));
    expect(onRead).not.toHaveBeenCalled();
  });
});
