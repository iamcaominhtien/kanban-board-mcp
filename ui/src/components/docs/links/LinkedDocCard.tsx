/**
 * A card of a ticket's Linked docs (RichDocsLinks H 47): 196 px wide, a 56 px cover with the page icon, the page (and
 * the heading or block the link points at: "Rate limiting › Limits"), where it lives, the words of that heading or
 * block, and why it is linked ("Mentioned in description", "Manual link", "From docs"). Hovering shows Side panel and,
 * for a manual link, Remove.
 */

import { useState, type CSSProperties } from 'react';
import { KindGlyph } from './BlockKind';
import { PageIcon } from '../tree/treeParts';
import './links.css';

/** The cover tints of the cards, chosen by the page (the board's ⏱️ blue, 📋 green, 📓 sand…). */
const COVERS = ['#E3EFFA', '#E6F2EA', '#F7ECD9', '#F0E8FA', '#FDEEDC', '#EEF0EF'];

/** The cover tint of a page: the same page always gets the same one. */
export function coverOf(pageId: string): string {
  let h = 0;
  for (let i = 0; i < pageId.length; i++) h = (h * 31 + pageId.charCodeAt(i)) >>> 0;
  return COVERS[h % COVERS.length];
}

const ACTION: CSSProperties = {
  font: 'inherit',
  height: 26,
  borderRadius: 7,
  background: '#fff',
  border: '1px solid #DCE3DE',
  boxShadow: '0 2px 8px rgba(30,42,34,.12)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  fontSize: 11.5,
  fontWeight: 700,
  color: '#1E2A22',
  cursor: 'pointer',
  padding: 0,
  boxSizing: 'border-box',
};

const LOCK = (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const LINK = (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

/** What a card shows. */
export interface LinkedDocCardData {
  pageId: string;
  title: string;
  icon?: string | null;
  /** "Architecture", or "Top level". */
  where: string;
  /** The page is published (green dot) or a draft (amber). */
  published: boolean;
  /** The heading or block the link points at. */
  target?: { kind: string; label: string } | null;
  /** The words of that heading or block, or the context of the mention. */
  excerpt?: string | null;
  /** Why it is linked, one line per way. */
  origins: { label: string; manual: boolean }[];
  /** `canvas`: a canvas shown in the ticket. */
  canvas?: boolean;
}

/**
 * One linked doc.
 * @param props.doc - What the card shows.
 * @param props.testId - The card's test id (`ticket-doc-mention`, `ticket-doc-manual`, `ticket-doc-page`).
 * @param props.onOpen - Opens the page (at the block) in the side panel.
 * @param props.onRemove - Removes a manual link; absent for a mention (remove the mention to unlink).
 */
export function LinkedDocCard({
  doc,
  testId,
  onOpen,
  onRemove,
}: {
  doc: LinkedDocCardData;
  testId: string;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const title = doc.target ? `${doc.title} › ${doc.target.label}` : doc.title;
  return (
    <div
      className={`tdoc tdoc-card ${onRemove ? 'tdoc-manual' : ''}`}
      data-testid={testId}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(false)}
      style={{
        position: 'relative',
        width: 196,
        boxSizing: 'border-box',
        border: `1px solid ${hover ? '#9CCBA8' : '#DCE3DE'}`,
        borderRadius: 12,
        background: '#fff',
        overflow: 'hidden',
        flex: 'none',
        boxShadow: hover ? '0 10px 26px rgba(30,42,34,.16)' : undefined,
        transition: 'box-shadow .12s, border-color .12s',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${title}`}
        className="tdoc-main"
        style={{
          display: 'block',
          width: '100%',
          padding: 0,
          border: 'none',
          background: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <div
          data-testid="tdoc-cover"
          className="tdoc-cover"
          style={{
            height: 56,
            background: coverOf(doc.pageId),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 23,
          }}
        >
          <PageIcon icon={doc.icon} size={23} />
        </div>
        <div className="tdoc-body" style={{ padding: '10px 12px 11px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 15, display: 'inline-flex' }}>
              {doc.target && doc.target.kind !== 'heading' ? (
                <KindGlyph kind={doc.target.kind} size={14} />
              ) : (
                <PageIcon icon={doc.icon} size={15} />
              )}
            </span>
            <span
              data-testid="tdoc-title"
              style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25, flex: 1, minWidth: 0, color: '#1E2A22' }}
            >
              {title}
            </span>
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11.5, color: '#5B6B60' }}
          >
            <span
              title={doc.published ? 'Published' : 'Draft'}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: doc.published ? '#2E6F40' : '#C98A1B',
                flex: 'none',
              }}
            />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.where}
            </span>
          </div>
          {doc.excerpt && (
            <div
              data-testid="tdoc-excerpt"
              className="tdoc-excerpt"
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: '#3A4A3E',
                marginTop: 7,
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {doc.excerpt}
            </div>
          )}
          {doc.origins.map((o) => (
            <div
              key={o.label}
              data-testid="ticket-doc-origin"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                marginTop: 8,
                fontSize: 11,
                fontWeight: 600,
                color: '#5B6B60',
              }}
            >
              {o.manual ? LINK : LOCK}
              {o.label}
            </div>
          ))}
        </div>
      </button>
      <div
        className="tdoc-acts"
        style={{
          position: 'absolute',
          right: 8,
          top: 8,
          display: hover ? 'flex' : 'none',
          gap: 4,
          zIndex: 3,
        }}
      >
        <button
          type="button"
          data-testid="tdoc-side-panel"
          className="tdoc-side"
          style={{ ...ACTION, padding: '0 10px' }}
          onClick={onOpen}
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
          Side panel
        </button>
        {onRemove && (
          <button
            type="button"
            className="tdoc-remove"
            aria-label="Remove link"
            title="Remove link"
            style={{ ...ACTION, width: 26, color: '#C4432A' }}
            onClick={onRemove}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.6}
              aria-hidden="true"
            >
              <path d="M6 6L18 18" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
