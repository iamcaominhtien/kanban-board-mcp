import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FlowEdge, FlowMap, Journey, Timeline, TimelineArrow, TimelineBar } from '../../types/aiTeam';
import { Swimlanes, TeamMap } from './FlowTab';
import { TimelineBody, arrowLabel } from './timelineDraw';
import { buildAxis } from './timelineLayout';

/**
 * A ticket on a workflow, as the server gives it: Triage, BA, Design skipped, Dev, the Checks send the Dev's work
 * back, QA, the Reviewer returns it once (round 1), and the Reviewer is working on what QA handed on.
 */
const ROLES = ['triage', 'ba', 'designer', 'dev', 'qa', 'reviewer'];
const T0 = new Date('2026-11-02T08:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60000).toISOString();

function edge(from: string, to: string, kind: FlowEdge['kind'], extra: Partial<FlowEdge> = {}): FlowEdge {
  return { from, to, kind, skipped: [], via: null, count: 1, waitS: 30, tickets: ['KAN-1'], live: false, ...extra };
}

function map(): FlowMap {
  return {
    range: '7d',
    since: at(-60),
    live: [],
    nodes: ROLES.map((id) => ({
      id,
      name: id[0].toUpperCase() + id.slice(1),
      color: '#2F6FB0',
      tickets: 1,
      avgRunS: 300,
      asked: 0,
      live: null,
      liveCount: 0,
      pauseTag: null,
      held: 0,
    })),
    edges: [
      edge('triage', 'ba', 'flow'),
      edge('ba', 'dev', 'skip', { skipped: ['Design'] }),
      edge('dev', 'dev', 'sent back', { via: 'checks' }),
      edge('dev', 'qa', 'flow', { count: 2 }),
      edge('qa', 'reviewer', 'flow', { live: true }),
      edge('reviewer', 'dev', 'returned'),
    ],
    tickets: 1,
    stats: {
      handoffs: 8,
      kinds: [{ kind: 'hand-off', count: 8 }],
      sentBack: 1,
      sentBackShare: 0.125,
      sentBackTo: [{ name: 'Dev', count: 1 }],
      pingPong: [],
      waitingShare: null,
      returned: 1,
    },
    picker: [],
  } as unknown as FlowMap;
}

describe('the Team map of a workflow', () => {
  const html = renderToStaticMarkup(<TeamMap map={map()} />);

  it('draws the skipped step in purple with its name', () => {
    expect(html).toContain('1 skip Design');
    expect(html).toMatch(/stroke="#7C5CD6"[^>]*marker-end="url\(#ahp\)"/);
  });

  it('draws the Checks sending the Dev’s work back as a red loop under the Dev', () => {
    const loop = /<g data-testid="map-loop-dev">([\s\S]*?)<\/g>/.exec(html)?.[1] ?? '';
    expect(loop).toContain('stroke="#C4432A"');
    expect(loop).toContain('stroke-dasharray="5 4"');
    expect(loop).toContain('1 back from checks');
  });

  it('draws the first review round going back brown dashed, not as a green hand-off back', () => {
    expect(html).toContain('1 returned');
    expect(html).not.toContain('hand-off back');
  });

  it('moves the edge of the hand-off under way, and only that one', () => {
    expect(html.match(/class="at-live-edge"/g)?.length).toBe(1);
    // QA to the Reviewer is adjacent: the straight arrow between their boxes moves
    expect(html).toMatch(/class="at-live-edge" marker-end="url\(#ah\)"/);
  });
});

function journey(): Journey {
  const lanes = ['triage', 'ba', 'dev', 'qa', 'reviewer'].map((id) => ({ id, name: id, color: '#2F6FB0' }));
  const bar = (runId: string, memberId: string, s: number, e: number, step: string) => ({
    runId,
    memberId,
    number: 1,
    state: 'finished',
    trigger: 'workflow',
    start: at(s),
    end: at(e),
    wait: null,
    summary: '',
    steps: 3,
    costUsd: null,
    tokens: 0,
    endedReason: null,
    files: 0,
    limitMin: null,
    step,
  });
  return {
    ticket: { id: 'KAN-1', title: 'x', status: 'review' },
    empty: false,
    start: at(0),
    end: at(100),
    lanes,
    bars: [
      bar('t1', 'triage', 0, 5, 'Triage'),
      bar('b1', 'ba', 10, 15, 'Spec'),
      bar('d1', 'dev', 20, 25, 'Build'),
      bar('d2', 'dev', 30, 35, 'Build'),
      bar('q1', 'qa', 40, 45, 'Test'),
      bar('r1', 'reviewer', 50, 55, 'Review'),
      bar('d3', 'dev', 60, 65, 'Build'),
    ],
    arrows: [
      { runId: 'b1', at: at(10), from: 'triage', to: 'ba', kind: 'hand-off', skipped: [], via: null },
      { runId: 'd1', at: at(20), from: 'ba', to: 'dev', kind: 'skip', skipped: ['Design'], via: null },
      { runId: 'd2', at: at(30), from: 'dev', to: 'dev', kind: 'sent back', skipped: [], via: 'checks' },
      { runId: 'q1', at: at(40), from: 'dev', to: 'qa', kind: 'hand-off', skipped: [], via: null },
      { runId: 'r1', at: at(50), from: 'qa', to: 'reviewer', kind: 'hand-off', skipped: [], via: null },
      { runId: 'd3', at: at(60), from: 'reviewer', to: 'dev', kind: 'returned', skipped: [], via: null },
    ],
    touches: [],
    docs: [],
  } as unknown as Journey;
}

describe('One ticket on a workflow', () => {
  const html = renderToStaticMarkup(<Swimlanes j={journey()} selected={null} onSelect={() => {}} />);

  it('draws a skipped step purple, a Checks send-back red and the first return brown', () => {
    expect(html).toMatch(/stroke="#7C5CD6"[^>]*data-testid="journey-arrow-skip"/);
    expect(html).toContain('<title>hand-off, skipped Design</title>');
    expect(html).toMatch(/stroke="#C4432A"[^>]*data-testid="journey-arrow-sent-back"/);
    expect(html).toContain('<title>sent back: the checks failed the work</title>');
    expect(html).toMatch(/stroke="#8A6A12"[^>]*data-testid="journey-arrow-returned"/);
  });

  it('draws no arrow from you: the board moved the ticket on', () => {
    // every arrow starts on an AI's lane; the You lane is the first one (y = 34 + 21)
    const starts = [...html.matchAll(/<path d="M[\d.]+ ([\d.]+)[^"]*"[^>]*data-testid="journey-arrow/g)];
    expect(starts).toHaveLength(6);
    for (const m of starts) expect(Number(m[1])).toBeGreaterThan(34 + 56);
  });

  it('says which step each run did', () => {
    expect(html).toContain('<title>dev #1 · Build</title>');
  });
});

