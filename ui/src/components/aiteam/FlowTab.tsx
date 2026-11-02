import { useEffect, useState, type ReactNode } from 'react';
import {
  useFlowStories,
  useFlowStory,
  useTeamFlow,
  useTicketJourney,
  type FlowCluster,
  type FlowStory,
  type ScopedFlowMap,
} from '../../api/aiTeam';
import type { FlowEdge, FlowMap, Journey, JourneyPage, LiveRun, ParentRollup, TeamRange } from '../../types/aiTeam';
import { pickTickets, scopeLevel, shareOf, storyOfTickets, type FlowScope, type FlowView } from './flowScope';
import { openRun } from './runLink';
import { FS_ICON, FsIcon, ScopeBar } from './ScopeBar';
import { StoryClusters } from './StoryClusters';
import { STORY_LEGEND, StoryMap, StoryStats, pmOf, type LitMark } from './StoryMap';
import { StoryTimeline } from './StoryTimeline';
import { fmtShort, fmtUsd } from './teamFormat';
import { TicketChip } from './teamUi';
import { TimelineTab } from './TimelineTab';
import { buildFlowLink, type TimelineLink } from './timelineLink';
import { CostCard, EvidenceCard, WorkflowStrip } from './WorkflowStrip';
import { NODE_H, NODE_Y, arcReach, teamMapHeight } from './teamMapLayout';
import { PAUSE_COLOR, clockTime } from '../ai/pausedUi';
import { LiveFeedSplit } from '../ai/live/LiveFeed';

export interface FlowActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
  /** Open the Story page; without it the Story ticket opens. */
  onOpenStory?: (storyId: string) => void;
}

const NODE_W = 130;
const NODE_GAP = 60;

const LIVE_WORD: Record<LiveRun['state'], string> = {
  working: 'working',
  waiting_you: 'waiting for you',
  queued: 'queued',
};
// The short word inside a node, which is only 130 px wide
const LIVE_SHORT: Record<LiveRun['state'], string> = { working: 'working', waiting_you: 'needs you', queued: 'queued' };
const LIVE_COLOR: Record<LiveRun['state'], string> = { working: '#2E6F40', waiting_you: '#8A6A12', queued: '#5B6B60' };

/** "3m 20s" for a live timer: seconds under a minute, minutes after. */
function since(s: number | null): string {
  if (s == null) return '';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
}

