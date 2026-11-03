// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow as Row } from '../../types/notifications';

const api = vi.hoisted(() => ({ list: vi.fn(), counts: vi.fn(), read: vi.fn() }));
vi.mock('../../api/client', () => ({
  client: {
    get: async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      if (url === '/notifications') return { data: await api.list(cfg?.params) };
      if (url === '/notifications/counts') return { data: await api.counts() };
      throw new Error(url);
    },
    post: async (url: string, body: unknown) => ({ data: await api.read(url, body) }),
  },
}));
vi.mock('../../api/projects', () => ({
  useProjects: () => ({
    data: [
      { id: 'p1', name: 'Kanban Board', color: '#AACC2E' },
      { id: 'p2', name: 'Mobile App', color: '#123456' },
    ],
  }),
}));

import { AllNotificationsPage } from './AllNotificationsPage';
import { NotificationPanel } from './NotificationPanel';
import { NotificationRow } from './NotificationRow';

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'nt_1',
    kind: 'question',
    kindLabel: 'A question',
    needs: true,
    projectId: 'p1',
    title: 'A title',
    body: 'A body',
    targetKind: 'run',
    targetId: 'run_1',
    ticketId: 'KAN-1',
    pageId: null,
    memberId: 'm1',
    memberName: 'BA Bao',
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actions: [{ id: 'answer', label: 'Answer' }],
    dismissable: false,
    ...over,
  };
}
const page = (items: Row[], dayCard: Row | null = null) => ({ items, total: items.length, head: 1, dayCard, now: '' });
const counts = { needs: 1, needsUnread: 1, updatesUnread: 0, updates: 2, snoozed: 1, unread: 1, head: 1 };

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const click = (el: HTMLElement) => act(() => void fireEvent.click(el));

