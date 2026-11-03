import { useEffect } from 'react';
import type { DocsCommentThread } from '../../../types/docs';
import { collectBlocks, rangeForThread } from './anchorDom';

interface Opts {
  /** Element holding the rendered page body (the badges are placed inline in it). */
  root: HTMLElement | null;
  threads: DocsCommentThread[];
  activeId: string | null;
  /** Re-run when this changes (the Markdown shown). */
  revision: string;
  onSelect: (threadId: string) => void;
  /** Selection waiting for its comment: kept visible while the box is open. */
  pending?: Range | null;
}

type HighlightRegistry = Map<string, unknown> & { set(k: string, v: unknown): unknown };
const registry = (): HighlightRegistry | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS
    ? (CSS as unknown as { highlights: HighlightRegistry }).highlights
    : null;
const HighlightCtor = (): (new (...r: Range[]) => unknown) | null =>
  (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight ?? null;

/** Where a badge goes: right after the highlight, or after the chip, link or code span it ends in (their text can
 *  change on its own, so it is never split). */
const ATOMIC_SEL = '.dk-chip,a,code,.katex,[data-ref]';

function badgePlace(range: Range, root: HTMLElement): { parent: Node; before: Node | null } | null {
  const node = range.endContainer;
  let offset = range.endOffset;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const atomic = el?.closest(ATOMIC_SEL);
  if (atomic && root.contains(atomic) && atomic !== root) {
    return atomic.parentNode ? { parent: atomic.parentNode, before: atomic.nextSibling } : null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    if (offset > 0 && offset < text.length) text.splitText(offset);
    if (!text.parentNode) return null;
    return offset === 0
      ? { parent: text.parentNode, before: text }
      : { parent: text.parentNode, before: text.nextSibling };
  }
  offset = Math.min(offset, node.childNodes.length);
  return { parent: node, before: node.childNodes[offset] ?? null };
}

/**
 * Highlight commented text in the rendered page (CSS Custom Highlight API) and put its number right after the
 * highlighted text, inline, as the design draws it ("bearer token ❶;"). The badges are the only nodes added to the
 * page; the rendered Markdown is keyed by its content (DocsPageView), so React never edits a text node a badge split.
 * @param opts - Page body element, threads, active thread and callbacks.
 */
export function useCommentHighlights({ root, threads, activeId, revision, onSelect, pending }: Opts): void {
  useEffect(() => {
    const reg = registry();
    const H = HighlightCtor();
    if (!root) return;
    let entries: { id: string; number: number; range: Range }[] = [];
    let frame = 0;
    let placed: HTMLButtonElement[] = [];
    const removeBadges = () => {
      for (const b of placed) b.remove();
      placed = [];
    };
    const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true };

    const layout = () => {
      frame = 0;
      const blocks = collectBlocks(root);
      entries = [];
      for (const t of threads) {
        if (t.number == null || t.status !== 'open') continue;
        const range = rangeForThread(blocks, t);
        if (range) entries.push({ id: t.id, number: t.number, range });
      }
      if (reg && H) {
        const all = entries.filter((e) => e.id !== activeId).map((e) => e.range);
        const act = entries.filter((e) => e.id === activeId).map((e) => e.range);
        reg.set('dk-cmt', new H(...all));
        reg.set('dk-cmt-active', new H(...act));
        reg.set('dk-cmt-pending', new H(...(pending ? [pending] : [])));
      }
      // our own changes to the page must not wake the observer, or the badges would be placed again and again
      mo.disconnect();
      removeBadges();
      for (const e of entries) {
        const at = badgePlace(e.range, root);
        if (!at) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dk-cmt-badge' + (e.id === activeId ? ' is-active' : '');
        b.dataset.testid = 'comment-badge';
        b.dataset.thread = e.id;
        b.dataset.nocomment = '';
        b.setAttribute('aria-label', `Open comment ${e.number}`);
        b.textContent = String(e.number);
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onSelect(e.id);
        });
        at.parent.insertBefore(b, at.before);
        placed.push(b);
      }
      mo.takeRecords();
      mo.observe(root, OBSERVE);
    };
    // a late callback (fonts ready, a resize) after this effect was cleaned up must not lay out its stale threads:
    // the registry is global, so it would wipe the highlights the current effect set
    let disposed = false;
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(layout);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, OBSERVE);
    layout();
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);

    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      for (const en of entries) {
        for (const r of Array.from(en.range.getClientRects())) {
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            onSelect(en.id);
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
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      root.removeEventListener('click', onClick);
      removeBadges();
      reg?.delete('dk-cmt');
      reg?.delete('dk-cmt-active');
      reg?.delete('dk-cmt-pending');
    };
  }, [root, threads, activeId, revision, onSelect, pending]);
}
