import { unzipSync, type Unzipped } from 'fflate';
import { BUILTIN_FORMATS, formatValue } from './numFmt';
import {
  drawingContext,
  hslAdjust,
  readAnchored,
  readTheme,
  rels,
  rid,
  type MakeUrl,
  type RenderedShape,
} from './pptxRender';
import { xml } from './office';
import type { RefLookup } from './pptxChart';

/**
 * Read an .xlsx into sheets that can be drawn like Excel shows them: cell fills, fonts, borders and alignment, number
 * and date formats, merged cells, column widths and row heights, frozen panes, colour scales and data bars, and the
 * charts, pictures and shapes laid over the cells. Formulas show their last saved result; nothing in the file runs.
 */

/** Bigger workbooks are not read in the browser. */
const BYTES_LIMIT = 30 * 1024 * 1024;
/** Rows and columns read from a sheet (the view shows a part of them at a time). */
export const ROWS_READ = 5000;
export const COLS_READ = 200;

const EMU_PX = 1 / 9525;
const PT_PX = 96 / 72;

/** Thrown when a workbook cannot be read: protected, too large or damaged. */
export class XlsxError extends Error {
  reason: 'protected' | 'too-large' | 'damaged';
  constructor(reason: 'protected' | 'too-large' | 'damaged') {
    super(reason);
    this.reason = reason;
  }
}

/** The look of a cell, from its style record. */
export interface CellLook {
  bg?: string;
  color?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontPx: number;
  font: string;
  align: 'general' | 'left' | 'center' | 'right' | 'justify';
  vAlign: 'top' | 'center' | 'bottom';
  wrap: boolean;
  indentPx: number;
  /** CSS borders: left, top, right, bottom. */
  borders: (string | undefined)[];
  format: string;
}

export interface XlsxCell {
  /** What the cell shows. */
  text: string;
  /** The number, when the cell holds one (for colour scales and data bars). */
  number?: number;
  kind: 'number' | 'text' | 'bool' | 'error' | 'blank';
  look: CellLook;
  /** A colour the number format asks for (`[Red]`). */
  formatColor?: string;
  /** What conditional formatting adds. */
  cf?: { bg?: string; color?: string; bold?: boolean; bar?: { pct: number; color: string } };
}

export interface XlsxSheet {
  name: string;
  tabColor?: string;
  rows: (XlsxCell | undefined)[][];
  /** Row heights and column widths in px, as drawn. */
  rowHeights: number[];
  rowHidden: boolean[];
  colWidths: number[];
  colHidden: boolean[];
  defaultRowPx: number;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  showGrid: boolean;
  freezeRows: number;
  freezeCols: number;
  /** Charts, pictures and shapes, in px from the top left of cell A1. */
  shapes: RenderedShape[];
  /** Rows the sheet has. */
  totalRows: number;
  columns: number;
}

export interface XlsxBook {
  sheets: XlsxSheet[];
}

// ── colours ────────────────────────────────────────────────────────────────────────────────────────────────────────

const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
]; // prettier-ignore
const THEME_ORDER = [
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
];

type Colors = { theme: Map<string, string>; indexed: string[] };

const attr = (el: Element | null | undefined, name: string) => el?.getAttribute(name) ?? '';
const num = (el: Element | null | undefined, name: string, fallback = 0) => {
  const v = Number(attr(el, name));
  return attr(el, name) !== '' && Number.isFinite(v) ? v : fallback;
};
const kids = (el: Element | null | undefined, tag: string) =>
  Array.from(el?.children ?? []).filter((c) => c.localName === tag);
const first = (el: Element | null | undefined, tag: string): Element | null => kids(el, tag)[0] ?? null;
const all = (el: Document | Element, tag: string) => Array.from(el.getElementsByTagNameNS('*', tag));

