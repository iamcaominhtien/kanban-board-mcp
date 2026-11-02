import type { FlowDecision, FlowStory, ScopedEdge, ScopedFlowMap } from '../../api/aiTeam';
import { compactTickets } from './flowScope';

/** Where a feed line came from: its AI and its ticket light up in the drawing. */
export interface LitMark {
  memberId: string | null;
  ticketId: string | null;
}

const PM_X = 12;
const PM_W = 150;
const PM_H = 132;
const COL_X = 400;
const BOX_W = 196;
const HEAD = 22;
const GAP = 34;
const TOP = 10;
/** About how many ticket numbers fit on one line of a box. */
const PER_LINE = 5;

const LIVE_WORD: Record<string, string> = { working: 'working', waiting_you: 'needs you', queued: 'queued' };
const LIVE_COLOR: Record<string, string> = { working: '#2E6F40', waiting_you: '#8A6A12', queued: '#5B6B60' };

type Node = ScopedFlowMap['nodes'][number];

/** The PM of the Story: the one its plan names, else whoever sends the plan's arrows, else a member called PM. */
export function pmOf(map: ScopedFlowMap, story: FlowStory | null): string | null {
  const ids = new Set(map.nodes.map((n) => n.id));
  const hub = map.nodes.find((n) => n.hub);
  if (hub) return hub.id;
  if (story?.pm?.id && ids.has(story.pm.id)) return story.pm.id;
  const plan = map.edges.find((e) => e.kind === 'plan' && ids.has(e.from));
  if (plan) return plan.from;
  return map.nodes.find((n) => /^pm\b/i.test(n.name))?.id ?? null;
}

function boxHeight(n: Node): number {
  const lines = Math.max(1, Math.ceil((n.ticketIds?.length ?? 0) / PER_LINE));
  return Math.max(48, HEAD + 10 + lines * 16);
}

/** "from plan 3", "2 hand-offs", "report back 3": what an arrow of the Story map says. */
export function spokeLabel(e: ScopedEdge, toPm: boolean): string {
  if (toPm)
    return e.kind === 'report back' ? `report back ${e.count}` : `${e.count} hand-off${e.count === 1 ? '' : 's'}`;
  if (e.kind === 'plan') return `from plan ${e.count}`;
  return `${e.count} hand-off${e.count === 1 ? '' : 's'}`;
}

/**
 * Flow inside one Story (design/screens/ai-story-flow.md, I): the PM on the left as the hub, an arrow from its plan to
 * each AI that held one of the Story's tickets, the tickets in each box (the live one ringed, each opens its ticket),
 * the hand-offs down the column, each AI reporting back to the PM, and work that went back dashed on the right (brown
 * for review round 1, red after it).
 */
