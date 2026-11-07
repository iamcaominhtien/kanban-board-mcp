import { useEffect, useMemo, useState } from 'react';
import { useAiRuns, useTicketRuns } from '../../../api/ai';
import type { AiRunFull } from '../../../types/ai';
import {
  buildTimeline,
  LEAD,
  YOU,
  type ArrowKind,
  type BarState,
  type TimelineBar,
  type TimelineLane,
} from './timelineModel';
import './design/designBlocks.css';

const W = 860;
const GUTTER = 92;
const TOP = 70;
const ROW = 40;
const BAR_W = 18;
const MIN_BAR = 22;
const SAME_ROW_MS = 1500;

interface Palette {
  fill: string;
  stroke: string;
  text: string;
}

/** The canvas design's colours: Dev green, Tester amber, Reviewer indigo, PM blue; more roles go round again. */
const ROLE_PALETTES: Palette[] = [
  { fill: '#E6F2EA', stroke: '#2E6F40', text: '#1F5A31' },
  { fill: '#FEF3D9', stroke: '#B8860B', text: '#7A5A06' },
  { fill: '#E9EAF7', stroke: '#5B5FA8', text: '#3F4390' },
  { fill: '#E8F0FA', stroke: '#2F6FB0', text: '#1F4F82' },
  { fill: '#F8E9EE', stroke: '#B04A6A', text: '#7C2E48' },
];
const DARK: Palette = { fill: '#1E2A22', stroke: '#1E2A22', text: '#FFFFFF' };
const LEAD_BAR: Palette = { fill: '#E9EDEA', stroke: '#1E2A22', text: '#1E2A22' };

