// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveFeedItem } from '../../../api/aiLiveFeed';

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { mergeFeed } from '../../../api/aiLiveFeed';
import { LiveFeed, LiveFeedSplit } from './LiveFeed';
import { codeParts, relTime, toGroups, toLines } from './liveFeedModel';

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const item = (o: Partial<LiveFeedItem> = {}): LiveFeedItem => ({
  id: 'i1',
  at: at(0),
  memberId: 'm1',
  memberName: 'Dev An',
  glyph: 'asterisk',
  color: '#2E6F40',
  role: 'dev',
  roleLabel: 'Dev (TDD)',
  ticketId: 'KAN-1',
  ticketTitle: 'Fix add()',
  kind: 'edit',
  text: 'Edited calc.py',
  tone: 'info',
  ref: null,
  ...o,
});

let pages: { items: LiveFeedItem[]; cursor: string; working: string[] }[];
let calls: (Record<string, unknown> | undefined)[];

function setup(props: { onOpenTicket?: (id: string) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LiveFeed projectId="p1" {...props} />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(T0 + 30_000);
  pages = [];
  calls = [];
  http.get.mockImplementation(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
    if (url !== '/projects/p1/ai/live-feed') throw new Error(`unexpected ${url}`);
    calls.push(cfg?.params);
    const page = pages.shift() ?? { items: [], cursor: 'c-last', working: [] };
    return { data: page };
  });
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  http.get.mockReset();
});

