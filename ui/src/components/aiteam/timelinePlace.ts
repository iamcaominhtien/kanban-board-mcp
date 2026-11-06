/**
 * Collision handling for the Timeline diagram (design/screens/ai-team-timeline.md, B; ai-team-timeline-cases.md, I).
 *
 * The design draws sparse examples, where every mark sits at its natural place: a label 11 px right of its arrow's
 * badge, a ticket key 6 px right of its bar, a wait's length 14 px right of the wait. With real data several events
 * often fall in the same minute, so three deterministic steps keep the picture readable without changing what the
 * design shows when there is room:
 *
 * 1. The axis (timelineLayout.ts) gives every distinct moment its own row, at least ROW_GAP px below the previous one,
 *    in Compact time. Real time keeps true proportions and relies on the next two steps alone.
 * 2. `staggerArrows` moves an arrow down 12 px (more than half a label, so the two read as two arrows) when it would
 *    run along the same stretch of line as an arrow already drawn (same rows, overlapping lanes), so two arrows never
 *    share a line. Time order is kept: an arrow is only ever moved down, at most three steps.
 * 3. A `Placer` places glyph badges and labels one by one, in a fixed priority, against everything already drawn
 *    (bars, waits, nodes, badges, arrow lines and the labels placed before). Each mark has an ordered list of
 *    candidate spots; the first is the design's spot, so sparse data looks exactly as designed. A label never covers
 *    another label, a bar, a badge or a node, nor an arrow line other than its own (where the design writes it):
 *    it takes the first free spot, or shorter words only if those then fit a free spot, or else it is left out (its
 *    words stay in the hover card, the inspector and the Table). Only an important label (a decision, a question,
 *    a long wait, a return) may, as a last resort, cross another arrow's line.
 *    Marks of your own lifeline that sit closer than a mark is tall are folded into one label first ("×N",
 *    "+N more", see `touchLabels` in timelineDraw.tsx).
 *
 * Everything here is pure and deterministic: same input, same picture.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Anchor = 'start' | 'middle' | 'end';

/** A spot to try for a label: x of the anchor and the text's baseline. */
export interface Spot {
  x: number;
  y: number;
  anchor: Anchor;
}

// ---------------------------------------------------------------------------
// Text size without a DOM (Plus Jakarta Sans, measured in em)
// ---------------------------------------------------------------------------

const NARROW = new Set([...`iljtfr.,:;'!|·()[]/ `]);
const WIDE = new Set([...'mwMW@%']);

/** The width of a text in px, close to Plus Jakarta Sans at this size and weight (within a few %). */
export function textWidth(text: string, size = 10, weight = 600): number {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.29;
    else if (WIDE.has(ch)) em += 0.84;
    else if (ch >= '0' && ch <= '9') em += 0.6;
    else if (ch >= 'A' && ch <= 'Z') em += 0.68;
    else if (ch === '…' || ch === '×' || ch === '—') em += 0.7;
    else em += 0.55;
  }
  // calibrated against Chrome: semibold runs about 4 % wider than this table, bold about 3 %
  return em * size * (weight >= 700 ? 1.03 : weight >= 600 ? 1.04 : 1);
}

/** The box a label covers, with the room its white halo takes. */
export function labelBox(text: string, spot: Spot, size = 10, weight = 600): Box {
  const w = textWidth(text, size, weight);
  const x = spot.anchor === 'start' ? spot.x : spot.anchor === 'end' ? spot.x - w : spot.x - w / 2;
  return { x: x - 1.5, y: spot.y - size * 0.9 - 1, w: w + 3, h: size * 1.15 + 2 };
}

