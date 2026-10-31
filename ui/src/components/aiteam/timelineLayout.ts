import type { Timeline } from '../../types/aiTeam';

/**
 * The Timeline's vertical axis (design/screens/ai-team-timeline-cases.md, E).
 *
 * Time runs down. Compact time folds a stretch longer than 10 minutes in which no run is active, nothing is queued and
 * nobody is waited for into one labelled break; a wait is never folded, and a wait over 60 minutes is capped at about
 * 150 px with its length written on it. Real time keeps the true proportion and never folds or caps anything.
 */

export const PX_PER_MIN = 11;
export const BREAK_H = 40;
export const QUIET_MIN = 10;
export const CAP_MIN = 60;
export const CAP_H = 150;
export const HEAD_H = 46;

export type AxisMode = 'compact' | 'real';

export interface Segment {
  t0: number;
  t1: number;
  y0: number;
  h: number;
  kind: 'time' | 'break' | 'cap';
}

export interface Tick {
  t: number;
  y: number;
  label: string;
  /** A date line: this tick is midnight. */
  midnight?: boolean;
}

export interface Axis {
  segments: Segment[];
  height: number;
  /** Maps a time (ms) to a y position. */
  y: (t: number) => number;
  /** The time (ms) at a y position: the inverse of `y`, to the middle of a folded stretch. */
  timeAt: (y: number) => number;
  ticks: Tick[];
  breaks: { y: number; h: number; from: number; to: number; label: string; paused: boolean }[];
  /** Waits over an hour, drawn capped: where, how long. */
  caps: { id: string; y: number; h: number; from: number; to: number }[];
}

interface Span {
  a: number;
  b: number;
}

const MIN = 60000;

/** Words for a length of time: "1 h 10 min", "45 min", "2 h". */
export function lengthText(ms: number): string {
  const min = Math.max(1, Math.round(ms / MIN));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "08:10" in the person's time zone. */
export function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function merge(spans: Span[]): Span[] {
  const sorted = [...spans].filter((s) => s.b >= s.a).sort((x, y) => x.a - y.a);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.a <= last.b) last.b = Math.max(last.b, s.b);
    else out.push({ ...s });
  }
  return out;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Every stretch in which something is going on: a run, a queue, a wait, or a mark. */
export function busySpans(data: Timeline, now: number): Span[] {
  const spans: Span[] = [];
  for (const b of data.bars) {
    const a = ms(b.queuedAt) ?? ms(b.startedAt);
    if (a == null) continue;
    spans.push({ a, b: ms(b.endedAt) ?? now });
  }
  for (const w of data.waits) {
    const a = ms(w.from);
    if (a != null) spans.push({ a, b: ms(w.to) ?? now });
  }
  // A single event (an arrow, a mark) keeps a minute around it so it is not folded into a break
  for (const e of data.arrows) {
    const a = ms(e.at);
    const z = ms(e.toAt) ?? a;
    if (a != null && z != null) spans.push({ a: Math.min(a, z) - MIN, b: Math.max(a, z) + MIN });
  }
  for (const t of data.touches) {
    const a = ms(t.at);
    if (a != null) spans.push({ a: a - MIN, b: a + MIN });
  }
  return merge(spans);
}

