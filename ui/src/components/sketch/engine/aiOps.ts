import { arrowHead } from './geometry.ts';
import type { SourceText } from './sourceFormat.ts';

/** Most ops one answer may hold. The server enforces the same numbers. */
export const MAX_AI_OPS = 60;
/** Most points of one freehand path. */
export const MAX_AI_POINTS = 120;
/** Name of the layer the AI's shapes go on. */
export const AI_LAYER_NAME = 'AI';

const MAX_STROKE = 60;
const MIN_FONT = 8;
const MAX_FONT = 120;
const DEFAULT_COLOUR = '#2b2b2b';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A straight line, with an arrow head when `arrow` is set. */
export interface LineOp {
  op: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  size: number;
  arrow: boolean;
}

/** A rectangle or an ellipse in the box `x y w h`; `fill` makes it solid. */
export interface BoxOp {
  op: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  size: number;
  fill: boolean;
}

/** A text label (top left at `x y`); `size` is the font size. It stays editable text on the layer. */
export interface TextOp {
  op: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  bold: boolean;
}

/** A freehand polyline through `points`. */
export interface PathOp {
  op: 'path';
  points: [number, number][];
  color: string;
  size: number;
  closed: boolean;
}

/** One vector op as the server returns it (already checked and clamped to the canvas). */
export type AiOp = LineOp | BoxOp | TextOp | PathOp;

/** The part of a 2D canvas context the ops need, so the mapping can be tested without a canvas. */
export type OpsContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'rect'
  | 'ellipse'
  | 'stroke'
  | 'fill'
  | 'strokeStyle'
  | 'fillStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
>;

function num(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(hi, Math.max(lo, v)));
}

function colour(v: unknown): string {
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : DEFAULT_COLOUR;
}

function label(v: unknown): string | null {
  if (typeof v !== 'string' || /<\s*\/?\s*script|javascript\s*:/i.test(v)) return null;
  const lines = v
    .replace(/\r/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/<[^>]{0,200}>/g, '')
    .split('\n')
    .map((l) => l.split(/\s+/).filter(Boolean).join(' '))
    .filter(Boolean)
    .slice(0, 3);
  const out = lines.join('\n').slice(0, 120).trim();
  return out || null;
}

function cleanOne(raw: unknown, w: number, h: number): AiOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const col = colour(o.color);
  const size = num(o.size ?? 4, 1, MAX_STROKE) ?? 4;
  if (o.op === 'line') {
    const x1 = num(o.x1, 0, w);
    const y1 = num(o.y1, 0, h);
    const x2 = num(o.x2, 0, w);
    const y2 = num(o.y2, 0, h);
    if (x1 === null || y1 === null || x2 === null || y2 === null || (x1 === x2 && y1 === y2)) return null;
    return { op: 'line', x1, y1, x2, y2, color: col, size, arrow: o.arrow === true };
  }
  if (o.op === 'rect' || o.op === 'ellipse') {
    const x = num(o.x, 0, w);
    const y = num(o.y, 0, h);
    const bw = num(o.w, 0, w);
    const bh = num(o.h, 0, h);
    if (x === null || y === null || bw === null || bh === null) return null;
    const cw = Math.min(bw, w - x);
    const ch = Math.min(bh, h - y);
    if (cw < 1 || ch < 1) return null;
    return { op: o.op, x, y, w: cw, h: ch, color: col, size, fill: o.fill === true };
  }
  if (o.op === 'text') {
    const text = label(o.text);
    const x = num(o.x, 0, w);
    const y = num(o.y, 0, h);
    if (text === null || x === null || y === null) return null;
    return {
      op: 'text',
      x,
      y,
      text,
      color: col,
      size: num(o.size ?? 28, MIN_FONT, MAX_FONT) ?? 28,
      bold: o.bold === true,
    };
  }
  if (o.op === 'path' && Array.isArray(o.points)) {
    const points: [number, number][] = [];
    for (const p of o.points.slice(0, MAX_AI_POINTS)) {
      if (!Array.isArray(p)) continue;
      const px = num(p[0], 0, w);
      const py = num(p[1], 0, h);
      if (px === null || py === null) continue;
      const last = points[points.length - 1];
      if (!last || last[0] !== px || last[1] !== py) points.push([px, py]);
    }
    if (points.length < 2) return null;
    return { op: 'path', points, color: col, size, closed: o.closed === true };
  }
  return null;
}

