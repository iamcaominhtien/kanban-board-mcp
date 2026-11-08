// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRunFull, RunStep } from '../../../types/ai';
import { aiKeys, useAiRun } from '../../../api/ai';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { RunTree } from './RunTree';

const step = (seq: number, extra: Partial<RunStep> = {}): RunStep => ({
  seq,
  at: '2026-11-05T10:00:00Z',
  agentId: null,
  kind: 'tool',
  tool: null,
  title: `step ${seq}`,
  detail: {},
  hasOutput: false,
  parentToolId: null,
  toolId: null,
  ...extra,
});

const base = (extra: Partial<AiRunFull> = {}): AiRunFull =>
  ({
    id: 'r1',
    state: 'finished',
    stepsCount: 6,
    steps: [
      step(3, {
        kind: 'command',
        title: 'Ran npm test',
        hasOutput: true,
        detail: { command: 'npm test', exitCode: 1 },
      }),
      step(4, { kind: 'subagent', title: 'Reviewer', toolId: 'toolu_a' }),
      step(5, { agentId: 'toolu_a', title: 'Read a.ts' }),
      step(6),
    ],
    agents: [
      {
        id: 'toolu_a',
        runId: 'r1',
        agentType: 'reviewer',
        claudeId: null,
        startedAt: 'a',
        endedAt: 'b',
        stepsCount: 3,
        lastText: null,
      },
    ],
    ...extra,
  }) as unknown as AiRunFull;

/** The tree as the app draws it: the run comes from the cache, so a page that is fetched shows up. */
function Live() {
  const run = useAiRun('r1').data;
  return run ? <RunTree run={run} /> : null;
}

function mount(run: AiRunFull) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(aiKeys.run('r1'), run);
  const view = render(
    <QueryClientProvider client={qc}>
      <Live />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RunTree', () => {
  it('shows the lead steps, and a role steps only when its row is opened', () => {
    mount(base());
    const rows = screen.getAllByTestId('run-step');
    expect(rows.map((r) => r.getAttribute('data-seq'))).toEqual(['3', '4', '6']);
    expect(screen.queryByText('Read a.ts')).toBeNull();
    expect(screen.getByTestId('agent-meta').textContent).toContain('reviewer · 3 steps');
    fireEvent.click(within(rows[1]).getAllByTestId('step-toggle')[0]);
    expect(screen.getByText('Read a.ts')).toBeTruthy();
  });

  it('fetches the steps of a role that are not loaded yet, a page after the last held', async () => {
    http.get.mockResolvedValue({
      data: [step(7, { agentId: 'toolu_a', title: 'Read b.ts' }), step(8, { agentId: 'toolu_a', title: 'Read c.ts' })],
    });
    const { qc } = mount(base());
    fireEvent.click(within(screen.getAllByTestId('run-step')[1]).getAllByTestId('step-toggle')[0]);
    fireEvent.click(screen.getByTestId('load-agent-steps'));
    await waitFor(() => expect(screen.getByText('Read c.ts')).toBeTruthy());
    expect(http.get).toHaveBeenCalledWith('/ai/runs/r1/steps', { params: { after: 5, agent: 'toolu_a', limit: 200 } });
    expect(qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!.steps.map((s) => s.seq)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('opens the output of a command only when asked, and tells when it cannot be loaded', async () => {
    http.get.mockResolvedValueOnce({ data: { ...step(3), output: '1 failed' } });
    mount(base());
    expect(http.get).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getAllByTestId('run-step')[0]).getByTestId('step-toggle'));
    await waitFor(() => expect(screen.getByTestId('step-output').textContent).toContain('1 failed'));
    expect(screen.getByTestId('step-output').textContent).toContain('$ npm test');
    expect(http.get).toHaveBeenCalledWith('/ai/runs/r1/steps/3/output');
  });

  it('offers the earlier steps of the lead when the window starts after the first', async () => {
    http.get.mockResolvedValue({ data: [step(1), step(2)] });
    const { qc } = mount(base());
    fireEvent.click(screen.getByTestId('load-earlier'));
    await waitFor(() => expect(screen.getAllByTestId('run-step')[0].getAttribute('data-seq')).toBe('1'));
    expect(http.get).toHaveBeenCalledWith('/ai/runs/r1/steps', { params: { agent: 'lead', limit: 200 } });
    expect(qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!.steps[0].seq).toBe(1);
  });

  it('says so when a run has no steps', () => {
    mount(base({ steps: [], agents: [], stepsCount: 0 }));
    expect(screen.getByText('No steps recorded.')).toBeTruthy();
  });
});
