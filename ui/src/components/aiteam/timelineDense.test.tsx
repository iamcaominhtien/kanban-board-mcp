import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ArrowKind, Timeline, TimelineArrow, TimelineBar, TimelineLifeline } from '../../types/aiTeam';
import { TimelineBody } from './timelineDraw';
import { buildAxis, type AxisMode } from './timelineLayout';
import { labelBox, overlap, type Anchor, type Box } from './timelinePlace';

/**
 * A synthetic dense stretch, like the live data that went wrong: five AIs hand work back and forth, report back,
 * ask for a permission that Autopilot decides, return and send back, all within a few minutes, some at the same
 * second, and one AI running two runs at once. Whatever the placer decides, no label may cover another label, a
 * run's bar or an arrow's badge.
 */
const T0 = new Date('2026-10-31T01:35:00').getTime();
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const AIS = ['pm', 'ba', 'rv', 'ds', 'dv'];

function bar(id: string, member: string, from: number, to: number, ticket = 'AGT-4', extra: Partial<TimelineBar> = {}) {
  return {
    id,
    memberId: member,
    ticketId: ticket,
    number: 1,
    mode: 'work',
    state: 'finished',
    trigger: 'handoff',
    autopilot: false,
    queuedAt: at(from),
    startedAt: at(from),
    endedAt: at(to),
    endKind: 'ok',
    endedReason: null,
    endedBy: null,
    stopCode: null,
    peakRssMb: null,
    lastRssMb: null,
    restarts: [],
    steps: 12,
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
    ...extra,
  } as TimelineBar;
}

function arrow(
  id: string,
  kind: ArrowKind,
  from: string,
  to: string,
  s: number,
  run: string | null,
  extra: Partial<TimelineArrow> = {},
) {
  return {
    id,
    at: at(s),
    toAt: at(s),
    kind,
    from,
    to,
    ticketId: 'AGT-4',
    runId: run,
    waitS: 0,
    round: kind === 'sent_back' ? 1 : 0,
    label: null,
    count: 1,
    atLast: at(s),
    items: [],
    ...extra,
  } as TimelineArrow;
}

