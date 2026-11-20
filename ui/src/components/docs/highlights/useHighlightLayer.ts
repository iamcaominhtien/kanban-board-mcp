/**
 * Draws the shared highlights on the rendered page (design board "Rich Docs — reading", K 76): the colour's tint with
 * a dotted line in its ink (CSS Custom Highlight API, one highlight name per colour), and right after the words a
 * marker: the colour's shape, the person's dot and, when a thread is on it, a speech mark. Where the author's own text
 * colour would fall under 4.5 : 1 on the tint (77), the tint gives way and only the line and the marker show (a
 * `dk-hl-<colour>-line` name). One of yours that did not save has a dashed red line and a warning mark instead (125). The markers are the only nodes added to the page; the
 * rendered page is keyed by its content (DocsPageView), so React never edits a text node a marker split.
 */

import { useEffect, useRef } from 'react';
import type { HighlightColor } from '../../../api/docsHighlights';
import { HL_INK, HL_TINTS, colorName, contrast, shapeSvg } from './colors';
import { locate } from './hlAnchor';
import type { HlItem } from './useHighlights';

/** A person as the markers and the list draw them. */
export interface HlPerson {
  /** "You", or their name. */
  name: string;
  initials: string;
  bg: string;
  color: string;
}

type Registry = Map<string, unknown> & { set(k: string, v: unknown): unknown; delete(k: string): boolean };
const registry = (): Registry | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Registry }).highlights : null;
type HighlightObj = { priority: number };
const HighlightCtor = (): (new (...r: Range[]) => HighlightObj) | null =>
  (globalThis as unknown as { Highlight?: new (...r: Range[]) => HighlightObj }).Highlight ?? null;

/** The highlight names this layer sets, so it can take them all away again. */
const NAMES: string[] = [];

/** The words of a chip, link or code span are never split: a marker goes after it. */
const ATOMIC_SEL = '.dk-chip,a,code,.katex,[data-ref]';

function markerPlace(range: Range, root: HTMLElement): { parent: Node; before: Node | null } | null {
  const node = range.endContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const atomic = el?.closest(ATOMIC_SEL);
  if (atomic && root.contains(atomic) && atomic !== root) {
    return atomic.parentNode ? { parent: atomic.parentNode, before: atomic.nextSibling } : null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const offset = range.endOffset;
    if (offset > 0 && offset < text.length) text.splitText(offset);
    if (!text.parentNode) return null;
    return offset === 0
      ? { parent: text.parentNode, before: text }
      : { parent: text.parentNode, before: text.nextSibling };
  }
  const offset = Math.min(range.endOffset, node.childNodes.length);
  return { parent: node, before: node.childNodes[offset] ?? null };
}

/** The reading theme around the page ("white", "sepia", "night"). */
function themeOf(root: HTMLElement): keyof typeof HL_TINTS {
  const t = root.closest('[data-reader-theme]')?.getAttribute('data-reader-theme');
  return t === 'sepia' || t === 'night' ? t : 'white';
}

/**
 * Whether some text of a range would fall under 4.5 : 1 on a tint (77: the author's own text colour, a link).
 * @param range - The highlight's words.
 * @param tint - The tint as a hex colour.
 */
export function failsContrast(range: Range, tint: string): boolean {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root) return false;
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !(n as Text).data.trim() || !range.intersectsNode(n)) continue;
    seen.add(el);
    const ratio = contrast(getComputedStyle(el).color, tint);
    if (ratio !== null && ratio < 4.5) return true;
  }
  return false;
}

const SPEECH =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true" style="margin-left:2px"><path d="M4 5h16v11H9l-5 4z"/></svg>';
const WARN =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#C4432A" stroke-width="2.6" aria-hidden="true"><path d="M12 3.5L22 20H2Z"/><path d="M12 10V14"/><path d="M12 17.2V17.3"/></svg>';

