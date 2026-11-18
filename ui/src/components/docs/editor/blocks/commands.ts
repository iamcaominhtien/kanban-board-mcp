/**
 * The block operations of the editor (Rich Docs phase 4): image placement and width, table merge / split and cell
 * shading, columns, callouts, dividers, list styles, and what the block handle's menu does (duplicate, move, delete,
 * turn into, link to a block). Each works on a mounted or headless TipTap editor, so the tests run them without a
 * screen. Attribute names and values are those of server/contract/richdoc/schema.json.
 */

import type { Editor, JSONContent, Range } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { stripBlockIds } from '../../../../richdoc/ids';
import type { CalloutKind } from '../constants';

/* ---------- images ---------- */

/** Where an image sits (schema.json `image.placement`). */
export type Placement = 'block' | 'left' | 'center' | 'right' | 'floatLeft' | 'floatRight';

/** The widths a resized image snaps to, in % of the text column. */
export const SNAP_STEPS = [25, 50, 75, 100] as const;

/**
 * A width in % of the text column, kept between 10 and 100 and snapped to 25 / 50 / 75 / 100 when it is close.
 * @param pct - The width the pointer gives, in %.
 * @param tolerance - How close (in %) counts as on a step.
 */
export function snapWidth(pct: number, tolerance = 4): number {
  const v = Math.min(100, Math.max(10, pct));
  const step = SNAP_STEPS.find((s) => Math.abs(s - v) <= tolerance);
  return step ?? Math.round(v);
}

/**
 * Merges `attrs` into the attributes of the node at `pos` (one undo step).
 * @param pos - The position just before the node.
 * @returns False when there is no node there.
 */
export function setNodeAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
  return true;
}

/** Image attributes a crop, a width and a place reset to (Reset size). */
export const IMAGE_SIZE_RESET = { widthPct: null, width: null, height: null, crop: null } as const;
/** Image attributes Reset style puts back. */
export const IMAGE_STYLE_RESET = { border: null, radius: 0, shadow: false } as const;

/** A crop frame: fractions (0..1) of the original picture. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A crop frame kept inside the picture, or null when it is the whole picture (nothing cropped).
 * @param c - The frame as drawn.
 */
