// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { TeamAway } from '../../api/aiTeam';
import type { TeamCard } from '../../types/aiTeam';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { ToastProvider } from '../Toast';
import { AwayCard, AwaySummary, awayText, type AwayActions } from './AwayCard';
import { AWAY_AFTER_MS, awayOnArrival, closeAway, markSeen, readLastSeen } from './awayStore';

const SINCE = new Date(Date.now() - 15 * 3600_000).toISOString();
const UNTIL = new Date().toISOString();

const away = (o: Partial<TeamAway> = {}): TeamAway => ({
  since: SINCE,
  until: UNTIL,
  ran: true,
  pausedAll: false,
  stories: [
    {
      id: 'KAN-301',
      title: 'Weather app, web version',
      from: { state: 'in_progress', done: 0, total: 5 },
      to: { state: 'in_progress', done: 3, total: 5 },
      runs: 7,
    },
    {
      id: 'KAN-296',
      title: 'Dark mode for Docs',
      from: { state: 'in_progress', done: 3, total: 5 },
      to: { state: 'review', done: 5, total: 5 },
      runs: 2,
    },
  ],
  finished: [
    { ticketId: 'KAN-302', title: 'Search a city', storyId: 'KAN-301', at: SINCE, memberId: 'm1', sentBack: 0 },
    { ticketId: 'KAN-304', title: 'Unit switch', storyId: 'KAN-301', at: SINCE, memberId: 'm1', sentBack: 1 },
  ],
  needed: [
    {
      at: SINCE,
      kind: 'plan',
      ticketId: 'KAN-310',
      memberId: null,
      text: 'Plan for Export a board to CSV',
      open: true,
      storyId: 'KAN-310',
    },
  ],
  decided: { count: 7, overridable: 2 },
  spent: {
    usd: 11.3,
    tokens: 2_400_000,
    byStory: [
      { storyId: 'KAN-301', title: 'Weather app', usd: 6.4, tokens: 1_300_000 },
      { storyId: null, title: 'Not in a Story', usd: 0.1, tokens: 100_000 },
    ],
    dailyCap: 25,
  },
  failed: [
    {
      runId: 'r9',
      ticketId: 'KAN-321',
      memberId: 'm1',
      at: SINCE,
      text: 'Ran out of time',
      retried: true,
      retryState: 'finished',
    },
  ],
  waiting: 2,
  ...o,
});

let answer: TeamAway;
const actions = (): AwayActions => ({
  onOpenTicket: vi.fn(),
  onOpenStory: vi.fn(),
  onOpenWaiting: vi.fn(),
  onSeeDecided: vi.fn(),
  onResume: vi.fn(),
});

