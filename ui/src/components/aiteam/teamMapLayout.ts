/**
 * The height of the Team map (design/screens/ai-team.md, C): a row of AI boxes, arcs above them for skips and report
 * backs, arcs below them for work handed back or sent back. Every next arc reaches ARC_STEP px further out than the
 * one before, so the map must be as tall as its outermost arc and that arc's label, however many there are.
 */

export const NODE_Y = 70;
export const NODE_H = 140;
/** How far the first arc reaches past the boxes, and how much further each next one reaches. */
export const ARC_FIRST = 30;
export const ARC_STEP = 22;
/** A label's baseline sits 14 px past the bottom of an arc below; its text is about 12 px tall. */
const LABEL_BELOW = 14 + 4;
const LABEL_ABOVE = 2 + 12;
const MARGIN = 12;

/** How far arc `k` (0 = the shortest) reaches past the boxes. */
export const arcReach = (k: number) => ARC_FIRST + k * ARC_STEP;

/**
 * The offset of the box row (`top`) and the map's whole height, for `above` arcs over the boxes and `below` arcs
 * under them. With up to six arcs on a side it is the same as before (the look of a small team does not change);
 * past that it grows with the outermost arc instead of cutting it off.
 */
export function teamMapHeight(above: number, below: number): { top: number; height: number } {
  const usual = 40 + Math.min(above, 6) * ARC_STEP + 20;
  const needTop = above ? arcReach(above - 1) + LABEL_ABOVE + MARGIN - NODE_Y : 0;
  const top = Math.max(usual, needTop);
  const bottom = NODE_Y + NODE_H;
  const usualH = top + bottom + 30 + Math.min(below, 6) * ARC_STEP + 20;
  const needH = top + bottom + (below ? arcReach(below - 1) + LABEL_BELOW : 0) + MARGIN;
  return { top, height: Math.max(usualH, needH) };
}
