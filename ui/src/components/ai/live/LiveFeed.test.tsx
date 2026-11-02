// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveFeedItem } from '../../../api/aiLiveFeed';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { mergeFeed } from '../../../api/aiLiveFeed';
import { LiveFeed, LiveFeedSplit, type FeedLinks } from './LiveFeed';
import { codeParts, foldDense, relTime, toGroups, toLines } from './liveFeedModel';
import type { NeedsItem } from '../../../types/aiTeam';

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

let pages: { items: LiveFeedItem[]; cursor: string; working: string[]; needsYou?: NeedsItem[] }[];
let calls: (Record<string, unknown> | undefined)[];

function setup(props: { onOpenTicket?: (id: string) => void; links?: FeedLinks } = {}) {
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

  it('filters by AI; the ticket box of main is gone (the scope says which ticket)', async () => {
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
    expect(screen.getByText('Edited calc.py')).toBeTruthy();
    expect(screen.queryByLabelText('Only one ticket')).toBeNull();
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
    await waitFor(() => expect(screen.getByTestId('live-feed-jump').textContent).toContain('1 held · Resume'));
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

describe('following the scope (design K, K2)', () => {
  it('folds more than five commands by one AI in a minute into one line, naming the failure', () => {
    const cmds = Array.from({ length: 7 }, (_, n) =>
      item({ id: `c${n}`, at: at(n * 5), kind: 'command', text: n === 3 ? 'Ran `npm run lint`' : 'Ran `npm test`' }),
    );
    const results = cmds.map((c, n) =>
      item({ id: `r${n}`, at: c.at, kind: 'result', ref: c.id, text: 'x — ok', tone: n === 3 ? 'bad' : 'good' }),
    );
    const lines = foldDense(
      toLines(
        [...cmds, ...results].sort((a, b) => (a.at < b.at ? -1 : 1)),
        { speaker: null, ticketId: null },
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Ran 7 commands in 1 min');
    expect(lines[0].result).toEqual({ text: '6 passed, 1 failed: npm run lint', tone: 'bad' });
    expect(lines[0].folded).toHaveLength(7);
    // five stay as they are
    expect(foldDense(toLines(cmds.slice(0, 5), { speaker: null, ticketId: null }))).toHaveLength(5);
  });

  it('Highlights is the default; Everything shows every command, read and edit', async () => {
    pages.push({
      items: [
        item({ id: 'a', text: 'Read FavouriteList.tsx', highlight: false }),
        item({ id: 'b', at: at(1), text: 'Finished the Build step', highlight: true, kind: 'finished' }),
      ],
      cursor: 'c1',
      working: [],
    });
    setup();
    await screen.findByText('Finished the Build step');
    expect(screen.queryByText('Read FavouriteList.tsx')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    expect(screen.getByText('Read FavouriteList.tsx')).toBeTruthy();
    expect(window.localStorage.getItem('kanban.ai.liveFeed.detail')).toBe('everything');
  });

  it('asks for the lines of the scope and names it on a line that is not a button', async () => {
    pages.push({ items: [item({ id: 'a', highlight: true })], cursor: 'c1', working: [] });
    setup({
      links: {
        scope: { story: 'KAN-301', ticket: null },
        scopeLabel: { kind: 'story', id: 'KAN-301', title: 'Weather app' },
      },
    });
    await screen.findByText('Edited calc.py');
    expect(calls[0]).toEqual({ limit: 200, story: 'KAN-301' });
    const line = screen.getByTestId('live-feed-scope');
    expect(line.textContent).toBe('Story KAN-301 · Weather app');
    expect(line.tagName).not.toBe('BUTTON');
  });

  it('pins Needs you on top with its answer button, and keeps the count on the folded rail', async () => {
    const need = {
      kind: 'question',
      runId: 'r9',
      options: [],
      since: null,
      waitingS: 360,
      memberId: 'm3',
      memberName: 'Designer Dao',
      ticketId: 'KAN-303',
      text: 'Which icon set for the weather conditions?',
    } as NeedsItem;
    pages.push({ items: [], cursor: 'c1', working: [], needsYou: [need] });
    const open = vi.fn();
    setup({ onOpenTicket: open, links: {} });
    const box = await screen.findByTestId('live-feed-needs');
    expect(box.textContent).toContain('Which icon set for the weather conditions?');
    expect(box.textContent).toContain('Designer Dao · KAN-303 · waiting 6 min');
    fireEvent.click(within(box).getByRole('button', { name: 'Answer' }));
    expect(open).toHaveBeenCalledWith('KAN-303');
    fireEvent.click(screen.getByRole('button', { name: 'Hide live commentary' }));
    expect(screen.getByTestId('live-feed-rail-needs').textContent).toBe('1');
  });

  it('an empty ticket says what it waits for and offers its Story', async () => {
    pages.push({ items: [], cursor: 'c1', working: [] });
    const showStory = vi.fn();
    setup({
      links: {
        scope: { story: 'KAN-301', ticket: 'KAN-306' },
        scopeLabel: { kind: 'ticket', id: 'KAN-306', title: 'Offline states' },
        waitsFor: ['KAN-305'],
        onShowStory: showStory,
      },
    });
    const empty = await screen.findByTestId('live-feed-empty-scope');
    expect(empty.textContent).toContain('Nothing yet for KAN-306.');
    expect(empty.textContent).toContain('It waits for KAN-305.');
    fireEvent.click(screen.getByRole('button', { name: 'Show the Story instead' }));
    expect(showStory).toHaveBeenCalled();
  });

  it('a quiet Story says nothing runs and what the last thing was', async () => {
    pages.push({
      items: [item({ id: 'a', highlight: false, text: 'Moved KAN-304 to Done' })],
      cursor: 'c1',
      working: [],
    });
    setup({ links: { scope: { story: 'KAN-301' }, scopeLabel: { kind: 'story', id: 'KAN-301', title: null } } });
    const quiet = await screen.findByTestId('live-feed-quiet');
    expect(quiet.textContent).toContain('Nothing is running in this Story.');
    expect(quiet.textContent).toContain('The last thing was KAN-1: Moved KAN-304 to Done');
  });

  it('a hovered line lights the drawing, a click opens its run, and the running AI can be told', async () => {
    pages.push({
      items: [item({ id: 'run-1:s', highlight: true, runId: 'run-1', text: 'Started KAN-1' })],
      cursor: 'c1',
      working: ['m1'],
    });
    http.post.mockResolvedValue({ data: { delivered: 'input' } });
    const hover = vi.fn();
    const openRun = vi.fn();
    setup({
      links: {
        liveRuns: [
          {
            runId: 'run-1',
            memberId: 'm1',
            memberName: 'Dev An',
            ticketId: 'KAN-1',
            ticketTitle: 'Fix add()',
            state: 'working',
            mode: 'work',
            trigger: 'assign',
            sender: '',
            elapsedS: 30,
            step: 'Build',
          },
        ],
        onHoverLine: hover,
        onOpenRun: openRun,
      },
    });
    const text = await screen.findByText('Started KAN-1');
    const group = text.closest('.lf-group') as HTMLElement;
    fireEvent.mouseEnter(group);
    expect(hover).toHaveBeenLastCalledWith({ memberId: 'm1', ticketId: 'KAN-1' });
    fireEvent.click(text);
    expect(openRun).toHaveBeenCalledWith('run-1');
    fireEvent.click(screen.getByRole('button', { name: 'Tell Dev An, who is working on KAN-1' }));
    fireEvent.change(screen.getByLabelText('Tell Dev An'), { target: { value: 'Use the storage helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/ai/runs/run-1/tell', { text: 'Use the storage helper' }),
    );
    await screen.findByText('Sent. The AI reads it at its next turn.');
    fireEvent.mouseLeave(group);
    expect(hover).toHaveBeenLastCalledWith(null);
  });

  it('greys the reply box for an AI that is not running', async () => {
    pages.push({ items: [item({ id: 'a', highlight: true })], cursor: 'c1', working: [] });
    setup({ links: { liveRuns: [] } });
    const text = await screen.findByText('Edited calc.py');
    fireEvent.mouseEnter(text.closest('.lf-group') as HTMLElement);
    expect(screen.getByTestId('live-feed-tell-off').textContent).toContain('Dev An is not running now');
  });

  it('lights the lines of the AI hovered in the drawing', async () => {
    pages.push({ items: [item({ id: 'a', highlight: true })], cursor: 'c1', working: [] });
    setup({ links: { lit: { memberId: 'm1', ticketId: null } } });
    const text = await screen.findByText('Edited calc.py');
    expect((text.closest('.lf-group') as HTMLElement).className).toContain('lf-lit');
  });
});