export function normalizeCrop(c: Crop | null | undefined): Crop | null {
  if (!c) return null;
  const r = (n: number) => Math.round(n * 10000) / 10000;
  const w = Math.min(1, Math.max(0.02, c.w));
  const h = Math.min(1, Math.max(0.02, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  if (w > 0.999 && h > 0.999) return null;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

/* ---------- tables ---------- */

/** Whether the selected cells can be merged. */
export type MergeCheck = 'ok' | 'not-rectangle' | 'one-cell' | 'no-cells';

/** How many cells the cell selection holds (0 without one). */
export function selectedCellCount(state: EditorState): number {
  const sel = state.selection;
  if (!(sel instanceof CellSelection)) return 0;
  let n = 0;
  sel.forEachCell(() => {
    n += 1;
  });
  return n;
}

/**
 * Whether Merge cells can run: it needs two or more cells that make a rectangle (a merged cell that sticks out of
 * the selection breaks the rectangle).
 */
export function canMergeCells(editor: Editor): MergeCheck {
  const n = selectedCellCount(editor.state);
  if (n === 0) return 'no-cells';
  if (n === 1) return 'one-cell';
  return editor.can().mergeCells() ? 'ok' : 'not-rectangle';
}

/**
 * Merges the selected cells into one, keeping the text of every cell.
 * @returns `ok`, or why nothing was merged ("Merge not available" when it is not a rectangle).
 */
export function mergeSelectedCells(editor: Editor): MergeCheck {
  const check = canMergeCells(editor);
  if (check !== 'ok') return check;
  editor.chain().focus().mergeCells().run();
  return 'ok';
}

/** The cell (`tableCell` / `tableHeader`) that holds the caret or the selection's head, with its position. */
export function cellAt(state: EditorState): { node: PMNode; pos: number } | null {
  const sel = state.selection;
  if (sel instanceof CellSelection) return { node: sel.$headCell.nodeAfter as PMNode, pos: sel.$headCell.pos };
  const { $from } = sel;
  for (let d = $from.depth; d > 0; d -= 1) {
    const n = $from.node(d);
    if (n.type.spec.tableRole === 'cell' || n.type.spec.tableRole === 'header_cell')
      return { node: n, pos: $from.before(d) };
  }
  return null;
}

/** True when the cell in hand spans more than one row or column (Split cell can run). */
export function canSplitCell(editor: Editor): boolean {
  const cell = cellAt(editor.state);
  if (!cell) return false;
  return (cell.node.attrs.colspan ?? 1) > 1 || (cell.node.attrs.rowspan ?? 1) > 1;
}

/** Splits the merged cell in hand back into single cells; the text stays in the first one. */
export function splitSelectedCell(editor: Editor): boolean {
  if (!canSplitCell(editor)) return false;
  return editor.chain().focus().splitCell().run();
}

/** A cell attribute Cell properties sets (schema.json `tableCell`). */
export type CellAttr = 'background' | 'align' | 'verticalAlign' | 'border' | 'borderStyle' | 'borderColor' | 'padding';

/**
 * Sets one attribute on every selected cell (or the cell holding the caret).
 * @param name - `background` (a highlight name or null), `align`, `verticalAlign`, the border's `borderStyle` and
 *   `borderColor`, `padding`.
 */
export function setCellsAttr(editor: Editor, name: CellAttr, value: string | null) {
  return editor.chain().focus().setCellAttribute(name, value).run();
}

/** Which lines Cell properties draws round the selected cells (board F 30). */
export type BorderMode = 'all' | 'outer' | 'top' | 'bottom' | 'left' | 'right' | 'none';

/** The cells in hand (the cell selection, or the cell with the caret) as rectangles of the table's map. */
function cellsInHand(state: EditorState): {
  table: { node: PMNode; pos: number };
  rect: { left: number; top: number; right: number; bottom: number };
  cells: { pos: number; node: PMNode; left: number; top: number; right: number; bottom: number }[];
} | null {
  const t = tableAt(state);
  const cell = cellAt(state);
  if (!t || !cell) return null;
  const map = TableMap.get(t.node);
  const start = t.pos + 1;
  const sel = state.selection;
  const positions: number[] = [];
  if (sel instanceof CellSelection) sel.forEachCell((_n, pos) => positions.push(pos));
  else positions.push(cell.pos);
  const cells = positions.map((pos) => {
    const r = map.findCell(pos - start);
    return { pos, node: state.doc.nodeAt(pos) as PMNode, ...r };
  });
  const rect = {
    left: Math.min(...cells.map((c) => c.left)),
    top: Math.min(...cells.map((c) => c.top)),
    right: Math.max(...cells.map((c) => c.right)),
    bottom: Math.max(...cells.map((c) => c.bottom)),
  };
  return { table: t, rect, cells };
}

/** The `border` value each cell in hand gets for a mode: the sides of the selection's outline, or every side. */
export function bordersFor(state: EditorState, mode: BorderMode): Map<number, string> | null {
  const h = cellsInHand(state);
  if (!h) return null;
  const out = new Map<number, string>();
  for (const c of h.cells) {
    const sides: string[] = [];
    const edge = {
      top: c.top === h.rect.top,
      right: c.right === h.rect.right,
      bottom: c.bottom === h.rect.bottom,
      left: c.left === h.rect.left,
    };
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      if (mode === 'all' || (mode === 'outer' && edge[side]) || (mode === side && edge[side])) sides.push(side);
    }
    out.set(c.pos, sides.length ? sides.join(' ') : 'none');
  }
  return out;
}

/** The mode the cells in hand are drawn with now (`all` when none has its own lines), or null for a mix. */
export function currentBorderMode(state: EditorState): BorderMode | null {
  const h = cellsInHand(state);
  if (!h) return null;
  if (h.cells.every((c) => c.node.attrs.border == null)) return 'all';
  for (const mode of ['all', 'outer', 'top', 'bottom', 'left', 'right', 'none'] as const) {
    const want = bordersFor(state, mode);
    if (want && h.cells.every((c) => (c.node.attrs.border ?? 'top right bottom left') === want.get(c.pos))) return mode;
  }
  return null;
}

/** Draws the lines of a mode round the cells in hand ("All" puts the table's own lines back). */
export function setCellBorders(editor: Editor, mode: BorderMode): boolean {
  const want = bordersFor(editor.state, mode);
  if (!want) return false;
  const tr = editor.state.tr;
  for (const [pos, border] of want) {
    const node = tr.doc.nodeAt(pos);
    if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, border: mode === 'all' ? null : border });
  }
  editor.view.dispatch(tr);
  return true;
}

