// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { ToastProvider } from '../../Toast';
import type { Ticket } from '../../../types';
import { HandoffCard, WhoHasIt } from './Handoff';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const wrap = (n: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{n}</ToastProvider>
  </QueryClientProvider>
);

const ticket = { id: 'KAN-7', projectId: 'p1' } as Ticket;

describe('A handoff note in the comments', () => {
  it('shows its four fields in order, with the step and whom it is for', () => {
    render(
      wrap(
        <HandoffCard
          note={{
            done: 'Shape is done.',
            where: 'branch `feat/x`',
            left: 'Nothing.',
            check: 'Not said.',
            step: 'Shape',
            to: 'Dev',
            complete: true,
          }}
        />,
      ),
    );
    const rows = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(rows).toEqual(['Shape is done.', 'branch feat/x', 'Nothing.', 'Not said.']);
    expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual(['Done', 'Where', 'Left', 'Check']);
    expect(screen.getByText('Shape')).toBeTruthy();
    expect(screen.getByText('→ Dev')).toBeTruthy();
    expect(screen.getByText('feat/x').tagName).toBe('CODE');
    expect(screen.queryByTestId('handoff-by-board')).toBeNull();
  });

  it('says when the board wrote it because the AI left none', () => {
    render(
      wrap(<HandoffCard note={{ done: 'x', where: 'y', left: 'Not said.', check: 'Not said.', complete: false }} />),
    );
    expect(screen.getByTestId('handoff-by-board').textContent).toContain('the AI left no note');
  });
});

describe('Who has the ticket', () => {
  it('says which AI is working on it and at which step', async () => {
    http.get.mockResolvedValue({
      data: { kind: 'ai', name: 'Dev AI', state: 'running', text: 'Dev AI is working on it · Build' },
    });
    render(wrap(<WhoHasIt ticket={ticket} />));
    expect((await screen.findByTestId('who-has-it-chip')).textContent).toBe('Dev AI is working on it · Build');
    expect(http.get).toHaveBeenCalledWith('/tickets/KAN-7/ai/holder');
    expect(screen.queryByTestId('give-back')).toBeNull();
    expect(screen.getByTestId('take-over')).toBeTruthy(); // take it back from the same place
  });

  it('offers to give a ticket taken back to the AI team, with a note, Done needed', async () => {
    http.get.mockResolvedValue({
      data: {
        kind: 'person',
        name: 'An Nguyen',
        state: 'taken_back',
        text: 'An Nguyen took it back from the AI team · Build',
      },
    });
    http.post.mockResolvedValue({ data: { route: 'resumed', step: 'Build', holder: {} } });
    render(wrap(<WhoHasIt ticket={ticket} />));
    fireEvent.click(await screen.findByTestId('give-back'));
    const confirm = screen.getByTestId('give-back-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('give-back-done'), { target: { value: 'Swapped the library.' } });
    fireEvent.change(screen.getByTestId('give-back-left'), { target: { value: 'The tests.' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-7/ai/hand-over', {
        done: 'Swapped the library.',
        left: 'The tests.',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('give-back-pop')).toBeNull());
  });

  it('keeps a blocked step to a one-line chip and says why under it', async () => {
    http.get.mockResolvedValue({
      data: {
        kind: 'waiting',
        state: 'blocked',
        text: 'Blocked at Investigate: KAN-7 is already held by another AI run. Only one agent works on a ticket at a time.',
      },
    });
    render(wrap(<WhoHasIt ticket={ticket} />));
    expect((await screen.findByTestId('who-has-it-chip')).textContent).toBe('Blocked at Investigate');
    expect(screen.getByTestId('who-has-it-why').textContent).toBe(
      'KAN-7 is already held by another AI run. Only one agent works on a ticket at a time.',
    );
  });

  it('shows nothing when nobody has it', async () => {
    http.get.mockResolvedValue({ data: { kind: 'nobody', text: 'Nobody has it.' } });
    const { container } = render(wrap(<WhoHasIt ticket={ticket} />));
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="who-has-it"]')).toBeNull();
  });
});
