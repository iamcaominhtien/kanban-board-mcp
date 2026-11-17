/**
 * One row of the history list (design "History and comments on rich pages", A 1–3, 5, 6): the version, who wrote it
 * and when, its note, "with AI", how many blocks it changed, the conversion from Markdown and the old Markdown
 * versions, a restore; a box to choose it for a comparison; its buttons (on hover, or always on the chosen row) and
 * its menu (Open, Compare with previous, Compare with current, Restore…, Copy as new page).
 */

import { useEffect, useRef, useState } from 'react';
import type { DocsVersionSummary } from '../../../types/docs';
import { AiSpark } from '../ai/AiSpark';
import { Icon } from '../Icon';
import { Avatar, agoText, displayName, fmtDateTime } from '../docsShared';
import { restoredFrom, type RowChange } from './versionInfo';

/** What a row can ask for. */
export interface RowActions {
  /** Compare it with the version before it (what it changed). */
  onView?: () => void;
  /** Open it to read on the page (read-only). */
  onOpen?: () => void;
  onCompareCurrent?: () => void;
  onRestore?: () => void;
  onCopy?: () => void;
}

/** The chosen-row box. */
function Box({ on }: { on: boolean }) {
  return (
    <span className={`hx-box${on ? ' is-on' : ''}`} aria-hidden="true">
      {on && <Icon name="i10" size={11} strokeWidth={3} />}
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
  const item = (label: string, run: (() => void) | undefined, testId: string) =>
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
        {label}
      </button>
    );
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
        <Icon name="more" size={15} strokeWidth={2} />
      </button>
      {open && (
        <div className="hx-menu" role="menu" aria-label={`Version ${v.version}`}>
          {item('Open', actions.onOpen, 'menu-open')}
          {item('Compare with previous', actions.onView, 'menu-compare-previous')}
          {v.version !== current && item('Compare with current', actions.onCompareCurrent, 'menu-compare-current')}
          {v.version !== current && item(`Restore as v${current + 1}…`, actions.onRestore, 'menu-restore')}
          {item('Copy as new page', actions.onCopy, 'menu-copy')}
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
}

/**
 * One version in the history list.
 * @param props - See {@link VersionRowProps}.
 */
export function VersionRow({ v, current, change, previous, selected, onToggle, actions, touch }: VersionRowProps) {
  const isCurrent = v.version === current;
  const today = new Date(v.createdAt).toDateString() === new Date().toDateString();
  const from = restoredFrom(v);
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
        <Box on={selected} />
      </label>
      <div className="hx-row-main">
        <div className="hx-row-line">
          <span className="hx-v">v{v.version}</span>
          {isCurrent && <span className="hx-chip-s hx-chip-current">Current</span>}
          {converted && (
            <span className="hx-chip-s hx-chip-conv" data-testid={`converted-${v.version}`}>
              Converted from Markdown
            </span>
          )}
          {markdown && (
            <span
              className="hx-chip-s hx-chip-md"
              data-testid={`markdown-${v.version}`}
              title="Saved as Markdown, before the page was converted. Shown as it was."
            >
              Markdown
            </span>
          )}
          {from != null && <span className="hx-chip-s hx-chip-restore">Restore</span>}
          <span className="hx-when" title={fmtDateTime(v.createdAt)}>
            {today ? agoText(v.createdAt) : fmtDateTime(v.createdAt)}
          </span>
        </div>
        <div className="hx-row-who">
          <Avatar name={v.author} />
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
            {change.text}
          </div>
        )}
        <div className="hd-actions hx-actions" onClick={(e) => e.stopPropagation()}>
          {actions.onView && (
            <button type="button" className="st-btn st-btn-sm" onClick={actions.onView}>
              <Icon name="i36" size={13} strokeWidth={2} />
              {converted && previous != null ? `Compare with v${previous}` : 'View'}
            </button>
          )}
          {!isCurrent && actions.onOpen && (
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={actions.onOpen}
              data-testid={`read-version-${v.version}`}
            >
              <Icon name="page" size={13} strokeWidth={2} />
              Read
            </button>
          )}
          {!isCurrent && actions.onRestore && (
            <button type="button" className="st-btn st-btn-sm" onClick={actions.onRestore}>
              <Icon name="i19" size={13} strokeWidth={2} />
              Restore
            </button>
          )}
          {actions.onCopy && !touch && (
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={actions.onCopy}
              data-testid={`copy-version-${v.version}`}
            >
              Copy as new page
            </button>
          )}
          <RowMenu v={v} current={current} actions={actions} />
        </div>
      </div>
    </div>
  );
}