/**
 * Sets the width of the columns of the cells in hand, in px (null: back to automatic).
 * @param px - The width in CSS px, or null.
 */
export function setCellsWidth(editor: Editor, px: number | null): boolean {
  const h = cellsInHand(editor.state);
  if (!h) return false;
  const tr = editor.state.tr;
  const start = h.table.pos + 1;
  const map = TableMap.get(h.table.node);
  for (let col = h.rect.left; col < h.rect.right; col += 1) {
    for (let row = 0; row < map.height; row += 1) {
      const at = map.map[row * map.width + col];
      if (row > 0 && map.map[(row - 1) * map.width + col] === at) continue;
      const node = tr.doc.nodeAt(start + at);
      if (!node) continue;
      const span = (node.attrs.colspan as number) ?? 1;
      const widths = Array.isArray(node.attrs.colwidth) ? [...(node.attrs.colwidth as number[])] : Array(span).fill(0);
      const cellLeft = map.findCell(at).left;
      widths[col - cellLeft] = px ?? 0;
      const colwidth = widths.every((w) => !w) ? null : widths;
      tr.setNodeMarkup(start + at, undefined, { ...node.attrs, colwidth });
    }
  }
  editor.view.dispatch(tr);
  return true;
}

/** Puts the shading, alignment, lines and padding of the cells in hand back to their defaults (Clear formatting). */
export function clearCellFormatting(editor: Editor) {
  return editor
    .chain()
    .focus()
    .setCellAttribute('background', null)
    .setCellAttribute('align', null)
    .setCellAttribute('verticalAlign', null)
    .setCellAttribute('border', null)
    .setCellAttribute('borderStyle', null)
    .setCellAttribute('borderColor', null)
    .setCellAttribute('padding', null)
    .run();
}

/** The table that holds the selection, with its position. */
export function tableAt(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    const n = $from.node(d);
    if (n.type.name === 'table') return { node: n, pos: $from.before(d) };
  }
  return null;
}

/** Merges `attrs` (`style`, `width`, `banded`, `borders`, `spacing`, `align`, `caption`) into the table in hand. */
export function setTableAttrs(editor: Editor, attrs: Record<string, string | boolean | null>): boolean {
  const t = tableAt(editor.state);
  return t ? setNodeAttrs(editor, t.pos, attrs) : false;
}

/** True when every cell of the first row (`row`) or the first column (`column`) is a header cell. */
export function hasHeader(table: PMNode, which: 'row' | 'column'): boolean {
  const map = TableMap.get(table);
  const n = which === 'row' ? map.width : map.height;
  for (let i = 0; i < n; i += 1) {
    const at = which === 'row' ? map.map[i] : map.map[i * map.width];
    if (table.nodeAt(at)?.type.name !== 'tableHeader') return false;
  }
  return true;
}

/** What the Insert table picker chose. */
export interface TableSize {
  rows: number;
  cols: number;
  headerRow?: boolean;
  headerColumn?: boolean;
  fullWidth?: boolean;
}

/** The table JSON for a size: header row and column as asked, every cell with an empty paragraph. */
export function tableJson({ rows, cols, headerRow = true, headerColumn = false, fullWidth = false }: TableSize) {
  const r = Math.max(1, Math.min(30, Math.round(rows)));
  const c = Math.max(1, Math.min(12, Math.round(cols)));
  const row = (i: number): JSONContent => ({
    type: 'tableRow',
    content: Array.from({ length: c }, (_, j) => ({
      type: (headerRow && i === 0) || (headerColumn && j === 0) ? 'tableHeader' : 'tableCell',
      content: [{ type: 'paragraph' }],
    })),
  });
  const table: JSONContent = { type: 'table', content: Array.from({ length: r }, (_, i) => row(i)) };
  if (fullWidth) table.attrs = { width: 'full' };
  return table;
}

