import { unzipSync } from 'fflate';

/** Biggest part of an Office file read in the browser. */
const PART_LIMIT = 20 * 1024 * 1024;

/** A block of a simplified Word view. */
export type WordBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string; bold?: boolean }
  | { type: 'list'; ordered: boolean; text: string }
  | { type: 'table'; rows: string[][] };

/** One slide of a presentation: its text and speaker notes. */
export interface Slide {
  title: string;
  /** A short label above the title ("THE PROBLEM"), when the slide has one. */
  kicker?: string;
  lines: string[];
  notes: string;
}

/** Thrown when an Office file cannot be read. */
export class OfficeError extends Error {
  reason: 'damaged' | 'protected' | 'too-large';
  constructor(reason: 'damaged' | 'protected' | 'too-large') {
    super(reason);
    this.reason = reason;
  }
}

function open(bytes: Uint8Array, wanted: RegExp): Record<string, Uint8Array> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new OfficeError('protected');
  try {
    return unzipSync(bytes, { filter: (f) => wanted.test(f.name) && f.originalSize <= PART_LIMIT });
  } catch {
    throw new OfficeError('damaged');
  }
}

function xml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

const kids = (el: Element, tag: string) => Array.from(el.children).filter((c) => c.localName === tag);
const first = (el: Element, tag: string) => kids(el, tag)[0];

function runText(p: Element): string {
  let out = '';
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 't') out += c.textContent ?? '';
      else if (c.localName === 'tab') out += '\t';
      else if (c.localName === 'br') out += '\n';
      else if (c.localName !== 'instrText' && c.localName !== 'del') walk(c);
    }
  };
  walk(p);
  return out;
}

/**
 * Read a .docx as headings, paragraphs, lists and tables. Text only: pictures, fonts, layout, comments and tracked
 * changes are left out, and nothing in the file is run (macros and fields are ignored).
 * @param bytes - The file.
 */
export function parseDocx(bytes: Uint8Array): WordBlock[] {
  const files = open(bytes, /^word\/(document|numbering)\.xml$/);
  const doc = xml(files['word/document.xml']);
  const body = doc?.getElementsByTagName('w:body')[0] ?? doc?.getElementsByTagNameNS('*', 'body')[0];
  if (!body) throw new OfficeError('damaged');
  const numbering = xml(files['word/numbering.xml']);
  const orderedIds = new Set<string>();
  if (numbering) {
    const abstractOrdered = new Map<string, boolean>();
    for (const a of Array.from(numbering.getElementsByTagNameNS('*', 'abstractNum'))) {
      const lvl = Array.from(a.getElementsByTagNameNS('*', 'numFmt'))[0];
      const fmt = lvl?.getAttribute('w:val') ?? lvl?.getAttributeNS('*', 'val');
      abstractOrdered.set(a.getAttribute('w:abstractNumId') ?? '', !!fmt && fmt !== 'bullet');
    }
    for (const n of Array.from(numbering.getElementsByTagNameNS('*', 'num'))) {
      const abs = Array.from(n.getElementsByTagNameNS('*', 'abstractNumId'))[0]?.getAttribute('w:val') ?? '';
      if (abstractOrdered.get(abs)) orderedIds.add(n.getAttribute('w:numId') ?? '');
    }
  }
  const attr = (el: Element | undefined, name: string) => el?.getAttribute(`w:${name}`) ?? '';

  const blocks: WordBlock[] = [];
  const paragraph = (p: Element) => {
    const text = runText(p).trim();
    if (!text) return;
    const pPr = first(p, 'pPr');
    const style = attr(pPr && first(pPr, 'pStyle'), 'val');
    const heading = /^Heading(\d)$/i.exec(style) ?? (style.toLowerCase() === 'title' ? [style, '1'] : null);
    const numPr = pPr && first(pPr, 'numPr');
    if (heading) blocks.push({ type: 'heading', level: Math.min(6, Number(heading[1])), text });
    else if (numPr || /list/i.test(style))
      blocks.push({ type: 'list', ordered: orderedIds.has(attr(numPr && first(numPr, 'numId'), 'val')), text });
    else blocks.push({ type: 'paragraph', text });
  };
  for (const el of Array.from(body.children)) {
    if (el.localName === 'p') paragraph(el);
    else if (el.localName === 'tbl') {
      const rows = kids(el, 'tr').map((tr) =>
        kids(tr, 'tc').map((tc) =>
          kids(tc, 'p')
            .map((p) => runText(p).trim())
            .filter(Boolean)
            .join('\n'),
        ),
      );
      if (rows.length) blocks.push({ type: 'table', rows });
    }
  }
  return blocks;
}