export function StoryMap({
  map,
  pmId,
  story,
  decisions,
  lit = null,
  onOpenTicket,
  onHoverTicket,
  onHoverNode,
}: {
  map: ScopedFlowMap;
  pmId: string | null;
  story: FlowStory | null;
  decisions?: FlowDecision[];
  lit?: LitMark | null;
  onOpenTicket: (ticketId: string) => void;
  onHoverTicket?: (ticketId: string | null) => void;
  onHoverNode?: (memberId: string | null) => void;
}) {
  const pm = map.nodes.find((n) => n.id === pmId) ?? null;
  const col = map.nodes.filter((n) => n.id !== pmId);
  const ys: number[] = [];
  const hs = col.map(boxHeight);
  let y = TOP;
  for (const h of hs) {
    ys.push(y);
    y += h + GAP;
  }
  const colBottom = col.length ? ys[col.length - 1] + hs[col.length - 1] : TOP;
  const height = Math.max(colBottom + 18, PM_H + 40);
  const pmY = Math.round(height / 2 - PM_H / 2);
  const at = new Map(col.map((n, i) => [n.id, i]));
  const right = COL_X + BOX_W;

  const fromPm = map.edges.filter((e) => pmId && e.from === pmId && at.has(e.to) && e.kind !== 'report back');
  const toPm = map.edges.filter(
    (e) => pmId && e.to === pmId && at.has(e.from) && e.kind !== 'sent back' && e.kind !== 'returned',
  );
  const between = map.edges.filter((e) => at.has(e.from) && at.has(e.to) && e.from !== e.to);
  const down = between.filter((e) => (e.kind === 'flow' || e.kind === 'plan') && at.get(e.to)! - at.get(e.from)! === 1);
  const arcs = between.filter((e) => !down.includes(e));
  const maxSpoke = Math.max(...fromPm.map((e) => e.count), 1);
  const width = Math.max(702, right + 44 + arcs.length * 16 + 110);
  const midY = (i: number) => ys[i] + hs[i] / 2;

  const planned =
    story?.plan?.items.length ?? story?.progress.total ?? new Set(col.flatMap((n) => n.ticketIds ?? [])).size;
  const reports = toPm.filter((e) => e.kind === 'report back').reduce((n, e) => n + e.count, 0);
  const decided = decisions?.length ?? 0;
  const pmColor = pm?.color ?? '#2F6FB0';

  return (
    <div className="fs-smap" data-testid="story-map">
      <div className="fs-smap-in" style={{ width, height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{
            display: 'block',
            position: 'absolute',
            inset: 0,
            fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          }}
          aria-hidden="true"
        >
          <defs>
            {[
              ['sm-ah', '#2E6F40'],
              ['sm-ahy', '#9AA8A0'],
              ['sm-ahb', '#8A6A12'],
              ['sm-ahr', '#C4432A'],
              ['sm-ahp', '#7C5CD6'],
            ].map(([id, fill]) => (
              <marker
                key={id}
                id={id}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill={fill} />
              </marker>
            ))}
          </defs>
          {fromPm.map((e) => {
            const i = at.get(e.to)!;
            const x1 = PM_X + PM_W;
            const y1 = pmY + 40;
            const y2 = ys[i] + 16;
            const ly = 0.5 * y1 + 0.5 * y2;
            return (
              <g key={`p-${e.to}-${e.kind}`} data-testid={`story-spoke-${e.to}`}>
                <path
                  d={`M${x1} ${y1} C${x1 + 130} ${y1} ${COL_X - 130} ${y2} ${COL_X} ${y2}`}
                  stroke="#2E6F40"
                  strokeWidth={e.count === maxSpoke && fromPm.length > 1 ? 3 : 2}
                  fill="none"
                  className={e.live ? 'at-live-edge' : undefined}
                  markerEnd="url(#sm-ah)"
                />
                <rect x={223} y={ly - 9} width="76" height="18" rx="9" fill="#fff" stroke="#D3DDD7" />
                <text x={261} y={ly + 4} fontSize="10" fontWeight="700" fill="#1E2A22" textAnchor="middle">
                  {spokeLabel(e, false)}
                </text>
              </g>
            );
          })}
          {toPm.map((e) => {
            const i = at.get(e.from)!;
            const y1 = ys[i] + hs[i] - 14;
            const y2 = pmY + PM_H - 24;
            return (
              <g key={`r-${e.from}-${e.kind}`}>
                <path
                  d={`M${COL_X} ${y1} C${COL_X - 120} ${y1} ${PM_X + PM_W + 120} ${y2} ${PM_X + PM_W} ${y2}`}
                  stroke="#9AA8A0"
                  strokeWidth="1.6"
                  strokeDasharray="2 4"
                  fill="none"
                  markerEnd="url(#sm-ahy)"
                />
                <text x={COL_X - 8} y={y1 + 16} fontSize="9.5" fontWeight="700" fill="#7B8A81" textAnchor="end">
                  {spokeLabel(e, true)}
                </text>
              </g>
            );
          })}
          {down.map((e) => {
            const i = at.get(e.from)!;
            const x = COL_X + 70;
            const y1 = ys[i] + hs[i];
            const y2 = ys[i + 1];
            return (
              <g key={`d-${e.from}-${e.to}`}>
                <path
                  d={`M${x} ${y1} L${x} ${y2 - 1}`}
                  stroke="#2E6F40"
                  strokeWidth="2"
                  fill="none"
                  className={e.live ? 'at-live-edge' : undefined}
                  markerEnd="url(#sm-ah)"
                />
                <text x={x + 9} y={(y1 + y2) / 2 + 4} fontSize="10.5" fontWeight="800" fill="#1E2A22">
                  {e.count} hand-off{e.count === 1 ? '' : 's'}
                </text>
              </g>
            );
          })}
          {arcs.map((e, k) => {
            const a = midY(at.get(e.from)!);
            const b = midY(at.get(e.to)!);
            const reach = 44 + k * 16;
            const look =
              e.kind === 'returned'
                ? { stroke: '#8A6A12', dash: '5 4', marker: 'sm-ahb' }
                : e.kind === 'sent back'
                  ? { stroke: '#C4432A', dash: '5 4', marker: 'sm-ahr' }
                  : e.kind === 'skip'
                    ? { stroke: '#7C5CD6', dash: undefined, marker: 'sm-ahp' }
                    : { stroke: '#2E6F40', dash: undefined, marker: 'sm-ah' };
            const label =
              e.kind === 'returned'
                ? [`${e.count} returned`, 'review round 1']
                : e.kind === 'sent back'
                  ? [`${e.count} sent back`]
                  : [`${e.count} hand-off${e.count === 1 ? '' : 's'}`];
            return (
              <g key={`a-${e.from}-${e.to}-${e.kind}`} data-testid={`story-arc-${e.kind.replace(' ', '-')}`}>
                <path
                  d={`M${right} ${a} C${right + reach} ${a} ${right + reach} ${b} ${right} ${b}`}
                  stroke={look.stroke}
                  strokeWidth="2"
                  strokeDasharray={look.dash}
                  fill="none"
                  className={e.live ? 'at-live-edge' : undefined}
                  markerEnd={`url(#${look.marker})`}
                />
                {label.map((t, n) => (
                  <text
                    key={t}
                    x={right + reach - 8}
                    y={(a + b) / 2 + n * 13}
                    fontSize={n ? 9.5 : 10}
                    fontWeight={n ? 400 : 700}
                    fill={look.stroke}
                  >
                    {t}
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
        {col.map((n, i) => {
          const ids = n.ticketIds ?? [];
          const live = n.liveTicket ?? n.live?.ticketId ?? null;
          const isLit = !!lit?.memberId && lit.memberId === n.id;
          return (
            <div
              key={n.id}
              className={`fs-node${n.live ? ' live' : ''}${isLit ? ' lit' : ''}`}
              style={{ left: COL_X, top: ys[i], width: BOX_W, height: hs[i], borderColor: n.color }}
              onMouseEnter={() => onHoverNode?.(n.id)}
              onMouseLeave={() => onHoverNode?.(null)}
              data-testid={`story-node-${n.id}`}
            >
              <div className="fs-node-h" style={{ background: `${n.color}22` }}>
                <b style={{ color: n.color }}>{n.name}</b>
                <span style={n.live ? { color: LIVE_COLOR[n.live.state], fontWeight: 700 } : undefined}>
                  {n.live ? LIVE_WORD[n.live.state] : n.pauseTag || 'idle'}
                </span>
              </div>
              <div className="fs-node-t">
                {ids.length === 0 && <span style={{ color: '#9AA8A0' }}>{n.tickets} tickets</span>}
                {compactTickets(ids).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={t.id === live || (isLit && lit?.ticketId === t.id) ? 'live' : undefined}
                    title={`Open ${t.id}`}
                    onClick={() => onOpenTicket(t.id)}
                    onMouseEnter={() => onHoverTicket?.(t.id)}
                    onMouseLeave={() => onHoverTicket?.(null)}
                  >
                    {t.text}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div
          className={`fs-node fs-pm${lit?.memberId && lit.memberId === pmId ? ' lit' : ''}`}
          style={{ left: PM_X, top: pmY, width: PM_W, height: PM_H, borderColor: pmColor }}
          onMouseEnter={() => pmId && onHoverNode?.(pmId)}
          onMouseLeave={() => onHoverNode?.(null)}
          data-testid="story-pm"
        >
          <div className="fs-node-h" style={{ background: `${pmColor}22` }}>
            <b style={{ color: pmColor }}>{pm?.name ?? story?.pm?.name ?? 'PM'}</b>
            <span>runs the Story</span>
          </div>
          <div className="fs-pm-body">
            <b>
              {planned} ticket{planned === 1 ? '' : 's'} planned
            </b>
            <span>decided {decided} for you</span>
            <span>reports back: {reports}</span>
            <span style={(pm?.asked ?? 0) > 0 ? { color: '#7A5A06', fontWeight: 700 } : undefined}>
              asked you: {pm?.asked ?? 0}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, hint, color }: { label: string; value: string | number; hint: string; color?: string }) {
  return (
    <div className="fs-tile">
      <div className="fs-h">{label}</div>
      <span className="fs-tile-n" style={color ? { color } : undefined}>
        {value}
      </span>
      <div className="fs-tile-hint">{hint}</div>
    </div>
  );
}

/** The stats under the Story map: hand-offs by kind, sent back, waiting for you and what the PM decided. */
export function StoryStats({ map, decisions }: { map: ScopedFlowMap; decisions?: FlowDecision[] }) {
  const s = map.stats;
  const NAME: Record<string, string> = {
    assigned: 'assigned',
    plan: 'assigned',
    mention: '@mention',
    'hand-off': 'hand-off',
    'report back': 'report back',
  };
  const parts = (s?.kinds ?? [])
    .filter((k) => NAME[k.kind])
    .map((k) => `${NAME[k.kind]} ${k.count}${k.kind === 'plan' || k.kind === 'assigned' ? ' (from the plan)' : ''}`);
  const overridden = (decisions ?? []).filter((d) => d.state === 'overridden').length;
  return (
    <div className="fs-tiles" data-testid="story-stats">
      <Tile label="Hand-offs" value={s?.handoffs ?? 0} hint={parts.join(', ') || 'none yet'} />
      <Tile
        label="Sent back"
        value={s?.sentBack ?? 0}
        color="#A5321E"
        hint={
          s?.returned
            ? `${s.returned} returned in review round 1, which is normal`
            : 'nothing went back after the first review round'
        }
      />
      <Tile
        label="Waiting for you"
        value={s?.waitingShare != null ? `${Math.round(s.waitingShare * 100)}%` : '–'}
        color="#7A5A06"
        hint="of the Story so far"
      />
      <Tile
        label="PM decided"
        value={decisions?.length ?? 0}
        hint={decisions ? `${overridden} overridden` : 'decisions show once the Story has any'}
      />
    </div>
  );
}

export const STORY_LEGEND =
  'Green arrow from the PM: a step the board started from the PM’s plan. Green arrow between two AIs: a hand-off. ' +
  'Grey dotted back to the PM: the AI reported back. Brown dashed: returned in review round 1 (normal); red dashed ' +
  'is sent back after that. Same arrows and colours as the project map; @mentions are in the Timeline.';
