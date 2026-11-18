/**
 * Page history (design "History and comments on rich pages", A–C): the versions in a drawer — who wrote each, when,
 * with what note, "with AI", how many blocks it changed, the conversion from Markdown — and from there a comparison of
 * any two versions block by block, a restore that asks first, and "Copy as new page". Desktop: a drawer beside the
 * page; tablet: a drawer over the page with 44 px rows; phone: the whole screen, two rows chosen then Compare.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client } from '../../../api/client';
import {
  docsErrorDetail,
  useDocsVersion,
  useDocsVersions,
  useMarkDocsSeen,
  useRestoreVersion,
} from '../../../api/docs';
import { useDocsComments } from '../../../api/docsComments';
import { extractError } from '../../../api/extractError';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage, DocsVersionSummary } from '../../../types/docs';
import { useToast } from '../../Toast';
import { HistorySummary } from '../ai/HistorySummary';
import { Icon } from '../Icon';
import { agoText, displayName, fmtTimeOnly, plural } from '../docsShared';
import { COUNTED_ROWS, useVersionDetails } from './api';
import { CompareView } from './CompareView';
import { CopyPageDialog, RestoreDialog } from './Dialogs';
import { VersionRow } from './VersionRow';
import { rowChange } from './versionInfo';
import './history.css';

/** Props of {@link HistoryDrawer}. */
export interface HistoryDrawerProps {
  projectId: string;
  page: DocsPage;
  onClose: () => void;
  /** Called with the page after a version is restored (or a restore undone). */
  onRestored?: (page: DocsPage) => void;
  /** Open straight into a comparison (e.g. from the "Changes since you last viewed" banner). */
  initialCompare?: { from: number; to: number };
  /** If given, the restore toast offers "View history" and the drawer closes after a restore. */
  onReopen?: () => void;
  /** Opens an older version to read in place of the page (read-only, with a way back). */
  onRead?: (version: number) => void;
  /** Opens a page (the draft "Copy as new page" made). */
  onOpenPage?: (pageId: string) => void;
  /** The Docs area's layout (desktop when not given). */
  layout?: DocsLayout;
}

const OLDER_VISIBLE = 5;

type Day = 'today' | 'yesterday' | 'earlier';

function dayKey(iso: string): Day {
  const t = new Date(iso).getTime();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return 'today';
  if (t >= start - 86400000) return 'yesterday';
  return 'earlier';
}

const GROUP_LABEL: Record<Day, string> = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' };

/**
 * The history drawer of a page, with compare, restore and copy.
 * @param props - See {@link HistoryDrawerProps}.
 */