/** A colour element (`color`, `fgColor`, `bgColor`) as CSS, or undefined for "automatic". */
function colorOf(el: Element | null | undefined, colors: Colors): string | undefined {
  if (!el) return undefined;
  let hex = '';
  if (el.hasAttribute('rgb')) hex = attr(el, 'rgb').slice(-6);
  else if (el.hasAttribute('theme')) hex = colors.theme.get(THEME_ORDER[num(el, 'theme')] ?? '') ?? '';
  else if (el.hasAttribute('indexed')) hex = colors.indexed[num(el, 'indexed')] ?? '';
  if (!/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  const tint = num(el, 'tint');
  if (tint > 0) hex = hslAdjust(hex, 1 - tint, tint);
  else if (tint < 0) hex = hslAdjust(hex, 1 + tint, 0);
  return `#${hex}`;
}

// ── styles ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Styles {
  looks: CellLook[];
  /** The style records' number format codes. */
  dxfs: { bg?: string; color?: string; bold?: boolean }[];
}

const BORDER_CSS: Record<string, string> = {
  thin: '1px solid',
  hair: '1px dotted',
  dotted: '1px dotted',
  dashed: '1px dashed',
  dashDot: '1px dashed',
  dashDotDot: '1px dashed',
  slantDashDot: '1px dashed',
  mediumDashed: '2px dashed',
  mediumDashDot: '2px dashed',
  mediumDashDotDot: '2px dashed',
  medium: '2px solid',
  thick: '3px solid',
  double: '3px double',
};

function readStyles(doc: Document | null, colors: Colors): Styles {
  const out: Styles = { looks: [], dxfs: [] };
  if (!doc) return out;
  const formats = new Map<number, string>();
  for (const n of all(doc, 'numFmt')) formats.set(num(n, 'numFmtId'), attr(n, 'formatCode'));
  const fonts = kids(first(doc.documentElement, 'fonts'), 'font').map((f) => ({
    b: !!first(f, 'b') && attr(first(f, 'b'), 'val') !== '0',
    i: !!first(f, 'i') && attr(first(f, 'i'), 'val') !== '0',
    u: !!first(f, 'u') && attr(first(f, 'u'), 'val') !== 'none',
    strike: !!first(f, 'strike') && attr(first(f, 'strike'), 'val') !== '0',
    sz: num(first(f, 'sz'), 'val', 11),
    name: attr(first(f, 'name'), 'val') || 'Calibri',
    color: colorOf(first(f, 'color'), colors),
  }));
  const fills = kids(first(doc.documentElement, 'fills'), 'fill').map((f) => {
    const pat = first(f, 'patternFill');
    if (pat) return attr(pat, 'patternType') === 'solid' ? colorOf(first(pat, 'fgColor'), colors) : undefined;
    const stop = first(first(first(f, 'gradientFill'), 'stop'), 'color');
    return colorOf(stop, colors);
  });
  const edge = (b: Element | null | undefined, side: string) => {
    const e = first(b, side);
    const style = attr(e, 'style');
    if (!style) return undefined;
    return `${BORDER_CSS[style] ?? '1px solid'} ${colorOf(first(e, 'color'), colors) ?? '#000000'}`;
  };
  const borders = kids(first(doc.documentElement, 'borders'), 'border').map((b) => [
    edge(b, 'left'),
    edge(b, 'top'),
    edge(b, 'right'),
    edge(b, 'bottom'),
  ]);
  const base = fonts[0];
  for (const xf of kids(first(doc.documentElement, 'cellXfs'), 'xf')) {
    const font = fonts[num(xf, 'fontId')] ?? base;
    const al = first(xf, 'alignment');
    const h = attr(al, 'horizontal');
    const v = attr(al, 'vertical');
    const id = num(xf, 'numFmtId');
    out.looks.push({
      bg: fills[num(xf, 'fillId')],
      color: font?.color,
      bold: !!font?.b,
      italic: !!font?.i,
      underline: !!font?.u,
      strike: !!font?.strike,
      fontPx: (font?.sz ?? 11) * PT_PX,
      font: font?.name ?? 'Calibri',
      align:
        h === 'center' || h === 'centerContinuous'
          ? 'center'
          : h === 'right'
            ? 'right'
            : h === 'left'
              ? 'left'
              : h === 'justify'
                ? 'justify'
                : 'general',
      vAlign: v === 'top' ? 'top' : v === 'center' ? 'center' : 'bottom',
      wrap: attr(al, 'wrapText') === '1' || attr(al, 'wrapText') === 'true',
      indentPx: num(al, 'indent') * 9,
      borders: borders[num(xf, 'borderId')] ?? [undefined, undefined, undefined, undefined],
      format: formats.get(id) ?? BUILTIN_FORMATS[id] ?? 'General',
    });
  }
  for (const dxf of kids(first(doc.documentElement, 'dxfs'), 'dxf')) {
    const font = first(dxf, 'font');
    const fill = first(first(dxf, 'fill'), 'patternFill');
    out.dxfs.push({
      color: colorOf(first(font, 'color'), colors),
      bold: first(font, 'b') ? attr(first(font, 'b'), 'val') !== '0' : undefined,
      bg: colorOf(first(fill, 'bgColor'), colors) ?? colorOf(first(fill, 'fgColor'), colors),
    });
  }
  return out;
}