/** Cut a text to at most `maxW` px, with an ellipsis. */
export function clipToWidth(text: string, maxW: number, size = 10, weight = 600): string {
  if (textWidth(text, size, weight) <= maxW) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`, size, weight) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** The area two boxes share, 0 when they do not touch. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How much of a segment runs inside a box (Liang-Barsky clipping), in px. */
export function segInBox(s: Seg, b: Box): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, s.x1 - b.x],
    [dx, b.x + b.w - s.x1],
    [-dy, s.y1 - b.y],
    [dy, b.y + b.h - s.y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return 0;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return 0;
  }
  return (t1 - t0) * Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// Arrows that would share a line
// ---------------------------------------------------------------------------

/** The y of a segment at x (its end y beyond its ends). */
function yAt(s: Seg, x: number): number {
  if (s.x2 === s.x1) return s.y1;
  const t = Math.min(Math.max((x - s.x1) / (s.x2 - s.x1), 0), 1);
  return s.y1 + t * (s.y2 - s.y1);
}

/** Two arrows run along each other: they cover the same stretch of lanes, closer than `near` px all along it. */
export function runAlong(a: Seg, b: Seg, near = 6): boolean {
  const lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
  const hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
  if (hi - lo < 14) return false;
  return Math.abs(yAt(a, lo) - yAt(b, lo)) < near && Math.abs(yAt(a, hi) - yAt(b, hi)) < near;
}

/**
 * How far down (px) each arrow moves so that no two run along the same line. Arrows are taken in time order (top
 * first, then left first, then id); each takes the smallest step that clears the ones before it, at most `maxSteps`.
 */
export function staggerArrows(arrows: (Seg & { id: string })[], step = 12, maxSteps = 3): Map<string, number> {
  const order = [...arrows].sort(
    (p, q) =>
      Math.min(p.y1, p.y2) - Math.min(q.y1, q.y2) ||
      Math.min(p.x1, p.x2) - Math.min(q.x1, q.x2) ||
      (p.id < q.id ? -1 : p.id > q.id ? 1 : 0),
  );
  const out = new Map<string, number>();
  const placed: Seg[] = [];
  for (const a of order) {
    let k = 0;
    const moved = (n: number): Seg => ({ x1: a.x1, x2: a.x2, y1: a.y1 + n * step, y2: a.y2 + n * step });
    while (k < maxSteps && placed.some((p) => runAlong(moved(k), p))) k++;
    out.set(a.id, k * step);
    placed.push(moved(k));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The placer
// ---------------------------------------------------------------------------

/** What a placed thing is, for the cost of covering it. */
export type Layer = 'label' | 'glyph' | 'mark' | 'line';

const WEIGHT: Record<Layer, number> = { label: 10, glyph: 8, mark: 3, line: 2 };
/** About two arrows crossing a label: acceptable before the words are cut short. */
const LINE_OK = 240;

interface Item {
  key: string;
  layer: Layer;
  box?: Box;
  seg?: Seg;
}

export interface LabelRequest {
  /** The mark it belongs to: obstacles with this key (its own badge or bar) do not count. */
  key: string;
  text: string;
  spots: Spot[];
  size?: number;
  weight?: number;
  /** May be cut short, but only to fit a free spot (the full words stay in the hover card). */
  shrink?: boolean;
  /** Other keys it may cover (for example its own arrow's line, where the design puts the words). */
  ignore?: string[];
  /**
   * An important label (a decision, a question, a long wait): when no spot is free it may, as a last resort, sit
   * across an arrow line or two (never on a label, a bar, a badge or a node). Any other label is then left out.
   */
  crossLines?: boolean;
}

export interface PlacedLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  anchor: Anchor;
  box: Box;
  /** The words were cut short. */
  clipped: boolean;
}

/** Places badges and labels one by one against what is already on the diagram. */
export class Placer {
  private items: Item[] = [];

  /** @param width - The diagram's width: a label may not run past either edge. */
  constructor(private readonly width: number) {}

  addBox(key: string, box: Box, layer: Layer): void {
    this.items.push({ key, layer, box });
  }

  /** Take back everything placed under `key` (a label that has to move). */
  remove(key: string): void {
    this.items = this.items.filter((it) => it.key !== key);
  }

  addSeg(key: string, seg: Seg, layer: Layer = 'line'): void {
    this.items.push({ key, layer, seg });
  }

  /** The cost of covering `box`: overlap area (or length of line) times how much that layer matters. */
  cost(box: Box, skip: ReadonlySet<string>): { cost: number; lines: number } {
    let cost = 0;
    let lines = 0;
    if (box.x < 0 || box.x + box.w > this.width) cost += 4000;
    for (const it of this.items) {
      if (skip.has(it.key)) continue;
      const c = it.box ? overlap(box, it.box) : it.seg ? segInBox(it.seg, box) * 4 : 0;
      if (c <= 0) continue;
      if (it.seg) lines += c * WEIGHT[it.layer];
      else cost += c * WEIGHT[it.layer];
    }
    return { cost: cost + lines, lines };
  }

  /** Place a round badge of radius `r` (plus `extraRight` px of ×N pill) somewhere along a line, middle first. */
  placeOnLine(
    key: string,
    seg: Seg,
    r: number,
    extraRight = 0,
    ts: number[] = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82],
  ): { x: number; y: number } {
    const skip = new Set([key, `${key}:line`]);
    let best: { x: number; y: number; cost: number } | null = null;
    for (const t of ts) {
      const x = seg.x1 + t * (seg.x2 - seg.x1);
      const y = seg.y1 + t * (seg.y2 - seg.y1);
      const box = { x: x - r - 1, y: y - r - 1, w: 2 * r + 2 + extraRight, h: 2 * r + 2 };
      const { cost } = this.cost(box, skip);
      if (cost === 0) {
        best = { x, y, cost };
        break;
      }
      if (!best || cost < best.cost) best = { x, y, cost };
    }
    const at = best ?? { x: (seg.x1 + seg.x2) / 2, y: (seg.y1 + seg.y2) / 2 };
    this.addBox(key, { x: at.x - r, y: at.y - r, w: 2 * r + extraRight, h: 2 * r }, 'glyph');
    return { x: at.x, y: at.y };
  }

  /**
   * Place a label at its first free spot: the full words first, then (when it may shrink) shorter words. A label
   * never covers another label, a bar, a badge or a node; only an important one may, as a last resort, cross a line
   * or two. Returns null when there is no such spot: the label is left out.
   */
  place(req: LabelRequest): PlacedLabel | null {
    const size = req.size ?? 10;
    const weight = req.weight ?? 600;
    const skip = new Set([req.key, ...(req.ignore ?? [])]);
    const texts = [req.text];
    if (req.shrink) {
      const full = textWidth(req.text, size, weight);
      for (const share of [0.7, 0.5]) {
        const t = clipToWidth(req.text, Math.max(full * share, 30), size, weight);
        if (t !== texts[texts.length - 1] && t.length > 5) texts.push(t);
      }
    }
    const tiers: ('free' | 'lines')[] = req.crossLines ? ['free', 'lines'] : ['free'];
    for (const tier of tiers) {
      for (const text of texts) {
        let crossing: (PlacedLabel & { lines: number }) | null = null;
        for (const spot of req.spots) {
          const box = labelBox(text, spot, size, weight);
          const { cost, lines } = this.cost(box, skip);
          const cand = { key: req.key, text, ...spot, box, clipped: text !== req.text };
          if (cost === 0) {
            this.addBox(req.key, box, 'label');
            return cand;
          }
          if (tier === 'lines' && cost === lines && lines <= LINE_OK && (!crossing || lines < crossing.lines))
            crossing = { ...cand, lines };
        }
        if (crossing) {
          this.addBox(req.key, crossing.box, 'label');
          return {
            key: crossing.key,
            text: crossing.text,
            x: crossing.x,
            y: crossing.y,
            anchor: crossing.anchor,
            box: crossing.box,
            clipped: crossing.clipped,
          };
        }
      }
    }
    return null;
  }
}
