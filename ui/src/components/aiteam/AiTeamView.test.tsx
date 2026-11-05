// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../Toast';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));
vi.mock('./ResourcesTab', () => ({ ResourcesTab: () => <div>resources</div> }));

import { AiTeamView } from './AiTeamView';
import { AiBoardContext } from '../ai/aiUi';

const team = {
  id: 't1',
  name: 'Team An',
  color: '#2E6F40',
  packName: 'Standard feature',
  packKey: 'standard',
  roles: [{ key: 'dev', name: 'Developer' }],
  status: { code: 'running', label: 'Running', detail: null },
  paused: false,
  slotsInUse: 1,
  maxParallel: 2,
  queued: 0,
  usage: { runsToday: 2 },
  running: [{ runId: 'r1', ticketId: 'KAN-1', ticketTitle: 'Fix login', state: 'running', number: 1 }],
};
const run = (id: string, state: string, extra: object = {}) => ({
  id,
  ticketId: 'KAN-1',
  memberId: 't1',
  number: 1,
  state,
  stepsCount: 3,
  startedAt: '2026-11-05T10:00:00Z',
  endedAt: null,
  queuedAt: '2026-11-05T09:59:00Z',
  report: {},
  costUsd: 0,
  ...extra,
});

function mount() {
  http.get.mockImplementation((url: string, opts?: { params?: { state?: string } }) => {
    if (url === '/projects/p1/ai/teams') return Promise.resolve({ data: [team] });
    if (url === '/projects/p1/ai/overview')
      return Promise.resolve({ data: { runs: { running: 1, needsInput: 1, finished: 4 }, active: [], teams: [] } });
    if (url === '/projects/p1/ai/runs')
      return Promise.resolve({
        data: opts?.params?.state
          ? [
              run('r1', 'running'),
              run('r2', 'needs_input', { question: { text: 'Which database?', options: [] }, answer: null }),
            ]
          : [run('r9', 'finished', { summary: 'All done', endedAt: '2026-11-05T10:20:00Z' })],
      });
    if (url === '/projects/p1/ai/live')
      return Promise.resolve({
        data: {
          runs: [],
          steps: [
            {
              runId: 'r1',
              seq: 5,
              at: '2026-11-05T10:01:00Z',
              kind: 'tool',
              title: 'Ran the tests',
              detail: {},
              ticketId: 'KAN-1',
              memberId: 't1',
            },
          ],
        },
      });
    if (url === '/projects/p1/ai/knowledge') return Promise.resolve({ data: null });
    return Promise.resolve({ data: [] });
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <AiBoardContext.Provider
          value={{ projectId: 'p1', members: new Map(), runsByTicket: new Map(), settings: null }}
        >
          <AiTeamView projectId="p1" projectName="Kanban" onOpenTicket={vi.fn()} onOpenMember={vi.fn()} />
        </AiBoardContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AI Team › Now', () => {
  it('shows the counts, the teams, what waits for you, the active runs and the live steps', async () => {
    mount();
    expect((await screen.findByTestId('at-counts')).textContent).toContain('1 waiting for you');
    expect(screen.getByTestId('team-card-Team An').textContent).toContain('Standard feature');
    expect((await screen.findByTestId('at-needs-you')).textContent).toContain('Which database?');
    expect((await screen.findAllByTestId('active-run')).length).toBe(2);
    expect((await screen.findByTestId('live-steps')).textContent).toContain('Ran the tests');
  });
});

describe('AI Team › Run history', () => {
  it('lists the runs and filters them by state', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Run history' }));
    const row = await screen.findByTestId('history-row');
    expect(row.textContent).toContain('All done');
    fireEvent.click(screen.getByRole('radio', { name: 'Failed' }));
    await waitFor(() =>
      expect(http.get).toHaveBeenCalledWith('/projects/p1/ai/runs', {
        params: { limit: 60, state: 'failed,timed_out' },
      }),
    );
  });
});
