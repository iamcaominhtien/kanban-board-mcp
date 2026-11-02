// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowCluster, FlowStory, ScopedFlowMap, ScopedTimeline } from '../../api/aiTeam';
import type { ViewStep, WorkflowView } from '../../types/aiWorkflow';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { ToastProvider } from '../Toast';
import { FlowTab, TeamMap } from './FlowTab';
import { ScopeBar } from './ScopeBar';
import { StoryClusters } from './StoryClusters';
import { StoryMap } from './StoryMap';
import { StoryTimelineView } from './StoryTimeline';
import { WorkflowStrip } from './WorkflowStrip';
import type { FlowScope } from './flowScope';

const T0 = Date.parse('2026-11-02T09:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const node = (id: string, name: string, o: Partial<ScopedFlowMap['nodes'][number]> = {}) => ({
  id,
  name,
  color: '#2E6F40',
  tickets: 1,
  avgRunS: 300,
  asked: 0,
  live: null,
  liveCount: 0,
  pauseTag: null,
  held: 0,
  ...o,
});
const edge = (from: string, to: string, kind: string, count = 1) => ({
  from,
  to,
  kind,
  count,
  skipped: [],
  via: null,
  waitS: 60,
  tickets: [],
  live: false,
});

const story = (o: Partial<FlowStory> = {}): FlowStory => ({
  id: 'KAN-301',
  projectId: 'p1',
  title: 'Weather app, web version',
  state: 'in_progress',
  blocked: null,
  planWaiting: false,
  paused: false,
  pm: { id: 'pm', name: 'PM Linh', color: '#2F6FB0' },
  plan: {
    version: 1,
    items: [
      { order: 1, ticketId: 'KAN-302', title: 'Search a city', status: 'done', after: [] },
      { order: 2, ticketId: 'KAN-305', title: 'Favourite cities', status: 'in-progress', after: [] },
      { order: 3, ticketId: 'KAN-306', title: 'Offline states', status: 'todo', after: ['KAN-305'] },
    ],
  },
  progress: { done: 1, total: 3, building: 1, waiting: 0 },
  interventions: { count: 1, needed: 1, avoidable: 0, byRule: 0 },
  handedAt: at(0),
  startedAt: at(0),
  closedAt: null,
  createdAt: at(0),
  ...o,
});

function projectMap(): ScopedFlowMap {
  return {
    range: '7d',
    since: at(-600),
    live: [],
    nodes: [node('pm', 'PM'), node('dev', 'Dev'), node('qa', 'Tester')],
    edges: [edge('pm', 'dev', 'flow', 12), edge('dev', 'qa', 'flow', 16), edge('qa', 'dev', 'sent back', 6)],
    tickets: 18,
    stats: {
      handoffs: 34,
      kinds: [{ kind: 'hand-off', count: 34 }],
      sentBack: 6,
      sentBackShare: 0.18,
      sentBackTo: [],
      pingPong: [],
      waitingShare: 0.06,
      returned: 0,
    },
    picker: [
      {
        id: 'KAN-305',
        title: 'Save favourite cities',
        status: 'in-progress',
        elapsedS: 600,
        touches: 0,
        bounced: 0,
        costUsd: 0.4,
        completed: false,
        live: [],
      },
    ],
    clusters: [
      {
        storyId: 'KAN-301',
        title: 'Weather app',
        state: 'in_progress',
        done: 1,
        total: 3,
        tickets: 3,
        handoffs: 4,
        edges: [{ from: 'pm', to: 'dev', kind: 'flow', count: 2 }],
      },
      { storyId: null, title: '', state: null, done: 0, total: 0, tickets: 4, handoffs: 11, edges: [] },
    ],
    folded: { count: 3, edges: [edge('pm', 'qa', 'flow', 3)] },
  } as unknown as ScopedFlowMap;
}

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});
afterEach(() => cleanup());

