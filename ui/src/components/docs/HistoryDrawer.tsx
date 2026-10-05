import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docsErrorDetail, useDocsDiff, useDocsVersions, useRestoreVersion } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsDiff, DocsPage, DocsVersionSummary } from '../../types/docs';
import { actorName } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { DiffView, normalizeHeading } from './DiffView';
import styles from './HistoryDrawer.module.css';

interface HistoryDrawerProps {
  projectId: string;
  page: DocsPage;
  onClose: () => void;
  onRestored?: (page: DocsPage) => void;
}

type Mode = 'inline' | 'side-by-side';

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

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '?'
  );
}

function diffCounts(diff: DocsDiff): string {
  const sections = diff.sections.length;
  return `+${diff.added} −${diff.removed} lines in ${sections} ${sections === 1 ? 'section' : 'sections'}`;
}

export function HistoryDrawer({ projectId, page, onClose, onRestored }: HistoryDrawerProps) {
  const toast = useToast();
  const versionsQ = useDocsVersions(page.id);
  const restore = useRestoreVersion(projectId);
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [comparing, setComparing] = useState<{ from: number; to: number } | null>(null);
  const [mode, setMode] = useState<Mode>('inline');
  const [restoreTarget, setRestoreTarget] = useState<DocsVersionSummary | null>(null);
  const [note, setNote] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ from: number; to: number; previous: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  const versions = useMemo(
    () => [...(versionsQ.data ?? [])].sort((a, b) => b.version - a.version),
    [versionsQ.data],
  );

  const diffQ = useDocsDiff(page.id, comparing?.from ?? null, comparing?.to ?? null);
  // Used by the restore confirm: how the target differs from the current page.
  const restoreDiffQ = useDocsDiff(
    page.id,
    restoreTarget && restoreTarget.version !== page.version ? restoreTarget.version : null,
    restoreTarget && restoreTarget.version !== page.version ? page.version : null,
  );

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (restoreTarget) noteRef.current?.focus();
  }, [restoreTarget]);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (restoreTarget) setRestoreTarget(null);
      else handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, restoreTarget]);

  function toggle(version: number) {
    setSelected((prev) => {
      if (prev.includes(version)) return prev.filter((v) => v !== version);
      return prev.length >= 2 ? [prev[1], version] : [...prev, version];
    });
  }

  function previousOf(version: number): number | null {
    const older = versions.filter((v) => v.version < version);
    return older.length ? older[0].version : null;
  }

  function compareSelected() {
    if (selected.length === 2) {
      const [a, b] = [...selected].sort((x, y) => x - y);
      setComparing({ from: a, to: b });
    } else if (selected.length === 1) {
      const prev = previousOf(selected[0]);
      if (prev != null) setComparing({ from: prev, to: selected[0] });
    }
  }

  const canCompare =
    selected.length === 2 || (selected.length === 1 && previousOf(selected[0]) != null);

  function openRestore(v: DocsVersionSummary) {
    setRestoreTarget(v);
    setNote(`Restored from v${v.version}`);
    setRestoreError(null);
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    const target = restoreTarget.version;
    try {
      const updated = await restore.mutateAsync({
        pageId: page.id,
        version: target,
        note: note.trim() || undefined,
      });
      setRestoreTarget(null);
      setComparing(null);
      setSelected([]);
      setSuccess({ from: target, to: updated.version, previous: page.version });
      toast.success(`Restored v${target} as v${updated.version}`, `v${page.version} is still in the history.`);
      onRestored?.(updated);
    } catch (err) {
      setRestoreError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  function jumpTo(heading: string) {
    const nodes = diffBodyRef.current?.querySelectorAll<HTMLElement>('[data-section]');
    const target = Array.from(nodes ?? []).find(
      (n) => normalizeHeading(n.dataset.section ?? '') === normalizeHeading(heading),
    );
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const byVersion = (n: number) => versions.find((v) => v.version === n);
  const fromV = comparing ? byVersion(comparing.from) : undefined;
  const toV = comparing ? byVersion(comparing.to) : undefined;

  return (
    <div className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`} onClick={handleClose}>
      <aside
        className={`${styles.drawer} ${visible ? styles.drawerVisible : ''} ${comparing ? styles.drawerWide : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Page history"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Page history</h2>
            <p className={styles.subtitle}>
              {page.title} · {versions.length || page.version} versions
            </p>
          </div>
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={handleClose} ref={closeRef}>
            ×
          </button>
        </header>

        {success && (
          <div className={styles.success} role="status">
            <div>
              <strong>Restored v{success.from} as v{success.to}.</strong> v{success.previous} is still in the history.
            </div>
            <button type="button" className={styles.linkBtn} onClick={() => setSuccess(null)}>
              Dismiss
            </button>
          </div>
        )}

        {comparing ? (
          <div className={styles.compare}>
            <div className={styles.toolbar}>
              <button type="button" className={styles.linkBtn} onClick={() => setComparing(null)}>
                ← Back to versions
              </button>
              <div className={styles.compareTitle}>
                <span className={styles.vChip}>v{comparing.from}</span>
                {fromV && <span className={styles.muted}>{actorName(fromV.author)}</span>}
                <span aria-hidden="true">→</span>
                <span className={styles.vChip}>v{comparing.to}</span>
                {toV && <span className={styles.muted}>{actorName(toV.author)}</span>}
              </div>
              <div className={styles.toolbarRow}>
                {diffQ.data && <span className={styles.summary}>{diffCounts(diffQ.data)}</span>}
                <div className={styles.toggle} role="group" aria-label="Diff layout">
                  <button
                    type="button"
                    className={mode === 'inline' ? styles.toggleOn : ''}
                    aria-pressed={mode === 'inline'}
                    onClick={() => setMode('inline')}
                  >
                    Inline
                  </button>
                  <button
                    type="button"
                    className={mode === 'side-by-side' ? styles.toggleOn : ''}
                    aria-pressed={mode === 'side-by-side'}
                    onClick={() => setMode('side-by-side')}
                  >
                    Side by side
                  </button>
                </div>
                {fromV && comparing.from !== page.version && (
                  <button type="button" className={styles.primaryBtn} onClick={() => openRestore(fromV)}>
                    Restore v{comparing.from}
                  </button>
                )}
              </div>
              <p className={styles.hint}>
                Comparing the published versions. Changes are shown as markdown source, the way the page is stored.
              </p>
            </div>
            <div className={styles.compareBody} ref={diffBodyRef}>
              {diffQ.isLoading && <p className={styles.muted}>Loading diff…</p>}
              {diffQ.isError && (
                <p className={styles.error} role="alert">
                  {docsErrorDetail(diffQ.error)?.message ?? extractError(diffQ.error)}
                </p>
              )}
              {diffQ.data && (
                <>
                  {diffQ.data.sections.length > 0 && (
                    <nav className={styles.jump} aria-label="Jump to a change">
                      <span className={styles.label}>Jump to a change</span>
                      <ul>
                        {diffQ.data.sections.map((s) => (
                          <li key={s.heading}>
                            <button type="button" onClick={() => jumpTo(s.heading)}>
                              <span className={styles.jumpName}>{normalizeHeading(s.heading) || 'Top of page'}</span>
                              <span className={styles.counts}>
                                <span className={styles.plus}>+{s.added}</span>{' '}
                                <span className={styles.minus}>−{s.removed}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </nav>
                  )}
                  <DiffView diff={diffQ.data} mode={mode} />
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <p className={styles.hint}>Select two versions to compare them, or one to see what it changed.</p>
            <div className={styles.list}>
              {versionsQ.isLoading && <p className={styles.muted}>Loading versions…</p>}
              {versionsQ.isError && (
                <p className={styles.error} role="alert">
                  {docsErrorDetail(versionsQ.error)?.message ?? extractError(versionsQ.error)}
                </p>
              )}
              {versions.length === 0 && versionsQ.isSuccess && (
                <p className={styles.muted}>No published versions yet.</p>
              )}
              <ul className={styles.versions}>
                {versions.map((v) => {
                  const isCurrent = v.version === page.version;
                  const on = selected.includes(v.version);
                  return (
                    <li key={v.version} className={`${styles.version} ${on ? styles.versionOn : ''}`}>
                      <label className={styles.pick}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(v.version)}
                          aria-label={`Select version ${v.version}`}
                        />
                      </label>
                      <div className={styles.versionMain}>
                        <div className={styles.versionTop}>
                          <span className={styles.vBadge}>v{v.version}</span>
                          {isCurrent && <span className={styles.current}>Current</span>}
                          <span className={styles.time} title={formatAbsolute(v.createdAt)}>
                            {formatRelative(v.createdAt)} · {formatAbsolute(v.createdAt)}
                          </span>
                        </div>
                        <div className={styles.author}>
                          <span className={styles.avatar} aria-hidden="true">{initials(v.author)}</span>
                          {actorName(v.author)}
                          <span className={styles.muted}> · {v.words} words</span>
                        </div>
                        {v.note && <div className={styles.note}>{v.note}</div>}
                      </div>
                      {!isCurrent && (
                        <button type="button" className={styles.restoreBtn} onClick={() => openRestore(v)}>
                          Restore
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <footer className={styles.footer}>
              <span className={styles.selCount}>
                {selected.length} selected
                {selected.length === 2 && ` · v${Math.min(...selected)} → v${Math.max(...selected)}`}
              </span>
              <div className={styles.footerBtns}>
                <button type="button" className={styles.ghostBtn} onClick={() => setSelected([])} disabled={!selected.length}>
                  Clear
                </button>
                <button type="button" className={styles.primaryBtn} onClick={compareSelected} disabled={!canCompare}>
                  Compare
                </button>
              </div>
            </footer>
          </>
        )}

        {restoreTarget && (
          <div className={styles.modalBackdrop} onClick={() => setRestoreTarget(null)}>
            <div
              className={styles.modal}
              role="dialog"
              aria-modal="true"
              aria-label={`Restore v${restoreTarget.version}`}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className={styles.modalTitle}>Restore v{restoreTarget.version}?</h3>
              <p className={styles.subtitle}>
                {actorName(restoreTarget.author)} · {formatAbsolute(restoreTarget.createdAt)}
                {restoreTarget.note ? ` · “${restoreTarget.note}”` : ''}
              </p>
              <div className={styles.info}>
                <strong>Restoring creates v{page.version + 1}.</strong> The page is set back to the content of v
                {restoreTarget.version} and published as a new version. v{page.version} stays in the history, so you
                can go back at any time.
              </div>
              {restoreDiffQ.data && (
                <p className={styles.compared}>
                  Compared with today’s page: <span className={styles.plus}>+{restoreDiffQ.data.removed}</span>{' '}
                  <span className={styles.minus}>−{restoreDiffQ.data.added}</span> lines
                </p>
              )}
              <label className={styles.label} htmlFor="restore-note">Version note</label>
              <input
                id="restore-note"
                ref={noteRef}
                className={styles.input}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {page.draft && (
                <div className={styles.warn}>
                  {actorName(page.draft.author)} has an unpublished draft. It is kept, and will now be based on v{page.version + 1}.
                </div>
              )}
              {restoreError && (
                <p className={styles.error} role="alert">{restoreError}</p>
              )}
              <div className={styles.modalFoot}>
                <span className={styles.muted}>Everyone sees v{page.version + 1} right away.</span>
                <div className={styles.footerBtns}>
                  <button type="button" className={styles.ghostBtn} onClick={() => setRestoreTarget(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => void confirmRestore()}
                    disabled={restore.isPending}
                  >
                    {restore.isPending ? 'Restoring…' : `Restore as v${page.version + 1}`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
