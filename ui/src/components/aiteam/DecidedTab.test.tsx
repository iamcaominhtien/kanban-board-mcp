// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision, DecisionList } from '../../types/story';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { DecidedTab } from './DecidedTab';

const now = () => new Date().toISOString();
/** Yesterday at a clock time, whatever the time is now. */
const yesterday = (h: number) => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

const decision = (o: Partial<Decision> = {}): Decision => ({
  id: 'd1',
  at: now(),
  kind: 'approve_design',
  title: 'Approved the design of KAN-305',
  why: 'It meets all three criteria.',
  ticketId: 'KAN-305',
  storyId: 'KAN-301',
  storyTitle: 'Weather app',
  member: { id: 'pm1', name: 'PM Linh' },
  state: 'in_effect',
  canOverride: true,
  whyNot: null,
  result: 'In effect: the next step has not started yet.',
  overriddenBy: null,
  overriddenAt: null,
  overrideNote: null,
  ...o,
});

const items = [
  decision(),
  decision({
    id: 'd2',
    kind: 'split',
    title: 'Split KAN-288 into 4 tickets',
    ticketId: 'KAN-288',
    storyId: 'KAN-287',
    storyTitle: 'Notification digest',
    canOverride: false,
    whyNot: 'KAN-289 has started. Change the plan in the Story page instead.',
    result: 'KAN-289 has started. Change the plan in the Story page instead.',
  }),
  decision({
    id: 'd3',
    at: yesterday(12),
    kind: 'retry',
    title: 'Tried the tests of KAN-321 again',
    ticketId: 'KAN-321',
    state: 'overridden',
    canOverride: false,
    overriddenBy: 'user',
    overriddenAt: yesterday(13),
  }),
];

function list(rows: Decision[]): DecisionList {
  return {
    items: rows,
    totals: {
      decided: rows.length,
      inEffect: rows.filter((d) => d.state === 'in_effect').length,
      overridable: rows.filter((d) => d.canOverride).length,
      overridden: rows.filter((d) => d.state === 'overridden').length,
      final: rows.filter((d) => d.state === 'in_effect' && !d.canOverride).length,
    },
    kinds: [...new Set(rows.map((d) => d.kind))].map((kind) => ({
      kind,
      count: rows.filter((d) => d.kind === kind).length,
    })),
  };
}

let rows: Decision[];
function setup(range: 'today' | '7d' = '7d') {
  http.get.mockImplementation(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
    if (url === '/projects/p1/ai/decisions') {
      const p = cfg?.params ?? {};
      const all = list(rows.filter((d) => !p.story || d.storyId === p.story));
      return {
        data: {
          ...all,
          items: all.items.filter(
            (d) =>
              (!p.kind || d.kind === p.kind) && (p.overridden == null || (d.state === 'overridden') === p.overridden),
          ),
        },
      };
    }
    return { data: {} };
  });
  const actions = { onOpenTicket: vi.fn(), onOpenStory: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DecidedTab projectId="p1" range={range} actions={actions} />
    </QueryClientProvider>,
  );
  return actions;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = items;
});
afterEach(cleanup);

describe('DecidedTab', () => {
  it('shows the tiles, the rows grouped by day and why a decision can no longer be undone', async () => {
    setup();
    const tiles = await screen.findByTestId('decided-tiles');
    expect(tiles.textContent).toContain('Decided in 7 days3');
    expect(tiles.textContent).toContain('by PM Linh, 2 Stories');
    expect(tiles.textContent).toContain('you can override 1 of them');
    expect(tiles.textContent).toContain('33% of 3');
    const table = await screen.findByTestId('decided-table');
    expect(table.textContent).toContain('Today');
    expect(table.textContent).toContain('Yesterday');
    const rowEls = screen.getAllByTestId('decided-row');
    expect(rowEls).toHaveLength(3);
    expect(rowEls[0].textContent).toContain('In effect');
    expect(rowEls[0].textContent).toContain('The next step has not started yet.');
    expect(within(rowEls[1]).getByTestId('decided-why-not').textContent).toContain('KAN-289 has started');
    expect((within(rowEls[1]).getByTestId('decided-override') as HTMLButtonElement).disabled).toBe(true);
    expect(rowEls[2].textContent).toContain('Overridden by you at');
    expect(within(rowEls[2]).queryByTestId('decided-override')).toBeNull();
    // the range of the header travels as since=
    const since = http.get.mock.calls.find((c) => c[0] === '/projects/p1/ai/decisions')?.[1]?.params?.since;
    expect(Date.now() - new Date(since).getTime()).toBeGreaterThan(6.9 * 86400_000);
    expect(screen.getByText('Showing 3 of 3')).toBeTruthy();
  });

  it('filters by kind and by Overridden, and says when nothing matches', async () => {
    setup();
    await screen.findByTestId('decided-table');
    fireEvent.click(screen.getByRole('button', { name: /Split a ticket/ }));
    await waitFor(() => expect(screen.getAllByTestId('decided-row')).toHaveLength(1));
    expect(http.get).toHaveBeenCalledWith(
      '/projects/p1/ai/decisions',
      expect.objectContaining({ params: expect.objectContaining({ kind: 'split' }) }),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Overridden only' }));
    const none = await screen.findByTestId('decided-no-match');
    expect(none.textContent).toContain('Overridden, Split a ticket: 0 in the last 7 days.');
    fireEvent.click(within(none).getByText('Clear the filters'));
    await waitFor(() => expect(screen.getAllByTestId('decided-row')).toHaveLength(3));
  });

  it('overrides with a note, and shows the server message when it can no longer be', async () => {
    setup();
    await screen.findByTestId('decided-table');
    fireEvent.click(screen.getAllByTestId('decided-override')[0]);
    const dialog = screen.getByTestId('override-dialog');
    expect(dialog.textContent).toContain('The design step of KAN-305 returns to Waiting for you');
    fireEvent.change(screen.getByTestId('override-note'), { target: { value: 'Wrong icon set' } });
    http.post.mockRejectedValueOnce({ response: { status: 409, data: { detail: 'Build has started.' } } });
    fireEvent.click(screen.getByTestId('override-confirm'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/ai/decisions/d1/override', { note: 'Wrong icon set' }),
    );
    expect((await screen.findByTestId('override-error')).textContent).toBe('Build has started.');
    http.post.mockResolvedValueOnce({ data: decision({ state: 'overridden' }) });
    fireEvent.click(screen.getByTestId('override-confirm'));
    await waitFor(() => expect(screen.queryByTestId('override-dialog')).toBeNull());
  });

  it('says plainly when the PM decided nothing in the range', async () => {
    rows = [];
    setup('today');
    expect((await screen.findByTestId('decided-none')).textContent).toContain('The PM has decided nothing yet');
    expect(screen.getByTestId('decided-tiles').textContent).toContain('Decided today0');
  });
});
