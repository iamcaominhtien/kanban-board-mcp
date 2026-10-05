import { useState } from 'react';
import { docsErrorDetail, useDocsRecycleBin, usePurgePage, useRestorePage } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsDeletedEntry } from '../../types/docs';
import { actorName } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import styles from './DocsRecycleSection.module.css';

interface DocsRecycleSectionProps {
  projectId: string;
}

function formatRelative(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function DocsRecycleSection({ projectId }: DocsRecycleSectionProps) {
  const toast = useToast();
  const { data, isLoading, isError, error } = useDocsRecycleBin(projectId);
  const restore = useRestorePage(projectId);
  const purge = usePurgePage(projectId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const message = (err: unknown) => docsErrorDetail(err)?.message ?? extractError(err);

  async function handleRestore(entry: DocsDeletedEntry) {
    setBusyId(entry.id);
    setRowError(null);
    try {
      const res = await restore.mutateAsync(entry.id);
      const children = res.restoredPages - 1;
      const title = `Restored “${entry.title}”${
        children > 0 ? ` and ${children} child ${children === 1 ? 'page' : 'pages'}` : ''
      }`;
      toast.success(
        title,
        res.movedToTopLevel
          ? `Its parent is still deleted, so “${entry.title}” returned at the top level.`
          : 'Back in the tree, in its old position.',
      );
    } catch (err) {
      setRowError({ id: entry.id, message: message(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurge(entry: DocsDeletedEntry) {
    setBusyId(entry.id);
    setRowError(null);
    try {
      await purge.mutateAsync(entry.id);
      setConfirmId(null);
      toast.success(`Deleted “${entry.title}” forever`);
    } catch (err) {
      setRowError({ id: entry.id, message: message(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className={styles.section} aria-label="Deleted docs pages">
      <h3 className={styles.heading}>Docs pages</h3>

      {isLoading && <p className={styles.muted}>Loading…</p>}
      {isError && <p className={styles.error} role="alert">{message(error)}</p>}
      {data && data.length === 0 && <p className={styles.muted}>No deleted pages.</p>}

      {data && data.length > 0 && (
        <ul className={styles.list}>
          {data.map((entry) => {
            const busy = busyId === entry.id;
            return (
              <li key={entry.id} className={styles.item}>
                <div className={styles.top}>
                  <span className={styles.title}>{entry.title}</span>
                  <span className={styles.count}>
                    {entry.pageCount} {entry.pageCount === 1 ? 'page' : 'pages'}
                  </span>
                </div>
                <p className={styles.meta}>
                  {actorName(entry.deletedBy)} · {formatRelative(entry.deletedAt)} · {entry.daysLeft}{' '}
                  {entry.daysLeft === 1 ? 'day' : 'days'} left
                </p>
                {entry.pageCount > 1 && (
                  <p className={styles.note}>Restoring brings back all {entry.pageCount} pages in the same order.</p>
                )}
                {confirmId === entry.id ? (
                  <div className={styles.confirm} role="alert">
                    <span>
                      Delete “{entry.title}”
                      {entry.pageCount > 1 ? ` and its ${entry.pageCount - 1} child pages` : ''} forever? This can’t be
                      undone.
                    </span>
                    <div className={styles.actions}>
                      <button type="button" className={styles.ghostBtn} onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        disabled={busy}
                        onClick={() => void handlePurge(entry)}
                      >
                        {busy ? 'Deleting…' : 'Delete forever'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.restoreBtn}
                      disabled={busy}
                      onClick={() => void handleRestore(entry)}
                    >
                      {busy ? 'Restoring…' : '↩ Restore'}
                    </button>
                    <button
                      type="button"
                      className={styles.dangerGhost}
                      disabled={busy}
                      onClick={() => setConfirmId(entry.id)}
                    >
                      Delete forever
                    </button>
                  </div>
                )}
                {rowError?.id === entry.id && <p className={styles.error} role="alert">{rowError.message}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <p className={styles.footnote}>
        If a restored page’s parent is still in the bin, it comes back at the top level.
      </p>
    </section>
  );
}
