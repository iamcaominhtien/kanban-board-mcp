/**
 * The small pieces a page shows in the tree, the gallery and the recent list (design "Rich Docs — organising
 * pages", A 1-6): its icon, its status dot, the conversion marker, the tint of a page with no cover, and the hover
 * card with the cover, the status and the first lines.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDocsPage } from '../../../api/docs';
import { resolveOrigin } from '../../../api/resolveOrigin';
import type { DocsTreeNode } from '../../../types/docs';
import { agoText, displayName, initialsOf } from '../docsShared';
import { Icon } from '../Icon';
import { coverUrl, PALETTE, readingMinutes, readPageLook } from '../pageSettings';
import { BoardIcon } from './boardIcons';
import { childrenMap, isBook, parseIcon, rowStatus, STATUS_TONE, type RowStatus } from './treeModel';
import './tree.css';

/**
 * The page's icon: its emoji, line icon or picture, else the plain page (or canvas) mark. The boards draw it in a
 * box 4 px wider than the glyph (an emoji of 16 in a 20 px box in a desktop row, 18 on touch).
 * @param props.icon - The stored `icon` setting.
 * @param props.kind - A canvas page shows the layers mark when it has no icon.
 * @param props.size - Font size of an emoji (a line icon is drawn one pixel smaller), in CSS pixels.
 * @param props.active - The row is the open page (a line icon turns green).
 */
export function PageIcon({
  icon,
  kind,
  size = 16,
  active,
}: {
  icon?: string | null;
  kind?: 'page' | 'canvas';
  size?: number;
  active?: boolean;
}) {
  const spec = parseIcon(icon);
  const box: CSSProperties = { width: size + 4, flexShrink: 0 };
  if (spec?.kind === 'emoji')
    return (
      <span className="tr-icon tr-emoji" aria-hidden="true" style={{ ...box, fontSize: size }}>
        {spec.value}
      </span>
    );
  if (spec?.kind === 'image')
    return (
      <span className="tr-icon" aria-hidden="true" style={{ ...box, height: size }}>
        <img src={coverUrl(spec.src, resolveOrigin())} alt="" style={{ width: size, height: size }} />
      </span>
    );
  if (spec?.kind === 'icon' || kind === 'canvas')
    return (
      <span className="tr-icon" aria-hidden="true" style={{ ...box, color: active ? '#2E6F40' : '#5B6B60' }}>
        <Icon name={spec?.kind === 'icon' ? spec.name : 'canvas'} size={size - 1} strokeWidth={1.7} />
      </span>
    );
  return (
    <span className="tr-icon" aria-hidden="true" style={{ ...box, color: active ? '#2E6F40' : '#5B6B60' }}>
      <BoardIcon name="page" size={size - 1} strokeWidth={1.7} />
    </span>
  );
}

/**
 * The status dot of a row in its 12 px slot: a filled 8 px dot, a ring for "may be outdated".
 * @param props.status - The row's status.
 * @param props.slot - Wrap the dot in the row's 12 px slot (the tree); off where it sits in a line of text.
 */
export function StatusDot({ status, slot = true }: { status: RowStatus; slot?: boolean }) {
  const ring = status.key === 'outdated';
  const dot = (
    <span
      className={`tr-dot tr-dot-${status.key}`}
      title={status.label}
      aria-hidden="true"
      data-status={status.key}
      style={ring ? { border: `2px solid ${status.color}` } : { background: status.color }}
    />
  );
  return slot ? <span className="tr-dot-slot">{dot}</span> : dot;
}

/** The pill of a status (hover card, recent list): a 6 px dot and the label on the status colours. */
export function StatusPill({ status, size = 11 }: { status: RowStatus; size?: number }) {
  const t = STATUS_TONE[status.key];
  return (
    <span
      className="tr-pill-status"
      data-status={status.key}
      style={{ background: t.bg, color: t.fg, borderColor: t.border, fontSize: size }}
    >
      <span className="tr-pill-dot" style={{ background: status.color }} />
      {status.label}
    </span>
  );
}

