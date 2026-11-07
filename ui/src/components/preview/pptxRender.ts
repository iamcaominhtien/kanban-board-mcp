import { OfficeError, open, xml } from './office';

/**
 * Read a .pptx into what is needed to draw its slides: boxes with a place, a fill, a line, text and pictures. Layouts
 * and masters give the places and styles a slide does not state itself. Charts, tables, groups, videos, effects and
 * unusual shapes are not drawn (a shape of a kind we cannot draw keeps its text and pictures); nothing in the file runs.
 */

const PX = 1 / 9525; // EMU to CSS px
const FONT_PX = 1 / 75; // 1/100 pt to CSS px

export interface RenderedRun {
  text: string;
  sizePx: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
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
  insets: [number, number, number, number];
  paras: RenderedPara[];
}

export interface RenderedShape {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** `rect`, `roundRect`, `ellipse`, `line`, or `none` for a geometry we do not draw. */
  geometry: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'none';
  /** Corner radius as a fraction of the shorter side, for roundRect. */
  radius: number;
  /** A CSS background (colour or gradient), or empty. */
  fill: string;
  line?: { widthPx: number; color: string };
  text?: RenderedText;
  image?: { src: string; crop: [number, number, number, number] };
}

export interface RenderedSlide {
  width: number;
  height: number;
  background: string;
  backgroundImage?: string;
  shapes: RenderedShape[];
}

type Theme = { colors: Map<string, string>; major: string; minor: string };
type Rels = Map<string, string>;
type Styles = { sizes: Record<string, number> };

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
const kids = (el: Element | null | undefined, tag: string) =>
  Array.from(el?.children ?? []).filter((c) => c.localName === tag);
const first = (el: Element | null | undefined, tag: string): Element | null => kids(el, tag)[0] ?? null;
const all = (el: Document | Element, tag: string) => Array.from(el.getElementsByTagNameNS('*', tag));

function rels(files: Record<string, Uint8Array>, partName: string): Rels {
  const dir = partName.slice(0, partName.lastIndexOf('/'));
  const file = `${dir}/_rels/${partName.slice(partName.lastIndexOf('/') + 1)}.rels`;
  const out: Rels = new Map();
  const doc = xml(files[file]);
  for (const r of all(doc ?? document.createElement('x'), 'Relationship')) {
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

function clamp(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)));
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
  const alpha = first(el, 'alpha');
  if (alpha) {
    const a = num(alpha, 'val', 100000) / 100000;
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `#${hex}`;
}

/** The colour inside a fill element (solidFill / gradFill's first stop), or ''. */
function solid(el: Element | null | undefined, theme: Theme): string {
  const inner = Array.from(el?.children ?? []).find((c) =>
    ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(c.localName),
  );
  return colorOf(inner, theme);
}

/** A fill property (solidFill, gradFill) as a CSS background; 'none' for noFill; '' when it does not say. */
function fillOf(parent: Element | null | undefined, theme: Theme): string {
  if (!parent) return '';
  if (first(parent, 'noFill')) return 'none';
  const sf = first(parent, 'solidFill');
  if (sf) return solid(sf, theme);
  const gf = first(parent, 'gradFill');
  if (gf) {
    const stops = kids(first(gf, 'gsLst'), 'gs').map((gs) => `${solid(gs, theme)} ${num(gs, 'pos') / 1000}%`);
    if (!stops.length) return '';
    const lin = first(gf, 'lin');
    const deg = lin ? num(lin, 'ang') / 60000 + 90 : 180;
    return stops.length === 1 ? stops[0].split(' ')[0] : `linear-gradient(${deg}deg, ${stops.join(', ')})`;
  }
  return '';
}