const ARROW: Record<ArrowKind, { color: string; dash?: string }> = {
  assign: { color: '#2F6FB0' },
  handoff: { color: '#2E6F40' },
  return: { color: '#8A6A12' },
  ask: { color: '#B8860B', dash: '5 4' },
  answer: { color: '#1E2A22' },
  report: { color: '#9AA8A0', dash: '5 4' },
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** The current time, moving while a run is going (a run's bar grows to "now"). */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The ticket's Timeline from its runs, in the look of the canvas design (AiTimelineCases): a lane for the person, the
 * lead and each role it called, a bar for each run and each call, an arrow for each hand-off. Rows follow the order of
 * the events, not the clock, so a quiet hour takes no more room than a minute.
 */
export function TicketTimeline({ ticketId }: { ticketId: string }) {
  const history = useTicketRuns(ticketId);
  const ids = useMemo(
    () =>
      (history.data ?? [])
        .filter((r) => r.kind === 'team')
        .slice(0, 3)
        .map((r) => r.id),
    [history.data],
  );
  const loaded = useAiRuns(ids);
  const full = loaded.map((q) => q.data).filter((r): r is AiRunFull => !!r);
  const running = full.some((r) => ['queued', 'starting', 'running', 'needs_input'].includes(r.state));
  const now = useNow(running);
  const model = useMemo(() => buildTimeline(full, now), [full, now]);

  return (
    <div className="dz dz-tl" data-testid="ticket-timeline-picture">
      <div
        style={{
          padding: '6px 10px',
          borderRadius: '8px',
          background: '#E6F2EA',
          fontSize: '12px',
          marginBottom: '6px',
        }}
        data-testid="timeline-banner"
      >
        <b>Now</b> &middot; {model.banner || 'No AI has worked on this ticket yet'}
      </div>
      {model.lanes.length > 0 && (
        <div style={{ border: '1px solid #E3E8E5', borderRadius: '10px', overflow: 'hidden' }}>
          <Picture model={model} now={now} />
        </div>
      )}
    </div>
  );
}

function Picture({ model, now }: { model: ReturnType<typeof buildTimeline>; now: number }) {
  const { lanes, bars, arrows, active } = model;
  const spacing = (W - GUTTER - 24) / lanes.length;
  const boxW = Math.min(102, spacing - 12);
  const cx = (key: string) => GUTTER + (lanes.findIndex((l) => l.key === key) + 0.5) * spacing;

  // one row per moment (moments within a second and a half share a row)
  const stamps = [
    ...bars.flatMap((b) => (b.end === null ? [b.start] : [b.start, b.end])),
    ...arrows.map((a) => a.at),
  ].sort((a, b) => a - b);
  const rows: number[] = [];
  for (const t of stamps) if (!rows.length || t - rows[rows.length - 1] > SAME_ROW_MS) rows.push(t);
  const rowOf = (t: number) => {
    let best = 0;
    for (let i = 0; i < rows.length; i++) if (Math.abs(rows[i] - t) <= Math.abs(rows[best] - t)) best = i;
    return best;
  };
  const yRow = (t: number) => TOP + rowOf(t) * ROW;
  const nowY = TOP + rows.length * ROW;
  const bottom = active ? nowY : TOP + Math.max(rows.length - 1, 0) * ROW + MIN_BAR;
  const height = bottom + 34;
  const palette = (key: string): Palette => {
    if (key === LEAD || key === YOU) return LEAD_BAR;
    const i = lanes.filter((l) => l.kind === 'role').findIndex((l) => l.key === key);
    return ROLE_PALETTES[Math.max(i, 0) % ROLE_PALETTES.length];
  };
  const barBox = (b: TimelineBar) => {
    const y1 = yRow(b.start);
    const y2 = b.end === null ? nowY : Math.max(yRow(b.end), y1 + MIN_BAR);
    return { y1, y2 };
  };
  const perRow: Record<number, number> = {};

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}
      role="img"
      aria-label="Timeline of the ticket's AI runs"
    >
      <defs>
        <pattern id="tt_hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#F6F8F6" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#E3E8E5" strokeWidth="3" />
        </pattern>
        {(Object.keys(ARROW) as ArrowKind[]).map((k) => (
          <marker
            key={k}
            id={`tt_ah_${k}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10z" fill={ARROW[k].color} />
          </marker>
        ))}
      </defs>
      {lanes.map((l) => (
        <line
          key={l.key}
          x1={cx(l.key)}
          y1={46}
          x2={cx(l.key)}
          y2={bottom}
          stroke="#D5DED8"
          strokeWidth="1.4"
          strokeDasharray="2 4"
        />
      ))}
      {rows.map((t, i) =>
        i === 0 || clock(t) !== clock(rows[i - 1]) ? (
          <text key={`t${i}`} x={46} y={TOP + i * ROW + 3.5} fontSize="10" fill="#6B7A70" textAnchor="end">
            {clock(t)}
          </text>
        ) : null,
      )}
      {lanes.map((l) => (
        <LaneBox
          key={`h${l.key}`}
          lane={l}
          x={cx(l.key)}
          boxW={boxW}
          palette={l.kind === 'role' ? palette(l.key) : DARK}
        />
      ))}
      {bars.map((b, i) => {
        const { y1, y2 } = barBox(b);
        return <Bar key={`b${i}`} bar={b} x={cx(b.lane) - BAR_W / 2} y1={y1} y2={y2} palette={palette(b.lane)} />;
      })}
      {arrows.map((a, i) => {
        const y = yRow(a.at);
        const n = (perRow[y] = (perRow[y] ?? -1) + 1);
        const dir = cx(a.to) > cx(a.from) ? 1 : -1;
        const y1 = y + n * 6;
        const style = ARROW[a.kind];
        const arrow = (moving: boolean) => (
          <path
            d={`M ${cx(a.from) + dir * (BAR_W / 2 + 1)} ${y1} L ${cx(a.to) - dir * (BAR_W / 2 + 2)} ${y1 + 3}`}
            stroke={style.color}
            strokeWidth="1.7"
            fill="none"
            strokeDasharray={a.live ? '5 4' : style.dash}
            markerEnd={`url(#tt_ah_${a.kind})`}
            data-arrow={a.kind}
          >
            {moving && (
              <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.9s" repeatCount="indefinite" />
            )}
          </path>
        );
        // a waiting arrow moves; under "reduce motion" the design shows the still copy (tl-still) instead
        return a.live ? (
          <g key={`a${i}`}>
            <g className="tl-anim">{arrow(true)}</g>
            <g className="tl-still">{arrow(false)}</g>
          </g>
        ) : (
          <g key={`a${i}`}>{arrow(false)}</g>
        );
      })}
      {active && (
        <g>
          <line x1={83} y1={nowY} x2={W - 6} y2={nowY} stroke="#2E6F40" strokeWidth="1.4" strokeDasharray="3 3" />
          <rect x={10} y={nowY - 11} width={73} height={22} rx={11} fill="#2E6F40" />
          <text x={46.5} y={nowY + 4} fontSize="10" fontWeight="800" fill="#fff" textAnchor="middle">
            now {clock(now)}
          </text>
          <g className="tl-anim">
            <circle cx={W - 14} cy={nowY} r="4" fill="#2E6F40">
              <animate attributeName="r" values="3;7;3" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite" />
            </circle>
          </g>
          <g className="tl-still">
            <circle cx={W - 14} cy={nowY} r="4" fill="#2E6F40" />
          </g>
        </g>
      )}
    </svg>
  );
}

/** The box at the top of a lane: dark for the person and the lead, the role's colour for a role. */
function LaneBox({ lane, x, boxW, palette }: { lane: TimelineLane; x: number; boxW: number; palette: Palette }) {
  const left = x - boxW / 2;
  return (
    <g data-lane={lane.key}>
      <rect
        x={left}
        y={4}
        width={boxW}
        height={40}
        rx={9}
        fill={palette.fill}
        stroke={palette.stroke}
        strokeWidth="1.5"
      />
      {lane.kind === 'you' ? (
        <g fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" transform={`translate(${left + 11} 15)`}>
          <circle cx="7" cy="5" r="3.4" />
          <path d="M1 18c0-3.6 2.7-6 6-6s6 2.4 6 6" />
        </g>
      ) : (
        <text x={left + 17} y={28} fontSize="10" fontWeight="800" fill={palette.text} textAnchor="middle">
          {lane.code}
        </text>
      )}
      <text x={left + 32} y={29} fontSize="12" fontWeight="700" fill={palette.text}>
        {lane.label}
      </text>
      {lane.kind !== 'you' && (
        <>
          <circle cx={left + boxW - 9} cy={16} r="4" fill={lane.working ? '#2E6F40' : '#C7D2CB'} />
          {lane.working && (
            <circle
              cx={left + boxW - 9}
              cy={16}
              r="4"
              fill="none"
              stroke="#2E6F40"
              strokeWidth="1.5"
              className="tl-anim"
            >
              <animate attributeName="r" values="4;9" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;0" dur="1.6s" repeatCount="indefinite" />
            </circle>
          )}
        </>
      )}
    </g>
  );
}

const BAR_LOOK: Record<BarState, { dash?: string; stroke?: string; fill?: string }> = {
  live: {},
  done: {},
  failed: { stroke: '#C4432A', fill: '#FBEAE6' },
  queued: { dash: '4 3', stroke: '#9AA8A0', fill: 'url(#tt_hatch)' },
};

/** A run or a call: a rounded bar on its lane, its label beside it, a breathing fill while it goes on. */
function Bar({ bar, x, y1, y2, palette }: { bar: TimelineBar; x: number; y1: number; y2: number; palette: Palette }) {
  const look = BAR_LOOK[bar.state];
  const h = y2 - y1;
  return (
    <g data-bar={bar.state}>
      <rect
        x={x}
        y={y1}
        width={BAR_W}
        height={h}
        rx={5}
        fill={look.fill ?? palette.fill}
        stroke={look.stroke ?? palette.stroke}
        strokeWidth="1.5"
        strokeDasharray={look.dash}
      />
      {bar.state === 'live' && (
        <g className="tl-anim">
          <rect
            x={x + 3}
            y={y1 + 3}
            width={BAR_W - 6}
            height={Math.max(h - 6, 1)}
            rx={3}
            fill={palette.stroke}
            opacity="0.18"
          >
            <animate attributeName="opacity" values="0.1;0.32;0.1" dur="1.8s" repeatCount="indefinite" />
          </rect>
          <circle cx={x + BAR_W / 2} cy={y2} r="4" fill={palette.stroke}>
            <animate attributeName="r" values="3;6;3" dur="1.4s" repeatCount="indefinite" />
          </circle>
        </g>
      )}
      {bar.state === 'live' && (
        <g className="tl-still">
          <circle cx={x + BAR_W / 2} cy={y2} r="4" fill={palette.stroke} />
        </g>
      )}
      <text x={x + BAR_W + 6} y={y1 + 11} fontSize="10" fontWeight="700" fill={palette.text}>
        {bar.label}
      </text>
    </g>
  );
}
