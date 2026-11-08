// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRun, AiTeam } from '../../types/ai';
import { ToastProvider } from '../Toast';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { RunWorkingRow } from './AiThread';
import { AiBoardContext } from './aiUi';

const team = { id: 't1', name: 'Research team', kind: 'ai', color: '#2E6F40' } as unknown as AiTeam;
const run = (over: Partial<AiRun> = {}) =>
  ({
    id: 'run_1',
    memberId: 't1',
    state: 'running',
    startedAt: new Date(Date.now() - 17_000).toISOString(),
    queuedAt: new Date().toISOString(),
    waitingReason: null,
    ...over,
  }) as unknown as AiRun;

function mount(r: AiRun) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AiBoardContext.Provider
          value={{ projectId: 'p1', members: new Map([[team.id, team]]), runsByTicket: new Map(), settings: null }}
        >
          <RunWorkingRow run={r} />
        </AiBoardContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('the team at work in the comment thread', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says who works, for how long, on which step, and can stop it', async () => {
    http.get.mockResolvedValue({
      data: {
        ...run(),
        agents: [],
        steps: [
          { seq: 1, kind: 'start', title: 'Started' },
          { seq: 2, kind: 'command', title: 'Fetched codegraph docs' },
          { seq: 3, kind: 'hook', title: 'PostToolUse Edit' },
        ],
      },
    });
    http.post.mockResolvedValue({ data: run({ state: 'cancelled' }) });
    mount(run());
    expect(screen.getByText('Research team')).toBeTruthy();
    expect(screen.getByText('WORKING')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('run-working-text').textContent).toContain('Fetched codegraph docs'));
    fireEvent.click(screen.getByTestId('run-working-stop'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/run_1/cancel'));
  });

  it('says why a queued run waits', () => {
    http.get.mockResolvedValue({ data: { ...run({ state: 'queued' }), agents: [], steps: [] } });
    mount(run({ state: 'queued', waitingReason: 'The team is at its limit of 1 run' }));
    expect(screen.getByText('QUEUED')).toBeTruthy();
    expect(screen.getByTestId('run-working-text').textContent).toContain('The team is at its limit of 1 run');
    expect(screen.getByTestId('run-working-stop').textContent).toBe('Cancel');
  });
});
