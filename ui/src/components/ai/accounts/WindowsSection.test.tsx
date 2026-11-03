// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountWindow, WindowsOverview } from '../../../types/aiWindows';

const http = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { ToastProvider } from '../../Toast';
import { WindowsSection } from './WindowsSection';

const acct = (o: Partial<AccountWindow> = {}): AccountWindow => ({
  key: 'a1',
  name: 'an',
  email: 'an@example.com',
  plan: 'Max 20×',
  status: 'signed_in',
  maxParallel: 2,
  running: [],
  waiting: 0,
  fiveHour: { used: 0.3, resetsAt: null, status: null },
  sevenDay: { used: 0.1, resetsAt: null, status: null },
  heldUntil: null,
  heldReason: null,
  moveUrgent: false,
  readAt: null,
  ...o,
});

function setup(overview: WindowsOverview | Error) {
  http.get.mockImplementation(async (url: string) => {
    if (url === '/ai/windows') {
      if (overview instanceof Error) throw overview;
      return { data: overview };
    }
    return { data: { runs: [], settings: {}, members: [], summary: {} } };
  });
  http.patch.mockResolvedValue({ data: {} });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <WindowsSection projectId="p1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('WindowsSection', () => {
  it('shows a loading state, then the empty note', async () => {
    setup({ accounts: [], room: [] });
    expect(screen.getByLabelText('Loading usage windows')).toBeTruthy();
    await screen.findByTestId('windows-empty');
    expect(screen.getByText(/Where these numbers come from/)).toBeTruthy();
  });

  it('shows the error and retries', async () => {
    setup(new Error('down'));
    await screen.findByTestId('load-error');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(http.get.mock.calls.filter((c) => c[0] === '/ai/windows').length).toBeGreaterThan(1));
  });

  it('shows a held account with its reason, the runs it holds and the local login line', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    setup({
      accounts: [
        acct({
          waiting: 2,
          heldUntil: future,
          heldReason: 'Window used up',
          fiveHour: { used: 1, resetsAt: future, status: 'rejected' },
          running: [{ runId: 'r1', ticketId: 'KAN-9', memberId: 'm', startedAt: new Date().toISOString() }],
        }),
        acct({
          key: 'local',
          name: 'This computer',
          email: null,
          plan: 'Pro',
          fiveHour: { used: null, resetsAt: null, status: null },
        }),
      ],
      room: [{ accountId: 'local', name: 'This computer', email: null, plan: 'Pro', used: null, free: 1 }],
    });
    const card = await screen.findByTestId('window-a1');
    expect(card.getAttribute('data-held')).toBe('true');
    expect(screen.getByTestId('win-held').textContent).toMatch(/Window used up\. Held since the window was used up/);
    expect(screen.getByTestId('win-held').textContent).toMatch(/Starts again at/);
    expect(card.textContent).toContain('KAN-9');
    expect(card.textContent).toContain('2 runs held until');
    const local = screen.getByTestId('window-local');
    expect(local.textContent).toContain('Pro · signed in');
    expect(local.textContent).toContain('This computer');
    expect(local.textContent).toContain('Nothing running.');
  });

  it('marks a signed-out account and offers no move when no other account has room', async () => {
    setup({
      accounts: [acct({ status: 'needs_sign_in', waiting: 1, readAt: new Date().toISOString() })],
      room: [{ accountId: 'a1', name: 'an', email: null, plan: null, used: 0.2, free: 1 }],
    });
    const card = await screen.findByTestId('window-a1');
    expect(card.className).toContain('win-card-out');
    expect(card.textContent).toContain('signed out');
    expect(screen.getByTestId('win-read').textContent).toMatch(/before it signed out/);
    const move = screen.getByRole('button', { name: 'Move urgent work' }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
  });

  it('opens the move dialog when another account has room', async () => {
    setup({
      accounts: [acct({ waiting: 1 })],
      room: [{ accountId: 'a2', name: 'work', email: null, plan: 'Pro', used: 0.2, free: 1 }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Move urgent work' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('saves the limit when committed, clamped to 1..20, and not when unchanged', async () => {
    setup({ accounts: [acct()], room: [] });
    const input = (await screen.findByLabelText('Runs at a time on an')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/windows/a1', { maxParallel: 20 }));
    expect(input.value).toBe('20');
    http.patch.mockClear();
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    expect(http.patch).not.toHaveBeenCalled();
  });

  it('saves the move-urgent switch and reports a refusal', async () => {
    setup({ accounts: [acct()], room: [] });
    http.patch.mockRejectedValueOnce({ response: { data: { detail: 'Nope' } } });
    fireEvent.click(await screen.findByTestId('move-urgent-switch-a1'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/windows/a1', { moveUrgent: true }));
    await screen.findByText('Could not change the switch');
  });

  it('sets the limit of every account from the one header control, and keeps a row of its own', async () => {
    setup({ accounts: [acct(), acct({ key: 'a2', name: 'work', maxParallel: 3 })], room: [] });
    expect((await screen.findByTestId('win-count')).textContent).toBe('2 Claude accounts');
    const all = screen.getByTestId('win-limit-all') as HTMLInputElement;
    expect(all.value).toBe('2');
    fireEvent.change(all, { target: { value: '4' } });
    fireEvent.blur(all);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/windows/a1', { maxParallel: 4 }));
    expect(http.patch).toHaveBeenCalledWith('/ai/windows/a2', { maxParallel: 4 });
    expect(screen.getByLabelText('Runs at a time on work')).toBeTruthy();
  });
});