/**
 * Inserts a table of the size chosen, at the cursor or in place of `range` (the typed "/table").
 * @returns True when it went in.
 */
export function insertTableSized(editor: Editor, size: TableSize, range?: Range): boolean {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  return chain.insertContent(tableJson(size)).run();
}

/* ---------- columns ---------- */

/** The column JSON for `n` empty columns. */
export function columnsJson(n: number, ratio: string | null = null): JSONContent {
  const count = Math.max(2, Math.min(4, n));
  return {
    type: 'columns',
    ...(ratio ? { attrs: { ratio } } : {}),
    content: Array.from({ length: count }, () => ({ type: 'column', content: [{ type: 'paragraph' }] })),
  };
}

/** Inserts `n` (2 to 4) empty columns at the cursor or in place of `range`, the caret in the first one. */
export function insertColumns(editor: Editor, n: number, range?: Range): boolean {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  const before = editor.state.selection.from - (range ? range.to - range.from : 0);
  const ok = chain.insertContent(columnsJson(n)).run();
  if (!ok) return false;
  // the caret into the first column's paragraph
  const { doc } = editor.state;
  let target: number | null = null;
  doc.nodesBetween(Math.max(0, before - 2), doc.content.size, (node, pos) => {
    if (target !== null) return false;
    if (node.type.name === 'column') {
      target = pos + 2;
      return false;
    }
    return true;
  });
  if (target !== null) editor.commands.setTextSelection(target);
  return true;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * The stored ratio for column weights (`[1, 2]` → "1:2"), or null for equal columns (the default).
 * @param weights - One positive number per column.
 */
export function ratioFromWeights(weights: number[]): string | null {
  const ints = weights.map((w) => Math.max(1, Math.round(w)));
  const g = ints.reduce((a, b) => gcd(a, b));
  const out = ints.map((w) => w / g);
  return out.every((w) => w === out[0]) ? null : out.join(':');
}

/**
 * The weights of a stored ratio for `n` columns: equal ones when the ratio is missing or does not fit.
 * @param ratio - "1:2", "1:1:1" or null.
 */
export function weightsOf(ratio: unknown, n: number): number[] {
  const parts =
    typeof ratio === 'string'
      ? ratio
          .split(':')
          .map(Number)
          .filter((x) => x > 0)
      : [];
  return parts.length === n ? parts : Array.from({ length: n }, () => 1);
}

/** The fractions the middle bar snaps to (share of the left column in a pair). */
const PAIR_STEPS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];

/**
 * New weights after dragging the bar between column `i` and `i + 1` to `fraction` of their combined width; the
 * share snaps to a quarter, a third or a half, and the result is in twelfths.
 */
export function dragRatio(weights: number[], i: number, fraction: number): number[] {
  const share = PAIR_STEPS.reduce((best, s) => (Math.abs(s - fraction) < Math.abs(best - fraction) ? s : best));
  const total = weights.reduce((a, b) => a + b, 0);
  const twelfths = weights.map((w) => (w / total) * 12);
  const pair = twelfths[i] + twelfths[i + 1];
  const out = [...twelfths];
  out[i] = pair * share;
  out[i + 1] = pair - out[i];
  // keep whole twelfths when the pair allows it, else whole 24ths
  const scale = out.every((w) => Math.abs(w - Math.round(w)) < 0.01) ? 1 : 2;
  return out.map((w) => Math.max(1, Math.round(w * scale)));
}

/**
 * Changes the number of columns of the `columns` block at `pos`: new columns come empty, and the blocks of removed
 * columns move into the last column kept, so no text is lost. The ratio goes back to equal.
 */
