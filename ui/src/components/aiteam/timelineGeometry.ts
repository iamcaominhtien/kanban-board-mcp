/**
 * Where runs and arrows sit across a lane (design/screens/ai-team-timeline.md, B and C).
 *
 * A run is an 18 px bar on its lifeline. The design never draws two runs of one lifeline at the same time; when an
 * AI does run twice at once, the second run is a narrower bar right beside the first (never on top of it), and a
 * third beside that. An arrow leaves and lands 1 px outside the edge of the bar it belongs to, as in the design
 * (`M662 … L446 …` for bars at 663–681 and 447–465); with no bar it ends 10 px from the lifeline.
 */

export const BAR_W = 18;
/** Width of a run that runs alongside another one of the same AI. */
export const SIDE_W = 12;
/** Room between two runs side by side. */
const SIDE_GAP = 2;

/** The x and width of a run's bar on a lifeline at `cx`, by its lane (0: on the lifeline, 1 and 2: beside it). */
export function laneBox(cx: number, lane: number): { x: number; w: number } {
  if (lane <= 0) return { x: cx - BAR_W / 2, w: BAR_W };
  return { x: cx + BAR_W / 2 + SIDE_GAP + (lane - 1) * (SIDE_W + SIDE_GAP), w: SIDE_W };
}

export interface BarSpan {
  x: number;
  w: number;
  top: number;
  bottom: number;
}

/**
 * The two ends of an arrow from the lifeline at `fx` to the one at `tx`: at the edge of the sending run's bar and of
 * the receiving run's bar when there is one, 10 px from the lifeline otherwise.
 */
export function arrowEnds(
  fx: number,
  tx: number,
  from: Pick<BarSpan, 'x' | 'w'> | null,
  to: Pick<BarSpan, 'x' | 'w'> | null,
): { x1: number; x2: number } {
  const dir = tx >= fx ? 1 : -1;
  const x1 = from ? (dir > 0 ? from.x + from.w + 1 : from.x - 1) : fx + dir * 10;
  const x2 = to ? (dir > 0 ? to.x - 1 : to.x + to.w + 1) : tx - dir * 10;
  return { x1, x2 };
}

/**
 * The run an arrow leaves from at `y`: of the bars on that lifeline that cover `y` (within a px), the one that ends
 * closest to it (a hand-off leaves as its run ends); null when no run covers it.
 */
export function barAt<T extends BarSpan>(bars: T[], y: number): T | null {
  let best: T | null = null;
  for (const b of bars) {
    if (b.top > y + 1 || b.bottom < y - 1) continue;
    if (!best || Math.abs(b.bottom - y) < Math.abs(best.bottom - y)) best = b;
  }
  return best;
}
