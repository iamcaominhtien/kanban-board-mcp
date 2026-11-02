// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: c }));

import { NotificationsSettings } from './NotificationsSettings';

function base(over: Record<string, unknown> = {}) {
  return {
    events: [
      { kind: 'question', label: 'A question from an AI', needs: true, inapp: true, inappLocked: true, desktop: true },
      { kind: 'day_card', label: 'The day card', needs: false, inapp: true, inappLocked: false, desktop: false },
      {
        kind: 'page_published',
        label: 'Page published',
        needs: false,
        inapp: false,
        inappLocked: false,
        desktop: true,
      },
      { kind: 'other', label: 'Other', needs: false, inapp: true, inappLocked: false, desktop: true },
    ],
    quiet: { on: false, start: '22:00', end: '07:00' },
    desktopOn: true,
    dnd: false,
    sound: false,
    soundName: 'chime',
    remindAfterMin: 15,
    dayCard: { on: true, time: '18:00', days: [0, 1, 2, 3, 4] },
    retentionDays: 90,
    muted: [],
    ...over,
  };
}

function setup(data = base()) {
  c.get.mockResolvedValue({ data });
  c.patch.mockImplementation(async () => ({ data }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotificationsSettings />
    </QueryClientProvider>,
  );
}

const lastPatch = () => c.patch.mock.calls[c.patch.mock.calls.length - 1]?.[1];

describe('NotificationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    cleanup();
  });

  it('shows loading then an error when it cannot load', async () => {
    c.get.mockRejectedValue(new Error('x'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <NotificationsSettings />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    await screen.findByText('Could not load the notification settings.');
  });

  it('renders the two groups and the rows', async () => {
    setup();
    await screen.findByTestId('notifications-settings');
    expect(screen.getByText(/Needs you — may interrupt/)).toBeTruthy();
    expect(screen.getByText(/For information — never interrupts/)).toBeTruthy();
    expect(screen.getByTestId('event-question')).toBeTruthy();
    expect(screen.getByTestId('event-day_card').textContent).toContain('18:00');
    expect(screen.getByTestId('event-page_published').textContent).toContain('Spaces you follow');
    expect(screen.getByText(/In app stays on for everything that needs you/)).toBeTruthy();
  });

  it('locks In app for Needs you rows', async () => {
    setup();
    const sw = await screen.findByLabelText('A question from an AI: in app (always on)');
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles desktop and in app on a kind', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('A question from an AI: desktop'));
    await waitFor(() => expect(lastPatch()).toEqual({ events: [{ kind: 'question', desktop: false }] }));
    fireEvent.click(screen.getByLabelText('Other: in app'));
    await waitFor(() => expect(lastPatch()).toEqual({ events: [{ kind: 'other', inapp: false }] }));
  });

  it('saves quiet hours, dnd and sound', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Quiet hours'));
    await waitFor(() => expect(lastPatch()).toEqual({ quiet: { on: true } }));
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '23:00' } });
    await waitFor(() => expect(lastPatch()).toEqual({ quiet: { start: '23:00' } }));
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '06:30' } });
    await waitFor(() => expect(lastPatch()).toEqual({ quiet: { end: '06:30' } }));
    fireEvent.click(screen.getByLabelText('Follow the system Do not disturb'));
    await waitFor(() => expect(lastPatch()).toEqual({ dnd: true }));
    fireEvent.click(screen.getByLabelText('Sound'));
    await waitFor(() => expect(lastPatch()).toEqual({ sound: true }));
  });

  it('ignores an emptied time input', async () => {
    setup();
    const input = await screen.findByLabelText('Quiet hours start');
    fireEvent.change(input, { target: { value: '' } });
    expect(c.patch).not.toHaveBeenCalled();
  });

  it('saves the day card time, weekday chips and retention', async () => {
    setup();
    fireEvent.change(await screen.findByLabelText('Day card time'), { target: { value: '19:15' } });
    await waitFor(() => expect(lastPatch()).toEqual({ dayCard: { time: '19:15' } }));
    // turn Sat on: stays in numeric order
    fireEvent.click(screen.getByRole('button', { name: 'Sat' }));
    await waitFor(() => expect(lastPatch()).toEqual({ dayCard: { days: [0, 1, 2, 3, 4, 5] } }));
    // turn Wed off
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }));
    await waitFor(() => expect(lastPatch()).toEqual({ dayCard: { days: [0, 1, 3, 4] } }));
    fireEvent.change(screen.getByLabelText('Keep notifications for'), { target: { value: '365' } });
    await waitFor(() => expect(lastPatch()).toEqual({ retentionDays: 365 }));
  });

  it('retention is read-only for someone who is not an owner or an admin', async () => {
    setup(base({ retentionEditable: false }));
    const select = (await screen.findByLabelText('Keep notifications for')) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(
      screen.getByText('Then they are deleted, for everyone. Only an owner or an admin can change this.'),
    ).toBeTruthy();
  });

  it('describes the day card days and adds an odd retention choice', async () => {
    setup(base({ dayCard: { on: true, time: '08:00', days: [] }, retentionDays: 45 }));
    await screen.findByText('Not sent.');
    expect(screen.getByRole('option', { name: '45 days' })).toBeTruthy();
    cleanup();
    setup(base({ dayCard: { on: true, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } }));
    await screen.findByText('Every day at 08:00.');
    cleanup();
    setup(base({ dayCard: { on: true, time: '08:00', days: [6, 0] } }));
    await screen.findByText('Mon, Sun at 08:00.');
    cleanup();
    setup();
    await screen.findByText('Weekdays at 18:00.');
  });

  it('shows the message of a rejected save', async () => {
    setup();
    c.patch.mockRejectedValue({ response: { data: { detail: 'Quiet hours must differ' } } });
    fireEvent.click(await screen.findByLabelText('Quiet hours'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Quiet hours must differ');
  });

  it('lists muted items and unmutes', async () => {
    c.delete.mockResolvedValue({});
    setup(
      base({
        muted: [
          {
            id: 'm1',
            scope: 'ticket',
            scopeId: 'KAN-1',
            projectId: null,
            level: 'mute',
            until: null,
            label: 'KAN-1 Thing',
            createdAt: '2026-03-04T10:00:00Z',
          },
          {
            id: 'm2',
            scope: 'page',
            scopeId: 'pg',
            projectId: null,
            level: 'mentions',
            until: null,
            label: '',
            createdAt: '2026-03-04T10:00:00Z',
          },
          {
            id: 'm3',
            scope: 'page',
            scopeId: 'pg3',
            projectId: null,
            level: 'mute',
            until: '2026-03-04T12:00:00Z',
            label: 'Timed',
            createdAt: 'bad',
          },
          {
            id: 'm4',
            scope: 'page',
            scopeId: 'pg4',
            projectId: null,
            level: 'mentions',
            until: null,
            label: 'Bad',
            createdAt: 'bad',
          },
          {
            id: 'm5',
            scope: 'page',
            scopeId: 'pg5',
            projectId: null,
            level: 'mute',
            until: null,
            label: 'Plain',
            createdAt: 'bad',
          },
        ],
      }),
    );
    const list = await screen.findByTestId('muted-list');
    expect(list.textContent).toContain('Muted (5)');
    expect(list.textContent).toContain('KAN-1 Thing');
    expect(list.textContent).toContain('only mentions and questions since');
    expect(list.textContent).toContain('muted until');
    expect(list.textContent).toContain('pg');
    fireEvent.click(within(list).getAllByRole('button', { name: 'Unmute' })[0]);
    await waitFor(() => expect(c.delete).toHaveBeenCalledWith('/notifications/follow/m1'));
  });

  it('says a browser without notifications can only show the count in the tab title', async () => {
    setup();
    await screen.findByText(/This browser cannot show system notifications/);
    expect(screen.queryByLabelText('Desktop notifications')).toBeNull();
  });

  it('saves the sound that was picked and the time of the reminder', async () => {
    setup(base({ sound: true }));
    fireEvent.change(await screen.findByLabelText('Which sound'), { target: { value: 'bell' } });
    await waitFor(() => expect(lastPatch()).toEqual({ soundName: 'bell' }));
    fireEvent.change(screen.getByLabelText('Remind me if unanswered'), { target: { value: '30' } });
    await waitFor(() => expect(lastPatch()).toEqual({ remindAfterMin: 30 }));
    fireEvent.change(screen.getByLabelText('Remind me if unanswered'), { target: { value: '0' } });
    await waitFor(() => expect(lastPatch()).toEqual({ remindAfterMin: 0 }));
  });

  it('keeps the sound choice off while the sound is off', async () => {
    setup(base({ sound: false }));
    const pick = (await screen.findByLabelText('Which sound')) as HTMLSelectElement;
    expect(pick.disabled).toBe(true);
  });

  describe('browser', () => {
    type FakeNotification = {
      permission: NotificationPermission;
      requestPermission: ReturnType<typeof vi.fn>;
    };
    const made: unknown[][] = [];
    function install(permission: NotificationPermission, after: NotificationPermission = permission) {
      const Fake = vi.fn(function (this: unknown, ...args: unknown[]) {
        made.push(args);
      }) as unknown as FakeNotification & (new (...a: unknown[]) => unknown);
      Fake.permission = permission;
      Fake.requestPermission = vi.fn(async () => {
        Fake.permission = after;
        return after;
      });
      vi.stubGlobal('Notification', Fake);
      return Fake;
    }
    afterEach(() => {
      vi.unstubAllGlobals();
      made.length = 0;
    });

    it('asks the browser only from the button, never on its own', async () => {
      const fake = install('default', 'granted');
      setup();
      const allow = await screen.findByRole('button', { name: 'Allow in this browser' });
      expect(fake.requestPermission).not.toHaveBeenCalled();
      fireEvent.click(allow);
      await screen.findByText(/Allowed in this browser/);
      expect(fake.requestPermission).toHaveBeenCalledTimes(1);
    });

    it('sends a test notification once it is allowed', async () => {
      install('granted');
      setup(base({ sound: false }));
      fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
      await screen.findByText(/Sent\. Look for it on your screen/);
      expect(made).toHaveLength(1);
      expect(made[0][0]).toBe('Kanban Board — Test notification');
      // sound off: the system's own sound is not let in either
      expect(made[0][1]).toMatchObject({ silent: true });
    });

    it('explains a blocked browser and how to allow it again', async () => {
      install('denied');
      setup();
      await screen.findByText(/The browser is blocking notifications for this site/);
      fireEvent.click(screen.getByRole('button', { name: 'send a test' }));
      await screen.findByText(/blocking notifications for this site\. Allow them in its site settings/);
      expect(made).toHaveLength(0);
    });

    it('has a switch for the master setting', async () => {
      install('granted');
      setup();
      fireEvent.click(await screen.findByLabelText('Desktop notifications'));
      await waitFor(() => expect(lastPatch()).toEqual({ desktopOn: false }));
    });
  });

  describe('desktop app', () => {
    function bridge(status: unknown, test?: unknown) {
      const n = {
        status: vi.fn().mockResolvedValue(status),
        test: vi.fn().mockResolvedValue(test ?? { ok: true }),
        openSystemSettings: vi.fn(),
      };
      (window as unknown as { electronAPI: unknown }).electronAPI = { notifications: n };
      return n;
    }

    it('toggles the master switch when allowed and sends a test', async () => {
      const n = bridge({ supported: true, permission: 'granted' });
      setup();
      await screen.findByText(/Allowed for this computer/);
      fireEvent.click(screen.getByLabelText('Desktop notifications'));
      await waitFor(() => expect(lastPatch()).toEqual({ desktopOn: false }));
      fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
      await screen.findByText(/Sent\. Look for it on your screen\./);
      expect(n.test).toHaveBeenCalled();
    });

    it('says when the computer has not been asked or is unsupported', async () => {
      bridge({ supported: true, permission: 'default' });
      setup();
      await screen.findByText(/has not been asked yet/);
      cleanup();
      bridge({ supported: false, permission: 'granted' });
      setup();
      expect(await screen.findByText(/Not available on this computer/)).toBeTruthy();
    });

    it('shows the blocked card, opens System Settings and reports a failed test', async () => {
      const n = bridge({ supported: true, permission: 'denied' }, { ok: false, reason: 'Blocked by macOS' });
      setup();
      await screen.findByText('Your computer is blocking notifications');
      fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
      expect(n.openSystemSettings).toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
      await screen.findByText('Blocked by macOS');
    });

    it('reports a test that throws and a failed test without reason', async () => {
      const n = bridge({ supported: true, permission: 'denied' });
      n.test.mockRejectedValueOnce(new Error('boom'));
      n.status.mockResolvedValueOnce({ supported: true, permission: 'denied' }).mockRejectedValue(new Error('no'));
      setup();
      await screen.findByText('Your computer is blocking notifications');
      fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
      await screen.findByText('The test could not be sent.');
      n.test.mockResolvedValueOnce({ ok: false });
      fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
      await waitFor(() => expect(n.test).toHaveBeenCalledTimes(2));
    });

    it('survives a status call that fails', async () => {
      const n = bridge({ supported: true, permission: 'granted' });
      n.status.mockRejectedValue(new Error('x'));
      setup();
      expect(await screen.findByLabelText('Desktop notifications')).toBeTruthy();
    });
  });
});
