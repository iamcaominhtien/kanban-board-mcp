// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow as Row } from '../../types/notifications';

const m = vi.hoisted(() => ({
  answer: vi.fn(),
  retry: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  dismiss: vi.fn(),
  snooze: vi.fn(),
  clear: vi.fn(),
  read: vi.fn(),
  setFollow: vi.fn(),
}));
const ops = vi.hoisted(() => ({
  trouble: vi.fn(),
  continueWith: vi.fn(),
  handTo: vi.fn(),
  moveAccount: vi.fn(),
  conflict: vi.fn(),
  arbitration: vi.fn(),
}));
const openRun = vi.hoisted(() => vi.fn());
vi.mock('../../api/aiOps', () => ({ aiOpsApi: ops }));
vi.mock('../aiteam/runLink', () => ({ openRun }));
vi.mock('../../api/ai', () => ({ aiApi: { answer: m.answer, retry: m.retry, cancel: vi.fn() } }));
vi.mock('../../api/aiSafety', () => ({ safetyApi: { approve: m.approve, deny: m.deny } }));
vi.mock('../../api/notifications', () => ({
  notificationKeys: { all: ['notifications'] },
  notificationsApi: {
    dismiss: m.dismiss,
    snooze: m.snooze,
    clear: m.clear,
    read: m.read,
    setFollow: m.setFollow,
  },
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock('../Toast', () => ({ useToast: () => toast }));

import { useNotificationActions } from './useNotificationActions';

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'nt_1',
    kind: 'question',
    kindLabel: 'A question',
    needs: true,
    projectId: 'p1',
    title: 't',
    body: 'b',
    targetKind: 'run',
    targetId: 'run_1',
    ticketId: 'KAN-1',
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
    createdAt: '',
    updatedAt: '',
    actions: [],
    dismissable: false,
    ...over,
  };
}

function setup() {
  const navigate = vi.fn();
  const qc = new QueryClient();
  const { result } = renderHook(() => useNotificationActions(navigate), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  return { act: result.current, navigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(m) as (keyof typeof m)[]) m[k].mockResolvedValue({});
});

describe('useNotificationActions', () => {
  it('answers a run with the text, or opens the ticket without one', async () => {
    const { act, navigate } = setup();
    await act(row(), 'answer', { text: 'Yes' });
    expect(m.answer).toHaveBeenCalledWith('run_1', 'Yes');
    await act(row(), 'answer');
    expect(navigate).toHaveBeenCalledWith(expect.anything(), 'open_ticket');
  });

  it('approves, warns when the board could not apply it, and denies', async () => {
    const { act } = setup();
    await act(row(), 'approve');
    expect(m.approve).toHaveBeenCalledWith('run_1');
    expect(toast.error).not.toHaveBeenCalled();
    m.approve.mockResolvedValueOnce({ error: 'conflict' });
    await act(row(), 'approve');
    expect(toast.error).toHaveBeenCalledWith('Approved, but it could not be applied', 'conflict');
    await act(row({ targetId: null }), 'approve');
    expect(m.approve).toHaveBeenCalledTimes(2);
    await act(row(), 'deny');
    expect(m.deny).toHaveBeenCalledWith('run_1');
    await act(row({ targetId: null }), 'deny');
    expect(m.deny).toHaveBeenCalledTimes(1);
  });

  it('retries a run, only when the target is a run', async () => {
    const { act } = setup();
    await act(row(), 'retry');
    expect(m.retry).toHaveBeenCalledWith('run_1');
    await act(row({ targetKind: 'ticket' }), 'retry');
    expect(m.retry).toHaveBeenCalledTimes(1);
  });

  it('retries the failed runs of the day card and reports what happened', async () => {
    const { act } = setup();
    await act(row({ data: { failedRuns: ['a'] } }), 'retry_failed');
    expect(toast.info).toHaveBeenCalledWith('Retried 1 failed run');
    m.retry.mockReset();
    m.retry.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('x'));
    await act(row({ data: { failedRuns: ['a', 'b', 'c'] } }), 'retry_failed');
    expect(toast.info).toHaveBeenCalledWith('Retried 2 failed runs');
    expect(toast.error).toHaveBeenCalledWith('Could not retry every run', '1 did not start.');
    toast.info.mockClear();
    await act(row({ data: {} }), 'retry_failed');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('dismisses, snoozes, unsnoozes, clears and reads', async () => {
    const { act } = setup();
    await act(row(), 'dismiss');
    expect(m.dismiss).toHaveBeenCalledWith('nt_1');
    await act(row(), 'snooze', { until: 'T' });
    expect(m.snooze).toHaveBeenCalledWith('nt_1', 'T');
    await act(row(), 'snooze');
    expect(m.snooze).toHaveBeenCalledWith('nt_1', null);
    await act(row(), 'unsnooze');
    expect(m.snooze).toHaveBeenCalledTimes(3);
    await act(row(), 'clear');
    expect(m.clear).toHaveBeenCalledWith('nt_1', true);
    await act(row(), 'read');
    expect(m.read).toHaveBeenCalledWith({ ids: ['nt_1'] });
  });

  it('mutes a ticket, a project and a kind', async () => {
    const { act } = setup();
    await act(row(), 'mute');
    expect(m.setFollow).toHaveBeenCalledWith(expect.objectContaining({ scope: 'ticket', scopeId: 'KAN-1' }));
    expect(toast.info).toHaveBeenCalledWith('KAN-1 is muted', expect.any(String), 5000);
    await act(row({ ticketId: null }), 'mute');
    expect(m.setFollow).toHaveBeenCalledTimes(1);
    await act(row(), 'mute_project', { label: 'Mobile' });
    expect(m.setFollow).toHaveBeenCalledWith(expect.objectContaining({ scope: 'project', label: 'Mobile' }));
    expect(toast.info).toHaveBeenCalledWith('Mobile is muted', expect.any(String), 5000);
    await act(row(), 'mute_project');
    expect(toast.info).toHaveBeenCalledWith('The project is muted', expect.any(String), 5000);
    await act(row({ projectId: null }), 'mute_project');
    expect(m.setFollow).toHaveBeenCalledTimes(3);
    await act(row(), 'mute_kind');
    expect(m.setFollow).toHaveBeenCalledWith(expect.objectContaining({ scope: 'kind', scopeId: 'question' }));
    expect(toast.info).toHaveBeenCalledWith('A question is off', expect.any(String), 5000);
  });

  it.each(['open', 'open_ticket', 'sign_in', 'review', 'open_ai', 'change_permission', 'open_list', 'expand'])(
    'sends %s to navigate and marks an unread row read',
    async (id) => {
      const { act, navigate } = setup();
      await act(row(), id, { ticketId: 'KAN-9' });
      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'nt_1' }), id, { ticketId: 'KAN-9' });
      expect(m.read).toHaveBeenCalledWith({ ids: ['nt_1'] });
    },
  );

  it('maps the trouble, hand-over, conflict and arbitration actions to their endpoints', async () => {
    const { act } = setup();
    ops.trouble.mockResolvedValue({ done: true, text: 'Stopped npm run dev' });
    await act(row(), 'trouble:stop_child');
    expect(ops.trouble).toHaveBeenCalledWith('run_1', 'stop_child', undefined);
    expect(toast.info).toHaveBeenCalledWith('Stopped npm run dev');
    await act(row(), 'trouble:wait');
    await act(row(), 'trouble:tell_ai');
    await act(row(), 'trouble:cancel');
    expect(ops.trouble.mock.calls.map((c) => c[1])).toEqual(['stop_child', 'wait', 'tell_ai', 'cancel']);
    await act(row(), 'continue_note', { text: ' use the cache ' });
    expect(ops.continueWith).toHaveBeenCalledWith('run_1', 'use the cache');
    await act(row(), 'hand_to', { memberId: 'm2', text: 'go' });
    expect(ops.handTo).toHaveBeenCalledWith('run_1', 'm2', 'go');
    await act(row(), 'move_account', { accountId: 'acc2' });
    expect(ops.moveAccount).toHaveBeenCalledWith('run_1', 'acc2');
    await act(row({ targetKind: 'ticket', targetId: 'KAN-1' }), 'conflict:ai');
    expect(ops.conflict).toHaveBeenCalledWith('KAN-1', 'ai');
    await act(row(), 'arbitration:split');
    expect(ops.arbitration).toHaveBeenCalledWith('KAN-1', 'split');
  });

  it('opens a run in the run history, and the ticket when the row has no run', async () => {
    const { act, navigate } = setup();
    await act(row(), 'open_run_log');
    expect(openRun).toHaveBeenCalledWith('run_1');
    expect(navigate).toHaveBeenCalledWith(expect.anything(), 'open_run');
    openRun.mockClear();
    await act(row({ targetKind: 'ticket' }), 'open_run_log');
    expect(openRun).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith(expect.anything(), 'open_run_log', undefined);
  });

  it('does not mark a read row read again', async () => {
    const { act, navigate } = setup();
    await act(row({ read: true }), 'open');
    expect(navigate).toHaveBeenCalled();
    expect(m.read).not.toHaveBeenCalled();
  });

  it('shows an error toast when something fails', async () => {
    const { act } = setup();
    m.dismiss.mockRejectedValueOnce(new Error('boom'));
    await act(row(), 'dismiss');
    expect(toast.error).toHaveBeenCalledWith('Could not do that', expect.any(String));
  });
});
