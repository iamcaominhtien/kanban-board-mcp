/**
 * The tree header's controls (design "Rich Docs — organising pages", B 7-17): the switch between Tree, Gallery and
 * Recent with the sort, the Filter button with its panel (a bottom sheet on a phone), the chips of the filters that
 * are on, and the entries that start selecting or reordering pages.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { BottomSheet } from '../DocsSheets';
import { Icon } from '../Icon';
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
import './tree.css';

const VIEWS: { id: TreeView; label: string; sub: string; icon: string }[] = [
  { id: 'tree', label: 'Tree', sub: 'Pages in the order you set', icon: 'i48' },
  { id: 'gallery', label: 'Gallery', sub: 'Cards with covers', icon: 'i54' },
  { id: 'recent', label: 'Recent', sub: 'Flat list, newest first', icon: 'i39' },
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
 * The view switch: Tree, Gallery or Recent, the sort of the gallery and the recent list, and "Select pages" /
 * "Reorder pages".
 * @param props.onSelectMode - Starts selecting several pages; absent for a reader who can't edit.
 * @param props.onReorderMode - Starts the reorder mode (touch); absent where dragging is the way.
 */
export function ViewMenu({
  view,
  sort,
  onView,
  onSort,
  onSelectMode,
  onReorderMode,
}: {
  view: TreeView;
  sort: TreeSort;
  onView: (v: TreeView) => void;
  onSort: (s: TreeSort) => void;
  onSelectMode?: () => void;
  onReorderMode?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="tr-tool"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`View: ${current.label}`}
        data-testid="tree-view-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={current.icon} size={13} strokeWidth={1.9} />
        {current.label}
        <Icon name="chevronDown" size={11} strokeWidth={2.4} />
      </button>
      {open && (
        <div className="dk-menu tr-pop" role="menu" aria-label="View and sort">
          <div className="tr-pop-head">View</div>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitemradio"
              aria-checked={view === v.id}
              className="dk-mi tr-mi"
              data-testid={`tree-view-${v.id}`}
              onClick={pick(() => onView(v.id))}
            >
              <Icon name={v.icon} size={15} strokeWidth={1.8} />
              <span className="tr-mi-text">
                <span>{v.label}</span>
                <small>{v.sub}</small>
              </span>
              {view === v.id && <Icon name="check" size={14} strokeWidth={2.2} style={{ marginLeft: 'auto' }} />}
            </button>
          ))}
          {view !== 'tree' && (
            <>
              <div className="tr-pop-head">Sort</div>
              {(Object.keys(SORT_LABEL) as TreeSort[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort === s}
                  className="dk-mi tr-mi"
                  data-testid={`tree-sort-${s}`}
                  onClick={pick(() => onSort(s))}
                >
                  <span className="tr-mi-text">{SORT_LABEL[s]}</span>
                  {sort === s && <Icon name="check" size={14} strokeWidth={2.2} style={{ marginLeft: 'auto' }} />}
                </button>
              ))}
            </>
          )}
          {(onSelectMode || onReorderMode) && <div className="tr-pop-sep" />}
          {onSelectMode && (
            <button type="button" role="menuitem" className="dk-mi tr-mi" onClick={pick(onSelectMode)}>
              <Icon name="check" size={15} strokeWidth={1.8} />
              <span className="tr-mi-text">Select pages</span>
            </button>
          )}
          {onReorderMode && (
            <button
              type="button"
              role="menuitem"
              className="dk-mi tr-mi"
              data-testid="tree-reorder-mode"
              onClick={pick(onReorderMode)}
            >
              <Icon name="grip" size={15} strokeWidth={1.8} />
              <span className="tr-mi-text">Reorder pages</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
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
            className="dk-mi tr-mi"
            data-testid={`tree-filter-${k}`}
            onClick={() => toggle(k)}
          >
            <span className={`tr-check${on ? ' tr-check-on' : ''}`} aria-hidden="true">
              {on && <Icon name="check" size={11} strokeWidth={3} />}
            </span>
            <span className="tr-mi-text">{FILTER_LABEL[k]}</span>
            <span className="tr-count">{counts[k]}</span>
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
          className="st-btn st-btn-sm"
          disabled={activeFilterCount(filters) === 0}
          onClick={() => onChange(NO_FILTERS)}
        >
          Clear all
        </button>
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-primary"
          data-testid="tree-filter-show"
          onClick={onDone}
        >
          Show {shown} {shown === 1 ? 'page' : 'pages'}
        </button>
      </div>
    </div>
  );
}

/**
 * The Filter button with the number of choices on, and its panel: a popover, or a bottom sheet on a phone.
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
  const ref = useRef<HTMLDivElement>(null);
  const phone = layout === 'phone';
  useDismiss(open && !phone, ref, () => setOpen(false));
  const n = activeFilterCount(filters);
  const choices = (
    <FilterChoices filters={filters} counts={counts} shown={shown} onChange={onChange} onDone={() => setOpen(false)} />
  );
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`tr-tool${n ? ' tr-tool-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={n ? `Filter, ${n} on` : 'Filter'}
        data-testid="tree-filter"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="filter" size={13} strokeWidth={1.9} />
        Filter
        {n > 0 && <span className="tr-badge">{n}</span>}
      </button>
      {open &&
        (phone ? (
          <BottomSheet label="Filter pages" onClose={() => setOpen(false)} testId="tree-filter-sheet">
            <div className="st-hint" style={{ padding: '0 16px 6px' }}>
              Choices combine: a page must match all of them.
            </div>
            {choices}
          </BottomSheet>
        ) : (
          <div className="dk-menu tr-pop tr-pop-wide" role="dialog" aria-label="Filter pages">
            {choices}
          </div>
        ))}
    </div>
  );
}

/** The chips of the filters that are on, each with ×, under the search box. */
export function FilterChips({ filters, onChange }: { filters: TreeFilters; onChange: (f: TreeFilters) => void }) {
  if (activeFilterCount(filters) === 0) return null;
  const chip = (key: string, label: ReactNode, off: () => void) => (
    <span key={key} className="tr-chip">
      {label}
      <button type="button" aria-label={`Remove filter ${String(label)}`} onClick={off}>
        <Icon name="close" size={10} strokeWidth={2.6} />
      </button>
    </span>
  );
  return (
    <div className="tr-chips" data-testid="tree-filter-chips">
      {filters.only.map((k) =>
        chip(k, FILTER_LABEL[k], () => onChange({ ...filters, only: filters.only.filter((x) => x !== k) })),
      )}
      {filters.edited !== 'any' &&
        chip('edited', `Edited ${EDITED_LABEL[filters.edited].toLowerCase()}`, () =>
          onChange({ ...filters, edited: 'any' }),
        )}
    </div>
  );
}
