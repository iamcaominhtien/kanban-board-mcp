// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow as Row } from '../../types/notifications';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  counts: vi.fn(),
  feed: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  client: {
    get: async (url: string, cfg?: { params?: { since?: number } & Record<string, unknown> }) => {
      if (url === '/notifications') return { data: await api.list(cfg?.params) };
      if (url === '/notifications/counts') return { data: await api.counts() };
      if (url === '/notifications/feed') return { data: await api.feed(cfg?.params?.since) };
      throw new Error(url);
    },
    post: async (url: string, body: unknown) => ({ data: await api.read(url, body) }),
  },
}));
vi.mock('../../api/projects', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'Kanban Board', color: '#AACC2E' }] }),
}));

const toastApi = vi.hoisted(() => ({ showToast: vi.fn((_t: unknown) => 'toast-1'), removeToast: vi.fn() }));
vi.mock('../Toast', () => ({ useToast: () => toastApi }));
const sound = vi.hoisted(() => ({ play: vi.fn(async (_name: string) => true) }));
vi.mock('../../utils/notificationSound', () => ({ playNotificationSound: sound.play }));

import { AllNotificationsPage } from './AllNotificationsPage';
import { NotificationBell } from './NotificationBell';
import { NotificationPanel } from './NotificationPanel';
import { NotificationRow } from './NotificationRow';
import { openActionOf } from './notificationUi';
import { toastAction, toastDetail, useNotificationToasts } from './useNotificationToasts';

function row(over: Partial<Row>): Row {
  return {
    id: 'nt_1',
    kind: 'question',
    kindLabel: 'A question from an AI',
    needs: true,
    projectId: 'p1',
    title: 'BA Bao asks a question',
    body: 'Should the export include archived tickets?',
    targetKind: 'run',
    targetId: 'run_1',
    ticketId: 'KAN-215',
    pageId: null,
    memberId: 'm1',
    memberName: 'BA Bao',
    actor: 'BA Bao',
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actions: [
      { id: 'answer', label: 'Answer' },
      { id: 'open_ticket', label: 'Open ticket' },
    ],
    dismissable: false,
    ...over,
  };
}

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.read.mockResolvedValue({ read: 0 });
});
afterEach(cleanup);

describe('NotificationBell', () => {
  it('shows the Needs you count in red, and nothing else in the number', async () => {
    api.counts.mockResolvedValue({ needs: 5, updatesUnread: 3, updates: 23, snoozed: 0, unread: 8, head: 1 });
    render(wrap(<NotificationBell open={false} onToggle={() => undefined} />));
    expect(await screen.findByText('5')).toBeTruthy();
    expect(screen.queryByTestId('bell-dot')).toBeNull();
  });

  it('shows a blue dot with no number when only updates are unread', async () => {
    api.counts.mockResolvedValue({ needs: 0, updatesUnread: 2, updates: 4, snoozed: 0, unread: 2, head: 1 });
    render(wrap(<NotificationBell open={false} onToggle={() => undefined} />));
    expect(await screen.findByTestId('bell-dot')).toBeTruthy();
    expect(screen.queryByText('2')).toBeNull();
  });

  it('shows a grey dot when the server cannot be reached', async () => {
    api.counts.mockRejectedValue(new Error('offline'));
    render(wrap(<NotificationBell open={false} onToggle={() => undefined} />));
    expect(await screen.findByTestId('bell-dot-offline')).toBeTruthy();
  });
});

