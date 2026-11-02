// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthStory } from '../../api/aiTeam';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { StoryAutonomy } from './StoryAutonomy';

const stories: HealthStory[] = [
  {
    id: 'KAN-288',
    title: 'Notification digest email',
    state: 'in_progress',
    ticketsDone: 2,
    ticketsTotal: 4,
    touches: { needed: 1, avoidable: 2, byRule: 0 },
    reasons: [
      'Needed: You answered which sender address on KAN-289',
      'Avoidable: You raised the daily budget of Dev Khoa on KAN-291. A limit was hit',
      'Avoidable: You raised the daily budget of Dev Khoa on KAN-292',
    ],
  },
  {
    id: 'KAN-296',
    title: 'Dark mode for Docs',
    state: 'review',
    ticketsDone: 5,
    ticketsTotal: 5,
    touches: { needed: 0, avoidable: 0, byRule: 1 },
    reasons: [],
  },
  {
    id: 'KAN-270',
    title: 'Keyboard shortcuts',
    state: 'done',
    ticketsDone: 6,
    ticketsTotal: 6,
    touches: { needed: 0, avoidable: 0, byRule: 0 },
    reasons: [],
  },
];

function setup() {
  http.get.mockImplementation(async (url: string) => {
    // the Story API says KAN-288 is blocked now
    if (url === '/projects/p1/stories')
      return {
        data: [
          {
            id: 'KAN-288',
            state: 'in_progress',
            planWaiting: false,
            blocked: { kind: 'question', text: 'Choose a sender address', ticketId: 'KAN-290' },
          },
        ],
      };
    return { data: {} };
  });
  const onOpenStepped = vi.fn();
  const onOpenStory = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StoryAutonomy projectId="p1" stories={stories} onOpenStepped={onOpenStepped} onOpenStory={onOpenStory} />
    </QueryClientProvider>,
  );
  return { onOpenStepped, onOpenStory };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Autonomy by Story (Health)', () => {
  it('shows the tiles and a row per Story with its count and why', async () => {
    const { onOpenStepped, onOpenStory } = setup();
    const tiles = screen.getByTestId('story-autonomy-tiles');
    expect(tiles.textContent).toContain('Stories3');
    expect(tiles.textContent).toContain('Stepped in on Stories3needed 1 · avoidable 2. By rule 1 is not counted');
    expect(tiles.textContent).toContain('Stories with 02 of 3');
    expect(await within(tiles).findByText('1 blocked · 1 review · 1 done')).toBeTruthy();

    const rows = screen.getAllByTestId('story-autonomy-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('2 of 4 done');
    expect(rows[0].textContent).toContain('3goal 0');
    expect(rows[0].textContent).toContain('Needed 1');
    expect(rows[0].textContent).toContain('Avoidable 2');
    expect(rows[0].textContent).toContain('(and 2 more)');
    expect(rows[1].textContent).toContain('By rule 1');
    expect(rows[1].textContent).toContain('The only touches are the ones your project asks for.');
    expect(rows[2].textContent).toContain('No one stepped in');
    expect(rows[2].textContent).toContain('Done without anyone stepping in.');

    // a row with reasons opens them, each with its mark
    fireEvent.click(rows[0]);
    const reasons = screen.getByTestId('story-autonomy-reasons');
    expect(reasons.textContent).toContain('You answered which sender address on KAN-289Needed');
    expect(reasons.textContent).toContain('You raised the daily budget of Dev Khoa on KAN-292Avoidable');

    fireEvent.click(screen.getByText('Notification digest email'));
    expect(onOpenStory).toHaveBeenCalledWith('KAN-288');
    fireEvent.click(screen.getByTestId('open-stepped'));
    expect(onOpenStepped).toHaveBeenCalled();
  });
});
