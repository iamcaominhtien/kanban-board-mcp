// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow as Row } from '../../types/notifications';

vi.mock('../../api/ai', () => ({
  useAiOverview: () => ({ data: { members: [] }, isLoading: false }),
}));

import { NotificationRow } from './NotificationRow';

afterEach(cleanup);

const stuck = (over: Partial<Row> = {}): Row =>
  ({
    id: 'nt_1',
    kind: 'run_stuck',
    kindLabel: 'An AI stopped moving',
    needs: true,
    projectId: 'p1',
    title: 'Dev An stopped moving',
    body: 'On KAN-218',
    targetKind: 'run',
    targetId: 'run_1',
    ticketId: 'KAN-218',
    memberId: 'm1',
    count: 1,
    items: [],
    data: {
      diagnosis: {
        boardFault: true,
        what: 'The MCP process did not answer.',
        means: 'Nothing is wrong with the request.',
        tried: ['Retried at 30 s.', 'Resumed the run once.'],
      },
    },
    read: true,
    done: false,
    gone: false,
    snoozed: false,
    createdAt: '2026-11-02T10:00:00Z',
    updatedAt: '2026-11-02T10:00:00Z',
    actions: [
      { id: 'trouble:stop_child', label: 'Stop that command, keep the run' },
      { id: 'trouble:continue_note', label: 'Continue with a note' },
      { id: 'open_run_log', label: 'Open the run' },
    ],
    ...over,
  }) as unknown as Row;

function show(row: Row, onAction = vi.fn().mockResolvedValue(true)) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationRow row={row} onAction={onAction} />
    </QueryClientProvider>,
  );
  return onAction;
}

describe('a Needs you row with a diagnosis', () => {
  it('shows what the board found, what it tried and the board fault label', () => {
    show(stuck());
    expect(screen.getByText(/did not answer/)).toBeTruthy();
    expect(screen.getByText('Retried at 30 s.')).toBeTruthy();
    expect(screen.getByText('Board fault · came straight to you, no AI was asked first')).toBeTruthy();
    expect(screen.getByText('Already tried')).toBeTruthy();
  });

  it('runs a plain action straight away', () => {
    const on = show(stuck());
    fireEvent.click(screen.getByRole('button', { name: 'Stop that command, keep the run' }));
    expect(on).toHaveBeenCalledWith(expect.objectContaining({ id: 'nt_1' }), 'trouble:stop_child', undefined);
  });
});