describe('the project map with Stories (H, H2)', () => {
  it('draws a hovered Story’s share of each arrow in dark blue and dims the arrows it has no part in', () => {
    const map = projectMap();
    const { container } = render(<TeamMap map={map} share={map.clusters![0]} />);
    const mine = container.querySelector('[data-testid="map-edge-pm-dev"]')!;
    expect(mine.textContent).toContain('2 of 12');
    expect(mine.getAttribute('opacity')).toBe('1');
    expect(container.querySelector('[data-testid="map-edge-dev-qa"]')!.getAttribute('opacity')).toBe('0.35');
  });

  it('draws nothing dimmed without a hovered Story', () => {
    const { container } = render(<TeamMap map={projectMap()} />);
    expect(container.querySelector('[data-testid="map-edge-dev-qa"]')!.getAttribute('opacity')).toBeNull();
    expect(container.querySelector('[data-testid="map-edge-dev-qa"]')!.textContent).toContain('16');
  });

  it('lists the Stories, hovers and opens one, and keeps the tickets in no Story dashed', () => {
    const map = projectMap();
    const hover = vi.fn();
    const open = vi.fn();
    render(<StoryClusters clusters={map.clusters!} stories={[story()]} hovered={null} onHover={hover} onOpen={open} />);
    const card = screen.getByTestId('cluster-KAN-301');
    expect(card.textContent).toContain('Weather app, web version');
    expect(card.textContent).toContain('In progress');
    expect(card.textContent).toContain('1 of 3');
    fireEvent.mouseEnter(card);
    expect(hover).toHaveBeenCalledWith(map.clusters![0]);
    fireEvent.click(card);
    expect(open).toHaveBeenCalledWith('KAN-301');
    expect(screen.getByTestId('cluster-loose').textContent).toContain('4 tickets · 11 hand-offs');
  });

  it('folds a busy range: the done Stories into one line, the rest that run behind "show all"', () => {
    const many: FlowCluster[] = Array.from({ length: 8 }, (_, n) => ({
      storyId: `KAN-${n}`,
      title: `Story ${n}`,
      state: n < 3 ? 'done' : 'in_progress',
      done: 1,
      total: 2,
      tickets: 2,
      handoffs: 10 - n,
      edges: [],
    }));
    render(<StoryClusters clusters={many} stories={[]} hovered={null} onHover={() => {}} onOpen={() => {}} />);
    expect(screen.getByTestId('clusters-done').textContent).toContain('3 Stories done');
    expect(screen.getByTestId('clusters-more').textContent).toContain('2 more running');
    expect(screen.getAllByTestId(/^cluster-KAN-/)).toHaveLength(3);
    fireEvent.click(screen.getByTestId('clusters-more'));
    expect(screen.getAllByTestId(/^cluster-KAN-/)).toHaveLength(5);
    fireEvent.click(screen.getByText('By state'));
    fireEvent.click(screen.getByTestId('clusters-done'));
    expect(screen.getAllByTestId(/^cluster-KAN-/)).toHaveLength(8);
  });
});

describe('the Story map (I)', () => {
  const map = {
    ...projectMap(),
    nodes: [
      node('pm', 'PM', { hub: true, color: '#2F6FB0', asked: 1 }),
      node('dev', 'Dev', {
        ticketIds: ['KAN-302', 'KAN-305'],
        liveTicket: 'KAN-305',
        live: { state: 'working', ticketId: 'KAN-305' } as never,
      }),
      node('rv', 'Reviewer', { ticketIds: ['KAN-302'] }),
    ],
    edges: [
      edge('pm', 'dev', 'plan', 2),
      edge('pm', 'rv', 'plan', 1),
      edge('dev', 'rv', 'flow', 2),
      edge('rv', 'pm', 'report back', 1),
      edge('rv', 'dev', 'returned', 1),
    ],
  } as unknown as ScopedFlowMap;

  it('puts the PM at the hub, the plan’s arrows to each AI, the hand-offs, the reports and the returns', () => {
    const openTicket = vi.fn();
    render(
      <StoryMap
        map={map}
        pmId="pm"
        story={story()}
        decisions={[{ id: 'd1', at: at(1), kind: 'approve_design', title: 'x', ticketId: null, state: 'in_effect' }]}
        onOpenTicket={openTicket}
      />,
    );
    const pm = screen.getByTestId('story-pm');
    expect(pm.textContent).toContain('3 tickets planned');
    expect(pm.textContent).toContain('decided 1 for you');
    expect(pm.textContent).toContain('reports back: 1');
    expect(pm.textContent).toContain('asked you: 1');
    expect(screen.getByTestId('story-spoke-dev').textContent).toBe('from plan 2');
    expect(screen.getByText('2 hand-offs')).toBeTruthy();
    expect(screen.getByText('report back 1')).toBeTruthy();
    expect(screen.getByTestId('story-arc-returned').textContent).toContain('review round 1');
    const dev = screen.getByTestId('story-node-dev');
    expect(dev.className).toContain('live');
    const chip = within(dev).getByRole('button', { name: '305' });
    expect(chip.className).toContain('live');
    fireEvent.click(chip);
    expect(openTicket).toHaveBeenCalledWith('KAN-305');
  });

  it('lights up the box a feed line came from', () => {
    render(
      <StoryMap map={map} pmId="pm" story={null} lit={{ memberId: 'rv', ticketId: null }} onOpenTicket={() => {}} />,
    );
    expect(screen.getByTestId('story-node-rv').className).toContain('lit');
  });
});

