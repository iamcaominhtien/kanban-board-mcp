import type { ReactNode } from 'react';
import type {
  ArrowKind,
  Timeline,
  TimelineArrow,
  TimelineBar,
  TimelineLifeline,
  TimelineWait,
  TouchMark,
} from '../../types/aiTeam';
import { PAUSE_COLOR } from '../ai/pausedUi';
import { HEAD_H, assignLanes, clock, lengthText, type Axis } from './timelineLayout';

/** The Timeline's drawing: a header row, a time gutter and the body, all from one axis (ai-team-timeline.md, B and C). */

export const COL = 108;
export const GUTTER = 70;
const TOP = 12;
const BAR_W = 18;

export type Pick = { type: 'bar' | 'arrow' | 'wait' | 'touch' | 'doc' | 'pause'; id: string };

/** A stable key for a picked mark. */
export const pickKey = (p: Pick | null) => (p ? `${p.type}:${p.id}` : '');

// ---------------------------------------------------------------------------
// Colours and glyphs
// ---------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}
function mix(hex: string, other: string, share: number): string {
  const a = rgb(hex);
  const b = rgb(other);
  const m = a.map((v, i) => Math.round(v * (1 - share) + b[i] * share));
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export interface Look {
  fill: string;
  stroke: string;
  text: string;
}

/** The fill, outline and text colours of a lifeline, from the AI's own colour. */
export function lookOf(l: TimelineLifeline): Look {
  const c = l.color && /^#[0-9a-f]{3,6}$/i.test(l.color) ? l.color : '#5B6B60';
  if (l.kind === 'you') return { fill: '#1E2A22', stroke: '#1E2A22', text: '#FFFFFF' };
  if (l.kind === 'autopilot') return { fill: '#FAF7FF', stroke: '#7C5CD6', text: '#5B3AA6' };
  if (l.kind === 'docs') return { fill: '#F1F3F1', stroke: '#9AA8A0', text: '#3A4A3E' };
  return { fill: mix(c, '#FFFFFF', 0.86), stroke: c, text: mix(c, '#000000', 0.42) };
}

const STATE_DOT: Record<string, string> = {
  working: '#2E6F40',
  waiting: '#8A6A12',
  queued: '#5B6B60',
  offline: '#C4432A',
  idle: '#C7D2CB',
  paused: PAUSE_COLOR,
};
export const STATE_WORD: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for you',
  queued: 'queued',
  offline: 'offline',
  idle: 'idle',
  paused: 'paused',
};

const ARROW: Record<ArrowKind, { color: string; dash?: string; glyph: string; word: string }> = {
  assign: { color: '#2F6FB0', glyph: '+', word: 'assigned' },
  mention: { color: '#7C5CD6', glyph: '@', word: '@mention' },
  handoff: { color: '#2E6F40', dash: '5 4', glyph: '›', word: 'hand-off' },
  report: { color: '#9AA8A0', dash: '1.5 3', glyph: '↵', word: 'report back' },
  returned: { color: '#8A6A12', dash: '5 3', glyph: '↵', word: 'returned (round 1)' },
  sent_back: { color: '#C4432A', dash: '5 3', glyph: '↵', word: 'sent back' },
  ask: { color: '#B8860B', glyph: '?', word: 'asks you' },
  perm: { color: '#B8860B', glyph: 'lock', word: 'needs a permission' },
  answer: { color: '#1E2A22', glyph: '✓', word: 'answered' },
  approve: { color: '#1E2A22', glyph: '✓', word: 'approved' },
  deny: { color: '#C4432A', glyph: '×', word: 'refused' },
  auto: { color: '#7C5CD6', glyph: 'A', word: 'Autopilot decided' },
  doc: { color: '#5B6B60', glyph: 'file', word: 'Docs' },
};
/** The words for an arrow's kind. */
export const arrowWord = (k: ArrowKind) => ARROW[k].word;
/** The colour of an arrow's kind. */
export const arrowColor = (k: ArrowKind) => ARROW[k].color;
/** The one-character badge of an arrow's kind (or `lock` / `file` for a drawn glyph). */
export const arrowGlyph = (k: ArrowKind) => ARROW[k].glyph;

const TOUCH: Record<TouchMark | 'start', string> = {
  start: '#2E6F40',
  by_rule: '#2F6FB0',
  needed: '#E8B93A',
  avoidable: '#C4432A',
};

