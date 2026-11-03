// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { WorkflowMetrics } from './WorkflowMetrics';

function setup(metrics: () => Promise<unknown>) {
  http.get.mockImplementation((url: string) =>
    url.endsWith('/ai/workflow-metrics')
      ? metrics()
      : Promise.resolve({
          data: [
            { key: 'standard', name: 'Standard' },
            { key: 'careful', name: 'Careful' },
          ],
        }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkflowMetrics projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('WorkflowMetrics', () => {
  it('loads, then explains an empty period', async () => {
    setup(() => Promise.resolve({ data: [] }));
    expect(screen.getByText('Loading the workflow measures…')).toBeTruthy();
    await screen.findByText(/No ticket has run on a workflow in the last 30 days/);
    expect(http.get).toHaveBeenCalledWith('/projects/p1/ai/workflow-metrics', { params: { days: 30 } });
  });

  it('says so when the measures cannot be read', async () => {
    setup(() => Promise.reject(new Error('boom')));
    expect(await screen.findByText('The workflow measures could not be read.')).toBeTruthy();
  });

  it('shows a tile and a table row per template, with verdicts and cost against Standard', async () => {
    setup(() =>
      Promise.resolve({
        data: [
          {
            templateKey: 'standard',
            tickets: 20,
            medianHours: 6.67,
            passedFirst: 0.85,
            roundsAvg: 0.4,
            costPerTicket: 2,
          },
          { templateKey: 'careful', tickets: 12, medianHours: 0.5, passedFirst: 0.5, roundsAvg: 2, costPerTicket: 5 },
          {
            templateKey: 'quick',
            tickets: 1,
            medianHours: null,
            passedFirst: null,
            roundsAvg: null,
            costPerTicket: null,
          },
          { templateKey: 'mid', tickets: 10, medianHours: 1, passedFirst: 0.7, roundsAvg: 1, costPerTicket: 1 },
        ],
      }),
    );
    await screen.findByText('Each workflow, over 30 days');
    const standard = screen.getByTestId('workflow-metric-standard');
    expect(standard.textContent).toContain('20 tickets');
    expect(standard.textContent).toContain('good');
    expect(standard.textContent).toContain('median 6 h 40');
    expect(standard.textContent).toContain('85% first time');
    const careful = screen.getByTestId('workflow-metric-careful');
    expect(careful.textContent).toContain('fix');
    expect(careful.textContent).toContain('2.5×');
    expect(careful.textContent).toContain('median 30 min');
    const quick = screen.getByTestId('workflow-metric-quick');
    expect(quick.textContent).toContain('1 ticket');
    expect(quick.textContent).toContain('no review');
    expect(quick.textContent).toContain('too few tickets to judge');
    expect(screen.getByTestId('workflow-metric-mid').textContent).toContain('watch');
    expect(screen.getByText('Rounds of rework')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('n/a')).toBeTruthy();
  });
});
