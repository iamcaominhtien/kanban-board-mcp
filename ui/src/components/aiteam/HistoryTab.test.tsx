// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRow } from '../../types/aiHistory';
import type { TeamCard } from '../../types/aiTeam';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { HistoryTab } from './HistoryTab';

const row = (o: Partial<HistoryRow> = {}): HistoryRow => ({
  id: 'r1',
  number: 1,
  projectId: 'p1',
  ticketId: 'KAN-212',
  ticketTitle: 'Cost badge',
  memberId: 'm1',
  memberName: 'Dev An',
  mode: 'work',
  trigger: 'manual',
  state: 'finished',
  model: 'sonnet',
  queuedAt: null,
  startedAt: '2020-03-11T11:22:04Z',
  endedAt: '2020-03-11T11:36:40Z',
  durationS: 876,
  costUsd: 0.38,
  tokens: 41000,
  summary: null,
  endedReason: null,
  files: 3,
  skills: [],
  transcript: null,
  diagnosis: null,
  ...o,
});

const members = [
  { id: 'm1', name: 'Dev An' },
  { id: 'm2', name: 'Dev Binh' },
] as TeamCard[];

type Page = { runs: HistoryRow[]; total: number };
let page: Page | Error;
const historyCalls = () => http.get.mock.calls.filter((c) => c[0] === '/ai/history');

function setup(runId: string | null = null, props: { onRunChange?: (id: string | null) => void } = {}) {
  http.get.mockImplementation(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
    if (url === '/ai/history') {
      if (page instanceof Error) throw page;
      if (cfg?.params?.limit === 1) return { data: { runs: [], total: cfg.params.state ? 4 : 120 } };
      return { data: page };
    }
    if (url === '/ai/skills/usage')
      return {
        data: [
          { name: 'tdd', kind: 'skill', plugin: null, uses: 5, runs: 3, members: [], last: null },
          { name: 'Explore', kind: 'subagent', plugin: null, uses: 2, runs: 2, members: [], last: null },
        ],
      };
    if (url === '/ai/transcripts/usage') return { data: { bytes: 2 * 1024 ** 3, runs: 10, pinned: 1 } };
    if (url.includes('notification')) return { data: { retentionDays: 45 } };
    if (url.endsWith('/transcript')) return { data: { run: row(), transcript: null, entries: [], available: false } };
    return { data: {} };
  });
  const onRunChange = props.onRunChange ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HistoryTab projectId="p1" members={members} runId={runId} onRunChange={onRunChange} onOpenTicket={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onRunChange, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  page = { runs: [row()], total: 1 };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Opens one of the filter dropdowns and picks an option by its words. */
function pick(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(option) }));
}

