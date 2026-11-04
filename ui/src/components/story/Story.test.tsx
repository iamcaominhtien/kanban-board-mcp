// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));
// The AI lines of a ticket card have their own tests and their own queries
vi.mock('../ai/RunPanel', () => ({ CardAiFooter: () => null }));
vi.mock('../workflowBoard/WorkflowBoardContext', () => ({ WorkflowCardChip: () => null }));
vi.mock('../schedules/ScheduleTicketBlock', () => ({ ScheduleCardChip: () => null }));
vi.mock('../assist/BoardHealth', () => ({ CardInsightChip: () => null }));

import { StoryCard } from './StoryCard';
import { GiveStoryDialog } from './GiveStoryDialog';
import { StoryPage } from './StoryPage';
import { StoryLanes, statusOfDropId } from './StoryLanes';
import { readGroupByStory, writeGroupByStory } from './storyLinks';
import { waitsWord } from './storyUi';
import { TicketCard } from '../TicketCard';
import type { Column, Ticket } from '../../types';
import type { StoryDetail, StoryView } from '../../types/story';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);
const ok = (data: unknown) => Promise.resolve({ data });

const ticket = (o: Partial<Ticket>): Ticket =>
  ({
    id: 'KAN-1',
    projectId: 'p1',
    title: 'A ticket',
    description: '',
    type: 'task',
    status: 'backlog',
    priority: 'medium',
    estimate: null,
    dueDate: null,
    startDate: null,
    tags: [],
    parentId: null,
    comments: [],
    acceptanceCriteria: [],
    subTasks: [],
    activityLog: [],
    workLog: [],
    testCases: [],
    wontDoReason: null,
    createdBy: null,
    assignee: null,
    blocks: [],
    blockedBy: [],
    blockDoneIfAcsIncomplete: false,
    blockDoneIfTcsIncomplete: false,
    links: [],
    createdAt: '2026-11-01T08:00:00Z',
    updatedAt: '2026-11-01T08:00:00Z',
    ...o,
  }) as Ticket;

const story = (o: Partial<StoryView>): StoryView => ({
  id: 'KAN-301',
  projectId: 'p1',
  title: 'Weather app, web version',
  goal: 'A web page where I type a city and see the weather there.',
  state: 'in_progress',
  blocked: null,
  planWaiting: false,
  approve: 'person',
  paused: false,
  pm: { id: 'pm1', name: 'PM Linh', color: '#2F6FB0' },
  criteria: [],
  plan: null,
  progress: { done: 3, total: 5, building: 1, waiting: 1 },
  tokens: { used: 1_300_000, budget: 2_000_000 },
  costUsd: 6.4,
  interventions: { count: 1, needed: 1, avoidable: 0, byRule: 2 },
  handedAt: '2026-11-02T08:00:00Z',
  startedAt: '2026-11-02T09:12:00Z',
  closedAt: null,
  createdAt: '2026-11-02T08:00:00Z',
  ...o,
});

const planOf = (items: { id: string; title: string; after?: string[]; status?: string; covers?: number[] }[]) => ({
  version: 1,
  by: 'pm',
  at: '2026-11-02T08:04:00Z',
  approvedBy: null,
  approvedAt: null,
  note: 'I will make four tickets. Two can run together.',
  items: items.map((it, i) => ({
    order: i + 1,
    ticketId: it.id,
    title: it.title,
    status: it.status ?? 'backlog',
    heldBy: { id: 'dv', name: 'Dev Khoa', role: 'dev' },
    step: null,
    after: it.after ?? [],
    covers: it.covers ?? [i + 1],
    startedAt: null,
    endedAt: null,
  })),
  changes: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});
afterEach(cleanup);

