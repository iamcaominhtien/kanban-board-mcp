/**
 * The tree's view (Tree, Gallery, Recent), sort and filters, remembered per project on this device.
 */

import { useCallback, useState } from 'react';
import { FILTER_KEYS, NO_FILTERS, type TreeFilters, type TreeSort, type TreeView } from './treeModel';

interface Stored {
  view: TreeView;
  sort: TreeSort;
  filters: TreeFilters;
}

const DEFAULTS: Stored = { view: 'tree', sort: 'edited', filters: NO_FILTERS };

/** Reads what was stored, keeping only values this version knows. */
export function readTreeViewState(projectId: string): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(`docsTreeView:${projectId}`) ?? 'null') as Partial<Stored> | null;
    if (!raw || typeof raw !== 'object') return DEFAULTS;
    const view = (['tree', 'gallery', 'recent'] as const).find((v) => v === raw.view) ?? 'tree';
    const sort = (['edited', 'title', 'tree'] as const).find((v) => v === raw.sort) ?? 'edited';
    const only = Array.isArray(raw.filters?.only) ? raw.filters.only.filter((k) => FILTER_KEYS.includes(k)) : [];
    const edited = (['any', 'today', 'week', 'month'] as const).find((v) => v === raw.filters?.edited) ?? 'any';
    return { view, sort, filters: { only, edited } };
  } catch {
    return DEFAULTS;
  }
}

/**
 * The state, and setters that remember it.
 * @param projectId - The project (each remembers its own).
 */
export function useTreeViewState(projectId: string) {
  const [state, setState] = useState<Stored>(() => readTreeViewState(projectId));
  const update = useCallback(
    (patch: Partial<Stored>) =>
      setState((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(`docsTreeView:${projectId}`, JSON.stringify(next));
        } catch {
          /* storage is optional */
        }
        return next;
      }),
    [projectId],
  );
  return {
    ...state,
    setView: useCallback((view: TreeView) => update({ view }), [update]),
    setSort: useCallback((sort: TreeSort) => update({ sort }), [update]),
    setFilters: useCallback((filters: TreeFilters) => update({ filters }), [update]),
  };
}
