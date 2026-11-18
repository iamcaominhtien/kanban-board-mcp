/**
 * One row of the history list (design "History and comments on rich pages", A 1–3, 5, 6): the version, who wrote it
 * and when, its note, "with AI", how many blocks it changed, the conversion from Markdown and the old Markdown
 * versions, a restore; a box to choose it for a comparison; its buttons (View, Restore, Copy as new page: on hover, or
 * always on the chosen row) and its menu (View this version, Compare with previous, Compare with current, Restore,
 * Copy as new page, Copy link to version, Edit note).
 */

import { useEffect, useRef, useState } from 'react';
import type { DocsVersionSummary } from '../../../types/docs';
import { AiSpark } from '../ai/AiSpark';
import { Icon } from '../Icon';
import { Avatar, agoText, displayName, fmtDateTime } from '../docsShared';
import { BOARD_AUTHOR, type RowChange } from './versionInfo';

/** What a row can ask for. */
export interface RowActions {
  /** Compare it with the version before it (what it changed). */
  onView?: () => void;
  /** Open it to read on the page (read-only). */
  onOpen?: () => void;
  onCompareCurrent?: () => void;
  onRestore?: () => void;
  onCopy?: () => void;
  /** Copy a link that opens the page on this version. */
  onCopyLink?: () => void;
  /** Change the version's note. */
  onEditNote?: () => void;
}

/** The chosen-row box (20 px with a 15 px check on touch, 16 px with an 11 px check on desktop). */
function Box({ on, touch }: { on: boolean; touch: boolean }) {
  return (
    <span className={`hx-box${on ? ' is-on' : ''}`} aria-hidden="true">
      {on && <Icon name="i10" size={touch ? 15 : 11} strokeWidth={3.2} />}
    </span>
  );
}