/** The colour of a person's dot: their ink, or their avatar's fill when the ink is white (the board's owner). */
export function personInk(p: Pick<HlPerson, 'bg' | 'color'>): string {
  return /^#f{3}(f{3})?$/i.test(p.color) ? p.bg : p.color;
}

/** "Highlighted Yellow by Hoa Mai" (the marker's name for a screen reader, 100). */
export function markerLabel(h: Pick<HlItem, 'color' | 'mine' | 'local'>, person: HlPerson): string {
  if (h.local === 'failed') return `Highlight not saved, ${colorName(h.color)}`;
  return `Highlighted ${colorName(h.color)} by ${h.mine ? 'you' : person.name}`;
}

interface Opts {
  /** The rendered page body. */
  root: HTMLElement | null;
  items: HlItem[];
  /** Hide the layer (switched off; the Reader's own "Show highlights"). */
  hidden: boolean;
  /** Re-run when this changes (the text shown). */
  revision: string;
  personOf: (author: string) => HlPerson;
  /** Called when a highlight or its marker is clicked, with where it is on screen. */
  onOpen: (id: string, rect: DOMRect) => void;
  /** Receives the ids in the page's order, and those whose words are not on the page ("Passage changed"). */
  onLayout?: (layout: { order: string[]; missing: string[] }) => void;
}

/**
 * Lays out the highlights; returns a map from id to its range in the page (null when its words are not there).
 * @param opts - The page body, the highlights and the callbacks.
 */
export function useHighlightLayer({ root, items, hidden, revision, personOf, onOpen, onLayout }: Opts) {
  const ranges = useRef(new Map<string, Range>());
  const cb = useRef({ personOf, onOpen, onLayout });
  cb.current = { personOf, onOpen, onLayout };
  const layoutKey = useRef('');

  useEffect(() => {
    const reg = registry();
    const H = HighlightCtor();
    const map = ranges.current;
    if (!root) return;
    let frame = 0;
    let placed: HTMLElement[] = [];
    let disposed = false;
    const clearNames = () => {
      for (const n of NAMES.splice(0)) reg?.delete(n);
    };
    const removeMarkers = () => {
      for (const m of placed) m.remove();
      placed = [];
    };
    const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true };
    // only changes of the page's own text matter: markers and comment numbers come and go around it
    const ours = (n: Node) =>
      n instanceof HTMLElement && (n.matches('.dk-hl-mark,.dk-cmt-badge') || !!n.closest('.dk-hl-mark'));
    const relevant = (records: MutationRecord[]) =>
      records.some((r) => {
        if (r.type === 'characterData') return !(r.target.parentElement?.closest('.dk-hl-mark,.dk-cmt-badge') ?? null);
        const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
        return nodes.some((n) => !ours(n) && n.nodeType !== Node.TEXT_NODE) || nodes.length === 0;
      });

    const layout = () => {
      frame = 0;
      if (disposed || root.querySelector('[data-rendering]')) return;
      mo.disconnect();
      removeMarkers();
      clearNames();
      map.clear();
      const missing: string[] = [];
      const byName = new Map<string, Range[]>();
      const tints = HL_TINTS[themeOf(root)];
      const lineOnly = new Set<string>();
      // oldest first: a newer highlight is drawn over an older one (88: "the newer one is on top")
      const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const h of hidden ? [] : sorted) {
        let range: Range | null = null;
        try {
          range = locate(root, h);
        } catch {
          range = null;
        }
        if (!range) {
          missing.push(h.id);
          continue;
        }
        map.set(h.id, range);
        const line = h.local !== 'failed' && failsContrast(range, tints[h.color as HighlightColor]);
        if (line) lineOnly.add(h.id);
        const name = `dk-hl-${h.color}${h.local === 'failed' ? '-failed' : line ? '-line' : ''}`;
        byName.set(name, [...(byName.get(name) ?? []), range]);
      }
      if (reg && H) {
        let prio = 0;
        for (const [name, rs] of byName) {
          const hl = new H(...rs);
          hl.priority = prio += 1;
          reg.set(name, hl);
          NAMES.push(name);
        }
      }
      for (const h of sorted) {
        const range = map.get(h.id);
        if (!range) continue;
        const at = markerPlace(range, root);
        if (!at) continue;
        const person = cb.current.personOf(h.author);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `dk-hl-mark${h.local === 'failed' ? ' is-failed' : ''}`;
        b.dataset.testid = 'hl-marker';
        b.dataset.hl = h.id;
        b.dataset.hlSkip = '';
        b.dataset.nocomment = '';
        if (lineOnly.has(h.id)) b.dataset.contrast = 'line';
        b.setAttribute('aria-label', markerLabel(h, person));
        b.title = markerLabel(h, person);
        b.style.color = HL_INK[h.color as HighlightColor];
        if (h.local === 'failed') b.innerHTML = WARN;
        else {
          b.innerHTML = shapeSvg(h.color, 10);
          const dot = document.createElement('span');
          dot.className = 'dk-hl-dot';
          dot.style.background = personInk(person);
          b.appendChild(dot);
          if (h.threadId) b.insertAdjacentHTML('beforeend', SPEECH);
        }
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          cb.current.onOpen(h.id, b.getBoundingClientRect());
        });
        at.parent.insertBefore(b, at.before);
        placed.push(b);
      }
      const order = [...map.entries()]
        .sort((a, b) => a[1].compareBoundaryPoints(Range.START_TO_START, b[1]))
        .map(([id]) => id);
      const key = `${order.join(',')}|${missing.join(',')}`;
      if (key !== layoutKey.current) {
        layoutKey.current = key;
        cb.current.onLayout?.({ order, missing });
      }
      mo.takeRecords();
      mo.observe(root, OBSERVE);
    };
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(layout);
    };
    const mo = new MutationObserver((records) => {
      if (relevant(records)) schedule();
    });
    mo.observe(root, OBSERVE);
    layout();
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);

    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      if ((e.target as HTMLElement | null)?.closest('a,button,.dk-chip,[data-ref]')) return;
      // the newest under the pointer wins, as it is drawn on top
      const hits = items.filter((h) => map.has(h.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const h of hits) {
        const r = map.get(h.id);
        if (!r) continue;
        for (const rect of Array.from(r.getClientRects())) {
          if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            cb.current.onOpen(h.id, r.getBoundingClientRect());
            return;
          }
        }
      }
    };
    root.addEventListener('click', onClick);

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      mo.disconnect();
      window.removeEventListener('resize', schedule);
      root.removeEventListener('click', onClick);
      removeMarkers();
      clearNames();
      map.clear();
    };
  }, [root, items, hidden, revision]);

  return ranges;
}

