import { OfficeError, open, xml } from './office';
import { BOX_PRESETS, customPaths, linePath, presetPaths, type PathPart } from './pptxGeometry';
import { parseChart, type ChartModel } from './pptxChart';

/**
 * Read a .pptx into what is needed to draw its slides: boxes with a place, a fill, a line, text, pictures, groups,
 * tables and charts. Layouts and masters give the places and text styles a slide does not state itself. Effects other
 * than a shadow, SmartArt, 3-D and animations are not drawn; nothing in the file runs.
 */

const PX = 1 / 9525; // EMU to CSS px
const FONT_PX = 1 / 75; // 1/100 pt to CSS px

export interface Fill {
  color?: string;
  gradient?: { angle: number; stops: { pos: number; color: string }[] };
}

export interface RenderedLine {
  widthPx: number;
  color: string;
  dash: 'solid' | 'dashed' | 'dotted';
  /** An arrowhead at the start / the end of a line. */
  head: boolean;
  tail: boolean;
}

export interface RenderedRun {
  text: string;
  sizePx: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  font: string;
  spacingPx: number;
  baseline: number;
}

export interface RenderedPara {
  align: 'left' | 'center' | 'right' | 'justify';
  /** Line height in px, or as a multiple of the font size. */
  lineHeightPx?: number;
  lineHeightPct?: number;
  beforePx: number;
  afterPx: number;
  marginLeftPx: number;
  indentPx: number;
  bullet: string;
  /** A line break inside the paragraph is a run with text "\n". */
  runs: RenderedRun[];
  /** Size of an empty paragraph, which still takes a line. */
  emptySizePx: number;
}

export interface RenderedText {
  anchor: 'top' | 'center' | 'bottom';
  wrap: boolean;
  vertical: '' | 'vert' | 'vert270';
  insets: [number, number, number, number];
  paras: RenderedPara[];
}

export interface RenderedCell {
  colSpan: number;
  rowSpan: number;
  fill: Fill | null;
  /** left, top, right, bottom */
  borders: (RenderedLine | null)[];
  text: RenderedText;
}

export interface RenderedTable {
  cols: number[];
  rows: { h: number; cells: RenderedCell[] }[];
}

export interface RenderedShape {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** `path` is drawn from `paths`; `none` is a geometry we do not draw (its text and picture still are). */
  geometry: 'rect' | 'roundRect' | 'ellipse' | 'path' | 'none';
  /** Corner radius as a fraction of the shorter side, for roundRect. */
  radius: number;
  paths?: PathPart[];
  fill: Fill | null;
  line?: RenderedLine;
  /** A CSS drop-shadow() filter. */
  shadow?: string;
  opacity: number;
  text?: RenderedText;
  image?: { src: string; crop: [number, number, number, number] };
  /** A group: its shapes, in the group's child space `box`. */
  children?: RenderedShape[];
  box?: { x: number; y: number; w: number; h: number };
  table?: RenderedTable;
  chart?: ChartModel;
}

export interface RenderedSlide {
  width: number;
  height: number;
  background: Fill | null;
  backgroundImage?: string;
  shapes: RenderedShape[];
}

type Theme = { colors: Map<string, string>; major: string; minor: string };
type Rels = Map<string, string>;

/** One level of a text style (what a master, a layout or a shape says about the text of that indent level). */
interface Level {
  sz?: number;
  b?: boolean;
  i?: boolean;
  color?: string;
  font?: string;
  marL?: number;
  indent?: number;
  algn?: string;
  /** '' = no bullet. */
  bullet?: string;
  autoNum?: string;
  startAt?: number;
  lnPct?: number;
  lnPx?: number;
  before?: number;
  after?: number;
}

interface TableStylePart {
  fill?: Fill;
  bold?: boolean;
  color?: string;
  border?: RenderedLine;
}

/** How a picture of the file becomes a URL; the viewer makes object URLs and takes them back when it is closed. */
export type MakeUrl = (bytes: Uint8Array, mime: string) => string;

interface Ctx {
  files: Record<string, Uint8Array>;
  theme: Theme;
  makeUrl: MakeUrl;
  urls: Map<string, string>;
  presentationStyle: Level[];
  masterStyles: { title: Level[]; body: Level[]; other: Level[] };
  tableStyles: Map<string, Record<string, TableStylePart>>;
}

/** Where a shape of a slide may look for what it does not say: the layout's and the master's shapes. */
interface Holders {
  layout: Element[];
  master: Element[];
}

const attr = (el: Element | null | undefined, name: string) => el?.getAttribute(name) ?? '';
/** A relationship id such as r:embed (it has its own namespace). */
const rid = (el: Element | null | undefined, name: string) =>
  el?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name) ||
  el?.getAttribute(`r:${name}`) ||
  '';
const num = (el: Element | null | undefined, name: string, fallback = 0) => {
  const v = Number(attr(el, name));
  return Number.isFinite(v) && attr(el, name) !== '' ? v : fallback;
};
const has = (el: Element | null | undefined, name: string) => !!el && el.hasAttribute(name);
const kids = (el: Element | null | undefined, tag: string) =>
  Array.from(el?.children ?? []).filter((c) => c.localName === tag);
