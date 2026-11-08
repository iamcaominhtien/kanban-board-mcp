// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRunFull } from '../../types/ai';
import { ToastProvider } from '../Toast';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { TicketRunsTab } from './RunView';
import { AiBoardContext } from './aiUi';

const run = (over: Partial<AiRunFull> = {}): AiRunFull =>
  ({
    id: 'r2',
    projectId: 'p1',
    ticketId: 'KAN-1',
    memberId: 't1',
    number: 2,
    mode: 'work',
    trigger: 'assign',
    startedBy: 'An',
    state: 'running',
    instruction: 'Fix the login bug',
    report: {},
    summary: null,
    question: null,
    answer: null,
    files: [],
    tokensIn: 1000,
    tokensOut: 500,
    costUsd: 0.12,
    model: 'sonnet',
    effort: null,
    stepsCount: 1,
    live: true,
    waitingReason: null,
    endedReason: null,
    startedAt: '2026-11-05T10:00:00Z',
    endedAt: null,
    queuedAt: '2026-11-05T09:59:00Z',
    agents: [],
    steps: [],
    ...over,
  }) as unknown as AiRunFull;

function setup(current: AiRunFull, older: AiRunFull[] = []) {
  http.get.mockImplementation((url: string) => {
    if (url === '/tickets/KAN-1/ai/runs') return Promise.resolve({ data: [current, ...older] });
    if (url === `/ai/runs/${current.id}`) return Promise.resolve({ data: current });
    if (url.endsWith('/messages')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
  http.post.mockResolvedValue({ data: {} });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <AiBoardContext.Provider
          value={{
            projectId: 'p1',
            members: new Map([['t1', { id: 't1', name: 'Team An', color: '#2E6F40', kind: 'ai' }]]) as never,
            runsByTicket: new Map(),
            settings: null,
          }}
        >
          <TicketRunsTab ticket={{ id: 'KAN-1' } as never} />
        </AiBoardContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the run on a ticket', () => {
  it('shows the newest run with its instruction, state and facts', async () => {
    setup(run());
    expect(await screen.findByTestId('run-view')).toBeTruthy();
    expect(screen.getByText('Run #2')).toBeTruthy();
    expect(screen.getByTestId('run-instruction').textContent).toContain('Instruction: Fix the login bug');
    const facts = screen.getByTestId('run-facts').textContent ?? '';
    expect(facts).toContain('Team An');
    expect(facts).toContain('by An');
    expect(facts).toContain('1.5k tokens');
    expect(screen.getByTestId('usage-card').textContent).toContain('Tokens in');
  });

  it('sends a note to the running lead', async () => {
    setup(run());
    fireEvent.change(await screen.findByTestId('run-message-input'), { target: { value: 'use the new API' } });
    fireEvent.click(screen.getByTestId('run-message-send'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r2/message', { text: 'use the new API' }));
  });

  it('has no message box once the run ended, and offers Run again', async () => {
    setup(run({ state: 'finished', endedAt: '2026-11-05T10:30:00Z', live: false }));
    await screen.findByTestId('run-view');
    expect(screen.queryByTestId('run-message-box')).toBeNull();
    fireEvent.click(screen.getByTestId('run-retry'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r2/retry'));
  });

  it('cancels a run that is going', async () => {
    setup(run());
    fireEvent.click(await screen.findByTestId('run-cancel'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r2/cancel'));
  });

  it('answers the lead question', async () => {
    setup(
      run({
        state: 'needs_input',
        live: false,
        question: { text: 'Which database?', options: ['Postgres', 'SQLite'], to: 'An' },
      }),
    );
    expect(await screen.findByText('Which database?')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('question-option')[1]);
    fireEvent.click(screen.getByTestId('ai-answer-send'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r2/answer', { text: 'SQLite' }));
  });

  it('shows the report: summary, branch, pull request and what is still open', async () => {
    setup(
      run({
        state: 'finished',
        endedAt: 'x',
        report: {
          summary: 'Fixed it.',
          branch: 'kan-1-login',
          prUrl: 'https://example.test/pr/1',
          openItems: ['Add a test for the edge case'],
        },
      }),
    );
    const report = await screen.findByTestId('run-report');
    expect(report.textContent).toContain('Fixed it.');
    expect(screen.getByTestId('report-branch').textContent).toContain('kan-1-login');
    expect((screen.getByTestId('report-pr') as HTMLAnchorElement).href).toBe('https://example.test/pr/1');
    expect(screen.getByTestId('report-open-items').textContent).toContain('Add a test');
  });

  it('lays the run out as on main: steps beside files, commands, tests and usage, then the history table', async () => {
    setup(
      run({
        state: 'finished',
        endedAt: '2026-11-05T10:30:00Z',
        live: false,
        files: [{ path: 'src/login.ts', added: 12, removed: 3 }],
        report: { tests: { passed: 14, failed: 1, failing: ['login.test'] } },
        steps: [
          { seq: 1, kind: 'command', title: 'Ran npm test', detail: { exitCode: 1 }, agentId: null },
          { seq: 2, kind: 'command', title: 'Ran npm run lint', detail: { exitCode: 0 }, agentId: null },
        ] as never,
      }),
      [run({ id: 'r1', number: 1, state: 'cancelled', files: [] })],
    );
    await screen.findByTestId('run-view');
    expect(screen.getByText('Files touched')).toBeTruthy();
    expect(screen.getByText('src/login.ts')).toBeTruthy();
    expect(screen.getByTestId('run-commands').textContent).toContain('npm run lint');
    expect(screen.getByTestId('run-commands').textContent).toContain('exit 1');
    expect(screen.getByTestId('run-tests').textContent).toContain('login.test');
    expect(screen.getByText('Run history for KAN-1')).toBeTruthy();
    expect(screen.getAllByTestId('run-history-item')).toHaveLength(2);
  });
});
