// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  action: vi.fn(),
  navigate: undefined as undefined | ((row: unknown, id: string, extra?: unknown) => void),
  setHealthOpen: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  client: {
    get: async (url: string) => {
      if (url === '/notifications/counts')
        return { data: { needs: 2, updatesUnread: 0, updates: 1, snoozed: 0, unread: 2, head: 1 } };
      if (url === '/notifications') return { data: { items: [], total: 0, head: 1, dayCard: null, now: '' } };
      throw new Error(url);
    },
    post: async () => ({ data: {} }),
  },
}));
vi.mock('../../api/projects', () => ({ useProjects: () => ({ data: [] }) }));
vi.mock('../assist/AssistContext', () => ({ useAssist: () => ({ setHealthOpen: h.setHealthOpen }) }));
vi.mock('./useNotificationToasts', () => ({ useNotificationToasts: () => undefined }));
vi.mock('./useNotificationActions', () => ({
  useNotificationActions: (nav: (row: unknown, id: string, extra?: unknown) => void) => {
    h.navigate = nav;
    return h.action;
  },
}));

import {
  NotificationBellButton,
  NotificationsHost,
  NotificationsPageView,
  requestOpenNotifications,
} from './NotificationsHost';

const cb = {
  onOpenTicket: vi.fn(),
  onOpenDoc: vi.fn(),
  onOpenAiTab: vi.fn(),
  onOpenAiMember: vi.fn(),
  onOpenPage: vi.fn(),
  onOpenSettings: vi.fn(),
};

function mount(children: React.ReactNode = <div>app</div>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotificationsHost {...cb}>{children}</NotificationsHost>
    </QueryClientProvider>,
  );
}

const key = (k: string, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
const panel = () => screen.queryByRole('dialog', { name: 'Notifications' });

function nav(row: Record<string, unknown>, id: string, extra?: unknown) {
  act(() =>
    h.navigate!(
      { id: 'r', kind: 'question', ticketId: null, pageId: null, memberId: 'm1', projectId: 'p1', ...row },
      id,
      extra,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  document.title = 'Kanban';
});
afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
  document.body.innerHTML = '';
});

describe('NotificationsHost keys and events', () => {
  it('N toggles the panel, Esc closes, Shift N opens the page', async () => {
    mount();
    expect(panel()).toBeNull();
    key('n');
    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeTruthy();
    key('n');
    expect(panel()).toBeNull();
    key('n');
    await screen.findByRole('dialog');
    key('Escape');
    expect(panel()).toBeNull();
    key('N');
    expect(cb.onOpenPage).toHaveBeenCalledTimes(1);
  });

  it('ignores N while typing or while another dialog is open', () => {
    mount(<input aria-label="field" />);
    key('n', screen.getByLabelText('field'));
    expect(panel()).toBeNull();
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    document.body.appendChild(dlg);
    key('n');
    expect(panel()).toBeNull();
    dlg.remove();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true })));
    expect(panel()).toBeNull();
  });

  it('opens the panel, the page and settings from the window event', async () => {
    mount();
    act(() => requestOpenNotifications('panel', 'updates'));
    const tab = await screen.findByRole('tab', { name: /Updates/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    act(() => requestOpenNotifications('panel'));
    act(() => requestOpenNotifications('page', undefined, 'row_9'));
    expect(panel()).toBeNull();
    expect(cb.onOpenPage).toHaveBeenCalledTimes(1);
    act(() => requestOpenNotifications('panel'));
    await screen.findByRole('dialog');
    act(() => requestOpenNotifications('settings'));
    expect(panel()).toBeNull();
    expect(cb.onOpenSettings).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new CustomEvent('kanban:notifications')));
  });

  it('the panel buttons open the page and settings', async () => {
    mount();
    key('n');
    fireEvent.click(await screen.findByRole('button', { name: /All notifications/ }));
    expect(cb.onOpenPage).toHaveBeenCalled();
    key('n');
    fireEvent.click(await screen.findByRole('button', { name: 'Notification settings' }));
    expect(cb.onOpenSettings).toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it('sets the tab title from the Needs you count', async () => {
    mount();
    await waitFor(() => expect(document.title).toBe('(2) Kanban'));
  });
});