/**
 * Read a .pptx as text per slide plus speaker notes. Slide pictures need a converter, so this is the outline view. A slide
 * without a title placeholder gets the biggest text as its title; repeated footers and page numbers are left out.
 * @param bytes - The file.
 */
export function parsePptx(bytes: Uint8Array): Slide[] {
  const files = open(bytes, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/);
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const slideNames = Object.keys(files)
    .filter((n) => n.startsWith('ppt/slides/'))
    .sort((a, b) => num(a) - num(b));
  if (!slideNames.length) throw new OfficeError('damaged');
  const notes = new Map<number, string>();
  for (const n of Object.keys(files).filter((k) => k.startsWith('ppt/notesSlides/'))) {
    const doc = xml(files[n]);
    if (!doc) continue;
    const lines: string[] = [];
    for (const sp of Array.from(doc.getElementsByTagNameNS('*', 'sp'))) {
      const ph = Array.from(sp.getElementsByTagNameNS('*', 'ph'))[0];
      if (ph && ph.getAttribute('type') !== 'body') continue;
      for (const p of Array.from(sp.getElementsByTagNameNS('*', 'p'))) {
        const t = runText(p).trim();
        if (t) lines.push(t);
      }
    }
    notes.set(num(n), lines.join('\n'));
  }
  // Every paragraph of every slide with its biggest font size (in 1/100 pt; 0 = inherited from the layout).
  const sizeOf = (p: Element) =>
    Math.max(0, ...Array.from(p.getElementsByTagNameNS('*', 'rPr')).map((r) => Number(r.getAttribute('sz')) || 0));
  type Para = { text: string; size: number; placeholderTitle: boolean };
  const perSlide: Para[][] = slideNames.map((n) => {
    const doc = xml(files[n]);
    const paras: Para[] = [];
    for (const sp of Array.from(doc?.getElementsByTagNameNS('*', 'sp') ?? [])) {
      const ph = Array.from(sp.getElementsByTagNameNS('*', 'ph'))[0];
      const placeholderTitle = !!ph && /title|ctrTitle/i.test(ph.getAttribute('type') ?? '');
      for (const p of Array.from(sp.getElementsByTagNameNS('*', 'p'))) {
        const text = runText(p).trim();
        if (text) paras.push({ text, size: sizeOf(p), placeholderTitle });
      }
    }
    return paras;
  });
  // What every slide repeats (a footer, a deck name) or numbers (a page number) is not the slide's own text.
  const seen = new Map<string, number>();
  for (const paras of perSlide) for (const t of new Set(paras.map((q) => q.text))) seen.set(t, (seen.get(t) ?? 0) + 1);
  const repeated = (t: string) => perSlide.length >= 4 && t.length >= 3 && (seen.get(t) ?? 0) >= perSlide.length * 0.6;
  // A big number ("12", "50%") is a figure to look at, not a title.
  const figure = (t: string) => t.length <= 6 && /^[\d\s.,:%+\-–×x/]+$/i.test(t);

  return perSlide.map((all, index) => {
    const paras = all.filter((q) => !repeated(q.text) && !(figure(q.text) && Number(q.text) === index + 1));
    // A deck made without title placeholders (most generated ones): the title is the biggest text that is not a figure.
    let at = paras.findIndex((q) => q.placeholderTitle);
    if (at < 0) {
      const best = Math.max(0, ...paras.filter((q) => !figure(q.text)).map((q) => q.size));
      at = paras.findIndex((q) => !figure(q.text) && q.size === best);
    }
    const title = at >= 0 ? paras[at].text : '';
    // A short, smaller line just before the title is its label ("THE PROBLEM"), shown above it.
    const before =
      at > 0 ? paras.findIndex((q, i) => i < at && q.size > 0 && q.size < paras[at].size && q.text.length <= 40) : -1;
    const kicker = before >= 0 ? paras[before].text : '';
    const lines = paras.filter((_, i) => i !== at && i !== before).map((q) => q.text);
    return { title, kicker, lines, notes: notes.get(num(slideNames[index])) ?? '' };
  });
}
