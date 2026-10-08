import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ticket } from '../types';
import { BinRow, PageBinRow, useDocsRecycle } from './docs/DocsRecycleSection';
import { Icon } from './docs/Icon';
import { CloseButton } from './docs/docsShared';
import { relativeTime } from '../utils/relativeTime';
import styles from './RecycleBin.module.css';

interface RecycleBinProps {
  tickets: Ticket[];
  projectId?: string;
  onRestore: (ticketId: string) => void;
  onClose: () => void;
  /** Opens a restored docs page (the "Open" action on the restore toast). */
  onOpenDocsPage?: (pageId: string) => void;
}

type Filter = 'all' | 'pages' | 'tickets';

/**
 * Combined Recycle Bin for "Won't do" tickets and deleted pages.
 * @param props.tickets - "Won't do" tickets to list.
 * @param props.projectId - Project whose deleted docs pages are listed too.
 * @param props.onRestore - Called with the ticket id to restore.
 * @param props.onClose - Called to dismiss the bin.
 * @param props.onOpenDocsPage - Called with a page id when "Open" on the restore toast is used.
 */
export function RecycleBin({ tickets, projectId, onRestore, onClose, onOpenDocsPage }: RecycleBinProps) {
  const [visible, setVisible] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const docs = useDocsRecycle(projectId ?? '', (id) => {
    onOpenDocsPage?.(id);
    handleClose();
  });
  const pages = projectId ? docs.entries : [];

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    panelRef.current?.focus();
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const items = useMemo(() => {
    const list = [
      ...pages.map((p) => ({ kind: 'page' as const, at: new Date(p.deletedAt).getTime(), page: p })),
      ...tickets.map((t) => ({ kind: 'ticket' as const, at: new Date(t.updatedAt).getTime() || 0, ticket: t })),
    ];
    return list.sort((a, b) => b.at - a.at);
  }, [pages, tickets]);
  const shown = items.filter((i) => filter === 'all' || (filter === 'pages' ? i.kind === 'page' : i.kind === 'ticket'));
  const empty = (kind: Filter) =>
    kind === 'pages'
      ? 'No deleted pages.'
      : kind === 'tickets'
        ? 'No tickets marked as "Won\'t Do".'
        : 'The Recycle Bin is empty.';

  const tab = (f: Filter, label: string, n: number) => (
    <button
      type="button"
      className={`dk-tabs-btn ${filter === f ? 'dk-tabs-btn-on' : ''}`}
      aria-pressed={filter === f}
      onClick={() => setFilter(f)}
    >
      {label} · {n}
    </button>
  );

  return (
    <div className={`${styles.overlay} docs-root ${visible ? styles.overlayVisible : ''}`} onClick={handleClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`${styles.panel} ${visible ? styles.panelVisible : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Recycle Bin"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid #E3E8E5',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22', flex: 1 }}>Recycle Bin</span>
          {projectId && (
            <button
              type="button"
              className="st-btn st-btn-sm st-btn-danger-outline"
              disabled={pages.length === 0 || docs.emptying}
              onClick={() => setConfirmEmpty(true)}
            >
              Empty bin
            </button>
          )}
          <CloseButton onClick={handleClose} />
        </div>

        {confirmEmpty && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 20px',
              background: '#FBE7E4',
              borderBottom: '1px solid #F0C4B8',
              fontSize: 12.5,
              color: '#1E2A22',
            }}
          >
            <span style={{ flex: 1 }}>
              Delete {pages.length} deleted {pages.length === 1 ? 'page' : 'pages'} forever? Tickets are not affected.
              This can’t be undone.
            </span>
            <button type="button" className="st-btn st-btn-sm" onClick={() => setConfirmEmpty(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm st-btn-danger"
              disabled={docs.emptying}
              onClick={() => void docs.emptyBin().then((ok) => ok && setConfirmEmpty(false))}
            >
              {docs.emptying ? 'Emptying…' : 'Empty bin'}
            </button>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 20px',
            borderBottom: '1px solid #EEF3EF',
            flexShrink: 0,
          }}
        >
          {tab('all', 'All', items.length)}
          {tab('pages', 'Pages', pages.length)}
          {tab('tickets', 'Tickets', tickets.length)}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: '#9AA8A0' }}>Newest first</span>
        </div>

        <div className={styles.list}>
          {docs.error && projectId && !/disabled/i.test(docs.error) && (
            <p role="alert" style={{ margin: 0, padding: '10px 20px', fontSize: 12.5, color: '#A5321E' }}>
              {docs.error}
            </p>
          )}
          {shown.length === 0 && (
            <p style={{ margin: 0, padding: '28px 20px', textAlign: 'center', fontSize: 13, color: '#5B6B60' }}>
              {empty(filter)}
            </p>
          )}
          {shown.map((it, i) => {
            const last = i === shown.length - 1;
            if (it.kind === 'page') {
              const entry = it.page;
              return (
                <PageBinRow
                  key={`p-${entry.id}`}
                  entry={entry}
                  last={last}
                  first={i === 0}
                  busy={docs.busyId === entry.id}
                  confirming={confirmId === entry.id}
                  error={docs.rowError?.id === entry.id ? docs.rowError.message : null}
                  onRestore={() => void docs.restoreEntry(entry)}
                  onAskPurge={() => setConfirmId(entry.id)}
                  onCancelPurge={() => setConfirmId(null)}
                  onPurge={() => void docs.purgeEntry(entry).then((ok) => ok && setConfirmId(null))}
                />
              );
            }
            const t = it.ticket;
            return (
              <BinRow
                key={`t-${t.id}`}
                kind="ticket"
                title={t.title}
                last={last}
                first={i === 0}
                meta={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: '#9AA8A0',
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#5B6B60' }}>
                      {t.id}
                    </span>
                  </span>
                }
                lines={[
                  t.wontDoReason ? <>Won’t do: {t.wontDoReason}</> : 'Marked as Won’t Do',
                  t.updatedAt ? relativeTime(t.updatedAt) : '',
                ].filter(Boolean)}
                actions={
                  <button type="button" className="st-btn st-btn-sm" onClick={() => onRestore(t.id)}>
                    <Icon name="i19" size={13} strokeWidth={2} />
                    Restore
                  </button>
                }
              />
            );
          })}
        </div>

        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #E3E8E5',
            background: '#FBFCFB',
            fontSize: 12,
            lineHeight: 1.5,
            color: '#5B6B60',
            flexShrink: 0,
          }}
        >
          Pages are deleted forever 30 days after they were removed. If a restored page's parent is gone, it comes back
          at the top level. Tickets marked as Won’t Do stay here until restored.
        </div>
      </div>
    </div>
  );
}