function dense(): Timeline {
  const bars: TimelineBar[] = [
    bar('r1', 'pm', 0, 24, 'AGT-3'),
    bar('r2', 'ba', 17, 294),
    bar('r3', 'pm', 52, 62),
    bar('r4', 'pm', 66, 120, 'AGT-3'),
    bar('r5', 'pm', 80, 140), // runs while r4 runs: side by side
    bar('r6', 'rv', 120, 300),
    bar('r7', 'ds', 140, 200, 'AGT-5'),
    bar('r8', 'ba', 300, 360, 'AGT-5'),
    bar('r9', 'pm', 300, 310, 'AGT-5', { autopilot: true, trigger: 'autopilot' }),
    bar('r10', 'dv', 305, 400, 'AGT-5', { endKind: 'failed' }),
    bar('r11', 'ds', 330, 420, 'AGT-5'),
  ];
  const arrows: TimelineArrow[] = [
    arrow('r1', 'assign', 'you', 'pm', 0, 'r1'),
    arrow('r2', 'handoff', 'pm', 'ba', 17, 'r2'),
    arrow('d1', 'doc', 'ba', 'docs', 30, null, { label: 'Product Brief and Requirements' }),
    arrow('p1', 'perm', 'ba', 'you', 40, 'r2', { label: 'Update AGT-4: assignee to Reviewer' }),
    arrow('a1', 'auto', 'autopilot', 'ba', 62, 'r2', { by: 'PM Mai', waitS: 127, label: 'low risk' }),
    arrow('r4', 'report', 'ba', 'pm', 66, 'r4'),
    arrow('r5', 'mention', 'ba', 'pm', 80, 'r5'),
    arrow('r6', 'handoff', 'pm', 'rv', 120, 'r6'),
    arrow('r7', 'handoff', 'pm', 'ds', 140, 'r7'),
    arrow('x1', 'report', 'pm', 'ba', 140, null),
    arrow('r8', 'returned', 'rv', 'ba', 300, 'r8'),
    arrow('m1', 'mention', 'rv', 'pm', 300, 'r9'),
    arrow('p2', 'perm', 'rv', 'you', 302, 'r6', { label: 'ticket items: work log.add AGT-4' }),
    arrow('a2', 'auto', 'autopilot', 'rv', 305, 'r6', { by: 'PM Mai', waitS: 30 }),
    arrow('r10', 'handoff', 'pm', 'dv', 305, 'r10'),
    arrow('s1', 'sent_back', 'dv', 'ds', 330, 'r11'),
    arrow('r11', 'report', 'dv', 'ba', 330, null),
  ];
  const lifelines: TimelineLifeline[] = [
    { id: 'you', kind: 'you', name: 'You', color: '#1E2A22', state: null },
    { id: 'autopilot', kind: 'autopilot', name: 'Autopilot', color: '#7C5CD6', delegate: 'PM Mai', state: null },
    ...AIS.map((id) => ({ id, kind: 'ai' as const, name: id.toUpperCase(), color: '#2F6FB0', state: 'idle' as const })),
    { id: 'docs', kind: 'docs', name: 'Docs', color: '#9AA8A0', state: null },
  ];
  return {
    range: 'today',
    since: at(-60),
    until: at(480),
    now: at(480),
    following: false,
    scope: { kind: 'team', ticketId: null },
    lifelines,
    bars,
    arrows,
    waits: [
      {
        id: 'w1',
        memberId: 'ba',
        ticketId: 'AGT-4',
        runId: 'r2',
        kind: 'approval',
        from: at(40),
        to: at(62),
        text: 'x',
      },
    ],
    touches: [
      { id: 't1', at: at(5), ticketId: 'AGT-4', mark: 'needed', what: 'Changed settings', who: 'you', via: null },
      { id: 't2', at: at(6), ticketId: 'AGT-4', mark: 'needed', what: 'Stopped a run', who: 'you', via: null },
    ],
    docs: [],
    pauses: [{ from: at(150), to: at(290), by: 'user', reason: null, resumedBy: 'user' }],
    pausedAll: false,
    pausedAt: null,
    pausedBy: null,
    live: [],
    density: [],
    truncated: false,
    lastEndedAt: null,
    tickets: {},
    autopilot: { on: true, delegate: 'PM Mai', graceMin: 0 },
  } as Timeline;
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The labels, bars and badges of a rendered diagram, as boxes. */
function boxes(html: string) {
  const labels: { text: string; box: Box }[] = [];
  const group = /<g data-testid="tl-labels">([\s\S]*?)<\/g>/.exec(html)?.[1] ?? '';
  for (const m of group.matchAll(/<text([^>]*)>([\s\S]*?)<\/text>/g)) {
    const text = m[2].replace(/<title>[\s\S]*?<\/title>/, '').replace(/&amp;/g, '&');
    const spot = {
      x: Number(attr(m[1], 'x')),
      y: Number(attr(m[1], 'y')),
      anchor: attr(m[1], 'text-anchor') as Anchor,
    };
    labels.push({
      text,
      box: labelBox(text, spot, Number(attr(m[1], 'font-size')), Number(attr(m[1], 'font-weight'))),
    });
  }
  const bars: Box[] = [];
  for (const m of html.matchAll(
    /data-testid="tl-bar-[^"]+"[^>]*>([\s\S]*?)(?=data-testid="tl-(?:bar|wait|arrow|labels|now))/g,
  ))
    for (const r of m[1].matchAll(/<rect([^>]*?)\/?>/g)) {
      if (attr(r[1], 'class') === 'tl-flash' || attr(r[1], 'opacity')) continue;
      bars.push({
        x: Number(attr(r[1], 'x')),
        y: Number(attr(r[1], 'y')),
        w: Number(attr(r[1], 'width')),
        h: Number(attr(r[1], 'height')),
      });
    }
  const badges: Box[] = [];
  for (const m of html.matchAll(/<circle([^>]*?)\/?>/g)) {
    const r = Number(attr(m[1], 'r'));
    if (r !== 7.5 && r !== 8.5) continue;
    const x = Number(attr(m[1], 'cx'));
    const y = Number(attr(m[1], 'cy'));
    badges.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
  }
  return { labels, bars, badges };
}

function render(detailed: boolean, mode: AxisMode) {
  const data = dense();
  const now = new Date(data.now).getTime();
  return renderToStaticMarkup(
    <TimelineBody
      data={data}
      axis={buildAxis(data, mode, now)}
      lifelines={data.lifelines}
      now={now}
      detailed={detailed}
      selected={null}
      onPick={() => {}}
      onHover={() => {}}
      hidden={new Set()}
      ticketOf={(id) => id ?? ''}
    />,
  );
}

describe('a dense stretch of the Timeline', () => {
  for (const detailed of [false, true])
    for (const mode of ['compact', 'real'] as AxisMode[])
      it(`never draws a label over another label, a bar or a badge (${detailed ? 'Detailed' : 'Compact'}, ${mode} time)`, () => {
        const { labels, bars, badges } = boxes(render(detailed, mode));
        expect(labels.length).toBeGreaterThan(detailed ? 8 : 3);
        expect(bars.length).toBeGreaterThanOrEqual(11);
        expect(badges.length).toBeGreaterThan(10);
        const hits: string[] = [];
        labels.forEach((l, i) => {
          labels.slice(i + 1).forEach((o) => overlap(l.box, o.box) > 0 && hits.push(`${l.text} / ${o.text}`));
          bars.forEach((b) => overlap(l.box, b) > 0 && hits.push(`${l.text} / bar`));
          badges.forEach((b) => overlap(l.box, b) > 0 && hits.push(`${l.text} / badge`));
          if (l.text.endsWith('…')) expect(l.text.length).toBeGreaterThan(5);
        });
        expect(hits).toEqual([]);
      });
});