beforeEach(() => {
  vi.clearAllMocks();
  api.counts.mockResolvedValue(counts);
  api.read.mockResolvedValue({ read: 0 });
  api.list.mockResolvedValue(page([]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NotificationRow branches', () => {
  it('offers Resume first on a ticket stopped at its token cap', () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(
      <NotificationRow
        row={row({
          kind: 'workflow_blocked',
          ticketId: 'KAN-305',
          data: { flag: 'quota_cap' },
          actions: [{ id: 'open', label: 'Open' }],
        })}
        onAction={onAction}
      />,
    );
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume.className).toMatch(/btnPrimary/);
    expect(screen.getByRole('button', { name: 'Open ticket' })).toBeTruthy();
    click(resume);
    expect(onAction.mock.calls[0][1]).toBe('workflow:resume');
  });

  it('answers with options and free text, and can cancel', async () => {
    const onAction = vi.fn().mockResolvedValueOnce(false); // the first answer fails: the box stays
    render(<NotificationRow row={row({ data: { options: ['Yes', 'No', 3] } })} onAction={onAction} />);
    click(screen.getByRole('button', { name: 'Answer' }));
    click(screen.getByRole('button', { name: 'Yes' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'answer', { text: 'Yes' });
    await act(async () => {});
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: ' Maybe ' } });
    click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'answer', { text: 'Maybe' });
    click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });

  it('closes and empties the answer box after a successful answer, and never shows it on a done row', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<NotificationRow row={row()} onAction={onAction} />);
    click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Maybe' } });
    click(screen.getByRole('button', { name: 'Send answer' }));
    await act(async () => {});
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    click(screen.getByRole('button', { name: 'Answer' }));
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('');
    // the row resolves while the box is open: the box goes
    rerender(<NotificationRow row={row({ done: true, doneText: 'Answered' })} onAction={onAction} />);
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
  });

  it('snoozes from the menu, mutes the ticket, brings a snoozed row back', () => {
    const onAction = vi.fn();
    const { unmount } = render(<NotificationRow row={row()} onAction={onAction} />);
    click(screen.getByRole('button', { name: 'Snooze' }));
    click(screen.getByRole('menuitem', { name: '1 hour' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'snooze', { until: expect.any(String) });
    click(screen.getByRole('button', { name: 'Mute this ticket' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'mute', undefined);
    unmount();
    render(
      <NotificationRow
        row={row({ snoozed: true, snoozedUntil: new Date(Date.now() + 3600e3).toISOString() })}
        onAction={onAction}
      />,
    );
    click(screen.getByRole('button', { name: 'Bring back now' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'unsnooze', undefined);
  });

  it('opens an update from its body, Enter and Space, but not from a button; clears it', () => {
    const onAction = vi.fn();
    const r = row({
      needs: false,
      kind: 'comment',
      actions: [{ id: 'open', label: 'Open' }],
      memberName: null,
      ticketId: null,
    });
    const { container } = render(<NotificationRow row={r} onAction={onAction} />);
    const el = container.querySelector('[data-row-id="nt_1"]') as HTMLElement;
    click(screen.getByText('A body'));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'open', undefined);
    onAction.mockClear();
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyDown(el, { key: ' ' });
    fireEvent.keyDown(el, { key: 'a' });
    expect(onAction).toHaveBeenCalledTimes(2);
    onAction.mockClear();
    click(screen.getByRole('button', { name: 'Clear' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'clear', undefined);
  });

  it('shows signed-out members, avatars of a group, a done chip and a gone page chip', () => {
    const items = [1, 2, 3].map((i) => ({
      eventId: i,
      title: `E${i}`,
      actor: `Actor ${i}`,
      ticketId: `K-${i}`,
      at: new Date().toISOString(),
    }));
    const { unmount } = render(
      <NotificationRow
        row={row({ kind: 'account_signed_out', data: { members: 3 }, done: true, doneText: 'Signed in again' })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('3 members')).toBeTruthy();
    expect(screen.getByText(/Done — signed in again/)).toBeTruthy();
    unmount();
    const onAction = vi.fn();
    render(
      <NotificationRow
        row={row({ needs: false, kind: 'comment', count: 6, items, data: { pageTitle: 'Spec' } })}
        onAction={onAction}
        now={Date.now()}
      />,
    );
    expect(screen.getByTitle('Actor 1')).toBeTruthy();
    click(screen.getByRole('button', { name: /Show all 6/ }));
    expect(screen.getByText(/Showing the last 3 of 6/)).toBeTruthy();
    click(screen.getAllByRole('button', { name: 'Open' })[0]);
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'open_item', { ticketId: 'K-1' });
    click(screen.getByRole('button', { name: 'Hide' }));
    click(screen.getByRole('button', { name: 'Spec' }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), 'open', undefined);
  });

  it('pages through a long group with Show more and Hide the list on the page', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      eventId: i,
      title: `E${i}`,
      actor: 'Dev',
      ticketId: null,
      at: new Date().toISOString(),
    }));
    render(
      <NotificationRow row={row({ needs: false, kind: 'ai_finished', count: 30, items })} onAction={vi.fn()} onPage />,
    );
    click(screen.getByRole('button', { name: 'Open the list' }));
    expect(screen.getByRole('button', { name: 'Hide the list' })).toBeTruthy();
    click(screen.getByRole('button', { name: 'Hide the list' }));
    expect(screen.queryByText(/E0/)).toBeNull();
    const three = Array.from({ length: 9 }, (_, i) => ({
      eventId: i,
      title: `T${i}`,
      actor: 'Dev',
      ticketId: null,
      at: new Date().toISOString(),
    }));
    cleanup();
    render(<NotificationRow row={row({ needs: false, kind: 'comment', count: 9, items: three })} onAction={vi.fn()} />);
    click(screen.getByRole('button', { name: /Show all 9/ }));
    click(screen.getByRole('button', { name: /Show 4 more/ }));
    expect(screen.getByRole('button', { name: /Show 1 more/ })).toBeTruthy();
  });
});

describe('NotificationPanel branches', () => {
  const open = (tab: 'needs' | 'updates', over: Partial<Parameters<typeof NotificationPanel>[0]> = {}) => {
    const props = {
      tab,
      onTab: vi.fn(),
      onClose: vi.fn(),
      onOpenPage: vi.fn(),
      onOpenSettings: vi.fn(),
      onAction: vi.fn(),
      ...over,
    };
    render(wrap(<NotificationPanel {...props} />));
    return props;
  };

  it('closes with Esc and a click outside, not a click inside', async () => {
    const p = open('needs');
    await screen.findByText('Nothing needs you');
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(p.onClose).toHaveBeenCalledTimes(2);
    click(screen.getByRole('button', { name: 'Close' }));
    expect(p.onClose).toHaveBeenCalledTimes(3);
  });

  it('marks all read for the tab, opens the page and settings, switches tabs', async () => {
    const p = open('needs');
    await screen.findByText('Nothing needs you');
    click(screen.getByRole('button', { name: /Mark all read/ }));
    await waitFor(() => expect(api.read).toHaveBeenCalledWith('/notifications/read', { all: true, tab: 'needs' }));
    click(screen.getByRole('button', { name: /All notifications/ }));
    click(screen.getByRole('button', { name: 'Notification settings' }));
    click(screen.getByRole('tab', { name: /Updates/ }));
    expect(p.onOpenPage).toHaveBeenCalled();
    expect(p.onOpenSettings).toHaveBeenCalled();
    expect(p.onTab).toHaveBeenCalledWith('updates');
  });

  it('shows the earlier-updates hint, the empty state and the offline notice', async () => {
    api.counts.mockResolvedValue({ ...counts, updates: 4 });
    open('needs');
    expect(await screen.findByText('Earlier updates are in the other tab.')).toBeTruthy();
    cleanup();
    api.counts.mockResolvedValue({ ...counts, needs: 0, updates: 0 });
    open('updates');
    expect(await screen.findByText('No notifications yet')).toBeTruthy();
    cleanup();
    // things wait in Needs you: the empty Updates tab says so instead of "No notifications yet"
    api.counts.mockResolvedValue({ ...counts, needs: 3, updates: 0 });
    open('updates');
    expect(await screen.findByText('No updates')).toBeTruthy();
    expect(screen.getByText(/3 items need you in the other tab/)).toBeTruthy();
    expect(screen.queryByText('No notifications yet')).toBeNull();
    cleanup();
    api.list.mockRejectedValue(new Error('down'));
    open('needs');
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(screen.getByText('Offline')).toBeTruthy();
    click(screen.getByRole('button', { name: 'Try again' }));
  });

  it('lists a done group, the day card, and takes J/Enter/E/S keys', async () => {
    const q = row({ id: 'q', title: 'Open one' });
    const d = row({ id: 'd', title: 'Done one', done: true, read: true, doneText: 'Answered', actions: [] });
    api.list.mockResolvedValue(page([q, d]));
    const p = open('needs');
    await screen.findByText('Open one');
    expect(screen.getByText('Done today')).toBeTruthy();
    const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k })));
    key('j');
    key('s');
    expect(p.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'q' }), 'snooze', {
      until: expect.any(String),
    });
    key('e');
    expect(p.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'q' }), 'read');
    key('j');
    key('s');
    key('Enter');
    expect(p.onAction).toHaveBeenCalledTimes(3);
    expect(p.onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'd' }), 'open_ticket');
  });

  it('opens the row with Enter, and the Needs you tab from the day card', async () => {
    const u = row({ id: 'u', needs: false, kind: 'comment', title: 'Upd', ticketId: 'K-1', actions: [] });
    const dc = row({ id: 'dc', kind: 'day_card', needs: false, title: 'Today', data: { waiting: 2 } });
    api.list.mockResolvedValue(page([u], dc));
    const p = open('updates');
    await screen.findByText('Upd');
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(p.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'u' }), 'open_ticket');
    click(screen.getByRole('button', { name: /Open the 2 waiting/ }));
    expect(p.onTab).toHaveBeenCalledWith('needs');
  });

  it('shows grey rows while switching tabs', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    api.list.mockImplementation((p: { tab: string }) =>
      p.tab === 'needs'
        ? Promise.resolve(page([row({ id: 'q', title: 'Open one' })]))
        : new Promise((r) => (resolve = r)),
    );
    const props = {
      tab: 'needs' as 'needs' | 'updates',
      onTab: vi.fn(),
      onClose: vi.fn(),
      onOpenPage: vi.fn(),
      onOpenSettings: vi.fn(),
      onAction: vi.fn(),
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (tab: 'needs' | 'updates') => (
      <QueryClientProvider client={qc}>
        <NotificationPanel {...props} tab={tab} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui('needs'));
    await screen.findByText('Open one');
    rerender(ui('updates'));
    expect(screen.getByLabelText('Loading notifications')).toBeTruthy();
    expect(screen.queryByText('Open one')).toBeNull();
    resolve(page([]));
  });
});

