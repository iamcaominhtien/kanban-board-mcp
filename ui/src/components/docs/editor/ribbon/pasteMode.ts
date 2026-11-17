/**
 * Paste from Word and the web (Editor board K): three ways to take text that arrives with formatting the page does
 * not know. "Match page style" (the default) keeps the structure (headings, lists, tables, links, bold, italic,
 * underline, strike, super- and subscript) and drops the foreign fonts, colours and sizes; "Keep formatting" keeps
 * colours, fonts and sizes as format 1 marks (a font the page does not ship is dropped); "Plain text" takes the
 * text only, one paragraph per line. The default for the next paste is a setting of this device.
 */

import { FONTS, FONT_LABEL, type PageFont } from '../../pageSettings';
import { rgbToHex } from './palette';

/** How a paste is taken. */
export type PasteMode = 'keep' | 'match' | 'plain';
/** The device setting: a mode, or ask each time (the chip opens by itself). */
export type PasteDefault = PasteMode | 'ask';

export const PASTE_MODES: readonly { value: PasteMode; label: string; note: string; webNote?: string }[] = [
  {
    value: 'keep',
    label: 'Keep formatting',
    note: 'Fonts, colours and sizes as they came',
    webNote: 'Colours, fonts and sizes of the web page',
  },
  {
    value: 'match',
    label: 'Match page style',
    note: 'Keeps headings, bold, italic, links, lists and tables in this page’s fonts and colours',
  },
  { value: 'plain', label: 'Plain text', note: 'Text only, one paragraph per line' },
];

export const PASTE_DEFAULTS: readonly { value: PasteDefault; label: string }[] = [
  { value: 'ask', label: 'Ask me each time' },
  { value: 'match', label: 'Match page style' },
  { value: 'keep', label: 'Keep formatting' },
  { value: 'plain', label: 'Plain text' },
];

const KEY = 'docsPasteMode';

/** The paste setting of this device ("Match page style" until it is changed). */
export function readPasteDefault(): PasteDefault {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'keep' || v === 'match' || v === 'plain' || v === 'ask' ? v : 'match';
  } catch {
    return 'match';
  }
}

/**
 * Stores the paste setting of this device.
 * @param v - The new setting.
 */
export function writePasteDefault(v: PasteDefault): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage is off: the default stays */
  }
}

/** Where pasted HTML came from: Word (or another Office app), or a web page and anything else. */
export type PasteSource = 'word' | 'web';

/**
 * Whether clipboard HTML is rich text from outside the editor (a copy inside the editor carries `data-pm-slice` and
 * is pasted as it is).
 * @param html - The clipboard's text/html.
 */
export function isForeignRich(html: string): boolean {
  if (!html || /data-pm-slice/.test(html)) return false;
  return /<(p|h[1-6]|ul|ol|li|table|blockquote|b|strong|i|em|u|a|span|font|div)\b/i.test(html);
}

/**
 * Word (or Outlook, or OneNote) or the web.
 * @param html - The clipboard's text/html.
 */
export function pasteSource(html: string): PasteSource {
  return /urn:schemas-microsoft-com:office|class="?Mso|mso-[a-z-]+:/i.test(html) ? 'word' : 'web';
}

/** What a clean-up took out, for the note under the web page option. */
export interface PasteCleanup {
  scripts: number;
  tracking: number;
  styles: number;
}

/** The result of `cleanPastedHtml`. */
export interface CleanedPaste {
  html: string;
  removed: PasteCleanup;
}

const DROP = 'script,style,meta,link,title,noscript,iframe,object,embed,template,o\\:p,xml';
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|yclid)$/i;

/** A CSS colour as `#rrggbb`, or null (transparent, inherit, a name we do not know). */
function cssToHex(v: string): string | null {
  const s = v.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) return hex[1].length === 3 ? `#${[...hex[1]].map((c) => c + c).join('')}` : s;
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (rgb) {
    if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null;
    return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff' };
  return named[s] ?? null;
}

/** A CSS size in px (`12pt` = 16, `14px`, `1.2em` of 16), rounded to one decimal; null for anything else. */
function cssToPx(v: string): number | null {
  const m = /^([\d.]+)(pt|px|em|rem)$/.exec(v.trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const px = m[2] === 'pt' ? (n * 4) / 3 : m[2] === 'px' ? n : n * 16;
  return Number.isFinite(px) && px > 0 ? Math.round(Math.min(160, Math.max(8, px)) * 10) / 10 : null;
}

/** The font key of a CSS font-family list, when its first family is one the page ships. */
function cssToFont(v: string): PageFont | null {
  const first = v
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  if (!first) return null;
  return FONTS.find((f) => FONT_LABEL[f].toLowerCase() === first) ?? null;
}

/** Reads a style attribute into a map of property → value. */
function styleMap(el: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
  }
  return out;
}

/** Wraps the children of `el` in a new element `tag`. */
function wrapChildren(doc: Document, el: Element, tag: string, attrs: Record<string, string> = {}): void {
  const w = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) w.setAttribute(k, v);
  while (el.firstChild) w.appendChild(el.firstChild);
  el.appendChild(w);
}

