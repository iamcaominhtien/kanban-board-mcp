import { useEffect, useRef, useState } from 'react';
import type { Status } from '../types';
import styles from './StatusMenu.module.css';

// Canonical per-status accent colors — mirrors Board.tsx's COLUMNS accent
// colors (and TicketModal's existing use of --color-danger for wont_do), so
// the dot colors stay consistent with the rest of the app.
export const STATUS_DOT_COLORS: Record<Status, string> = {
  backlog:       '#9AA8A0',
  todo:          'var(--color-blue)',
  'in-progress': 'var(--color-orange)',
  done:          'var(--color-lime)',
  wont_do:       'var(--color-danger)',
};

const STATUS_LABELS: Record<Status, string> = {
  backlog:       'Backlog',
  todo:          'To Do',
  'in-progress': 'In Progress',
  done:          'Done',
  wont_do:       'Không làm',
};

// Real, selectable statuses in menu order (Won't Do is appended separately
// below a divider, and is conditionally hidden for sub-tickets by the caller).
const SELECTABLE_STATUSES: Exclude<Status, 'wont_do'>[] = ['backlog', 'todo', 'in-progress', 'done'];

interface StatusMenuProps {
  value: Status;
  onChange: (status: Status) => void;
  showWontDo: boolean;
}

export function StatusMenu({ value, onChange, showWontDo }: StatusMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape — mirrors the tag-add popover's pattern
  // (tagPopoverOpen effect in TicketModal.tsx) for consistency.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  function handleSelect(status: Status) {
    setOpen(false);
    onChange(status);
  }

  return (
    <div className={styles.statusMenuAnchor} ref={anchorRef}>
      <button
        type="button"
        className={styles.statusMenuTrigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={styles.statusDot} style={{ background: STATUS_DOT_COLORS[value] }} />
        <span className={styles.statusMenuLabel}>{STATUS_LABELS[value]}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className={styles.statusMenuChevron}
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        >
          <path d="M6 9L12 15L18 9" />
        </svg>
      </button>

      {open && (
        <div className={styles.statusMenuPopover} role="listbox">
          {SELECTABLE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={value === s}
              className={value === s ? `${styles.statusMenuItem} ${styles.statusMenuItemActive}` : styles.statusMenuItem}
              onClick={() => handleSelect(s)}
            >
              <span className={styles.statusDot} style={{ background: STATUS_DOT_COLORS[s] }} />
              <span className={styles.statusMenuItemLabel}>{STATUS_LABELS[s]}</span>
              {value === s && (
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className={styles.statusMenuCheck}>
                  <path d="M3.5 7.2L5.7 9.5L10.5 4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}

          {/*
            TODO(backend): "Review" and "Testing" are part of the target design
            (a ticket moves to Review once code is up, then Testing once review
            passes and its test cases are ready to run, before Done) but need a
            backend Status enum/migration change first — see server/models.py's
            Status definition and Board.tsx's COLUMNS. These are shown here as
            visually-complete but disabled/unselectable placeholders until that
            work is scoped; do not wire them up as real selectable options yet.
          */}
          <div className={styles.statusMenuItemDisabled} aria-disabled="true">
            <span className={styles.statusDot} style={{ background: 'var(--color-purple)' }} />
            <span className={styles.statusMenuItemLabel}>Review</span>
            <span className={styles.statusMenuSoonTag}>Soon</span>
          </div>
          <div className={styles.statusMenuItemDisabled} aria-disabled="true">
            <span className={styles.statusDot} style={{ background: 'var(--color-orange)' }} />
            <span className={styles.statusMenuItemLabel}>Testing</span>
            <span className={styles.statusMenuSoonTag}>Soon</span>
          </div>

          {showWontDo && (
            <>
              <div className={styles.statusMenuDivider} />
              <button
                type="button"
                role="option"
                aria-selected={value === 'wont_do'}
                className={value === 'wont_do' ? `${styles.statusMenuItem} ${styles.statusMenuItemActive}` : styles.statusMenuItem}
                onClick={() => handleSelect('wont_do')}
              >
                <span className={styles.statusDot} style={{ background: STATUS_DOT_COLORS.wont_do }} />
                <span className={styles.statusMenuItemLabel}>{STATUS_LABELS.wont_do}</span>
                {value === 'wont_do' && (
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className={styles.statusMenuCheck}>
                    <path d="M3.5 7.2L5.7 9.5L10.5 4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
