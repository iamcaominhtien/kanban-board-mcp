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
import { HEAD_H, assignLanes, clock, lengthText, type Axis } from './timelineLayout';
import { BAR_W, arrowEnds, barAt, laneBox } from './timelineGeometry';
import { Placer, clipToWidth, staggerArrows, textWidth, type PlacedLabel, type Spot } from './timelinePlace';
import { ascendingText } from '../../utils/sorted';

/**
 * The Timeline's drawing: a header row, a time gutter and the body, all from one axis (ai-team-timeline.md, B and C;
 * ai-team-timeline-cases.md, E to I; ai-paused.md, D4). Sizes, colours and offsets are the ones of the design's SVG.
 * Where marks would collide, timelinePlace.ts decides where badges and labels go.
 */

export const COL = 108;
export const GUTTER = 70;
/** Room on each side of the lanes: the now dot sits at the right edge of the last lane. */
export const PAD = 8;
const TOP = 12;

/** Width of the diagram for `n` lanes. */
export const lanesWidth = (n: number) => n * COL + 2 * PAD;
/** Centre of lane `i`. */
const laneX = (i: number) => PAD + COL / 2 + i * COL;

/** One label per cluster of marks that sit closer than a mark is tall: "Changed settings ×3", not three texts on top of each other. */
export function touchLabels<T extends { what: string; at: string }>(
  touches: T[],
  yy: (at: string) => number,
  gap = 15,
): { t: T; label: string | null }[] {
  const sorted = [...touches].sort((a, b) => yy(a.at) - yy(b.at));
  const out: { t: T; label: string | null }[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && yy(sorted[end + 1].at) - yy(sorted[end].at) < gap) end++;
    const group = sorted.slice(start, end + 1);
    const same = group.every((g) => g.what === group[0].what);
    const label = same
      ? `${clip(group[0].what, group.length > 1 ? 22 : 26)}${group.length > 1 ? ` ×${group.length}` : ''}`
      : `${clip(group[0].what, 18)} +${group.length - 1} more`;
    group.forEach((t, i) => out.push({ t, label: i === group.length - 1 ? label : null }));
    start = end + 1;
  }
  return out;
}

export type Pick = { type: 'bar' | 'arrow' | 'wait' | 'touch' | 'doc' | 'pause'; id: string };

/** A stable key for a picked mark. */
export const pickKey = (p: Pick | null) => (p ? `${p.type}:${p.id}` : '');

// ---------------------------------------------------------------------------
// Colours and glyphs
// ---------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h.padEnd(6, '0');
  return [Number.parseInt(f.slice(0, 2), 16), Number.parseInt(f.slice(2, 4), 16), Number.parseInt(f.slice(4, 6), 16)];
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

/** The tints the design gives the AI colours of the Team map (fill, words); other colours are tinted to match. */
const TINTS: Record<string, [string, string]> = {
  '#2F6FB0': ['#E8F1FA', '#244E78'],
  '#0F8B8D': ['#DFF3F3', '#0B5F61'],
  '#C2417A': ['#FCE8F1', '#8A2655'],
  '#2E6F40': ['#E6F2EA', '#1F5A31'],
  '#B8860B': ['#FEF3D9', '#7A5A06'],
  '#5B5FA8': ['#E9EAF7', '#3F4390'],
  '#7C5CD6': ['#FAF7FF', '#5B3AA6'],
};

/** The fill, outline and text colours of a lifeline, from the AI's own colour. */
export function lookOf(l: Pick2<TimelineLifeline, 'kind' | 'color'>): Look {
  const c = l.color && /^#[0-9a-f]{3,6}$/i.test(l.color) ? l.color.toUpperCase() : '#5B6B60';
  if (l.kind === 'you') return { fill: '#1E2A22', stroke: '#1E2A22', text: '#FFFFFF' };
  if (l.kind === 'autopilot') return { fill: '#FAF7FF', stroke: '#7C5CD6', text: '#5B3AA6' };
  if (l.kind === 'docs') return { fill: '#F1F3F1', stroke: '#9AA8A0', text: '#3A4A3E' };
  const t = TINTS[c];
  if (t) return { fill: t[0], stroke: c, text: t[1] };
  return { fill: mix(c, '#FFFFFF', 0.9), stroke: c, text: mix(c, '#000000', 0.3) };
}
type Pick2<T, K extends keyof T> = { [P in K]: T[P] };

const STATE_DOT: Record<string, string> = {
  working: '#2E6F40',
  waiting: '#8A6A12',
  queued: '#5B6B60',
  offline: '#C4432A',
  idle: '#C7D2CB',
  // the whole team paused: every header goes grey (ai-team-timeline-cases.md, I)
  paused: '#9AA8A0',
};
export const STATE_WORD: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for you',
  queued: 'queued',
  offline: 'offline',
  idle: 'idle',
  paused: 'paused',
};

const ARROW: Record<ArrowKind, { color: string; dash?: string; glyph: string; word: string; label: string }> = {
  assign: { color: '#2F6FB0', glyph: '+', word: 'assigned', label: '#244E78' },
  mention: { color: '#7C5CD6', glyph: '@', word: '@mention', label: '#5B3AA6' },
  handoff: { color: '#2E6F40', glyph: '›', word: 'hand-off', label: '#1F5A31' },
  report: { color: '#9AA8A0', dash: '1.5 3', glyph: '↵', word: 'report back', label: '#3A4A3E' },
  returned: { color: '#8A6A12', dash: '5 3', glyph: '↵', word: 'returned (round 1)', label: '#8A6A12' },
  sent_back: { color: '#C4432A', dash: '5 3', glyph: '↵', word: 'sent back', label: '#A5321E' },
  skip: { color: '#7C5CD6', glyph: '»', word: 'hand-off, a step skipped', label: '#5B3AA6' },
  ask: { color: '#B8860B', glyph: '?', word: 'asks you', label: '#7A5A06' },
  perm: { color: '#B8860B', glyph: 'lock', word: 'needs a permission', label: '#7A5A06' },
  answer: { color: '#1E2A22', glyph: '✓', word: 'answered', label: '#1E2A22' },
  approve: { color: '#1E2A22', glyph: '✓', word: 'approved', label: '#1E2A22' },
  deny: { color: '#C4432A', glyph: '×', word: 'refused', label: '#A5321E' },
  auto: { color: '#7C5CD6', glyph: 'A', word: 'Autopilot decided', label: '#3A4A3E' },
  doc: { color: '#5B6B60', glyph: 'file', word: 'Docs', label: '#3A4A3E' },
};
/** Work handed to a person is amber, like everything that waits for you (the design's "to human" arrow). */
const TO_HUMAN = '#B8860B';
const MOVES_WORK: ReadonlySet<ArrowKind> = new Set(['assign', 'mention', 'handoff', 'skip', 'report', 'returned']);
/** The Show menu's groups. */
const HANDOFF_KINDS: ReadonlySet<ArrowKind> = new Set([
  'assign',
  'mention',
  'handoff',
  'skip',
  'report',
  'returned',
  'sent_back',
]);
const QUESTION_KINDS: ReadonlySet<ArrowKind> = new Set(['ask', 'answer', 'perm', 'approve', 'deny', 'auto']);

/** The words for an arrow's kind. */
export const arrowWord = (k: ArrowKind) => ARROW[k].word;
/** The colour of an arrow's kind. */
export const arrowColor = (k: ArrowKind) => ARROW[k].color;
/** The one-character badge of an arrow's kind (or `lock` / `file` for a drawn glyph). */
export const arrowGlyph = (k: ArrowKind) => ARROW[k].glyph;
/** The colour an arrow is drawn in: its kind's, amber when it hands work to you, red when refused. */
export function arrowStroke(a: Pick2<TimelineArrow, 'kind' | 'to' | 'denied'>): string {
  if (a.kind === 'deny' || a.denied) return '#C4432A';
  if (a.to === 'you' && MOVES_WORK.has(a.kind)) return TO_HUMAN;
  return ARROW[a.kind].color;
}