function wrap(ui: ReactNode) {
  http.get.mockImplementation(async (url: string) => {
    if (url === '/projects/p1/ai/away') return { data: answer };
    if (url === '/projects/p1/stories') return { data: [] };
    if (url === '/projects/p1/ai/decisions')
      return {
        data: {
          items: [
            {
              id: 'd1',
              at: SINCE,
              kind: 'approve_design',
              title: 'Approved the design of KAN-305',
              why: '',
              ticketId: 'KAN-305',
              storyId: 'KAN-301',
              storyTitle: 'Weather app',
              member: null,
              state: 'in_effect',
              canOverride: true,
              whyNot: null,
              result: '',
              overriddenBy: null,
              overriddenAt: null,
              overrideNote: null,
            },
          ],
          totals: { decided: 1, inEffect: 1, overridable: 1, overridden: 0, final: 0 },
          kinds: [{ kind: 'approve_design', count: 1 }],
        },
      };
    return { data: {} };
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  answer = away();
});
afterEach(cleanup);

describe('the away window', () => {
  it('opens after 30 minutes away, per person, and stays until it is closed', () => {
    expect(awayOnArrival()).toBeNull(); // the first visit: nothing to say
    const now = Date.now();
    markSeen(now - 10 * 60_000);
    expect(awayOnArrival(now)).toBeNull();
    markSeen(now - AWAY_AFTER_MS - 60_000);
    const since = awayOnArrival(now);
    expect(since).toBe(new Date(now - AWAY_AFTER_MS - 60_000).toISOString());
    markSeen(now); // the heartbeat goes on, the window stays until closed
    expect(awayOnArrival(now)).toBe(since);
    closeAway(now);
    expect(awayOnArrival(now)).toBeNull();
    expect(readLastSeen()).toBe(now);
    localStorage.setItem('kanbanActor', 'm2');
    expect(readLastSeen()).toBeNull();
  });
});

describe('AwayCard', () => {
  it('counts what happened and opens the full summary', async () => {
    const a = actions();
    const onClose = vi.fn();
    const onOpenFull = vi.fn();
    wrap(<AwayCard projectId="p1" since={SINCE} onClose={onClose} onOpenFull={onOpenFull} actions={a} />);
    const card = await screen.findByTestId('away-card');
    expect(http.get).toHaveBeenCalledWith('/projects/p1/ai/away', { params: { since: SINCE } });
    expect(card.textContent).toContain('15 hours ago');
    expect(card.textContent).toContain('2Stories moved1 to Review');
    expect(card.textContent).toContain('2tickets finishedacross 1 Story');
    expect(card.textContent).toContain('1times you were neededit still waits for you');
    expect(card.textContent).toContain('7decided for you2 can still be overridden');
    expect(card.textContent).toContain('$11.30spent2.4M tokens, cap $25.00 a day');
    expect(screen.getAllByTestId('away-story')[0].textContent).toContain('0 of 5 → 3 of 5');
    expect(screen.getAllByTestId('away-story')[0].textContent).toContain('KAN-302, KAN-304 finished');
    fireEvent.click(screen.getByTestId('away-open-waiting'));
    expect(a.onOpenWaiting).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('away-see-full'));
    expect(onOpenFull).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('away-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    [{ ran: false, waiting: 0 }, 'away-quiet', 'nothing ran and nothing waits for you'],
    [{ ran: false, waiting: 2 }, 'away-needed', 'Nothing ran, and 2 things wait for you.'],
    [{ ran: false, waiting: 0, pausedAll: true }, 'away-paused', 'AI was paused for all of it.'],
  ])('says plainly when %o', async (o, id, text) => {
    answer = away(o);
    const a = actions();
    wrap(<AwayCard projectId="p1" since={SINCE} onClose={vi.fn()} onOpenFull={vi.fn()} actions={a} />);
    expect((await screen.findByTestId(id)).textContent).toContain(text);
    if (id === 'away-paused') {
      fireEvent.click(screen.getByTestId('away-resume'));
      expect(a.onResume).toHaveBeenCalled();
    }
    if (id === 'away-needed') {
      fireEvent.click(screen.getByTestId('away-open-waiting'));
      expect(a.onOpenWaiting).toHaveBeenCalled();
    }
  });
});

describe('AwaySummary', () => {
  const members = [{ id: 'm1', name: 'Dev Khoa', color: '#2E6F40' }] as TeamCard[];

  it('shows each item, copies the summary as text and marks it seen', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const a = actions();
    const onMarkSeen = vi.fn();
    wrap(
      <AwaySummary
        projectId="p1"
        since={SINCE}
        members={members}
        onBack={vi.fn()}
        onMarkSeen={onMarkSeen}
        actions={a}
      />,
    );
    const page = await screen.findByTestId('away-summary');
    expect(page.textContent).toContain('15 haway');
    expect(screen.getAllByTestId('away-finished')).toHaveLength(2);
    expect(screen.getAllByTestId('away-finished')[1].textContent).toContain('sent back once');
    expect(screen.getByTestId('away-needed').textContent).toContain('Still waiting, 15 h.');
    expect(page.textContent).toContain('1.3M · $6.40');
    expect(page.textContent).toContain('The retry passed. Nothing to do.');
    expect(await screen.findByText('Approved the design of KAN-305')).toBeTruthy();
    fireEvent.click(screen.getByText('See all 7 in Decided for you'));
    expect(a.onSeeDecided).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('away-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('Weather app, web version (KAN-301): 0 of 5 -> 3 of 5');
    fireEvent.click(screen.getByTestId('away-mark-seen'));
    expect(onMarkSeen).toHaveBeenCalled();
  });

  it('writes a plain-text summary', () => {
    const text = awayText(away(), (id) => (id === 'm1' ? 'Dev Khoa' : ''));
    expect(text).toContain('2 Stories moved · 2 tickets finished · 1 times you were needed');
    expect(text).toContain('- KAN-321: Ran out of time (tried again)');
  });
});