// ── references ─────────────────────────────────────────────────────────────────────────────────────────────────────

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** "B3" as column and row (0-based). */
function cellRef(ref: string): { c: number; r: number } {
  return { c: colIndex(ref), r: Number(/\d+/.exec(ref)?.[0] ?? '1') - 1 };
}

/** "A1:B3 D5" as boxes. */
function ranges(sqref: string): { r1: number; c1: number; r2: number; c2: number }[] {
  return sqref
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const [a, b = a] = part.split(':');
      const p = cellRef(a);
      const q = cellRef(b);
      return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
    });
}

// ── the workbook ───────────────────────────────────────────────────────────────────────────────────────────────────

const WANTED =
  /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|theme\/theme\d+\.xml|worksheets\/[^/]+\.xml|worksheets\/_rels\/[^/]+\.rels|drawings\/[^/]+\.xml|drawings\/_rels\/[^/]+\.rels|charts\/chart\d+\.xml|media\/[^/]+)$/;

/**
 * Read a workbook for drawing.
 * @param bytes - The file.
 * @param makeUrl - Makes a URL for a picture of the file (the viewer takes the URLs back when it closes).
 */
export function parseXlsxBook(bytes: Uint8Array, makeUrl: MakeUrl): XlsxBook {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new XlsxError('protected');
  let files: Unzipped;
  try {
    files = unzipSync(bytes, { filter: (f) => WANTED.test(f.name) && f.originalSize <= BYTES_LIMIT });
  } catch {
    throw new XlsxError('damaged');
  }
  const wb = xml(files['xl/workbook.xml']);
  if (!wb) throw new XlsxError('damaged');
  const date1904 = attr(all(wb, 'workbookPr')[0], 'date1904') === '1';
  const bookRels = rels(files, 'xl/workbook.xml');
  const themePart = Object.keys(files).find((n) => n.startsWith('xl/theme/'));
  const theme = readTheme(files, themePart);
  const colors: Colors = { theme: theme.colors, indexed: INDEXED };
  const styleDoc = xml(files['xl/styles.xml']);
  const customIndexed = styleDoc ? all(styleDoc, 'indexedColors')[0] : undefined;
  if (customIndexed) colors.indexed = kids(customIndexed, 'rgbColor').map((c) => attr(c, 'rgb').slice(-6));
  const styles = readStyles(styleDoc, colors);
  const defaultLook: CellLook = styles.looks[0] ?? {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    fontPx: 11 * PT_PX,
    font: 'Calibri',
    align: 'general',
    vAlign: 'bottom',
    wrap: false,
    indentPx: 0,
    borders: [],
    format: 'General',
  };

  const shared: string[] = [];
  const ss = xml(files['xl/sharedStrings.xml']);
  for (const si of ss ? all(ss, 'si') : []) {
    let s = '';
    for (const child of Array.from(si.children)) {
      if (child.localName === 't') s += child.textContent ?? '';
      else if (child.localName === 'r') s += first(child, 't')?.textContent ?? '';
    }
    shared.push(s);
  }
  // a digit of the default font sets the unit of a column width
  const digitPx = Math.round(defaultLook.fontPx * 0.53) || 7;

  const sheets: XlsxSheet[] = [];
  const drawJobs: ((lookup: RefLookup) => void)[] = [];
  for (const s of all(wb, 'sheet')) {
    if (attr(s, 'state') === 'hidden' || attr(s, 'state') === 'veryHidden') continue;
    const name = attr(s, 'name') || `Sheet ${sheets.length + 1}`;
    const target = bookRels.get(rid(s, 'id')) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const doc = xml(files[target]);
    sheets.push(
      doc
        ? readSheet(name, doc, target, files, colors, styles, defaultLook, shared, date1904, digitPx, makeUrl, drawJobs)
        : emptySheet(name),
    );
  }
  if (!sheets.length) throw new XlsxError('damaged');
  // a chart that holds no values reads them from the cells it points at
  const lookup: RefLookup = (formula) => {
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(
      formula.replace(/^\(|\)$/g, ''),
    );
    if (!m) return [];
    const target = sheets.find((x) => x.name === (m[1] ? m[1].replace(/''/g, "'") : m[2]));
    if (!target) return [];
    const a = cellRef(`${m[3]}${m[4]}`);
    const z = cellRef(`${m[5] ?? m[3]}${m[6] ?? m[4]}`);
    const out: string[] = [];
    for (let r = a.r; r <= z.r; r++)
      for (let c = a.c; c <= z.c; c++) {
        const cell = target.rows[r]?.[c];
        out.push(cell ? String(cell.number ?? cell.text) : '');
      }
    return out;
  };
  for (const job of drawJobs) job(lookup);
  return { sheets };
}