function readTheme(files: Record<string, Uint8Array>, name: string | undefined): Theme {
  const theme: Theme = { colors: new Map(), major: 'Calibri', minor: 'Calibri' };
  const doc = name ? xml(files[name]) : null;
  if (!doc) return theme;
  const scheme = all(doc, 'clrScheme')[0];
  for (const c of Array.from(scheme?.children ?? [])) {
    const inner = c.children[0];
    const hex = attr(inner, 'val') || attr(inner, 'lastClr');
    if (/^[0-9a-f]{6}$/i.test(hex)) theme.colors.set(c.localName, hex);
  }
  const major = all(doc, 'majorFont')[0];
  const minor = all(doc, 'minorFont')[0];
  theme.major = attr(first(major, 'latin'), 'typeface') || theme.major;
  theme.minor = attr(first(minor, 'latin'), 'typeface') || theme.minor;
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

/** How a picture of the file becomes a URL; the viewer makes object URLs and takes them back when it is closed. */
export type MakeUrl = (bytes: Uint8Array, mime: string) => string;

interface Ctx {
  files: Record<string, Uint8Array>;
  theme: Theme;
  makeUrl: MakeUrl;
  urls: Map<string, string>;
  /** Default sizes (1/100 pt) from the master's text styles: title, body, other. */
  styles: Styles;
}

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

function placeholderKey(sp: Element): { type: string; idx: string } | null {
  const ph = all(sp, 'ph')[0];
  return ph ? { type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx') } : null;
}

/** The place a placeholder takes from its layout, then its master. */
function inheritedXfrm(holders: Element[][], key: { type: string; idx: string }): Element | null {
  for (const spTree of holders) {
    for (const sp of spTree) {
      const k = placeholderKey(sp);
      if (!k) continue;
      const same = key.idx ? k.idx === key.idx : k.type === key.type;
      const near = !key.idx && (k.type === key.type || (key.type === 'ctrTitle' && k.type === 'title'));
      if (same || near) {
        const x = all(sp, 'xfrm')[0];
        if (x) return x;
      }
    }
  }
  return null;
}

function readText(sp: Element, ctx: Ctx, key: { type: string; idx: string } | null): RenderedText | undefined {
  const body = kids(sp, 'txBody')[0];
  if (!body) return undefined;
  const bodyPr = first(body, 'bodyPr');
  const anchor = attr(bodyPr, 'anchor');
  const defaultSize = key
    ? /title/i.test(key.type)
      ? ctx.styles.sizes.title
      : ctx.styles.sizes.body
    : ctx.styles.sizes.other;
  const paras: RenderedPara[] = kids(body, 'p').map((p) => {
    const pPr = first(p, 'pPr');
    const algn = attr(pPr, 'algn');
    const runs: RenderedRun[] = [];
    const end = first(p, 'endParaRPr');
    const mk = (rPr: Element | null | undefined, text: string): RenderedRun => {
      const font = attr(first(rPr, 'latin'), 'typeface');
      const sz = num(rPr, 'sz', num(end, 'sz', defaultSize));
      return {
        text,
        sizePx: sz * FONT_PX,
        bold: attr(rPr, 'b') === '1' || attr(rPr, 'b') === 'true',
        italic: attr(rPr, 'i') === '1' || attr(rPr, 'i') === 'true',
        underline: !!attr(rPr, 'u') && attr(rPr, 'u') !== 'none',
        color: solid(first(rPr, 'solidFill'), ctx.theme) || '#000000',
        font: font === '+mj-lt' ? ctx.theme.major : font === '+mn-lt' || !font ? ctx.theme.minor : font,
        spacingPx: num(rPr, 'spc') * FONT_PX,
        baseline: num(rPr, 'baseline'),
      };
    };
    for (const c of Array.from(p.children)) {
      if (c.localName === 'r' || c.localName === 'fld') {
        const t = first(c, 't')?.textContent ?? '';
        if (t) runs.push(mk(first(c, 'rPr'), t));
      } else if (c.localName === 'br') runs.push(mk(first(c, 'rPr'), '\n'));
    }
    const ln = first(pPr, 'lnSpc');
    const pts = first(ln, 'spcPts');
    const pct = first(ln, 'spcPct');
    const px = (tag: string) => num(first(first(pPr, tag), 'spcPts'), 'val') * FONT_PX;
    const bu = first(pPr, 'buChar');
    const auto = first(pPr, 'buAutoNum');
    return {
      align: ({ ctr: 'center', r: 'right', just: 'justify' } as Record<string, RenderedPara['align']>)[algn] ?? 'left',
      lineHeightPx: pts ? num(pts, 'val') * FONT_PX : undefined,
      lineHeightPct: pct ? (num(pct, 'val') / 100000) * 1.2 : undefined,
      beforePx: px('spcBef'),
      afterPx: px('spcAft'),
      marginLeftPx: num(pPr, 'marL') * PX,
      indentPx: num(pPr, 'indent') * PX,
      bullet: bu ? attr(bu, 'char') : auto ? '1.' : '',
      runs,
      emptySizePx: num(end, 'sz', defaultSize) * FONT_PX,
    };
  });
  const ins = (name: string, def: number) => (bodyPr?.hasAttribute(name) ? num(bodyPr, name) : def) * PX;
  return {
    anchor: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'bottom' : 'top',
    wrap: attr(bodyPr, 'wrap') !== 'none',
    insets: [ins('lIns', 91440), ins('tIns', 45720), ins('rIns', 91440), ins('bIns', 45720)],
    paras,
  };
}

function readShape(el: Element, ctx: Ctx, rel: Rels, holders: Element[][]): RenderedShape | null {
  const isPic = el.localName === 'pic';
  const spPr = first(el, 'spPr');
  const key = isPic ? null : placeholderKey(el);
  let xfrm = first(spPr, 'xfrm');
  if (!xfrm && key) xfrm = inheritedXfrm(holders, key);
  if (!xfrm) return null;
  const off = first(xfrm, 'off');
  const ext = first(xfrm, 'ext');
  const prst = attr(first(spPr, 'prstGeom'), 'prst');
  const geometry: RenderedShape['geometry'] = first(spPr, 'custGeom')
    ? 'none'
    : ['rect', 'flowChartProcess', 'snip1Rect', ''].includes(prst) || isPic
      ? 'rect'
      : prst === 'roundRect'
        ? 'roundRect'
        : prst === 'ellipse'
          ? 'ellipse'
          : prst === 'line' || prst === 'straightConnector1'
            ? 'line'
            : 'none';
  const radiusVal = /val\s+(\d+)/.exec(attr(all(spPr ?? el, 'gd')[0], 'fmla'))?.[1];
  const radius = (radiusVal ? Number(radiusVal) : 16667) / 100000;
  const fill = fillOf(spPr, ctx.theme);
  const lnEl = first(spPr, 'ln');
  const lineColor = fillOf(lnEl, ctx.theme);
  const shape: RenderedShape = {
    x: num(off, 'x') * PX,
    y: num(off, 'y') * PX,
    w: num(ext, 'cx') * PX,
    h: num(ext, 'cy') * PX,
    rotation: num(xfrm, 'rot') / 60000,
    flipH: attr(xfrm, 'flipH') === '1',
    flipV: attr(xfrm, 'flipV') === '1',
    geometry,
    radius: Math.min(0.5, radius),
    fill: isPic || fill === 'none' ? '' : fill,
    line: lineColor && lineColor !== 'none' ? { widthPx: num(lnEl, 'w', 12700) * PX, color: lineColor } : undefined,
  };
  if (isPic) {
    const blip = all(el, 'blip')[0];
    const src = imageUrl(ctx, rel.get(rid(blip, 'embed') || rid(blip, 'link')));
    const rect = all(el, 'srcRect')[0];
    const c = (n: string) => num(rect, n) / 100000;
    if (!src) return null;
    shape.image = { src, crop: [c('l'), c('t'), c('r'), c('b')] };
  } else {
    shape.text = readText(el, ctx, key);
    const blipFill = first(spPr, 'blipFill');
    if (blipFill) {
      const src = imageUrl(ctx, rel.get(rid(first(blipFill, 'blip'), 'embed')));
      if (src) shape.image = { src, crop: [0, 0, 0, 0] };
    }
  }
  return shape;
}

function shapesOf(doc: Document | null, ctx: Ctx, rel: Rels, holders: Element[][], skipPlaceholders: boolean) {
  const tree = doc ? all(doc, 'spTree')[0] : undefined;
  const out: RenderedShape[] = [];
  for (const el of Array.from(tree?.children ?? [])) {
    if (el.localName !== 'sp' && el.localName !== 'pic') continue;
    if (skipPlaceholders && placeholderKey(el)) continue;
    const s = readShape(el, ctx, rel, holders);
    if (s) out.push(s);
  }
  return out;
}

function backgroundOf(doc: Document | null, ctx: Ctx, rel: Rels): { color: string; image?: string } {
  const bgPr = doc ? all(doc, 'bgPr')[0] : undefined;
  if (!bgPr) return { color: '' };
  const image = imageUrl(ctx, rel.get(rid(all(bgPr, 'blip')[0], 'embed')));
  return { color: fillOf(bgPr, ctx.theme) === 'none' ? '' : fillOf(bgPr, ctx.theme), image: image || undefined };
}

function readStyles(master: Document | null): Styles {
  const size = (tag: string) => {
    const root = master ? all(master, tag)[0] : undefined;
    return num(first(first(root, 'lvl1pPr'), 'defRPr'), 'sz', 0);
  };
  return {
    sizes: { title: size('titleStyle') || 4400, body: size('bodyStyle') || 2800, other: size('otherStyle') || 1800 },
  };
}

/**
 * Read the slides of a .pptx to draw them.
 * @param bytes - The file.
 * @param makeUrl - Makes a URL for a picture of the file.
 */
export function renderPptx(bytes: Uint8Array, makeUrl: MakeUrl): RenderedSlide[] {
  const files = open(
    bytes,
    /^ppt\/(presentation\.xml|theme\/theme\d+\.xml|slides\/slide\d+\.xml|slideLayouts\/slideLayout\d+\.xml|slideMasters\/slideMaster\d+\.xml|(slides|slideLayouts|slideMasters)\/_rels\/[^/]+\.rels|media\/[^/]+)$/,
  );
  const presentation = xml(files['ppt/presentation.xml']);
  const sz = presentation ? all(presentation, 'sldSz')[0] : undefined;
  const width = num(sz, 'cx', 12192000) * PX;
  const height = num(sz, 'cy', 6858000) * PX;
  const num2 = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const names = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => num2(a) - num2(b));
  if (!names.length) throw new OfficeError('damaged');
  const themeName = Object.keys(files)
    .filter((n) => n.startsWith('ppt/theme/'))
    .sort()[0];
  const theme = readTheme(files, themeName);
  const urls = new Map<string, string>();
  return names.map((name) => {
    const slideDoc = xml(files[name]);
    const slideRel = rels(files, name);
    const layoutName = [...slideRel.values()].find((t) => t.startsWith('ppt/slideLayouts/'));
    const layoutDoc = layoutName ? xml(files[layoutName]) : null;
    const layoutRel = layoutName ? rels(files, layoutName) : new Map();
    const masterName = [...layoutRel.values()].find((t) => t.startsWith('ppt/slideMasters/'));
    const masterDoc = masterName ? xml(files[masterName]) : null;
    const masterRel = masterName ? rels(files, masterName) : new Map();
    const ctx: Ctx = { files, theme, makeUrl, urls, styles: readStyles(masterDoc) };
    const holders = [layoutDoc, masterDoc].map((d) => (d ? Array.from(all(d, 'spTree')[0]?.children ?? []) : []));
    const own = backgroundOf(slideDoc, ctx, slideRel);
    const layoutBg = backgroundOf(layoutDoc, ctx, layoutRel);
    const masterBg = backgroundOf(masterDoc, ctx, masterRel);
    const bg = own.color || own.image ? own : layoutBg.color || layoutBg.image ? layoutBg : masterBg;
    return {
      width,
      height,
      background: bg.color || '#ffffff',
      backgroundImage: bg.image,
      shapes: [
        ...shapesOf(masterDoc, ctx, masterRel, [], true),
        ...shapesOf(layoutDoc, ctx, layoutRel, [], true),
        ...shapesOf(slideDoc, ctx, slideRel, holders, false),
      ],
    };
  });
}
