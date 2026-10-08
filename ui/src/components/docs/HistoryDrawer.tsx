import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { docsErrorDetail, useDocsDiff, useDocsVersions, useRestoreVersion } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsVersionSummary } from '../../types/docs';
import { useToast } from '../Toast';
import { DiffView, diffSections, type DiffMode } from './DiffView';
import { Icon } from './Icon';
import {
  Avatar,
  FooterNote,
  ModalShell,
  PlusMinus,
  Spacer,
  agoText,
  blueInfoBox,
  displayName,
  fmtDate,
  fmtDateTime,
  fmtTimeOnly,
  plural,
} from './docsShared';

interface HistoryDrawerProps {
  projectId: string;
  page: DocsPage;
  onClose: () => void;
  onRestored?: (page: DocsPage) => void;
  /** Open straight into a comparison (e.g. from the "Changes since you last viewed" banner). */
  initialCompare?: { from: number; to: number };
  /** If given, the restore toast offers "View history" and the drawer closes after a restore. */
  onReopen?: () => void;
}

const MONO = "'JetBrains Mono', monospace";
const OLDER_VISIBLE = 5;

function dayKey(iso: string): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'today';
  if (t >= start - 86400000) return 'yesterday';
  return 'earlier';
}

const GROUP_LABEL = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' } as const;

function VersionBox({ on }: { on: boolean }) {
  return on ? (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        background: '#2E6F40',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginTop: 2,
        color: '#FFFFFF',
      }}
    >
      <Icon name="i10" size={11} strokeWidth={3} />
    </span>
  ) : (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: '1.5px solid #C7D2CB',
        background: '#FFFFFF',
        boxSizing: 'border-box',
        flexShrink: 0,
        marginTop: 2,
      }}
    />
  );
}

const hdrCell: CSSProperties = {
  padding: '7px 16px',
  background: '#F6FAF7',
  borderBottom: '1px solid #EEF3EF',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#5B6B60',
};