/** Everything going on apart from a person being waited for: runs (minus their own waits), marks and short waits. */
function activeSpans(data: Timeline, now: number): Span[] {
  const waitsOf = new Map<string, Span[]>();
  for (const w of data.waits) {
    const a = ms(w.from);
    if (a == null || !w.runId) continue;
    const list = waitsOf.get(w.runId) ?? [];
    list.push({ a, b: ms(w.to) ?? now });
    waitsOf.set(w.runId, list);
  }
  const spans: Span[] = [];
  for (const b of data.bars) {
    const a = ms(b.queuedAt) ?? ms(b.startedAt);
    if (a == null) continue;
    let pieces: Span[] = [{ a, b: ms(b.endedAt) ?? now }];
    for (const w of merge(waitsOf.get(b.id) ?? [])) {
      pieces = pieces.flatMap((p) => {
        if (w.b <= p.a || w.a >= p.b) return [p];
        const out: Span[] = [];
        if (w.a > p.a) out.push({ a: p.a, b: w.a });
        if (w.b < p.b) out.push({ a: w.b, b: p.b });
        return out;
      });
    }
    spans.push(...pieces);
  }
  for (const w of data.waits) {
    const a = ms(w.from);
    if (a == null) continue;
    const z = ms(w.to) ?? now;
    if (z - a <= CAP_MIN * MIN) spans.push({ a, b: z });
  }
  for (const e of data.arrows) {
    const a = ms(e.at);
    const z = ms(e.toAt) ?? a;
    if (a != null && z != null) spans.push({ a: Math.min(a, z) - MIN, b: Math.max(a, z) + MIN });
  }
  for (const t of data.touches) {
    const a = ms(t.at);
    if (a != null) spans.push({ a: a - MIN, b: a + MIN });
  }
  return merge(spans);
}

/** Ticks whose label does not crowd the next one: a step from five minutes to six hours. */
function tickStep(pxPerMin: number): number {
  for (const step of [5, 10, 15, 30, 60, 120, 360, 720]) if (step * pxPerMin >= 46) return step;
  return 1440;
}