/**
 * Check the ops the server sent once more before anything is drawn: unknown shapes, bad numbers and script-like text
 * are dropped, coordinates are put inside the canvas and there are at most 60 ops. The editor never trusts a list it
 * did not check itself.
 * @param raw - The `ops` value of a draft result.
 * @param width - Canvas width in px.
 * @param height - Canvas height in px.
 * @returns The ops that can be drawn, and how many were dropped.
 */
export function cleanAiOps(raw: unknown, width: number, height: number): { ops: AiOp[]; dropped: number } {
  if (!Array.isArray(raw)) return { ops: [], dropped: 0 };
  const ops: AiOp[] = [];
  for (const item of raw) {
    const op = cleanOne(item, Math.max(1, width), Math.max(1, height));
    if (op && ops.length < MAX_AI_OPS) ops.push(op);
  }
  return { ops, dropped: raw.length - ops.length };
}

/**
 * Draw the shapes of a list of ops (lines, arrows, rectangles, ellipses, paths) onto a context. Text ops are not drawn
 * here: they become editable text on the layer (`aiTexts`).
 * @param ctx - The context of the AI layer's canvas.
 * @param ops - Checked ops.
 */
export function drawAiShapes(ctx: OpsContext, ops: readonly AiOp[]): void {
  for (const op of ops) {
    if (op.op === 'text') continue;
    ctx.save();
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = op.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (op.op === 'line') {
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      if (op.arrow) {
        const head = arrowHead(op.x1, op.y1, op.x2, op.y2, Math.max(10, op.size * 4));
        if (head.length) {
          ctx.beginPath();
          ctx.moveTo(head[0].x, head[0].y);
          ctx.lineTo(head[1].x, head[1].y);
          ctx.lineTo(head[2].x, head[2].y);
          ctx.closePath();
          ctx.fill();
        }
      }
    } else if (op.op === 'path') {
      ctx.moveTo(op.points[0][0], op.points[0][1]);
      for (const [x, y] of op.points.slice(1)) ctx.lineTo(x, y);
      if (op.closed) ctx.closePath();
      ctx.stroke();
    } else {
      if (op.op === 'ellipse') ctx.ellipse(op.x + op.w / 2, op.y + op.h / 2, op.w / 2, op.h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(op.x, op.y, op.w, op.h);
      if (op.fill) ctx.fill();
      else ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * The text ops as the editor's own editable text objects.
 * @param ops - Checked ops.
 * @param idPrefix - Prefix that makes the ids unique inside the drawing.
 */
export function aiTexts(ops: readonly AiOp[], idPrefix = 'ai'): SourceText[] {
  const out: SourceText[] = [];
  for (const op of ops) {
    if (op.op !== 'text') continue;
    out.push({
      id: `${idPrefix}${out.length + 1}`,
      x: op.x,
      y: op.y,
      text: op.text,
      size: op.size,
      color: op.color,
      bold: op.bold || undefined,
    });
  }
  return out;
}

/**
 * A short phrase for what a list of ops draws: "3 shapes, 1 arrow and 2 labels".
 * @param ops - Checked ops.
 */
export function describeAiOps(ops: readonly AiOp[]): string {
  const count = (pred: (o: AiOp) => boolean) => ops.filter(pred).length;
  const arrows = count((o) => o.op === 'line' && o.arrow);
  const labels = count((o) => o.op === 'text');
  const shapes = ops.length - arrows - labels;
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(shapes, 'shape', 'shapes');
  add(arrows, 'arrow', 'arrows');
  add(labels, 'label', 'labels');
  if (parts.length <= 1) return parts[0] ?? 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
