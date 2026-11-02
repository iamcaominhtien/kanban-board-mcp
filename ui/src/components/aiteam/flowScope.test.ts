import { describe, expect, it } from 'vitest';
import { flowParams, withNodeTickets, type FlowCluster, type FlowStory, type ScopedFlowMap } from '../../api/aiTeam';
import {
  clusterRows,
  compactTickets,
  matches,
  pickerRows,
  scopeLevel,
  scopeUp,
  shareOf,
  storyLine,
  storyLook,
  ticketLine,
  type PickTicket,
} from './flowScope';
import { buildFlowLink, parseTimelineLink } from './timelineLink';

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
    version: 2,
    items: [
      { order: 1, ticketId: 'KAN-305', title: 'Save favourite cities', status: 'in-progress', after: [] },
      { order: 2, ticketId: 'KAN-306', title: 'Offline states', status: 'todo', after: ['KAN-305'] },
    ],
  },
  progress: { done: 3, total: 5, building: 1, waiting: 0 },
  interventions: { count: 1, needed: 1, avoidable: 0, byRule: 0 },
  handedAt: null,
  startedAt: null,
  closedAt: null,
  createdAt: null,
  ...o,
});

const ticket = (o: Partial<PickTicket> = {}): PickTicket => ({
  id: 'KAN-247',
  title: 'Fix scroll jump on drop',
  status: 'review',
  storyId: null,
  holder: 'Reviewer',
  step: null,
  completed: false,
  live: false,
  ...o,
});

const cluster = (o: Partial<FlowCluster> = {}): FlowCluster => ({
  storyId: 'KAN-301',
  title: 'Weather app',
  state: 'in_progress',
  done: 3,
  total: 5,
  tickets: 5,
  handoffs: 9,
  edges: [{ from: 'dev', to: 'qa', kind: 'flow', count: 2 }],
  ...o,
});

describe('the scope', () => {
  it('has three levels and goes up one at a time', () => {
    expect(scopeLevel({ story: null, ticket: null })).toBe('project');
    expect(scopeLevel({ story: 'KAN-301', ticket: null })).toBe('story');
    expect(scopeLevel({ story: 'KAN-301', ticket: 'KAN-305' })).toBe('ticket');
    expect(scopeUp({ story: 'KAN-301', ticket: 'KAN-305' })).toEqual({ story: 'KAN-301', ticket: null });
    expect(scopeUp({ story: null, ticket: 'KAN-247' })).toEqual({ story: null, ticket: null });
    expect(scopeUp({ story: 'KAN-301', ticket: null })).toEqual({ story: null, ticket: null });
  });

  it('asks the map for a range only when one was picked, and for the narrowest scope', () => {
    expect(flowParams('7d')).toEqual({ range: '7d' });
    expect(flowParams(null, { story: 'KAN-301' })).toEqual({ story: 'KAN-301' });
    expect(flowParams('today', { story: 'KAN-301', ticket: 'KAN-305' })).toEqual({ range: 'today', ticket: 'KAN-305' });
  });

  it('keeps a Story-level node’s ticket list apart from the count', () => {
    const map = withNodeTickets({
      nodes: [
        { id: 'dev', tickets: ['KAN-302', 'KAN-303'] },
        { id: 'pm', tickets: 4 },
      ],
    } as unknown as ScopedFlowMap);
    expect(map.nodes[0]).toMatchObject({ tickets: 2, ticketIds: ['KAN-302', 'KAN-303'] });
    expect(map.nodes[1]).toMatchObject({ tickets: 4 });
    expect(map.nodes[1].ticketIds).toBeUndefined();
  });

  it('puts the scope and the view on the address, and reads them back', () => {
    const url = buildFlowLink(
      'p1',
      { story: 'KAN-301', ticket: null, view: 'timeline' },
      { href: 'http://127.0.0.1:5173/?ticket=KAN-9' },
    );
    const u = new URL(url);
    expect(u.searchParams.get('story')).toBe('KAN-301');
    expect(u.searchParams.get('view')).toBe('timeline');
    expect(u.searchParams.get('proj')).toBe('p1');
    expect(parseTimelineLink(u.search)).toEqual({ flow: { story: 'KAN-301', ticket: null, view: 'timeline' } });
    // the ticket of the scope never collides with the ticket modal's ?ticket=
    const t = new URL(buildFlowLink('p1', { story: null, ticket: 'KAN-305', view: 'map' }, { href: u.toString() }));
    expect(t.searchParams.get('flow_ticket')).toBe('KAN-305');
    expect(t.searchParams.get('story')).toBeNull();
    expect(parseTimelineLink(t.search)?.flow).toEqual({ story: null, ticket: 'KAN-305', view: 'map' });
  });
});