/** What the AIs are doing right now, one chip each; a click opens that ticket's journey. */
function LiveStrip({
  live,
  onPick,
  pausedAt,
}: {
  live: LiveRun[];
  onPick: (ticketId: string) => void;
  /** Set while Pause all AI is on: the strip says why nothing runs. */
  pausedAt?: string | null;
}) {
  if (live.length === 0 && pausedAt !== undefined)
    return (
      <div className="at-now idle" data-testid="live-strip">
        <b>Right now</b> <b style={{ color: PAUSE_COLOR }}>No AI is running</b> · paused since {clockTime(pausedAt)}
      </div>
    );
  if (live.length === 0)
    return (
      <div className="at-now idle" data-testid="live-strip">
        <b>Right now</b> Nobody is working. The map shows what already happened.
      </div>
    );
  return (
    <div className="at-now" data-testid="live-strip">
      <b>Right now</b>
      {live.map((x) => (
        <button
          key={x.runId}
          type="button"
          className="at-now-chip"
          onClick={() => onPick(x.ticketId)}
          title={x.step || x.ticketTitle}
        >
          <span className={`at-live-dot ${x.state}`} />
          <b>{x.memberName}</b>
          <span style={{ color: LIVE_COLOR[x.state] }}>
            {LIVE_WORD[x.state]} · {x.ticketId} · {since(x.elapsedS)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One box per AI in a row, an arrow per pair: straight to the next one, an arc above for a skip or a report back,
 *  an arc below for work sent back (design/screens/ai-team.md, C). Longer arcs rise higher so labels do not collide. */
export function TeamMap({
  map,
  share = null,
  lit = null,
  onHoverNode,
}: {
  map: FlowMap | ScopedFlowMap;
  /** A Story cluster hovered under the map: its share of every arrow in dark blue, the rest dimmed (design H). */
  share?: FlowCluster | null;
  /** The AI a line of the feed came from: its box lights up. */
  lit?: string | null;
  onHoverNode?: (memberId: string | null) => void;
}) {
  const nodes = map.nodes;
  // with a cluster hovered: the arrows it has no part in fade, its part of the others is counted in dark blue
  const part = (e: { from: string; to: string; kind: string }) => shareOf(share, e);
  const dim = (e: { from: string; to: string; kind: string }) => (share ? (part(e) ? 1 : 0.35) : undefined);
  const width = Math.max(nodes.length * (NODE_W + NODE_GAP) + 20, 480);
  const x = (i: number) => 20 + i * (NODE_W + NODE_GAP);
  const cx = (i: number) => x(i) + NODE_W / 2;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const pos = (id: string) => idx.get(id) ?? -1;
  // an edge from an AI to itself is the Checks sending its work back: a loop under its box, drawn on its own
  const edges = map.edges as FlowEdge[];
  const agg = (kind: FlowEdge['kind'], pred: (e: FlowEdge) => boolean) =>
    edges.filter((e) => e.kind === kind && pos(e.from) >= 0 && pos(e.to) >= 0 && e.from !== e.to && pred(e));
  const adjacent = agg('flow', (e) => pos(e.to) - pos(e.from) === 1);
  const skips = agg('skip', () => true);
  const longForward = agg('flow', (e) => pos(e.to) - pos(e.from) > 1);
  const backs = agg('flow', (e) => pos(e.to) < pos(e.from));
  const sent = agg('sent back', () => true);
  const returned = agg('returned', () => true);
  const reports = agg('report back', () => true);
  const loops = edges.filter((e) => e.from === e.to && pos(e.from) >= 0);
  const maxCount = Math.max(...edges.map((e) => e.count), 1);
  const w = (c: number) => (c / maxCount > 0.6 ? 3 : 2);
  const above = [
    ...skips.map((e) => ({
      e,
      color: '#7C5CD6',
      dash: undefined,
      marker: 'ahp',
      label: `${e.count} skip ${e.skipped.join(' and ')}`,
    })),
    ...longForward.map((e) => ({ e, color: '#2E6F40', dash: undefined, marker: 'ah', label: `${e.count}` })),
    ...reports.map((e) => ({ e, color: '#9AA8A0', dash: '2 4', marker: 'ahy', label: `${e.count} report back` })),
  ].sort((a, b) => Math.abs(pos(a.e.to) - pos(a.e.from)) - Math.abs(pos(b.e.to) - pos(b.e.from)));
  const below = [
    ...backs.map((e) => ({ e, color: '#2E6F40', dash: undefined, marker: 'ah', label: `${e.count} hand-off back` })),
    ...returned.map((e) => ({ e, color: '#8A6A12', dash: '5 4', marker: 'ahb', label: `${e.count} returned` })),
    ...sent.map((e) => ({ e, color: '#C4432A', dash: '5 4', marker: 'ahr', label: `${e.count} sent back` })),
  ].sort((a, b) => Math.abs(pos(a.e.to) - pos(a.e.from)) - Math.abs(pos(b.e.to) - pos(b.e.from)));
  // as tall as the outermost arc and its label: with many hand-offs back the old fixed room cut the arcs off; a loop
  // under a box needs the room of the first arc
  const { top: M, height } = teamMapHeight(above.length, Math.max(below.length, loops.length ? 1 : 0));
  const bottom = NODE_Y + NODE_H;
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', maxWidth: width, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}
      data-testid="team-map"
    >
      <defs>
        {[
          ['ah', '#2E6F40'],
          ['ahr', '#C4432A'],
          ['ahy', '#9AA8A0'],
          ['ahp', '#7C5CD6'],
          ['ahb', '#8A6A12'],
          ['ahn', '#1B3A6B'],
        ].map(([id, fill]) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="9"
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10z" fill={fill} />
          </marker>
        ))}
      </defs>
      <g transform={`translate(0,${M})`}>
        {above.map(({ e, color, dash, marker, label }, k) => {
          const a = cx(pos(e.from));
          const b = cx(pos(e.to));
          const rise = arcReach(k);
          const top = NODE_Y - rise;
          return (
            <g key={`u-${marker}-${e.from}-${e.to}`} opacity={dim(e)}>
              <path
                d={`M${a} ${NODE_Y} C${a} ${top - rise * 0.33} ${b} ${top - rise * 0.33} ${b} ${NODE_Y}`}
                stroke={color}
                strokeWidth={e.live ? 3 : 1.8}
                fill="none"
                strokeDasharray={dash}
                className={e.live ? 'at-live-edge' : undefined}
                markerEnd={`url(#${marker})`}
              />
              <text x={(a + b) / 2} y={top - 2} fontSize="11.5" fontWeight="700" fill={color} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        {nodes.map((n, i) => (
          <g
            key={n.id}
            onMouseEnter={onHoverNode ? () => onHoverNode(n.id) : undefined}
            onMouseLeave={onHoverNode ? () => onHoverNode(null) : undefined}
            data-testid={`map-node-${n.id}`}
          >
            {lit === n.id && (
              <rect
                x={x(i) - 5}
                y={NODE_Y - 5}
                width={NODE_W + 10}
                height={NODE_H + 10}
                rx="16"
                fill="none"
                stroke="#1B3A6B"
                strokeWidth="2.6"
                data-testid="map-node-lit"
              />
            )}
            {n.live && (
              <rect
                className="at-ring"
                x={x(i) - 4}
                y={NODE_Y - 4}
                width={NODE_W + 8}
                height={NODE_H + 8}
                rx="15"
                fill="none"
                stroke={LIVE_COLOR[n.live.state]}
                strokeWidth="2.4"
              />
            )}
            <rect
              x={x(i)}
              y={NODE_Y}
              width={NODE_W}
              height={NODE_H}
              rx="12"
              fill="#fff"
              stroke={n.color}
              strokeWidth="1.6"
            />
            <rect x={x(i)} y={NODE_Y} width={NODE_W} height="30" rx="12" fill={`${n.color}22`} />
            <rect x={x(i)} y={NODE_Y + 18} width={NODE_W} height="12" fill={`${n.color}22`} />
            <text x={x(i) + 12} y={NODE_Y + 20} fontSize="13" fontWeight="800" fill={n.color}>
              {n.name.length > 13 ? `${n.name.slice(0, 12)}…` : n.name}
            </text>
            <text x={x(i) + 12} y={NODE_Y + 50} fontSize="11.5" fontWeight="600" fill="#1E2A22">
              {n.tickets} ticket{n.tickets === 1 ? '' : 's'}
            </text>
            <text x={x(i) + 12} y={NODE_Y + 68} fontSize="11" fill="#5B6B60">
              avg run {fmtShort(n.avgRunS)}
            </text>
            <text x={x(i) + 12} y={NODE_Y + 86} fontSize="11" fill="#5B6B60">
              asked you: {n.asked}
            </text>
            <line x1={x(i) + 8} x2={x(i) + NODE_W - 8} y1={NODE_Y + 95} y2={NODE_Y + 95} stroke="#E3E8E5" />
            {n.live ? (
              <g data-testid={`node-live-${n.name}`}>
                <circle cx={x(i) + 17} cy={NODE_Y + 110} r="4.5" fill={LIVE_COLOR[n.live.state]} className="at-ring" />
                <text x={x(i) + 28} y={NODE_Y + 114} fontSize="11" fontWeight="700" fill={LIVE_COLOR[n.live.state]}>
                  {LIVE_SHORT[n.live.state]}
                </text>
                <text x={x(i) + 28} y={NODE_Y + 130} fontSize="11" fontWeight="600" fill="#1E2A22">
                  {n.live.ticketId.length > 11 ? `${n.live.ticketId.slice(0, 10)}…` : n.live.ticketId}
                  {(n.liveCount ?? 0) > 1 ? ` +${(n.liveCount ?? 1) - 1}` : ''}
                </text>
              </g>
            ) : (
              <text x={x(i) + 12} y={NODE_Y + 113.5} fontSize="11" fill="#9AA8A0">
                {n.pauseTag ? '' : 'idle'}
              </text>
            )}
            {n.pauseTag && (
              <g data-testid={`node-pause-${n.name}`}>
                <rect
                  x={x(i) + NODE_W - 64}
                  y={NODE_Y + 99}
                  width="56"
                  height="18"
                  rx="9"
                  fill={n.pauseTag === 'paused' ? '#FDF0E6' : n.pauseTag === 'waiting' ? '#FEF3D9' : '#FDECE8'}
                  stroke={n.pauseTag === 'paused' ? '#F0CDB0' : n.pauseTag === 'waiting' ? '#E8B93A' : '#C4432A'}
                />
                <text
                  x={x(i) + NODE_W - 36}
                  y={NODE_Y + 111.5}
                  fontSize="10"
                  fontWeight="700"
                  textAnchor="middle"
                  fill={n.pauseTag === 'paused' ? PAUSE_COLOR : n.pauseTag === 'waiting' ? '#7A5A06' : '#A5321E'}
                >
                  {n.pauseTag}
                </text>
                {(n.held ?? 0) > 0 && (
                  <>
                    <rect
                      x={x(i) + 12}
                      y={NODE_Y + 121}
                      width="62"
                      height="16"
                      rx="8"
                      fill="#fff"
                      stroke="#9AA8A0"
                      strokeDasharray="3 2"
                    />
                    <text
                      x={x(i) + 43}
                      y={NODE_Y + 132.5}
                      fontSize="10"
                      fontWeight="600"
                      textAnchor="middle"
                      fill="#5B6B60"
                    >
                      {n.held} held
                    </text>
                  </>
                )}
              </g>
            )}
          </g>
        ))}
        {adjacent.map((e) => {
          const a = pos(e.from);
          const mid = x(a) + NODE_W + NODE_GAP / 2;
          const mine = part(e);
          return (
            <g key={`a-${e.from}-${e.to}`} opacity={dim(e)} data-testid={`map-edge-${e.from}-${e.to}`}>
              <path
                d={`M${x(a) + NODE_W} ${NODE_Y + 52} L${x(a) + NODE_W + NODE_GAP - 2} ${NODE_Y + 52}`}
                stroke={mine ? '#1B3A6B' : '#2E6F40'}
                strokeWidth={e.live ? w(e.count) + 1 : w(e.count)}
                fill="none"
                className={e.live ? 'at-live-edge' : undefined}
                markerEnd={mine ? 'url(#ahn)' : 'url(#ah)'}
              />
              <text
                x={mid}
                y={NODE_Y + 42}
                fontSize={mine ? 10.5 : 11.5}
                fontWeight={mine ? 800 : 700}
                fill={mine ? '#1B3A6B' : '#1E2A22'}
                textAnchor="middle"
              >
                {mine ? `${mine} of ${e.count}` : e.count}
              </text>
              <text x={mid} y={NODE_Y + 70} fontSize="10.5" fill="#5B6B60" textAnchor="middle">
                {fmtShort(e.waitS)}
              </text>
            </g>
          );
        })}
        {below.map(({ e, color, dash, marker, label }, k) => {
          const a = cx(pos(e.from));
          const b = cx(pos(e.to));
          const drop = arcReach(k);
          const low = bottom + drop;
          return (
            <g key={`d-${marker}-${e.from}-${e.to}`} opacity={dim(e)}>
              <path
                d={`M${a} ${bottom} C${a} ${low + drop * 0.33} ${b} ${low + drop * 0.33} ${b} ${bottom}`}
                stroke={color}
                strokeWidth={e.live ? 3 : 2}
                fill="none"
                strokeDasharray={dash}
                className={e.live ? 'at-live-edge' : undefined}
                markerEnd={`url(#${marker})`}
              />
              <text x={(a + b) / 2} y={low + 14} fontSize="11.5" fontWeight="700" fill={color} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        {loops.map((e) => {
          const c = cx(pos(e.from));
          // a small loop to the right of the box's centre, its label beside it, clear of the arcs between boxes
          const low = bottom + 26;
          const color = e.kind === 'sent back' ? '#C4432A' : '#8A6A12';
          return (
            <g key={`l-${e.from}-${e.kind}`} data-testid={`map-loop-${e.from}`} opacity={dim(e)}>
              <path
                d={`M${c + 14} ${bottom} C${c + 4} ${low} ${c + 54} ${low} ${c + 44} ${bottom}`}
                stroke={color}
                strokeWidth={e.live ? 3 : 2}
                fill="none"
                strokeDasharray="5 4"
                className={e.live ? 'at-live-edge' : undefined}
                markerEnd={`url(#${e.kind === 'sent back' ? 'ahr' : 'ahb'})`}
              />
              <text x={c + 52} y={bottom + 20} fontSize="11.5" fontWeight="700" fill={color}>
                {e.via === 'checks' ? `${e.count} back from checks` : `${e.count} back`}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function Stat({ label, value, hint, color }: { label: string; value: string | number; hint: string; color?: string }) {
  return (
    <div className="at-tile" style={{ minWidth: 150 }}>
      <div className="at-label">{label}</div>
      <span className="at-total-n" style={color ? { color } : undefined}>
        {value}
      </span>
      <div className="at-hint-sm">{hint}</div>
    </div>
  );
}

/** The folded hand-offs of a busy map (design H2): a dashed chip that opens the list. */
function FoldedChip({ folded, names }: { folded: NonNullable<ScopedFlowMap['folded']>; names: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  if (!folded.count) return null;
  return (
    <div className="fs-folded">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="map-folded">
        + {folded.count} smaller hand-off{folded.count === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="fs-folded-list" role="list" data-testid="map-folded-list">
          {folded.edges.map((e) => (
            <div key={`${e.from}-${e.to}-${e.kind}`} role="listitem">
              <b style={{ minWidth: 22 }}>{e.count}</b>
              <span style={{ flex: 1 }}>
                {names.get(e.from) ?? e.from} → {names.get(e.to) ?? e.to}
              </span>
              <span style={{ color: '#5B6B60' }}>{e.kind === 'flow' ? 'hand-off' : e.kind}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The whole project (design/screens/ai-team.md, C, and ai-story-flow.md, H): the map, its Story clusters, the stats. */
function MapView({
  map,
  onPick,
  stories = [],
  share = null,
  onShare,
  onOpenStory,
  lit = null,
  onHoverNode,
}: {
  map: ScopedFlowMap;
  onPick: (ticketId: string) => void;
  stories?: FlowStory[];
  share?: FlowCluster | null;
  onShare?: (c: FlowCluster | null) => void;
  onOpenStory?: (storyId: string) => void;
  lit?: string | null;
  onHoverNode?: (memberId: string | null) => void;
}) {
  const names = new Map(map.nodes.map((n) => [n.id, n.name]));
  const s = map.stats;
  const LABEL: Record<string, string> = {
    assigned: 'assigned',
    mention: '@mention',
    'hand-off': 'hand-off',
    'report back': 'report back',
  };
  const breakdown = s.kinds
    .filter((x) => LABEL[x.kind])
    .map((x) => `${LABEL[x.kind]} ${x.count}`)
    .join(', ');
  const sentTo = s.sentBackTo.map((x) => `${x.name} ${x.count}`).join(', ');
  const pp = s.pingPong[0];
  return (
    <>
      <LiveStrip live={map.live ?? []} onPick={onPick} pausedAt={map.pausedAll ? (map.pausedAt ?? '') : undefined} />
      {map.nodes.length < 2 ? (
        <div className="at-empty">Hand-offs between AIs need at least two AI members.</div>
      ) : (
        <div className="fs-mapbox">
          <TeamMap map={map} share={share} lit={lit} onHoverNode={onHoverNode} />
          {share?.storyId && (
            <div className="fs-against" data-testid="map-against">
              <FsIcon d={FS_ICON.story} size={11} color="#1B3A6B" width={2.2} />
              Showing {share.storyId} against the rest
            </div>
          )}
          {map.folded && map.folded.count > 0 && <FoldedChip folded={map.folded} names={names} />}
        </div>
      )}
      {((map.clusters?.length ?? 0) > 0 || stories.length > 0) && onShare && onOpenStory && (
        <StoryClusters
          clusters={map.clusters ?? []}
          stories={stories}
          hovered={share}
          onHover={onShare}
          onOpen={onOpenStory}
        />
      )}
      <div className="at-tiles">
        <Stat label="Hand-offs" value={s.handoffs} hint={breakdown || 'none in this range'} />
        <Stat
          label="Sent back"
          value={s.sentBack}
          color={s.sentBack > 0 ? '#A5321E' : undefined}
          hint={
            s.sentBackShare != null
              ? `${Math.round(s.sentBackShare * 100)}% · returned after the first review round${sentTo ? `. ${sentTo}` : ''}`
              : 'no hand-offs yet'
          }
        />
        <Stat
          label="Ping-pong"
          value={s.pingPong.length}
          color={s.pingPong.length > 0 ? '#A5321E' : undefined}
          hint={pp ? `one ticket sent back ${pp.count} times: ${pp.ticketId}` : 'no ticket went back and forth'}
        />
        <Stat
          label="Waiting for you"
          value={s.waitingShare != null ? `${Math.round(s.waitingShare * 100)}%` : '–'}
          color="#7A5A06"
          hint="of the time until completed"
        />
      </div>
      <div className="at-hint" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          <b style={{ color: '#2E6F40' }}>Green arrow</b> a normal hand-off. Thicker means more.
        </span>
        <span>
          <b style={{ color: '#C4432A' }}>Red dashed</b> work sent back.
        </span>
        <span>
          <b style={{ color: '#7C5CD6' }}>Purple</b> a step skipped.
        </span>
        <span>
          <b style={{ color: '#8A6A12' }}>Brown dashed</b> returned in the first review round.
        </span>
        <span>
          <b style={{ color: '#C4432A' }}>A loop under a box</b> the checks sent that AI&apos;s work back.
        </span>
        <span>
          <b style={{ color: '#5B6B60' }}>Grey dotted</b> report back, expected.
        </span>
        <span>
          The first return from a review ({s.returned} in this range) is normal and is not counted as sent back.
        </span>
      </div>
    </>
  );
}

const MARK_COLOR: Record<string, string> = {
  start: '#1E2A22',
  by_rule: '#2F6FB0',
  needed: '#E8B93A',
  avoidable: '#C4432A',
};
const ARROW_LOOK: Record<string, { stroke: string; dash?: string; marker: string }> = {
  returned: { stroke: '#8A6A12', dash: '5 4', marker: 'ahb' },
  'sent back': { stroke: '#C4432A', dash: '5 4', marker: 'ahr' },
  'report back': { stroke: '#9AA8A0', dash: '2 4', marker: 'ahy' },
  skip: { stroke: '#7C5CD6', marker: 'ahp' },
};

/** What a journey arrow says on hover: its kind, the steps a workflow skipped, the Checks sending work back. */
function arrowTitle(a: NonNullable<Journey['arrows']>[number]): string {
  if (a.via === 'checks') return `${a.kind}: the checks failed the work`;
  if (a.kind === 'skip') return `hand-off, skipped ${(a.skipped ?? []).join(' and ') || 'a step'}`;
  return a.kind;
}
const LANE_H = 56;
const LEFT = 92;
const W = 1082;
const TOP = 34;

function clock(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}

/** Ticks on the time axis: a step of 5 min to a day, so there are at most about eight. */
function ticks(t0: number, t1: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60000);
  const step = steps.find((s) => (t1 - t0) / s <= 8) ?? steps[steps.length - 1];
  const first = Math.ceil(t0 / step) * step;
  const out: number[] = [];
  for (let t = first; t <= t1; t += step) out.push(t);
  return out;
}

/** One ticket's journey (design/screens/ai-team.md, D): a lane per AI and one for you, bars for runs, arrows for the
 *  hand-offs (a skipped workflow step purple, a send-back dashed, the Checks' send-back a loop on the AI's own lane). */
export function Swimlanes({
  j,
  selected,
  onSelect,
}: {
  j: Journey;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const lanes = [
    { id: 'you', name: 'You', color: '#1E2A22' },
    ...(j.lanes ?? []).map((l) => ({ ...l, color: l.color ?? '#5B6B60' })),
  ];
  const t0 = new Date(j.start ?? Date.now()).getTime();
  const t1 = Math.max(new Date(j.end ?? Date.now()).getTime(), t0 + 60000);
  const span = t1 - t0;
  const px = (iso: string | null | undefined) =>
    LEFT + (((iso ? new Date(iso).getTime() : t0) - t0) / span) * (W - LEFT - 14);
  const laneY = (id: string) =>
    TOP +
    Math.max(
      lanes.findIndex((l) => l.id === id),
      0,
    ) *
      LANE_H;
  const height = TOP + lanes.length * LANE_H + 8;
  const byRun = new Map((j.bars ?? []).map((b) => [b.runId, b]));
  return (
    <div style={{ border: '1px solid #E3E8E5', borderRadius: 10, overflowX: 'auto' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${height}`}
        style={{ display: 'block', minWidth: 720, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}
        data-testid="swimlanes"
      >
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#FFFBEF" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#F0DBA8" strokeWidth="3" />
          </pattern>
          {[
            ['ahg', '#7B8A80'],
            ['ahr', '#C4432A'],
            ['ahb', '#8A6A12'],
            ['ahy', '#9AA8A0'],
            ['ahp', '#7C5CD6'],
          ].map(([id, fill]) => (
            <marker
              key={id}
              id={id}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" fill={fill} />
            </marker>
          ))}
        </defs>
        {lanes.map((l, i) => (
          <g key={l.id}>
            <rect x="0" y={TOP + i * LANE_H} width={W} height={LANE_H} fill={i % 2 ? '#fff' : '#FBFCFB'} />
            <text x="10" y={TOP + i * LANE_H + 26} fontSize="12" fontWeight="700" fill={l.color}>
              {l.name.length > 12 ? `${l.name.slice(0, 11)}…` : l.name}
            </text>
          </g>
        ))}
        {ticks(t0, t1).map((t) => {
          const x = LEFT + ((t - t0) / span) * (W - LEFT - 14);
          return (
            <g key={t}>
              <line x1={x} y1={TOP - 8} x2={x} y2={height - 8} stroke="#EEF3EF" />
              <text x={x} y="18" fontSize="10.5" fill="#5B6B60" textAnchor="middle">
                {clock(new Date(t).toISOString())}
              </text>
            </g>
          );
        })}
        {(j.arrows ?? []).map((a) => {
          const target = byRun.get(a.runId);
          if (!target || !target.start) return null;
          const lane = lanes.find((l) => l.id === a.from) ? a.from : 'you';
          const prior = [...(j.bars ?? [])]
            .filter((b) => b.memberId === a.from && b.end && new Date(b.end) <= new Date(target.start!))
            .pop();
          const x1 = prior?.end ? px(prior.end) : px(a.at);
          const y1 = laneY(lane) + 21;
          const x2 = px(target.start);
          const y2 = laneY(target.memberId) + 21;
          const look = ARROW_LOOK[a.kind] ?? { stroke: '#7B8A80', marker: 'ahg' };
          // the Checks sending the work back to the same AI: a loop under its lane from one run to the next
          const d =
            lane === target.memberId
              ? `M${x1} ${y1 + 13} C${x1 + 10} ${y1 + 26} ${x2 - 10} ${y2 + 26} ${x2 - 2} ${y2 + 13}`
              : `M${x1} ${y1} C${x1 + 18} ${y1} ${x2 - 18} ${y2} ${x2 - 2} ${y2}`;
          return (
            <path
              key={`${a.runId}-${a.kind}`}
              d={d}
              stroke={look.stroke}
              strokeWidth="1.6"
              fill="none"
              strokeDasharray={look.dash}
              markerEnd={`url(#${look.marker})`}
              data-testid={`journey-arrow-${a.kind.replace(' ', '-')}`}
            >
              <title>{arrowTitle(a)}</title>
            </path>
          );
        })}
        {(j.bars ?? []).map((b) => {
          const lane = lanes.find((l) => l.id === b.memberId);
          const x1 = px(b.start);
          const x2 = Math.max(px(b.end), x1 + 6);
          const y = laneY(b.memberId) + 8;
          const bad = b.state === 'failed' || b.state === 'timed_out';
          const color = bad ? '#C4432A' : (lane?.color ?? '#5B6B60');
          return (
            <g key={b.runId} style={{ cursor: 'pointer' }} onClick={() => onSelect(b.runId)} data-testid="run-bar">
              <title>{`${lane?.name ?? 'AI'} #${b.number}${b.step ? ` · ${b.step}` : ''}`}</title>
              <rect
                x={x1}
                y={y}
                width={x2 - x1}
                height="26"
                rx="6"
                fill={bad ? '#FDECE8' : `${color}33`}
                stroke={color}
                strokeWidth={selected === b.runId ? 2.4 : 1.2}
                className={b.state === 'running' || b.state === 'starting' ? 'at-bar-live' : undefined}
              />
              {(b.state === 'running' || b.state === 'starting') && (
                <circle cx={x2} cy={y + 13} r="4" fill={color} className="at-ring" />
              )}
              {b.wait && (
                <rect
                  x={px(b.wait.from)}
                  y={y}
                  width={Math.max(px(b.wait.to) - px(b.wait.from), 3)}
                  height="26"
                  rx="6"
                  fill="url(#hatch)"
                  stroke="#E8B93A"
                />
              )}
              {x2 - x1 > 54 && (
                <text x={x1 + 7} y={y + 17} fontSize="10.5" fontWeight="700" fill={color}>
                  #{b.number}
                </text>
              )}
            </g>
          );
        })}
        {(j.touches ?? []).map((t, k) => (
          <g key={`${t.at}-${t.what}`}>
            <title>{`${t.who}: ${t.what}`}</title>
            <rect
              x={px(t.at) - 8}
              y={laneY('you') + 15}
              width="16"
              height="16"
              rx="3"
              transform={`rotate(45 ${px(t.at)} ${laneY('you') + 23})`}
              fill={MARK_COLOR[t.mark] ?? '#5B6B60'}
            />
            <text x={px(t.at)} y={laneY('you') + 26.5} fontSize="9.5" fontWeight="800" fill="#fff" textAnchor="middle">
              {k + 1}
            </text>
          </g>
        ))}
        {(j.docs ?? []).flatMap((p) => [
          ...p.versions.map((v) => {
            const lane = lanes.find((l) => l.name === v.author)?.id ?? 'you';
            return (
              <g key={`v-${p.id}-${v.version}`}>
                <title>{`${p.title} v${v.version} · ${v.author}`}</title>
                <rect x={px(v.at) - 9} y={laneY(lane) + 38} width="18" height="11" rx="3" fill="#1E2A22" />
                <text
                  x={px(v.at)}
                  y={laneY(lane) + 46.5}
                  fontSize="8.5"
                  fontWeight="800"
                  fill="#fff"
                  textAnchor="middle"
                >
                  v{v.version}
                </text>
              </g>
            );
          }),
          ...p.threads.map((th, k) => {
            const lane = lanes.find((l) => l.name === th.by)?.id ?? 'you';
            const cx = px(th.at) + k * 14 + 20;
            const cy = laneY(lane) + 43;
            return (
              <g key={`t-${th.id}`}>
                <title>{`Thread by ${th.by}: ${th.state}`}</title>
                <circle
                  cx={cx}
                  cy={cy}
                  r="4.5"
                  fill={th.state === 'resolved' ? '#2E6F40' : th.state === 'open' ? '#E8B93A' : '#fff'}
                  stroke={th.state === 'resolved' ? '#2E6F40' : th.state === 'open' ? '#E8B93A' : '#9AA8A0'}
                  strokeWidth="1.5"
                />
                {th.state === 'orphaned' && (
                  <line x1={cx - 3} y1={cy + 3} x2={cx + 3} y2={cy - 3} stroke="#9AA8A0" strokeWidth="1.4" />
                )}
              </g>
            );
          }),
        ])}
      </svg>
    </div>
  );
}

const markChip = (mark: string) =>
  mark === 'by_rule'
    ? { background: '#E8F1FA', color: '#244E78' }
    : mark === 'needed'
      ? { background: '#FEF3D9', color: '#7A5A06' }
      : mark === 'avoidable'
        ? { background: '#FDECE8', color: '#A5321E' }
        : { background: '#E6F2EA', color: '#1F5A31' };

/** The Docs page a ticket delivered: its versions, review threads and what still needs a person. */
function DeliverablePanel({ page, actions }: { page: JourneyPage; actions: FlowActions }) {
  const total = page.counts.resolved + page.counts.open + page.counts.orphaned;
  return (
    <div
      data-testid="docs-deliverable"
      style={{
        width: 330,
        flexShrink: 0,
        border: '1px solid #E3E8E5',
        borderRadius: 12,
        background: '#FBFCFB',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      }}
    >
      <div className="at-label">Deliverable</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13.5, flex: 1 }}>{page.title}</b>
        <span className="at-chip" style={{ background: '#DCEEE1', color: '#1F5A31' }}>
          Published · v{page.version}
        </span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: '#3A4A3E' }}>
        {page.versions
          .map((v) => `v${v.version} ${clock(v.at)} ${v.author}${v.note ? ` (${v.note})` : ''}`)
          .join(' · ')}
      </div>
      {total > 0 && (
        <div style={{ fontSize: 12.5 }}>
          <b>
            {total} review thread{total === 1 ? '' : 's'}
          </b>
          : <span style={{ color: '#2E6F40', fontWeight: 700 }}>{page.counts.resolved} resolved</span>,{' '}
          <span style={{ color: '#7A5A06', fontWeight: 700 }}>{page.counts.open} open</span>,{' '}
          <span style={{ color: '#5B6B60', fontWeight: 700 }}>{page.counts.orphaned} orphaned</span>
        </div>
      )}
      <span
        className="at-chip"
        style={{
          ...(page.needsPerson
            ? { background: '#FEF3D9', color: '#7A5A06' }
            : { background: '#E6F2EA', color: '#1F5A31' }),
          width: 'max-content',
        }}
      >
        {page.needsPerson
          ? `Delivered. ${page.needsPerson} thing${page.needsPerson === 1 ? '' : 's'} need a person`
          : 'Delivered'}
      </span>
      <div className="at-actions">
        <button
          type="button"
          className="st-btn st-btn-primary st-btn-sm"
          onClick={() => actions.onOpenDocsPage(page.id)}
        >
          Open the page
        </button>
        {total > 0 && (
          <button type="button" className="st-btn st-btn-sm" onClick={() => actions.onOpenDocsPage(page.id)}>
            Open the threads
          </button>
        )}
      </div>
      <div className="at-hint-sm" style={{ lineHeight: 1.45 }}>
        The ticket counts as completed when the last run finished and the page exists. Open or orphaned threads do not
        block that; they show here and in Needs you.
      </div>
    </div>
  );
}

const STATE_TEXT: Record<string, { label: string; bg: string; fg: string }> = {
  delivered: { label: 'Delivered', bg: '#E6F2EA', fg: '#1F5A31' },
  delivered_threads: { label: 'Delivered', bg: '#FEF3D9', fg: '#7A5A06' },
  waiting_you: { label: 'Waiting for you', bg: '#FEF3D9', fg: '#7A5A06' },
  working: { label: 'Working', bg: '#E6F2EA', fg: '#1F5A31' },
  blocked: { label: 'Blocked', bg: '#FDECE8', fg: '#A5321E' },
  not_started: { label: 'Not started', bg: '#F1F3F1', fg: '#5B6B60' },
};

/** A PM-led lifecycle: every child with its deliverable, who holds it, whether it is delivered and what blocks the rest,
 *  on one time line (design/screens/ai-team.md, F). */
function ParentView({ parent, onOpen }: { parent: ParentRollup; onOpen: (id: string) => void }) {
  const t0 = new Date(parent.start ?? parent.end).getTime();
  const t1 = Math.max(new Date(parent.end).getTime(), t0 + 3600000);
  const pct = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - t0) / (t1 - t0)) * 100));
  const color = (id: string) => parent.members.find((m) => m.id === id)?.color ?? '#5B6B60';
  const k = parent.tiles;
  const dayTicks: number[] = [];
  const stepDay = 86400000;
  for (let t = Math.ceil(t0 / stepDay) * stepDay; t <= t1; t += stepDay) dayTicks.push(t);
  return (
    <div data-testid="parent-rollup" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="at-tiles">
        <Stat
          label="Children"
          value={k.children}
          hint={`${k.delivered} delivered, ${k.waiting} waiting for you or blocked, ${k.notStarted} not started`}
        />
        <Stat
          label="Blocked"
          value={k.blocked}
          color={k.blocked ? '#A5321E' : undefined}
          hint={parent.alert ? `${parent.alert.child}, by ${parent.alert.blocker}` : 'nothing is blocked'}
        />
        <Stat label="Elapsed" value={fmtShort(k.elapsedS)} hint="from the first run to now" />
        <Stat label="Waiting for you" value={fmtShort(k.waitingS)} color="#7A5A06" hint="of the time so far" />
        <Stat
          label="You stepped in"
          value={k.touches}
          hint={`${k.touchesExpected} expected, ${k.touchesAvoidable} avoidable`}
        />
        <Stat label="Cost" value={fmtUsd(k.costUsd)} hint="all children" />
      </div>
      {parent.alert && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid #F1C9C0',
            background: '#FFF6F4',
            fontSize: 12.5,
          }}
        >
          <span style={{ flex: 1 }}>{parent.alert.text}</span>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            onClick={() => onOpen(parent.alert!.blocker)}
          >
            Open {parent.alert.blocker}
          </button>
        </div>
      )}
      <div className="at-table">
        <div className="at-trow head" style={{ gridTemplateColumns: '150px 190px 120px 190px 1fr', minWidth: 900 }}>
          {['Child ticket', 'Deliverable', 'Held by', 'State', 'Time line'].map((h) => (
            <span key={h} className="at-label" style={{ fontSize: 11 }}>
              {h}
            </span>
          ))}
        </div>
        {parent.children.map((c) => {
          const st = STATE_TEXT[c.state] ?? STATE_TEXT.not_started;
          return (
            <div
              key={c.id}
              className="at-trow"
              style={{ gridTemplateColumns: '150px 190px 120px 190px 1fr', minWidth: 900, alignItems: 'center' }}
              data-testid="parent-child"
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TicketChip id={c.id} onOpen={onOpen} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>{c.title}</span>
              </span>
              <span style={{ fontSize: 12 }}>{c.deliverable || <span className="at-hint">none yet</span>}</span>
              <span style={{ fontSize: 12.5 }}>{c.heldBy ?? '–'}</span>
              <span>
                <span className="at-chip" style={{ background: st.bg, color: st.fg }}>
                  {c.state === 'delivered_threads'
                    ? `${st.label}, ${c.threadsNeed} thread${c.threadsNeed === 1 ? '' : 's'} need you`
                    : st.label}
                </span>
                {c.state === 'blocked' && <div className="at-hint-sm">waits for {c.blockers.join(', ')}</div>}
                {c.state === 'waiting_you' && c.proposals > 0 && (
                  <div className="at-hint-sm">
                    {c.proposals} proposed change{c.proposals === 1 ? '' : 's'} need you
                  </div>
                )}
              </span>
              <span style={{ position: 'relative', height: 22 }}>
                {dayTicks.map((t) => (
                  <i
                    key={t}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: `${pct(new Date(t).toISOString())}%`,
                      borderLeft: '1px solid #EEF3EF',
                    }}
                  />
                ))}
                {c.segments.map((sg, i) => (
                  <span
                    key={i}
                    title={`${parent.members.find((m) => m.id === sg.memberId)?.name ?? 'AI'}`}
                    style={{
                      position: 'absolute',
                      top: 4,
                      height: 14,
                      borderRadius: 4,
                      left: `${pct(sg.start)}%`,
                      width: `${Math.max(pct(sg.end) - pct(sg.start), 1.6)}%`,
                      background: `${color(sg.memberId)}55`,
                      border: `1px solid ${color(sg.memberId)}`,
                    }}
                  />
                ))}
                {c.segments.map((sg, i) =>
                  sg.wait ? (
                    <span
                      key={`w${i}`}
                      style={{
                        position: 'absolute',
                        top: 4,
                        height: 14,
                        borderRadius: 4,
                        left: `${pct(sg.wait.from)}%`,
                        width: `${Math.max(pct(sg.wait.to) - pct(sg.wait.from), 0.8)}%`,
                        background: 'repeating-linear-gradient(45deg,#FFFBEF,#FFFBEF 3px,#F0DBA8 3px,#F0DBA8 5px)',
                        border: '1px solid #E8B93A',
                      }}
                    />
                  ) : null,
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="at-hint" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>Bars: who held the ticket, in their colour</span>
        <span>Hatched amber: waiting for you</span>
        {parent.lead?.name && (
          <span>
            {parent.lead.name}, woken by report backs: {parent.reportBacks} so far, expected. A report back is not a
            bounce.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The ticket scope (design/screens/ai-story-flow.md, J): the One ticket view of main without its ticket list (the
 * picker replaces it), with the steps of the ticket's workflow on top, then the journey, the evidence and the cost.
 */
function TicketScope({
  projectId,
  ticketId,
  setTicketId,
  onOpenStory,
  actions,
}: {
  projectId: string;
  ticketId: string;
  /** Another ticket (a child, a blocker): its own ticket scope. */
  setTicketId: (id: string) => void;
  /** The Story the ticket is in: its Story scope. */
  onOpenStory: (storyId: string) => void;
  actions: FlowActions;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const q = useTicketJourney(projectId, ticketId);
  const j = q.data;
  const sel = j?.bars?.find((b) => b.runId === selected) ?? null;
  const st = j?.strip;
  const wf = j?.workflow ?? null;
  const tokens = (j?.bars ?? []).reduce((n, b) => n + (b.tokens ?? 0), 0);
  return (
    <div data-testid="ticket-scope">
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!j ? (
          <div className="at-hint">{q.isError ? "Couldn't load this ticket." : 'Loading the journey…'}</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                <FsIcon d={FS_ICON.ticket} size={16} color="#2F6FB0" width={2} />
                <b style={{ fontSize: 15 }}>{j.ticket.title}</b>
                <TicketChip id={j.ticket.id} onOpen={actions.onOpenTicket} />
              </span>
              <span style={{ flex: 1 }} />
              {j.story && (
                <button
                  type="button"
                  className="fs-chip"
                  style={{
                    background: '#E6ECF5',
                    color: '#1B3A6B',
                    border: 'none',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                  onClick={() => onOpenStory(j.story!.id)}
                  title={`The Story ${j.story.id}`}
                  data-testid="ticket-story-chip"
                >
                  <FsIcon d={FS_ICON.story} size={11} color="#1B3A6B" width={2.2} />
                  <span className="fs-code" style={{ fontSize: 10.5 }}>
                    {j.story.id}
                  </span>
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 }}>
                    {j.story.title}
                  </span>
                </button>
              )}
              {wf && (
                <span className="fs-chip" style={{ background: '#F1F5F2', color: '#3A4A3E' }}>
                  {wf.templateName}
                </span>
              )}
              {wf?.reviewDepth && (
                <span className="fs-chip" style={{ background: '#F1F5F2', color: '#3A4A3E' }}>
                  {wf.reviewDepth[0].toUpperCase() + wf.reviewDepth.slice(1)} review
                </span>
              )}
              <span className="at-hint">
                {j.start
                  ? new Date(j.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
                  : ''}
                {j.touches?.[0]?.mark === 'start' ? ` · started by ${j.touches[0].who}` : ''}
              </span>
            </div>
            {wf && wf.steps.length > 0 && <WorkflowStrip view={wf} />}
            {j.empty && <div className="at-hint">No AI has worked on {j.ticket.id} yet.</div>}
            <div className={`at-now${j.live?.length ? '' : ' idle'}`} data-testid="journey-now">
              <b>Now</b>
              {j.live?.length ? (
                j.live.map((x) => (
                  <span key={x.runId} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <span className={`at-live-dot ${x.state}`} />
                    <b>{x.memberName}</b>
                    <span style={{ color: LIVE_COLOR[x.state] }}>
                      {LIVE_WORD[x.state]} · {since(x.elapsedS)}
                    </span>
                    {x.step && <span style={{ color: '#5B6B60' }}>· {x.step}</span>}
                  </span>
                ))
              ) : (
                <span>No AI is working on this ticket. It is in {j.ticket.status}.</span>
              )}
            </div>
            {st && !j.parent && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                <span className="at-label">Deliverable</span>
                <span className="at-chip" style={{ background: '#F1F5F2', color: '#3A4A3E', fontWeight: 600 }}>
                  {st.deliverable.label || 'nothing delivered yet'}
                </span>
                {st.deliverable.summary && <span style={{ color: '#3A4A3E' }}>{st.deliverable.summary}</span>}
                <span className="at-label" style={{ marginLeft: 8 }}>
                  Completed
                </span>
                <span>
                  {st.completedAt
                    ? `${clock(st.completedAt)}${st.deliverable.acceptedAt ? `, accepted by a person at ${clock(st.deliverable.acceptedAt)}` : ''}`
                    : j.running
                      ? 'still running'
                      : 'not yet'}
                </span>
              </div>
            )}
            {st && !j.parent && (
              <div className="at-tiles">
                <Stat label="Elapsed" value={fmtShort(st.elapsedS)} hint={`${clock(j.start)} to ${clock(j.end)}`} />
                <Stat
                  label="AIs working"
                  value={fmtShort(st.workingS)}
                  hint={`${st.runs} run${st.runs === 1 ? '' : 's'}`}
                />
                <Stat
                  label="Waiting for you"
                  value={fmtShort(st.waitingS)}
                  hint="questions and approvals"
                  color="#7A5A06"
                />
                <Stat label="Between runs" value={fmtShort(st.betweenS)} hint="hand-off gaps" />
                {(st.pausedS ?? 0) > 0 && (
                  <Stat
                    label="AI paused"
                    value={fmtShort(st.pausedS)}
                    hint="not counted in the others"
                    color={PAUSE_COLOR}
                  />
                )}
                <Stat
                  label="Hand-offs"
                  value={st.handoffs}
                  hint={`${st.returned} returned, round 1${st.sentBack ? `, ${st.sentBack} sent back` : ''}`}
                />
                <Stat
                  label="You stepped in"
                  value={st.touches}
                  hint={`${st.touchesNeeded} needed, ${st.touchesAvoidable} avoidable`}
                />
                <Stat label="Cost" value={fmtUsd(st.costUsd)} hint={`${st.runs} runs`} />
              </div>
            )}
            {j.parent && <ParentView parent={j.parent} onOpen={(id) => setTicketId(id)} />}
            {!j.empty && (!j.parent || (j.bars ?? []).length > 0) ? (
              <Swimlanes j={j} selected={selected} onSelect={setSelected} />
            ) : null}
            <div className="at-hint" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span>Hatched bar: waiting for you</span>
              <span>Red bar: failed</span>
              <span style={{ color: '#8A6A12' }}>Brown dashed arrow: returned in review round 1 (normal)</span>
              <span style={{ color: '#C4432A' }}>Red dashed: sent back after round 1, or by the checks</span>
              <span style={{ color: '#7C5CD6' }}>Purple: a workflow step skipped</span>
              <span>Grey dotted: report back</span>
              <span>◆ start · by rule · needed · avoidable</span>
            </div>
            {sel && (
              <div className="at-box" data-testid="run-card">
                <b style={{ fontSize: 13.5 }}>
                  {j.lanes?.find((l) => l.id === sel.memberId)?.name} · run #{sel.number}
                </b>
                <div className="at-hint-sm" style={{ margin: '3px 0 6px' }}>
                  {sel.state.replace('_', ' ')} · {clock(sel.start)} to {clock(sel.end)}
                  {sel.costUsd != null ? ` · ${fmtUsd(sel.costUsd)}` : ''} · {sel.steps} steps
                  {sel.endedReason ? ` · ${sel.endedReason}` : ''}
                </div>
                {sel.summary && <div style={{ fontSize: 12.5 }}>{sel.summary}</div>}
                <div className="at-actions" style={{ marginTop: 8 }}>
                  <button type="button" className="st-btn st-btn-sm" onClick={() => openRun(sel.runId)}>
                    Open the full run
                  </button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 320 }}>
                {(j.touches ?? []).length > 0 && (
                  <>
                    <div className="at-label" style={{ marginBottom: 4 }}>
                      Touches: the start and {(j.touches ?? []).length - 1} time
                      {(j.touches ?? []).length - 1 === 1 ? '' : 's'} you stepped in
                    </div>
                    {(j.touches ?? []).map((t, k) => (
                      <div
                        key={`${t.at}-${t.what}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '7px 0',
                          borderBottom: '1px solid #EEF3EF',
                          fontSize: 12.5,
                        }}
                      >
                        <span
                          className="at-avatar"
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            background: MARK_COLOR[t.mark] ?? '#5B6B60',
                            color: '#fff',
                            fontSize: 10.5,
                          }}
                        >
                          {k + 1}
                        </span>
                        <span className="at-hint-sm" style={{ width: 44 }}>
                          {clock(t.at)}
                        </span>
                        <span style={{ flex: 1 }}>
                          <b>{t.who}</b> {t.what.toLowerCase()}
                          {t.details ? `: ${t.details}` : ''}
                          {t.via === 'mcp' ? ' (via MCP)' : ''}
                        </span>
                        <span className="at-chip" style={markChip(t.mark)}>
                          {t.mark === 'start'
                            ? 'Start'
                            : t.mark === 'by_rule'
                              ? 'By rule'
                              : t.mark === 'needed'
                                ? 'Needed'
                                : 'Avoidable'}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
              {(j.docs ?? []).map((p) => (
                <DeliverablePanel key={p.id} page={p} actions={actions} />
              ))}
            </div>
            {!j.empty && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <EvidenceCard view={wf} />
                <CostCard usd={st?.costUsd ?? 0} tokens={tokens} runs={st?.runs ?? (j.bars ?? []).length} />
              </div>
            )}
            {(j.children ?? []).length > 0 && !j.parent && (
              <div>
                <div className="at-label" style={{ marginBottom: 4 }}>
                  Children · {(j.children ?? []).length}
                </div>
                {(j.children ?? []).map((c) => (
                  <div
                    key={c.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '4px 0' }}
                  >
                    <TicketChip id={c.id} onOpen={(id) => setTicketId(id)} />
                    <span style={{ flex: 1 }}>{c.title}</span>
                    <span className="at-hint-sm">{c.holder ?? 'no holder'}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const RANGE_WORDS: Record<TeamRange, string> = { today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days' };

/** What the line beside Team map / Timeline says at each level (design G). */
export function scopeHint(
  level: 'project' | 'story' | 'ticket',
  view: FlowView,
  range: TeamRange | null,
  map: ScopedFlowMap | undefined,
): string {
  const when = range ? RANGE_WORDS[range] : null;
  if (level === 'ticket')
    return view === 'map'
      ? 'the steps of this ticket’s workflow, the AI at each, and what came back'
      : 'One ticket, from the first assignment to done';
  if (level === 'story') {
    const n = map?.tickets ?? 0;
    return view === 'map'
      ? `${n} ticket${n === 1 ? '' : 's'} in this Story · the PM is the hub, the arrow is an assignment`
      : `rows are the Story’s tickets, the PM first · ${when ? when : 'the whole life of the Story'}`;
  }
  if (view === 'timeline') return 'every AI is a lifeline, time runs down · the range is set on the Timeline';
  const n = map?.tickets ?? 0;
  const k = (map?.clusters ?? []).filter((c) => c.storyId).length;
  return `${n} ticket${n === 1 ? '' : 's'} with AI work in ${when ?? 'the range'}${k ? `, in ${k} Stor${k === 1 ? 'y' : 'ies'}` : ''} · the number on an arrow is how many hand-offs`;
}

/**
 * Flow (design/screens/ai-story-flow.md, G to K): how work moves between the AIs, for the whole project, one Story or
 * one ticket. The scope bar on top says which; Team map and Timeline draw it; Live commentary follows it.
 */
export function FlowTab({
  projectId,
  projectName = 'Project',
  range,
  scope,
  view,
  onScope,
  onView,
  actions,
  timelineLink = null,
}: {
  projectId: string;
  projectName?: string;
  /** The picked range; null is the whole life of the Story or the ticket. */
  range: TeamRange | null;
  scope: FlowScope;
  view: FlowView;
  onScope: (s: FlowScope) => void;
  onView: (v: FlowView) => void;
  actions: FlowActions;
  /** Open on the Timeline with this state (a link, or "Open in Timeline" on a ticket). */
  timelineLink?: TimelineLink | null;
}) {
  const level = scopeLevel(scope);
  const [pickerWanted, setPickerWanted] = useState(false);
  const [share, setShare] = useState<FlowCluster | null>(null);
  const [hoverTicket, setHoverTicket] = useState<string | null>(null);
  const [lit, setLit] = useState<LitMark | null>(null);
  const stories = useFlowStories(projectId).data ?? [];
  const projQ = useTeamFlow(projectId, range ?? '7d', {}, { enabled: level === 'project' || pickerWanted });
  const storyQ = useTeamFlow(projectId, range, { story: scope.story }, { enabled: level === 'story' });
  const journeyQ = useTicketJourney(projectId, scope.ticket);
  const detail = useFlowStory(level === 'story' ? scope.story : null).data;
  const journey = journeyQ.data;
  const map = level === 'project' ? projQ.data : level === 'story' ? storyQ.data : undefined;
  const mapQ = level === 'project' ? projQ : storyQ;
  const storyRow = stories.find((x) => x.id === scope.story) ?? null;
  const storyTitle =
    storyRow?.title ?? storyQ.data?.scope?.story?.title ?? journey?.story?.title ?? detail?.title ?? null;
  const storyOf = storyOfTickets(stories);
  const tickets = pickTickets(projQ.data, storyOf);
  const ticketTitle = journey?.ticket.title ?? tickets.find((t) => t.id === scope.ticket)?.title ?? null;

  // a ticket picked without its Story (a link, the Right now strip): its crumb names the Story once it is known
  const knownStory = journey?.story?.id ?? null;
  useEffect(() => {
    if (scope.ticket && !scope.story && knownStory) onScope({ story: knownStory, ticket: scope.ticket });
  }, [scope.ticket, scope.story, knownStory, onScope]);

  const toTicket = (id: string) =>
    onScope({ story: (id === scope.ticket ? scope.story : null) ?? storyOf.get(id)?.id ?? scope.story, ticket: id });
  const toStory = (id: string) => onScope({ story: id, ticket: null });
  const openStoryPage = (id: string) => (actions.onOpenStory ?? actions.onOpenTicket)(id);
  const hovered: FlowScope | null = share?.storyId
    ? { story: share.storyId, ticket: null }
    : hoverTicket
      ? { story: scope.story, ticket: hoverTicket }
      : null;

  const liveRuns = (level === 'ticket' ? journey?.live : map?.live) ?? [];
  const waitsFor =
    level === 'ticket' && scope.ticket
      ? (storyRow?.plan?.items.find((i) => i.ticketId === scope.ticket)?.after ?? [])
      : [];
  const feedScope =
    level === 'ticket'
      ? { kind: 'ticket' as const, id: scope.ticket!, title: ticketTitle }
      : level === 'story'
        ? { kind: 'story' as const, id: scope.story!, title: storyTitle }
        : null;

  const link = buildFlowLink(projectId, { story: scope.story, ticket: scope.ticket, view });
  const pmId = map && level === 'story' ? pmOf(map, storyRow) : null;

  let body: ReactNode;
  if (view === 'timeline') {
    body =
      level === 'story' ? (
        <StoryTimeline
          projectId={projectId}
          storyId={scope.story!}
          story={storyRow}
          range={range}
          lit={lit}
          onHover={setLit}
          onOpenTicket={toTicket}
          onOpenRun={openRun}
        />
      ) : (
        <TimelineTab
          key={scope.ticket ?? 'team'}
          projectId={projectId}
          scopeTicketId={scope.ticket}
          scopeBar
          initial={(scope.ticket ?? null) === (timelineLink?.scope ?? null) ? timelineLink : null}
          actions={{
            onOpenTicket: actions.onOpenTicket,
            onOpenDocsPage: actions.onOpenDocsPage,
            onSeeMap: () => onView('map'),
            onOpenStory: (id) => {
              toTicket(id);
              onView('map');
            },
          }}
        />
      );
  } else if (level === 'ticket') {
    body = (
      <TicketScope
        key={scope.ticket!}
        projectId={projectId}
        ticketId={scope.ticket!}
        setTicketId={toTicket}
        onOpenStory={toStory}
        actions={actions}
      />
    );
  } else if (!map) {
    body = <div className="at-hint">{mapQ.isError ? "Couldn't load the flow." : 'Drawing the team map…'}</div>;
  } else if (level === 'story') {
    body = (
      <>
        <StoryMap
          map={map}
          pmId={pmId}
          story={storyRow}
          decisions={detail?.decisions}
          lit={lit}
          onOpenTicket={toTicket}
          onHoverTicket={setHoverTicket}
          onHoverNode={(id) => setLit(id ? { memberId: id, ticketId: null } : null)}
        />
        <StoryStats map={map} decisions={detail?.decisions} />
        <div className="fs-legend">{STORY_LEGEND}</div>
      </>
    );
  } else {
    body = (
      <MapView
        map={map}
        onPick={toTicket}
        stories={stories}
        share={share}
        onShare={setShare}
        onOpenStory={toStory}
        lit={lit?.memberId ?? null}
        onHoverNode={(id) => setLit(id ? { memberId: id, ticketId: null } : null)}
      />
    );
  }

  return (
    <LiveFeedSplit
      show
      projectId={projectId}
      onOpenTicket={actions.onOpenTicket}
      feed={{
        scope: { story: scope.story, ticket: scope.ticket },
        scopeLabel: feedScope,
        liveRuns,
        lit,
        onHoverLine: setLit,
        onOpenRun: openRun,
        onOpenDocsPage: actions.onOpenDocsPage,
        onShowStory: level === 'ticket' && scope.story ? () => toStory(scope.story!) : undefined,
        waitsFor,
      }}
    >
      <ScopeBar
        projectName={projectName}
        scope={scope}
        storyTitle={storyTitle}
        ticketTitle={ticketTitle}
        view={view}
        onView={onView}
        onScope={onScope}
        hint={scopeHint(level, view, range, map)}
        extra={
          level === 'story' ? (
            <button type="button" className="st-btn st-btn-sm" onClick={() => openStoryPage(scope.story!)}>
              <FsIcon d={FS_ICON.story} />
              Open the Story page
            </button>
          ) : null
        }
        stories={stories}
        tickets={tickets}
        onPickerOpen={() => setPickerWanted(true)}
        link={link}
        hovered={hovered}
      />
      {body}
    </LiveFeedSplit>
  );
}
