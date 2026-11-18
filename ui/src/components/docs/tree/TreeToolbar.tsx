/**
 * The tree header's controls (design "Rich Docs — organising pages", B 7-17): the switch between Tree, Gallery and
 * Recent with the sort, the Filter button with its panel (a bottom sheet on a phone), the chips of the filters that
 * are on, and the entries that start selecting or reordering pages.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { BottomSheet } from '../DocsSheets';
import {
  activeFilterCount,
  EDITED_LABEL,
  FILTER_KEYS,
  FILTER_LABEL,
  NO_FILTERS,
  SORT_LABEL,
  type EditedWithin,
  type FilterKey,
  type TreeFilters,
  type TreeSort,
  type TreeView,
} from './treeModel';
import { BoardIcon, type BoardIconName } from './boardIcons';
import './tree.css';

const VIEWS: { id: TreeView; label: string; sub: string; icon: BoardIconName }[] = [
  { id: 'tree', label: 'Tree', sub: 'Pages in the order you set', icon: 'viewTree' },
  { id: 'gallery', label: 'Gallery', sub: 'Cards with covers', icon: 'viewGallery' },
  { id: 'recent', label: 'Recent', sub: 'Flat list, newest first', icon: 'viewRecent' },
];

/** Closes a popover on a mousedown outside it or Esc. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, ref, close]);
}

/**
 * The view switch of the tree header (organising pages, B 7-12): Tree, Gallery and Recent as a three-icon segmented
 * control, each with its name as the tooltip.
 */
export function ViewSwitch({ view, onView }: { view: TreeView; onView: (v: TreeView) => void }) {
  return (
    <span className="tr-seg" role="radiogroup" aria-label="View" data-testid="tree-view-menu">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={view === v.id}
          aria-label={`${v.label}: ${v.sub}`}
          title={`${v.label} · ${v.sub}`}
          data-testid={`tree-view-${v.id}`}
          onClick={() => onView(v.id)}
        >
          <BoardIcon name={v.icon} size={16} strokeWidth={1.9} />
        </button>
      ))}
    </span>
  );
}

/**
 * The sort of the gallery and the recent list (organising pages, B 11): "Sort Recently edited ▾" and its menu.
 * @param props.sort - The sort in use.
 * @param props.onSort - Called with the sort picked.
 */
