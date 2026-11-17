import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ticket } from '../types';
import { useDocsTree } from '../api/docs';
import type { RecycleEntry } from '../types/docsActions';
import { BinRow, PageBinRow, useDocsRecycle } from './docs/DocsRecycleSection';
import { EmptyBinDialog, parentEntryOf, PurgeDialog, RestoreWhereDialog } from './docs/tree/RecycleBinParts';
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
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  // pages picked for Restore / Delete forever of several, the pages a Delete forever asks about, the page whose
  // parent is gone (where should it go?)
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [purgeFor, setPurgeFor] = useState<RecycleEntry[] | null>(null);
  const [whereFor, setWhereFor] = useState<RecycleEntry | null>(null);
  const [phone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 600);
  const tree = useDocsTree(whereFor ? (projectId ?? '') : '');
  const panelRef = useRef<HTMLDivElement>(null);
  const docs = useDocsRecycle(projectId ?? '', (id) => {
    onOpenDocsPage?.(id);
    handleClose();
  });
  const pages = useMemo(() => (projectId ? docs.entries : []), [projectId, docs.entries]);
  const pickedPages = pages.filter((p) => picked.has(p.id));

  function restore(entry: RecycleEntry) {
    if (entry.parentDeleted) setWhereFor(entry);
    else void docs.restoreEntry(entry);
  }

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
      // Esc in one of its dialogs closes only that dialog
      if (
        e.key === 'Escape' &&
        !document.querySelector('[role="dialog"][aria-modal="true"]:not([aria-label="Recycle Bin"])')
      )
        handleClose();
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

        {pickedPages.length > 0 && (
          <div className="tr-binbar" role="toolbar" aria-label="Selected pages" data-testid="bin-selection-bar">
            <span style={{ flex: 1 }}>{pickedPages.length} selected</span>
            <button
              type="button"
              className="st-btn st-btn-sm"
              disabled={docs.bulkBusy}
              onClick={() => void docs.restoreMany(pickedPages).then((ok) => ok && setPicked(new Set()))}
            >
              Restore {pickedPages.length}
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm st-btn-danger-outline"
              disabled={docs.bulkBusy}
              onClick={() => setPurgeFor(pickedPages)}
            >
              Delete forever
            </button>
            <button type="button" className="st-btn st-btn-sm" onClick={() => setPicked(new Set())}>
              Cancel
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
            <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 13, color: '#5B6B60' }}>
              <p style={{ margin: 0, fontWeight: 700, color: '#1E2A22' }}>{empty(filter)}</p>
              {filter !== 'tickets' && (
                <p style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
                  Pages you delete wait here for 30 days. Restoring brings back the page, its child pages and its files.
                </p>
              )}
            </div>
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
                  confirming={false}
                  error={docs.rowError?.id === entry.id ? docs.rowError.message : null}
                  onRestore={() => restore(entry)}
                  onAskPurge={() => setPurgeFor([entry])}
                  onCancelPurge={() => setPurgeFor(null)}
                  onPurge={() => setPurgeFor([entry])}
                  selected={picked.has(entry.id)}
                  onToggleSelect={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) next.delete(entry.id);
                      else next.add(entry.id);
                      return next;
                    })
                  }
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
          Pages are deleted forever 30 days after they were removed; the last week turns amber and the last three days
          red. If a restored page's parent is gone, you choose where it comes back (the top level unless you pick a
          page). Tickets marked as Won’t Do stay here until restored.
        </div>
        {confirmEmpty && (
          <EmptyBinDialog
            entries={pages}
            tickets={tickets.length}
            phone={phone}
            busy={docs.emptying}
            onClose={() => setConfirmEmpty(false)}
            onConfirm={(scope) => void docs.emptyBin(scope).then((ok) => ok && setConfirmEmpty(false))}
          />
        )}
        {purgeFor && (
          <PurgeDialog
            entries={purgeFor}
            phone={phone}
            busy={docs.bulkBusy || purgeFor.some((e) => docs.busyId === e.id)}
            onClose={() => setPurgeFor(null)}
            onConfirm={() => {
              const list = purgeFor;
              const run = list.length === 1 ? docs.purgeEntry(list[0]) : docs.purgeMany(list);
              void run.then((ok) => {
                if (!ok) return;
                setPurgeFor(null);
                setPicked((prev) => new Set([...prev].filter((id) => !list.some((e) => e.id === id))));
              });
            }}
          />
        )}
        {whereFor && (
          <RestoreWhereDialog
            entry={whereFor}
            parent={parentEntryOf(whereFor, pages)}
            nodes={tree.data ?? []}
            phone={phone}
            onClose={() => setWhereFor(null)}
            onRestore={(where) => {
              const entry = whereFor;
              setWhereFor(null);
              void docs.restoreEntry(entry, where);
            }}
          />
        )}
      </div>
    </div>
  );
}
