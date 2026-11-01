import { useEffect, useState } from 'react';
import type { CanvasThread, PinAnchor } from '../../api/canvases';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** CSS.escape where the browser has it, a close copy where it does not (tests). */
function esc(s: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css?.escape) return css.escape(s);
  return s.replace(/^\d/, (d) => `\\3${d} `).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

const STABLE_ATTRS = ['data-testid', 'data-id', 'aria-label', 'name'];

function unique(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/**
 * A CSS selector that finds `el` again: its id, a stable attribute, or the path from the body by tag and position.
 * @param el - The element the pin was put on.
 */
export function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id && unique(doc, `#${esc(el.id)}`, el)) return `#${esc(el.id)}`;
  const tag = el.tagName.toLowerCase();
  for (const a of STABLE_ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const s = `${tag}[${a}="${v.replace(/["\\]/g, '\\$&')}"]`;
    if (unique(doc, s, el)) return s;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== doc.body && cur !== doc.documentElement) {
    const parent: Element | null = cur.parentElement;
    if (cur.id && unique(doc, `#${esc(cur.id)}`, cur)) {
      parts.unshift(`#${esc(cur.id)}`);
      return parts.join(' > ');
    }
    const name = cur.tagName.toLowerCase();
    const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
    cur = parent;
  }
  return `body > ${parts.join(' > ')}`;
}

/** The visible text of a small element, so a pin can find it again when the page's structure changes. */
function ownText(el: Element): string {
  if (el.children.length > 4) return '';
  return squash(el.textContent ?? '').slice(0, 60);
}

/**
 * What a pin put at a point of a loaded page sits on: the element under the point, where inside it, and the width of
 * the page at the time. Nothing for the page's own background.
 * @param doc - The frame's document.
 * @param px - The point, in the frame's pixels from its left edge.
 * @param py - The point, in the frame's pixels from its top edge.
 * @param width - The frame's width when the pin is made.
 */
export function anchorAt(doc: Document, px: number, py: number, width: number): PinAnchor | null {
  let el: Element | null = null;
  try {
    el = doc.elementFromPoint(px, py);
  } catch {
    return null;
  }
  if (!el || el === doc.documentElement || el === doc.body) return null;
  const r = el.getBoundingClientRect();
  const text = ownText(el);
  return {
    sel: selectorFor(el),
    ...(text ? { text } : {}),
    ox: r.width ? clamp01((px - r.left) / r.width) : 0.5,
    oy: r.height ? clamp01((py - r.top) / r.height) : 0.5,
    w: Math.round(width),
  };
}

/** The smallest element whose text contains `text`. */
function findByText(doc: Document, text: string): Element | null {
  const want = squash(text).toLowerCase();
  if (!want || !doc.body) return null;
  let best: Element | null = null;
  let bestLen = Infinity;
  const all = doc.body.querySelectorAll('*');
  for (let i = 0; i < Math.min(all.length, 3000); i++) {
    const e = all[i];
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(e.tagName)) continue;
    const t = squash(e.textContent ?? '').toLowerCase();
    if (t.includes(want) && t.length < bestLen) {
      best = e;
      bestLen = t.length;
    }
  }
  return best;
}

/**
 * Where a pin's element is now, in the frame's pixels: found by its selector, else by its text, then the pin's place inside
 * it. `null` when the element is gone (the pin then stays where its x and y put it).
 * @param doc - The frame's document, laid out at the width it is shown at.
 * @param anchor - What the pin was put on.
 */
export function resolveAnchor(doc: Document, anchor: PinAnchor): { x: number; y: number } | null {
  let el: Element | null = null;
  if (anchor.sel) {
    try {
      el = doc.querySelector(anchor.sel);
    } catch {
      el = null;
    }
  }
  if (!el && anchor.text) el = findByText(doc, anchor.text);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const win = doc.defaultView;
  return {
    x: r.left + anchor.ox * r.width + (win?.scrollX ?? 0),
    y: r.top + anchor.oy * r.height + (win?.scrollY ?? 0),
  };
}

interface Options {
  threads: CanvasThread[];
  /** The live frame of a board, when it is drawn live. */
  frameFor: (boardId: string) => HTMLIFrameElement | null;
  /** The board's size now. */
  sizeOf: (boardId: string) => { w: number; h: number } | null;
  /** Changes when a frame loaded or a board changed size: look again. */
  tick: unknown;
}

/**
 * Where the pins on frames are drawn, as 0..1 of the frame: for a pin with an anchor, where its element is in the page as
 * it is laid out now (so a pin follows its element when the width changes); otherwise `x` and `y` as saved.
 * @param o - The threads, a way to reach each live frame and its size, and a value that changes when they do.
 */
export function useAnchoredPins({
  threads,
  frameFor,
  sizeOf,
  tick,
}: Options): Record<string, { x: number; y: number }> {
  const [at, setAt] = useState<Record<string, { x: number; y: number }>>({});
  const key = threads.map((t) => `${t.id}:${t.boardId ?? ''}:${t.anchor ? JSON.stringify(t.anchor) : ''}`).join('|');
  useEffect(() => {
    const compute = () => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const t of threads) {
        if (!t.boardId || !t.anchor) continue;
        const size = sizeOf(t.boardId);
        let doc: Document | null = null;
        try {
          doc = frameFor(t.boardId)?.contentDocument ?? null;
        } catch {
          doc = null;
        }
        if (!doc || !size) continue;
        const p = resolveAnchor(doc, t.anchor);
        if (p) next[t.id] = { x: clamp01(p.x / size.w), y: clamp01(p.y / size.h) };
      }
      setAt((old) => {
        const same =
          Object.keys(next).length === Object.keys(old).length &&
          Object.entries(next).every(([id, v]) => old[id] && old[id].x === v.x && old[id].y === v.y);
        return same ? old : next;
      });
    };
    compute();
    const later = window.setTimeout(compute, 700); // a page that draws itself with a script needs a moment
    return () => window.clearTimeout(later);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the threads are tracked by `key`
  }, [key, tick]);
  return at;
}