/** The four-squares mark before a row's block count. */
export function BlocksMark({ size = 11 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/** Who wrote a version: the app's square mark for the conversion, a person's initials otherwise. */
export function RowAuthor({ name }: { name: string }) {
  if (name === BOARD_AUTHOR) {
    return (
      <span className="hx-av-board" aria-hidden="true">
        <Icon name="i57" size={12} strokeWidth={2} />
      </span>
    );
  }
  return (
    <span className="hx-av">
      <Avatar name={name} size={20} />
    </span>
  );
}

/** The row's menu, under its ⋯ button. */
function RowMenu({ v, current, actions }: { v: DocsVersionSummary; current: number; actions: RowActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const item = (label: string, icon: string, run: (() => void) | undefined, testId: string) =>
    run && (
      <button
        type="button"
        role="menuitem"
        data-testid={testId}
        onClick={() => {
          setOpen(false);
          run();
        }}
      >
        <span className="hx-menu-ico">
          <Icon name={icon} size={15} strokeWidth={2} />
        </span>
        <span className="hx-menu-label">{label}</span>
      </button>
    );
  const restore = v.version !== current && actions.onRestore;
  return (
    <span className="hx-menu-wrap" ref={ref}>
      <button
        type="button"
        className="dk-icobtn hx-more"
        aria-label={`More for version ${v.version}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`version-menu-${v.version}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={14} strokeWidth={2} />
      </button>
      {open && (
        <div className="hx-menu" role="menu" aria-label={`Version ${v.version}`}>
          {item('View this version', 'i36', actions.onOpen, 'menu-open')}
          {item('Compare with previous', 'i40', actions.onView, 'menu-compare-previous')}
          {v.version !== current &&
            item('Compare with current', 'i40', actions.onCompareCurrent, 'menu-compare-current')}
          <div className="hx-menu-sep" role="separator" />
          {restore && item(`Restore as v${current + 1}`, 'i19', actions.onRestore, 'menu-restore')}
          {item('Copy as new page', 'i24', actions.onCopy, 'menu-copy')}
          {item('Copy link to version', 'i11', actions.onCopyLink, 'menu-copy-link')}
          {actions.onEditNote && <div className="hx-menu-sep" role="separator" />}
          {item('Edit note', 'i15', actions.onEditNote, 'menu-edit-note')}
        </div>
      )}
    </span>
  );
}

/** Props of {@link VersionRow}. */
export interface VersionRowProps {
  v: DocsVersionSummary;
  /** The page's current version. */
  current: number;
  /** What it changed (null while its content loads). */
  change: RowChange | null;
  /** The version before it (for "Compare with v6" on the conversion row). */
  previous: number | null;
  selected: boolean;
  onToggle: () => void;
  actions: RowActions;
  /** Tablet and phone: 44 px targets, the chosen row's buttons always shown, a tap on the row chooses it. */
  touch: boolean;
  /** Phone: the chosen row has no "Copy as new page" (it stays in the row's menu). */
  phone?: boolean;
}

/**
 * One version in the history list.
 * @param props - See {@link VersionRowProps}.
 */
export function VersionRow({
  v,
  current,
  change,
  previous,
  selected,
  onToggle,
  actions,
  touch,
  phone,
}: VersionRowProps) {
  const isCurrent = v.version === current;
  const today = new Date(v.createdAt).toDateString() === new Date().toDateString();
  const converted = change?.kind === 'converted';
  const markdown = change?.kind === 'markdown';
  return (
    <div
      className={`hd-row hx-row${touch ? ' hx-touch' : ''}${converted ? ' hx-row-conv' : ''}`}
      data-selected={selected ? '1' : undefined}
      data-testid={`version-row-${v.version}`}
      onClick={touch ? onToggle : undefined}
    >
      <label className="hx-box-wrap" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select version ${v.version}`}
          className="hx-box-input"
        />
        <Box on={selected} touch={touch} />
      </label>
      <div className="hx-row-main">
        <div className="hx-row-line">
          <span className="hx-v">v{v.version}</span>
          {isCurrent && <span className="hx-chip-s hx-chip-current">Current</span>}
          {converted && (
            <span className="hx-chip-s hx-chip-conv" data-testid={`converted-${v.version}`}>
              <Icon name="i41" size={10} strokeWidth={2.4} />
              Converted from Markdown
            </span>
          )}
          {markdown && (
            <span
              className="hx-chip-s hx-chip-md"
              data-testid={`markdown-${v.version}`}
              title="Saved as Markdown, before the page was converted. Shown as it was."
            >
              <Icon name="i00" size={10} strokeWidth={2} />
              Markdown
            </span>
          )}
          <span className="hx-when" title={fmtDateTime(v.createdAt)}>
            {today ? agoText(v.createdAt) : fmtDateTime(v.createdAt)}
          </span>
        </div>
        <div className="hx-row-who">
          <RowAuthor name={v.author} />
          {displayName(v.author)}
          {v.withAi && (
            <span
              className="hx-chip-s hx-chip-ai"
              data-testid={`with-ai-${v.version}`}
              title="The author accepted AI text in this version"
            >
              <AiSpark size={11} />
              with AI
            </span>
          )}
        </div>
        {v.note && !converted && <div className="hx-note-line">{v.note}</div>}
        {converted && <div className="hx-note-line">Same text, now in the new page format. Nothing was rewritten.</div>}
        {change && change.kind !== 'markdown' && (
          <div className="hx-row-count" data-testid={`version-count-${v.version}`}>
            <BlocksMark />
            {change.text}
          </div>
        )}
        <div className="hd-actions hx-actions" onClick={(e) => e.stopPropagation()}>
          {actions.onView && (
            <button type="button" className="st-btn st-btn-sm" onClick={actions.onView}>
              <Icon name="i36" size={touch ? 14.5 : 13} strokeWidth={2.4} />
              {converted && previous != null ? `Compare with v${previous}` : 'View'}
            </button>
          )}
          {!isCurrent && actions.onRestore && (
            <button type="button" className="st-btn st-btn-sm" onClick={actions.onRestore}>
              <Icon name="i19" size={touch ? 14.5 : 13} strokeWidth={2.4} />
              Restore
            </button>
          )}
          {actions.onCopy && !phone && (
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={actions.onCopy}
              data-testid={`copy-version-${v.version}`}
            >
              <Icon name="i24" size={touch ? 14.5 : 13} strokeWidth={2.4} />
              Copy as new page
            </button>
          )}
          <RowMenu v={v} current={current} actions={actions} />
        </div>
      </div>
    </div>
  );
}