export function HistoryDrawer({
  projectId,
  page,
  onClose,
  onRestored,
  initialCompare,
  onReopen,
  onRead,
  onOpenPage,
  layout = 'desktop',
}: HistoryDrawerProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const versionsQ = useDocsVersions(page.id);
  const restore = useRestoreVersion(projectId);
  const markSeen = useMarkDocsSeen();
  const comments = useDocsComments(page.id);
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [comparing, setComparing] = useState<{ from: number; to: number } | null>(initialCompare ?? null);
  const [restoreTarget, setRestoreTarget] = useState<DocsVersionSummary | null>(null);
  const [copyTarget, setCopyTarget] = useState<DocsVersionSummary | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [draftOpen, setDraftOpen] = useState(true);
  const drawerRef = useRef<HTMLDivElement>(null);
  const touch = layout !== 'desktop';
  const phone = layout === 'phone';

  const versions = useMemo(() => [...(versionsQ.data ?? [])].sort((a, b) => b.version - a.version), [versionsQ.data]);
  // the rows count the blocks each version changed: their content and the content of the one before each
  const counted = useMemo(() => versions.slice(0, COUNTED_ROWS + 1).map((v) => v.version), [versions]);
  const details = useVersionDetails(page.id, counted);
  const restoreDetail = useDocsVersion(page.id, restoreTarget?.version ?? null).data;
  const copyDetail = useDocsVersion(page.id, copyTarget?.version ?? null).data;

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    drawerRef.current?.focus();
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 180);
  }, [onClose]);

  const dialogOpen = !!restoreTarget || !!copyTarget;
  useEffect(() => {
    if (comparing || dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // an open row menu takes this Escape (it closes itself); the drawer closes on the next one
      if (drawerRef.current?.querySelector('[role="menu"]')) return;
      e.stopPropagation();
      handleClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleClose, comparing, dialogOpen]);

  const previousOf = (version: number): number | null => versions.find((v) => v.version < version)?.version ?? null;

  function toggle(version: number) {
    setSelected((prev) => {
      if (prev.includes(version)) return prev.filter((v) => v !== version);
      return prev.length >= 2 ? [prev[1], version] : [...prev, version];
    });
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
  const canCompare = selected.length === 2 || (selected.length === 1 && previousOf(selected[0]) != null);

  function openRestore(v: DocsVersionSummary) {
    setRestoreTarget(v);
    setRestoreError(null);
  }

  /** Restores without the mutation hook: an Undo runs after the drawer has closed. */
  async function restoreNow(version: number, note: string): Promise<DocsPage> {
    const updated = (await client.post<DocsPage>(`/docs/pages/${page.id}/versions/${version}/restore`, { note })).data;
    void qc.invalidateQueries({ queryKey: ['docs'] });
    return updated;
  }

  async function undoRestore(previous: number, restored: number) {
    try {
      const back = await restoreNow(previous, `Undid the restore of v${restored}`);
      markSeen(page.id, back.version);
      onRestored?.(back);
      toast.success(`Back to v${previous}`, `The page is v${back.version} now, with the content of v${previous}.`);
    } catch (err) {
      toast.error(`Couldn’t undo the restore`, docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  async function confirmRestore(note: string) {
    if (!restoreTarget) return;
    const target = restoreTarget.version;
    const was = page.version;
    try {
      const updated = await restore.mutateAsync({ pageId: page.id, version: target, note: note || undefined });
      markSeen(page.id, updated.version); // your own restore is not news to you
      setRestoreTarget(null);
      setComparing(null);
      setSelected([]);
      toast.showToast({
        variant: 'success',
        title: `Restored v${target}`,
        message: `The page is v${updated.version} now, with the content of v${target}.`,
        action: { label: 'Undo', onClick: () => void undoRestore(was, target) },
        secondaryAction: onReopen ? { label: 'View history', onClick: onReopen } : undefined,
      });
      onRestored?.(updated);
      if (onReopen) handleClose();
    } catch (err) {
      setRestoreError(docsErrorDetail(err)?.message ?? extractError(err));
      toast.error(`Couldn’t restore v${target}`, `Check your connection. The page is still v${was}.`);
    }
  }

  const draft = page.draft;
  const groups = useMemo(() => {
    const out: Record<Day, DocsVersionSummary[]> = { today: [], yesterday: [], earlier: [] };
    for (const v of versions) out[dayKey(v.createdAt)].push(v);
    return out;
  }, [versions]);

  const dialogs = (
    <>
      {restoreTarget && (
        <RestoreDialog
          projectId={projectId}
          page={page}
          target={restoreTarget}
          detail={restoreDetail}
          threads={comments.data?.threads ?? []}
          busy={restore.isPending}
          error={restoreError}
          compact={phone}
          onCancel={() => setRestoreTarget(null)}
          onConfirm={(note) => void confirmRestore(note)}
        />
      )}
      {copyTarget && (
        <CopyPageDialog
          projectId={projectId}
          page={page}
          target={copyTarget}
          detail={copyDetail}
          onCancel={() => setCopyTarget(null)}
          onCreated={(created, title, place) => {
            setCopyTarget(null);
            toast.showToast({
              variant: 'success',
              title: 'Created a draft',
              message: `${title}, in ${place}.`,
              action: onOpenPage ? { label: 'Open', onClick: () => onOpenPage(created.id) } : undefined,
            });
          }}
        />
      )}
    </>
  );

  /* ---------- Compare (full screen) ---------- */
  if (comparing) {
    return (
      <>
        <CompareView
          projectId={projectId}
          page={page}
          versions={versions}
          from={comparing.from}
          to={comparing.to}
          onPair={(from, to) => setComparing({ from, to })}
          onBack={() => setComparing(null)}
          onClose={handleClose}
          onRestore={openRestore}
          layout={layout}
          keys={!dialogOpen}
        />
        {dialogs}
      </>
    );
  }

  /* ---------- Version list ---------- */
  const olderHidden = !showOlder && groups.earlier.length > OLDER_VISIBLE ? groups.earlier.length - OLDER_VISIBLE : 0;
  const earlierShown = olderHidden ? groups.earlier.slice(0, OLDER_VISIBLE) : groups.earlier;

  const renderVersion = (v: DocsVersionSummary): ReactNode => {
    const prev = previousOf(v.version);
    const detail = details.get(v.version);
    const prevDetail = prev == null ? null : details.get(prev);
    return (
      <VersionRow
        key={v.version}
        v={v}
        current={page.version}
        change={rowChange(v, detail, prevDetail)}
        previous={prev}
        selected={selected.includes(v.version)}
        onToggle={() => toggle(v.version)}
        touch={touch}
        phone={phone}
        actions={{
          onView: prev != null ? () => setComparing({ from: prev, to: v.version }) : undefined,
          onOpen: onRead && v.version !== page.version ? () => onRead(v.version) : undefined,
          onCompareCurrent:
            v.version !== page.version ? () => setComparing({ from: v.version, to: page.version }) : undefined,
          onRestore: v.version !== page.version ? () => openRestore(v) : undefined,
          onCopy: () => setCopyTarget(v),
        }}
      />
    );
  };

  const list = (
    <>
      {versionsQ.isLoading && <p className="hx-list-state">Loading versions…</p>}
      {versionsQ.isError && (
        <p role="alert" className="hx-list-state hx-list-error">
          {docsErrorDetail(versionsQ.error)?.message ?? extractError(versionsQ.error)}
        </p>
      )}
      {versions.length === 0 && versionsQ.isSuccess && !draft && (
        <p className="hx-list-state">No published versions yet.</p>
      )}
      {(groups.today.length > 0 || draft) && (
        <>
          <div className="hx-group">Today</div>
          {draft && (
            <>
              <button
                type="button"
                className="hx-draft"
                aria-expanded={draftOpen}
                onClick={() => setDraftOpen((o) => !o)}
              >
                <Icon name={draftOpen ? 'i06' : 'i05'} size={12} strokeWidth={2.3} />
                <span className="hx-draft-dot" />
                Draft autosaves
                <span className="hx-draft-who">{displayName(draft.author)}</span>
                <span className="hx-draft-not">not published</span>
              </button>
              {draftOpen && (
                <div className="hx-draft-row">
                  <Icon name="i20" size={12} strokeWidth={2} />
                  Autosave {fmtTimeOnly(draft.updatedAt)}
                  <span className="hx-draft-not">{agoText(draft.updatedAt)}</span>
                </div>
              )}
            </>
          )}
          {groups.today.map(renderVersion)}
        </>
      )}
      {groups.yesterday.length > 0 && (
        <>
          <div className="hx-group">{GROUP_LABEL.yesterday}</div>
          {groups.yesterday.map(renderVersion)}
        </>
      )}
      {groups.earlier.length > 0 && (
        <>
          <div className="hx-group">{GROUP_LABEL.earlier}</div>
          {earlierShown.map(renderVersion)}
          {olderHidden > 0 && (
            <button type="button" className="hx-older" onClick={() => setShowOlder(true)}>
              <Icon name="i06" size={12} strokeWidth={2.3} />
              Show {olderHidden} older {olderHidden === 1 ? 'version' : 'versions'}
            </button>
          )}
        </>
      )}
    </>
  );

  const pair = [...selected].sort((a, b) => a - b);
  const panel = (
    <div
      ref={drawerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal={touch ? 'true' : 'false'}
      aria-label="Page history"
      className="hx-panel"
    >
      {phone ? (
        <div className="hx-panel-head hx-phone-head">
          <button type="button" className="hx-close" aria-label="Close" onClick={handleClose}>
            <Icon name="i60" size={20} strokeWidth={2} />
          </button>
          <div className="hx-panel-title">Page history</div>
        </div>
      ) : (
        <>
          <div className="hx-panel-head">
            <span className="hx-panel-icon">
              <Icon name="i39" size={18} strokeWidth={2} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="hx-panel-title">Page history</div>
              <div className="hx-panel-sub">
                {page.title} · {plural(versions.length || page.version, 'version')}
              </div>
            </div>
            <button type="button" className="hx-close" aria-label="Close" onClick={handleClose}>
              <Icon name="i08" size={16} strokeWidth={2} />
            </button>
          </div>
          <div className="hx-panel-hint">Select two versions to compare them, or one to see what it changed.</div>
        </>
      )}
      {!phone && (
        <HistorySummary
          projectId={projectId}
          pageId={page.id}
          versions={versions.map((x) => x.version)}
          selected={selected}
        />
      )}
      <div className="hx-list">{list}</div>
      <div className="hx-foot">
        <span className="hx-foot-text">
          <b>{selected.length} selected</b>{' '}
          {pair.length === 2 && (
            <span className="hx-foot-pair">
              v{pair[0]} → v{pair[1]}
            </span>
          )}
        </span>
        {!phone && (
          <button type="button" className="st-btn" onClick={() => setSelected([])} disabled={!selected.length}>
            Clear
          </button>
        )}
        <button type="button" className="st-btn st-btn-primary" onClick={compareSelected} disabled={!canCompare}>
          <Icon name="i40" size={phone ? 15.5 : 14} strokeWidth={2.4} />
          Compare
        </button>
      </div>
    </div>
  );

  if (touch) {
    return (
      <>
        <div className="docs-root hx-overlay" data-layout={layout} data-testid="history-drawer">
          {!phone && <div className="hx-scrim" aria-hidden="true" onClick={handleClose} />}
          <div className={`hx-sheet${visible ? ' is-in' : ''}`}>{panel}</div>
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      {/* In the page row, so the page makes room for the drawer instead of sitting under it. */}
      <div className="docs-root hx-drawer" data-testid="history-drawer" style={{ width: visible ? 420 : 0 }}>
        {panel}
      </div>
      {dialogs}
    </>
  );
}