describe('liveFeedModel', () => {
  it('folds a command result into its line and groups one AI on one ticket', () => {
    const items = [
      item({ id: 'a', kind: 'command', text: 'Ran `npm test`' }),
      item({ id: 'b', at: at(5), kind: 'result', ref: 'a', text: '`npm test` — 12 passed, 1 failed', tone: 'bad' }),
      item({ id: 'c', at: at(6), text: 'Edited src/search.js' }),
      item({ id: 'd', at: at(7), memberId: 'm2', memberName: 'Rev Binh', text: 'Started the Review step' }),
      item({ id: 'e', at: at(8), ticketId: 'KAN-2', text: 'Read the ticket' }),
    ];
    const lines = toLines(items, { speaker: null, ticketId: null });
    expect(lines.map((l) => l.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(lines[0].result).toEqual({ text: '12 passed, 1 failed', tone: 'bad' });
    const groups = toGroups(lines);
    expect(groups.map((g) => g.lines.map((l) => l.id))).toEqual([['a', 'c'], ['d'], ['e']]);
    expect(toLines(items, { speaker: 'm2', ticketId: null }).map((l) => l.id)).toEqual(['d']);
    expect(toLines(items, { speaker: null, ticketId: 'KAN-2' }).map((l) => l.id)).toEqual(['e']);
  });

  it('a long pause starts a new group', () => {
    const lines = toLines([item({ id: 'a' }), item({ id: 'b', at: at(600) })], { speaker: null, ticketId: null });
    expect(toGroups(lines)).toHaveLength(2);
  });

  it('merges pages once each, in time order, keeping the newest', () => {
    const a = item({ id: 'a', at: at(1) });
    const b = item({ id: 'b', at: at(3) });
    const late = item({ id: 'late', at: at(2) });
    expect(mergeFeed([a, b], [b, late]).map((i) => i.id)).toEqual(['a', 'late', 'b']);
    const many = Array.from({ length: 8 }, (_, n) => item({ id: `n${n}`, at: at(n) }));
    expect(mergeFeed([], many, 5).map((i) => i.id)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
  });

  it('short times and code spans', () => {
    expect(relTime(at(0), T0 + 3000)).toBe('now');
    expect(relTime(at(0), T0 + 42_000)).toBe('42s');
    expect(relTime(at(0), T0 + 5 * 60_000)).toBe('5m');
    expect(codeParts('Ran `npm test` now')).toEqual([
      { code: false, text: 'Ran ' },
      { code: true, text: 'npm test' },
      { code: false, text: ' now' },
    ]);
  });
});

describe('LiveFeed', () => {
  it('shows the lines with the name once, the role and the ticket, and opens the ticket', async () => {
    pages.push({
      items: [
        item({ id: 'a', kind: 'command', text: 'Ran `npm test`' }),
        item({ id: 'b', at: at(4), kind: 'result', ref: 'a', text: '`npm test` — 12 passed, 1 failed', tone: 'bad' }),
        item({ id: 'c', at: at(5), text: 'Edited src/search.js' }),
        item({
          id: 'd',
          at: at(6),
          memberId: null,
          memberName: 'Board',
          glyph: 'board',
          role: null,
          roleLabel: null,
          kind: 'done',
          text: 'Moved it to Done',
          tone: 'good',
        }),
      ],
      cursor: 'c1',
      working: ['m1'],
    });
    const open = vi.fn();
    setup({ onOpenTicket: open });
    const log = await screen.findByRole('log');
    expect(within(log).getAllByText('Dev An')).toHaveLength(1);
    expect(within(log).getByText('Dev (TDD)')).toBeTruthy();
    expect(within(log).getByText('npm test').tagName).toBe('CODE');
    expect(within(log).getByText(/12 passed, 1 failed/)).toBeTruthy();
    expect(within(log).getByText('Moved it to Done')).toBeTruthy();
    expect(screen.getByTestId('live-feed-working').textContent).toBe('1 AI working now');
    expect(screen.getByText('LIVE')).toBeTruthy();
    fireEvent.click(within(log).getAllByRole('button', { name: /KAN-1/ })[0]);
    expect(open).toHaveBeenCalledWith('KAN-1');
  });

  it('polls with the cursor and adds only the new lines', async () => {
    pages.push({ items: [item({ id: 'a' })], cursor: 'c1', working: [] });
    pages.push({ items: [item({ id: 'b', at: at(10), text: 'Ran the tests' })], cursor: 'c2', working: [] });
    setup();
    await screen.findByText('Edited calc.py');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await screen.findByText('Ran the tests');
    expect(calls[0]).toEqual({ limit: 200 });
    expect(calls[1]).toEqual({ limit: 200, after: 'c1' });
    expect(screen.getAllByText('Edited calc.py')).toHaveLength(1);
  });

  it('filters by AI and by ticket', async () => {
    pages.push({
      items: [
        item({ id: 'a', text: 'Edited calc.py' }),
        item({
          id: 'b',
          at: at(1),
          memberId: 'm2',
          memberName: 'Rev Binh',
          text: 'Passed the review',
          ticketId: 'KAN-2',
        }),
      ],
      cursor: 'c1',
      working: [],
    });
    setup();
    await screen.findByText('Passed the review');
    fireEvent.click(screen.getByRole('button', { name: 'Rev Binh' }));
    expect(screen.queryByText('Edited calc.py')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Only one ticket'), { target: { value: 'KAN-1' } });
    expect(screen.queryByText('Passed the review')).toBeNull();
    expect(screen.getByText('Edited calc.py')).toBeTruthy();
  });

  it('pause holds the feed still and counts what came in; Jump to live shows it', async () => {
    pages.push({ items: [item({ id: 'a' })], cursor: 'c1', working: [] });
    pages.push({ items: [item({ id: 'b', at: at(10), text: 'Ran the tests' })], cursor: 'c2', working: [] });
    setup();
    await screen.findByText('Edited calc.py');
    fireEvent.click(screen.getByRole('button', { name: 'Pause the feed' }));
    expect(screen.getByText('PAUSED')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(screen.getByTestId('live-feed-jump').textContent).toContain('1 new · Jump to live'));
    expect(screen.queryByText('Ran the tests')).toBeNull();
    fireEvent.click(screen.getByTestId('live-feed-jump'));
    expect(screen.getByText('Ran the tests')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('collapses to a rail and remembers it', async () => {
    pages.push({ items: [], cursor: 'c1', working: [] });
    setup();
    await screen.findByText(/It's quiet/);
    fireEvent.click(screen.getByRole('button', { name: 'Hide live commentary' }));
    expect(screen.queryByTestId('live-feed')).toBeNull();
    expect(window.localStorage.getItem('kanban.ai.liveFeed.collapsed')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Show live commentary' }));
    expect(screen.getByTestId('live-feed')).toBeTruthy();
  });

  it('the collapsed rail shows who is working, counts unread lines and expands on click and Enter', async () => {
    window.localStorage.setItem('kanban.ai.liveFeed.collapsed', '1');
    pages.push({ items: [item({ id: 'a' })], cursor: 'c1', working: ['m1', 'm2'] });
    pages.push({
      items: [item({ id: 'b', text: 'Ran the tests' }), item({ id: 'c', text: 'Pushed' })],
      cursor: 'c2',
      working: ['m1', 'm2'],
    });
    setup();
    const rail = await screen.findByRole('button', { name: /Show live commentary/ });
    await waitFor(() => expect(screen.getByTestId('live-feed-rail-working')).toBeTruthy());
    expect(screen.queryByTestId('live-feed-rail-unread')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(screen.getByTestId('live-feed-rail-unread').textContent).toBe('2'));
    expect(screen.getByRole('button', { name: 'Show live commentary, 2 new' })).toBe(rail);
    expect(rail.getAttribute('title')).toContain('Pushed');
    fireEvent.click(rail);
    expect(screen.getByTestId('live-feed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide live commentary' }));
    const again = screen.getByRole('button', { name: 'Show live commentary' });
    // a native button turns Enter into a click; jsdom does not, so keyDown+click stands in for it
    fireEvent.keyDown(again, { key: 'Enter' });
    fireEvent.click(again);
    expect(screen.getByTestId('live-feed')).toBeTruthy();
  });

  it('the split leaves the feed out when it is off', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LiveFeedSplit show={false} projectId="p1">
          <div>the map</div>
        </LiveFeedSplit>
      </QueryClientProvider>,
    );
    expect(screen.getByText('the map')).toBeTruthy();
    expect(screen.queryByTestId('live-feed')).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });
});
