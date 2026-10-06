import { useEffect, useRef, type ReactNode } from 'react';
import type { DocsPage } from '../../types/docs';
import { pageStats } from '../../api/docsActions';
import { useBacklinksEx } from '../../api/docsActions';
import { useDocsVersions } from '../../api/docs';
import { Icon } from './Icon';
import { Avatar, displayName, fmtDate, fmtDateTime } from './docsShared';

interface PageInfoPopoverProps {
  page: DocsPage;
  onClose: () => void;
  /** Optional shortcuts behind the two links ("Page history" / "Referenced by"). */
  onOpenHistory?: () => void;
  onOpenReferences?: () => void;
}

const valueStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 600,
  color: '#1E2A22',
  lineHeight: 1.5,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
};
const muted: React.CSSProperties = { fontWeight: 500, color: '#5B6B60' };
const linkStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontWeight: 600,
  color: '#2E6F40',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 12.5,
};

function Row({ icon, label, last, children }: { icon: string; label: string; last?: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 0',
        borderBottom: last ? undefined : '1px solid #EEF3EF',
      }}
    >
      <span style={{ display: 'flex', color: '#9AA8A0', marginTop: 1, width: 16 }}>
        <Icon name={icon} size={15} strokeWidth={1.8} />
      </span>
      <span style={{ width: 104, flexShrink: 0, fontSize: 12.5, color: '#5B6B60' }}>{label}</span>
      <div style={valueStyle}>{children}</div>
    </div>
  );
}

export function PageInfoPopover({ page, onClose, onOpenHistory, onOpenReferences }: PageInfoPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stats = pageStats(page);
  const versions = useDocsVersions(page.id);
  const backlinks = useBacklinksEx(page.id);
  const crumbs = (page.path ?? []).map((p) => p.title);
  if (!crumbs.length || crumbs[crumbs.length - 1] !== page.title) crumbs.push(page.title);
  const tickets = Array.from(new Set(page.markdown.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []));
  const total = versions.data?.length;
  const words = stats?.words;
  const inbound = stats?.inboundLinks;
  const bl = backlinks.data;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="dk-menu docs-root"
      role="dialog"
      aria-label="Page info"
      style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', width: 440, zIndex: 60, padding: '6px 16px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22', flex: 1 }}>Page info</span>
        <span style={{ fontSize: 12, color: '#9AA8A0' }}>{crumbs.join(' › ')}</span>
      </div>
      <Row icon="i61" label="Created by">
        <Avatar name={page.createdBy} />
        {displayName(page.createdBy)}
        <span style={muted}>{fmtDate(page.createdAt, true)}</span>
      </Row>
      <Row icon="i15" label="Last edited">
        <Avatar name={page.updatedBy} />
        {displayName(page.updatedBy)}
        <span style={muted}>{fmtDateTime(page.updatedAt)}</span>
      </Row>
      <Row icon="i39" label="Version">
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>v{page.version}</span>
        <span style={muted}>
          {total ? `of ${total} · ` : ''}
          {page.status === 'published' ? 'Published' : 'Draft'}
        </span>
        {onOpenHistory && (
          <button type="button" style={linkStyle} onClick={() => { onClose(); onOpenHistory(); }}>
            Page history
          </button>
        )}
      </Row>
      <Row icon="i42" label="Words">
        {words ?? '–'}
        {words != null && <span style={muted}>about {Math.max(1, Math.round(words / 200))} min read</span>}
      </Row>
      <Row icon="i13" label="Linked tickets">
        {stats?.linkedTickets ?? tickets.length}
        {tickets.map((k) => (
          <span key={k} className="dk-chip dk-chip-ticket">
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#9AA8A0', flexShrink: 0, display: 'inline-block' }} />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{k}</span>
          </span>
        ))}
      </Row>
      <Row icon="i11" label="Inbound links" last>
        {inbound ?? '–'}
        {bl && (
          <span style={muted}>
            {bl.pages.length} {bl.pages.length === 1 ? 'page' : 'pages'}, {bl.tickets.length}{' '}
            {bl.tickets.length === 1 ? 'ticket' : 'tickets'}
          </span>
        )}
        {onOpenReferences && (
          <button type="button" style={linkStyle} onClick={() => { onClose(); onOpenReferences(); }}>
            Referenced by
          </button>
        )}
      </Row>
    </div>
  );
}
