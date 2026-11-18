/**
 * The rows of quick open, "Go to page…" (RichDocsLinks A 1-6): 46 px rows (54 on a tablet, 58 on a phone, set in links.css) with a 28 px tile (the page's icon, or a
 * heading, ticket, create or search mark), the title, the page's status dot, where it is, and Enter on the chosen
 * row. Group heads are 11 px capitals.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { DocsTreeNode } from '../../../types/docs';
import { Kbd } from '../searchShared';
import { PageIcon, StatusDot } from '../tree/treeParts';
import { rowStatus } from '../tree/treeModel';

/** A group head ("Recent pages", "Pages · 1"). */
export const QO_HEAD: CSSProperties = {
  padding: '10px 18px 4px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: '#5B6B60',
};

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  padding: '5px 14px',
  borderRadius: 9,
  margin: '0 6px',
  boxSizing: 'border-box',
  cursor: 'pointer',
};

const TITLE: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: '#1E2A22',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const WHERE: CSSProperties = {
  fontSize: 12,
  color: '#5B6B60',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 190,
  flex: 'none',
};

const MARKS: Record<'heading' | 'ticket' | 'create' | 'search', { bg: string; fg: string; svg: string }> = {
  heading: { bg: '#E6F2EA', fg: '#2E6F40', svg: '<path d="M5 9h14M4 15h14M10 4L8 20M16 4l-2 16"/>' },
  ticket: {
    bg: '#E3EFFA',
    fg: '#2F6FB0',
    svg: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8 12l3 3 5-6"/>',
  },
  create: { bg: '#E6F2EA', fg: '#2E6F40', svg: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>' },
  search: {
    bg: '#E3EFFA',
    fg: '#2F6FB0',
    svg: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 15h18M9 5v14"/>',
  },
};

/**
 * The 28 px tile of a row: a page's icon on #F1F6F2 (white on the chosen row), or a mark in its colours.
 * @param props.node - The page (its icon).
 * @param props.mark - A mark instead of a page icon.
 * @param props.on - The row is the chosen one.
 */
export function QoTile({ node, mark, on }: { node?: DocsTreeNode; mark?: keyof typeof MARKS; on?: boolean }) {
  const m = mark ? MARKS[mark] : null;
  return (
    <span
      className="qo-tile"
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: m ? m.bg : on ? '#FFFFFF' : '#F1F6F2',
        color: m?.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      {m ? (
        <svg
          aria-hidden="true"
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: m.svg }}
        />
      ) : (
        <PageIcon icon={node?.icon} kind={node?.kind} size={16} />
      )}
    </span>
  );
}

/**
 * One row of quick open.
 * @param props.on - The chosen row (#E6F2EA, Enter shown).
 * @param props.dim - The page you are on: dimmed, not hidden.
 * @param props.tile - The row's tile.
 * @param props.title - Its title (with the matched words marked).
 * @param props.node - The page, for its status dot.
 * @param props.where - Where it is ("Architecture", "Top level", "Requirements › Billing").
 * @param props.after - What follows `where` (a ticket chip, "this page").
 */
export function QoRow({
  on,
  dim,
  tile,
  title,
  node,
  where,
  after,
  testId,
  rowProps,
}: {
  on: boolean;
  dim?: boolean;
  tile: ReactNode;
  title: ReactNode;
  node?: DocsTreeNode;
  where?: ReactNode;
  after?: ReactNode;
  testId?: string;
  rowProps: Record<string, unknown>;
}) {
  return (
    <div style={dim ? { opacity: 0.55 } : undefined}>
      <div
        {...rowProps}
        data-testid={testId ?? 'qo-row'}
        className={`fx-row qo-row${on ? ' fx-row-on' : ''}`}
        style={ROW}
      >
        {tile}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={TITLE}>{title}</div>
        </div>
        {node && <StatusDot status={rowStatus(node, new Date())} slot={false} />}
        {where != null && where !== '' && <span style={WHERE}>{where}</span>}
        {after}
        {on && (
          <span className="qo-enter" style={{ marginLeft: 6, flex: 'none' }}>
            <Kbd>Enter</Kbd>
          </span>
        )}
      </div>
    </div>
  );
}