export function HistoryDrawer({ projectId, page, onClose, onRestored, initialCompare, onReopen }: HistoryDrawerProps) {
  const toast = useToast();
  const versionsQ = useDocsVersions(page.id);
  const restore = useRestoreVersion(projectId);
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [comparing, setComparing] = useState<{ from: number; to: number } | null>(initialCompare ?? null);
  const [mode, setMode] = useState<DiffMode>('inline');
  const [restoreTarget, setRestoreTarget] = useState<DocsVersionSummary | null>(null);
  const [note, setNote] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [draftOpen, setDraftOpen] = useState(true);
  const [activeSection, setActiveSection] = useState(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  const versions = useMemo(() => [...(versionsQ.data ?? [])].sort((a, b) => b.version - a.version), [versionsQ.data]);

  const diffQ = useDocsDiff(page.id, comparing?.from ?? null, comparing?.to ?? null);
  const sections = useMemo(() => (diffQ.data ? diffSections(diffQ.data) : []), [diffQ.data]);
  // Used by the restore confirm: how the target differs from the current page.
  const restoreDiffQ = useDocsDiff(
    page.id,
    restoreTarget && restoreTarget.version !== page.version ? restoreTarget.version : null,
    restoreTarget && restoreTarget.version !== page.version ? page.version : null,
  );

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    drawerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (restoreTarget) noteRef.current?.focus();
  }, [restoreTarget]);
  useEffect(() => setActiveSection(0), [comparing?.from, comparing?.to]);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 180);
  }, [onClose]);

  const jump = useCallback((i: number) => {
    setActiveSection(i);
    const el = diffBodyRef.current?.querySelector<HTMLElement>(`[data-section-index="${i}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (restoreTarget) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (comparing && sections.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'j') jump(Math.min(sections.length - 1, activeSection + 1));
        else if (k === 'k') jump(Math.max(0, activeSection - 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleClose, restoreTarget, comparing, sections.length, activeSection, jump]);

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
  const canCompare = selected.length === 2 || (selected.length === 1 && previousOf(selected[0]) != null);

  function viewVersion(v: number) {
    const prev = previousOf(v);
    if (prev != null) setComparing({ from: prev, to: v });
  }

  function openRestore(v: DocsVersionSummary) {
    setRestoreTarget(v);
    setNote(`Restored from v${v.version}`);
    setRestoreError(null);
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    const target = restoreTarget.version;
    try {
      const updated = await restore.mutateAsync({ pageId: page.id, version: target, note: note.trim() || undefined });
      setRestoreTarget(null);
      setComparing(null);
      setSelected([]);
      toast.showToast({
        variant: 'success',
        title: `Restored v${target} as v${updated.version}`,
        message: `v${page.version} is still in the history.`,
        action: onReopen ? { label: 'View history', onClick: onReopen } : undefined,
      });
      onRestored?.(updated);
      if (onReopen) handleClose();
    } catch (err) {
      setRestoreError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  const byVersion = (n: number) => versions.find((v) => v.version === n);
  const fromV = comparing ? byVersion(comparing.from) : undefined;
  const toV = comparing ? byVersion(comparing.to) : undefined;
  const draft = page.draft;

  const groups = useMemo(() => {
    const out: Record<'today' | 'yesterday' | 'earlier', DocsVersionSummary[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const v of versions) out[dayKey(v.createdAt)].push(v);
    return out;
  }, [versions]);

  const restoreDialog = restoreTarget && (
    <ModalShell
      width={540}
      zIndex={1200}
      ariaLabel={`Restore v${restoreTarget.version}`}
      icon="i19"
      title={`Restore v${restoreTarget.version}?`}
      subtitle={
        <>
          {displayName(restoreTarget.author)} · {fmtDateTime(restoreTarget.createdAt)}
          {restoreTarget.note ? ` · “${restoreTarget.note}”` : ''}
        </>
      }
      onClose={() => setRestoreTarget(null)}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          <FooterNote>Everyone sees v{page.version + 1} right away.</FooterNote>
          <Spacer />
          <button type="button" className="st-btn" onClick={() => setRestoreTarget(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            onClick={() => void confirmRestore()}
            disabled={restore.isPending}
          >
            <Icon name="i19" size={14} />
            {restore.isPending ? 'Restoring…' : `Restore as v${page.version + 1}`}
          </button>
        </>
      }
    >
      <div style={blueInfoBox}>
        <span style={{ color: '#2F6FB0', display: 'flex', marginTop: 1 }}>
          <Icon name="i28" size={16} />
        </span>
        <span>
          <b style={{ fontWeight: 700 }}>Restoring creates v{page.version + 1}.</b> {page.title} is set back to the
          content of v{restoreTarget.version} and published as a new version. v{page.version} stays in the history, so
          you can go back at any time.
        </span>
      </div>
      {restoreDiffQ.data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#3A4A3E' }}>
          Compared with today’s page:
          <PlusMinus added={restoreDiffQ.data.removed} removed={restoreDiffQ.data.added} size={12.5} />
          lines
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="st-field-label" htmlFor="restore-note" style={{ fontSize: 11 }}>
          Version note
        </label>
        <input
          id="restore-note"
          ref={noteRef}
          className="st-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {draft && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 9,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#FEF6E7',
            border: '1px solid #F0DBA8',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: '#1E2A22',
          }}
        >
          <span style={{ color: '#B8860B', display: 'flex', marginTop: 1 }}>
            <Icon name="i14" size={15} strokeWidth={2} />
          </span>
          <span>
            {displayName(draft.author)} has an unpublished draft. It is kept, and will now be based on v
            {page.version + 1}.
          </span>
        </div>
      )}
      {restoreError && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {restoreError}
        </div>
      )}
    </ModalShell>
  );

  /* ---------- Compare view (full width) ---------- */
  if (comparing) {
    const verSelect = (value: number, other: number, set: (v: number) => void, v?: DocsVersionSummary) => (
      <div
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid #E3E8E5',
          background: '#FFFFFF',
          fontSize: 12.5,
          color: '#1E2A22',
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700 }}>v{value}</span>
        {v && <Avatar name={v.author} />}
        {v && displayName(v.author)}
        {v && (
          <span style={{ color: '#9AA8A0', fontSize: 12 }}>
            {dayKey(v.createdAt) === 'today' ? 'today' : fmtDate(v.createdAt)}
          </span>
        )}
        <Icon name="i06" size={12} strokeWidth={2.3} />
        <select
          aria-label={`Version ${value}`}
          value={value}
          onChange={(e) => set(Number(e.target.value))}
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }}
        >
          {versions
            .filter((x) => x.version !== other)
            .map((x) => (
              <option key={x.version} value={x.version}>
                v{x.version} · {displayName(x.author)} · {fmtDate(x.createdAt)}
              </option>
            ))}
        </select>
      </div>
    );
    const setPair = (a: number, b: number) => setComparing({ from: Math.min(a, b), to: Math.max(a, b) });
    return (
      <>
        <div
          ref={drawerRef}
          tabIndex={-1}
          className="docs-root"
          role="dialog"
          aria-modal="true"
          aria-label="Page history"
          data-testid="history-compare"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            background: '#FBFCFB',
            outline: 'none',
            opacity: visible ? 1 : 0,
            transition: 'opacity .15s ease',
            color: '#1E2A22',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 22px',
              borderBottom: '1px solid #E3E8E5',
              background: '#FFFFFF',
              flexWrap: 'wrap',
            }}
          >
            <button type="button" className="st-btn st-btn-sm" onClick={() => setComparing(null)}>
              <Icon name="i60" size={13} strokeWidth={2} />
              Back to page
            </button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>{page.title}</span>
            {verSelect(comparing.from, comparing.to, (v) => setPair(v, comparing.to), fromV)}
            <Icon name="i29" size={14} strokeWidth={2} style={{ color: '#9AA8A0' }} />
            {verSelect(comparing.to, comparing.from, (v) => setPair(comparing.from, v), toV)}
            <div style={{ flex: 1 }} />
            {diffQ.data && (
              <span style={{ fontFamily: MONO, fontSize: 12.5 }}>
                <span style={{ color: '#2E6F40', fontWeight: 700 }}>+{diffQ.data.added}</span>{' '}
                <span style={{ color: '#C4432A', fontWeight: 700 }}>−{diffQ.data.removed}</span>{' '}
                <span
                  style={{
                    color: '#5B6B60',
                    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                    fontWeight: 500,
                  }}
                >
                  lines in {plural(sections.length, 'section')}
                </span>
              </span>
            )}
            <div
              role="group"
              aria-label="Diff layout"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: 3,
                borderRadius: 8,
                background: '#EEF3EF',
              }}
            >
              <button
                type="button"
                className="mb-view-btn"
                aria-pressed={mode === 'inline'}
                onClick={() => setMode('inline')}
                style={viewBtn(mode === 'inline')}
              >
                Inline
              </button>
              <button
                type="button"
                className="mb-view-btn"
                aria-pressed={mode === 'side-by-side'}
                onClick={() => setMode('side-by-side')}
                style={viewBtn(mode === 'side-by-side')}
              >
                Side by side
              </button>
            </div>
            {fromV && comparing.from !== page.version && (
              <button type="button" className="st-btn st-btn-primary" onClick={() => openRestore(fromV)}>
                <Icon name="i19" size={14} strokeWidth={2} />
                Restore v{comparing.from}
              </button>
            )}
            <button type="button" aria-label="Close" className="dk-icobtn" onClick={handleClose}>
              <Icon name="i08" size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
            <div
              ref={diffBodyRef}
              style={{
                flex: 1,
                minWidth: 0,
                overflowY: 'auto',
                padding: '22px 20px 22px 26px',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5B6B60' }}>
                <span style={{ color: '#2F6FB0', display: 'flex' }}>
                  <Icon name="i28" size={14} />
                </span>
                Comparing the published versions. Changes are shown as markdown source, the way the page is stored.
              </div>
              {diffQ.isLoading && <p style={{ margin: 0, fontSize: 13, color: '#5B6B60' }}>Loading diff…</p>}
              {diffQ.isError && (
                <p role="alert" style={{ margin: 0, fontSize: 13, color: '#A5321E' }}>
                  {docsErrorDetail(diffQ.error)?.message ?? extractError(diffQ.error)}
                </p>
              )}
              {diffQ.data && (
                <DiffView
                  diff={diffQ.data}
                  mode={mode}
                  activeSection={activeSection}
                  leftLabel={
                    fromV
                      ? {
                          version: fromV.version,
                          text: `${displayName(fromV.author)}, ${dayKey(fromV.createdAt) === 'today' ? 'today' : fmtDate(fromV.createdAt)}`,
                        }
                      : undefined
                  }
                  rightLabel={
                    toV
                      ? {
                          version: toV.version,
                          text: `${displayName(toV.author)}, ${dayKey(toV.createdAt) === 'today' ? 'today' : fmtDate(toV.createdAt)}`,
                        }
                      : undefined
                  }
                />
              )}
            </div>
            <div style={{ width: 250, flexShrink: 0, padding: '22px 18px 0 6px', boxSizing: 'border-box' }}>
              <nav
                aria-label="Jump to a change"
                style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: '#5B6B60',
                  }}
                >
                  Jump to a change
                </div>
                {sections.map((s, i) => (
                  <button
                    key={`${s.heading}-${i}`}
                    type="button"
                    onClick={() => jump(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 10px',
                      borderRadius: 7,
                      fontSize: 12.5,
                      fontWeight: i === activeSection ? 700 : 500,
                      color: '#1E2A22',
                      background: i === activeSection ? '#DCEEE1' : 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                  >
                    {s.heading || 'Top of page'}
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11.5, fontWeight: 500 }}>
                      <span style={{ color: '#2E6F40' }}>+{s.added}</span>{' '}
                      <span style={{ color: '#C4432A' }}>−{s.removed}</span>
                    </span>
                  </button>
                ))}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 10,
                    fontSize: 12,
                    color: '#5B6B60',
                  }}
                >
                  <span className="dk-kbd">J</span>
                  <span className="dk-kbd">K</span>
                  next / previous change
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.5, color: '#9AA8A0', marginTop: 2 }}>
                  Unchanged sections are not listed.
                </div>
              </nav>
            </div>
          </div>
        </div>
        {restoreDialog}
      </>
    );
  }

  /* ---------- Version list (right drawer) ---------- */
  const olderHidden = !showOlder && groups.earlier.length > OLDER_VISIBLE ? groups.earlier.length - OLDER_VISIBLE : 0;
  const earlierShown = olderHidden ? groups.earlier.slice(0, OLDER_VISIBLE) : groups.earlier;

  const renderVersion = (v: DocsVersionSummary): ReactNode => {
    const isCurrent = v.version === page.version;
    const on = selected.includes(v.version);
    const absolute = dayKey(v.createdAt) === 'today' ? agoText(v.createdAt) : fmtDateTime(v.createdAt);
    return (
      <div
        key={v.version}
        className="hd-row"
        data-selected={on ? '1' : undefined}
        style={{
          display: 'flex',
          gap: 10,
          padding: '10px 16px',
          borderBottom: '1px solid #EEF3EF',
          background: on ? '#F1F8F3' : undefined,
          position: 'relative',
        }}
      >
        <label style={{ position: 'relative', display: 'flex', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={on}
            onChange={() => toggle(v.version)}
            aria-label={`Select version ${v.version}`}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              margin: 0,
              opacity: 0,
              cursor: 'pointer',
            }}
          />
          <VersionBox on={on} />
        </label>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>v{v.version}</span>
            {isCurrent && (
              <span className="mc-chip" style={{ background: '#DCEEE1', color: '#1F5A31', height: 20 }}>
                Current
              </span>
            )}
            <span
              title={fmtDateTime(v.createdAt)}
              style={{ marginLeft: 'auto', fontSize: 11.5, color: '#9AA8A0', whiteSpace: 'nowrap' }}
            >
              {absolute}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#5B6B60' }}>
            <Avatar name={v.author} />
            {displayName(v.author)}
          </div>
          {v.note && <div style={{ fontSize: 12.5, lineHeight: 1.45, color: '#3A4A3E' }}>{v.note}</div>}
          <div className="hd-actions" style={{ gap: 6, marginTop: 6 }}>
            {previousOf(v.version) != null && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => viewVersion(v.version)}>
                <Icon name="i36" size={13} strokeWidth={2} />
                View
              </button>
            )}
            {!isCurrent && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => openRestore(v)}>
                <Icon name="i19" size={13} strokeWidth={2} />
                Restore
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <style>{`
        .hd-row:hover { background: #F6FAF7; }
        .hd-row[data-selected] { background: #F1F8F3; }
        .hd-row .hd-actions { display: none; }
        .hd-row:hover .hd-actions, .hd-row:focus-within .hd-actions { display: flex; }
      `}</style>
      <div
        className="docs-root"
        onClick={handleClose}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'transparent' }}
      >
        <div
          ref={drawerRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Page history"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 420,
            maxWidth: '100vw',
            display: 'flex',
            flexDirection: 'column',
            background: '#FFFFFF',
            borderLeft: '1px solid #E3E8E5',
            boxShadow: '-12px 0 32px rgba(30,42,34,0.08)',
            color: '#1E2A22',
            outline: 'none',
            transform: visible ? 'translateX(0)' : 'translateX(24px)',
            opacity: visible ? 1 : 0,
            transition: 'transform .18s ease, opacity .18s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px' }}>
            <span style={{ display: 'flex', color: '#2E6F40' }}>
              <Icon name="i39" size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Page history</div>
              <div style={{ fontSize: 12, color: '#5B6B60' }}>
                {page.title} · {plural(versions.length || page.version, 'version')}
              </div>
            </div>
            <button type="button" className="dk-icobtn" aria-label="Close" onClick={handleClose}>
              <Icon name="i08" size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div style={{ padding: '0 16px 10px', fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
            Select two versions to compare them, or one to see what it changed.
          </div>
          <div style={{ borderTop: '1px solid #E3E8E5', flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {versionsQ.isLoading && (
              <p style={{ margin: 0, padding: 16, fontSize: 13, color: '#5B6B60' }}>Loading versions…</p>
            )}
            {versionsQ.isError && (
              <p role="alert" style={{ margin: 0, padding: 16, fontSize: 13, color: '#A5321E' }}>
                {docsErrorDetail(versionsQ.error)?.message ?? extractError(versionsQ.error)}
              </p>
            )}
            {versions.length === 0 && versionsQ.isSuccess && !draft && (
              <p style={{ margin: 0, padding: 16, fontSize: 13, color: '#5B6B60' }}>No published versions yet.</p>
            )}

            {(groups.today.length > 0 || draft) && (
              <>
                <div style={hdrCell}>Today</div>
                {draft && (
                  <>
                    <button
                      type="button"
                      aria-expanded={draftOpen}
                      onClick={() => setDraftOpen((o) => !o)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '9px 16px',
                        border: 'none',
                        borderBottom: '1px solid #EEF3EF',
                        background: 'none',
                        fontFamily: 'inherit',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: '#3A4A3E',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <Icon name={draftOpen ? 'i06' : 'i05'} size={12} strokeWidth={2.3} />
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#B4791E' }} />
                      Draft autosaves
                      <span style={{ fontWeight: 500, color: '#5B6B60' }}>{displayName(draft.author)}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 500, color: '#9AA8A0' }}>
                        not published
                      </span>
                    </button>
                    {draftOpen && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 16px 6px 40px',
                          borderBottom: '1px solid #EEF3EF',
                          fontSize: 12,
                          color: '#5B6B60',
                        }}
                      >
                        <Icon name="i20" size={12} strokeWidth={2} />
                        Autosave {fmtTimeOnly(draft.updatedAt)}
                        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#9AA8A0' }}>
                          {agoText(draft.updatedAt)}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {groups.today.map(renderVersion)}
              </>
            )}
            {groups.yesterday.length > 0 && (
              <>
                <div style={hdrCell}>{GROUP_LABEL.yesterday}</div>
                {groups.yesterday.map(renderVersion)}
              </>
            )}
            {groups.earlier.length > 0 && (
              <>
                <div style={hdrCell}>{GROUP_LABEL.earlier}</div>
                {earlierShown.map(renderVersion)}
                {olderHidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowOlder(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '11px 16px',
                      border: 'none',
                      background: 'none',
                      fontFamily: 'inherit',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: '#2E6F40',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon name="i06" size={12} strokeWidth={2.3} />
                    Show {olderHidden} older {olderHidden === 1 ? 'version' : 'versions'}
                  </button>
                )}
              </>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 16px',
              borderTop: '1px solid #E3E8E5',
              background: '#FBFCFB',
            }}
          >
            <span style={{ flex: 1, fontSize: 12.5, color: '#3A4A3E' }}>
              <b style={{ color: '#1E2A22', fontWeight: 700 }}>{selected.length} selected</b>{' '}
              {selected.length === 2 && (
                <span style={{ fontFamily: MONO, fontSize: 12 }}>
                  v{Math.min(...selected)} → v{Math.max(...selected)}
                </span>
              )}
            </span>
            <button type="button" className="st-btn" onClick={() => setSelected([])} disabled={!selected.length}>
              Clear
            </button>
            <button type="button" className="st-btn st-btn-primary" onClick={compareSelected} disabled={!canCompare}>
              <Icon name="i40" size={14} />
              Compare
            </button>
          </div>
        </div>
      </div>
      {restoreDialog}
    </>
  );
}

function viewBtn(on: boolean): CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: 'inherit',
    background: on ? '#FFFFFF' : 'none',
    color: on ? '#1E2A22' : '#5B6B60',
    boxShadow: on ? '0 1px 2px rgba(30,42,34,0.10)' : undefined,
  };
}
