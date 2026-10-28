import { useEffect, useState } from 'react';
import type { DocsCommentThread } from '../../../types/docs';
import { collectBlocks, rangeForThread } from './anchorDom';

export interface Badge {
  id: string;
  number: number;
  left: number;
  top: number;
}

interface Opts {
  /** Element holding the rendered page body; also the badge container (must be `position: relative`). */
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

/**
 * Highlight commented text in the rendered page without touching its DOM (CSS Custom Highlight API),
 * and return numbered badges to draw at the end of each highlight.
 * @param opts - Page body element, threads, active thread and callbacks.
 * @returns Badge positions relative to `opts.root`.
 */
export function useCommentHighlights({ root, threads, activeId, revision, onSelect, pending }: Opts): Badge[] {
  const [badges, setBadges] = useState<Badge[]>([]);

  useEffect(() => {
    const reg = registry();
    const H = HighlightCtor();
    if (!root) return;
    let entries: { id: string; number: number; range: Range }[] = [];
    let frame = 0;

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
      const box = root.getBoundingClientRect();
      setBadges(
        entries.map((e) => {
          const rects = e.range.getClientRects();
          const r = rects[rects.length - 1] ?? e.range.getBoundingClientRect();
          return { id: e.id, number: e.number, left: r.right - box.left - 1, top: r.top - box.top - 14 };
        }),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(layout);
    };
    layout();

    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
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
      if (frame) cancelAnimationFrame(frame);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      root.removeEventListener('click', onClick);
      reg?.delete('dk-cmt');
      reg?.delete('dk-cmt-active');
      reg?.delete('dk-cmt-pending');
    };
  }, [root, threads, activeId, revision, onSelect, pending]);

  return badges;
}

/**
 * Numbered markers drawn after each highlighted text (click one to open its thread).
 * @param props.badges - Positions from `useCommentHighlights`.
 * @param props.activeId - Thread to emphasise.
 * @param props.onSelect - Called with a thread id when its number is clicked.
 */
export function CommentBadges({
  badges,
  activeId,
  onSelect,
}: {
  badges: Badge[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div data-nocomment style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {badges.map((b) => (
        <button
          key={b.id}
          type="button"
          data-testid="comment-badge"
          data-thread={b.id}
          aria-label={`Open comment ${b.number}`}
          className={'dk-cmt-badge' + (activeId === b.id ? ' is-active' : '')}
          style={{ left: b.left, top: b.top }}
          onClick={() => onSelect(b.id)}
        >
          {b.number}
        </button>
      ))}
    </div>
  );
}