/** Replaces an element by its children. */
function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** Inline formatting that lives in a style attribute (Google Docs, Word) turned into tags the page knows. */
function stylesToTags(doc: Document, el: Element, css: Map<string, string>): void {
  const weight = css.get('font-weight');
  const bold = weight === 'bold' || weight === 'bolder' || (weight && Number(weight) >= 600);
  const unbold = el.tagName === 'B' && (weight === 'normal' || (weight && Number(weight) < 600));
  const italic = css.get('font-style') === 'italic';
  const deco = `${css.get('text-decoration') ?? ''} ${css.get('text-decoration-line') ?? ''}`;
  const va = css.get('vertical-align');
  if (bold && !/^(B|STRONG|H[1-6]|TH)$/.test(el.tagName)) wrapChildren(doc, el, 'strong');
  if (italic && !/^(I|EM)$/.test(el.tagName)) wrapChildren(doc, el, 'em');
  if (/underline/.test(deco) && el.tagName !== 'U' && el.tagName !== 'A') wrapChildren(doc, el, 'u');
  if (/line-through/.test(deco) && !/^(S|DEL|STRIKE)$/.test(el.tagName)) wrapChildren(doc, el, 's');
  if (va === 'super') wrapChildren(doc, el, 'sup');
  if (va === 'sub') wrapChildren(doc, el, 'sub');
  // Google Docs wraps the whole copy in <b style="font-weight:normal">
  if (unbold) el.setAttribute('data-unwrap', '1');
}

/**
 * The HTML to insert for a paste taken in `mode` (not `plain`, which inserts the text): scripts, styles and comments
 * are removed, tracking parameters are cut from links; Match page style drops every font, colour and size, Keep
 * formatting turns them into the page's own marks.
 * @param html - The clipboard's text/html.
 * @param mode - `match` or `keep`.
 */
export function cleanPastedHtml(html: string, mode: Exclude<PasteMode, 'plain'>): CleanedPaste {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const removed: PasteCleanup = { scripts: 0, tracking: 0, styles: 0 };
  doc.querySelectorAll(DROP).forEach((el) => {
    if (el.tagName === 'SCRIPT') removed.scripts += 1;
    el.remove();
  });
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));

  doc.querySelectorAll('a[href]').forEach((a) => {
    try {
      const url = new URL(a.getAttribute('href') ?? '');
      const drop = [...url.searchParams.keys()].filter((k) => TRACKING_PARAM.test(k));
      if (drop.length) {
        drop.forEach((k) => url.searchParams.delete(k));
        a.setAttribute('href', url.toString());
        removed.tracking += 1;
      }
    } catch {
      /* a relative or odd link stays as it is */
    }
  });

  // deepest first, so a wrap does not move an element that is still to be read
  const all = [...doc.body.querySelectorAll('*')].reverse();
  for (const el of all) {
    const css = styleMap(el);
    if (el.hasAttribute('style')) removed.styles += 1;
    stylesToTags(doc, el, css);
    if (mode === 'keep') {
      const span: Record<string, string> = {};
      const color = css.get('color') ?? el.getAttribute('color') ?? '';
      const hex = color ? cssToHex(color) : null;
      if (hex && hex !== '#000000') span['data-color'] = hex;
      const font = cssToFont(css.get('font-family') ?? el.getAttribute('face') ?? '');
      if (font) span['data-font-family'] = font;
      const size = cssToPx(css.get('font-size') ?? '');
      if (size && !/^H[1-6]$/.test(el.tagName)) span['data-font-size'] = JSON.stringify(size);
      if (Object.keys(span).length) wrapChildren(doc, el, 'span', span);
      const bg = cssToHex(css.get('background-color') ?? css.get('background') ?? '');
      if (bg && bg !== '#ffffff' && !/^(TD|TH|TABLE|TR|BODY|DIV|P)$/.test(el.tagName))
        wrapChildren(doc, el, 'mark', { 'data-color': bg });
    }
    for (const attr of ['style', 'class', 'color', 'face', 'size', 'bgcolor', 'lang', 'dir', 'id', 'align'])
      el.removeAttribute(attr);
    if (el.getAttribute('data-unwrap') || el.tagName === 'FONT') unwrap(el);
    // spans with nothing of their own left are unwrapped; Keep formatting's own spans carry data-*
    else if (el.tagName === 'SPAN' && !el.attributes.length) unwrap(el);
  }
  // a heading from a web page keeps its level but not the site's inline colours (done above); Word's empty
  // paragraphs (&nbsp; only) are kept as they are: they are the author's blank lines
  return { html: doc.body.innerHTML, removed };
}

/**
 * The paragraphs of a Plain text paste: one per line of the text, empty lines kept as empty paragraphs.
 * @param text - The clipboard's text/plain.
 */
export function plainParagraphs(text: string): { type: 'paragraph'; content?: { type: 'text'; text: string }[] }[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }));
}

/**
 * The clean-up note under the web page option: "Removed scripts, tracking links and 14 inline styles." (empty when
 * nothing was removed).
 * @param r - What was removed.
 */
export function cleanupNote(r: PasteCleanup): string {
  const parts: string[] = [];
  if (r.scripts) parts.push('scripts');
  if (r.tracking) parts.push('tracking links');
  if (r.styles) parts.push(`${r.styles} inline ${r.styles === 1 ? 'style' : 'styles'}`);
  if (!parts.length) return '';
  const last = parts.pop();
  return `Removed ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}