describe('the Timeline inside a Story (I2)', () => {
  const data = {
    since: at(0),
    until: at(240),
    now: at(200),
    following: true,
    lifelines: [
      { id: 'pm', kind: 'ai', name: 'PM', color: '#2F6FB0', state: 'idle' },
      { id: 'dev', kind: 'ai', name: 'Dev', color: '#2E6F40', state: 'working' },
    ],
    bars: [
      { id: 'r1', memberId: 'pm', ticketId: 'KAN-301', startedAt: at(0), endedAt: at(20), state: 'finished' },
      { id: 'r2', memberId: 'dev', ticketId: 'KAN-302', startedAt: at(20), endedAt: at(80), state: 'finished' },
      { id: 'r3', memberId: 'dev', ticketId: 'KAN-302', startedAt: at(90), endedAt: at(120), state: 'finished' },
      { id: 'r4', memberId: 'dev', ticketId: 'KAN-305', startedAt: at(130), endedAt: null, state: 'running' },
    ],
    waits: [{ id: 'w1', memberId: 'dev', ticketId: 'KAN-302', from: at(80), to: at(90), text: 'a question' }],
    touches: [{ id: 't1', at: at(85), ticketId: 'KAN-302', mark: 'needed', what: 'Answered', who: 'You' }],
    decisions: [{ at: at(30), kind: 'approve_design', title: 'Approved the design', ticketId: 'KAN-302' }],
    rows: [
      { ticketId: 'KAN-302', title: 'Search a city', status: 'done' },
      { ticketId: 'KAN-305', title: 'Favourite cities', status: 'in-progress' },
      { ticketId: 'KAN-306', title: 'Offline states', status: 'todo' },
    ],
    live: [{ runId: 'r4', memberId: 'dev', memberName: 'Dev', ticketId: 'KAN-305', state: 'working' }],
    tickets: {},
  } as unknown as ScopedTimeline;

  it('draws a row per ticket under the PM, bars by the AI, waits, diamonds and the now line', () => {
    const openRun = vi.fn();
    const hover = vi.fn();
    render(
      <StoryTimelineView
        data={data}
        storyId="KAN-301"
        story={story()}
        onOpenTicket={() => {}}
        onOpenRun={openRun}
        onHover={hover}
      />,
    );
    expect(screen.getByTestId('story-row-pm').textContent).toContain('plans, decides, closes');
    expect(screen.getAllByTestId('story-decision')).toHaveLength(1);
    expect(screen.getAllByTestId('story-touch')).toHaveLength(1);
    expect(screen.getByTestId('story-row-KAN-305').textContent).toContain('Dev is building');
    expect(screen.getByTestId('story-row-KAN-306').textContent).toContain('waits for KAN-305');
    const bars = within(screen.getByTestId('story-row-KAN-302')).getAllByTestId('story-bar');
    expect(bars.map((b) => b.textContent)).toEqual(['Dev', 'Dev #2']);
    fireEvent.click(bars[1]);
    expect(openRun).toHaveBeenCalledWith('r3');
    fireEvent.mouseEnter(bars[0]);
    expect(hover).toHaveBeenCalledWith({ memberId: 'dev', ticketId: 'KAN-302' });
    expect(screen.getByTestId('story-now')).toBeTruthy();
  });
});

