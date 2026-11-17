import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { client } from '../../api/client';
import { docsErrorDetail, docsKeys, usePurgePage, useRestorePage } from '../../api/docs';
import { useEmptyRecycleBin, useRecycleEntries } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import type { RecycleEntry } from '../../types/docsActions';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { agoText, displayName, plural } from './docsShared';
import { daysLeftText, daysLeftTone, pagesToEmpty, type EmptyScope, type RestoreWhere } from './tree/RecycleBinParts';

const errMsg = (err: unknown) => docsErrorDetail(err)?.message ?? extractError(err);

/**
 * Data + actions for the deleted-pages half of the Recycle Bin.
 * @param projectId - Project whose deleted pages are managed.
 * @param onOpenPage - Called with a page id for the "Open" action after a restore.
 * @returns Entries with loading and error state, per-row busy and error info, and restore, purge and empty-bin actions.
 */
export function useDocsRecycle(projectId: string, onOpenPage?: (pageId: string) => void) {
  const toast = useToast();
  const query = useRecycleEntries(projectId);
  const restore = useRestorePage(projectId);
  const purge = usePurgePage(projectId);
  const empty = useEmptyRecycleBin(projectId);
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  /**
   * Restores a page with its child pages. A page whose parent is gone comes back at the top level, under a page
   * chosen for it, or under its parent restored first (`where`).
   */
  async function restoreEntry(entry: RecycleEntry, where?: RestoreWhere) {
    setBusyId(entry.id);
    setRowError(null);
    try {
      if (where?.kind === 'parent-first') await restore.mutateAsync(where.parentId);
      const res = await restore.mutateAsync(entry.id);
      if (where?.kind === 'page')
        await client.post(`/docs/pages/${entry.id}/move`, { parentId: where.parentId, beforeId: null, afterId: null });
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
      const children = res.restoredPages - 1;
      toast.showToast({
        variant: 'success',
        title: `Restored “${entry.title}”${children > 0 ? ` and ${plural(children, 'child page')}` : ''}`,
        message:
          where?.kind === 'page'
            ? 'Back in the tree, under the page you chose.'
            : where?.kind === 'parent-first'
              ? `Back in the tree, under ${entry.parentTitle}.`
              : res.movedToTopLevel
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

  /** Restores several pages, each in its own place (a page whose parent is gone comes back at the top level). */
  async function restoreMany(list: RecycleEntry[]): Promise<boolean> {
    setBulkBusy(true);
    let done = 0;
    try {
      for (const e of list) {
        await restore.mutateAsync(e.id);
        done += 1;
      }
      toast.success(`Restored ${plural(done, 'page')}`, 'Each one is back in its own place.');
      return true;
    } catch (err) {
      toast.error(done ? `Restored ${done} of ${list.length} pages` : "Couldn't restore the pages", errMsg(err));
      return false;
    } finally {
      setBulkBusy(false);
    }
  }

  /** Deletes several pages forever. */
  async function purgeMany(list: RecycleEntry[]): Promise<boolean> {
    setBulkBusy(true);
    let done = 0;
    try {
      for (const e of list) {
        await purge.mutateAsync(e.id);
        done += 1;
      }
      toast.success(`Deleted ${plural(done, 'page')} forever`);
      return true;
    } catch (err) {
      toast.error(done ? `Deleted ${done} of ${list.length} pages` : "Couldn't delete the pages", errMsg(err));
      return false;
    } finally {
      setBulkBusy(false);
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

  async function emptyBin(scope: EmptyScope = 'all'): Promise<boolean> {
    // only the older pages: one by one (the server empties the whole bin or nothing)
    if (scope === 'older') return purgeMany(pagesToEmpty(query.data ?? [], 'older'));
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
    emptying: empty.isPending || bulkBusy,
    bulkBusy,
    restoreEntry,
    restoreMany,
    purgeEntry,
    purgeMany,
    emptyBin,
  };
}

/**
 * One row of the combined Recycle Bin list (page or ticket).
 * @param props.kind - Whether the row is a deleted page or a ticket.
 * @param props.meta - Second line (location or ticket key).
 * @param props.lines - Muted lines under the meta line.
 * @param props.actions - Action buttons on the right.
 * @param props.footer - Extra content under the row.
 * @param props.first - First row of the list (rounded top corners).
 * @param props.last - Last row of the list (rounded bottom corners).
 */
export function BinRow({
  kind,
  title,
  meta,
  lines,
  actions,
  footer,
  first,
  last,
  pinned,
  check,
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
  /** Keep the actions visible (a confirmation or a request is in progress). */
  pinned?: boolean;
  /** A checkbox before the row (several pages picked). */
  check?: ReactNode;
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
      data-pinned={pinned ? '1' : undefined}
    >
      {check}
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
      <div
        className="bin-actions"
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingTop: 2 }}
      >
        {actions}
      </div>
    </div>
  );
}

/** "API, Data model" / "API, Data model, +2 more": the pages deleted with a parent. */
function listTitles(titles: string[], total: number): string {
  const shown = titles.slice(0, 3);
  const hidden = total - shown.length;
  return hidden > 0 ? `${shown.join(', ')}, +${hidden} more` : shown.join(', ');
}

/**
 * The deleted-page row, with its restore note and Restore / Delete forever actions.
 * @param props.entry - Deleted page entry.
 * @param props.busy - A restore or purge for this row is running.
 * @param props.confirming - Show the "Delete forever" confirmation.
 * @param props.error - Error message from the last action on this row.
 * @param props.first - First row of the list (rounded top corners).
 * @param props.last - Last row of the list (rounded bottom corners).
 * @param props.onRestore - Called to restore the page.
 * @param props.onAskPurge - Called to ask for confirmation before deleting forever.
 * @param props.onCancelPurge - Called to cancel the confirmation.
 * @param props.onPurge - Called to delete the page permanently.
 */
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
  selected,
  onToggleSelect,
}: {
  entry: RecycleEntry;
  busy: boolean;
  confirming: boolean;
  /** Picked for Restore or Delete forever of several pages; absent: no checkbox. */
  selected?: boolean;
  onToggleSelect?: () => void;
  error?: string | null;
  first?: boolean;
  last?: boolean;
  onRestore: () => void;
  onAskPurge: () => void;
  onCancelPurge: () => void;
  onPurge: () => void;
}) {
  const extra = entry.pageCount - 1;
  const tone = daysLeftTone(entry.daysLeft);
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
      pinned={confirming || busy}
      meta={
        <>
          <Icon name="i00" size={12} strokeWidth={1.8} />
          <span style={{ minWidth: 0 }}>
            {entry.parentTitle ?? 'Top level'}
            {extra > 0 &&
              ` · with ${plural(extra, 'child page')}${entry.childTitles?.length ? ` (${listTitles(entry.childTitles, extra)})` : ''}`}
          </span>
        </>
      }
      lines={[
        <>
          {displayName(entry.deletedBy)} · {agoText(entry.deletedAt)} ·{' '}
          <span
            className="tr-days"
            style={{ color: tone.color, fontWeight: tone.tone === 'grey' ? 500 : 700 }}
            data-testid="bin-days-left"
            data-tone={tone.tone}
          >
            {daysLeftText(entry.daysLeft)}
          </span>
        </>,
      ]}
      check={
        onToggleSelect ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            aria-label={`Select ${entry.title}`}
            style={{ accentColor: '#2E6F40', width: 16, height: 16, marginTop: 8 }}
          />
        ) : undefined
      }
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

/**
 * Standalone list of deleted pages (the combined panel in RecycleBin.tsx merges these with tickets).
 * @param props.projectId - Project whose deleted pages are listed.
 * @param props.onOpenPage - Called with a page id for the "Open" action after a restore.
 */
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
