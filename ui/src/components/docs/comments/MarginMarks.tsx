/**
 * Marks in the margin of a rich page (design "History and comments on rich pages", D 18–20, 25): with the comments
 * panel closed, one numbered mark per commented block, level with it (two threads on one block share a mark with a
 * count); with the panel open, only the threads the text highlights cannot show (an image, a table, an embed). A click
 * opens the thread. Hovering an image, a table or an embed shows a Comment button beside it: a comment on the whole
 * block. On a tablet or a phone the marks sit on the block's right edge.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsCommentThread, RichDoc } from '../../../types/docs';
import { Icon } from '../Icon';
import { collectBlocks, rangeForThread } from './anchorDom';
import {
  WHOLE_COMMENT_BLOCKS,
  anchorForBlock,
  blockLabel,
  findBlock,
  layoutMarks,
  topBlockOf,
  type MarginMark,
  type MarkInput,
} from './blockAnchor';
import type { Pick } from './SelectionComment';
import './blocks.css';

/** Props of {@link MarginMarks}. */
export interface MarginMarksProps {
  /** The page body (the marks are placed against it; it must be positioned). */
  root: HTMLElement | null;
  /** The published page (null on a Markdown page: no Comment button on blocks). */
  doc: RichDoc | null;
  /** The page's inline threads. */
  threads: DocsCommentThread[];
  /** The comments panel is open: only marks the text highlights cannot show. */
  panelOpen: boolean;
  activeId: string | null;
  layout: DocsLayout;
  /** Changes when the page shows something else (measure again). */
  revision: string;
  /** Offer the Comment button on images, tables and embeds. */
  canComment: boolean;
  onSelect: (threadId: string) => void;
  onComment: (pick: Pick) => void;
}

const SAFE_ID = /^[\w-]+$/;

/**
 * Which threads get a mark and how far down the page body their block starts.
 * @param root - The page body.
 * @param threads - The inline threads.
 * @param panelOpen - With the panel open, threads whose quote is highlighted in the text are left out.
 */
export function markInputs(root: HTMLElement, threads: DocsCommentThread[], panelOpen: boolean): MarkInput[] {
  const base = root.getBoundingClientRect();
  let blocks: ReturnType<typeof collectBlocks> | null = null;
  const out: MarkInput[] = [];
  for (const t of threads) {
    if (t.kind !== 'inline' || t.status !== 'open' || t.number == null || t.anchor?.state === 'orphaned') continue;
    const id = t.anchor?.blockId ?? '';
    let el: Element | null = id && SAFE_ID.test(id) ? root.querySelector(`[data-block-id="${id}"]`) : null;
    let inText = false;
    if (panelOpen || !el) {
      blocks ??= collectBlocks(root);
      const range = rangeForThread(blocks, t);
      inText = !!range;
      if (!el && range) el = topBlockOf(range.startContainer) ?? range.startContainer.parentElement;
    }
    if (!el || (panelOpen && inText)) continue;
    out.push({
      threadId: t.id,
      number: t.number,
      blockKey: el.getAttribute('data-block-id') ?? `thread-${t.id}`,
      top: Math.round(el.getBoundingClientRect().top - base.top),
    });
  }
  return out;
}

const sameMarks = (a: MarginMark[], b: MarginMark[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The margin marks and the Comment button on whole blocks.
 * @param props - See {@link MarginMarksProps}.
 */
export function MarginMarks({
  root,
  doc,
  threads,
  panelOpen,
  activeId,
  layout,
  revision,
  canComment,
  onSelect,
  onComment,
}: MarginMarksProps) {
  const [marks, setMarks] = useState<MarginMark[]>([]);
  const [hover, setHover] = useState<{ id: string; top: number } | null>(null);

  const measure = useCallback(() => {
    if (!root || root.querySelector('[data-rendering]')) return;
    const next = layoutMarks(markInputs(root, threads, panelOpen));
    setMarks((prev) => (sameMarks(prev, next) ? prev : next));
  }, [root, threads, panelOpen]);

  useEffect(() => {
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      }
    };
    measure();
    // a long page comes in piece by piece: measure again once it is all there
    const mo = new MutationObserver(schedule);
    mo.observe(root, { attributes: true, subtree: true, attributeFilter: ['data-rendering'] });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(root);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [root, measure, revision]);

  // hovering an image, a table or an embed offers a comment on the whole block
  useEffect(() => {
    if (!root || !doc || !canComment || layout !== 'desktop') return;
    const onOver = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('.dc-mark-add')) return;
      const el = topBlockOf(target);
      const id = el?.getAttribute('data-block-id');
      const hit = id ? findBlock(doc, id) : null;
      if (!el || !id || !hit || !WHOLE_COMMENT_BLOCKS.has(hit.node.type ?? '')) {
        setHover(null);
        return;
      }
      const top = Math.round(el.getBoundingClientRect().top - root.getBoundingClientRect().top);
      setHover((h) => (h?.id === id && h.top === top ? h : { id, top }));
    };
    const onLeave = () => setHover(null);
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseleave', onLeave);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseleave', onLeave);
    };
  }, [root, doc, canComment, layout]);

  const commentOn = (id: string) => {
    const hit = findBlock(doc, id);
    const el = root?.querySelector(`[data-block-id="${id}"]`);
    if (!hit || !el) return;
    const r = el.getBoundingClientRect();
    onComment({
      anchor: anchorForBlock(hit.node, doc),
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      label: blockLabel(hit.node) ?? undefined,
    });
    setHover(null);
  };

  const edge = layout !== 'desktop';
  return (
    <div className={`dc-marks${edge ? ' dc-marks-edge' : ''}`} data-nocomment aria-label="Comment marks">
      {marks.map((m) => {
        const extra = m.threadIds.length - 1;
        return (
          <button
            key={m.blockKey}
            type="button"
            className={`dc-mark${m.threadIds.includes(activeId ?? '') ? ' is-active' : ''}`}
            style={{ top: m.top }}
            data-testid="margin-mark"
            data-thread={m.threadIds[0]}
            data-block={m.blockKey}
            aria-label={extra ? `Open comment ${m.number} and ${extra} more on this block` : `Open comment ${m.number}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(m.threadIds[0]);
            }}
          >
            {m.number}
            {extra > 0 && <span className="dc-mark-count">+{extra}</span>}
          </button>
        );
      })}
      {hover && (
        <button
          type="button"
          className="dc-mark-add"
          style={{ top: hover.top + 6 }}
          data-testid="block-comment"
          aria-label="Comment on this block"
          title="Comment on this block"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => commentOn(hover.id)}
        >
          <Icon name="comment" size={14} strokeWidth={1.9} />
        </button>
      )}
    </div>
  );
}
