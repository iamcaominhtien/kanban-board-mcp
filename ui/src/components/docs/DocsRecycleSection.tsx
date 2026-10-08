import { useState, type ReactNode } from 'react';
import { docsErrorDetail, usePurgePage, useRestorePage } from '../../api/docs';
import { useEmptyRecycleBin, useRecycleEntries } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import type { RecycleEntry } from '../../types/docsActions';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { agoText, displayName, plural } from './docsShared';

const errMsg = (err: unknown) => docsErrorDetail(err)?.message ?? extractError(err);

/** Data + actions for the deleted-pages half of the Recycle Bin. */
export function useDocsRecycle(projectId: string, onOpenPage?: (pageId: string) => void) {
  const toast = useToast();
  const query = useRecycleEntries(projectId);
  const restore = useRestorePage(projectId);
  const purge = usePurgePage(projectId);
  const empty = useEmptyRecycleBin(projectId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  async function restoreEntry(entry: RecycleEntry) {
    setBusyId(entry.id);
    setRowError(null);
    try {
      const res = await restore.mutateAsync(entry.id);
      const children = res.restoredPages - 1;
      toast.showToast({
        variant: 'success',
        title: `Restored “${entry.title}”${children > 0 ? ` and ${plural(children, 'child page')}` : ''}`,
        message: res.movedToTopLevel
          ? `Its parent is still deleted, so “${entry.title}” returned at the top level.`
          : 'Back in the tree, in its old position.',
        action: onOpenPage ? { label: 'Open', onClick: () => onOpenPage(entry.id) } : undefined,
      });
    } catch (err) {
      setRowError({ id: entry.id, message: errMsg(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function purgeEntry(entry: RecycleEntry): Promise<boolean> {
    setBusyId(entry.id);
    setRowError(null);
    try {
      await purge.mutateAsync(entry.id);
      toast.success(`Deleted “${entry.title}” forever`);
      return true;
    } catch (err) {
      setRowError({ id: entry.id, message: errMsg(err) });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function emptyBin(): Promise<boolean> {
    try {
      await empty.mutateAsync();
      toast.success('Recycle Bin emptied', 'Deleted pages were removed forever.');
      return true;
    } catch (err) {
      toast.error("Couldn't empty the bin", errMsg(err));
      return false;
    }
  }

  return {
    entries: query.data ?? [],
    isLoading: query.isLoading,
    error: query.isError ? errMsg(query.error) : null,
    busyId,
    rowError,
    emptying: empty.isPending,
    restoreEntry,
    purgeEntry,
    emptyBin,
  };
}

/** One row of the combined Recycle Bin list (page or ticket). */
export function BinRow({
  kind,
  title,
  meta,
  lines,
  actions,
  footer,
  first,
  last,
}: {
  kind: 'page' | 'ticket';
  title: string;
  /** Second line (location / ticket key). */
  meta: ReactNode;
  /** Muted lines under it. */
  lines: ReactNode[];
  actions: ReactNode;
  footer?: ReactNode;
  first?: boolean;
  last?: boolean;
}) {
  const isPage = kind === 'page';
  return (
    <div
      className="bin-row"
      data-testid={`bin-row-${kind}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 16px',
        borderBottom: last ? undefined : '1px solid #EEF3EF',
      }}
      data-first={first ? '1' : undefined}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: isPage ? '#DCEEE1' : '#EEF3EF',
          color: isPage ? '#2E6F40' : '#5B6B60',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon name={isPage ? 'i00' : 'i13'} size={16} strokeWidth={1.8} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="mc-chip"
            style={
              isPage
                ? { background: '#DCEEE1', color: '#1F5A31', height: 20 }
                : { background: '#F1F3F1', color: '#3A4A3E', height: 20 }
            }
          >
            {isPage ? 'Page' : 'Ticket'}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>{title}</span>
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5B6B60', flexWrap: 'wrap' }}
        >
          {meta}
        </div>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: 11.5, color: '#9AA8A0' }}>
            {l}
          </div>
        ))}
        {footer}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingTop: 2 }}>{actions}</div>
    </div>
  );
}

/** The deleted-page row, with its restore note and Restore / Delete forever actions. */
export function PageBinRow({
  entry,
  busy,
  confirming,
  error,
  first,
  last,
  onRestore,
  onAskPurge,
  onCancelPurge,
  onPurge,
}: {
  entry: RecycleEntry;
  busy: boolean;
  confirming: boolean;
  error?: string | null;
  first?: boolean;
  last?: boolean;
  onRestore: () => void;
  onAskPurge: () => void;
  onCancelPurge: () => void;
  onPurge: () => void;
}) {
  const extra = entry.pageCount - 1;
  let note: ReactNode = null;
  if (entry.parentDeleted && entry.parentTitle) {
    note = (
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '9px 12px',
          borderRadius: 10,
          background: '#E8F1FB',
          border: '1px solid #B9D3EE',
          fontSize: 12.5,
          lineHeight: 1.5,
          color: '#1E2A22',
          marginTop: 4,
        }}
      >
        <span style={{ color: '#2F6FB0', display: 'flex', marginTop: 1 }}>
          <Icon name="i28" size={16} strokeWidth={1.9} />
        </span>
        <span>
          <b style={{ fontWeight: 700 }}>“{entry.title}” will return at the top level.</b> Its parent,{' '}
          {entry.parentTitle}, is still in the Recycle Bin. Restore {entry.parentTitle} first to put it back in place.
        </span>
      </div>
    );
  } else if (extra > 0) {
    note = (
      <div style={{ fontSize: 12, lineHeight: 1.45, color: '#5B6B60', marginTop: 2 }}>
        Restoring brings back all {entry.pageCount} pages in the same order.
      </div>
    );
  } else if (entry.parentTitle) {
    note = (
      <div style={{ fontSize: 12, lineHeight: 1.45, color: '#5B6B60', marginTop: 2 }}>
        Restores under {entry.parentTitle}.
      </div>
    );
  }

  return (
    <BinRow
      kind="page"
      title={entry.title}
      first={first}
      last={last}
      meta={
        <>
          <Icon name="i00" size={12} strokeWidth={1.8} />
          {entry.parentTitle ?? 'Top level'}
          {extra > 0 && ` · with ${plural(extra, 'child page')}`}
        </>
      }
      lines={[
        `${displayName(entry.deletedBy)} · ${agoText(entry.deletedAt)} · ${entry.daysLeft} ${entry.daysLeft === 1 ? 'day' : 'days'} left`,
      ]}
      footer={
        <>
          {note}
          {confirming && (
            <div role="alert" style={{ fontSize: 12.5, color: '#A5321E', marginTop: 4 }}>
              Delete “{entry.title}”{extra > 0 ? ` and its ${plural(extra, 'child page')}` : ''} forever? This can’t be
              undone.
            </div>
          )}
          {error && (
            <div role="alert" style={{ fontSize: 12.5, color: '#A5321E', marginTop: 4 }}>
              {error}
            </div>
          )}
        </>
      }
      actions={
        confirming ? (
          <>
            <button type="button" className="st-btn st-btn-sm" onClick={onCancelPurge}>
              Cancel
            </button>
            <button type="button" className="st-btn st-btn-sm st-btn-danger" disabled={busy} onClick={onPurge}>
              {busy ? 'Deleting…' : 'Delete forever'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="st-btn st-btn-sm" disabled={busy} onClick={onRestore}>
              <Icon name="i19" size={13} strokeWidth={2} />
              {busy ? 'Restoring…' : 'Restore'}
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm st-btn-danger-outline"
              disabled={busy}
              onClick={onAskPurge}
            >
              <Icon name="i12" size={13} />
              Delete forever
            </button>
          </>
        )
      }
    />
  );
}

/** Standalone list of deleted pages (the combined panel in RecycleBin.tsx merges these with tickets). */
export function DocsRecycleSection({
  projectId,
  onOpenPage,
}: {
  projectId: string;
  onOpenPage?: (pageId: string) => void;
}) {
  const r = useDocsRecycle(projectId, onOpenPage);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <section aria-label="Deleted docs pages">
      {r.isLoading && <p style={{ padding: 16, color: '#5B6B60', fontSize: 13 }}>Loading…</p>}
      {r.error && (
        <p role="alert" style={{ padding: 16, color: '#A5321E', fontSize: 13 }}>
          {r.error}
        </p>
      )}
      {!r.isLoading && r.entries.length === 0 && (
        <p style={{ padding: 16, color: '#5B6B60', fontSize: 13 }}>No deleted pages.</p>
      )}
      {r.entries.map((entry, i) => (
        <PageBinRow
          key={entry.id}
          entry={entry}
          busy={r.busyId === entry.id}
          confirming={confirmId === entry.id}
          error={r.rowError?.id === entry.id ? r.rowError.message : null}
          last={i === r.entries.length - 1}
          onRestore={() => void r.restoreEntry(entry)}
          onAskPurge={() => setConfirmId(entry.id)}
          onCancelPurge={() => setConfirmId(null)}
          onPurge={() => void r.purgeEntry(entry).then((ok) => ok && setConfirmId(null))}
        />
      ))}
    </section>
  );
}