const TOUCH: Record<TouchMark | 'start', string> = {
  start: '#2E6F40',
  by_rule: '#2F6FB0',
  needed: '#E8B93A',
  avoidable: '#C4432A',
};

const GLYPHS: Record<string, ReactNode> = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
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
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
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
};

/** A drawing from the 24 px icon set, centred on (x, y); `stroke` is in the icon's own units, as in the design. */
function Glyph({
  name,
  x,
  y,
  color,
  size = 14.88,
  stroke = 2.2,
}: {
  name: string;
  x: number;
  y: number;
  color: string;
  size?: number;
  stroke?: number;
}) {
  return (
    <g
      transform={`translate(${x - size / 2},${y - size / 2}) scale(${size / 24})`}
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
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
  /** One ticket on show: bars say "run 3" and arrows leave the ticket out, as in the design */
  scoped?: boolean;
  /** Ids of runs and arrows that just arrived: they are drawn in, once. */
  fresh?: ReadonlySet<string>;
}

/** At most this many things move at once; beyond it the rest are still (design/screens/ai-team-timeline-cases.md, G). */
const MOTION_BUDGET = 20;

/** Height of the diagram body: the axis, its padding and room for the now pill. */
export function bodyHeight(axis: Axis) {
  // below the "now" line: room for its pill and a bar's head, no more (it was 34 more)
  return axis.height + TOP * 2 + 6;
}

/** A live element moves; with reduced motion it shows its still picture instead (timeline.css). */
const Pulse = ({ children, still }: { children: ReactNode; still: ReactNode }) => (
  <>
    <g className="tl-anim">{children}</g>
    {still != null && <g className="tl-still">{still}</g>}
  </>
);

// ---------------------------------------------------------------------------
// Header row: one box per lifeline
// ---------------------------------------------------------------------------

/** Room for the words of a header box: from 20 px left of its centre to its state dot. */
const HEAD_TEXT_W = 54;

/** The header row: one box per lifeline with its state dot, and the strip of quiet AIs folded away. */
export function TimelineHeader({
  lifelines,
  folded,
  onOpenFolded,
  paused = false,
}: {
  lifelines: TimelineLifeline[];
  /** Quiet AIs folded into one thin strip at the right. */
  folded: number;
  onOpenFolded: () => void;
  /** The whole team is paused: every dot is grey and nothing moves. */
  paused?: boolean;
}) {
  const w = lanesWidth(lifelines.length) + (folded ? 100 : 0);
  return (
    <svg width={w} height={HEAD_H} role="presentation" style={{ display: 'block' }} className="tl-svg">
      {lifelines.map((l, i) => {
        // the team's lead has a dark box like You: it is the one who talks to the person
        const look = l.lead ? { fill: '#1E2A22', stroke: '#1E2A22', text: '#FFFFFF' } : lookOf(l);
        const cx = laneX(i);
        const state = paused && l.kind === 'ai' ? 'paused' : l.state;
        const word = state ? STATE_WORD[state] : '';
        const name = clipToWidth(l.name, l.kind === 'autopilot' ? 64 : HEAD_TEXT_W + (state ? 0 : 12), 12, 700);
        return (
          <g key={l.id} data-testid={`tl-head-${l.id}`}>
            <title>{state ? `${l.name} · ${word}` : l.name}</title>
            <rect
              x={cx - 46}
              y={4}
              width={92}
              height={40}
              rx={9}
              fill={look.fill}
              stroke={look.stroke}
              strokeWidth={1.5}
              strokeDasharray={l.kind === 'autopilot' ? '4 3' : undefined}
            />
            {l.kind === 'you' && <Glyph name="user" x={cx - 33} y={24} color="#FFFFFF" />}
            {l.kind === 'autopilot' && <Glyph name="spark" x={cx - 33} y={24} color={look.text} />}
            {l.kind === 'docs' && <Glyph name="file" x={cx - 33} y={24} color={look.text} />}
            {l.kind === 'ai' && (
              <text x={cx - 33} y={28} fontSize={10} fontWeight={800} fill={look.text} textAnchor="middle">
                {initials(l.name)}
              </text>
            )}
            <text x={cx - 20} y={l.kind === 'autopilot' ? 24 : 29} fontSize={12} fontWeight={700} fill={look.text}>
              {name}
            </text>
            {l.kind === 'autopilot' && <DelegateLine x={cx - 20} delegate={l.delegate ?? null} color={look.text} />}
            {state && (
              <>
                <circle cx={cx + 37} cy={16} r={4} fill={STATE_DOT[state] ?? '#C7D2CB'} />
                {state === 'working' && (
                  <Pulse still={null}>
                    <circle
                      cx={cx + 37}
                      cy={16}
                      r={4}
                      fill="none"
                      stroke="#2E6F40"
                      strokeWidth={1.5}
                      data-testid="tl-head-ring"
                    >
                      <animate attributeName="r" values="4;9" dur="1.6s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0" dur="1.6s" repeatCount="indefinite" />
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
            x={lanesWidth(lifelines.length) + 4}
            y={4}
            width={92}
            height={40}
            rx={9}
            fill="#F1F3F1"
            stroke="#C7D2CB"
            strokeDasharray="4 3"
          />
          <text
            x={lanesWidth(lifelines.length) + 50}
            y={28}
            fontSize={11}
            fontWeight={700}
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

/** "delegate: PM" under Autopilot. A name a little too long is squeezed to the box; a longer one is cut short. */
function DelegateLine({ x, delegate, color }: { x: number; delegate: string | null; color: string }) {
  const room = 64;
  let text = delegate ? `delegate: ${delegate}` : 'no delegate';
  let w = textWidth(text, 9.5, 600);
  if (delegate && w > room * 1.15) {
    text = `delegate: ${clipToWidth(delegate, room * 1.15 - textWidth('delegate: ', 9.5, 600), 9.5, 600)}`;
    w = textWidth(text, 9.5, 600);
  }
  return (
    <text
      x={x}
      y={38}
      fontSize={9.5}
      fontWeight={600}
      fill={color}
      {...(w > room ? { textLength: room, lengthAdjust: 'spacingAndGlyphs' } : {})}
    >
      {delegate && text !== `delegate: ${delegate}` ? <title>{`delegate: ${delegate}`}</title> : null}
      {text}
    </text>
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
        <rect
          key={`b${b.from}`}
          x={0}
          y={TOP + b.y}
          width={GUTTER}
          height={b.h}
          fill={b.paused ? '#FDF0E6' : '#FBFCFB'}
          opacity={b.paused ? 0.75 : 1}
        />
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

interface BarGeo {
  b: TimelineBar;
  x: number;
  w: number;
  lane: number;
  qy: number;
  top: number;
  bottom: number;
  queued: boolean;
  live: boolean;
  look: Look;
}

interface ArrowGeo {
  a: TimelineArrow;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dash?: string;
  underWay: boolean;
  /** An open question: a "?" on your lifeline that ripples. */
  askOpen: boolean;
  badge: string | null;
  label: { text: string; important: boolean };
  /** Where the purple A of an Autopilot decision sits on the Autopilot lifeline. */
  autoAt: { x: number; y: number } | null;
}

/** How a finished run looks, by how it ended (C and I of the design). */
function endLook(b: TimelineBar, look: Look): { fill: string; stroke: string; dash?: string; text: string } {
  if (b.state === 'queued')
    return { fill: 'url(#tlhG)', stroke: '#9AA8A0', dash: '4 3', text: b.heldByPause ? '#5B6B60' : look.text };
  switch (b.endKind) {
    case 'failed':
    case 'memory':
      return { fill: '#FDECE8', stroke: '#C4432A', text: '#A5321E' };
    case 'timeout':
      return { fill: '#FFF1E0', stroke: '#E8861A', text: '#8A4B08' };
    case 'stopped':
    case 'pause_all':
      return { fill: '#F1F3F1', stroke: '#1E2A22', text: '#1E2A22' };
    case 'budget':
      return { fill: '#FEF3D9', stroke: '#B8860B', dash: '4 3', text: '#7A5A06' };
    default:
      if (b.paused) return { fill: '#F1F3F1', stroke: '#9AA8A0', dash: '4 3', text: '#5B6B60' };
      if (b.autopilot) return { fill: '#FAF7FF', stroke: '#7C5CD6', text: look.text };
      return { fill: look.fill, stroke: look.stroke, text: look.text };
  }
}

/** The diagram: pauses, lifelines, folds, runs, waits, arrows, your marks, Docs nodes and the now line. */
export function TimelineBody(props: DrawProps) {
  const { data, axis, lifelines, now, detailed, selected, onPick, onHover, hidden } = props;
  const ticketOf = props.scoped ? () => '' : props.ticketOf;
  const fresh = props.fresh ?? new Set<string>();
  const motion = { left: MOTION_BUDGET };
  const may = () => motion.left-- > 0;
  const pausedNow = data.pausedAll;
  const index = new Map(lifelines.map((l, i) => [l.id, i]));
  const cx = (id: string): number => (index.has(id) ? laneX(index.get(id) as number) : -1);
  const yy = (iso: string | null | undefined, fallback = now): number => TOP + axis.y(ms(iso) ?? fallback);
  const nowY = TOP + axis.y(now);
  const W = lanesWidth(lifelines.length);
  const H = bodyHeight(axis);
  const lookById = new Map(lifelines.map((l) => [l.id, lookOf(l)]));
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

  // ---- runs ----------------------------------------------------------------
  const bars: BarGeo[] = [];
  for (const l of lifelines) {
    const mine = data.bars.filter((b) => b.memberId === l.id);
    const lanes = assignLanes(
      mine.map((b) => ({ id: b.id, a: ms(b.startedAt) ?? ms(b.queuedAt) ?? 0, b: ms(b.endedAt) ?? now })),
    );
    for (const b of mine) {
      const lane = lanes.get(b.id) ?? 0;
      const { x: bx, w } = laneBox(laneX(index.get(l.id) as number), lane);
      const queued = b.state === 'queued';
      const qy = yy(b.queuedAt ?? b.startedAt);
      const sy = b.startedAt ? yy(b.startedAt) : qy;
      const ey = b.endedAt ? yy(b.endedAt) : nowY;
      const top = queued ? qy : sy;
      const bottom = queued ? nowY : Math.max(ey, top + 6);
      bars.push({
        b,
        x: bx,
        w,
        lane,
        qy,
        top,
        bottom: Math.max(bottom, top + 6),
        queued,
        live: !b.endedAt && ['running', 'starting', 'needs_input'].includes(b.state),
        look: lookById.get(l.id) as Look,
      });
    }
  }
  const barById = new Map(bars.map((g) => [g.b.id, g]));

  // ---- waits: drawn over the run; a narrow strip beside it when the run keeps going -----------------------------
  const waits = (hidden.has('questions') ? [] : data.waits)
    .map((w) => {
      const x = cx(w.memberId);
      if (x < 0) return null;
      const y0 = yy(w.from);
      const y1 = w.to ? yy(w.to) : nowY;
      const runGoesOn = bars.some(
        (g) => g.b.memberId === w.memberId && !g.queued && g.top <= y0 + 1 && g.bottom >= y1 - 1 && g.bottom > y1 + 2,
      );
      const longMin = ((ms(w.to) ?? now) - (ms(w.from) ?? now)) / 60000;
      return {
        w,
        cx: x,
        x: runGoesOn ? x + 5 : x - BAR_W / 2,
        bw: runGoesOn ? 8 : BAR_W,
        y0,
        y1: Math.max(y1, y0 + 6),
        long: longMin,
        caps: axis.caps.filter((c) => c.id === w.id),
      };
    })
    .filter((v): v is NonNullable<typeof v> => !!v);

  // ---- arrows ----------------------------------------------------------------
  const visible = data.arrows.filter(
    (a) =>
      !hidden.has(a.kind) &&
      !(hidden.has('handoffs') && HANDOFF_KINDS.has(a.kind)) &&
      !(hidden.has('questions') && QUESTION_KINDS.has(a.kind)) &&
      cx(a.from) >= 0 &&
      cx(a.to) >= 0,
  );
  // a permission that Autopilot decided goes to the Autopilot lifeline, as in the design (B and C)
  const decided = new Set(data.arrows.filter((a) => a.kind === 'auto' && a.runId).map((a) => a.runId));
  const target = (a: TimelineArrow) =>
    a.kind === 'perm' && a.runId && decided.has(a.runId) && cx('autopilot') >= 0 ? 'autopilot' : a.to;
  const barsOf = (id: string) => bars.filter((g) => g.b.memberId === id && !g.queued);
  const raw = visible.map((a) => {
    const to = target(a);
    const fy = yy(a.at);
    const ty = Math.max(a.toAt ? yy(a.toAt) : fy, fy);
    const own = a.runId ? barById.get(a.runId) : undefined;
    // the sending run: the one that covers the moment it leaves; the receiving one: the run it started, or the
    // receiver's run that covers the moment it lands
    const sender =
      a.from === 'you' || a.from === 'autopilot' ? null : own?.b.memberId === a.from ? own : barAt(barsOf(a.from), fy);
    const receiver =
      to === 'you' || to === 'autopilot' || to === 'docs' ? null : own?.b.memberId === to ? own : barAt(barsOf(to), ty);
    if (a.from === to) {
      // the Checks sent the work back to the AI that did it: a line down beside its lifeline, from one run to the next
      const side = sender ?? receiver;
      const x = side ? side.x + side.w + 12 : cx(to) + 18;
      return { id: a.id, x1: x, y1: fy, x2: x, y2: ty };
    }
    const { x1, x2 } = arrowEnds(cx(a.from), cx(to), sender ?? null, receiver ?? null);
    return { id: a.id, x1, y1: fy, x2, y2: ty };
  });
  const shift = staggerArrows(raw);
  const docVersion = (a: TimelineArrow) =>
    data.docs.find((n) => n.memberId === a.from && Math.abs((ms(n.at) ?? 0) - (ms(a.at) ?? 0)) < 5000);
  const arrows: ArrowGeo[] = visible.map((a, i) => {
    const r = raw[i];
    const d = shift.get(a.id) ?? 0;
    const recv = a.runId ? barById.get(a.runId)?.b : undefined;
    const question = data.waits.find((w) => w.runId === a.runId && w.kind === 'question');
    const askOpen = a.kind === 'ask' && !!question && !question.to;
    // not delivered yet: the run waits to start, or the question waits for its answer (dashed and moving)
    const underWay =
      !pausedNow &&
      (askOpen ||
        (['assign', 'mention', 'handoff', 'skip'].includes(a.kind) &&
          !!recv &&
          (recv.state === 'queued' || recv.state === 'starting')));
    const doc = a.kind === 'doc' ? docVersion(a) : undefined;
    const label = arrowLabel(
      a,
      ticketOf,
      ms(a.toAt) != null && ms(a.at) != null ? (ms(a.toAt) as number) - (ms(a.at) as number) : 0,
      { open: askOpen, question: question?.text, version: doc?.version, detailed },
    );
    const count = a.kind === 'sent_back' ? Math.max(a.round, 1) : a.count;
    return {
      a,
      x1: r.x1,
      y1: r.y1 + d,
      x2: r.x2,
      y2: r.y2 + d,
      color: arrowStroke(a),
      dash: underWay ? '5 4' : ARROW[a.kind].dash,
      underWay,
      askOpen,
      badge: a.kind === 'sent_back' || count > 1 ? `×${count}` : null,
      label,
      autoAt: a.kind === 'auto' && a.from === 'autopilot' ? { x: cx('autopilot'), y: r.y1 + d - 5.5 } : null,
    };
  });

  // ---- sent back again and again: the loop is boxed (ai-team-timeline-cases.md, F) ------------------------------
  const loops: { key: string; x: number; y: number; w: number; h: number; n: number; color: string }[] = [];
  const pairs = new Map<string, ArrowGeo[]>();
  for (const g of arrows) {
    if (g.a.kind !== 'sent_back') continue;
    const k = `${g.a.ticketId ?? ''}|${ascendingText([g.a.from, g.a.to]).join('|')}`;
    pairs.set(k, [...(pairs.get(k) ?? []), g]);
  }
  for (const [k, list] of pairs) {
    const n = Math.max(list.length, ...list.map((g) => g.a.round));
    if (n < 2) continue;
    const xs = list.flatMap((g) => [cx(g.a.from), cx(g.a.to)]);
    const y0 = Math.min(...list.map((g) => Math.min(g.y1, g.y2))) - 12.6;
    const y1 = Math.max(...list.map((g) => Math.max(g.y1, g.y2))) + 8.4;
    const x0 = Math.min(...xs) - 40;
    loops.push({
      key: k,
      x: x0,
      y: y0,
      w: Math.max(...xs) + 46 - x0,
      h: y1 - y0,
      n,
      color: n >= 3 ? '#C4432A' : '#8A6A12',
    });
  }

  // ---- what sits where: obstacles first, then badges, then labels in priority -----------------------------------
  // keys of what is on the diagram: an arrow and the run it starts share an id in the data, so each kind has its own
  const K = {
    bar: (id: string) => `bar:${id}`,
    wait: (id: string) => `wait:${id}`,
    touch: (id: string) => `touch:${id}`,
    arrow: (id: string) => `arrow:${id}`,
    line: (id: string) => `arrow:${id}:line`,
    words: (id: string) => `arrow:${id}:words`,
  };
  /** The design writes an arrow's words across its own line when the arrow slopes away; a flat one would hide them. */
  const ownLine = (g: ArrowGeo) => (isFlat(g) ? [] : [K.line(g.a.id)]);
  const placer = new Placer(W);
  for (const g of bars) {
    placer.addBox(
      K.bar(g.b.id),
      { x: g.x, y: Math.min(g.qy, g.top), w: g.w, h: g.bottom - Math.min(g.qy, g.top) },
      'mark',
    );
  }
  for (const v of waits) placer.addBox(K.wait(v.w.id), { x: v.x, y: v.y0, w: v.bw, h: v.y1 - v.y0 }, 'mark');
  for (const n of data.docs) {
    const x = cx('docs');
    if (x >= 0) placer.addBox(`doc:${n.id}`, { x: x - 11, y: yy(n.at) - 11, w: 22, h: 22 }, 'mark');
  }
  const touches = hidden.has('touches') || cx('you') < 0 ? [] : touchLabels(data.touches, (at) => yy(at));
  // marks closer than a diamond is tall are drawn as one (the last of them, which carries the "×N" label)
  const drawn = new Set<string>();
  for (let i = touches.length - 1, lastY = Infinity; i >= 0; i--) {
    const y = yy(touches[i].t.at);
    if (touches[i].label || lastY - y >= 14) {
      drawn.add(touches[i].t.id);
      lastY = y;
    }
  }
  for (const { t } of touches)
    if (drawn.has(t.id)) placer.addBox(K.touch(t.id), { x: cx('you') - 10, y: yy(t.at) - 10, w: 20, h: 20 }, 'mark');
  for (const l of loops) placer.addBox(`loop:${l.key}`, { x: l.x, y: l.y - 24, w: loopPillW(l.n), h: 18 }, 'label');
  for (const b of axis.breaks) {
    const bw = breakPillW(b.label, W);
    placer.addBox(`br-${b.from}`, { x: (W - bw) / 2, y: TOP + b.y + 9, w: bw, h: 22 }, 'label');
  }
  for (const g of arrows) {
    placer.addSeg(K.line(g.a.id), { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 });
    // the "?" on your lifeline and the purple A on Autopilot's: their own label sits beside them, never on them
    if (g.askOpen) placer.addBox(`${K.arrow(g.a.id)}:?`, { x: cx('you') - 9, y: g.y2 - 9, w: 18, h: 18 }, 'glyph');
    if (g.autoAt)
      placer.addBox(`${K.arrow(g.a.id)}:A`, { x: g.autoAt.x - 9, y: g.autoAt.y - 9, w: 18, h: 18 }, 'glyph');
  }
  const labels: { label: PlacedLabel; color: string; weight: number; size: number; pick: Pick; full: string }[] = [];
  const put = (
    req: Parameters<Placer['place']>[0],
    color: string,
    pick: Pick,
    style: { weight?: number; size?: number } = {},
  ) => {
    const placed = placer.place({ ...req, weight: style.weight ?? 600, size: style.size ?? 10 });
    if (placed)
      labels.push({ label: placed, color, weight: style.weight ?? 600, size: style.size ?? 10, pick, full: req.text });
  };

  // 0. a decision or an open question has its words beside the A or the "?" on the lifeline, as in the design: they
  //    go first, so the arrow's own badge slides along its line out of their way
  const homed = new Set<string>();
  const labelColor = (g: ArrowGeo) =>
    g.a.kind === 'sent_back' ? '#A5321E' : g.color === TO_HUMAN ? '#7A5A06' : ARROW[g.a.kind].label;
  for (const g of [...arrows].sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1)) {
    if (!g.label.text || !g.label.important || !(g.askOpen || g.autoAt)) continue;
    const at = g.autoAt ?? { x: cx('you'), y: g.y2 };
    const before = labels.length;
    const beside: Spot = { x: at.x + 15, y: at.y + 4, anchor: 'start' };
    const below: Spot = { x: at.x + 15, y: at.y + 17, anchor: 'start' };
    const above: Spot = { x: at.x + 15, y: at.y - 9, anchor: 'start' };
    put(
      {
        key: `${K.arrow(g.a.id)}:L`,
        // its own badge and, when the arrow slopes away as in the design, its own line
        ignore: ownLine(g),
        text: g.label.text,
        // beside its circle, as designed, when the arrow slopes away; a flat arrow would run under the words
        spots: isFlat(g) ? [above, below, beside] : [beside, below, above],
      },
      labelColor(g),
      { type: 'arrow', id: g.a.id },
    );
    if (labels.length > before) homed.add(g.a.id);
  }
  const glyphAt = new Map<string, { x: number; y: number }>();
  for (const g of [...arrows].sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1)) {
    glyphAt.set(
      g.a.id,
      placer.placeOnLine(K.arrow(g.a.id), { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 }, 7.5, g.badge ? 22.5 : 0),
    );
  }
  // a badge that found no other place than on a decision's words: those words move (step 2 places them again)
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i].label;
    if (!l.key.endsWith(':L')) continue;
    const own = l.key.slice(0, -2);
    const skip = new Set([l.key, `${own}:line`]);
    if (placer.cost(l.box, skip).cost > 0) {
      placer.remove(l.key);
      labels.splice(i, 1);
      homed.delete(own.slice('arrow:'.length));
    }
  }

  // 1. your marks: they have only your lifeline
  for (const { t, label } of touches) {
    if (!label) continue;
    const x = cx('you');
    const y = yy(t.at);
    put(
      {
        key: K.touch(t.id),
        text: label,
        shrink: true,
        crossLines: true,
        spots: [
          { x: x + 15, y: y + 4, anchor: 'start' },
          { x: x + 15, y: y + 17, anchor: 'start' },
          { x: x + 15, y: y - 9, anchor: 'start' },
        ],
      },
      '#3A4A3E',
      { type: 'touch', id: t.id },
    );
  }
  // 2. what matters at a glance: long waits, returns, questions, decisions (all of them in Detailed, later)
  // an important label may move further from its badge (up to three rows away) before it gives up
  const arrowSpots = (g: ArrowGeo, further = false): Spot[] => {
    const at = glyphAt.get(g.a.id) as { x: number; y: number };
    // after the ×N pill when there is one (the design writes "sent back, 3rd time" at 32 px)
    const right = at.x + (g.badge ? 32 : 11);
    const spots: Spot[] = [];
    if (g.askOpen) {
      const yc = g.y2;
      spots.push({ x: cx('you') + 15, y: yc + 4, anchor: 'start' }, { x: cx('you') + 15, y: yc + 17, anchor: 'start' });
    }
    if (g.autoAt) {
      const { x, y } = g.autoAt;
      spots.push({ x: x + 15, y: y + 4, anchor: 'start' }, { x: x + 15, y: y - 9, anchor: 'start' });
    }
    const onLine: Spot[] = [
      { x: right, y: at.y + 3.6, anchor: 'start' },
      { x: at.x - 11, y: at.y + 3.6, anchor: 'end' },
    ];
    const offLine: Spot[] = [
      { x: right, y: at.y - 9.4, anchor: 'start' },
      { x: right, y: at.y + 16.6, anchor: 'start' },
      { x: at.x - 11, y: at.y - 9.4, anchor: 'end' },
      { x: at.x - 11, y: at.y + 16.6, anchor: 'end' },
    ];
    // the design's spot is beside the badge, on the line: fine for a sloping arrow, which leaves the words at once;
    // a flat arrow would run under them, so its words go above the line first
    spots.push(...(isFlat(g) ? [...offLine, ...onLine] : [...onLine, ...offLine]));
    if (further)
      for (const d of [26, 39]) {
        spots.push(
          { x: right, y: at.y + 3.6 - d, anchor: 'start' },
          { x: right, y: at.y + 3.6 + d, anchor: 'start' },
          { x: at.x - 11, y: at.y + 3.6 - d, anchor: 'end' },
          { x: at.x - 11, y: at.y + 3.6 + d, anchor: 'end' },
        );
      }
    return spots;
  };
  const byTime = [...arrows].sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1);
  for (const g of byTime) {
    if (!g.label.text || !g.label.important || homed.has(g.a.id)) continue;
    put(
      {
        key: K.words(g.a.id),
        ignore: ownLine(g),
        text: g.label.text,
        shrink: true,
        crossLines: true,
        spots: arrowSpots(g, true),
      },
      labelColor(g),
      { type: 'arrow', id: g.a.id },
    );
  }
  // 3. waits: how long, beside the wait
  for (const v of waits) {
    if (v.caps.length === 0 && v.long <= 10) continue;
    const word = `${v.w.to ? 'waited' : 'waiting'} ${lengthText(v.long * 60000)}`;
    const cap = v.caps[0];
    const mid = cap ? TOP + cap.y + cap.h / 2 + 7 : Math.max((v.y0 + v.y1) / 2, v.y0 + 12) + 4;
    const right = v.x + v.bw + 5;
    const left = v.cx - 14;
    const capSpots: Spot[] = [
      { x: v.cx - 19, y: mid, anchor: 'end' },
      { x: v.cx + 19, y: mid, anchor: 'start' },
    ];
    const plain: Spot[] = [
      { x: right, y: mid, anchor: 'start' },
      { x: left, y: mid, anchor: 'end' },
      { x: right, y: mid + 14, anchor: 'start' },
      { x: left, y: mid + 14, anchor: 'end' },
      { x: right, y: mid - 14, anchor: 'start' },
    ];
    put(
      {
        key: K.wait(v.w.id),
        text: word,
        crossLines: true,
        spots: cap ? capSpots : plain,
      },
      v.long > 60 ? '#A5321E' : '#7A5A06',
      { type: 'wait', id: v.w.id },
      cap ? { weight: 800, size: 10.5 } : { weight: 700 },
    );
  }
  // 4. runs: the ticket key (or "run 3" for one ticket), and how long a queue has waited
  for (const g of [...bars].sort((p, q) => p.top - q.top || p.x - q.x)) {
    const h = g.bottom - g.top;
    const text = props.scoped ? (g.b.label ?? `run ${g.b.number}`) : ticketOf(g.b.ticketId);
    if (text && (h >= 14 || detailed)) {
      const right: Spot = { x: g.x + g.w + 6, y: g.top + 11, anchor: 'start' };
      const left: Spot = { x: g.x - 6, y: g.top + 11, anchor: 'end' };
      const lower = (s: Spot): Spot => ({ ...s, y: s.y + 13 });
      const spots = [right, left];
      if (h > 28) spots.push(...spots.map(lower));
      if (h > 42) spots.push(...spots.slice(0, 2).map((s2) => lower(lower(s2))));
      // a ticket key never covers a line or a badge: without a free spot it is left out (the hover card has it)
      put({ key: K.bar(g.b.id), text, spots }, endLook(g.b, g.look).text, { type: 'bar', id: g.b.id }, { weight: 700 });
    }
    // how long a run waited in its queue, on the queue (on its break glyph when the queue is capped)
    const qa = ms(g.b.queuedAt);
    const qb = g.queued ? now : ms(g.b.startedAt);
    const queuedMin = qa != null && qb != null ? (qb - qa) / 60000 : 0;
    if (queuedMin > 10) {
      const cap = axis.caps.find((c) => c.id === g.b.id);
      const qTop = g.queued ? g.top : g.qy;
      const qBottom = g.queued ? g.bottom : g.top;
      const mid = cap ? TOP + cap.y + cap.h / 2 + 7 : (qTop + qBottom) / 2 + 4;
      const cx0 = g.x + g.w / 2;
      put(
        {
          key: `${K.bar(g.b.id)}:queued`,
          text: `${g.queued ? 'queued' : 'waited'} ${lengthText(queuedMin * 60000)}${g.b.heldByPause ? ', held until resume' : ''}`,
          shrink: true,
          crossLines: true,
          spots: cap
            ? [
                { x: cx0 - 19, y: mid, anchor: 'end' },
                { x: cx0 + 19, y: mid, anchor: 'start' },
                { x: cx0 - 19, y: mid + 14, anchor: 'end' },
                { x: cx0 + 19, y: mid + 14, anchor: 'start' },
              ]
            : [
                { x: g.x + g.w + 5, y: mid, anchor: 'start' },
                { x: g.x - 5, y: mid, anchor: 'end' },
                { x: g.x + g.w + 5, y: mid + 14, anchor: 'start' },
              ],
        },
        '#7A5A06',
        { type: 'bar', id: g.b.id },
        { weight: 700 },
      );
    }
  }
  // 5. the pause band's own words: on its line, wherever the lanes leave room
  const pauseSpots = (y: number): Spot[] => [
    { x: 12, y, anchor: 'start' },
    ...lifelines.map((_, i) => ({ x: laneX(i) + 15, y, anchor: 'start' as const })),
  ];
  for (const p of data.pauses) {
    const y0 = yy(p.from);
    put(
      {
        key: `pause-${p.from}`,
        text: 'AI paused',
        crossLines: true,
        spots: [...pauseSpots(y0 + 14), ...pauseSpots(y0 - 5)],
      },
      '#8A3F12',
      { type: 'pause', id: p.from },
      { weight: 800 },
    );
    if (p.to) {
      const y1 = yy(p.to);
      put(
        {
          key: `resumed-${p.from}`,
          crossLines: true,
          text: `Resumed ${clock(ms(p.to) ?? 0)}`,
          spots: [...pauseSpots(y1 - 4), ...pauseSpots(y1 + 13)],
        },
        '#2E6F40',
        { type: 'pause', id: p.from },
        { weight: 800 },
      );
    }
  }
  // 6. Detailed: a label on every other arrow, where there is room
  if (detailed) {
    for (const g of byTime) {
      if (!g.label.text || g.label.important) continue;
      put(
        { key: K.words(g.a.id), ignore: ownLine(g), text: g.label.text, shrink: true, spots: arrowSpots(g) },
        g.color === TO_HUMAN ? '#7A5A06' : ARROW[g.a.kind].label,
        { type: 'arrow', id: g.a.id },
      );
    }
  }

  // ---- drawing ---------------------------------------------------------------
  const markerColors = [...new Set([...Object.values(ARROW).map((v) => v.color), TO_HUMAN])];
  const marker = (c: string) => `url(#tlah${c.slice(1)})`;

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
        {markerColors.map((c) => (
          <marker
            key={c}
            id={`tlah${c.slice(1)}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10z" fill={c} />
          </marker>
        ))}
      </defs>

      {/* paused stretches: a tinted band from the pause to now (or to Resume), as in ai-paused.md D4 */}
      {data.pauses.map((p) => {
        const y0 = yy(p.from);
        const y1 = p.to ? yy(p.to) : nowY;
        return (
          <g
            key={`pause-${p.from}`}
            data-testid="tl-pause-band"
            {...interact({ type: 'pause', id: p.from }, `AI paused since ${clock(ms(p.from) ?? 0)}`)}
          >
            <rect x={0} y={y0} width={W} height={Math.max(y1 - y0, 2)} fill="#FDF0E6" opacity={0.75} />
          </g>
        );
      })}

      {/* lifelines, the grid and quiet stretches */}
      {lifelines.map((l, i) => (
        <line
          key={`ll-${l.id}`}
          x1={laneX(i)}
          x2={laneX(i)}
          y1={0}
          y2={H}
          stroke="#D5DED8"
          strokeWidth={1.4}
          strokeDasharray="2 4"
        />
      ))}
      {axis.ticks
        .filter((t) => !t.inside)
        .map((t) => (
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
        // the pill is as wide as its words and sits in the middle; the zigzag runs under it from edge to edge
        const bw = breakPillW(b.label, W);
        const base = TOP + b.y + 24;
        return (
          <g key={`br-${b.from}`} data-testid="tl-break">
            <rect
              x={0}
              y={TOP + b.y}
              width={W}
              height={b.h}
              fill={b.paused ? '#FDF0E6' : '#FBFCFB'}
              opacity={b.paused ? 0.75 : 1}
            />
            <polyline points={zigzag(0, W, base)} fill="none" stroke="#D5DED8" strokeWidth={1.4} />
            <rect x={(W - bw) / 2} y={TOP + b.y + 9} width={bw} height={22} rx={11} fill="#fff" stroke="#D5DED8" />
            <text
              x={W / 2}
              y={base}
              fontSize={11}
              fontWeight={600}
              fill={b.paused ? '#8A3F12' : '#5B6B60'}
              textAnchor="middle"
            >
              {b.label}
            </text>
          </g>
        );
      })}
      {data.pauses.map((p) => (
        <g key={`pl-${p.from}`} pointerEvents="none">
          <line x1={0} x2={W} y1={yy(p.from)} y2={yy(p.from)} stroke="#B4571F" strokeWidth={1.4} />
          {p.to && <line x1={0} x2={W} y1={yy(p.to)} y2={yy(p.to)} stroke="#2E6F40" strokeWidth={1.6} />}
        </g>
      ))}

      {/* the loop of a ticket sent back again and again */}
      {loops.map((l) => (
        <g key={l.key} data-testid="tl-pingpong" pointerEvents="none">
          <rect
            x={l.x}
            y={l.y}
            width={l.w}
            height={l.h}
            rx={10}
            fill="none"
            stroke={l.color}
            strokeWidth={1.4}
            strokeDasharray="6 4"
          />
          <rect x={l.x} y={l.y - 24} width={loopPillW(l.n)} height={18} rx={9} fill={l.color} />
          <text
            x={l.x + loopPillW(l.n) / 2}
            y={l.y - 11}
            fontSize={10.5}
            fontWeight={800}
            fill="#fff"
            textAnchor="middle"
          >
            ping-pong ×{l.n}
          </text>
        </g>
      ))}

      {/* runs */}
      {bars.map((g) => {
        const { b, x, w, top, bottom, qy, queued, live, look } = g;
        const end = endLook(b, look);
        const label = `${props.ticketOf(b.ticketId)} · ${b.label ?? `run ${b.number}`}`;
        const mid = (top + bottom) / 2;
        const r = Math.min(5, (bottom - top) / 2);
        return (
          <g
            key={b.id}
            data-testid={`tl-bar-${b.id}`}
            className={fresh.has(b.id) ? 'tl-grow' : undefined}
            {...interact({ type: 'bar', id: b.id }, `${label}, ${b.state}`)}
          >
            {!queued && b.startedAt && top - qy > 6 && (
              <rect
                x={x}
                y={qy}
                width={w}
                height={top - qy}
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
              height={bottom - top}
              rx={r}
              fill={end.fill}
              stroke={end.stroke}
              strokeWidth={sel('bar', b.id) ? 2.6 : 1.5}
              strokeDasharray={end.dash}
            />
            {fresh.has(b.id) && b.endedAt && ['failed', 'memory', 'timeout', 'budget'].includes(b.endKind ?? '') && (
              <rect
                className="tl-flash"
                x={x}
                y={top}
                width={w}
                height={bottom - top}
                rx={r}
                fill="#C4432A"
                pointerEvents="none"
              />
            )}
            {live && !pausedNow && may() ? (
              <Pulse still={<circle cx={x + w / 2} cy={bottom} r={4} fill={look.stroke} />}>
                <rect
                  x={x + 3}
                  y={top + 3}
                  width={Math.max(w - 6, 4)}
                  height={Math.max(bottom - top - 6, 2)}
                  rx={3}
                  fill={look.stroke}
                  opacity={0.18}
                  data-testid="tl-run-pulse"
                >
                  <animate attributeName="opacity" values="0.1;0.32;0.1" dur="1.6s" repeatCount="indefinite" />
                </rect>
                <circle cx={x + w / 2} cy={bottom} r={4} fill={look.stroke} data-testid="tl-run-head">
                  <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
                </circle>
              </Pulse>
            ) : (
              live && <circle cx={x + w / 2} cy={bottom} r={4} fill={look.stroke} />
            )}
            <RunEnd b={b} x={x + w / 2} y={bottom} mid={mid} />
            {b.restarts
              .filter((rs) => rs.by === 'system')
              .map((rs) => (
                <RestartMark key={rs.n} x={x + w / 2} y={Math.min(Math.max(yy(rs.at), top + 6), bottom - 6)} />
              ))}
            {queued && b.heldByPause && <Glyph name="pause" x={x + w / 2} y={mid} color="#5B6B60" size={14.4} />}
            {/* a queue over an hour is capped like a long wait: the design's break glyph across it (E.2) */}
            {axis.caps
              .filter((c) => c.id === b.id)
              .map((c) => (
                <path
                  key={c.from}
                  d={`M${x + w / 2 - 14} ${TOP + c.y + c.h / 2} l7 -4 l7 6 l7 -6 l7 4`}
                  stroke="#9AA8A0"
                  strokeWidth={1.6}
                  fill="#fff"
                  strokeLinejoin="round"
                  data-testid="tl-queue-cap"
                />
              ))}
            {detailed && b.steps > 0 && !queued && (
              <StepTicks b={b} x={x} w={w} top={top} bottom={bottom} color={end.stroke} />
            )}
          </g>
        );
      })}

      {/* waits: hatched amber for a person, over the run they hold up */}
      {waits.map((v) => (
        <WaitMark
          key={v.w.id}
          w={v.w}
          x={v.x}
          cx={v.cx}
          bw={v.bw}
          y0={v.y0}
          y1={v.y1}
          caps={v.caps}
          long={v.long}
          breathe={!v.w.to && !pausedNow}
          selected={sel('wait', v.w.id)}
          props={interact(
            { type: 'wait', id: v.w.id },
            `${v.w.kind === 'question' ? 'Question' : 'Permission'} ${v.w.to ? 'answered' : 'waiting for you'}`,
          )}
        />
      ))}

      {/* waits on the Docs lifeline: changes proposed and not yet decided */}
      {data.docs
        .filter((n) => n.kind === 'proposal' && n.status === 'waiting' && cx('docs') >= 0)
        .map((n) => (
          <rect
            key={`dw-${n.id}`}
            x={cx('docs') - BAR_W / 2}
            y={yy(n.at) + 22}
            width={BAR_W}
            height={Math.max(nowY - yy(n.at) - 22, 6)}
            rx={5}
            fill="url(#tlhA)"
            stroke="#E8B93A"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        ))}

      {/* arrows */}
      {arrows.map((g) => {
        const { a } = g;
        const meta = ARROW[a.kind];
        const at = glyphAt.get(a.id) as { x: number; y: number };
        const isNew = fresh.has(a.id) && !pausedNow;
        const line = {
          d: `M${g.x1} ${g.y1} L${g.x2} ${g.y2}`,
          stroke: g.color,
          strokeWidth: sel('arrow', a.id) ? 2.6 : 1.7,
          fill: 'none',
          strokeDasharray: g.dash,
          markerEnd: marker(g.color),
        };
        const youX = cx('you');
        return (
          <g
            key={a.id}
            data-testid={`tl-arrow-${a.kind}`}
            {...interact({ type: 'arrow', id: a.id }, `${meta.word}${g.label.text ? `: ${g.label.text}` : ''}`)}
          >
            <path d={line.d} stroke="transparent" strokeWidth={10} fill="none" />
            {g.underWay && may() ? (
              <Pulse still={<path {...line} />}>
                <path {...line} data-testid="tl-underway">
                  <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.9s" repeatCount="indefinite" />
                </path>
              </Pulse>
            ) : (
              <path
                {...line}
                className={isNew ? (g.dash ? 'tl-fade' : 'tl-draw') : undefined}
                style={
                  isNew && !g.dash
                    ? ({ '--len': Math.hypot(g.x2 - g.x1, g.y2 - g.y1) } as React.CSSProperties)
                    : undefined
                }
              />
            )}
            {isNew && (
              <circle className="tl-ring" cx={at.x} cy={at.y} r={13} fill="none" stroke={g.color} strokeWidth={1.5} />
            )}
            <g className={isNew ? 'tl-pop tl-late' : undefined}>
              <circle cx={at.x} cy={at.y} r={7.5} fill="#fff" stroke={g.color} strokeWidth={1.4} />
              {meta.glyph === 'lock' ? (
                <Glyph name="lock" x={at.x} y={at.y} color={g.color} size={12} stroke={2.6} />
              ) : meta.glyph === 'file' ? (
                <Glyph name="file" x={at.x} y={at.y} color={g.color} size={11.04} stroke={2.6} />
              ) : (
                <text x={at.x} y={at.y + 3.6} fontSize={10} fontWeight={800} fill={g.color} textAnchor="middle">
                  {meta.glyph}
                </text>
              )}
            </g>
            {g.badge && (
              <g key={g.badge} className={isNew || fresh.has(`${a.id}:n${a.count}`) ? 'tl-pop' : undefined}>
                <rect
                  x={at.x + 9}
                  y={at.y - 8}
                  width={g.badge.length > 3 ? 26 : 22}
                  height={15}
                  rx={7.5}
                  fill={a.kind === 'sent_back' ? '#C4432A' : g.color}
                />
                <text
                  x={at.x + (g.badge.length > 3 ? 22 : 20)}
                  y={at.y + 3}
                  fontSize={9.5}
                  fontWeight={800}
                  fill="#fff"
                  textAnchor="middle"
                >
                  {g.badge}
                </text>
              </g>
            )}
            {g.askOpen && youX >= 0 && (
              <g>
                <circle cx={youX} cy={g.y2} r={8.5} fill="#FEF3D9" stroke="#B8860B" strokeWidth={1.6} />
                <text x={youX} y={g.y2 + 4} fontSize={11} fontWeight={800} fill="#7A5A06" textAnchor="middle">
                  ?
                </text>
                {!pausedNow && may() && (
                  <Pulse still={null}>
                    <circle
                      cx={youX}
                      cy={g.y2}
                      r={8.5}
                      fill="none"
                      stroke="#B8860B"
                      strokeWidth={1.4}
                      data-testid="tl-ask-ripple"
                    >
                      <animate attributeName="r" values="8.5;16" dur="2.2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.8;0" dur="2.2s" repeatCount="indefinite" />
                    </circle>
                  </Pulse>
                )}
              </g>
            )}
            {g.autoAt && g.autoAt.x >= 0 && (
              <g>
                <circle cx={g.autoAt.x} cy={g.autoAt.y} r={8.5} fill="#EFE8FB" stroke="#7C5CD6" strokeWidth={1.5} />
                <text
                  x={g.autoAt.x}
                  y={g.autoAt.y + 4}
                  fontSize={10.5}
                  fontWeight={800}
                  fill="#5B3AA6"
                  textAnchor="middle"
                >
                  A
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* your marks, as in Flow and You stepped in */}
      {touches.map(({ t }) => {
        if (!drawn.has(t.id)) return null;
        const x = cx('you');
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
            <title>{n.title}</title>
            <rect
              x={x - 11}
              y={y - 11}
              width={22}
              height={22}
              rx={5}
              fill={wait ? 'url(#tlhA)' : '#fff'}
              stroke={wait ? '#E8B93A' : '#5B6B60'}
              strokeWidth={1.5}
              strokeDasharray={wait ? '4 3' : undefined}
            />
            <Glyph name="file" x={x} y={y} color={wait ? '#7A5A06' : '#5B6B60'} />
          </g>
        );
      })}

      {/* every label last, on top, each where the placer found room */}
      <g data-testid="tl-labels">
        {labels.map(({ label: l, color, weight, size, pick, full }, i) => (
          <text
            key={`${l.key}-${i}`}
            x={l.x}
            y={l.y}
            fontSize={size}
            fontWeight={weight}
            fill={color}
            textAnchor={l.anchor}
            className="tl-halo"
            data-label-for={pickKey(pick)}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              onPick(pick);
            }}
          >
            {l.clipped && <title>{full}</title>}
            {l.text}
          </text>
        ))}
      </g>

      {/* now */}
      <g data-testid="tl-now" pointerEvents="none">
        <line
          x1={0}
          x2={W}
          y1={nowY}
          y2={nowY}
          stroke={pausedNow ? '#9AA8A0' : '#2E6F40'}
          strokeWidth={1.4}
          strokeDasharray="3 3"
        />
        {!pausedNow && (
          <Pulse still={<circle cx={W - PAD} cy={nowY} r={4} fill="#2E6F40" />}>
            <circle cx={W - PAD} cy={nowY} r={4} fill="#2E6F40" data-testid="tl-now-dot">
              <animate attributeName="r" values="3;7;3" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite" />
            </circle>
          </Pulse>
        )}
      </g>
    </svg>
  );
}

/** The now pill sits in the gutter, level with the now line. */
export function NowPill({ axis, now, paused }: { axis: Axis; now: number; paused: boolean }) {
  const y = TOP + axis.y(now);
  const text = `now ${clock(now)}`;
  // as wide as its words with 7 px of air on each side (the design's 56 px left almost none), inside the gutter
  const w = Math.min(Math.ceil(textWidth(text, 10, 800)) + 14, GUTTER - 2);
  const x = GUTTER - 1 - w;
  return (
    <svg
      width={GUTTER}
      height={bodyHeight(axis)}
      style={{ display: 'block', position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      role="presentation"
      data-testid="tl-now-pill"
    >
      <rect x={x} y={y - 9} width={w} height={18} rx={9} fill={paused ? '#5B6B60' : '#2E6F40'} />
      <text x={x + w / 2} y={y + 4} fontSize={10} fontWeight={800} fill="#fff" textAnchor="middle">
        {text}
      </text>
    </svg>
  );
}

/** An arrow drawn (nearly) level: its own line would run under words placed beside its badge. */
function isFlat(g: { y1: number; y2: number; x1: number; x2: number }): boolean {
  return Math.abs(g.y2 - g.y1) < 4 || Math.abs(g.y2 - g.y1) / Math.max(Math.abs(g.x2 - g.x1), 1) < 0.03;
}

/** Width of a break's pill: its words and some room, never wider than the lanes. */
function breakPillW(label: string, W: number): number {
  return Math.min(W - 12, Math.max(64, textWidth(label, 11, 600) + 28));
}

/** Width of the "ping-pong ×3" pill. */
function loopPillW(n: number): number {
  return textWidth(`ping-pong ×${n}`, 10.5, 800) + 26;
}

function zigzag(x0: number, x1: number, y: number): string {
  const pts: string[] = [];
  for (let x = x0, up = false; x <= x1; x += 10, up = !up) pts.push(`${x},${up ? y - 8 : y}`);
  return pts.join(' ');
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function WaitMark({
  w,
  x,
  cx,
  bw,
  y0,
  y1,
  caps,
  long,
  breathe,
  selected,
  props,
}: {
  w: TimelineWait;
  x: number;
  cx: number;
  bw: number;
  y0: number;
  y1: number;
  caps: Axis['caps'];
  long: number;
  breathe: boolean;
  selected: boolean;
  props: Record<string, unknown>;
}) {
  const red = long > 60;
  return (
    <g data-testid={`tl-wait-${w.kind}`} {...props}>
      <rect
        x={x}
        y={y0}
        width={bw}
        height={y1 - y0}
        rx={Math.min(5, bw / 2)}
        fill="url(#tlhA)"
        stroke={red ? '#C4432A' : '#E8B93A'}
        strokeWidth={selected ? 2.6 : 1.5}
        strokeDasharray="4 3"
      />
      {breathe && (
        <Pulse still={null}>
          <rect x={x} y={y0} width={bw} height={y1 - y0} rx={Math.min(5, bw / 2)} fill="#E8B93A" opacity={0}>
            <animate attributeName="opacity" values="0;0.25;0" dur="2.4s" repeatCount="indefinite" />
          </rect>
        </Pulse>
      )}
      {caps.map((cap) => {
        const cy = TOP + cap.y + cap.h / 2;
        return (
          <path
            key={cap.from}
            d={`M${cx - 14} ${cy} l7 -4 l7 6 l7 -6 l7 4`}
            stroke="#B8860B"
            strokeWidth={1.6}
            fill="#fff"
            strokeLinejoin="round"
          />
        );
      })}
    </g>
  );
}

/** How a run ended, drawn at its foot: a cross, a clock, a black square, a pause or a dollar. */
function RunEnd({ b, x, y, mid }: { b: TimelineBar; x: number; y: number; mid: number }) {
  if (b.paused && !b.endKind) return <Glyph name="pause" x={x} y={mid} color="#5B6B60" size={14.4} />;
  switch (b.endKind) {
    case 'failed':
      return (
        <text x={x} y={y - 3} fontSize={13} fontWeight={800} fill="#C4432A" textAnchor="middle">
          ×
        </text>
      );
    case 'memory':
      return (
        <text
          x={x}
          y={y - 3}
          fontSize={9}
          fontWeight={800}
          fill="#C4432A"
          textAnchor="middle"
          data-testid="tl-ram-stop"
        >
          RAM
        </text>
      );
    case 'timeout':
      return <Glyph name="clock" x={x} y={y - 8} color="#8A4B08" size={14.4} />;
    case 'stopped':
    case 'pause_all':
      return <rect x={x - 4.5} y={y - 12} width={9} height={9} fill="#1E2A22" rx={1.5} />;
    case 'budget':
      return (
        <text x={x} y={y - 4} fontSize={12} fontWeight={800} fill="#7A5A06" textAnchor="middle">
          $
        </text>
      );
    default:
      return null;
  }
}

/** The system started the run's CLI again here (over the memory limit): an orange circle with an arrow. */
function RestartMark({ x, y }: { x: number; y: number }) {
  return (
    <g data-testid="tl-restart" aria-hidden="true">
      <circle cx={x} cy={y} r={6.5} fill="#E8821A" stroke="#FFFFFF" strokeWidth={1.5} />
      <path
        d="M-2.6 0.4 A2.7 2.7 0 1 1 0 2.7 M-2.6 -2.2 L-2.6 0.6 L0.2 0.6"
        transform={`translate(${x} ${y})`}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** The steps of a run as ticks across its bar (Detailed), at least 28 px apart as in the design. */
function StepTicks({
  b,
  x,
  w,
  top,
  bottom,
  color,
}: {
  b: TimelineBar;
  x: number;
  w: number;
  top: number;
  bottom: number;
  color: string;
}) {
  const n = Math.min(b.steps, Math.floor((bottom - top) / 28));
  const ticks = [];
  for (let i = 1; i <= n; i++) {
    const y = top + ((bottom - top) * i) / (n + 1);
    ticks.push(<line key={i} x1={x} x2={x + w} y1={y} y2={y} stroke={color} strokeWidth={1.2} opacity={0.6} />);
  }
  return (
    <g aria-hidden="true" data-testid="tl-steps">
      {ticks}
    </g>
  );
}

/**
 * The words next to an arrow: what matters at a glance (long waits, returns, open questions, decisions), and the
 * rest in Detailed.
 */
export function arrowLabel(
  a: TimelineArrow,
  ticketOf: (id: string | null | undefined) => string,
  spanMs: number,
  opts: { open?: boolean; question?: string; version?: number; detailed?: boolean } = {},
): { text: string; important: boolean } {
  const wait = a.waitS != null ? a.waitS / 60 : spanMs / 60000;
  const after = `after ${Math.max(Math.round(wait), 1)} min`;
  switch (a.kind) {
    case 'sent_back': {
      const by = a.via === 'checks' ? ' by the checks' : '';
      return { text: a.round > 1 ? `sent back${by}, ${ordinal(a.round)} time` : `sent back${by}`, important: true };
    }
    case 'skip':
      return {
        text: a.skipped?.length ? `skipped ${a.skipped.join(' and ')}` : 'a step skipped',
        important: true,
      };
    case 'returned':
      return { text: 'returned, round 1 (normal)', important: true };
    case 'ask':
      if (opts.open && !opts.detailed)
        return { text: ticketOf(a.ticketId) ? `question on ${ticketOf(a.ticketId)}` : 'question', important: true };
      return {
        text: opts.question
          ? `asks you: ${clip(opts.question, 40)}`
          : `question${ticketOf(a.ticketId) ? ` on ${ticketOf(a.ticketId)}` : ''}`,
        important: !!opts.open,
      };
    case 'perm':
      return { text: a.label ?? 'needs a permission', important: false };
    case 'auto':
      return { text: `${a.by ? `${a.by} ` : ''}${a.denied ? 'refused' : 'approved'} ${after}`, important: true };
    case 'answer':
    case 'approve':
      return { text: `${a.kind === 'answer' ? 'answered' : 'approved'} ${after}`, important: wait > 10 };
    case 'deny':
      return { text: 'refused', important: true };
    case 'doc':
      return {
        text: a.label ? `wrote ${a.label}${opts.version ? `, v${opts.version}` : ''}` : 'Docs',
        important: false,
      };
    default: {
      // the next run started long after the hand-off without a queue in between (for example the app was closed):
      // a fold may hide that stretch, so the arrow says how long it was
      const gap = spanMs / 60000;
      if (wait <= 10 && gap > 10) return { text: `started ${lengthText(spanMs)} later`, important: true };
      return {
        text: wait > 10 ? `waited ${Math.round(wait)} min` : `${ARROW[a.kind].word} ${ticketOf(a.ticketId)}`.trim(),
        important: wait > 10,
      };
    }
  }
}

function ordinal(n: number): string {
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}
