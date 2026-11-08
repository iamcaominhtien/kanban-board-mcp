// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../types';
import type { AiRun, AiTeam } from '../../types/ai';
import { ToastProvider } from '../Toast';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { TicketAiPanel } from './RunPanel';
import { AiBoardContext } from './aiUi';

const team = { id: 't1', name: 'Research team', kind: 'ai', color: '#2E6F40' } as unknown as AiTeam;
const ticket = { id: 'RES-1', projectId: 'p1', assignee: 't1', status: 'in-progress' } as unknown as Ticket;
const run = (over: Partial<AiRun> = {}) =>
  ({
    id: 'run_1',
    memberId: 't1',
    number: 2,
    state: 'running',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    queuedAt: new Date().toISOString(),
    stepsCount: 19,
    waitingReason: null,
    ...over,
  }) as unknown as AiRun;

function mount(r: AiRun, onOpenRun = vi.fn()) {
  http.get.mockImplementation(async (url: string) => ({ data: url.includes('/runs') ? [r] : {} }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AiBoardContext.Provider
          value={{ projectId: 'p1', members: new Map([[team.id, team]]), runsByTicket: new Map(), settings: null }}
        >
          <TicketAiPanel ticket={ticket} onOpenRun={onOpenRun} />
        </AiBoardContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onOpenRun;
}

describe('the run going on a ticket, at the top of its AI activity', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says which run, who runs it and which step, and opens the run', async () => {
    const open = mount(run());
    const card = await screen.findByTestId('active-run-card');
    expect(card.textContent).toContain('Run #2 in progress · Research team');
    expect(card.textContent).toContain('step 19');
    fireEvent.click(screen.getByText('Open run'));
    expect(open).toHaveBeenCalled();
  });

  it('says why a queued run waits, and shows nothing for a finished one', async () => {
    mount(run({ state: 'queued', startedAt: null, waitingReason: 'Behind KAN-3 on this machine' }));
    expect((await screen.findByTestId('why-waiting')).textContent).toBe('Behind KAN-3 on this machine');
    cleanup();
    mount(run({ state: 'finished' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('active-run-card')).toBeNull();
  });
});