describe('NotificationPanel', () => {
  const noop = () => undefined;
  const open = (tab: 'needs' | 'updates') =>
    render(
      wrap(
        <NotificationPanel
          tab={tab}
          onTab={noop}
          onClose={noop}
          onOpenPage={noop}
          onOpenSettings={noop}
          onAction={noop}
        />,
      ),
    );

  it('shows both tabs with their counts and Needs you rows oldest waiting first, done rows after', async () => {
    api.counts.mockResolvedValue({ needs: 2, updatesUnread: 0, updates: 23, snoozed: 0, unread: 2, head: 1 });
    api.list.mockResolvedValue({
      items: [
        row({ id: 'a', title: 'Oldest waiting' }),
        row({ id: 'b', title: 'Newer waiting' }),
        row({
          id: 'c',
          title: 'Finished one',
          done: true,
          read: true,
          doneText: 'You answered in the ticket',
          actions: [],
        }),
      ],
      total: 3,
      head: 1,
      dayCard: null,
      now: '',
    });
    open('needs');
    await screen.findByText('Oldest waiting');
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Updates')).toBeTruthy();
    expect(screen.getByText('23')).toBeTruthy();
    const titles = screen.getAllByText(/waiting|Finished one/).map((e) => e.textContent);
    expect(titles).toEqual(['Oldest waiting', 'Newer waiting', 'Finished one']);
    expect(screen.getByText(/Done — you answered in the ticket/)).toBeTruthy();
  });

  it('offers only Dismiss on a row whose target is gone, and says why', async () => {
    api.counts.mockResolvedValue({ needs: 1, updatesUnread: 0, updates: 0, snoozed: 0, unread: 1, head: 1 });
    api.list.mockResolvedValue({
      items: [
        row({
          gone: true,
          goneReason: 'KAN-215 was deleted, so this cannot be answered.',
          actions: [{ id: 'dismiss', label: 'Dismiss' }],
        }),
      ],
      total: 1,
      head: 1,
      dayCard: null,
      now: '',
    });
    open('needs');
    await screen.findByText('KAN-215 was deleted, so this cannot be answered.');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  });

  it('says Nothing needs you and counts the updates of today, not the 30-day total', async () => {
    api.counts.mockResolvedValue({ needs: 0, updatesUnread: 0, updates: 23, snoozed: 0, unread: 0, head: 1 });
    const old = new Date(Date.now() - 5 * 86400_000).toISOString();
    api.list.mockImplementation(async (p?: { tab?: string }) => ({
      items:
        p?.tab === 'updates'
          ? [
              row({ id: 'u1', needs: false, kind: 'page_published' }),
              row({ id: 'u2', needs: false, kind: 'comment' }),
              row({ id: 'u3', needs: false, kind: 'comment', updatedAt: old, createdAt: old }),
            ]
          : [],
      total: 0,
      head: 1,
      dayCard: null,
      now: '',
    }));
    open('needs');
    expect(await screen.findByText('Nothing needs you')).toBeTruthy();
    expect(await screen.findByText('2 updates from today are in the other tab.')).toBeTruthy();
    expect(screen.queryByText(/23 updates/)).toBeNull();
  });

  it('shows the day card first on the Updates tab', async () => {
    api.counts.mockResolvedValue({ needs: 0, updatesUnread: 0, updates: 1, snoozed: 0, unread: 0, head: 1 });
    api.list.mockResolvedValue({
      items: [
        row({
          id: 'u',
          needs: false,
          kind: 'page_published',
          title: 'Hoa Mai published v14',
          actions: [{ id: 'open', label: 'Open' }],
        }),
      ],
      total: 1,
      head: 1,
      dayCard: row({
        id: 'dc',
        needs: false,
        kind: 'day_card',
        title: 'Today on your boards',
        body: 'Fri 31 Oct · 18:00 · 3 projects',
        data: { finished: 23, failed: 2, failedRuns: ['r1', 'r2'], waiting: 3, spent: 1.84, lines: [] },
      }),
      now: '',
    });
    open('updates');
    expect(await screen.findByText('Today on your boards')).toBeTruthy();
    expect(screen.getByText('$1.84')).toBeTruthy();
    expect(screen.getByText('Open the 3 waiting')).toBeTruthy();
    expect(screen.getByText('Retry both failed')).toBeTruthy();
  });

  it('shows grey rows while loading, never an empty state', () => {
    api.counts.mockReturnValue(new Promise(() => undefined));
    api.list.mockReturnValue(new Promise(() => undefined));
    open('needs');
    expect(screen.getByLabelText('Loading notifications')).toBeTruthy();
    expect(screen.queryByText('No notifications yet')).toBeNull();
  });
});

