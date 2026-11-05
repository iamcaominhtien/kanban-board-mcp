// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: c }));

import { MoveUrgentDialog } from './MoveUrgentDialog';
import type { AccountWindow, RoomAccount } from '../../../types/aiWindows';

const account = {
  key: 'a1',
  name: 'an',
  email: 'an@example.com',
  plan: 'Max 20×',
  status: 'signed_in',
  maxParallel: 2,
  running: [],
  waiting: 2,
  fiveHour: { used: 0.92, resetsAt: null, status: null },
  sevenDay: { used: null, resetsAt: null, status: null },
  heldUntil: null,
  heldReason: null,
  moveUrgent: false,
  readAt: null,
} as AccountWindow;
const room: RoomAccount[] = [
  { accountId: 'a2', name: 'work', email: 'an.work@example.com', plan: 'Pro', used: 0.41, free: 1 },
];
const run = (id: string, memberId: string, state = 'queued') => ({
  runId: id,
  state,
  memberId,
  ticketId: `KAN-${id}`,
  startedAt: new Date().toISOString(),
});

function setup(onClose = vi.fn(), roomList = room) {
  c.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/ai/board')) {
      const runs = [run('1', 'm1'), run('2', 'm2'), run('3', 'm3')];
      return { data: { tickets: Object.fromEntries(runs.map((r) => [r.ticketId, r])) } };
    }
    return {
      data: [
        { id: 'm1', name: 'M-1', accountId: 'a1' },
        { id: 'm2', name: 'M-2', accountId: 'a2' },
        { id: 'm3', name: 'M-3', accountId: 'a1' },
      ],
    };
  });
  c.post.mockResolvedValue({ data: {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MoveUrgentDialog account={account} room={roomList} projectId="p1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('MoveUrgentDialog', () => {
  it('lists only the waiting runs of this account and moves them to the account with room', async () => {
    const onClose = setup();
    await screen.findByText('M-1');
    expect(screen.queryByText('M-2')).toBeNull();
    expect(screen.getByText(/Only the account changes, and only for this run/)).toBeTruthy();
    expect(screen.getByText(/The conversation does not carry over/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 runs' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(c.post).toHaveBeenCalledWith('/ai/runs/1/move-account', { accountId: 'a2' });
    expect(c.post).toHaveBeenCalledWith('/ai/runs/3/move-account', { accountId: 'a2' });
  });

  it('can move just one run', async () => {
    setup();
    await screen.findByText('M-1');
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Move 1 run' }));
    await waitFor(() => expect(c.post).toHaveBeenCalledTimes(1));
  });

  it('says so and cannot move when no account has room', async () => {
    setup(vi.fn(), []);
    await screen.findByText('M-1');
    expect(screen.getByTestId('move-urgent-no-room')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Move 2 runs' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the dialog open and shows the error when a move is refused', async () => {
    c.post.mockRejectedValue({ response: { data: { detail: 'Run already started' } } });
    const onClose = setup();
    c.post.mockRejectedValue({ response: { data: { detail: 'Run already started' } } });
    await screen.findByText('M-1');
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 runs' }));
    await waitFor(() => expect(c.post).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