export function setColumnCount(editor: Editor, pos: number, n: number): boolean {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'columns') return false;
  const count = Math.max(2, Math.min(4, n));
  if (count === node.childCount) return true;
  const schema = state.schema;
  const cols: PMNode[] = [];
  node.forEach((c) => cols.push(c));
  let next: PMNode[];
  if (count > cols.length) {
    next = [
      ...cols,
      ...Array.from({ length: count - cols.length }, () =>
        schema.nodes.column.create(null, schema.nodes.paragraph.create()),
      ),
    ];
  } else {
    const kept = cols.slice(0, count);
    const moved: PMNode[] = [];
    cols.slice(count).forEach((c) => c.forEach((b) => moved.push(b)));
    const last = kept[count - 1];
    const blocks: PMNode[] = [];
    last.forEach((b) => blocks.push(b));
    kept[count - 1] = schema.nodes.column.create(last.attrs, [...blocks, ...moved]);
    next = kept;
  }
  const replacement = node.type.create({ ...node.attrs, ratio: null }, next);
  editor.view.dispatch(state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
  return true;
}

/* ---------- callouts, quotes, dividers, lists ---------- */

/** The divider styles (schema.json `horizontalRule.style`), in the order of the picker. */
export const RULE_STYLES = [
  { value: 'line', label: 'Line', hint: 'Between sections of a spec' },
  { value: 'thick', label: 'Thick line', hint: 'A strong break' },
  { value: 'double', label: 'Double line', hint: 'A formal break' },
  { value: 'short', label: 'Short rule', hint: 'Under a title or between paragraphs' },
  { value: 'wave', label: 'Dotted', hint: 'A light break' },
  { value: 'stars', label: 'Three stars', hint: 'Scene break in a story' },
  { value: 'dots', label: 'Three dots', hint: 'A quiet scene break' },
  { value: 'fleuron', label: 'Ornament', hint: 'Chapter end in a book' },
] as const;

export type RuleStyle = (typeof RULE_STYLES)[number]['value'];

/** Inserts a divider of `style` at the cursor or in place of `range`. */
export function insertDivider(editor: Editor, style: RuleStyle = 'line', range?: Range): boolean {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  if (style === 'line') return chain.setHorizontalRule().run();
  return chain.insertContent([{ type: 'horizontalRule', attrs: { style } }, { type: 'paragraph' }]).run();
}

/** Inserts an empty pull quote at the cursor or in place of `range`, the caret in it. */
export function insertPullQuote(editor: Editor, range?: Range): boolean {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  return chain.setNode('pullQuote').run();
}

/** Inserts a callout of `kind` (wrapping the line), or in place of `range`. */
export function insertCallout(editor: Editor, kind: CalloutKind, range?: Range): boolean {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  return chain.setCallout(kind).run();
}

/** The bullet and number markers (schema.json `listStyle`), with how the picker shows them. */
export const BULLET_STYLES = [
  { value: null, label: 'Default', sample: '•' },
  { value: 'disc', label: 'Disc', sample: '•' },
  { value: 'circle', label: 'Circle', sample: '◦' },
  { value: 'square', label: 'Square', sample: '▪' },
  { value: 'dash', label: 'Dash', sample: '–' },
] as const;
export const NUMBER_STYLES = [
  { value: null, label: 'Default', sample: '1. 2. 3.' },
  { value: 'decimal', label: 'Numbers', sample: '1. 2. 3.' },
  { value: 'lower-alpha', label: 'Letters', sample: 'a. b. c.' },
  { value: 'upper-alpha', label: 'Capitals', sample: 'A. B. C.' },
  { value: 'lower-roman', label: 'Roman', sample: 'i. ii. iii.' },
  { value: 'upper-roman', label: 'Roman capitals', sample: 'I. II. III.' },
  { value: 'decimal-paren', label: 'Numbers with bracket', sample: '1) 2) 3)' },
] as const;

/* ---------- blocks: the handle and its menu ---------- */

/** A block of the page: a child of the document or of a column (schema.json `topLevelParents`). */
export interface BlockRef {
  node: PMNode;
  pos: number;
}

/**
 * The block that holds `pos`: the outermost node whose parent is the document or a column, or, when `pos` sits right
 * before a block of the page, that block.
 */
