/**
 * The small pieces a page shows in the tree, the gallery and the recent list (design "Rich Docs — organising
 * pages", A 1-6): its icon, its status dot, the conversion marker, the tint of a page with no cover, and the hover
 * card with the cover, the status and the first lines.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDocsPage } from '../../../api/docs';
import { resolveOrigin } from '../../../api/resolveOrigin';
import type { DocsTreeNode } from '../../../types/docs';
import { agoText, displayName } from '../docsShared';
import { Icon } from '../Icon';
import { coverUrl, PALETTE, readingMinutes, readPageLook } from '../pageSettings';
import { childrenMap, isBook, parseIcon, rowStatus, type RowStatus } from './treeModel';
import './tree.css';

/**
 * The page's icon: its emoji, line icon or picture, else the page (or canvas) mark.
 * @param props.icon - The stored `icon` setting.
 * @param props.kind - A canvas page shows the layers mark when it has no icon.
 * @param props.size - Edge in CSS pixels.
 */
export function PageIcon({
  icon,
  kind,
  size = 15,
  active,
}: {
  icon?: string | null;
  kind?: 'page' | 'canvas';
  size?: number;
  active?: boolean;
}) {
  const spec = parseIcon(icon);
  const box: CSSProperties = { width: size + 3, height: size + 3, flexShrink: 0 };
  if (spec?.kind === 'emoji')
    return (
      <span className="tr-icon tr-emoji" aria-hidden="true" style={{ ...box, fontSize: size - 1 }}>
        {spec.value}
      </span>
    );
  if (spec?.kind === 'image')
    return (
      <span className="tr-icon" aria-hidden="true" style={box}>
        <img src={coverUrl(spec.src, resolveOrigin())} alt="" style={{ width: size, height: size }} />
      </span>
    );
  return (
    <span className="tr-icon" aria-hidden="true" style={{ ...box, color: active ? '#2E6F40' : '#9AA8A0' }}>
      <Icon
        name={spec?.kind === 'icon' ? spec.name : kind === 'canvas' ? 'canvas' : 'page'}
        size={size}
        strokeWidth={1.7}
      />
    </span>
  );
}

/** The status dot of a row: quiet for published, standing out for draft, changed, outdated and in review. */
export function StatusDot({ status }: { status: RowStatus }) {
  return (
    <span
      className={`tr-dot tr-dot-${status.key}`}
      title={status.label}
      aria-hidden="true"
      data-status={status.key}
      style={{ background: status.color }}
    />
  );
}

/** The marker of a page still being converted to the rich format, or whose conversion failed. */
export function ConvertMark({ state }: { state: DocsTreeNode['convertState'] }) {
  if (state !== 'waiting' && state !== 'working' && state !== 'failed') return null;
  const failed = state === 'failed';
  return (
    <span
      className={`tr-convert${failed ? ' tr-convert-failed' : ''}`}
      title={failed ? 'Conversion failed: read-only' : 'Converting to the new format'}
      aria-hidden="true"
      data-testid="tree-convert-mark"
    >
      {failed ? '!' : '↻'}
    </span>
  );
}

/** A soft tint for a page with no cover, the same for a page every time. */
export function pageTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 32% 92%)`;
}

/** The first lines of a page, as plain text. */
function firstLines(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]+)[^\]]*\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>|#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * The hover card of a row (desktop): the cover or the page colour, the status, the first lines and who edited it.
 * The page is fetched only once the card shows. A book says how many of its chapters are published.
 * @param props.node - The row's page.
 * @param props.nodes - The tree (for a book's chapters).
 * @param props.anchor - The row's box; the card sits to its right.
 */
export function HoverCard({ node, nodes, anchor }: { node: DocsTreeNode; nodes: DocsTreeNode[]; anchor: DOMRect }) {
  const { data: page } = useDocsPage(node.id);
  const status = rowStatus(node, new Date());
  const look = readPageLook(page?.settings);
  const book = isBook(node);
  const chapters = book ? (childrenMap(nodes).get(node.id) ?? []) : [];
  const published = chapters.filter((c) => c.version > 0).length;
  const icon = parseIcon(node.icon);
  const top = Math.max(8, Math.min(anchor.top - 10, window.innerHeight - 280));
  const text = page ? firstLines(page.markdown) : '';
  return createPortal(
    <div
      className="tr-hovercard docs-root"
      role="tooltip"
      data-testid="tree-hover-card"
      style={{ left: anchor.right + 10, top }}
    >
      <div
        className="tr-hc-cover"
        style={
          node.cover
            ? { backgroundImage: `url("${coverUrl(node.cover, resolveOrigin())}")` }
            : { background: page ? PALETTE[look.background].page : pageTint(node.id) }
        }
      >
        {!node.cover && icon?.kind === 'emoji' && <span className="tr-hc-emoji">{icon.value}</span>}
      </div>
      <div className="tr-hc-body">
        <div className="tr-hc-title">
          <PageIcon icon={node.icon} kind={node.kind} size={14} />
          <span>{node.title}</span>
        </div>
        <div className="tr-hc-tags">
          <span className="tr-tag" style={{ color: status.color === '#8DC09C' ? '#2E6F40' : status.color }}>
            {status.label}
          </span>
          {book && <span className="tr-tag tr-tag-book">Book</span>}
          {(node.suggestions ?? 0) > 0 && <span className="tr-tag tr-tag-ai">{node.suggestions} waiting</span>}
        </div>
        {page ? (
          text && <p className="tr-hc-text">{text}</p>
        ) : (
          <div className="skel" style={{ height: 30, borderRadius: 4 }} />
        )}
        {book && (
          <div className="tr-hc-meta">
            {published} of {chapters.length} chapters published
          </div>
        )}
        <div className="tr-hc-meta">
          {page ? `${displayName(page.updatedBy)} · ` : ''}
          {agoText(node.updatedAt)}
          <span style={{ marginLeft: 'auto' }}>
            {book ? `${chapters.length} chapters` : page ? `${readingMinutes(page.markdown)} min read` : ''}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Shows a hover card after the pointer rests on a row for a moment (desktop only; touch has no hover).
 * @param enabled - Hover cards are on (desktop, nothing being dragged, no menu open).
 * @returns `bind(id)` for a row's mouse handlers, and the row being shown with its box.
 */
export function useHoverCard(enabled: boolean) {
  const [shown, setShown] = useState<{ id: string; rect: DOMRect } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!enabled) {
      window.clearTimeout(timer.current);
      setShown(null);
    }
  }, [enabled]);
  const bind = (id: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (!enabled) return;
      const el = e.currentTarget;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShown({ id, rect: el.getBoundingClientRect() }), 650);
    },
    onMouseLeave: () => {
      window.clearTimeout(timer.current);
      setShown(null);
    },
  });
  return { shown: enabled ? shown : null, bind, hide: () => setShown(null) };
}
