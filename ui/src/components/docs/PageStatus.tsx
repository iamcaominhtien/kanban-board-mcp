/**
 * The status of a page under its bar (design board "Rich Docs — reading", D, frames 29-37): the Published badge
 * with its version popover, the note on a page that may be outdated with "Mark as reviewed", and the bar of an
 * older version opened from History.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { actorName } from '../../utils/relativeTime';
import { Icon } from './Icon';
import { longDateTime, outdatedText, shortDate, type Outdated } from './pageStatus';

/**
 * The green "Published · vN" badge; a click opens the version, when and by whom, with Page history and Compare.
 * @param props.version - The version shown.
 * @param props.publishedAt - When it was published (ISO).
 * @param props.by - Who published it (an actor).
 * @param props.onHistory - Opens Page history.
 * @param props.onCompare - Compares it with the version before (none for v1).
 */
export function VersionBadge({
  version,
  publishedAt,
  by,
  onHistory,
  onCompare,
}: {
  version: number;
  publishedAt: string;
  by: string;
  onHistory: () => void;
  onCompare?: (from: number, to: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }} data-popover>
      <button
        type="button"
        className="mc-chip dk-schip dk-schip-green dk-status-badge"
        data-testid="status-badge"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mc-dot" />
        Published · v{version}
      </button>
      {open && (
        <div className="dk-menu docs-root dk-version-pop" role="dialog" aria-label={`Version ${version}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ flex: 1, fontSize: 14, color: '#1E2A22' }}>Version {version}</b>
            <span className="mc-chip dk-schip dk-schip-green">
              <span className="mc-dot" />
              Published · v{version}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: '#3A4A3E' }}>
            Published {longDateTime(publishedAt)} by {actorName(by)}. Readers see this version.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => {
                setOpen(false);
                onHistory();
              }}
            >
              <Icon name="i39" size={13} strokeWidth={2} />
              Page history
            </button>
            {onCompare && version > 1 && (
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => {
                  setOpen(false);
                  onCompare(version - 1, version);
                }}
              >
                <Icon name="i40" size={13} strokeWidth={2} />
                Compare with v{version - 1}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The note on a page that may be outdated: readers read it, editors can mark the page as reviewed.
 * @param props.outdated - Why it may be outdated.
 * @param props.canEdit - Show "Mark as reviewed".
 * @param props.busy - The review is being saved.
 * @param props.onReviewed - Marks the page as reviewed.
 */
export function OutdatedNote({
  outdated,
  canEdit,
  busy,
  onReviewed,
}: {
  outdated: Outdated;
  canEdit: boolean;
  busy?: boolean;
  onReviewed: () => void;
}) {
  return (
    <div className="dk-note dk-note-amber" role="note" data-testid="outdated-note">
      <span className="dk-note-icon" aria-hidden="true">
        <Icon name="i39" size={16} strokeWidth={2} />
      </span>
      <span className="dk-note-text">{outdatedText(outdated)}</span>
      {canEdit && (
        <button type="button" className="st-btn" disabled={busy} onClick={onReviewed} data-testid="mark-reviewed">
          {busy ? 'Saving…' : 'Mark as reviewed'}
        </button>
      )}
    </div>
  );
}

/**
 * The bar over an older version opened from History: what is shown, the way back, and Restore for editors.
 * @param props.version - The version being read.
 * @param props.current - The page's current version.
 * @param props.currentAt - When the current version was published (ISO).
 * @param props.onBack - Back to the current page.
 * @param props.onRestore - Restores this version as a new one (editors only).
 * @param props.restoring - The restore is running.
 */
export function OlderVersionBar({
  version,
  current,
  currentAt,
  onBack,
  onRestore,
  restoring,
}: {
  version: number;
  current: number;
  currentAt: string;
  onBack: () => void;
  onRestore?: () => void;
  restoring?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  // History board, frame 4: a purple card, the line with its clock, the buttons 26 px under it
  const btn = (primary: boolean): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: 26,
    padding: '0 10px',
    boxSizing: 'border-box',
    borderRadius: 7,
    background: primary ? '#2E6F40' : '#FFFFFF',
    color: primary ? '#FFFFFF' : '#1E2A22',
    border: `1px solid ${primary ? '#2E6F40' : '#D5DDD8'}`,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    flex: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  });
  return (
    <div
      role="status"
      data-testid="older-version-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 14px',
        borderRadius: 10,
        background: '#F1ECFB',
        border: '1px solid #DCD0F3',
        fontSize: 13,
        lineHeight: 1.45,
        color: '#1E2A22',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg
          aria-hidden="true"
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#5B3AA6"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5M4 4v4.5h4.5M12 8v4l3 2" />
        </svg>
        <span>
          {confirming ? (
            <>
              Restore v{version}? It becomes v{current + 1}; v{current} stays in History.
            </>
          ) : (
            <>
              <b>You are reading v{version}.</b>{' '}
              <span style={{ color: '#5B6B60' }}>
                The current page is v{current}, published {shortDate(currentAt)}. Edit is off while you read an older
                version.
              </span>
            </>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingLeft: 26 }}>
        {confirming ? (
          <>
            <button
              type="button"
              style={btn(true)}
              disabled={restoring}
              onClick={onRestore}
              data-testid="older-restore-yes"
            >
              {restoring ? 'Restoring…' : `Restore as v${current + 1}`}
            </button>
            <button type="button" style={btn(false)} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {onRestore && (
              <button type="button" style={btn(true)} onClick={() => setConfirming(true)}>
                <svg
                  aria-hidden="true"
                  width={13}
                  height={13}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
                </svg>
                Restore this version
              </button>
            )}
            <button type="button" style={btn(!onRestore)} onClick={onBack} data-testid="older-back">
              Back to the latest
            </button>
          </>
        )}
      </div>
    </div>
  );
}