const first = (el: Element | null | undefined, tag: string): Element | null => kids(el, tag)[0] ?? null;
const all = (el: Document | Element, tag: string) => Array.from(el.getElementsByTagNameNS('*', tag));
const textOf = (el: Element | null | undefined) => el?.textContent?.trim() ?? '';

function rels(files: Record<string, Uint8Array>, partName: string): Rels {
  const dir = partName.slice(0, partName.lastIndexOf('/'));
  const file = `${dir}/_rels/${partName.slice(partName.lastIndexOf('/') + 1)}.rels`;
  const out: Rels = new Map();
  const doc = xml(files[file]);
  for (const r of doc ? all(doc, 'Relationship') : []) {
    const target = attr(r, 'Target');
    if (attr(r, 'TargetMode') === 'External') continue;
    const parts = (target.startsWith('/') ? target.slice(1) : `${dir}/${target}`).split('/');
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === '..') resolved.pop();
      else if (p && p !== '.') resolved.push(p);
    }
    out.set(attr(r, 'Id'), resolved.join('/'));
  }
  return out;
}

// ── colours and fills ──────────────────────────────────────────────────────────────────────────────────────────────

function clamp(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hslAdjust(hex: string, lumMod: number, lumOff: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = Math.max(0, Math.min(1, l * lumMod + lumOff));
  const f = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rgb = s === 0 ? [l, l, l] : [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  return rgb
    .map((c) =>
      clamp(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
}

/** A colour element (srgbClr, schemeClr, sysClr, prstClr) as a CSS colour, or '' when there is none. */
function colorOf(el: Element | null | undefined, theme: Theme): string {
  if (!el) return '';
  let hex = '';
  const kind = el.localName;
  if (kind === 'srgbClr') hex = attr(el, 'val');
  else if (kind === 'sysClr') hex = attr(el, 'lastClr') || '000000';
  else if (kind === 'schemeClr') {
    const key = attr(el, 'val');
    const map: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
    hex = theme.colors.get(map[key] ?? key) ?? '';
  } else if (kind === 'prstClr') hex = { black: '000000', white: 'FFFFFF' }[attr(el, 'val')] ?? '';
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '';
  const mod = first(el, 'lumMod');
  const off = first(el, 'lumOff');
  if (mod || off) hex = hslAdjust(hex, num(mod, 'val', 100000) / 100000, num(off, 'val', 0) / 100000);
  const tint = first(el, 'tint');
  if (tint) {
    const t = num(tint, 'val', 100000) / 100000;
    hex = hslAdjust(hex, t, 1 - t);
  }
  const alpha = first(el, 'alpha');
  if (alpha) {
    const a = num(alpha, 'val', 100000) / 100000;
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `#${hex}`;
}

/** The colour inside a fill element (solidFill, a gradient stop), or ''. */
function solid(el: Element | null | undefined, theme: Theme): string {
  const inner = Array.from(el?.children ?? []).find((c) =>
    ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(c.localName),
  );
  return colorOf(inner, theme);
}

/** The fill a shape property says: a colour, a gradient, `null` for noFill, `undefined` when it says nothing. */
function fillOf(parent: Element | null | undefined, theme: Theme): Fill | null | undefined {
  if (!parent) return undefined;
  if (first(parent, 'noFill')) return null;
  const sf = first(parent, 'solidFill');
  if (sf) return { color: solid(sf, theme) || undefined };
  const gf = first(parent, 'gradFill');
  if (gf) {
    const stops = kids(first(gf, 'gsLst'), 'gs').map((gs) => ({ pos: num(gs, 'pos') / 1000, color: solid(gs, theme) }));
    if (!stops.length) return undefined;
    if (stops.length === 1) return { color: stops[0].color };
    const lin = first(gf, 'lin');
    return { gradient: { angle: lin ? num(lin, 'ang') / 60000 : 90, stops } };
  }
  const pf = first(parent, 'pattFill');
  if (pf) return { color: solid(first(pf, 'fgClr'), theme) || undefined };
  return undefined;
}

function lineOf(ln: Element | null | undefined, theme: Theme): RenderedLine | undefined {
  if (!ln) return undefined;
  const fill = fillOf(ln, theme);
  if (!fill || !fill.color) return undefined;
  const dash = attr(first(ln, 'prstDash'), 'val');
  const end = (tag: string) => {
    const type = attr(first(ln, tag), 'type');
    return !!type && type !== 'none';
  };
  return {
    widthPx: Math.max(0.75, num(ln, 'w', 12700) * PX),
    color: fill.color,
    dash: /^(dot|sysDot)$/.test(dash) ? 'dotted' : /dash/i.test(dash) ? 'dashed' : 'solid',
    head: end('headEnd'),
    tail: end('tailEnd'),
  };
}

function shadowOf(spPr: Element | null | undefined, theme: Theme): string | undefined {
  const effects = first(spPr, 'effectLst');
  const sh = effects ? all(effects, 'outerShdw')[0] : undefined;
  if (!sh) return undefined;
  const dist = num(sh, 'dist') * PX;
  const dir = (num(sh, 'dir') / 60000) * (Math.PI / 180);
  const blur = num(sh, 'blurRad') * PX;
  const color = solid(sh, theme) || 'rgba(0,0,0,0.35)';
  const r = (v: number) => Math.round(v * 10) / 10;
  return `drop-shadow(${r(dist * Math.cos(dir))}px ${r(dist * Math.sin(dir))}px ${r(blur)}px ${color})`;
}

function readTheme(files: Record<string, Uint8Array>, name: string | undefined): Theme {
  const theme: Theme = { colors: new Map(), major: 'Calibri', minor: 'Calibri' };
  const doc = name ? xml(files[name]) : null;
  if (!doc) return theme;
  const scheme = all(doc, 'clrScheme')[0];
  for (const c of Array.from(scheme?.children ?? [])) {
    const inner = c.children[0];
    // a sysClr ("window", "windowText") keeps its colour in lastClr
    const hex = [attr(inner, 'val'), attr(inner, 'lastClr')].find((v) => /^[0-9a-f]{6}$/i.test(v)) ?? '';
    if (hex) theme.colors.set(c.localName, hex);
  }
  theme.major = attr(first(all(doc, 'majorFont')[0], 'latin'), 'typeface') || theme.major;
  theme.minor = attr(first(all(doc, 'minorFont')[0], 'latin'), 'typeface') || theme.minor;
  return theme;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function imageUrl(ctx: Ctx, target: string | undefined): string {
  if (!target) return '';
  const hit = ctx.urls.get(target);
  if (hit) return hit;
  const bytes = ctx.files[target];
  const mime = MIME[target.split('.').pop()?.toLowerCase() ?? ''];
  if (!bytes || !mime) return '';
  const url = ctx.makeUrl(bytes, mime);
  ctx.urls.set(target, url);
  return url;
}

// ── text ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A bullet character; Wingdings and Symbol glyphs are shown as the shapes they stand for. */
function bulletChar(char: string, font: string): string {
  if (/wingdings/i.test(font)) {
    const map: Record<string, string> = { '§': '▪', ü: '✓', Ø: '➢', l: '●', n: '■', q: '❑', v: '❖' };
    return map[char] ?? '•';
  }
  if (/symbol/i.test(font)) return char === '·' ? '•' : char;
  return char || '•';
}

/** What a `lvlNpPr` element says about a level of text. */
function readLevel(lvl: Element | null | undefined, theme: Theme): Level {
  if (!lvl) return {};
  const def = first(lvl, 'defRPr');
  const out: Level = {};
  if (has(def, 'sz')) out.sz = num(def, 'sz');
  if (has(def, 'b')) out.b = attr(def, 'b') === '1' || attr(def, 'b') === 'true';
  if (has(def, 'i')) out.i = attr(def, 'i') === '1' || attr(def, 'i') === 'true';
  const color = solid(first(def, 'solidFill'), theme);
  if (color) out.color = color;
  const font = attr(first(def, 'latin'), 'typeface');
  if (font) out.font = font;
  if (has(lvl, 'marL')) out.marL = num(lvl, 'marL') * PX;
  if (has(lvl, 'indent')) out.indent = num(lvl, 'indent') * PX;
  if (has(lvl, 'algn')) out.algn = attr(lvl, 'algn');
  if (first(lvl, 'buNone')) out.bullet = '';
  const bu = first(lvl, 'buChar');
  if (bu) out.bullet = bulletChar(attr(bu, 'char'), attr(first(lvl, 'buFont'), 'typeface'));
  const auto = first(lvl, 'buAutoNum');
  if (auto) {
    out.autoNum = attr(auto, 'type') || 'arabicPeriod';
    out.startAt = num(auto, 'startAt', 1);
  }
  const ln = first(lvl, 'lnSpc');
  if (first(ln, 'spcPct')) out.lnPct = (num(first(ln, 'spcPct'), 'val') / 100000) * 1.2;
  if (first(ln, 'spcPts')) out.lnPx = num(first(ln, 'spcPts'), 'val') * FONT_PX;
  const before = first(first(lvl, 'spcBef'), 'spcPts');
  const after = first(first(lvl, 'spcAft'), 'spcPts');
  if (before) out.before = num(before, 'val') * FONT_PX;
  if (after) out.after = num(after, 'val') * FONT_PX;
  return out;
}

const levelsOf = (list: Element | null | undefined, theme: Theme): Level[] =>
  Array.from({ length: 9 }, (_, i) => readLevel(first(list, `lvl${i + 1}pPr`), theme));

const mergeLevels = (...parts: Level[][]): Level[] =>
  Array.from({ length: 9 }, (_, i) => Object.assign({}, ...parts.map((p) => p[i] ?? {})) as Level);

function numbering(type: string, n: number): string {
  const letter = (k: number) => String.fromCharCode(96 + (((k - 1) % 26) + 1));
  const roman = (k: number) => ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][k] ?? String(k);
  const close = /ParenR/.test(type) ? ')' : '.';
  if (/alphaLc/.test(type)) return `${letter(n)}${close}`;
  if (/alphaUc/.test(type)) return `${letter(n).toUpperCase()}${close}`;
  if (/romanLc/.test(type)) return `${roman(n)}.`;
  if (/romanUc/.test(type)) return `${roman(n).toUpperCase()}.`;
  return `${n}${close}`;
}

interface TextOpts {
  /** The text styles to merge, weakest first. */
  levels: Level[];
  /** bodyPr attributes: the shape's own, then the layout's and the master's placeholder. */
  bodyAttr: (name: string) => string;
  bodyPr?: Element | null;
  /** Colour and weight a table style gives. */
  base?: { color?: string; bold?: boolean };
  insets?: [number, number, number, number];
}

function readBody(body: Element | null | undefined, ctx: Ctx, opts: TextOpts): RenderedText | undefined {
  if (!body) return undefined;
  const anchor = opts.bodyAttr('anchor');
  const fit = first(opts.bodyPr, 'normAutofit');
  const scale = fit && has(fit, 'fontScale') ? num(fit, 'fontScale') / 100000 : 1;
  const dk1 = `#${ctx.theme.colors.get('dk1') ?? '000000'}`;
  let counter: { level: number; n: number } | null = null;
  const paras: RenderedPara[] = kids(body, 'p').map((p) => {
    const pPr = first(p, 'pPr');
    const lvlIdx = Math.max(0, Math.min(8, num(pPr, 'lvl', 0)));
    const st = Object.assign({}, opts.levels[lvlIdx], readLevel(pPr, ctx.theme)) as Level;
    const end = first(p, 'endParaRPr');
    const mk = (rPr: Element | null | undefined, text: string): RenderedRun => {
      const font = attr(first(rPr, 'latin'), 'typeface') || st.font || '';
      const rb = attr(rPr, 'b');
      const ri = attr(rPr, 'i');
      return {
        text,
        sizePx: num(rPr, 'sz', num(end, 'sz', st.sz ?? 1800)) * FONT_PX * scale,
        bold: rb ? rb === '1' || rb === 'true' : (st.b ?? opts.base?.bold ?? false),
        italic: ri ? ri === '1' || ri === 'true' : (st.i ?? false),
        underline: !!attr(rPr, 'u') && attr(rPr, 'u') !== 'none',
        strike: !!attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike',
        color: solid(first(rPr, 'solidFill'), ctx.theme) || opts.base?.color || st.color || dk1,
        font: font === '+mj-lt' ? ctx.theme.major : font === '+mn-lt' || !font ? ctx.theme.minor : font,
        spacingPx: num(rPr, 'spc') * FONT_PX,
        baseline: num(rPr, 'baseline'),
      };
    };
    const runs: RenderedRun[] = [];
    for (const c of Array.from(p.children)) {
      if (c.localName === 'r' || c.localName === 'fld') {
        const t = first(c, 't')?.textContent ?? '';
        if (t) runs.push(mk(first(c, 'rPr'), t));
      } else if (c.localName === 'br') runs.push(mk(first(c, 'rPr'), '\n'));
    }
    let bullet = st.bullet ?? '';
    if (st.autoNum && !first(pPr, 'buNone')) {
      counter =
        counter && counter.level === lvlIdx
          ? { level: lvlIdx, n: counter.n + 1 }
          : { level: lvlIdx, n: st.startAt ?? 1 };
      bullet = numbering(st.autoNum, counter.n);
    } else counter = null;
    if (!runs.some((r) => r.text.trim())) bullet = '';
    const align: Record<string, RenderedPara['align']> = { ctr: 'center', r: 'right', just: 'justify' };
    return {
      align: align[st.algn ?? ''] ?? 'left',
      lineHeightPx: st.lnPx != null ? st.lnPx * scale : undefined,
      lineHeightPct: st.lnPct,
      beforePx: (st.before ?? 0) * scale,
      afterPx: (st.after ?? 0) * scale,
      marginLeftPx: st.marL ?? 0,
      indentPx: st.indent ?? 0,
      bullet,
      runs,
      emptySizePx: num(end, 'sz', st.sz ?? 1800) * FONT_PX * scale,
    };
  });
  const ins = (name: string, def: number) => (opts.bodyAttr(name) !== '' ? Number(opts.bodyAttr(name)) : def) * PX;
  const vert = opts.bodyAttr('vert');
  return {
    anchor: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'bottom' : 'top',
    wrap: opts.bodyAttr('wrap') !== 'none',
    vertical: vert === 'vert' || vert === 'eaVert' ? 'vert' : vert === 'vert270' ? 'vert270' : '',
    insets: opts.insets ?? [ins('lIns', 91440), ins('tIns', 45720), ins('rIns', 91440), ins('bIns', 45720)],
    paras,
  };
}

// ── shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function placeholderKey(sp: Element): { type: string; idx: string } | null {
  const ph = all(sp, 'ph')[0];
  return ph ? { type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx') } : null;
}

/** The layout's, then the master's shape that a slide placeholder takes its place and text style from. */
function holderFor(holders: Holders, key: { type: string; idx: string }): Element[] {
  const found: Element[] = [];
  for (const list of [holders.layout, holders.master]) {
    const hit = list.find((sp) => {
      const k = placeholderKey(sp);
      if (!k) return false;
      if (key.idx && k.idx === key.idx) return true;
      return (
        k.type === key.type ||
        (key.type === 'ctrTitle' && k.type === 'title') ||
        (key.type === 'subTitle' && k.type === 'body')
      );
    });
    if (hit) found.push(hit);
  }
  return found;
}

function readShape(el: Element, ctx: Ctx, rel: Rels, holders: Holders | null): RenderedShape | null {
  const isPic = el.localName === 'pic';
  const isLine = el.localName === 'cxnSp';
  const spPr = first(el, 'spPr');
  const key = isPic || isLine || !holders ? null : placeholderKey(el);
  const above = key && holders ? holderFor(holders, key) : []; // layout placeholder, then master placeholder
  let xfrm = first(spPr, 'xfrm');
  for (const h of above) xfrm = xfrm ?? first(first(h, 'spPr'), 'xfrm');
  if (!xfrm) return null;
  const off = first(xfrm, 'off');
  const ext = first(xfrm, 'ext');
  const w = num(ext, 'cx') * PX;
  const h = num(ext, 'cy') * PX;
  const prst = attr(first(spPr, 'prstGeom'), 'prst') || (isLine ? 'line' : 'rect');
  const adj: Record<string, number> = {};
  for (const gd of all(spPr ?? el, 'gd')) {
    const m = /val\s+(-?\d+)/.exec(attr(gd, 'fmla'));
    if (m) adj[attr(gd, 'name')] = Number(m[1]);
  }
  let geometry: RenderedShape['geometry'] = 'none';
  let paths: PathPart[] | undefined;
  let radius = 0;
  const cust = first(spPr, 'custGeom');
  const box = BOX_PRESETS[prst];
  if (cust) {
    paths = customPaths(cust, w, h);
    geometry = paths.length ? 'path' : 'none';
  } else if (box) {
    geometry = box.geometry;
    radius = Math.min(0.5, box.radius ?? (adj.adj != null ? adj.adj / 100000 : 16667 / 100000));
  } else if (prst === 'line' || /^(straight|bent|curved)Connector\d?$/.test(prst)) {
    paths = [{ d: linePath(prst, w, h), fill: false, stroke: true }];
    geometry = 'path';
  } else if (!isPic) {
    paths = presetPaths(prst, w, h, adj) ?? undefined;
    geometry = paths ? 'path' : 'none';
  }
  if (isPic && geometry === 'path') geometry = 'rect';
  const blipEl = all(el, 'blip')[0];
  const alpha = blipEl ? first(blipEl, 'alphaModFix') : null;
  // what the shape's style (p:style) gives where its own properties say nothing
  const style = first(el, 'style');
  const refColor = (tag: string) => {
    const ref = first(style, tag);
    return ref && num(ref, 'idx', 1) !== 0 ? solid(ref, ctx.theme) : '';
  };
  const ownFill = isPic ? null : fillOf(spPr, ctx.theme);
  const styleFill = ownFill === undefined && refColor('fillRef') ? { color: refColor('fillRef') } : null;
  const lnEl = first(spPr, 'ln');
  const ownLine = lineOf(lnEl, ctx.theme);
  const lnSaysNothing = !lnEl || !(first(lnEl, 'noFill') || first(lnEl, 'solidFill') || first(lnEl, 'gradFill'));
  const styleLine: RenderedLine | undefined =
    !ownLine && lnSaysNothing && refColor('lnRef')
      ? {
          widthPx: Math.max(0.75, num(lnEl, 'w', 12700) * PX),
          color: refColor('lnRef'),
          dash: 'solid',
          head: false,
          tail: false,
        }
      : undefined;
  const shape: RenderedShape = {
    x: num(off, 'x') * PX,
    y: num(off, 'y') * PX,
    w,
    h,
    rotation: num(xfrm, 'rot') / 60000,
    flipH: attr(xfrm, 'flipH') === '1',
    flipV: attr(xfrm, 'flipV') === '1',
    geometry,
    radius,
    paths,
    fill: ownFill === undefined ? styleFill : ownFill,
    line: ownLine ?? styleLine,
    shadow: shadowOf(spPr, ctx.theme),
    opacity: alpha ? num(alpha, 'amt', 100000) / 100000 : 1,
  };
  if (isPic) {
    const src = imageUrl(ctx, rel.get(rid(blipEl, 'embed') || rid(blipEl, 'link')));
    const rect = all(el, 'srcRect')[0];
    const c = (n: string) => num(rect, n) / 100000;
    if (!src) return null;
    shape.image = { src, crop: [c('l'), c('t'), c('r'), c('b')] };
    return shape;
  }
  const body = first(el, 'txBody');
  const bodies = [body, ...above.map((a) => first(a, 'txBody'))];
  const category = key
    ? /title/i.test(key.type)
      ? ctx.masterStyles.title
      : /^(body|obj|subTitle)$/.test(key.type)
        ? ctx.masterStyles.body
        : ctx.masterStyles.other
    : ctx.presentationStyle;
  shape.text = readBody(body, ctx, {
    levels: mergeLevels(category, ...[...bodies].reverse().map((b) => levelsOf(first(b, 'lstStyle'), ctx.theme))),
    bodyPr: first(body, 'bodyPr'),
    base: { color: refColor('fontRef') || undefined },
    bodyAttr: (name) => bodies.map((b) => attr(first(b, 'bodyPr'), name)).find((v) => v !== '') ?? '',
  });
  const blipFill = first(spPr, 'blipFill');
  if (blipFill) {
    const src = imageUrl(ctx, rel.get(rid(first(blipFill, 'blip'), 'embed')));
    if (src) shape.image = { src, crop: [0, 0, 0, 0] };
  }
  return shape;
}

function readGroup(el: Element, ctx: Ctx, rel: Rels): RenderedShape | null {
  const xfrm = first(first(el, 'grpSpPr'), 'xfrm');
  if (!xfrm) return null;
  const off = first(xfrm, 'off');
  const ext = first(xfrm, 'ext');
  const chOff = first(xfrm, 'chOff');
  const chExt = first(xfrm, 'chExt');
  return {
    x: num(off, 'x') * PX,
    y: num(off, 'y') * PX,
    w: num(ext, 'cx') * PX,
    h: num(ext, 'cy') * PX,
    rotation: num(xfrm, 'rot') / 60000,
    flipH: attr(xfrm, 'flipH') === '1',
    flipV: attr(xfrm, 'flipV') === '1',
    geometry: 'none',
    radius: 0,
    fill: null,
    opacity: 1,
    children: collect(el, ctx, rel, null),
    box: {
      x: num(chOff, 'x') * PX,
      y: num(chOff, 'y') * PX,
      w: num(chExt, 'cx', num(ext, 'cx')) * PX,
      h: num(chExt, 'cy', num(ext, 'cy')) * PX,
    },
  };
}

// ── tables and charts ──────────────────────────────────────────────────────────────────────────────────────────────

function readTableStyles(files: Record<string, Uint8Array>, theme: Theme): Map<string, Record<string, TableStylePart>> {
  const out = new Map<string, Record<string, TableStylePart>>();
  const doc = xml(files['ppt/tableStyles.xml']);
  for (const st of doc ? all(doc, 'tblStyle') : []) {
    const parts: Record<string, TableStylePart> = {};
    for (const part of Array.from(st.children)) {
      const tcStyle = first(part, 'tcStyle');
      const txStyle = first(part, 'tcTxStyle');
      const bdr = first(tcStyle, 'tcBdr');
      const edge = first(bdr, 'insideH') ?? first(bdr, 'bottom');
      parts[part.localName] = {
        fill: fillOf(first(tcStyle, 'fill'), theme) ?? undefined,
        bold: attr(txStyle, 'b') === 'on' ? true : undefined,
        color: solid(txStyle, theme) || solid(first(txStyle, 'fontRef'), theme) || undefined,
        border: lineOf(first(edge, 'ln'), theme),
      };
    }
    out.set(attr(st, 'styleId'), parts);
  }
  return out;
}

/** PowerPoint's own default table look (Medium Style 2, Accent 1), for a table whose style the file does not hold. */
function builtInTableStyle(theme: Theme): Record<string, TableStylePart> {
  const accent = theme.colors.get('accent1') ?? '4472C4';
  const tint = (a: number) => `#${hslAdjust(accent, 1 - a, a)}`;
  const white: RenderedLine = { widthPx: 1.3, color: '#ffffff', dash: 'solid', head: false, tail: false };
  return {
    wholeTbl: { fill: { color: tint(0.8) }, color: '#000000', border: white },
    band1H: { fill: { color: tint(0.6) } },
    firstRow: { fill: { color: `#${accent}` }, bold: true, color: '#ffffff', border: white },
    lastRow: { fill: { color: `#${accent}` }, bold: true, color: '#ffffff' },
    firstCol: { fill: { color: `#${accent}` }, bold: true, color: '#ffffff' },
  };
}

function readTable(tbl: Element, ctx: Ctx): RenderedTable {
  const pr = first(tbl, 'tblPr');
  const id = textOf(first(pr, 'tableStyleId'));
  const style = ctx.tableStyles.get(id) ?? builtInTableStyle(ctx.theme);
  const flag = (n: string) => attr(pr, n) === '1' || attr(pr, n) === 'true';
  const cols = kids(first(tbl, 'tblGrid'), 'gridCol').map((g) => num(g, 'w') * PX);
  const trs = kids(tbl, 'tr');
  const rows = trs.map((tr, ri) => {
    const cells: RenderedCell[] = [];
    kids(tr, 'tc').forEach((tc, ci) => {
      if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') return;
      const tcPr = first(tc, 'tcPr');
      const parts = [
        style.wholeTbl,
        flag('bandRow') && (ri - (flag('firstRow') ? 1 : 0)) % 2 === 0 ? style.band1H : undefined,
        flag('firstCol') && ci === 0 ? style.firstCol : undefined,
        flag('lastRow') && ri === trs.length - 1 ? style.lastRow : undefined,
        flag('firstRow') && ri === 0 ? style.firstRow : undefined,
      ].filter(Boolean) as TableStylePart[];
      const merged = Object.assign({}, ...parts) as TableStylePart;
      const own = fillOf(tcPr, ctx.theme);
      const edge = (tag: string): RenderedLine | null => {
        const l = first(tcPr, tag);
        return l ? (lineOf(l, ctx.theme) ?? null) : (merged.border ?? null);
      };
      const inset = (name: string, def: number) => (has(tcPr, name) ? num(tcPr, name) : def) * PX;
      const text = readBody(first(tc, 'txBody'), ctx, {
        levels: ctx.presentationStyle,
        bodyAttr: (name) => (name === 'anchor' ? attr(tcPr, 'anchor') : ''),
        base: { color: merged.color, bold: merged.bold },
        insets: [inset('marL', 91440), inset('marT', 45720), inset('marR', 91440), inset('marB', 45720)],
      }) ?? { anchor: 'top', wrap: true, vertical: '', insets: [0, 0, 0, 0], paras: [] };
      cells.push({
        colSpan: num(tc, 'gridSpan', 1),
        rowSpan: num(tc, 'rowSpan', 1),
        fill: own === undefined ? (merged.fill ?? null) : own,
        borders: [edge('lnL'), edge('lnT'), edge('lnR'), edge('lnB')],
        text,
      });
    });
    return { h: num(tr, 'h') * PX, cells };
  });
  return { cols, rows };
}

function readFrame(el: Element, ctx: Ctx, rel: Rels): RenderedShape | null {
  const xfrm = first(el, 'xfrm');
  if (!xfrm) return null;
  const off = first(xfrm, 'off');
  const ext = first(xfrm, 'ext');
  const shape: RenderedShape = {
    x: num(off, 'x') * PX,
    y: num(off, 'y') * PX,
    w: num(ext, 'cx') * PX,
    h: num(ext, 'cy') * PX,
    rotation: 0,
    flipH: false,
    flipV: false,
    geometry: 'none',
    radius: 0,
    fill: null,
    opacity: 1,
  };
  const tbl = all(el, 'tbl')[0];
  if (tbl) {
    shape.table = readTable(tbl, ctx);
    return shape;
  }
  const diagram = all(el, 'relIds')[0];
  if (diagram) {
    // SmartArt: PowerPoint keeps the shapes it drew in a drawing part, named by the data part
    const dataDoc = xml(ctx.files[rel.get(rid(diagram, 'dm')) ?? '']);
    const drawingPart = rel.get(attr(dataDoc ? all(dataDoc, 'dataModelExt')[0] : null, 'relId'));
    const drawing = drawingPart ? xml(ctx.files[drawingPart]) : null;
    const tree = drawing ? all(drawing, 'spTree')[0] : undefined;
    if (!tree || !drawingPart) return null;
    return {
      ...shape,
      children: collect(tree, ctx, rels(ctx.files, drawingPart), null),
      box: { x: 0, y: 0, w: shape.w, h: shape.h },
    };
  }
  const picture = all(el, 'pic')[0]; // an embedded workbook or document: the picture PowerPoint shows for it
  if (picture) {
    const pic = readShape(picture, ctx, rel, null);
    return pic
      ? {
          ...shape,
          children: [{ ...pic, x: 0, y: 0, w: shape.w, h: shape.h }],
          box: { x: 0, y: 0, w: shape.w, h: shape.h },
        }
      : null;
  }
  const chart = all(el, 'chart')[0];
  const part = chart ? rel.get(rid(chart, 'id')) : undefined;
  const doc = part ? xml(ctx.files[part]) : null;
  if (!doc) return null;
  const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(
    (k) => `#${ctx.theme.colors.get(k) ?? '888888'}`,
  );
  const model = parseChart(
    doc,
    (spPr) => (fillOf(spPr, ctx.theme) ?? fillOf(first(spPr, 'ln'), ctx.theme))?.color ?? '',
    accents,
  );
  if (!model) return null;
  shape.chart = model;
  return shape;
}

// ── a slide ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The shapes inside a shape tree or a group, in drawing order. */
function collect(
  tree: Element,
  ctx: Ctx,
  rel: Rels,
  holders: Holders | null,
  skipPlaceholders = false,
): RenderedShape[] {
  const out: RenderedShape[] = [];
  const visit = (el: Element) => {
    switch (el.localName) {
      case 'sp':
      case 'pic':
      case 'cxnSp': {
        if (skipPlaceholders && placeholderKey(el)) return;
        const s = readShape(el, ctx, rel, holders);
        if (s) out.push(s);
        return;
      }
      case 'grpSp': {
        const g = readGroup(el, ctx, rel);
        if (g) out.push(g);
        return;
      }
      case 'graphicFrame': {
        const g = readFrame(el, ctx, rel);
        if (g) out.push(g);
        return;
      }
      case 'AlternateContent': {
        const before = out.length;
        for (const c of Array.from(first(el, 'Choice')?.children ?? [])) visit(c);
        if (out.length === before) for (const c of Array.from(first(el, 'Fallback')?.children ?? [])) visit(c);
        return;
      }
      default:
    }
  };
  for (const el of Array.from(tree.children)) visit(el);
  return out;
}

function backgroundOf(doc: Document | null, ctx: Ctx, rel: Rels): { fill: Fill | null; image?: string } {
  const bgPr = doc ? all(doc, 'bgPr')[0] : undefined;
  if (!bgPr) return { fill: null };
  const image = imageUrl(ctx, rel.get(rid(all(bgPr, 'blip')[0], 'embed')));
  return { fill: fillOf(bgPr, ctx.theme) ?? null, image: image || undefined };
}

/**
 * Read the slides of a .pptx to draw them.
 * @param bytes - The file.
 * @param makeUrl - Makes a URL for a picture of the file.
 */
export function renderPptx(bytes: Uint8Array, makeUrl: MakeUrl): RenderedSlide[] {
  const files = open(
    bytes,
    /^ppt\/(presentation\.xml|tableStyles\.xml|theme\/theme\d+\.xml|slides\/slide\d+\.xml|slideLayouts\/slideLayout\d+\.xml|slideMasters\/slideMaster\d+\.xml|charts\/chart\d+\.xml|diagrams\/(data|drawing)\d+\.xml|diagrams\/_rels\/[^/]+\.rels|(slides|slideLayouts|slideMasters)\/_rels\/[^/]+\.rels|media\/[^/]+)$/,
  );
  const presentation = xml(files['ppt/presentation.xml']);
  const sz = presentation ? all(presentation, 'sldSz')[0] : undefined;
  const width = num(sz, 'cx', 12192000) * PX;
  const height = num(sz, 'cy', 6858000) * PX;
  const fileNo = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const names = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => fileNo(a) - fileNo(b));
  if (!names.length) throw new OfficeError('damaged');
  const theme = readTheme(
    files,
    Object.keys(files)
      .filter((n) => n.startsWith('ppt/theme/'))
      .sort()[0],
  );
  const base: Ctx = {
    files,
    theme,
    makeUrl,
    urls: new Map(),
    presentationStyle: levelsOf(presentation ? all(presentation, 'defaultTextStyle')[0] : null, theme),
    masterStyles: { title: [], body: [], other: [] },
    tableStyles: readTableStyles(files, theme),
  };
  const treeOf = (d: Document | null) => (d ? all(d, 'spTree')[0] : undefined);
  return names.map((name) => {
    const slideDoc = xml(files[name]);
    const slideRel = rels(files, name);
    const layoutName = [...slideRel.values()].find((t) => t.startsWith('ppt/slideLayouts/'));
    const layoutDoc = layoutName ? xml(files[layoutName]) : null;
    const layoutRel = layoutName ? rels(files, layoutName) : new Map();
    const masterName = [...layoutRel.values()].find((t) => t.startsWith('ppt/slideMasters/'));
    const masterDoc = masterName ? xml(files[masterName]) : null;
    const masterRel = masterName ? rels(files, masterName) : new Map();
    const styleOf = (tag: string) => levelsOf(masterDoc ? all(masterDoc, tag)[0] : null, theme);
    const ctx: Ctx = {
      ...base,
      masterStyles: { title: styleOf('titleStyle'), body: styleOf('bodyStyle'), other: styleOf('otherStyle') },
    };
    const layoutTree = treeOf(layoutDoc);
    const masterTree = treeOf(masterDoc);
    const slideTree = treeOf(slideDoc);
    const holders: Holders = {
      layout: Array.from(layoutTree?.children ?? []),
      master: Array.from(masterTree?.children ?? []),
    };
    const own = backgroundOf(slideDoc, ctx, slideRel);
    const layoutBg = backgroundOf(layoutDoc, ctx, layoutRel);
    const masterBg = backgroundOf(masterDoc, ctx, masterRel);
    const bg = own.fill || own.image ? own : layoutBg.fill || layoutBg.image ? layoutBg : masterBg;
    const slideShowsMaster = attr(slideDoc?.documentElement, 'showMasterSp') !== '0';
    const layoutShowsMaster = attr(layoutDoc?.documentElement, 'showMasterSp') !== '0';
    return {
      width,
      height,
      background: bg.fill ?? { color: '#ffffff' },
      backgroundImage: bg.image,
      shapes: [
        ...(slideShowsMaster && layoutShowsMaster && masterTree ? collect(masterTree, ctx, masterRel, null, true) : []),
        ...(slideShowsMaster && layoutTree ? collect(layoutTree, ctx, layoutRel, null, true) : []),
        ...(slideTree ? collect(slideTree, ctx, slideRel, holders) : []),
      ],
    };
  });
}