describe('NotificationsHost navigation', () => {
  it('routes each action to the app', () => {
    mount();
    nav({ ticketId: 'K-1' }, 'open_ticket');
    expect(cb.onOpenTicket).toHaveBeenLastCalledWith('K-1');
    nav({ pageId: 'pg' }, 'open_run_log');
    expect(cb.onOpenDoc).toHaveBeenLastCalledWith('pg', 'p1');
    nav({ ticketId: 'K-1' }, 'open_item', { ticketId: 'K-7' });
    expect(cb.onOpenTicket).toHaveBeenLastCalledWith('K-7');
    nav({}, 'sign_in');
    expect(cb.onOpenAiTab).toHaveBeenLastCalledWith('accounts', 'p1');
    nav({ kind: 'page_proposal', pageId: 'pg2' }, 'review');
    expect(cb.onOpenDoc).toHaveBeenLastCalledWith('pg2', 'p1');
    nav({}, 'review');
    expect(cb.onOpenAiTab).toHaveBeenLastCalledWith('approvals', 'p1');
    nav({ projectId: 'p2' }, 'review');
    expect(cb.onOpenAiTab).toHaveBeenLastCalledWith('approvals', 'p2');
    nav({}, 'open_ai');
    expect(cb.onOpenAiMember).toHaveBeenLastCalledWith('m1', 'p1');
    nav({}, 'change_permission');
    expect(cb.onOpenAiMember).toHaveBeenCalledTimes(2);
    nav({ id: 'row5' }, 'open_list');
    expect(cb.onOpenPage).toHaveBeenCalledTimes(1);
    nav({}, 'board_health');
    expect(h.setHealthOpen).toHaveBeenCalledWith(true);
    nav({ kind: 'day_card' }, 'open');
    expect(cb.onOpenPage).toHaveBeenCalledTimes(2);
    nav({ pageId: 'pg3' }, 'open');
    expect(cb.onOpenDoc).toHaveBeenLastCalledWith('pg3', 'p1');
    nav({ ticketId: 'K-3' }, 'reply');
    expect(cb.onOpenTicket).toHaveBeenLastCalledWith('K-3');
    nav({}, 'open');
    expect(cb.onOpenPage).toHaveBeenCalledTimes(3);
  });
});

describe('NotificationsHost views', () => {
  it('renders the bell and the page view inside the host, and nothing outside it', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onBack = vi.fn();
    const outside = render(
      <QueryClientProvider client={qc}>
        <NotificationBellButton />
        <NotificationsPageView onBack={onBack} onOpenSettings={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(outside.container.innerHTML).toBe('');
    outside.unmount();
    mount(
      <>
        <NotificationBellButton />
        <NotificationsPageView onBack={onBack} onOpenSettings={vi.fn()} />
      </>,
    );
    expect(await screen.findByRole('heading', { name: 'All notifications' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
    expect(document.querySelector('[data-notification-bell]')).toBeTruthy();
  });
});

describe('NotificationsHost desktop bridge', () => {
  type OpenCb = (payload: unknown) => void;
  let onOpen: OpenCb;
  let backendReady: () => void;
  const setActor = vi.fn();

  beforeEach(() => {
    setActor.mockReset();
    window.electronAPI = {
      onBackendReady: (c: () => void) => {
        backendReady = c;
        return () => undefined;
      },
      notifications: {
        setActor,
        onOpen: (c: OpenCb) => {
          onOpen = c;
          return () => undefined;
        },
      },
    } as never;
    localStorage.setItem('kanbanActor', 'Mai');
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('tells the desktop app who acts, retrying when the backend is not ready', async () => {
    vi.useFakeTimers();
    setActor.mockResolvedValueOnce(false).mockResolvedValue(true);
    mount();
    await act(async () => {});
    expect(setActor).toHaveBeenCalledWith('Mai');
    expect(setActor).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(setActor).toHaveBeenCalledTimes(2);
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(setActor).toHaveBeenCalledTimes(2);
    act(() => backendReady());
    await act(async () => {});
    expect(setActor).toHaveBeenCalledTimes(3);
    setActor.mockRejectedValueOnce(new Error('x'));
    act(() => backendReady());
    await act(async () => {});
    expect(setActor).toHaveBeenCalledTimes(4);
  });

  it('routes a click on a desktop notice', async () => {
    mount();
    expect(onOpen).toBeTypeOf('function');
    act(() => onOpen(undefined));
    expect(h.action).not.toHaveBeenCalled();
    // a row from the desktop app arrives in snake_case with its own action
    act(() => onOpen({ id: 'r1', kind: 'question', ticket_id: 'K-1', actions: [], action: 'answer' }));
    expect(h.action).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'r1', ticketId: 'K-1' }), 'answer');
    act(() => onOpen({ id: 'r2', kind: 'question', ticket_id: 'K-2', actions: [] }));
    expect(h.action).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'r2' }), 'open_ticket');
    h.action.mockClear();
    act(() => onOpen({ id: 'r3', kind: 'question', needs: false, gone: true, actions: [] }));
    expect(h.action).not.toHaveBeenCalled();
    expect((await screen.findByRole('tab', { name: /Updates/ })).getAttribute('aria-selected')).toBe('true');
    act(() => onOpen({ group: true, ids: ['a'], needs: true }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected')).toBe('true'),
    );
    act(() => onOpen({ group: true, ids: ['a'], needs: false }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Updates/ }).getAttribute('aria-selected')).toBe('true'),
    );
  });

  it('does nothing without a bridge', () => {
    window.electronAPI = {} as never;
    mount();
    expect(setActor).not.toHaveBeenCalled();
  });
});