function emptySheet(name: string): XlsxSheet {
  return {
    name,
    rows: [],
    rowHeights: [],
    rowHidden: [],
    colWidths: [],
    colHidden: [],
    defaultRowPx: 20,
    merges: [],
    showGrid: true,
    freezeRows: 0,
    freezeCols: 0,
    shapes: [],
    totalRows: 0,
    columns: 0,
  };
}

function readSheet(
  name: string,
  doc: Document,
  part: string,
  files: Unzipped,
  colors: Colors,
  styles: Styles,
  defaultLook: CellLook,
  shared: string[],
  date1904: boolean,
  digitPx: number,
  makeUrl: MakeUrl,
  drawJobs: ((lookup: RefLookup) => void)[],
): XlsxSheet {
  const root = doc.documentElement;
  const fmt = first(root, 'sheetFormatPr');
  const defaultRowPx = num(fmt, 'defaultRowHeight', 15) * PT_PX;
  const defaultColPx = Math.round(num(fmt, 'defaultColWidth', num(fmt, 'baseColWidth', 8) + 0.43) * digitPx + 5);
  const sheet = emptySheet(name);
  sheet.defaultRowPx = defaultRowPx;
  sheet.tabColor = colorOf(first(first(root, 'sheetPr'), 'tabColor'), colors);

  // columns
  const widths: number[] = [];
  const hiddenCols: boolean[] = [];
  for (const col of kids(first(root, 'cols'), 'col')) {
    const px = Math.round(num(col, 'width', 8.43) * digitPx + 5);
    for (let c = num(col, 'min', 1) - 1; c < Math.min(num(col, 'max', 1), COLS_READ); c++) {
      widths[c] = px;
      hiddenCols[c] = attr(col, 'hidden') === '1';
    }
  }

  // the cells
  const rows: (XlsxCell | undefined)[][] = [];
  const heights: number[] = [];
  const hiddenRows: boolean[] = [];
  const blank: XlsxCell = { text: '', kind: 'blank', look: defaultLook };
  let total = 0;
  let columns = 0;
  for (const rowEl of kids(first(root, 'sheetData'), 'row')) {
    const r = num(rowEl, 'r', rows.length + 1) - 1;
    total = Math.max(total, r + 1);
    if (r >= ROWS_READ) continue;
    if (attr(rowEl, 'ht')) heights[r] = num(rowEl, 'ht') * PT_PX;
    hiddenRows[r] = attr(rowEl, 'hidden') === '1';
    const out: (XlsxCell | undefined)[] = [];
    for (const c of kids(rowEl, 'c')) {
      const idx = colIndex(attr(c, 'r'));
      if (idx < 0 || idx >= COLS_READ) continue;
      const look = styles.looks[num(c, 's')] ?? defaultLook;
      const type = attr(c, 't');
      const v = first(c, 'v')?.textContent ?? '';
      let cell: XlsxCell = { ...blank, look };
      if (type === 's') cell = { text: shared[Number(v)] ?? '', kind: 'text', look };
      else if (type === 'inlineStr')
        cell = {
          text: all(c, 't')
            .map((t) => t.textContent ?? '')
            .join(''),
          kind: 'text',
          look,
        };
      else if (type === 'str') cell = { text: v, kind: 'text', look };
      else if (type === 'b') cell = { text: v === '1' ? 'TRUE' : 'FALSE', kind: 'bool', look };
      else if (type === 'e') cell = { text: v, kind: 'error', look };
      else if (v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) {
          const f = formatValue(n, look.format, date1904);
          cell = { text: f.text, number: n, kind: 'number', look, formatColor: f.color };
        } else cell = { text: v, kind: 'text', look };
      }
      if (cell.kind === 'text' && /@/.test(look.format) && look.format !== 'General') {
        const f = formatValue(cell.text, look.format, date1904);
        cell = { ...cell, text: f.text, formatColor: f.color };
      }
      if (cell.kind !== 'blank' || look !== defaultLook) {
        while (out.length < idx) out.push(undefined);
        out[idx] = cell;
        columns = Math.max(columns, idx + 1);
      }
    }
    while (rows.length < r) rows.push([]);
    rows[r] = out;
  }

  // merges, panes, grid
  const merges = kids(first(root, 'mergeCells'), 'mergeCell').flatMap((m) => ranges(attr(m, 'ref')));
  const view = first(first(root, 'sheetViews'), 'sheetView');
  const pane = first(view, 'pane');
  const frozen = !!pane && /frozen/.test(attr(pane, 'state'));

  Object.assign(sheet, {
    rows,
    merges,
    showGrid: attr(view, 'showGridLines') !== '0' && attr(view, 'showGridLines') !== 'false',
    freezeRows: frozen ? num(pane, 'ySplit') : 0,
    freezeCols: frozen ? num(pane, 'xSplit') : 0,
    totalRows: total,
    columns,
  } satisfies Partial<XlsxSheet>);

  const nCols = Math.max(columns, widths.length, 1);
  sheet.colWidths = Array.from({ length: nCols }, (_, c) => (hiddenCols[c] ? 0 : (widths[c] ?? defaultColPx)));
  sheet.colHidden = Array.from({ length: nCols }, (_, c) => !!hiddenCols[c]);
  const nRows = Math.max(rows.length, 1);
  sheet.rowHeights = Array.from({ length: nRows }, (_, r) => heights[r] ?? defaultRowPx);
  sheet.rowHidden = Array.from({ length: nRows }, (_, r) => !!hiddenRows[r]);

  applyConditionalFormats(root, sheet, styles, colors);

  drawJobs.push((lookup) => readDrawings(sheet, root, part, files, defaultColPx, makeUrl, lookup));
  return sheet;
}