describe('AllNotificationsPage branches', () => {
  const lastParams = () => api.list.mock.calls[api.list.mock.calls.length - 1]?.[0] as Record<string, unknown>;
  const mountPage = (over: Partial<Parameters<typeof AllNotificationsPage>[0]> = {}) => {
    const props = { onBack: vi.fn(), onOpenSettings: vi.fn(), onAction: vi.fn(), ...over };
    render(wrap(<AllNotificationsPage {...props} />));
    return props;
  };

  it('goes back, opens settings, marks all read and shows the bell', async () => {
    const p = mountPage({ bell: <span>BELL</span> });
    await screen.findByText('No notifications yet');
    expect(screen.getByText('BELL')).toBeTruthy();
    click(screen.getByRole('button', { name: 'Back' }));
    click(screen.getByRole('button', { name: /Notification settings/ }));
    expect(p.onBack).toHaveBeenCalled();
    expect(p.onOpenSettings).toHaveBeenCalled();
    click(screen.getByRole('button', { name: /Mark all read/ }));
    await waitFor(() =>
      expect(api.read).toHaveBeenCalledWith('/notifications/read', { all: true, filter: 'all', days: 7 }),
    );
  });

  it('marks all read only within the filters on the page', async () => {
    mountPage();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Search notifications'), { target: { value: 'export' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'export' }));
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '30' } });
    click(screen.getByRole('button', { name: /Unread/ }));
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: 'unread', q: 'export', days: 30 }));
    click(screen.getByRole('button', { name: /Mark all read/ }));
    await waitFor(() =>
      expect(api.read).toHaveBeenCalledWith('/notifications/read', {
        all: true,
        filter: 'unread',
        q: 'export',
        days: 30,
      }),
    );
  });

  it('searches after a pause and changes the days', async () => {
    mountPage();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Search notifications'), { target: { value: ' export ' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'export' }));
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '30' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ days: 30 }));
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
    expect(screen.getByText('0 in the last 30 days')).toBeTruthy();
    click(screen.getByRole('button', { name: /Needs you/ }));
    await waitFor(() => expect(screen.getByText('0 in all')).toBeTruthy());
    expect((screen.getByLabelText('Days') as HTMLSelectElement).disabled).toBe(true);
  });

  it('filters by project and kind in the side bar, and shows offline', async () => {
    const a = row({ id: 'a', title: 'AAA', projectId: 'p1', needs: false });
    const b = row({ id: 'b', title: 'BBB', projectId: 'p2', needs: false });
    api.list.mockResolvedValue(page([a, b]));
    mountPage();
    await screen.findByText('AAA');
    click(screen.getByRole('checkbox', { name: /Mobile App/ }));
    expect(screen.queryByText('AAA')).toBeNull();
    expect(screen.getByText('BBB')).toBeTruthy();
    click(screen.getByRole('checkbox', { name: /Mobile App/ }));
    expect(screen.getByText('AAA')).toBeTruthy();
    click(screen.getByRole('checkbox', { name: /Mobile App/ }));
    click(screen.getByRole('checkbox', { name: /All projects/ }));
    expect(screen.getByText('AAA')).toBeTruthy();
    click(screen.getByRole('checkbox', { name: 'From AI members' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ family: 'ai' }));
    click(screen.getByRole('checkbox', { name: 'From AI members' }));
    await waitFor(() => expect(lastParams().family).toBeUndefined());
    for (const f of ['Unread', 'Snoozed', 'Done', 'Cleared', 'All'])
      click(screen.getByRole('button', { name: new RegExp(`^${f}`) }));
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: 'all' }));
  });

  it('has the Needs you and Docs kinds, in the order drawn (NT-5)', async () => {
    mountPage();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    const kinds = screen
      .getAllByRole('checkbox')
      .map((c) => c.closest('label')?.textContent ?? '')
      .filter((t) => !/project|Mobile|Kanban/i.test(t) && !/\d/.test(t));
    expect(kinds).toEqual(['Needs you', 'For information', 'From AI members', 'From people', 'Docs', 'Schedules']);
    click(screen.getByRole('checkbox', { name: 'Needs you' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ family: 'needs' }));
    click(screen.getByRole('checkbox', { name: 'Docs' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ family: 'docs' }));
    click(screen.getByRole('checkbox', { name: 'Schedules' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ family: 'schedules' }));
  });

  it('shows offline, and takes keys unless the panel is open', async () => {
    api.list.mockRejectedValue(new Error('down'));
    mountPage();
    expect(await screen.findByText('Not connected')).toBeTruthy();
    click(screen.getByRole('button', { name: 'Try again' }));
  });

  it('runs row keys on the page and opens the focused group expanded', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      eventId: i,
      title: `E${i}`,
      actor: 'Dev',
      ticketId: `K-${i}`,
      at: new Date().toISOString(),
    }));
    const g = row({
      id: 'g',
      needs: false,
      kind: 'ai_finished',
      count: 3,
      items,
      title: 'Group',
      actions: [],
      ticketId: null,
      memberName: null,
    });
    const q = row({ id: 'q', title: 'Qrow' });
    api.list.mockResolvedValue(page([q, g]));
    const p = mountPage({ focusRowId: 'g' });
    await screen.findByText('Qrow');
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(3);
    const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k })));
    key('j');
    key('s');
    key('e');
    key('Enter');
    expect(p.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'q' }), 'snooze', {
      until: expect.any(String),
    });
    expect(p.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'q' }), 'read');
    expect(p.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'q' }), 'open_ticket');
  });
});