export function SortMenu({ sort, onSort }: { sort: TreeSort; onSort: (s: TreeSort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div ref={ref} className="tr-sort">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort: ${SORT_LABEL[sort]}`}
        data-testid="tree-sort"
        onClick={() => setOpen((v) => !v)}
      >
        <BoardIcon name="sort" size={13} strokeWidth={2} />
        <span>Sort</span>
        {SORT_LABEL[sort]}
        <BoardIcon name="chevronDown" size={12} strokeWidth={2.2} color="#5B6B60" />
      </button>
      {open && (
        <div className="dk-menu" role="menu" aria-label="Sort">
          {(Object.keys(SORT_LABEL) as TreeSort[]).map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={sort === s}
              className="dk-mi tr-mi"
              data-testid={`tree-sort-${s}`}
              onClick={() => {
                setOpen(false);
                onSort(s);
              }}
            >
              <span style={{ width: 14, display: 'inline-flex', flex: 'none' }}>
                {sort === s && <BoardIcon name="check" size={14} strokeWidth={1.9} />}
              </span>
              <span>{SORT_LABEL[s]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The mark a filter choice carries before its name (organising pages, B 15): the status dot of drafts, unpublished
 * changes and may be outdated, the ✦ of suggestions, the book of books; `null` for "My pages".
 */
export function FilterMark({ k }: { k: FilterKey }) {
  if (k === 'drafts') return <span className="tr-dot" style={{ background: '#C98A1B' }} />;
  if (k === 'unpublished') return <span className="tr-dot" style={{ background: '#2F6FB0' }} />;
  if (k === 'outdated') return <span className="tr-dot" style={{ border: '2px solid #C98A1B' }} />;
  if (k === 'suggestions') return <BoardIcon name="spark" size={13} strokeWidth={2.2} color="#5B3FA8" />;
  if (k === 'books') return <BoardIcon name="book" size={13} strokeWidth={2.2} color="#1F5A31" />;
  return null;
}

/**
 * The choices of the filter: "Show only" (they combine), how recently edited, Clear all and "Show N pages".
 * @param props.counts - How many pages each choice keeps on its own.
 * @param props.shown - How many pages the filters keep together.
 * @param props.onDone - Closes the panel.
 */
export function FilterChoices({
  filters,
  counts,
  shown,
  onChange,
  onDone,
}: {
  filters: TreeFilters;
  counts: Record<FilterKey, number>;
  shown: number;
  onChange: (f: TreeFilters) => void;
  onDone: () => void;
}) {
  const toggle = (k: FilterKey) =>
    onChange({
      ...filters,
      only: filters.only.includes(k) ? filters.only.filter((x) => x !== k) : [...filters.only, k],
    });
  return (
    <div className="tr-filter" data-testid="tree-filter-panel">
      <div className="tr-pop-head">Show only</div>
      {FILTER_KEYS.map((k) => {
        const on = filters.only.includes(k);
        return (
          <button
            key={k}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            className="tr-fopt"
            data-testid={`tree-filter-${k}`}
            onClick={() => toggle(k)}
          >
            <span className={`tr-check${on ? ' tr-check-on' : ''}`} aria-hidden="true">
              {on && <BoardIcon name="check" size={12} strokeWidth={3.2} />}
            </span>
            <FilterMark k={k} />
            <span>{FILTER_LABEL[k]}</span>
            <span className="tr-fopt-count">{counts[k]}</span>
          </button>
        );
      })}
      <div className="tr-pop-head">Edited</div>
      <div className="tr-pills" role="radiogroup" aria-label="Edited">
        {(Object.keys(EDITED_LABEL) as EditedWithin[]).map((e) => (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={filters.edited === e}
            className={`tr-pill${filters.edited === e ? ' tr-pill-on' : ''}`}
            onClick={() => onChange({ ...filters, edited: e })}
          >
            {EDITED_LABEL[e]}
          </button>
        ))}
      </div>
      <div className="tr-filter-foot">
        <button
          type="button"
          className="tr-link"
          disabled={activeFilterCount(filters) === 0}
          onClick={() => onChange(NO_FILTERS)}
        >
          Clear all
        </button>
        <span />
        <button type="button" className="st-btn st-btn-primary" data-testid="tree-filter-show" onClick={onDone}>
          Show {shown} {shown === 1 ? 'page' : 'pages'}
        </button>
      </div>
    </div>
  );
}

/**
 * The Filter button with the number of choices on, and its panel: on a desktop a popover beside the tree with its
 * arrow at the button (organising pages, B 15), a bottom sheet on a phone.
 * @param props.layout - The Docs area's layout.
 */
export function FilterButton({
  layout,
  filters,
  counts,
  shown,
  onChange,
}: {
  layout: DocsLayout;
  filters: TreeFilters;
  counts: Record<FilterKey, number>;
  shown: number;
  onChange: (f: TreeFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const phone = layout === 'phone';
  useDismiss(open && !phone, ref, () => setOpen(false));
  const n = activeFilterCount(filters);
  const choices = (
    <FilterChoices filters={filters} counts={counts} shown={shown} onChange={onChange} onDone={() => setOpen(false)} />
  );
  function toggle(btn: HTMLElement) {
    if (open) return setOpen(false);
    const b = btn.getBoundingClientRect();
    // beside the tree panel, the arrow (26 px down the popover) level with the middle of the button
    const panel = btn.closest('aside')?.getBoundingClientRect();
    const left = Math.min((panel?.right ?? b.right) + 4, window.innerWidth - 334);
    setAt({ left, top: Math.max(8, b.top + b.height / 2 - 26) });
    setOpen(true);
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`tr-tool${n ? ' tr-tool-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={n ? `Filter, ${n} on` : 'Filter'}
        data-testid="tree-filter"
        onClick={(e) => toggle(e.currentTarget)}
      >
        <BoardIcon name="filter" size={13} strokeWidth={2} />
        Filter
        {n > 0 && <span className="tr-badge">{n}</span>}
      </button>
      {open &&
        (phone ? (
          <BottomSheet label="Filter pages" onClose={() => setOpen(false)} testId="tree-filter-sheet" hideTitle>
            {/* Tree1 16: a 16 px title over a muted line, 48 px choices, two 48 px buttons */}
            <div className="tr-fsheet-head">
              <div className="tr-fsheet-title">Filter pages</div>
              <div className="tr-fsheet-sub">Choices combine: a page must match all of them.</div>
            </div>
            {choices}
          </BottomSheet>
        ) : (
          <div className="tr-filterpop" style={at ?? undefined}>
            <span className="tr-hc-arrow" />
            <div className="dk-menu" role="dialog" aria-label="Filter pages">
              {choices}
            </div>
          </div>
        ))}
    </div>
  );
}

/** The chips of the filters that are on, each with ×, under the toolbar. */
export function FilterChips({ filters, onChange }: { filters: TreeFilters; onChange: (f: TreeFilters) => void }) {
  if (activeFilterCount(filters) === 0) return null;
  const chip = (key: string, label: string, mark: ReactNode, off: () => void) => (
    <span key={key} className="tr-chip">
      {mark}
      {label}
      <button type="button" aria-label={`Remove filter ${label}`} onClick={off}>
        <BoardIcon name="close" size={11} strokeWidth={2.6} />
      </button>
    </span>
  );
  return (
    <div className="tr-chips" data-testid="tree-filter-chips">
      {filters.only.map((k) =>
        chip(k, FILTER_LABEL[k], k === 'suggestions' || k === 'books' ? null : <FilterMark k={k} />, () =>
          onChange({ ...filters, only: filters.only.filter((x) => x !== k) }),
        ),
      )}
      {filters.edited !== 'any' &&
        chip('edited', `Edited ${EDITED_LABEL[filters.edited].toLowerCase()}`, null, () =>
          onChange({ ...filters, edited: 'any' }),
        )}
    </div>
  );
}