describe('HistoryTab', () => {
  it('shows loading, then a run row that opens its detail', async () => {
    page = {
      runs: [
        row({
          snippet: 'ran <mark>npm test</mark> and 2 failed',
          skills: ['tdd'],
          transcript: { bytes: 1, events: 14, pinned: true, pinnedBy: null, endedAt: null, removedAt: null },
        }),
        row({
          id: 'r2',
          state: 'failed',
          memberName: null,
          memberId: 'm9',
          endedReason: 'crash',
          startedAt: null,
          durationS: null,
        }),
        row({ id: 'r3', state: 'failed', diagnosis: { boardFault: true } as HistoryRow['diagnosis'] }),
      ],
      total: 1,
    };
    const { onRunChange } = setup();
    expect(screen.getByText('Loading the run history…')).toBeTruthy();
    const rows = await screen.findAllByTestId('hs-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('KAN-212');
    expect(rows[0].textContent).toContain('14 steps');
    expect(rows[0].textContent).toContain('tdd');
    expect(rows[0].textContent).toContain('15 min');
    expect(screen.getByTestId('hs-snippet').querySelector('mark')?.textContent).toBe('npm test');
    expect(rows[1].textContent).toContain('m9');
    expect(rows[1].textContent).toContain('crash');
    expect(rows[2].textContent).toContain('Board fault');
    expect(screen.getByTestId('hs-count').textContent).toBe('1 run');
    fireEvent.click(rows[1]);
    expect(onRunChange).toHaveBeenCalledWith('r2');
    // counts of the view chips and the usage line
    await waitFor(() => expect(screen.getAllByText('120').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('hs-usage').textContent).toContain('2.0 GB of 45 days'));
    expect(screen.getByTestId('hs-usage').textContent).toContain('1 pinned run is never deleted');
    expect(http.get).toHaveBeenCalledWith('/ai/history', {
      params: expect.objectContaining({ project_id: 'p1', limit: 25, offset: 0 }),
    });
  });

  it('says nothing has run yet, or that the list failed to load', async () => {
    page = { runs: [], total: 0 };
    const first = setup();
    await screen.findByText(/Nothing has run yet/);
    first.unmount();
    page = new Error('down');
    setup();
    await screen.findByRole('alert');
    expect(screen.getByText(/Couldn.t load the run history/)).toBeTruthy();
  });

  it('filters by view, member, ticket, skill and time through the API', async () => {
    setup();
    await screen.findByTestId('hs-row');
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }));
    await waitFor(() =>
      expect(historyCalls().some((c) => c[1].params.state === 'failed,timed_out' && c[1].params.limit === 25)).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Pinned/ }));
    await waitFor(() => expect(historyCalls().some((c) => c[1].params.pinned === true)).toBe(true));
    pick('Member', 'Dev Binh');
    await waitFor(() => expect(historyCalls().some((c) => c[1].params.member_id === 'm2')).toBe(true));
    fireEvent.change(screen.getByLabelText('Ticket'), { target: { value: ' KAN-5 ' } });
    await waitFor(() => expect(historyCalls().some((c) => c[1].params.ticket_id === 'KAN-5')).toBe(true));
    fireEvent.click(screen.getByLabelText('Skill'));
    await screen.findByText('tdd · 5');
    expect(screen.getByText('Explore (subagent) · 2')).toBeTruthy();
    fireEvent.click(screen.getByText('tdd · 5'));
    await waitFor(() => expect(historyCalls().some((c) => c[1].params.skill === 'tdd')).toBe(true));
    pick('Time', 'All time');
    await waitFor(() =>
      expect(historyCalls().some((c) => c[1].params.since === undefined && c[1].params.skill === 'tdd')).toBe(true),
    );
  });

  it('says no run matches the filters', async () => {
    page = { runs: [], total: 0 };
    setup();
    await screen.findByText(/Nothing has run yet/);
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }));
    await screen.findByText('No run matches these filters.');
  });

  it('searches after a pause in typing and counts matches against all runs', async () => {
    setup();
    await screen.findByTestId('hs-row');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByLabelText('Search runs'), { target: { value: ' npm test ' } });
    expect(historyCalls().some((c) => c[1].params.q)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();
    await waitFor(() => expect(historyCalls().some((c) => c[1].params.q === 'npm test')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('hs-count').textContent).toBe('120 runs · 1 match'));
  });

  it('says no run matches the search text', async () => {
    page = { runs: [], total: 0 };
    setup();
    await screen.findByText(/Nothing has run yet/);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByLabelText('Search runs'), { target: { value: 'zzz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    vi.useRealTimers();
    await screen.findByText('No run matches “zzz”.');
  });

  it('pages through a long list', async () => {
    page = { runs: [row()], total: 60 };
    setup();
    await screen.findByText('Page 1 of 3');
    // the search's debounce timer resets the page once, shortly after mount
    await new Promise((r) => setTimeout(r, 350));
    expect((screen.getByRole('button', { name: 'Newer' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await screen.findByText('Page 2 of 3');
    await waitFor(() => expect(historyCalls().some((c) => c[1].params.offset === 25)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await screen.findByText('Page 3 of 3');
    expect((screen.getByRole('button', { name: 'Older' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    await screen.findByText('Page 2 of 3');
  });

  it('shows and hides what is kept and for how long', async () => {
    setup();
    await screen.findByTestId('hs-row');
    fireEvent.click(screen.getByRole('button', { name: 'Retention' }));
    expect(screen.getByTestId('hs-retention').textContent).toContain('The full transcript');
    await waitFor(() => expect(screen.getByTestId('hs-retention').textContent).toContain('45 days'));
    fireEvent.click(screen.getByRole('button', { name: 'Retention' }));
    expect(screen.queryByTestId('hs-retention')).toBeNull();
  });

  it('shows the run detail instead of the list when a run is open, and goes back', async () => {
    const { onRunChange } = setup('r1');
    await screen.findByTestId('hs-no-transcript');
    expect(screen.getByTestId('run-detail')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    expect(onRunChange).toHaveBeenCalledWith(null);
  });
});