describe('NotificationRow grouping', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    eventId: i,
    title: 'x',
    ticketId: `AGT-${13 + i}`,
    actor: i % 2 ? 'Dev' : 'Reviewer',
    at: new Date().toISOString(),
  }));

  it('shows "8 AI finished work", Show all 8, and then the lines with Show 4 more', () => {
    const g = row({
      needs: false,
      kind: 'ai_finished',
      title: '8 AI finished work',
      body: 'Reviewer, Dev · AGT-13 to AGT-20',
      count: 8,
      items,
      actions: [{ id: 'expand', label: 'Show all 8' }],
    });
    render(<NotificationRow row={g} onAction={() => undefined} />);
    expect(screen.getByText('8 AI finished work')).toBeTruthy();
    act(() => screen.getByRole('button', { name: /Show all 8/ }).click());
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(4);
    expect(screen.getByRole('button', { name: /Show 4 more/ })).toBeTruthy();
  });

  it('says 20+ and offers Open the list', () => {
    const g = row({
      needs: false,
      kind: 'ai_finished',
      title: '20+ AI finished work',
      count: 23,
      items,
      actions: [{ id: 'expand', label: 'Show all 23' }],
    });
    render(<NotificationRow row={g} onAction={() => undefined} />);
    expect(screen.getByText('20+ AI finished work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the list' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('on the page, Open the list lists the items instead of leaving; in the panel it asks to open the page', () => {
    const big = Array.from({ length: 23 }, (_, i) => ({ ...items[i % 8], eventId: 100 + i }));
    const g = row({ needs: false, kind: 'ai_finished', title: '20+ AI finished work', count: 23, items: big });
    const onAction = vi.fn();
    const { unmount } = render(<NotificationRow row={g} onAction={onAction} />);
    act(() => screen.getByRole('button', { name: 'Open the list' }).click());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: g.id }), 'open_list', undefined);
    unmount();
    render(<NotificationRow row={g} onAction={onAction} onPage />);
    act(() => screen.getByRole('button', { name: 'Open the list' }).click());
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(23);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('starts expanded when the page was opened for this row', () => {
    const g = row({ needs: false, kind: 'ai_finished', title: '9 AI finished work', count: 9, items });
    render(<NotificationRow row={g} onAction={() => undefined} onPage focused />);
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(8);
  });

  it('keeps the chips of a gone row as plain text and finds no action to open', () => {
    const g = row({
      gone: true,
      goneReason: 'KAN-215 was deleted.',
      data: { pageTitle: 'Export spec' },
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
    });
    render(<NotificationRow row={g} onAction={() => undefined} />);
    expect(screen.getByText('KAN-215')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /KAN-215/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Export spec/ })).toBeNull();
    expect(openActionOf(g)).toBeNull();
    expect(openActionOf({ ...g, gone: false })).toBe('open_ticket');
  });

  it('mutes the project from its chip and the kind from the overflow', () => {
    const onAction = vi.fn();
    render(
      <NotificationRow
        row={row({ needs: false, kind: 'ai_finished', actions: [] })}
        onAction={onAction}
        projects={new Map([['p1', { id: 'p1', name: 'Mobile App', color: '#fff' } as never]])}
      />,
    );
    act(() => screen.getByRole('button', { name: /Mobile App/ }).click());
    act(() => screen.getByRole('menuitem', { name: 'Mute Mobile App' }).click());
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'mute_project', { label: 'Mobile App' });
    act(() => screen.getByRole('button', { name: 'More' }).click());
    act(() => screen.getByRole('menuitem', { name: 'Turn this kind off' }).click());
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'mute_kind', undefined);
  });

  it('does not offer "Turn this kind off" on a Needs you row', () => {
    render(<NotificationRow row={row({})} onAction={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('tells a snoozed row and offers Bring back now', () => {
    const until = new Date(Date.now() + 2 * 3600_000).toISOString();
    render(<NotificationRow row={row({ snoozed: true, snoozedUntil: until })} onAction={() => undefined} />);
    expect(screen.getByText(/Snoozed until .*back in 2 hours\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bring back now' })).toBeTruthy();
  });
});

describe('useNotificationToasts', () => {
  const run = (head?: number) =>
    renderHook(() => useNotificationToasts(vi.fn(), head), { wrapper: ({ children }) => wrap(children) });
  // `dnd: true` is the server's default setting (follow the system Do not disturb); it never silences a toast
  const feed = (items: Row[], resolved: string[] = [], head = 10) => ({
    head,
    cursorTooOld: false,
    items,
    resolved,
    dnd: true,
  });

  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows nothing on the first load, only stores the head', async () => {
    api.feed.mockResolvedValueOnce({ head: 5, cursorTooOld: false, items: [row({})], resolved: [] });
    run();
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    expect(api.feed).toHaveBeenCalledWith(undefined);
    expect(toastApi.showToast).not.toHaveBeenCalled();
  });

  it('shows one toast per new Needs you row, none for updates, and removes it when resolved', async () => {
    api.feed.mockResolvedValueOnce({ head: 5, cursorTooOld: false, items: [], resolved: [] });
    const { rerender } = renderHook(({ h }) => useNotificationToasts(vi.fn(), h), {
      wrapper: ({ children }) => wrap(children),
      initialProps: { h: 5 as number | undefined },
    });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    api.feed.mockResolvedValueOnce(
      feed([
        row({ id: 'q1' }),
        row({ id: 'u1', needs: false, kind: 'ai_finished' }),
        row({ id: 'f1', kind: 'run_failed' }),
      ]),
    );
    rerender({ h: 10 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(2));
    expect(api.feed).toHaveBeenLastCalledWith(5);
    const variants = toastApi.showToast.mock.calls.map((c) => (c[0] as unknown as { variant: string }).variant);
    expect(variants).toEqual(['warning', 'error']);

    api.feed.mockResolvedValueOnce(feed([], ['q1'], 11));
    rerender({ h: 11 });
    await waitFor(() => expect(toastApi.removeToast).toHaveBeenCalledWith('toast-1'));
  });

  const primed = async () => {
    api.feed.mockResolvedValueOnce({ head: 5, cursorTooOld: false, items: [], resolved: [] });
    const hook = renderHook(({ h }) => useNotificationToasts(vi.fn(), h), {
      wrapper: ({ children }) => wrap(children),
      initialProps: { h: 5 as number | undefined },
    });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    return hook;
  };

  it('shows no toast in quiet hours, though the row is loud', async () => {
    const { rerender } = await primed();
    api.feed.mockResolvedValueOnce({ ...feed([row({ id: 'q1' })]), quiet: true });
    rerender({ h: 10 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
    expect(toastApi.showToast).not.toHaveBeenCalled();
  });

  it('toasts a question again when it is asked again, and after its toast closed', async () => {
    const { rerender } = await primed();
    api.feed.mockResolvedValueOnce(feed([row({ id: 'q1', lastEventId: 3 })]));
    rerender({ h: 10 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(1));
    // the same event again: nothing new
    api.feed.mockResolvedValueOnce(feed([row({ id: 'q1', lastEventId: 3 })], [], 11));
    rerender({ h: 11 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(3));
    expect(toastApi.showToast).toHaveBeenCalledTimes(1);
    // a reminder moved the row on: the old toast goes, a new one comes
    api.feed.mockResolvedValueOnce(feed([row({ id: 'q1', lastEventId: 9 })], [], 12));
    rerender({ h: 12 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(2));
    expect(toastApi.removeToast).toHaveBeenCalledWith('toast-1');
    // its toast closed; a later event toasts once more
    (toastApi.showToast.mock.calls[1][0] as { onClose: () => void }).onClose();
    api.feed.mockResolvedValueOnce(feed([row({ id: 'q1', lastEventId: 9 })], [], 13));
    rerender({ h: 13 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(3));
  });

  it('keeps a Needs you toast until it is acted on or closed, and plays the chosen sound with it (#270)', async () => {
    const { rerender } = await primed();
    api.feed.mockResolvedValueOnce({ ...feed([row({ id: 'q1' })]), sound: true, soundName: 'bell' });
    rerender({ h: 10 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(1));
    expect(toastApi.showToast.mock.calls[0][0]).toMatchObject({ duration: 0 });
    expect(sound.play).toHaveBeenCalledTimes(1);
    expect(sound.play).toHaveBeenCalledWith('bell');
  });

  it('plays the sound again for a reminder, and not at all when the sound is off', async () => {
    const { rerender } = await primed();
    api.feed.mockResolvedValueOnce({ ...feed([row({ id: 'q1', lastEventId: 11 })]), sound: true });
    rerender({ h: 10 });
    await waitFor(() => expect(sound.play).toHaveBeenCalledTimes(1));
    api.feed.mockResolvedValueOnce({
      ...feed([row({ id: 'q1', lastEventId: 14, reminded: true })], [], 14),
      sound: true,
    });
    rerender({ h: 14 });
    await waitFor(() => expect(sound.play).toHaveBeenCalledTimes(2));
    api.feed.mockResolvedValueOnce({
      ...feed([row({ id: 'q2', lastEventId: 15 })], [], 15),
      sound: false,
    });
    rerender({ h: 15 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(3));
    expect(sound.play).toHaveBeenCalledTimes(2);
  });

  it('makes no sound for a row that earns no toast (information, quiet hours)', async () => {
    const { rerender } = await primed();
    api.feed.mockResolvedValueOnce({
      ...feed([row({ id: 'u1', needs: false, kind: 'ai_finished' })]),
      sound: true,
    });
    rerender({ h: 10 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
    api.feed.mockResolvedValueOnce({ ...feed([row({ id: 'q9' })], [], 12), sound: true, quiet: true });
    rerender({ h: 12 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(3));
    expect(sound.play).not.toHaveBeenCalled();
  });

  it('hands every feed after the first to the browser notifier', async () => {
    const seen = vi.fn();
    api.feed.mockResolvedValueOnce({ head: 5, cursorTooOld: false, items: [], resolved: [] });
    const { rerender } = renderHook(({ h }: { h?: number }) => useNotificationToasts(vi.fn(), h, seen), {
      initialProps: { h: undefined } as { h?: number },
      wrapper: ({ children }) => wrap(children),
    });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    expect(seen).not.toHaveBeenCalled(); // the first call only gives the cursor
    api.feed.mockResolvedValueOnce(feed([row({ id: 'q1' })]));
    rerender({ h: 10 });
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    expect(seen.mock.calls[0][0].items[0].id).toBe('q1');
  });

  it('shows the ticket and the question as the detail line, and one action', async () => {
    const { rerender } = await primed();
    api.feed.mockResolvedValueOnce(feed([row({ id: 'q1' })]));
    rerender({ h: 10 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(1));
    const t = toastApi.showToast.mock.calls[0][0] as Record<string, unknown>;
    expect(t.message).toBe('KAN-215 · Should the export include archived tickets?');
    expect(t.action).toMatchObject({ label: 'Answer' });
    expect(t.secondaryAction).toBeUndefined();
    expect(toastDetail(row({ body: 'KAN-215 failed', ticketId: 'KAN-215' }))).toBe('KAN-215 failed');
  });

  it("a toast's one button is the safe way in, never a decision taken from under the cursor", () => {
    const a = (id: string, label = id) => ({ id, label });
    const pick = (kind: string, ids: string[]) => toastAction(row({ kind, actions: ids.map((i) => a(i)) }))?.id;
    expect(pick('approval', ['approve', 'deny', 'review'])).toBe('review');
    expect(pick('run_failed', ['retry', 'open_run_log'])).toBe('open_run_log');
    expect(pick('run_stopped_memory', ['retry', 'open_run_log'])).toBe('open_run_log');
    expect(pick('blocked', ['open_ticket', 'change_permission'])).toBe('change_permission');
    expect(pick('question', ['answer', 'open_ticket'])).toBe('answer');
    expect(pick('account_signed_out', ['sign_in'])).toBe('sign_in');
    expect(pick('mention', ['dismiss'])).toBeUndefined();
  });

  it('does not toast a loud row that is already done, quiet, or when the window is hidden', async () => {
    api.feed.mockResolvedValueOnce({ head: 5, cursorTooOld: false, items: [], resolved: [] });
    const { rerender } = renderHook(({ h }) => useNotificationToasts(vi.fn(), h), {
      wrapper: ({ children }) => wrap(children),
      initialProps: { h: 5 as number | undefined },
    });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    api.feed.mockResolvedValueOnce(feed([row({ id: 'd', done: true }), row({ id: 'q', inapp: false })]));
    rerender({ h: 10 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    api.feed.mockResolvedValueOnce(feed([row({ id: 'z' })], [], 12));
    rerender({ h: 12 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(3));
    expect(toastApi.showToast).not.toHaveBeenCalled();
  });

  it('does not toast a row that arrives while the window is not focused', async () => {
    api.feed.mockResolvedValueOnce({ head: 5, cursorTooOld: false, items: [], resolved: [] });
    const { rerender } = renderHook(({ h }) => useNotificationToasts(vi.fn(), h), {
      wrapper: ({ children }) => wrap(children),
      initialProps: { h: 5 as number | undefined },
    });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    api.feed.mockResolvedValueOnce(feed([row({ id: 'z' })], [], 12));
    rerender({ h: 12 });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
    expect(toastApi.showToast).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    api.feed.mockResolvedValueOnce(feed([row({ id: 'y' })], [], 14));
    rerender({ h: 14 });
    await waitFor(() => expect(toastApi.showToast).toHaveBeenCalledTimes(1));
    focus.mockRestore();
  });
});

describe('AllNotificationsPage', () => {
  const lastParams = () => api.list.mock.calls[api.list.mock.calls.length - 1]?.[0] as Record<string, unknown>;
  it('does not cut Needs you and Snoozed by the days select', async () => {
    api.counts.mockResolvedValue({ needs: 1, updatesUnread: 0, updates: 0, snoozed: 1, unread: 1, head: 1 });
    api.list.mockResolvedValue({ items: [], total: 0, head: 1, dayCard: null, now: '' });
    render(wrap(<AllNotificationsPage onBack={() => undefined} onOpenSettings={() => undefined} onAction={vi.fn()} />));
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({ filter: 'all', days: 7 });
    act(() => screen.getByRole('button', { name: /Needs you/ }).click());
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: 'needs' }));
    expect(lastParams().days).toBeUndefined();
    act(() => screen.getByRole('button', { name: /Snoozed/ }).click());
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: 'snoozed' }));
    expect(lastParams().days).toBeUndefined();
    act(() => screen.getByRole('button', { name: /Unread/ }).click());
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: 'unread', days: 7 }));
  });

  it('groups by the last activity and never repeats a day header', async () => {
    api.counts.mockResolvedValue({ needs: 0, updatesUnread: 0, updates: 3, snoozed: 0, unread: 0, head: 1 });
    const old = new Date(Date.now() - 3 * 86400_000).toISOString();
    api.list.mockResolvedValue({
      items: [
        row({ id: 'a', needs: false, title: 'A', createdAt: old }),
        row({ id: 'b', needs: false, title: 'B', createdAt: old }),
      ],
      total: 2,
      head: 1,
      dayCard: null,
      now: '',
    });
    render(wrap(<AllNotificationsPage onBack={() => undefined} onOpenSettings={() => undefined} onAction={vi.fn()} />));
    await screen.findByText('A');
    expect(screen.getAllByText('Today')).toHaveLength(1);
  });
});