describe('the workflow strip of a ticket (J)', () => {
  const step = (idx: number, key: string, label: string, o: Partial<ViewStep> = {}): ViewStep => ({
    id: `s${idx}`,
    idx,
    key,
    label,
    kind: 'ai',
    role: null,
    state: 'pending',
    attempt: 1,
    memberId: null,
    memberName: null,
    runId: null,
    note: null,
    noteIn: null,
    outcome: null,
    result: null,
    startedAt: null,
    endedAt: null,
    ...o,
  });
  const view = {
    templateName: 'Feature with a UI',
    reviewDepth: 'standard',
    steps: [
      step(0, 'triage', 'Triage', { role: 'triage', state: 'done', note: 'Chose this workflow' }),
      step(1, 'approve', 'Approve design', {
        kind: 'person',
        state: 'done',
        memberName: 'The PM',
        outcome: 'approved',
      }),
      step(2, 'build', 'Build', { role: 'dev', state: 'active', attempt: 2, startedAt: new Date().toISOString() }),
      step(3, 'checks', 'Checks', { kind: 'code' }),
      step(4, 'review', 'Review', { role: 'reviewer', state: 'done', outcome: 'changes' }),
      step(5, 'done', 'Done', { kind: 'person' }),
    ],
  } as unknown as WorkflowView;

  it('shows each step with who holds it, the approval as its own step, and the return as a brown arc', () => {
    render(<WorkflowStrip view={view} />);
    expect(screen.getByTestId('wf-step-approve').textContent).toContain('a person');
    expect(screen.getByTestId('wf-step-approve').textContent).toContain('The PM approved for you');
    expect(screen.getByTestId('wf-step-build').className).toContain('active');
    expect(screen.getByTestId('wf-step-build').textContent).toContain('Run 2');
    expect(screen.getByTestId('wf-step-checks').textContent).toContain('Lint, types, tests');
    expect(screen.getByTestId('wf-step-done').textContent).toContain('You move it');
    expect(screen.getByTestId('wf-return').textContent).toBe('returned in review round 1 (normal)');
  });
});

describe('the scope bar (G)', () => {
  function setup(scope: FlowScope, extra: Partial<Parameters<typeof ScopeBar>[0]> = {}) {
    const onScope = vi.fn();
    const onView = vi.fn();
    wrap(
      <ScopeBar
        projectName="Kanban Board"
        scope={scope}
        storyTitle="Weather app, web version"
        ticketTitle="Save favourite cities"
        view="map"
        onView={onView}
        onScope={onScope}
        hint="5 tickets in this Story"
        stories={[story(), story({ id: 'KAN-270', title: 'Keyboard shortcuts', state: 'done' })]}
        tickets={[
          {
            id: 'KAN-305',
            title: 'Save favourite cities',
            status: 'in-progress',
            storyId: 'KAN-301',
            holder: 'Dev',
            step: 'Build',
            completed: false,
            live: true,
          },
        ]}
        link="http://x/?aiteam=flow"
        {...extra}
      />,
    );
    return { onScope, onView };
  }

  it('is a breadcrumb: every part but the last goes up', () => {
    const { onScope } = setup({ story: 'KAN-301', ticket: 'KAN-305' });
    const bar = screen.getByTestId('scope-bar');
    expect(bar.textContent).toContain('Kanban Board');
    expect(bar.textContent).toContain('KAN-301');
    expect(bar.textContent).toContain('Save favourite cities');
    fireEvent.click(screen.getByTitle('The Story KAN-301'));
    expect(onScope).toHaveBeenLastCalledWith({ story: 'KAN-301', ticket: null });
    fireEvent.click(screen.getByTitle('The whole project'));
    expect(onScope).toHaveBeenLastCalledWith({ story: null, ticket: null });
    expect(screen.getByText('Save favourite cities').closest('[aria-current]')).toBeTruthy();
  });

  it('opens the picker on "/", searches, and opens the Story with Enter', () => {
    const { onScope } = setup({ story: null, ticket: null });
    fireEvent.keyDown(window, { key: '/' });
    const picker = screen.getByTestId('scope-picker');
    expect(picker.textContent).toContain('Stories running now');
    expect(picker.textContent).toContain('Recent tickets');
    expect(picker.textContent).not.toContain('Keyboard shortcuts');
    const input = within(picker).getByLabelText('Find a Story or ticket');
    fireEvent.change(input, { target: { value: 'weather' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onScope).toHaveBeenCalledWith({ story: 'KAN-301', ticket: null });
    expect(screen.queryByTestId('scope-picker')).toBeNull();
  });

  it('a ticket inside a Story opens with its Story in the crumb', () => {
    const { onScope } = setup({ story: null, ticket: null });
    fireEvent.click(screen.getByTestId('scope-picker-btn'));
    fireEvent.click(screen.getByRole('option', { name: /KAN-305/ }));
    expect(onScope).toHaveBeenCalledWith({ story: 'KAN-301', ticket: 'KAN-305' });
  });

  it('"[" goes up a level and "]" goes into what is hovered, never while typing', () => {
    const { onScope } = setup(
      { story: 'KAN-301', ticket: 'KAN-305' },
      { hovered: { story: 'KAN-301', ticket: 'KAN-302' } },
    );
    fireEvent.keyDown(window, { key: '[' });
    expect(onScope).toHaveBeenLastCalledWith({ story: 'KAN-301', ticket: null });
    fireEvent.keyDown(window, { key: ']' });
    expect(onScope).toHaveBeenLastCalledWith({ story: 'KAN-301', ticket: 'KAN-302' });
    onScope.mockClear();
    const field = document.createElement('input');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: '[' });
    expect(onScope).not.toHaveBeenCalled();
    field.remove();
  });
});