/** A small drawing from a 24 px icon set, centred on (x, y). */
function Glyph({ name, x, y, color, size = 14 }: { name: string; x: number; y: number; color: string; size?: number }) {
  const s = size / 24;
  const paths: Record<string, ReactNode> = {
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
    file: (
      <>
        <path d="M7 3h7l5 5v13H7z" />
        <path d="M14 3v5h5" />
      </>
    ),
    pause: (
      <>
        <rect x="7" y="5" width="3.5" height="14" />
        <rect x="13.5" y="5" width="3.5" height="14" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
      </>
    ),
    spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
    cross: <path d="M6 6l12 12M18 6L6 18" />,
  };
  return (
    <g
      transform={`translate(${x - size / 2},${y - size / 2}) scale(${s})`}
      fill="none"
      stroke={color}
      strokeWidth={2.2 / Math.max(s, 0.5) > 4 ? 3 : 2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

export interface DrawProps {
  data: Timeline;
  axis: Axis;
  lifelines: TimelineLifeline[];
  now: number;
  detailed: boolean;
  selected: Pick | null;
  onPick: (p: Pick | null) => void;
  /** The key (of the same kinds as `Pick`) the keyboard or the mouse is on. */
  onHover: (p: Pick | null, at?: { x: number; y: number }) => void;
  /** Kinds hidden by the Show filter. */
  hidden: ReadonlySet<string>;
  ticketOf: (id: string | null | undefined) => string;
  /** Ids of runs and arrows that just arrived: they are drawn in, once. */
  fresh?: ReadonlySet<string>;
}

/** At most this many things move at once; beyond it the rest are still (design/screens/ai-team-timeline-cases.md, G). */
const MOTION_BUDGET = 20;

/** Height of the diagram body: the axis, its padding and room for the now pill. */
export function bodyHeight(axis: Axis) {
  return axis.height + TOP * 2 + 34;
}

/** The pulse of a live element stops while the whole team is paused. */
const Pulse = ({ children, still }: { children: ReactNode; still: ReactNode }) => (
  <>
    <g className="tl-anim">{children}</g>
    <g className="tl-still">{still}</g>
  </>
);

// ---------------------------------------------------------------------------
// Header row: one box per lifeline
// ---------------------------------------------------------------------------

/** The header row: one box per lifeline with its state dot, and the strip of quiet AIs folded away. */
export function TimelineHeader({
  lifelines,
  folded,
  onOpenFolded,
}: {
  lifelines: TimelineLifeline[];
  /** Quiet AIs folded into one thin strip at the right. */
  folded: number;
  onOpenFolded: () => void;
}) {
  const w = lifelines.length * COL + (folded ? 100 : 0);
  return (
    <svg width={w} height={HEAD_H} role="presentation" style={{ display: 'block' }} className="tl-svg">
      {lifelines.map((l, i) => {
        const look = lookOf(l);
        const cx = COL / 2 + i * COL;
        const word = l.state ? STATE_WORD[l.state] : '';
        return (
          <g key={l.id} data-testid={`tl-head-${l.id}`}>
            <title>{l.state ? `${l.name} · ${word}` : l.name}</title>
            <rect
              x={cx - 46}
              y={4}
              width={92}
              height={40}
              rx={9}
              fill={look.fill}
              stroke={look.stroke}
              strokeWidth={1.5}
            />
            {l.kind === 'you' && <Glyph name="user" x={cx - 30} y={24} color="#FFFFFF" size={15} />}
            {l.kind === 'autopilot' && <Glyph name="spark" x={cx - 31} y={17} color={look.text} size={13} />}
            {l.kind === 'docs' && <Glyph name="file" x={cx - 31} y={24} color={look.text} size={15} />}
            {l.kind === 'ai' && (
              <text x={cx - 33} y={28} fontSize={10} fontWeight={800} fill={look.text} textAnchor="middle">
                {initials(l.name)}
              </text>
            )}
            <text
              x={l.kind === 'autopilot' ? cx - 22 : cx - 20}
              y={l.kind === 'autopilot' ? 20 : 29}
              fontSize={l.kind === 'ai' ? 11.5 : 12}
              fontWeight={700}
              fill={look.text}
            >
              {clip(l.name, l.kind === 'ai' ? 9 : 10)}
            </text>
            {l.kind === 'autopilot' && (
              <text x={cx - 22} y={34} fontSize={9.5} fill={look.text}>
                {l.delegate ? `delegate: ${clip(l.delegate, 7)}` : 'no delegate'}
              </text>
            )}
            {l.state && (
              <>
                <circle cx={cx + 37} cy={14} r={4} fill={STATE_DOT[l.state] ?? '#C7D2CB'} />
                {l.state === 'working' && (
                  <Pulse still={null}>
                    <circle cx={cx + 37} cy={14} r={4} fill="none" stroke="#2E6F40">
                      <animate attributeName="r" values="4;8;4" dur="1.6s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.8;0;0.8" dur="1.6s" repeatCount="indefinite" />
                    </circle>
                  </Pulse>
                )}
              </>
            )}
          </g>
        );
      })}
      {folded > 0 && (
        <g className="tl-folded" onClick={onOpenFolded} style={{ cursor: 'pointer' }} role="button" tabIndex={0}>
          <rect
            x={lifelines.length * COL + 4}
            y={4}
            width={92}
            height={40}
            rx={9}
            fill="#F6F8F6"
            stroke="#C7D2CB"
            strokeDasharray="4 3"
          />
          <text
            x={lifelines.length * COL + 50}
            y={28}
            fontSize={11}
            fontWeight={600}
            fill="#5B6B60"
            textAnchor="middle"
          >
            {folded} quiet AI{folded === 1 ? '' : 's'}
          </text>
        </g>
      )}
    </svg>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const raw = words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
  return raw.toUpperCase() || '?';
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Time gutter
// ---------------------------------------------------------------------------

/** The time labels down the left edge, with the real clock on both sides of every folded stretch. */
export function TimelineGutter({ axis }: { axis: Axis }) {
  return (
    <svg width={GUTTER} height={bodyHeight(axis)} role="presentation" style={{ display: 'block' }} className="tl-svg">
      {axis.breaks.map((b) => (
        <rect key={`b${b.from}`} x={0} y={TOP + b.y} width={GUTTER} height={b.h} fill="#FBFCFB" />
      ))}
      {axis.ticks.map((t) => (
        <text
          key={t.t}
          x={64}
          y={TOP + t.y + 3.5}
          fontSize={10}
          fill={t.midnight ? '#1E2A22' : '#6B7A70'}
          fontWeight={t.midnight ? 700 : 400}
          textAnchor="end"
        >
          {t.label}
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** The diagram: pauses, lifelines, folds, waits, runs, arrows, your marks, Docs nodes and the now line. */
export function TimelineBody(props: DrawProps) {
  const { data, axis, lifelines, now, detailed, selected, onPick, onHover, hidden, ticketOf } = props;
  const fresh = props.fresh ?? new Set<string>();
  const motion = { left: MOTION_BUDGET };
  const may = () => motion.left-- > 0;
  const pausedNow = data.pausedAll;
  const index = new Map(lifelines.map((l, i) => [l.id, i]));
  const cx = (id: string): number => (index.has(id) ? COL / 2 + (index.get(id) as number) * COL : -1);
  const yy = (iso: string | null | undefined, fallback = now): number => TOP + axis.y(ms(iso) ?? fallback);
  const W = lifelines.length * COL;
  const H = bodyHeight(axis);
  const lookById = new Map(lifelines.map((l) => [l.id, lookOf(l)]));
  const barById = new Map(data.bars.map((b) => [b.id, b]));

  const lanes = new Map<string, Map<string, number>>();
  for (const l of lifelines) {
    const mine = data.bars.filter((b) => b.memberId === l.id);
    lanes.set(
      l.id,
      assignLanes(
        mine.map((b) => ({
          id: b.id,
          a: ms(b.startedAt) ?? ms(b.queuedAt) ?? 0,
          b: ms(b.endedAt) ?? now,
        })),
      ),
    );
  }
  const barX = (b: TimelineBar): { x: number; w: number } => {
    const lane = lanes.get(b.memberId)?.get(b.id) ?? 0;
    return { x: cx(b.autopilot ? b.memberId : b.memberId) - BAR_W / 2 + lane * 7, w: lane ? BAR_W - 4 : BAR_W };
  };
  const sel = (type: Pick['type'], id: string) => selected?.type === type && selected.id === id;
  const interact = (p: Pick, label: string) => ({
    'data-pick': `${p.type}:${p.id}`,
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onPick(p);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPick(p);
      }
      if (e.key === 'Escape') onPick(null);
    },
    onMouseEnter: (e: React.MouseEvent) => onHover(p, { x: e.clientX, y: e.clientY }),
    onMouseMove: (e: React.MouseEvent) => onHover(p, { x: e.clientX, y: e.clientY }),
    onMouseLeave: () => onHover(null),
    onFocus: (e: React.FocusEvent) => {
      const r = (e.currentTarget as SVGGraphicsElement).getBoundingClientRect();
      onHover(p, { x: r.right, y: r.top });
    },
    onBlur: () => onHover(null),
  });

  return (
    <svg
      width={W}
      height={H}
      style={{ display: 'block' }}
      className="tl-svg"
      onClick={() => onPick(null)}
      data-testid="tl-body"
    >
      <defs>
        <pattern id="tlhA" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#FFFBEF" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#F0DBA8" strokeWidth="3" />
        </pattern>
        <pattern id="tlhG" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#F6F8F6" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#E3E8E5" strokeWidth="3" />
        </pattern>
        {Object.entries(ARROW).map(([k, v]) => (
          <marker
            key={k}
            id={`ah_${k}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10z" fill={v.color} />
          </marker>
        ))}
      </defs>

      {/* paused stretches: a tinted band from the pause to now (or to Resume), and a line where it was resumed */}
      {data.pauses.map((p) => {
        const y0 = yy(p.from);
        const y1 = p.to ? yy(p.to) : TOP + axis.height;
        return (
          <g
            key={`pause-${p.from}`}
            data-testid="tl-pause-band"
            {...interact({ type: 'pause', id: p.from }, `AI paused since ${clock(ms(p.from) ?? 0)}`)}
          >
            <rect x={0} y={y0} width={W} height={Math.max(y1 - y0, 2)} fill="rgba(180,87,31,0.07)" />
            <line x1={0} x2={W} y1={y0} y2={y0} stroke={PAUSE_COLOR} strokeDasharray="4 3" opacity={0.7} />
            <text x={6} y={y0 + 12} fontSize={10} fontWeight={700} fill={PAUSE_COLOR}>
              AI paused since {clock(ms(p.from) ?? 0)}
            </text>
            {p.to && (
              <>
                <line x1={0} x2={W} y1={y1} y2={y1} stroke="#2E6F40" strokeDasharray="4 3" opacity={0.7} />
                <text x={6} y={y1 - 4} fontSize={10} fontWeight={700} fill="#2E6F40">
                  Resumed {clock(ms(p.to) ?? 0)}
                </text>
              </>
            )}
          </g>
        );
      })}

      {/* lifelines, quiet stretches and the grid */}
      {lifelines.map((l, i) => (
        <line key={`ll-${l.id}`} x1={COL / 2 + i * COL} x2={COL / 2 + i * COL} y1={0} y2={H} stroke="#D5DED8" />
      ))}
      {axis.ticks.map((t) => (
        <line
          key={`g-${t.t}`}
          x1={0}
          x2={W}
          y1={TOP + t.y}
          y2={TOP + t.y}
          stroke={t.midnight ? '#C7D2CB' : '#F1F5F2'}
        />
      ))}
      {axis.breaks.map((b) => {
        const bw = Math.min(W - 40, 560);
        const cxm = W / 2;
        return (
          <g key={`br-${b.from}`} data-testid="tl-break">
            <rect x={0} y={TOP + b.y} width={W} height={b.h} fill={b.paused ? 'rgba(180,87,31,0.06)' : '#FBFCFB'} />
            <polyline points={zigzag(0, W, TOP + b.y + b.h - 6)} fill="none" stroke="#D5DED8" />
            <rect
              x={cxm - bw / 2 + 120}
              y={TOP + b.y + 9}
              width={Math.max(bw - 240, 190)}
              height={22}
              rx={11}
              fill="#fff"
              stroke="#D5DED8"
            />
            <text
              x={cxm + 120 - 0}
              y={TOP + b.y + 24}
              fontSize={11}
              fontWeight={600}
              fill={b.paused ? PAUSE_COLOR : '#5B6B60'}
              textAnchor="middle"
              style={{ transform: 'translateX(0)' }}
            >
              {b.label}
            </text>
          </g>
        );
      })}

      {/* waits: hatched amber for a person, hatched grey for a queue */}
      {(hidden.has('questions') ? [] : data.waits).map((w) => (
        <WaitMark
          key={w.id}
          w={w}
          x={cx(w.memberId)}
          y0={yy(w.from)}
          y1={w.to ? yy(w.to) : TOP + axis.y(now)}
          caps={axis.caps.filter((c) => c.id === w.id)}
          long={((ms(w.to) ?? now) - (ms(w.from) ?? now)) / 60000}
          pausedNow={pausedNow}
          selected={sel('wait', w.id)}
          props={interact(
            { type: 'wait', id: w.id },
            `${w.kind === 'question' ? 'Question' : 'Permission'} waiting for you`,
          )}
          yOffset={TOP}
        />
      ))}

      {/* runs */}
      {data.bars.map((b) => {
        const x0 = cx(b.memberId);
        if (x0 < 0) return null;
        const look = lookById.get(b.memberId) as Look;
        const { x, w } = barX(b);
        const qy = yy(b.queuedAt);
        const sy = b.startedAt ? yy(b.startedAt) : b.state === 'queued' ? qy : qy;
        const ey = b.endedAt ? yy(b.endedAt) : TOP + axis.y(now);
        const live = !b.endedAt && ['running', 'starting', 'needs_input'].includes(b.state);
        const queued = b.state === 'queued';
        const stroke = b.autopilot ? '#7C5CD6' : look.stroke;
        const held = b.heldByPause;
        const fill = queued ? (held ? 'url(#tlhG)' : 'url(#tlhG)') : b.autopilot ? '#FAF7FF' : look.fill;
        const top = queued ? qy : sy;
        const bottom = queued ? TOP + axis.y(now) : Math.max(ey, top + 6);
        const failed = b.endKind === 'failed';
        const label = `${ticketOf(b.ticketId)} · run ${b.number}`;
        return (
          <g
            key={b.id}
            data-testid={`tl-bar-${b.id}`}
            className={fresh.has(b.id) ? 'tl-grow' : undefined}
            {...interact({ type: 'bar', id: b.id }, `${label}, ${b.state}`)}
          >
            {!queued && b.startedAt && sy - qy > 6 && (
              <rect
                x={x}
                y={qy}
                width={w}
                height={sy - qy}
                rx={5}
                fill="url(#tlhG)"
                stroke="#9AA8A0"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}
            <rect
              x={x}
              y={top}
              width={w}
              height={Math.max(bottom - top, 6)}
              rx={5}
              fill={failed ? '#FDECE8' : fill}
              stroke={failed ? '#C4432A' : queued ? '#9AA8A0' : stroke}
              strokeWidth={sel('bar', b.id) ? 2.6 : 1.5}
              strokeDasharray={queued ? '4 3' : b.paused ? '4 3' : undefined}
            />
            {fresh.has(b.id) && b.endedAt && ['failed', 'timeout', 'budget'].includes(b.endKind ?? '') && (
              <rect
                className="tl-flash"
                x={x}
                y={top}
                width={w}
                height={Math.max(bottom - top, 6)}
                rx={5}
                fill="#C4432A"
                pointerEvents="none"
              />
            )}
            {live && !pausedNow && may() && (
              <Pulse still={<circle cx={x + w / 2} cy={bottom} r={4} fill={look.stroke} />}>
                <rect
                  x={x + 3}
                  y={top + 3}
                  width={Math.max(w - 6, 4)}
                  height={Math.max(bottom - top - 6, 2)}
                  rx={3}
                  fill={look.stroke}
                  opacity={0.18}
                >
                  <animate attributeName="opacity" values="0.1;0.32;0.1" dur="1.6s" repeatCount="indefinite" />
                </rect>
                <circle cx={x + w / 2} cy={bottom} r={4} fill={look.stroke}>
                  <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
                </circle>
              </Pulse>
            )}
            {live && (pausedNow || motion.left < 0) && <circle cx={x + w / 2} cy={bottom} r={4} fill={look.stroke} />}
            <RunEnd b={b} x={x + w / 2} y={bottom} />
            {held && queued && <Glyph name="pause" x={x + w / 2} y={top + 10} color="#5B6B60" size={11} />}
            {(bottom - top >= 14 || detailed) && !(x0 < 0) && (
              <text
                x={lanes.get(b.memberId)?.get(b.id) ? x - 6 : x + w + 6}
                y={top + 11}
                fontSize={10}
                fontWeight={700}
                fill={look.text}
                textAnchor={lanes.get(b.memberId)?.get(b.id) ? 'end' : 'start'}
                className="tl-halo"
              >
                {ticketOf(b.ticketId)}
              </text>
            )}
            {detailed && b.steps > 0 && !queued && <StepTicks b={b} x={x + w} top={top} bottom={bottom} />}
          </g>
        );
      })}

      {/* arrows */}
      {data.arrows.map((a) => {
        if (
          hidden.has(a.kind) ||
          (hidden.has('handoffs') &&
            ['assign', 'mention', 'handoff', 'report', 'returned', 'sent_back'].includes(a.kind))
        )
          return null;
        const fx = cx(a.from);
        const tx = cx(a.to);
        if (fx < 0 || tx < 0) return null;
        const meta = ARROW[a.kind];
        const fy = yy(a.at);
        const ty = a.toAt ? yy(a.toAt) : fy;
        const dir = tx >= fx ? 1 : -1;
        const x1 = fx + dir * (a.from === 'you' || a.from === 'autopilot' ? 8 : BAR_W / 2 + 1);
        const x2 = tx - dir * (a.to === 'you' ? 12 : BAR_W / 2 + 3);
        const recv = a.runId ? barById.get(a.runId) : undefined;
        const underWay =
          ['assign', 'mention', 'handoff'].includes(a.kind) &&
          !!recv &&
          (recv.state === 'queued' || recv.state === 'starting') &&
          !pausedNow;
        const mx = (x1 + x2) / 2;
        const my = (fy + Math.max(ty, fy)) / 2;
        const ay = Math.max(ty, fy + (a.kind === 'ask' || a.kind === 'perm' ? 0 : 0));
        const label = arrowLabel(
          a,
          ticketOf,
          ms(a.toAt) != null && ms(a.at) != null ? (ms(a.toAt) as number) - (ms(a.at) as number) : 0,
        );
        const showLabel = detailed || !!label.important;
        const isNew = fresh.has(a.id) && !pausedNow;
        const line = {
          d: `M${x1} ${fy} L${x2} ${ay}`,
          stroke: a.kind === 'deny' || a.denied ? '#C4432A' : meta.color,
          strokeWidth: sel('arrow', a.id) ? 2.6 : 1.7,
          fill: 'none',
          strokeDasharray: meta.dash,
          markerEnd: `url(#ah_${a.kind})`,
        };
        const waiting =
          a.kind === 'ask' && data.waits.some((w) => w.runId === a.runId && w.kind === 'question' && !w.to);
        return (
          <g
            key={a.id}
            data-testid={`tl-arrow-${a.kind}`}
            {...interact({ type: 'arrow', id: a.id }, `${meta.word}${label.text ? `: ${label.text}` : ''}`)}
          >
            <path d={`M${x1} ${fy} L${x2} ${ay}`} stroke="transparent" strokeWidth={10} fill="none" />
            {underWay && may() ? (
              <>
                <g className="tl-anim">
                  <path {...line}>
                    <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.9s" repeatCount="indefinite" />
                  </path>
                </g>
                <g className="tl-still">
                  <path {...line} />
                </g>
              </>
            ) : (
              <path
                {...line}
                className={isNew ? (meta.dash ? 'tl-fade' : 'tl-draw') : undefined}
                style={
                  isNew && !meta.dash ? ({ '--len': Math.hypot(x2 - x1, ay - fy) } as React.CSSProperties) : undefined
                }
              />
            )}
            <g className={isNew ? 'tl-pop tl-late' : undefined}>
              <circle cx={mx} cy={my} r={7.5} fill="#fff" stroke={meta.color} strokeWidth={1.4} />
              {meta.glyph === 'lock' || meta.glyph === 'file' ? (
                <Glyph name={meta.glyph} x={mx} y={my} color={meta.color} size={10} />
              ) : (
                <text
                  x={mx}
                  y={my + 3.6}
                  fontSize={a.kind === 'auto' ? 9 : 11}
                  fontWeight={800}
                  fill={meta.color}
                  textAnchor="middle"
                >
                  {meta.glyph}
                </text>
              )}
            </g>
            {a.kind === 'ask' && cx('you') >= 0 && (
              <g>
                <circle cx={cx('you')} cy={fy} r={8.5} fill="#FEF3D9" stroke="#B8860B" strokeWidth={1.4} />
                <text x={cx('you')} y={fy + 4} fontSize={11} fontWeight={800} fill="#7A5A06" textAnchor="middle">
                  ?
                </text>
                {waiting && !pausedNow && may() && (
                  <g className="tl-anim">
                    <circle cx={cx('you')} cy={fy} r={8.5} fill="none" stroke="#B8860B">
                      <animate attributeName="r" values="8.5;18" dur="2.2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0" dur="2.2s" repeatCount="indefinite" />
                    </circle>
                  </g>
                )}
              </g>
            )}
            {(a.count > 1 || (a.kind === 'sent_back' && a.round > 1)) && (
              <g key={a.count} className={isNew || fresh.has(`${a.id}:n${a.count}`) ? 'tl-pop' : undefined}>
                <rect
                  x={mx + 9}
                  y={my - 7}
                  width={22}
                  height={15}
                  rx={7}
                  fill={a.kind === 'sent_back' ? '#C4432A' : '#3A4A3E'}
                />
                <text x={mx + 20} y={my + 4} fontSize={9.5} fontWeight={800} fill="#fff" textAnchor="middle">
                  ×{a.kind === 'sent_back' ? a.round : a.count}
                </text>
              </g>
            )}
            {showLabel && label.text && (
              <text
                x={mx + (a.count > 1 || a.kind === 'sent_back' ? 36 : 12)}
                y={my + 3.6}
                fontSize={10}
                fontWeight={600}
                fill={a.kind === 'sent_back' ? '#A5321E' : '#3A4A3E'}
                className="tl-halo"
              >
                {label.text}
              </text>
            )}
          </g>
        );
      })}

      {/* your marks, as in Flow and You stepped in */}
      {!hidden.has('touches') &&
        data.touches.map((t) => {
          const x = cx('you');
          if (x < 0) return null;
          const y = yy(t.at);
          return (
            <g key={t.id} {...interact({ type: 'touch', id: t.id }, `You: ${t.what}`)}>
              <rect
                x={x - 7}
                y={y - 7}
                width={14}
                height={14}
                rx={3}
                transform={`rotate(45 ${x} ${y})`}
                fill={TOUCH[t.mark] ?? '#2F6FB0'}
                stroke={sel('touch', t.id) ? '#1E2A22' : 'none'}
                strokeWidth={2}
              />
              <text x={x + 15} y={y + 4} fontSize={10} fontWeight={600} fill="#3A4A3E" className="tl-halo">
                {clip(t.what, 26)}
              </text>
            </g>
          );
        })}

      {/* pages an AI wrote or proposed changes to */}
      {data.docs.map((n) => {
        const x = cx('docs');
        if (x < 0) return null;
        const y = yy(n.at);
        const wait = n.kind === 'proposal' && n.status === 'waiting';
        return (
          <g
            key={n.id}
            {...interact(
              { type: 'doc', id: n.id },
              `${n.title}, ${n.kind === 'proposal' ? 'proposal' : `version ${n.version}`}`,
            )}
          >
            <rect
              x={x - 11}
              y={y - 11}
              width={22}
              height={22}
              rx={5}
              fill={wait ? 'url(#tlhA)' : '#F1F3F1'}
              stroke={wait ? '#E8B93A' : '#9AA8A0'}
              strokeWidth={1.4}
              strokeDasharray={wait ? '4 3' : undefined}
            />
            <Glyph name="file" x={x} y={y} color={wait ? '#7A5A06' : '#3A4A3E'} size={13} />
            <text x={x + 15} y={y + 4} fontSize={10} fontWeight={600} fill="#3A4A3E" className="tl-halo">
              {clip(n.title, 18)}
            </text>
          </g>
        );
      })}

      {/* now */}
      <g data-testid="tl-now">
        <line x1={0} x2={W} y1={TOP + axis.y(now)} y2={TOP + axis.y(now)} stroke={pausedNow ? '#9AA8A0' : '#2E6F40'} />
        {!pausedNow ? (
          <Pulse still={<circle cx={W - 8} cy={TOP + axis.y(now)} r={4} fill="#2E6F40" />}>
            <circle cx={W - 8} cy={TOP + axis.y(now)} r={4} fill="#2E6F40">
              <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
            </circle>
          </Pulse>
        ) : (
          <circle cx={W - 8} cy={TOP + axis.y(now)} r={4} fill="#9AA8A0" />
        )}
      </g>
    </svg>
  );
}

/** The now pill sits in the gutter, level with the now line. */
export function NowPill({ axis, now, paused }: { axis: Axis; now: number; paused: boolean }) {
  const y = TOP + axis.y(now);
  return (
    <svg
      width={GUTTER}
      height={bodyHeight(axis)}
      style={{ display: 'block', position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      role="presentation"
    >
      <rect x={10} y={y - 9} width={56} height={18} rx={4} fill={paused ? '#5B6B60' : '#2E6F40'} />
      <text x={38} y={y + 4} fontSize={10} fontWeight={700} fill="#fff" textAnchor="middle">
        now {clock(now)}
      </text>
    </svg>
  );
}

function zigzag(x0: number, x1: number, y: number): string {
  const pts: string[] = [];
  for (let x = x0, up = false; x <= x1; x += 10, up = !up) pts.push(`${x},${up ? y - 4 : y}`);
  return pts.join(' ');
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function WaitMark({
  w,
  x,
  y0,
  y1,
  caps,
  long,
  pausedNow,
  selected,
  props,
  yOffset,
}: {
  w: TimelineWait;
  x: number;
  y0: number;
  y1: number;
  caps: Axis['caps'];
  long: number;
  pausedNow: boolean;
  selected: boolean;
  props: Record<string, unknown>;
  yOffset: number;
}) {
  if (x < 0) return null;
  const open = !w.to;
  const bw = BAR_W - 4;
  const red = long > 60;
  const mid = (y0 + y1) / 2;
  const word = open ? `waiting ${lengthText(long * 60000)}` : `waited ${lengthText(long * 60000)}`;
  return (
    <g data-testid={`tl-wait-${w.kind}`} {...props}>
      <rect
        x={x - bw / 2}
        y={y0}
        width={bw}
        height={Math.max(y1 - y0, 6)}
        rx={5}
        fill="url(#tlhA)"
        stroke={red ? '#C4432A' : '#E8B93A'}
        strokeWidth={selected ? 2.6 : 1.5}
        strokeDasharray="4 3"
      />
      {open && !pausedNow && (
        <g className="tl-anim">
          <rect x={x - bw / 2} y={y0} width={bw} height={Math.max(y1 - y0, 6)} rx={5} fill="#E8B93A" opacity={0}>
            <animate attributeName="opacity" values="0;0.25;0" dur="2.4s" repeatCount="indefinite" />
          </rect>
        </g>
      )}
      {caps.map((cap, i) => {
        const cy = TOP + cap.y + cap.h / 2;
        return (
          <g key={cap.from}>
            <polyline
              points={`${x - 8},${cy - 3} ${x - 3},${cy} ${x + 3},${cy - 6} ${x + 8},${cy - 3}`}
              fill="none"
              stroke="#7A5A06"
            />
            {i === 0 && (
              <text
                x={x + 12}
                y={cy + 4}
                fontSize={10}
                fontWeight={700}
                fill={red ? '#A5321E' : '#7A5A06'}
                className="tl-halo"
              >
                {word}
              </text>
            )}
          </g>
        );
      })}
      {caps.length === 0 && long > 10 && (
        <text
          x={x + 14}
          y={Math.max(mid, y0 + 12) + yOffset * 0}
          fontSize={10}
          fontWeight={700}
          fill="#7A5A06"
          className="tl-halo"
        >
          {word}
        </text>
      )}
    </g>
  );
}

/** How a run ended, drawn at its foot: a cross, a clock, a black square, a pause or a dollar. */
function RunEnd({ b, x, y }: { b: TimelineBar; x: number; y: number }) {
  switch (b.endKind) {
    case 'failed':
      return <Glyph name="cross" x={x} y={y - 8} color="#C4432A" size={12} />;
    case 'timeout':
      return <Glyph name="clock" x={x} y={y - 8} color="#C0661A" size={12} />;
    case 'stopped':
      return <rect x={x - 4.5} y={y - 11} width={9} height={9} fill="#1E2A22" rx={1} />;
    case 'pause_all':
      return (
        <g>
          <rect x={x - 4.5} y={y - 11} width={9} height={9} fill="#1E2A22" rx={1} />
        </g>
      );
    case 'budget':
      return (
        <text x={x} y={y - 3} fontSize={11} fontWeight={800} fill="#B8860B" textAnchor="middle">
          $
        </text>
      );
    default:
      return null;
  }
}

/** The steps of a run as small ticks along its bar (Detailed). */
function StepTicks({ b, x, top, bottom }: { b: TimelineBar; x: number; top: number; bottom: number }) {
  const n = Math.min(b.steps, Math.max(Math.floor((bottom - top) / 7), 1));
  const ticks = [];
  for (let i = 1; i <= n; i++) {
    const y = top + ((bottom - top) * i) / (n + 1);
    ticks.push(<line key={i} x1={x - 4} x2={x} y1={y} y2={y} stroke="#9AA8A0" />);
  }
  return <g aria-hidden="true">{ticks}</g>;
}

/** The words next to an arrow: what matters at a glance (long waits, returns, questions), everything in Detailed. */
export function arrowLabel(
  a: TimelineArrow,
  ticketOf: (id: string | null | undefined) => string,
  spanMs: number,
): { text: string; important: boolean } {
  const wait = a.waitS != null ? a.waitS / 60 : spanMs / 60000;
  switch (a.kind) {
    case 'sent_back':
      return { text: `sent back, ${ordinal(a.round)} time`, important: true };
    case 'returned':
      return { text: 'returned, round 1', important: false };
    case 'ask':
      return { text: `question on ${ticketOf(a.ticketId)}`, important: true };
    case 'perm':
      return { text: a.label ?? 'needs a permission', important: false };
    case 'auto':
      return {
        text: `${a.by ? `${a.by} ` : ''}${a.denied ? 'refused' : 'decided'} after ${Math.max(Math.round(wait), 1)} min`,
        important: true,
      };
    case 'answer':
    case 'approve':
      return {
        text: `${a.kind === 'answer' ? 'answered' : 'approved'} after ${Math.max(Math.round(wait), 1)} min`,
        important: wait > 10,
      };
    case 'deny':
      return { text: 'refused', important: true };
    case 'doc':
      return { text: a.label ?? 'Docs', important: false };
    default:
      return {
        text: wait > 10 ? `waited ${Math.round(wait)} min` : `${ARROW[a.kind].word} ${ticketOf(a.ticketId)}`.trim(),
        important: wait > 10,
      };
  }
}

function ordinal(n: number): string {
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}