/** Build the axis for a window. `now` is the live edge; the window ends there while following. */
export function buildAxis(data: Timeline, mode: AxisMode, now: number): Axis {
  const from = ms(data.since) ?? now - 3600000;
  const to = Math.max(ms(data.until) ?? now, from + MIN);
  const segments: Segment[] = [];
  const breaks: Axis['breaks'] = [];
  const caps: Axis['caps'] = [];
  const pauses = data.pauses.map((p) => ({ a: ms(p.from) ?? from, b: ms(p.to) ?? now }));

  // The stretches that are folded or capped, in order, inside [from, to]
  const special: { t0: number; t1: number; kind: 'break' | 'cap'; id?: string }[] = [];
  if (mode === 'compact') {
    const busy = busySpans(data, now).map((s) => ({ a: Math.max(s.a, from), b: Math.min(s.b, to) }));
    let cursor = from;
    for (const s of [...busy.filter((x) => x.b > x.a), { a: to, b: to }]) {
      if (s.a - cursor > QUIET_MIN * MIN) special.push({ t0: cursor, t1: s.a, kind: 'break' });
      cursor = Math.max(cursor, s.b);
    }
    // A wait over an hour is capped where nothing else is going on; shorter ones stay to scale, and so does any
    // stretch in which another AI works, so that work is not squeezed
    const active = activeSpans(data, now);
    for (const w of data.waits) {
      const a = ms(w.from);
      if (a == null) continue;
      const z = ms(w.to) ?? now;
      if (z - a <= CAP_MIN * MIN) continue;
      let cursor = Math.max(a, from);
      const end = Math.min(z, to);
      for (const s of [...active.filter((x) => x.b > cursor && x.a < end), { a: end, b: end }]) {
        const gapEnd = Math.min(s.a, end);
        if (gapEnd - cursor > CAP_MIN * MIN) special.push({ t0: cursor, t1: gapEnd, kind: 'cap', id: w.id });
        cursor = Math.max(cursor, s.b);
      }
    }
  }
  special.sort((p, q) => p.t0 - q.t0 || p.t1 - q.t1);
  // Capped waits may overlap each other or a break's edge: keep the first, trim the next to start after it
  const clean: typeof special = [];
  for (const sp of special) {
    const last = clean[clean.length - 1];
    if (last && sp.t0 < last.t1) {
      if (sp.t1 <= last.t1) continue;
      sp.t0 = last.t1;
    }
    if (sp.t1 > sp.t0) clean.push(sp);
  }

  let y = 0;
  let t = from;
  const addTime = (t0: number, t1: number) => {
    if (t1 <= t0) return;
    const h = ((t1 - t0) / MIN) * PX_PER_MIN;
    segments.push({ t0, t1, y0: y, h, kind: 'time' });
    y += h;
  };
  for (const sp of clean) {
    addTime(t, sp.t0);
    if (sp.kind === 'break') {
      const paused = pauses.some((p) => p.a <= sp.t0 + MIN && p.b >= sp.t1 - MIN);
      segments.push({ t0: sp.t0, t1: sp.t1, y0: y, h: BREAK_H, kind: 'break' });
      breaks.push({
        y,
        h: BREAK_H,
        from: sp.t0,
        to: sp.t1,
        paused,
        label: paused
          ? `AI paused · ${lengthText(sp.t1 - sp.t0)}`
          : `${lengthText(sp.t1 - sp.t0)} with nothing running`,
      });
      y += BREAK_H;
    } else {
      const natural = ((sp.t1 - sp.t0) / MIN) * PX_PER_MIN;
      const h = Math.min(natural, CAP_H);
      segments.push({ t0: sp.t0, t1: sp.t1, y0: y, h, kind: 'cap' });
      caps.push({ id: sp.id ?? '', y, h, from: sp.t0, to: sp.t1 });
      y += h;
    }
    t = sp.t1;
  }
  addTime(t, to);
  const height = y;

  const yOf = (time: number): number => {
    if (time <= from) return 0;
    if (time >= to) return height;
    // binary search for the segment that holds it
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].t0 <= time) lo = mid;
      else hi = mid - 1;
    }
    const s = segments[lo];
    if (!s || s.t1 === s.t0) return s ? s.y0 : 0;
    return s.y0 + ((Math.min(time, s.t1) - s.t0) / (s.t1 - s.t0)) * s.h;
  };

  const timeOf = (pos: number): number => {
    if (segments.length === 0 || pos <= 0) return from;
    if (pos >= height) return to;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].y0 <= pos) lo = mid;
      else hi = mid - 1;
    }
    const s = segments[lo];
    return s.h === 0 ? s.t0 : s.t0 + ((pos - s.y0) / s.h) * (s.t1 - s.t0);
  };

  // Labels: on the rows of the to-scale segments, and the real clock on both sides of every fold
  const ticks: Tick[] = [];
  for (const s of segments) {
    if (s.kind !== 'time') {
      ticks.push({ t: s.t0, y: s.y0, label: clock(s.t0) });
      ticks.push({ t: s.t1, y: s.y0 + s.h, label: clock(s.t1) });
      continue;
    }
    const ppm = s.h / Math.max((s.t1 - s.t0) / MIN, 1e-9);
    const step = tickStep(ppm) * MIN;
    const first = Math.ceil(s.t0 / step) * step;
    for (let tt = first; tt < s.t1; tt += step) {
      const d = new Date(tt);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      ticks.push({
        t: tt,
        y: s.y0 + ((tt - s.t0) / (s.t1 - s.t0)) * s.h,
        label: midnight ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : clock(tt),
        midnight,
      });
    }
  }
  // Drop a tick that sits within 12 px of the one before it (the first and the fold edges win)
  ticks.sort((p, q) => p.y - q.y);
  const spaced: Tick[] = [];
  for (const k of ticks) {
    const last = spaced[spaced.length - 1];
    if (last && k.y - last.y < 12) continue;
    spaced.push(k);
  }
  return { segments, height, y: yOf, timeAt: timeOf, ticks: spaced, breaks, caps };
}

/** Which lane (0, 1, 2) a bar takes on its lifeline so overlapping bars do not hide each other. */
export function assignLanes(items: { id: string; a: number; b: number }[]): Map<string, number> {
  const lanes: number[] = [];
  const out = new Map<string, number>();
  for (const it of [...items].sort((p, q) => p.a - q.a)) {
    let k = lanes.findIndex((end) => end <= it.a);
    if (k < 0) {
      k = lanes.length;
      lanes.push(it.b);
    } else lanes[k] = it.b;
    out.set(it.id, Math.min(k, 2));
  }
  return out;
}