describe('FlowTab by scope', () => {
  beforeEach(() => {
    http.get.mockImplementation(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      if (url === '/projects/p1/stories') return { data: [story()] };
      if (url === '/projects/p1/ai/team/flow') {
        if (cfg?.params?.story) {
          return {
            data: {
              ...projectMap(),
              nodes: [
                node('pm', 'PM', { hub: true, tickets: ['KAN-302'] as never }),
                node('dev', 'Dev', { tickets: ['KAN-302'] as never }),
              ],
              edges: [edge('pm', 'dev', 'plan', 1)],
              tickets: 3,
              clusters: [],
              scope: {
                level: 'story',
                story: { id: 'KAN-301', title: 'Weather app, web version', state: 'in_progress' },
                ticket: null,
              },
            },
          };
        }
        return { data: projectMap() };
      }
      if (url === '/stories/KAN-301') return { data: { ...story(), decisions: [] } };
      if (url === '/projects/p1/ai/live-feed') return { data: { items: [], cursor: 'c', working: [], needsYou: [] } };
      throw new Error(`unexpected ${url}`);
    });
  });

  function flow(scope: FlowScope) {
    const onScope = vi.fn();
    const openStory = vi.fn();
    wrap(
      <FlowTab
        projectId="p1"
        projectName="Kanban Board"
        range={scope.story ? null : '7d'}
        scope={scope}
        view="map"
        onScope={onScope}
        onView={() => {}}
        actions={{ onOpenTicket: () => {}, onOpenDocsPage: () => {}, onOpenStory: openStory }}
      />,
    );
    return { onScope, openStory };
  }

  it('the project map lists the Stories under it; a click opens the Story scope', async () => {
    const { onScope } = flow({ story: null, ticket: null });
    const card = await screen.findByTestId('cluster-KAN-301');
    expect(screen.getByTestId('scope-bar').textContent).toContain(
      '18 tickets with AI work in the last 7 days, in 1 Story',
    );
    fireEvent.mouseEnter(card);
    expect(screen.getByTestId('map-against').textContent).toContain('Showing KAN-301 against the rest');
    fireEvent.click(card);
    expect(onScope).toHaveBeenCalledWith({ story: 'KAN-301', ticket: null });
    expect(screen.getByTestId('map-folded').textContent).toContain('+ 3 smaller hand-offs');
  });

  it('the Story scope draws the PM hub, asks for the Story, and the feed follows it', async () => {
    const { openStory } = flow({ story: 'KAN-301', ticket: null });
    await screen.findByTestId('story-map');
    expect(screen.getByTestId('story-spoke-dev').textContent).toBe('from plan 1');
    await waitFor(() => expect(screen.getByTestId('live-feed-scope').textContent).toContain('Story KAN-301'));
    const feedCalls = http.get.mock.calls.filter((c) => c[0] === '/projects/p1/ai/live-feed');
    expect(feedCalls.every((c) => c[1]?.params?.story === 'KAN-301')).toBe(true);
    const mapCall = http.get.mock.calls.find((c) => c[0] === '/projects/p1/ai/team/flow' && c[1]?.params?.story);
    expect(mapCall?.[1]?.params).toEqual({ story: 'KAN-301' });
    fireEvent.click(screen.getByRole('button', { name: /Open the Story page/ }));
    expect(openStory).toHaveBeenCalledWith('KAN-301');
  });
});