/** The charts, pictures and shapes laid over a sheet's cells, put at the place their anchors give. */
function readDrawings(
  sheet: XlsxSheet,
  root: Element,
  part: string,
  files: Unzipped,
  defaultColPx: number,
  makeUrl: MakeUrl,
  lookup: RefLookup,
) {
  const sheetRels = rels(files, part);
  const drawingPart = sheetRels.get(rid(first(root, 'drawing'), 'id'));
  const drawingDoc = drawingPart ? xml(files[drawingPart]) : null;
  if (drawingPart && drawingDoc) {
    const ctx = drawingContext(
      files,
      Object.keys(files).find((n) => n.startsWith('xl/theme/')),
      makeUrl,
      lookup,
    );
    const drawingRels = rels(files, drawingPart);
    const colX = (c: number) =>
      Array.from({ length: c }, (_, i) => sheet.colWidths[i] ?? defaultColPx).reduce((a, b) => a + b, 0);
    const rowY = (r: number) =>
      Array.from({ length: r }, (_, i) =>
        sheet.rowHidden[i] ? 0 : (sheet.rowHeights[i] ?? sheet.defaultRowPx),
      ).reduce((a, b) => a + b, 0);
    const at = (m: Element | null) => ({
      x: colX(Number(first(m, 'col')?.textContent ?? 0)) + Number(first(m, 'colOff')?.textContent ?? 0) * EMU_PX,
      y: rowY(Number(first(m, 'row')?.textContent ?? 0)) + Number(first(m, 'rowOff')?.textContent ?? 0) * EMU_PX,
    });
    for (const anchor of Array.from(drawingDoc.documentElement.children)) {
      const kind = anchor.localName;
      let box: { x: number; y: number; w: number; h: number } | null = null;
      if (kind === 'twoCellAnchor') {
        const a = at(first(anchor, 'from'));
        const b = at(first(anchor, 'to'));
        box = { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
      } else if (kind === 'oneCellAnchor') {
        const a = at(first(anchor, 'from'));
        const ext = first(anchor, 'ext');
        box = { ...a, w: num(ext, 'cx') * EMU_PX, h: num(ext, 'cy') * EMU_PX };
      } else if (kind === 'absoluteAnchor') {
        const pos = first(anchor, 'pos');
        const ext = first(anchor, 'ext');
        box = {
          x: num(pos, 'x') * EMU_PX,
          y: num(pos, 'y') * EMU_PX,
          w: num(ext, 'cx') * EMU_PX,
          h: num(ext, 'cy') * EMU_PX,
        };
      }
      const content = Array.from(anchor.children).find((c) =>
        ['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(c.localName),
      );
      if (!box || !content) continue;
      const shape = readAnchored(content, ctx, drawingRels, box);
      if (shape) sheet.shapes.push(shape);
    }
  }
}

// ── conditional formatting ─────────────────────────────────────────────────────────────────────────────────────────

function lerpColor(a: string, b: string, t: number): string {
  const p = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function applyConditionalFormats(root: Element, sheet: XlsxSheet, styles: Styles, colors: Colors) {
  const rules = kids(root, 'conditionalFormatting').flatMap((cf) =>
    kids(cf, 'cfRule').map((rule) => ({ rule, boxes: ranges(attr(cf, 'sqref')) })),
  );
  rules.sort((x, y) => num(x.rule, 'priority', 99) - num(y.rule, 'priority', 99));
  const taken = new Set<string>();
  for (const { rule, boxes } of rules) {
    const type = attr(rule, 'type');
    const cells: { r: number; c: number; cell: XlsxCell }[] = [];
    for (const b of boxes)
      for (let r = b.r1; r <= Math.min(b.r2, sheet.rows.length - 1); r++)
        for (let c = b.c1; c <= Math.min(b.c2, sheet.columns - 1); c++) {
          const cell = sheet.rows[r]?.[c];
          if (cell && cell.kind !== 'blank') cells.push({ r, c, cell });
        }
    const dxf = styles.dxfs[num(rule, 'dxfId', -1)];
    const set = (item: { r: number; c: number; cell: XlsxCell }, add: NonNullable<XlsxCell['cf']>) => {
      const key = `${item.r}:${item.c}:${type}`;
      if (taken.has(key)) return;
      taken.add(key);
      item.cell.cf = { ...item.cell.cf, ...add };
    };
    const formulas = kids(rule, 'formula').map((f) => (f.textContent ?? '').trim());
    const lit = (f: string) => (/^".*"$/.test(f) ? f.slice(1, -1) : Number.isFinite(Number(f)) ? Number(f) : f);
    if (type === 'cellIs' && dxf) {
      const op = attr(rule, 'operator');
      const [a, b] = formulas.map(lit);
      for (const item of cells) {
        const v = item.cell.number ?? item.cell.text;
        const n = typeof v === 'number' && typeof a === 'number';
        const hit =
          (op === 'greaterThan' && n && v > a) ||
          (op === 'greaterThanOrEqual' && n && v >= a) ||
          (op === 'lessThan' && n && v < a) ||
          (op === 'lessThanOrEqual' && n && v <= a) ||
          (op === 'equal' && v === a) ||
          (op === 'notEqual' && v !== a) ||
          (op === 'between' && n && typeof b === 'number' && v >= a && v <= b) ||
          (op === 'notBetween' && n && typeof b === 'number' && (v < a || v > b));
        if (hit) set(item, dxf);
      }
    } else if (type === 'containsText' && dxf) {
      const needle = attr(rule, 'text').toLowerCase();
      for (const item of cells) if (item.cell.text.toLowerCase().includes(needle)) set(item, dxf);
    } else if (type === 'colorScale') {
      const scale = first(rule, 'colorScale');
      const cfvo = kids(scale, 'cfvo');
      const cols = kids(scale, 'color').map((c) => colorOf(c, colors) ?? '#ffffff');
      const nums = cells.filter((x) => x.cell.number != null).map((x) => x.cell.number as number);
      if (!nums.length || cols.length < 2) continue;
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      const at = (cv: Element, fallback: number) => {
        const t = attr(cv, 'type');
        const val = Number(attr(cv, 'val'));
        if (t === 'num') return val;
        if (t === 'percent') return lo + ((hi - lo) * val) / 100;
        if (t === 'percentile')
          return [...nums].sort((p, q) => p - q)[Math.min(nums.length - 1, Math.floor((val / 100) * nums.length))];
        return fallback;
      };
      const stops = cfvo.map((cv, i) => at(cv, i === 0 ? lo : i === cfvo.length - 1 ? hi : (lo + hi) / 2));
      for (const item of cells) {
        const v = item.cell.number;
        if (v == null) continue;
        let k = 0;
        while (k < stops.length - 2 && v > stops[k + 1]) k++;
        const span = stops[k + 1] - stops[k] || 1;
        const t = Math.max(0, Math.min(1, (v - stops[k]) / span));
        set(item, { bg: lerpColor(cols[k], cols[k + 1], t) });
      }
    } else if (type === 'dataBar') {
      const bar = first(rule, 'dataBar');
      const color = colorOf(first(bar, 'color'), colors) ?? '#638ec6';
      const nums = cells.filter((x) => x.cell.number != null).map((x) => x.cell.number as number);
      if (!nums.length) continue;
      const lo = Math.min(0, ...nums);
      const hi = Math.max(...nums);
      for (const item of cells) {
        const v = item.cell.number;
        if (v == null) continue;
        set(item, { bar: { pct: hi === lo ? 100 : ((v - lo) / (hi - lo)) * 100, color } });
      }
    }
  }
}