export function blockAt(state: EditorState, pos: number): BlockRef | null {
  const doc = state.doc;
  const p = Math.max(0, Math.min(pos, doc.content.size));
  const $p = doc.resolve(p);
  const after = $p.nodeAfter;
  if (after && after.isBlock && ($p.parent.type.name === 'doc' || $p.parent.type.name === 'column'))
    return { node: after, pos: p };
  for (let d = $p.depth; d > 0; d -= 1) {
    const parent = $p.node(d - 1).type.name;
    if (parent === 'doc' || parent === 'column') return { node: $p.node(d), pos: $p.before(d) };
  }
  return null;
}

/** The block that holds the selection. */
export const currentBlock = (state: EditorState) => blockAt(state, state.selection.from);

/**
 * Inserts a copy of the block at `pos` right after it. The copy (and every block inside it) gets a new block id.
 * @returns The position of the copy, or null.
 */
export function duplicateBlock(editor: Editor, pos: number): number | null {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const copy = state.schema.nodeFromJSON(stripBlockIds(node.toJSON() as JSONContent));
  const at = pos + node.nodeSize;
  editor.view.dispatch(state.tr.insert(at, copy).scrollIntoView());
  return at;
}

/**
 * Moves the block at `pos` one place up (-1) or down (1) among its siblings.
 * @returns The block's new position, or null when it cannot move.
 */
export function moveBlock(editor: Editor, pos: number, dir: -1 | 1): number | null {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const $pos = state.doc.resolve(pos);
  const index = $pos.index();
  const parent = $pos.parent;
  if (dir < 0 && index === 0) return null;
  if (dir > 0 && index >= parent.childCount - 1) return null;
  const tr = state.tr;
  if (dir < 0) {
    const prev = parent.child(index - 1);
    const target = pos - prev.nodeSize;
    tr.delete(pos, pos + node.nodeSize).insert(target, node);
    editor.view.dispatch(tr.scrollIntoView());
    return target;
  }
  const next = parent.child(index + 1);
  tr.delete(pos, pos + node.nodeSize);
  const target = pos + next.nodeSize;
  tr.insert(target, node);
  editor.view.dispatch(tr.scrollIntoView());
  return target;
}

/**
 * Deletes the blocks at `positions` (one undo step). A page left with nothing gets an empty paragraph.
 */
export function deleteBlocks(editor: Editor, positions: number[]): boolean {
  const { state } = editor;
  const sorted = [...new Set(positions)].sort((a, b) => b - a);
  if (!sorted.length) return false;
  const tr = state.tr;
  for (const p of sorted) {
    const node = tr.doc.nodeAt(p);
    if (node) tr.delete(p, p + node.nodeSize);
  }
  if (tr.doc.childCount === 0 || tr.doc.content.size === 0) tr.insert(0, state.schema.nodes.paragraph.create());
  editor.view.dispatch(tr);
  return true;
}

/** Duplicates the blocks at `positions`; the copies go right after the last of them, in order. */
export function duplicateBlocks(editor: Editor, positions: number[]): boolean {
  const { state } = editor;
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const nodes = sorted.map((p) => state.doc.nodeAt(p)).filter((n): n is PMNode => !!n);
  if (!nodes.length) return false;
  const last = sorted[sorted.length - 1];
  const at = last + (state.doc.nodeAt(last)?.nodeSize ?? 0);
  const copies = nodes.map((n) => state.schema.nodeFromJSON(stripBlockIds(n.toJSON() as JSONContent)));
  editor.view.dispatch(state.tr.insert(at, copies));
  return true;
}

/** The kinds a block can be turned into (block menu, Turn into). */
export const TURN_INTO = [
  { id: 'paragraph', label: 'Paragraph', tile: '¶' },
  { id: 'h1', label: 'Heading 1', tile: 'H1' },
  { id: 'h2', label: 'Heading 2', tile: 'H2' },
  { id: 'h3', label: 'Heading 3', tile: 'H3' },
  { id: 'h4', label: 'Heading 4', tile: 'H4' },
  { id: 'quote', label: 'Quote', tile: '“' },
  { id: 'callout', label: 'Callout', tile: 'i' },
  { id: 'bulletList', label: 'Bulleted list', tile: '•' },
  { id: 'orderedList', label: 'Numbered list', tile: '1.' },
  { id: 'taskList', label: 'Task list', tile: '☑' },
  { id: 'codeBlock', label: 'Code block', tile: '</>' },
  { id: 'columns', label: 'Columns', tile: '▥' },
] as const;