/** "✦ 3": suggestions waiting for a person, the purple pill of the boards. */
export function SuggestionCount({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="tr-spark" title={`${count} AI suggestion${count === 1 ? '' : 's'} waiting`} aria-hidden="true">
      <BoardIcon name="spark" size={10} strokeWidth={2.4} />
      <span>{count}</span>
    </span>
  );
}

/** The "Book" tag of a row or a card (with "· 7 ch." on a card). */
export function BookTag({ children = 'Book' }: { children?: ReactNode }) {
  return (
    <span className="tr-booktag" aria-hidden="true">
      <BoardIcon name="book" size={10} strokeWidth={2.2} />
      {children}
    </span>
  );
}

const AVATAR_TONES = [
  { bg: '#E1EEFB', fg: '#1F5A8E' },
  { bg: '#F3E3F0', fg: '#8A2655' },
  { bg: '#FDF3E3', fg: '#8A5A00' },
  { bg: '#E6F2EA', fg: '#1F5A31' },
];

/**
 * The round initials of whoever edited a page, at the boards' sizes (18 on a hover card, 20 on a card, 22 in the
 * recent list; the letters are 40 % of the edge).
 */
export function EditorAvatar({ name, size }: { name: string; size: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const t = AVATAR_TONES[h % AVATAR_TONES.length];
  return (
    <span
      className="tr-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, background: t.bg, color: t.fg, fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(name)}
    </span>
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

/** The page colours the boards give a page with no cover (blue, sand, rose, lilac, green). */
const TINTS = ['#E3EFFA', '#F7ECD9', '#F3E3F0', '#E4E1F5', '#E6F2EA'];

/** A soft tint for a page with no cover, the same for a page every time. */
export function pageTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
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
  // the arrow sits 28 px below the card's top, level with the middle of the row
  const top = Math.max(8, Math.min(anchor.top + anchor.height / 2 - 28, window.innerHeight - 300));
  const text = page ? firstLines(page.markdown) : '';
  const colour = page && look.background !== 'white' ? PALETTE[look.background].page : pageTint(node.id);
  return createPortal(
    <div
      className="tr-hovercard docs-root"
      role="tooltip"
      data-testid="tree-hover-card"
      // the row sits 8 px inside the tree (and its 1 px border): the card's box starts 6 px past the tree's edge
      style={{ left: anchor.right + 9, top }}
    >
      <span className="tr-hc-arrow" style={{ top: Math.min(22, 22 + (anchor.top + anchor.height / 2 - 28 - top)) }} />
      <div className="tr-hc-box">
        <div
          className="tr-hc-cover"
          style={
            node.cover ? { backgroundImage: `url("${coverUrl(node.cover, resolveOrigin())}")` } : { background: colour }
          }
        >
          {!node.cover && icon?.kind === 'emoji' && <span className="tr-hc-emoji">{icon.value}</span>}
        </div>
        <div className="tr-hc-body">
          <div className="tr-hc-title">
            <PageIcon icon={node.icon} kind={node.kind} size={18} />
            <span>{node.title}</span>
          </div>
          <div className="tr-hc-tags">
            <StatusPill status={status} />
            {book && <BookTag />}
            <SuggestionCount count={node.suggestions} />
          </div>
          {page ? (
            text && <p className="tr-hc-text">{text}</p>
          ) : (
            <div className="skel" style={{ height: 30, borderRadius: 4, marginTop: 8 }} />
          )}
          {book && (
            <div className="tr-hc-progress">
              <div>
                <span>
                  {published} of {chapters.length} chapters published
                </span>
              </div>
              <div className="tr-hc-bar">
                <div style={{ width: `${chapters.length ? Math.round((published / chapters.length) * 100) : 0}%` }} />
              </div>
            </div>
          )}
          <div className="tr-hc-meta">
            {page && <EditorAvatar name={page.updatedBy} size={18} />}
            <span>
              {page ? `${displayName(page.updatedBy)} · ` : ''}
              {agoText(node.updatedAt)}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              {book ? `${chapters.length} chapters` : page ? `${readingMinutes(page.markdown)} min read` : ''}
            </span>
          </div>
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
