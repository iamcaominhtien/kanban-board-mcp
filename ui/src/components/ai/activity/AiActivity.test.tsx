// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../../types';
import type { AiRun } from '../../../types/ai';
import { ToastProvider } from '../../Toast';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { AiActivity, AiRunPanel } from './AiActivity';
import { AiBoardContext } from '../aiUi';

const ticket = { id: 'KAN-1', projectId: 'p', assignee: 't1', status: 'in-progress' } as unknown as Ticket;
const run = (over: Partial<AiRun> = {}): AiRun =>
  ({
    id: 'r1',
    projectId: 'p',
    kind: 'team',
    ticketId: 'KAN-1',
    memberId: 't1',
    number: 1,
    mode: 'work',
    trigger: 'assign',
    state: 'running',
    startedBy: 'An',
    instruction: '',
    queuedAt: '2026-11-05T09:59:00Z',
    startedAt: '2026-11-05T10:00:00Z',
    endedAt: null,
    endedReason: null,
    report: {},
    files: [],
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    stopCode: null,
    peakRssMb: null,
    lastRssMb: null,
    restarts: [],
    retries: [],
    stepsCount: 0,
    live: true,
    waitingReason: null,
    ...over,
  }) as unknown as AiRun;

function wire({ runs = [] as AiRun[], worktree = null as unknown }) {
  http.get.mockImplementation(async (url: string) => {
    if (url === '/tickets/KAN-1/ai/runs') return { data: runs };
    if (url === '/tickets/KAN-1/ai/worktree') return { data: worktree };
    if (url === '/tickets/KAN-1') return { data: ticket };
    if (url === '/projects/p/ai/settings') return { data: { projectId: 'p', runMemoryLimitMb: 2048, ops: {} } };
    if (url === '/projects/p/ai/board') return { data: { tickets: {} } };
    if (url === '/projects/p/ai/pulls') return { data: [] };
    const one = runs.find((r) => url === `/ai/runs/${r.id}`);
    if (one) return { data: { ...one, agents: [], steps: [] } };
    if (url.includes('/messages') || url.includes('/steps')) return { data: [] };
    return { data: {} };
  });
  http.post.mockResolvedValue({ data: {} });
}

const mount = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <AiBoardContext.Provider
          value={{
            projectId: 'p',
            members: new Map([['t1', { id: 't1', name: 'Backend team', kind: 'ai', color: '#2E6F40' }]]) as never,
            runsByTicket: new Map(),
            settings: null,
          }}
        >
          {ui}
        </AiBoardContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the AI activity of a ticket', () => {
  it('shows nothing made up for a ticket the AI never touched', async () => {
    wire({});
    mount(<AiActivity ticket={ticket} ticketId="KAN-1" projectId="p" shown={false} />);
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree'));
    await new Promise((r) => setTimeout(r, 30));
    // the design's sample numbers and names must never reach a real ticket
    const text = screen.getByTestId('ai-activity').textContent ?? '';
    expect(text).toBe('');
    for (const id of ['active-run-card', 'restart-notice', 'memory-stop', 'resources', 'ticket-handover'])
      expect(screen.queryByTestId(id)).toBeNull();
  });

  it('shows the run, a system restart with its count and the hand-over of the worktree', async () => {
    wire({
      runs: [
        run({
          restarts: [{ n: 1, at: '2026-11-05T10:50:00Z', by: 'system', rssMb: 2100, limitMb: 2048 }] as never,
        }),
      ],
      worktree: {
        ticketId: 'KAN-1',
        projectId: 'p',
        branch: 'ai/KAN-1-fix',
        base: 'main',
        state: 'active',
        handover: null,
        route: 'local',
        conflictFiles: [],
        live: { uncommitted: [], outputs: [], sizeMb: 12, exists: true, ahead: 1 },
      },
    });
    const open = vi.fn();
    mount(<AiActivity ticket={ticket} ticketId="KAN-1" projectId="p" shown={false} onOpenRun={open} />);
    expect((await screen.findByTestId('active-run-card')).textContent).toContain('Run #1 in progress');
    const notice = await screen.findByTestId('restart-notice');
    expect(notice.textContent).toContain('Restart 1 of 2');
    expect((await screen.findByTestId('raise-limit')).textContent).toBe('Raise limit to 3 GB');
    const handover = await screen.findByTestId('ticket-handover');
    expect(handover.textContent).toContain('ai/KAN-1-fix');
    expect(screen.getByTestId('merge-btn')).toBeTruthy();
    fireEvent.click(screen.getByText('Open run ›'));
    expect(open).toHaveBeenCalled();
  });

  it('says a run was stopped for memory and offers Retry', async () => {
    wire({
      runs: [
        run({
          state: 'failed',
          stopCode: 'memory',
          endedAt: '2026-11-05T10:58:00Z',
          peakRssMb: 2365,
          restarts: [
            { n: 1, at: '2026-11-05T10:50:00Z', by: 'system', rssMb: 2100, limitMb: 2048 },
            { n: 2, at: '2026-11-05T10:54:00Z', by: 'system', rssMb: 2100, limitMb: 2048 },
          ] as never,
        }),
      ],
    });
    mount(<AiActivity ticket={ticket} ticketId="KAN-1" projectId="p" shown={false} />);
    const stop = await screen.findByTestId('memory-stop');
    expect(stop.textContent).toContain('It went over the 2 GB limit again after 2 restarts (peak 2.31 GB)');
    // the run has ended: no restart notice, the stop notice says it
    expect(screen.queryByTestId('restart-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('memory-stop-retry'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/retry'));
  });
});

describe('the run panel of a ticket', () => {
  it('says so when the ticket has no runs', async () => {
    wire({});
    mount(<AiRunPanel ticket={ticket} />);
    expect((await screen.findByTestId('no-runs')).textContent).toContain('No AI runs on this ticket yet');
  });

  it('opens the run a link asked for, not only the newest', async () => {
    wire({ runs: [run({ id: 'r2', number: 2 }), run({ id: 'r1', number: 1, state: 'finished', live: false })] });
    mount(<AiRunPanel ticket={ticket} runId="r1" />);
    const asked = () => http.get.mock.calls.map((c) => c[0] as string);
    await waitFor(() => expect(asked()).toContain('/ai/runs/r1'));
    expect(asked()).not.toContain('/ai/runs/r2');
  });
});