/**
 * Scrolls a highlight into view and marks it once (100, 117): a 0.6 s fade of a tint over it, or with reduced motion
 * a static 2 px ring for 3 seconds. The mark is drawn over the scrolling pane, never into the page.
 * @param range - The highlight's words.
 * @param pane - The page's scrolling element.
 */
export function flashRange(range: Range, pane: HTMLElement | null) {
  const first = range.getClientRects()[0];
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const reduced =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  startEl?.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  if (!pane || !first) return;
  const draw = () => {
    const box = pane.getBoundingClientRect();
    const wrap = document.createElement('div');
    wrap.className = `dk-hl-flash${reduced ? ' is-static' : ''}`;
    wrap.dataset.testid = 'hl-flash';
    wrap.setAttribute('aria-hidden', 'true');
    for (const r of Array.from(range.getClientRects())) {
      const d = document.createElement('div');
      d.style.left = `${r.left - box.left + pane.scrollLeft}px`;
      d.style.top = `${r.top - box.top + pane.scrollTop}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
      wrap.appendChild(d);
    }
    pane.appendChild(wrap);
    window.setTimeout(() => wrap.remove(), reduced ? 3000 : 700);
  };
  // after the scroll has settled
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    pane.removeEventListener('scrollend', go);
    draw();
  };
  pane.addEventListener('scrollend', go);
  window.setTimeout(go, reduced ? 0 : 450);
}