describe('the picker', () => {
  it('matches codes and words', () => {
    expect(matches('weather', 'KAN-301', 'Weather app')).toBe(true);
    expect(matches('kan301', 'KAN-301', 'Weather app')).toBe(true);
    expect(matches('kan-30', 'KAN-301')).toBe(true);
    expect(matches('weather app', 'KAN-301', 'Weather for the app')).toBe(true);
    expect(matches('mobile', 'KAN-301', 'Weather app')).toBe(false);
  });

  it('lists the Stories that run first, then the recent tickets, the live ones first', () => {
    const rows = pickerRows(
      '',
      [
        story({ id: 'KAN-270', state: 'done' }),
        story(),
        story({ id: 'KAN-288', blocked: { kind: 'approval', text: 'waiting for you', ticketId: null } }),
      ],
      [ticket(), ticket({ id: 'KAN-305', live: true, storyId: 'KAN-301' })],
    );
    expect(rows.map((r) => (r.kind === 'story' ? r.story.id : r.ticket.id))).toEqual([
      'KAN-288',
      'KAN-301',
      'KAN-305',
      'KAN-247',
    ]);
  });

  it('finds a done Story once something is typed', () => {
    const rows = pickerRows('short', [story({ id: 'KAN-270', title: 'Keyboard shortcuts', state: 'done' })], []);
    expect(rows).toHaveLength(1);
  });

  it('says where a ticket is and who holds it', () => {
    expect(ticketLine(ticket({ storyId: 'KAN-301', holder: 'Dev', step: 'Build' }))).toBe('in KAN-301 · Dev · Build');
    expect(ticketLine(ticket())).toBe('no Story · Reviewer');
    expect(storyLine(story())).toBe('3 of 5 done · PM Linh · 1 time you stepped in');
    expect(storyLine(story({ blocked: { kind: 'question', text: '', ticketId: null } }))).toBe(
      '3 of 5 done · waiting for you',
    );
  });
});

describe('Stories as clusters', () => {
  it('draws the state of a Story as its card does', () => {
    expect(storyLook('in_progress').label).toBe('In progress');
    expect(storyLook('in_progress', { blocked: true }).label).toBe('Blocked');
    expect(storyLook('planning', { planWaiting: true }).label).toBe('Plan needs you');
    expect(storyLook('done', { blocked: true }).label).toBe('Done');
  });

  it('sorts by activity with the done ones last, or by state, and keeps the tickets in no Story apart', () => {
    const cs = [
      cluster({ storyId: 'A', handoffs: 2 }),
      cluster({ storyId: 'B', handoffs: 20, state: 'done' }),
      cluster({ storyId: 'C', handoffs: 9 }),
      cluster({ storyId: null, handoffs: 11 }),
    ];
    const byActivity = clusterRows(cs, [], 'activity');
    expect(byActivity.rows.map((r) => r.cluster.storyId)).toEqual(['C', 'A', 'B']);
    expect(byActivity.rows[2].done).toBe(true);
    expect(byActivity.loose?.handoffs).toBe(11);
    const blocked = story({ id: 'A', blocked: { kind: 'quota', text: 'quota', ticketId: null } });
    expect(clusterRows(cs, [blocked], 'state').rows.map((r) => r.cluster.storyId)).toEqual(['A', 'C', 'B']);
  });

  it('counts a cluster’s share of an arrow', () => {
    const c = cluster();
    expect(shareOf(c, { from: 'dev', to: 'qa', kind: 'flow' })).toBe(2);
    expect(shareOf(c, { from: 'dev', to: 'qa', kind: 'sent back' })).toBe(0);
    expect(shareOf(null, { from: 'dev', to: 'qa', kind: 'flow' })).toBe(0);
  });

  it('writes the tickets of a box once with their prefix', () => {
    expect(compactTickets(['KAN-302', 'KAN-303', 'MOB-4', 'MOB-5']).map((t) => t.text)).toEqual([
      'KAN-302',
      '303',
      'MOB-4',
      '5',
    ]);
  });
});