export type TurnIntoKind = (typeof TURN_INTO)[number]['id'];

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * Turns the block at `pos` into another kind, keeping its text: a paragraph into a heading or a list, a list into
 * another kind of list, a quote back into paragraphs, any block into the first of two columns.
 * @returns True when the block changed.
 */
export function turnInto(editor: Editor, pos: number, kind: TurnIntoKind): boolean {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node) return false;
  if (kind === 'columns') {
    if (node.type.name === 'columns') return false;
    const schema = state.schema;
    const cols = schema.nodes.columns.create(null, [
      schema.nodes.column.create(null, node),
      schema.nodes.column.create(null, schema.nodes.paragraph.create()),
    ]);
    editor.view.dispatch(state.tr.replaceWith(pos, pos + node.nodeSize, cols));
    return true;
  }
  // select the block's text, then let the editor's own commands change it
  const inner = node.isTextblock
    ? TextSelection.create(state.doc, pos + 1, pos + 1 + node.content.size)
    : TextSelection.between(state.doc.resolve(pos + 1), state.doc.resolve(pos + node.nodeSize - 1));
  editor.view.dispatch(state.tr.setSelection(inner));
  const chain = () => editor.chain().focus();
  const name = node.type.name;
  const isList = LIST_TYPES.has(name);
  switch (kind) {
    case 'paragraph':
      return chain().clearNodes().setParagraph().run();
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
      return chain()
        .clearNodes()
        .setHeading({ level: Number(kind.slice(1)) as 1 | 2 | 3 | 4 })
        .run();
    case 'codeBlock':
      return chain().clearNodes().setCodeBlock().run();
    case 'quote':
      return name === 'blockquote' ? false : chain().clearNodes().setBlockquote().run();
    case 'callout':
      return name === 'callout' ? false : chain().clearNodes().setCallout('info').run();
    case 'bulletList':
      if (name === 'bulletList') return false;
      return isList ? chain().toggleBulletList().run() : chain().clearNodes().toggleBulletList().run();
    case 'orderedList':
      if (name === 'orderedList') return false;
      return isList ? chain().toggleOrderedList().run() : chain().clearNodes().toggleOrderedList().run();
    case 'taskList':
      if (name === 'taskList') return false;
      return isList ? chain().toggleTaskList().run() : chain().clearNodes().toggleTaskList().run();
    default:
      return false;
  }
}

/**
 * The address of a block: the page's address with `#block-<blockId>`, which scrolls to it.
 * @param pageUrl - The page's address (any `#…` on it is replaced).
 * @param blockId - The block's id (`b-xxxxxx`).
 */
export function blockLink(pageUrl: string, blockId: string): string {
  return `${pageUrl.replace(/#.*$/, '')}#block-${blockId}`;
}

/** The name of a block's kind as the block menu shows it ("Paragraph", "Heading 2", "Image"…). */
export function blockLabel(node: PMNode): string {
  const n = node.type.name;
  if (n === 'heading') return `Heading ${node.attrs.level ?? 1}`;
  const names: Record<string, string> = {
    paragraph: 'Paragraph',
    blockquote: 'Quote',
    pullQuote: 'Pull quote',
    bulletList: 'Bulleted list',
    orderedList: 'Numbered list',
    taskList: 'Task list',
    codeBlock: 'Code block',
    horizontalRule: 'Divider',
    table: 'Table',
    image: 'Image',
    callout: 'Callout',
    columns: 'Columns',
    mathBlock: 'Formula',
    diagram: 'draw.io drawing',
    sketch: 'Sketch',
    canvas: 'Canvas',
    video: 'Video',
    htmlEmbed: 'HTML',
    fileCard: 'File',
    linkEmbed: 'Link',
    pageCard: 'Page card',
    ticketCard: 'Ticket card',
  };
  return names[n] ?? n.charAt(0).toUpperCase() + n.slice(1);
}

/** Whether a block's kind can be turned into another (text blocks, lists, quotes and callouts). */
export function canTurnInto(node: PMNode): boolean {
  return (
    node.isTextblock || ['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout'].includes(node.type.name)
  );
}