describe('StoryCard', () => {
  it('shows a Draft with Give it to the PM, and hands it with the chosen settings', async () => {
    const t = ticket({ id: 'KAN-315', type: 'story', title: 'Weather alerts' });
    http.get.mockImplementation((url: string) =>
      url === '/projects/p1/stories'
        ? ok([
            story({
              id: 'KAN-315',
              title: 'Weather alerts',
              state: 'draft',
              approve: 'pm',
              progress: { done: 0, total: 0, building: 0, waiting: 0 },
              tokens: { used: 0, budget: 0 },
            }),
          ])
        : ok({ autonomy: { approve: 'pm' } }),
    );
    http.post.mockReturnValue(ok(story({ id: 'KAN-315', state: 'planning' })));
    const onOpen = vi.fn();
    render(wrap(<StoryCard ticket={t} onOpen={onOpen} />));
    await waitFor(() => expect(screen.getByTestId('story-card').getAttribute('data-face')).toBe('draft'));
    expect(screen.getByText('Not given to the PM yet')).toBeTruthy();
    expect(screen.queryByText(/stepped in/)).toBeNull();

    fireEvent.click(screen.getByTestId('story-card-hand'));
    expect(onOpen).not.toHaveBeenCalled();
    // The Draft was made with the project's autonomy.approve (the PM): the second option is pre-selected
    await waitFor(() => expect(screen.getByTestId('story-approve-pm').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(screen.getByTestId('story-give'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/stories/KAN-315/hand', { approve: 'pm', budgetTokens: 2_000_000 }),
    );
  });

  it('shows the amber strip only when the plan waits, and opens the plan from it', async () => {
    const t = ticket({ id: 'KAN-310', type: 'story', status: 'todo', title: 'Export a board to CSV' });
    const s = story({
      id: 'KAN-310',
      title: 'Export a board to CSV',
      state: 'planning',
      planWaiting: true,
      progress: { done: 0, total: 4, building: 0, waiting: 0 },
      criteria: [1, 2, 3, 4].map((n) => ({
        id: `c${n}`,
        text: `C${n}`,
        done: false,
        ticketId: null,
        state: 'not_started' as const,
      })),
      plan: planOf([
        { id: 'KAN-311', title: 'Write the CSV for one board' },
        { id: 'KAN-312', title: 'Choose columns and the date range', after: ['KAN-311'] },
        { id: 'KAN-313', title: 'Export button and file name', after: ['KAN-311'] },
        { id: 'KAN-314', title: 'Tests for large boards', after: ['KAN-312', 'KAN-313'] },
      ]),
    });
    http.get.mockReturnValue(ok([s]));
    http.post.mockReturnValue(ok(s));
    render(wrap(<StoryCard ticket={t} />));
    const strip = await screen.findByTestId('story-card-plan');
    expect(strip.textContent).toContain('Plan for 4 tickets');
    fireEvent.click(strip);
    const review = await screen.findByTestId('plan-review');
    expect(within(review).getAllByTestId('plan-review-row')).toHaveLength(4);
    expect(review.textContent).toContain('after 1');
    expect(review.textContent).toContain('at the same time as 2');
    expect(review.textContent).toContain('after 2 and 3');
    expect(review.textContent).toContain('All 4 criteria are covered.');

    fireEvent.click(screen.getByTestId('plan-tell'));
    fireEvent.change(screen.getByTestId('plan-tell-note'), { target: { value: 'Split the button' } });
    fireEvent.click(screen.getByTestId('plan-tell-send'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/stories/KAN-310/plan/revise', { note: 'Split the button' }),
    );
  });

  it('approves the plan and runs it', async () => {
    const s = story({
      id: 'KAN-310',
      state: 'planning',
      planWaiting: true,
      plan: planOf([{ id: 'KAN-311', title: 'One' }]),
    });
    http.get.mockReturnValue(ok([s]));
    http.post.mockReturnValue(ok({ ...s, planWaiting: false, state: 'in_progress' }));
    render(wrap(<StoryCard ticket={ticket({ id: 'KAN-310', type: 'story', status: 'todo' })} />));
    fireEvent.click(await screen.findByTestId('story-card-plan'));
    fireEvent.click(await screen.findByTestId('plan-approve'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/stories/KAN-310/plan/approve'));
    await waitFor(() => expect(screen.queryByTestId('plan-review')).toBeNull());
  });

  it('says what a Blocked Story waits for, and how often a person stepped in', async () => {
    http.get.mockReturnValue(
      ok([
        story({
          id: 'KAN-288',
          blocked: { kind: 'question', text: 'choose a sender address for KAN-290', ticketId: 'KAN-290' },
          interventions: { count: 3, needed: 2, avoidable: 1, byRule: 0 },
        }),
      ]),
    );
    render(wrap(<StoryCard ticket={ticket({ id: 'KAN-288', type: 'story', status: 'in-progress' })} />));
    const blocked = await screen.findByTestId('story-card-blocked');
    expect(blocked.textContent).toBe('Needs you: choose a sender address for KAN-290');
    expect(screen.getByText('You stepped in 3 times')).toBeTruthy();
    expect(screen.getByTestId('story-state-chip').textContent).toBe('Blocked');
  });

  it('reads its ticket while the Story API does not answer', async () => {
    http.get.mockRejectedValue(new Error('down'));
    const t = ticket({ id: 'KAN-296', type: 'story', status: 'review', title: 'Dark mode for Docs' });
    const kids = [1, 2].map((n) => ticket({ id: `KAN-29${n}`, parentId: 'KAN-296', status: 'done' }));
    render(wrap(<StoryCard ticket={t} allTickets={[t, ...kids]} />));
    expect(await screen.findByText('2 of 2 tickets done')).toBeTruthy();
    expect(screen.getByText('No one has stepped in')).toBeTruthy();
  });
});

describe('GiveStoryDialog', () => {
  it('pre-selects Show me the plan first when designs are approved by a person, and creates the Story', async () => {
    http.get.mockReturnValue(ok({ autonomy: { approve: 'person' } }));
    http.post.mockReturnValue(ok(story({ id: 'KAN-320', state: 'planning' })));
    const onClose = vi.fn();
    render(wrap(<GiveStoryDialog projectId="p1" onClose={onClose} />));
    await waitFor(() => expect(screen.getByTestId('story-approve-hint').textContent).toContain('You'));
    expect(screen.getByTestId('story-approve-person').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('story-give') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('story-title'), { target: { value: 'Weather app' } });
    fireEvent.change(screen.getByTestId('story-goal'), { target: { value: 'See the weather of a city' } });
    fireEvent.change(screen.getByLabelText('Criterion 1'), { target: { value: 'I can type a city' } });
    fireEvent.click(screen.getByText('Add a criterion'));
    fireEvent.change(screen.getByLabelText('Criterion 2'), { target: { value: 'I can see seven days' } });
    fireEvent.click(screen.getByText('Add a criterion')); // an empty one is left out
    fireEvent.change(screen.getByTestId('story-budget'), { target: { value: '500,000' } });
    fireEvent.click(screen.getByTestId('story-give'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/projects/p1/stories', {
        title: 'Weather app',
        goal: 'See the weather of a city',
        criteria: ['I can type a city', 'I can see seven days'],
        approve: 'person',
        budgetTokens: 500_000,
        hand: true,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says why the server refused', async () => {
    http.get.mockReturnValue(ok({}));
    http.post.mockRejectedValue({ response: { data: { detail: 'This project has no PM.' } } });
    render(wrap(<GiveStoryDialog projectId="p1" onClose={() => {}} />));
    fireEvent.change(screen.getByTestId('story-title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByTestId('story-goal'), { target: { value: 'G' } });
    fireEvent.click(screen.getByTestId('story-give'));
    expect((await screen.findByRole('alert')).textContent).toBe('This project has no PM.');
  });
});

describe('StoryPage', () => {
  const detail: StoryDetail = {
    ...story({
      criteria: [
        { id: 'c1', text: 'See today', done: true, ticketId: 'KAN-302', state: 'met' },
        { id: 'c2', text: 'Cities stay', done: false, ticketId: 'KAN-305', state: 'in_progress' },
      ],
      plan: {
        ...planOf([
          { id: 'KAN-302', title: 'Search a city', status: 'done' },
          { id: 'KAN-305', title: 'Save favourite cities', status: 'in-progress' },
          { id: 'KAN-306', title: 'Offline message', after: ['KAN-305'] },
        ]),
        version: 2,
        approvedBy: 'pm',
        changes: [{ at: '2026-11-02T10:30:00Z', text: 'Added KAN-306 after the review of KAN-304.' }],
      },
    }),
    decisions: [
      {
        id: 'd1',
        at: '2026-11-02T10:05:00Z',
        kind: 'approve_design',
        title: 'Approved the design of KAN-303',
        why: 'Matches the criterion.',
        ticketId: 'KAN-303',
        storyId: 'KAN-301',
        storyTitle: 'Weather app',
        member: { id: 'pm1', name: 'PM Linh' },
        state: 'in_effect',
        canOverride: true,
        whyNot: null,
        result: '',
        overriddenBy: null,
        overriddenAt: null,
        overrideNote: null,
      },
      {
        id: 'd2',
        at: '2026-11-02T09:40:00Z',
        kind: 'retry',
        title: 'Spent 220k more tokens on KAN-302',
        why: 'Inside the Story budget.',
        ticketId: 'KAN-302',
        storyId: 'KAN-301',
        storyTitle: 'Weather app',
        member: null,
        state: 'in_effect',
        canOverride: false,
        whyNot: 'the tokens are spent',
        result: '',
        overriddenBy: null,
        overriddenAt: null,
        overrideNote: null,
      },
    ],
    children: ['KAN-302', 'KAN-305', 'KAN-306'],
  };
  const t = ticket({ id: 'KAN-301', type: 'story', status: 'in-progress' });

  it('answers what was asked, how far it is, what the PM decided and what it cost', async () => {
    http.get.mockReturnValue(ok(detail));
    const onOpenTicket = vi.fn();
    const kid = ticket({ id: 'KAN-305', parentId: 'KAN-301' });
    render(wrap(<StoryPage ticket={t} allTickets={[t, kid]} onClose={() => {}} onOpenTicket={onOpenTicket} />));
    await screen.findByText('3 of 5');
    expect(screen.getAllByText('1.3M')).toHaveLength(2); // the tile and Tokens and money
    expect(screen.getByText('1 of 2 met')).toBeTruthy();
    expect(screen.getByText('Plan · version 2')).toBeTruthy();
    expect(screen.getAllByTestId('story-plan-row')).toHaveLength(3);
    expect(screen.getByText('Waits for KAN-305')).toBeTruthy();
    expect(screen.getByTestId('story-plan-change').textContent).toContain('Added KAN-306');
    expect(screen.getByText('about $6.40 so far')).toBeTruthy();
    expect(screen.getByTestId('decision-why-not').textContent).toContain('the tokens are spent');

    fireEvent.click(screen.getAllByText('KAN-305')[0]);
    expect(onOpenTicket).toHaveBeenCalledWith(kid);
  });

  it('overrides a decision, and says why when it no longer can', async () => {
    http.get.mockReturnValue(ok(detail));
    http.post.mockRejectedValueOnce({ response: { status: 409, data: { detail: 'Dev already built on it.' } } });
    render(wrap(<StoryPage ticket={t} onClose={() => {}} />));
    fireEvent.click(await screen.findByTestId('decision-override'));
    fireEvent.click(screen.getByTestId('decision-override-confirm'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/decisions/d1/override', {}));
    expect((await screen.findByTestId('decision-override-error')).textContent).toBe('Dev already built on it.');
  });

  it('pauses the Story and edits the plan in place', async () => {
    http.get.mockReturnValue(ok(detail));
    http.post.mockReturnValue(ok(detail));
    http.patch.mockReturnValue(ok(detail));
    render(wrap(<StoryPage ticket={t} onClose={() => {}} />));
    fireEvent.click(await screen.findByTestId('story-page-pause'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/stories/KAN-301/pause'));

    fireEvent.click(screen.getByTestId('plan-edit'));
    fireEvent.click(screen.getByLabelText('Move KAN-306 up'));
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/stories/KAN-301/plan', {
        items: [
          { ticketId: 'KAN-302', after: [] },
          { ticketId: 'KAN-306', after: [] },
          { ticketId: 'KAN-305', after: [] },
        ],
      }),
    );
  });

  it('closes on Escape', async () => {
    http.get.mockReturnValue(ok(detail));
    const onClose = vi.fn();
    render(wrap(<StoryPage ticket={t} onClose={onClose} />));
    await screen.findByText('3 of 5');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('StoryLanes', () => {
  const columns: Column[] = [
    { id: 'backlog', label: 'Backlog', accentColor: '' },
    { id: 'todo', label: 'To Do', accentColor: '' },
    { id: 'in-progress', label: 'In Progress', accentColor: '' },
    { id: 'review', label: 'Review', accentColor: '' },
    { id: 'testing', label: 'Testing', accentColor: '' },
    { id: 'done', label: 'Done', accentColor: '' },
  ];
  const s1 = ticket({ id: 'KAN-301', type: 'story', status: 'in-progress', title: 'Weather app' });
  const draft = ticket({ id: 'KAN-315', type: 'story', status: 'backlog', title: 'Weather alerts' });
  const kids = [
    ticket({ id: 'KAN-305', parentId: 'KAN-301', status: 'in-progress', title: 'Save favourite cities' }),
    ticket({ id: 'KAN-304', parentId: 'KAN-301', status: 'done', title: 'Unit switch' }),
  ];
  const loose = ticket({ id: 'KAN-318', status: 'backlog', title: 'Show last updated time' });
  const all = [s1, draft, ...kids, loose];

  it('draws one lane per Story, the Draft in Backlog, and the rest in the last lane', async () => {
    http.get.mockReturnValue(
      ok([
        story({ id: 'KAN-301', title: 'Weather app', progress: { done: 1, total: 2, building: 1, waiting: 0 } }),
        story({ id: 'KAN-315', title: 'Weather alerts', state: 'draft' }),
      ]),
    );
    const onCardClick = vi.fn();
    render(
      wrap(
        <DndContext>
          <StoryLanes columns={columns} tickets={all} allTickets={all} onCardClick={onCardClick} />
        </DndContext>,
      ),
    );
    const lanes = await screen.findAllByTestId('lane-story');
    expect(lanes.map((l) => l.getAttribute('data-story-id'))).toEqual(['KAN-301', 'KAN-315']);
    await waitFor(() => expect(lanes[0].textContent).toContain('1 of 2 done'));
    // The children sit in the columns; the lane says the Story, so no chip on them
    expect(screen.getByText('Save favourite cities')).toBeTruthy();
    expect(screen.queryByTitle('In the Story Weather app')).toBeNull();
    expect(screen.getByTestId('lane-loose').textContent).toContain('1 ticket');

    fireEvent.click(screen.getByLabelText('Fold KAN-301'));
    expect(screen.queryByText('Save favourite cities')).toBeNull();
    expect(screen.getByText('Collapsed: 1 in In Progress · 1 in Done')).toBeTruthy();

    fireEvent.click(screen.getByText('Weather app'));
    expect(onCardClick).toHaveBeenCalledWith(s1);
  });

  it('reads the status of a lane cell', () => {
    expect(statusOfDropId('lane:KAN-301:in-progress')).toBe('in-progress');
    expect(statusOfDropId('lane:__loose:done')).toBe('done');
    expect(statusOfDropId('review')).toBe('review');
  });
});

describe('Group by: Story', () => {
  it('is off until turned on, and is remembered per person', () => {
    expect(readGroupByStory()).toBe(false);
    writeGroupByStory(true);
    expect(readGroupByStory()).toBe(true);
    localStorage.setItem('kanbanActor', 'someone-else');
    expect(readGroupByStory()).toBe(false);
    localStorage.removeItem('kanbanActor');
    writeGroupByStory(false);
    expect(readGroupByStory()).toBe(false);
  });
});

describe('waitsWord', () => {
  it('says first for the first ticket with nothing to wait for', () => {
    const items = planOf([{ id: 'A', title: 'a' }]).items;
    expect(waitsWord(items[0], items)).toBe('first');
  });
});

describe('A child of a Story on the board', () => {
  it('carries one chip naming its Story and says what it waits for', () => {
    const parent = ticket({ id: 'KAN-301', type: 'story', title: 'Weather app' });
    const blocker = ticket({ id: 'KAN-305', parentId: 'KAN-301', status: 'in-progress' });
    const child = ticket({ id: 'KAN-306', parentId: 'KAN-301', blockedBy: ['KAN-305'], title: 'Offline message' });
    render(wrap(<TicketCard ticket={child} allTickets={[parent, blocker, child]} />));
    expect(screen.getByTitle('In the Story Weather app').textContent).toBe('KAN-301');
    expect(screen.getByTestId('card-waits-for').textContent).toBe('waits for KAN-305');
  });

  it('keeps the plain parent chip under a ticket that is not a Story', () => {
    const parent = ticket({ id: 'KAN-100', title: 'Parent' });
    const child = ticket({ id: 'KAN-101', parentId: 'KAN-100', blockedBy: ['KAN-102'] });
    render(wrap(<TicketCard ticket={child} allTickets={[parent, child]} />));
    expect(screen.getByTitle('Sub-ticket of KAN-100')).toBeTruthy();
    expect(screen.queryByTestId('card-waits-for')).toBeNull();
  });
});