describe('the Timeline of a workflow', () => {
  const bar = (id: string, member: string, s: number, e: number | null, state = 'finished') =>
    ({
      id,
      memberId: member,
      ticketId: 'KAN-1',
      number: 1,
      mode: 'work',
      state,
      trigger: 'workflow',
      autopilot: false,
      queuedAt: at(s),
      startedAt: state === 'queued' ? null : at(s),
      endedAt: e == null ? null : at(e),
      endKind: e == null ? null : 'ok',
      endedReason: null,
      endedBy: null,
      stopCode: null,
      peakRssMb: null,
      lastRssMb: null,
      restarts: [],
      steps: 3,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: null,
      costUsd: 0,
      metered: false,
      summary: '',
      question: null,
      paused: false,
      heldByPause: false,
      model: null,
    }) as TimelineBar;
  const arrow = (id: string, kind: TimelineArrow['kind'], from: string, to: string, s: number, e: number, x = {}) =>
    ({
      id,
      at: at(s),
      toAt: at(e),
      kind,
      from,
      to,
      ticketId: 'KAN-1',
      runId: id,
      waitS: 0,
      round: kind === 'sent_back' ? 1 : 0,
      label: null,
      count: 1,
      atLast: at(s),
      items: [],
      ...x,
    }) as TimelineArrow;
  const data = {
    range: 'today',
    since: at(-5),
    until: at(80),
    now: at(80),
    following: false,
    scope: { kind: 'ticket', ticketId: 'KAN-1' },
    lifelines: [
      { id: 'you', kind: 'you', name: 'You', color: '#1E2A22', state: null },
      ...['ba', 'dev', 'qa'].map((id) => ({ id, kind: 'ai', name: id, color: '#2F6FB0', state: 'idle' })),
    ],
    bars: [
      bar('b1', 'ba', 0, 10),
      bar('d1', 'dev', 12, 22),
      bar('d2', 'dev', 30, 40),
      bar('q1', 'qa', 70, null, 'queued'),
    ],
    arrows: [
      arrow('d1', 'skip', 'ba', 'dev', 10, 12, { skipped: ['Design'] }),
      arrow('d2', 'sent_back', 'dev', 'dev', 22, 30, { via: 'checks' }),
      arrow('q1', 'handoff', 'dev', 'qa', 40, 70),
    ],
    waits: [],
    touches: [],
    docs: [],
    pauses: [],
    pausedAll: false,
    pausedAt: null,
    pausedBy: null,
    live: [],
    density: [],
    truncated: false,
    lastEndedAt: null,
    tickets: {},
    autopilot: { on: false, delegate: null, graceMin: null },
  } as unknown as Timeline;
  const now = new Date(data.now).getTime();
  const html = renderToStaticMarkup(
    <TimelineBody
      data={data}
      axis={buildAxis(data, 'real', now)}
      lifelines={data.lifelines}
      now={now}
      detailed
      selected={null}
      onPick={() => {}}
      onHover={() => {}}
      hidden={new Set()}
      ticketOf={(id) => id ?? ''}
    />,
  );

  it('draws the skip and the Checks send-back, and moves the hand-off to the queued QA', () => {
    expect(html).toContain('data-testid="tl-arrow-skip"');
    expect(html).toContain('data-testid="tl-arrow-sent_back"');
    expect(html).toContain('data-testid="tl-underway"');
  });

  it('draws the Checks send-back down beside the Dev, from one run to the next', () => {
    const g = /<g data-testid="tl-arrow-sent_back"[\s\S]*?<path d="M([\d.]+) [\d.]+ L([\d.]+) [\d.]+"/.exec(html);
    expect(g).not.toBeNull();
    expect(g?.[1]).toBe(g?.[2]);
  });

  it('says what was skipped and who sent it back', () => {
    const [skip, back] = data.arrows;
    expect(arrowLabel(skip, () => '', 0)).toEqual({ text: 'skipped Design', important: true });
    expect(arrowLabel(back, () => '', 0).text).toBe('sent back by the checks');
  });
});
