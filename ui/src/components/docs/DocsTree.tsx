import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import type { DocsTreeNode } from '../../types/docs';
import { Icon } from './Icon';
import { TreeEmpty } from './DocsStates';
import { NoMatch } from './tree/PageViews';
import { SelectionBar } from './tree/SelectionBar';
import { FilterButton, FilterChips, ViewMenu } from './tree/TreeToolbar';
import {
  activeFilterCount,
  affectedPages,
  buildRows,
  chapterNumbers,
  describeTarget,
  filterCounts,
  isBook,
  keyboardMove,
  matchesFilters,
  NO_FILTERS,
  rowStatus,
  selectionRoots,
  type MoveDir,
  type TreeFilters,
  type TreeRow,
  type TreeSort,
  type TreeView,
} from './tree/treeModel';
import { ConvertMark, HoverCard, PageIcon, StatusDot, useHoverCard } from './tree/treeParts';
import { SuggestionMarker } from './suggestions/extras';

interface Props {
  projectId: string;
  projectName: string;
  nodes: DocsTreeNode[];
  selectedId: string | null;
  /** Pages whose content is loading right now (row spinner). */
  loadingId?: string | null;
  onSelect: (id: string) => void;
  onNewPage: (parentId: string | null) => void;
  /** The New page menu (From template, Import, Paste), opened by the arrow beside New page; `close` dismisses it. */
  renderNewPageMenu?: (close: () => void) => ReactNode;
  /** The reader can't edit this space: no add buttons. */
  readOnly?: boolean;
  /** Rename inline: the tree asks the lead to decide between a plain rename and the rewrite-links dialog. */
  onRequestRename: (node: DocsTreeNode, title: string) => void;
  /** Controlled inline rename (F2 or the row menu). */
  renamingId: string | null;
  onRenamingChange: (id: string | null) => void;
  /** Drag and drop; the returned promise keeps the row spinner on while the move saves. */
  onMove: (
    id: string,
    parentId: string | null,
    beforeId: string | null,
    afterId: string | null,
  ) => Promise<unknown> | void;
  onCollapse: () => void;
  /** Row "···" menu content (PageMenu for that page). */
  renderMenu: (node: DocsTreeNode, close: () => void) => ReactNode;
  /** Enter in the filter / "Search page content". */
  onOpenSearch?: (query: string) => void;
  /** Fill the filter box from outside (the palette's "Filter the tree instead"); a new `n` re-applies it. */
  filterRequest?: { q: string; n: number } | null;
  /** Slot in the header, next to the collapse button (Follow space). */
  headerExtra?: ReactNode;
  /** Buttons in the header before the bell and the collapse button (e.g. open Docs in its own window). */
  headerActions?: ReactNode;
  /** Docs AI is on for the project: two rows above the page list, and the hidden / guidance marks on pages. */
  aiOn?: boolean;
  /** "Ask the docs" row (opens the search palette in Ask mode). */
  onAskDocs?: () => void;
  /** "Docs health" row, with the number of things to look at. */
  onHealth?: () => void;
  healthActive?: boolean;
  healthCount?: number;
  /** The Docs area's layout: hover cards on a desktop; long-press drag and the reorder mode on touch. */
  layout?: DocsLayout;
  /** Tree, Gallery or Recent (the switch in the header) and the sort of the last two; no switch when absent. */
  view?: TreeView;
  onViewChange?: (v: TreeView) => void;
  sort?: TreeSort;
  onSortChange?: (s: TreeSort) => void;
  /** The filters (they combine) and their change; no Filter button when `onFiltersChange` is absent. */
  filters?: TreeFilters;
  onFiltersChange?: (f: TreeFilters) => void;
  /** Who is looking (DocsAccess.me), for "My pages". */
  me?: string;
  /** Several pages picked: the action and the picked pages none of whose parents is picked, in tree order. */
  onBulk?: (action: 'move' | 'duplicate' | 'export' | 'delete', roots: string[]) => void;
  /** "Move to…" for one page (M on a row, the reorder mode's button). */
  onMoveTo?: (node: DocsTreeNode) => void;
  /** Pages in the Recycle Bin and opening it (the row under the tree); no row when absent. */
  binCount?: number;
  onOpenBin?: () => void;
}

type Row = TreeRow;

type Zone = 'before' | 'after' | 'nest';
interface Drop {
  rowId: string;
  zone: Zone;
  /** nest zone held for 400 ms */
  nestReady: boolean;
}

const INDENT = 20;
const WIDTH_KEY = 'docsTreeWidth';
const WIDTH_MIN = 220;
const WIDTH_MAX = 520;
const WIDTH_DEFAULT = 280;

function maxWidth() {
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, window.innerWidth - 80));
}

function clampWidth(w: number) {
  return Math.round(Math.min(Math.max(w, WIDTH_MIN), maxWidth()));
}

function readWidth() {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v > 0 ? clampWidth(v) : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* storage is optional */
  }
}

/** Drag (or arrow keys) on the tree's right edge to resize it; double-click resets. */
function ResizeHandle({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const [active, setActive] = useState(false);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    setActive(true);
    const move = (ev: PointerEvent) => {
      last = clampWidth(startW + ev.clientX - startX);
      onChange(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setActive(false);
      saveWidth(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = clampWidth(width + (e.key === 'ArrowRight' ? 16 : -16));
    onChange(w);
    saveWidth(w);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize page tree"
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className={`dk-tree-resize${active ? ' dk-tree-resize-on' : ''}`}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onChange(WIDTH_DEFAULT);
        saveWidth(WIDTH_DEFAULT);
      }}
    />
  );
}

/** Page title that ends in an ellipsis; shows the full title in a tooltip right away, only when it is cut off. */
function TitleTip({ title, suppressed, children }: { title: string; suppressed: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function show() {
    const el = ref.current;
    if (!el || suppressed || el.scrollWidth <= el.clientWidth) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 6 });
  }

  return (
    <span
      ref={ref}
      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onPointerDown={() => setPos(null)}
    >
      {children}
      {pos &&
        !suppressed &&
        createPortal(
          <div
            role="tooltip"
            className="dk-tt"
            style={{
              position: 'fixed',
              left: Math.min(pos.x, window.innerWidth - 328),
              top: pos.y,
              zIndex: 10000,
              maxWidth: 320,
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              fontWeight: 500,
              pointerEvents: 'none',
            }}
          >
            {title}
          </div>,
          document.body,
        )}
    </span>
  );
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: '#FBE7A6', color: 'inherit', borderRadius: 2, padding: '0 1px', margin: '0 -1px' }}>
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * Page tree with drag-to-reorder, filter, rename and row menu.
 * @param props.nodes - Flat page tree nodes.
 * @param props.selectedId - Currently open page id.
 * @param props.loadingId - Page whose content is loading (row spinner).
 * @param props.onSelect - Called with the id of the clicked page.
 * @param props.onNewPage - Called with the parent page id, or `null` for a root page.
 * @param props.renderNewPageMenu - Renders the New page menu beside the New page button.
 * @param props.readOnly - Hides the add-page buttons when the reader can't edit the space.
 * @param props.onRequestRename - Called with the node and typed title; the lead decides between a plain rename and the rewrite-links dialog.
 * @param props.renamingId - Page being renamed inline (controlled), or `null`.
 * @param props.onRenamingChange - Called to start or stop inline rename.
 * @param props.onMove - Called with moved id, new parent and the siblings before and after it; a returned promise keeps the row spinner on while saving.
 * @param props.onCollapse - Called to collapse the tree.
 * @param props.renderMenu - Renders the row "···" menu content; `close` dismisses the menu.
 * @param props.onOpenSearch - Called with the filter text on Enter or "Search page content".
 * @param props.filterRequest - Sets the filter text and focuses the box when its `n` changes.
 * @param props.headerExtra - Slot in the header next to the collapse button.
 * @param props.headerActions - Buttons in the header before the bell and the collapse button.
 */
export function DocsTree({
  projectId,
  projectName,
  nodes,
  selectedId,
  loadingId,
  onSelect,
  onNewPage,
  renderNewPageMenu,
  readOnly,
  onRequestRename,
  renamingId,
  onRenamingChange,
  onMove,
  onCollapse,
  renderMenu,
  onOpenSearch,
  filterRequest,
  headerExtra,
  headerActions,
  aiOn,
  onAskDocs,
  onHealth,
  healthActive,
  healthCount,
  layout = 'desktop',
  view = 'tree',
  onViewChange,
  sort = 'edited',
  onSortChange,
  filters = NO_FILTERS,
  onFiltersChange,
  me = '',
  onBulk,
  onMoveTo,
  binCount,
  onOpenBin,
}: Props) {
  const storageKey = `docsTreeClosed:${projectId}`;
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
    } catch {
      return new Set();
    }
  });
  const [filter, setFilter] = useState('');
  const [filterFocus, setFilterFocus] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [width, setWidth] = useState(readWidth);
  const filterRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{ id: string; sx: number; sy: number; started: boolean } | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const suppressClick = useRef(false);
  const touch = layout !== 'desktop';
  // several pages picked (checkboxes), the anchor of a Shift-click range
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  // the touch reorder mode and the page its buttons move
  const [reorder, setReorder] = useState(false);
  const [reorderId, setReorderId] = useState<string | null>(null);
  // what a keyboard move said, for screen readers
  const [announce, setAnnounce] = useState('');
  const longPress = useRef<number | undefined>(undefined);

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, DocsTreeNode[]>();
    for (const n of nodes) {
      const k = n.parentId && byId.has(n.parentId) ? n.parentId : null;
      (m.get(k) ?? m.set(k, []).get(k)!).push(n);
    }
    m.forEach((list) => list.sort((a, b) => a.position - b.position));
    return m;
  }, [nodes, byId]);

  // keep the selected page visible: open its ancestors
  useEffect(() => {
    if (!selectedId) return;
    let cur = byId.get(selectedId)?.parentId ?? null;
    const need: string[] = [];
    while (cur) {
      need.push(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    if (need.some((id) => closed.has(id))) {
      setClosed((prev) => {
        const next = new Set(prev);
        need.forEach((id) => next.delete(id));
        persist(next);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, byId]);

  const q = filter.trim();
  const filtering = activeFilterCount(filters) > 0;
  // "now" for the age rules moves on with the tree, not with every render
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `nodes` stands for "the tree changed": a new now
  const ctx = useMemo(() => ({ me, now: new Date() }), [me, nodes]);
  const rows = useMemo<Row[]>(() => buildRows(nodes, { closed, q, filters, ctx }), [nodes, closed, q, filters, ctx]);
  const chapters = useMemo(() => chapterNumbers(nodes), [nodes]);
  const counts = useMemo(() => filterCounts(nodes, ctx), [nodes, ctx]);
  const filterShown = useMemo(() => nodes.filter((n) => matchesFilters(n, filters, ctx)).length, [nodes, filters, ctx]);
  const affected = useMemo(() => affectedPages(nodes, picked), [nodes, picked]);
  const hover = useHoverCard(!touch && !drag && !menu && !selectMode && !reorder);

  const matchCount = q || filtering ? rows.filter((r) => !r.dim).length : 0;

  function toggle(id: string) {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  }
  function expand(id: string) {
    setClosed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      persist(next);
      return next;
    });
  }

  useEffect(() => {
    if (!filterRequest) return;
    setFilter(filterRequest.q);
    filterRef.current?.focus();
  }, [filterRequest]);

  // "/" focuses the filter when focus is not in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // close the row menu on outside click / Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const t = setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /* ---------- drag and drop (pointer based: floating chip, insertion line, nest) ---------- */

  const isInside = useCallback(
    (id: string, ancestor: string) => {
      let cur: string | null = id;
      while (cur) {
        if (cur === ancestor) return true;
        cur = byId.get(cur)?.parentId ?? null;
      }
      return false;
    },
    [byId],
  );

  const computeDrop = useCallback(
    (x: number, y: number, dragId: string): Drop | null => {
      void x;
      let hit: { row: Row; rect: DOMRect } | null = null;
      for (const r of rows) {
        const el = rowEls.current.get(r.node.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (y >= rect.top && y < rect.bottom) hit = { row: r, rect };
      }
      if (!hit) {
        const roots = rows.filter((r) => r.depth === 0);
        const body = bodyRef.current?.getBoundingClientRect();
        const last = roots[roots.length - 1];
        if (!last || !body || y < body.top || y > body.bottom) return null;
        const lastEl = rowEls.current.get(rows[rows.length - 1].node.id)?.getBoundingClientRect();
        if (!lastEl || y < lastEl.bottom) return null;
        return isInside(last.node.id, dragId) ? null : { rowId: last.node.id, zone: 'after', nestReady: false };
      }
      if (isInside(hit.row.node.id, dragId)) return null;
      const rel = (y - hit.rect.top) / hit.rect.height;
      const zone: Zone = rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'nest';
      const prev = dropRef.current;
      return {
        rowId: hit.row.node.id,
        zone,
        nestReady: zone === 'nest' && prev?.rowId === hit.row.node.id && prev.zone === 'nest' ? prev.nestReady : false,
      };
    },
    [rows, isInside],
  );

  useEffect(() => {
    dropRef.current = drop;
  }, [drop]);

  // 400 ms in the middle of a row = nest; 800 ms on a collapsed folder = expand it
  useEffect(() => {
    if (!drop || drop.zone !== 'nest') return;
    const t1 = setTimeout(
      () => setDrop((d) => (d && d.rowId === drop.rowId && d.zone === 'nest' ? { ...d, nestReady: true } : d)),
      400,
    );
    const row = rows.find((r) => r.node.id === drop.rowId);
    const t2 = row && row.hasChildren && !row.open ? setTimeout(() => expand(drop.rowId), 800) : null;
    return () => {
      clearTimeout(t1);
      if (t2) clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drop?.rowId, drop?.zone]);

  function startPointer(e: React.PointerEvent, id: string) {
    if (e.button !== 0 || q || filtering || renamingId || selectMode) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    // touch: hold half a second to lift the row (a quick swipe still scrolls the tree); the reorder mode's handle
    // lifts it at once; a mouse drags after 5 px
    const byTouch = e.pointerType !== 'mouse';
    const handle = !!(e.target as HTMLElement).closest('[data-drag-handle]');
    const held = byTouch && !(reorder && handle);
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, started: false };
    let armed = !held;
    let last = { x: e.clientX, y: e.clientY };
    const lift = () => {
      const d = dragRef.current;
      if (!d) return;
      d.started = true;
      armed = true;
      navigator.vibrate?.(10);
      setDrag({ id: d.id, x: last.x, y: last.y });
      setDrop(computeDrop(last.x, last.y, d.id));
    };
    if (held) longPress.current = window.setTimeout(lift, 500);
    // while a row is lifted on touch, the finger moves it instead of scrolling the drawer
    const noScroll = (ev: TouchEvent) => {
      if (dragRef.current?.started) ev.preventDefault();
    };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      last = { x: ev.clientX, y: ev.clientY };
      if (!armed) {
        // moved before the hold ended: this is a scroll, not a drag
        if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 8) cancel();
        return;
      }
      if (!d.started && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 5) return;
      d.started = true;
      setDrag({ id: d.id, x: ev.clientX, y: ev.clientY });
      setDrop(computeDrop(ev.clientX, ev.clientY, d.id));
      // the tree scrolls at its top and bottom edge
      const body = bodyRef.current;
      const box = body?.getBoundingClientRect();
      if (body && box) {
        if (ev.clientY < box.top + 36) body.scrollTop -= 10;
        else if (ev.clientY > box.bottom - 36) body.scrollTop += 10;
      }
    };
    const detach = () => {
      window.clearTimeout(longPress.current);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('touchmove', noScroll);
    };
    const cancel = () => {
      detach();
      dragRef.current = null;
      setDrag(null);
      setDrop(null);
    };
    const up = () => {
      detach();
      const d = dragRef.current;
      dragRef.current = null;
      const target = dropRef.current;
      setDrag(null);
      setDrop(null);
      if (!d?.started) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (target) void commitDrop(d.id, target);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', esc);
    window.addEventListener('touchmove', noScroll, { passive: false });
  }

  /** Moves a page by the keyboard or the reorder buttons, and says where it went. */
  async function moveBy(id: string, dir: MoveDir) {
    const t = keyboardMove(nodes, id, dir);
    const n = byId.get(id);
    if (!n) return;
    if (!t) {
      setAnnounce(
        dir === 'up'
          ? `${n.title} is already first`
          : dir === 'down'
            ? `${n.title} is already last`
            : dir === 'out'
              ? `${n.title} is already at the top level`
              : `${n.title} has no page above it to go into`,
      );
      return;
    }
    setAnnounce(`${describeTarget(nodes, t, 'Moving', id).replace(/^Moving/, `Moving ${n.title}`)}`);
    if (t.parentId) expand(t.parentId);
    setMovingId(id);
    try {
      await onMove(id, t.parentId, t.beforeId, t.afterId);
    } finally {
      setMovingId(null);
      // the row is drawn again in its new place: keep the focus on it
      setTimeout(() => rowEls.current.get(id)?.focus(), 0);
    }
  }

  /* ---------- selecting several pages ---------- */

  function togglePick(id: string, range: boolean) {
    setSelectMode(true);
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current) {
        const ids = rows.map((r) => r.node.id);
        const a = ids.indexOf(anchor.current);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      return next;
    });
  }

  function endSelect() {
    setSelectMode(false);
    setPicked(new Set());
    anchor.current = null;
  }

  function bulk(action: 'move' | 'duplicate' | 'export' | 'delete') {
    const roots = selectionRoots(nodes, picked);
    if (!roots.length) return;
    onBulk?.(action, roots);
    if (action !== 'export' && action !== 'delete' && action !== 'move') endSelect();
  }

  // a page that left the tree (deleted, moved away by someone) leaves the selection too
  useEffect(() => {
    setPicked((prev) => {
      const kept = [...prev].filter((id) => byId.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [byId]);

  /** Where a drop lands: parent plus neighbour ids. */
  function landing(
    rowId: string,
    zone: Zone,
  ): { parentId: string | null; beforeId: string | null; afterId: string | null; depth: number } | null {
    const row = rows.find((r) => r.node.id === rowId);
    if (!row) return null;
    const n = row.node;
    if (zone === 'before') return { parentId: n.parentId, beforeId: n.id, afterId: null, depth: row.depth };
    if (zone === 'nest') {
      const kids = childrenOf.get(n.id) ?? [];
      return {
        parentId: n.id,
        beforeId: null,
        afterId: kids.length ? kids[kids.length - 1].id : null,
        depth: row.depth + 1,
      };
    }
    const kids = childrenOf.get(n.id) ?? [];
    if (row.open && kids.length) return { parentId: n.id, beforeId: kids[0].id, afterId: null, depth: row.depth + 1 };
    return { parentId: n.parentId, beforeId: null, afterId: n.id, depth: row.depth };
  }

  async function commitDrop(id: string, target: Drop) {
    const zone: Zone = target.zone === 'nest' && !target.nestReady ? 'after' : target.zone;
    const l = landing(target.rowId, zone);
    if (!l || l.parentId === id || l.beforeId === id || l.afterId === id) return;
    setMovingId(id);
    try {
      await onMove(id, l.parentId, l.beforeId, l.afterId);
    } finally {
      setMovingId(null);
    }
  }

  /* ---------- rows ---------- */

  const dragNode = drag ? byId.get(drag.id) : null;
  const dropLanding = drop && !(drop.zone === 'nest') ? landing(drop.rowId, drop.zone) : null;
  const dragKids = dragNode ? affectedPages(nodes, [dragNode.id]).size - 1 : 0;
  // the tip under the dragged chip says the outcome in words (frame 21)
  let dragTip = '';
  if (drag && dragNode) {
    if (!drop) {
      const under = rows.find((r) => {
        const box = rowEls.current.get(r.node.id)?.getBoundingClientRect();
        return !!box && drag.y >= box.top && drag.y < box.bottom;
      });
      dragTip =
        under && isInside(under.node.id, dragNode.id) ? 'A page cannot go inside itself' : 'Drop it in the tree';
    } else if (drop.zone === 'nest') {
      const over = rows.find((r) => r.node.id === drop.rowId);
      const target = landing(drop.rowId, 'nest');
      dragTip =
        over && over.hasChildren && !over.open
          ? `Hold to open ${over.node.title}`
          : drop.nestReady && target
            ? describeTarget(nodes, target, 'Move', dragNode.id)
            : `Hold to move under ${over?.node.title ?? ''}`;
    } else if (dropLanding) dragTip = describeTarget(nodes, dropLanding, 'Move', dragNode.id);
  }

  function indicator(depth: number) {
    return (
      <div
        aria-hidden="true"
        data-testid="drop-line"
        style={{ position: 'relative', height: 0, margin: `0 4px 0 ${16 + depth * INDENT}px`, zIndex: 3 }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: -1,
            height: 2,
            borderRadius: 1,
            background: '#2E6F40',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: -3,
            top: -4,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#FFFFFF',
            border: '2px solid #2E6F40',
            boxSizing: 'border-box',
          }}
        />
      </div>
    );
  }

  function renderRow(r: Row) {
    const n = r.node;
    const active = n.id === selectedId;
    const isDrag = drag?.id === n.id;
    const nesting = drop?.rowId === n.id && drop.zone === 'nest' && drop.nestReady;
    const renaming = renamingId === n.id;
    const status = rowStatus(n, ctx.now);
    const chapter = chapters.get(n.id);
    const pickedHere = picked.has(n.id);
    // a child of a picked page comes with it: a lighter check it can't take off
    const follows = !pickedHere && affected.has(n.id);
    const book = isBook(n);
    const lifted = reorder && reorderId === n.id;
    return (
      <Fragment key={n.id}>
        {dropLanding && drop?.zone === 'before' && drop.rowId === n.id && indicator(dropLanding.depth)}
        <div
          ref={(el) => {
            if (el) rowEls.current.set(n.id, el);
            else rowEls.current.delete(n.id);
          }}
          className={`dk-tree-row${active ? ' dk-tree-active' : ''}${isDrag ? ' dk-row-dim' : ''}${nesting ? ' dk-row-nest' : ''}${menu?.id === n.id ? ' dk-tree-hover' : ''}${pickedHere || follows ? ' tr-row-picked' : ''}${lifted ? ' tr-row-lifted' : ''}`}
          style={{
            opacity: r.dim && !isDrag ? 0.6 : undefined,
            // touch scrolls the tree; a long press lifts the row (then the finger moves it)
            touchAction: touch ? 'pan-y' : 'none',
            userSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
          role="treeitem"
          aria-level={r.depth + 1}
          aria-selected={selectMode ? pickedHere || follows : active}
          aria-current={active ? 'page' : undefined}
          aria-expanded={r.hasChildren ? r.open : undefined}
          tabIndex={0}
          data-testid={`tree-row-${n.slug}`}
          data-page-id={n.id}
          data-status={status.key}
          onPointerDown={(e) => startPointer(e, n.id)}
          {...hover.bind(n.id)}
          onContextMenu={(e) => {
            // right-click opens the row menu where the pointer is; a long press on touch lifts the row instead
            e.preventDefault();
            if (touch || renaming) return;
            hover.hide();
            setMenu({ id: n.id, left: e.clientX + 290, top: e.clientY - 6 });
          }}
          onClick={(e) => {
            if (suppressClick.current || renaming) return;
            if (reorder) {
              setReorderId((cur) => (cur === n.id ? null : n.id));
              return;
            }
            if (selectMode || ((e.ctrlKey || e.metaKey || e.shiftKey) && onBulk)) {
              if (follows) return;
              togglePick(n.id, e.shiftKey);
              return;
            }
            onSelect(n.id);
          }}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.altKey && e.shiftKey && !readOnly && !q && !filtering) {
              const dir: MoveDir | null =
                e.key === 'ArrowUp'
                  ? 'up'
                  : e.key === 'ArrowDown'
                    ? 'down'
                    : e.key === 'ArrowLeft'
                      ? 'out'
                      : e.key === 'ArrowRight'
                        ? 'in'
                        : null;
              if (dir) {
                e.preventDefault();
                e.stopPropagation();
                void moveBy(n.id, dir);
                return;
              }
            }
            if (!e.altKey && !e.ctrlKey && !e.metaKey && !readOnly) {
              if (e.key === 'F2') {
                e.preventDefault();
                e.stopPropagation();
                onRenamingChange(n.id);
                return;
              }
              if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                onNewPage(n.id);
                return;
              }
              if ((e.key === 'm' || e.key === 'M') && !e.shiftKey && onMoveTo) {
                e.preventDefault();
                e.stopPropagation();
                onMoveTo(n);
                return;
              }
            }
            if (e.key === 'Escape' && (selectMode || reorder)) {
              endSelect();
              setReorder(false);
              return;
            }
            if (selectMode && e.key === ' ') {
              e.preventDefault();
              if (!follows) togglePick(n.id, e.shiftKey);
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(n.id);
            } else if (e.key === 'ArrowRight' && r.hasChildren && !r.open) toggle(n.id);
            else if (e.key === 'ArrowLeft' && r.hasChildren && r.open) toggle(n.id);
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const i = rows.findIndex((x) => x.node.id === n.id) + (e.key === 'ArrowDown' ? 1 : -1);
              if (rows[i]) rowEls.current.get(rows[i].node.id)?.focus();
            }
          }}
        >
          <span
            className={`dk-hov${reorder ? ' tr-handle-on' : ''}`}
            data-drag-handle=""
            style={{
              position: 'absolute',
              left: 1,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 12,
              display: 'flex',
              justifyContent: 'center',
              color: '#9AA8A0',
              cursor: 'grab',
            }}
            title="Drag to move"
          >
            <Icon name="grip" size={14} strokeWidth={1.8} />
          </span>
          {Array.from({ length: r.depth }).map((_, i) => (
            <span key={i} style={{ width: 16, flexShrink: 0 }} />
          ))}
          {r.hasChildren ? (
            <button
              type="button"
              aria-label={r.open ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation();
                toggle(n.id);
              }}
              style={{
                width: 16,
                height: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#5B6B60',
                flexShrink: 0,
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              <Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={12} strokeWidth={2.3} />
            </button>
          ) : (
            <span style={{ width: 16, flexShrink: 0 }} />
          )}
          {selectMode && (
            <span
              className={`tr-check${pickedHere ? ' tr-check-on' : follows ? ' tr-check-follow' : ''}`}
              role="checkbox"
              aria-checked={pickedHere || follows}
              aria-disabled={follows || undefined}
              aria-label={follows ? `${n.title} comes with its parent` : `Select ${n.title}`}
              data-testid={`tree-check-${n.slug}`}
            >
              {(pickedHere || follows) && <Icon name="check" size={11} strokeWidth={3} />}
            </span>
          )}
          <PageIcon icon={n.icon} kind={n.kind} active={active} />
          {renaming ? (
            <RenameInput
              initial={n.title}
              onCommit={(title) => {
                onRenamingChange(null);
                if (title && title !== n.title) onRequestRename(n, title);
              }}
              onCancel={() => onRenamingChange(null)}
            />
          ) : (
            <TitleTip
              title={chapter ? `${chapter}. ${n.title}` : n.title}
              suppressed={!!drag || menu?.id === n.id || hover.shown?.id === n.id}
            >
              {chapter ? <span className="tr-chapter">{chapter}. </span> : null}
              {highlight(n.title, q)}
            </TitleTip>
          )}
          {!renaming && <ConvertMark state={n.convertState} />}
          {!renaming && <StatusDot status={status} />}
          {!renaming && book && (
            <span className="tr-tag tr-tag-book" aria-hidden="true">
              Book
            </span>
          )}
          {!renaming && <SuggestionMarker count={n.suggestions} />}
          {!renaming && r.hasChildren && !r.open && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#9AA8A0' }}>{r.childCount}</span>
          )}
          {!renaming && (movingId === n.id || loadingId === n.id) && (
            <span
              className="mc-spin"
              role="status"
              aria-label={movingId === n.id ? 'Saving move' : 'Loading page'}
              style={{ marginRight: 4 }}
            />
          )}
          {!renaming && (
            <span className="dk-tree-actions">
              {!readOnly && (
                <button
                  type="button"
                  title="Add child page"
                  aria-label={`Add child page under ${n.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewPage(n.id);
                  }}
                  className="dk-icobtn"
                  style={{ width: 22, height: 22, borderRadius: 5 }}
                >
                  <Icon name="plus" size={14} strokeWidth={2} />
                </button>
              )}
              <button
                type="button"
                title="More"
                aria-label={`Page actions for ${n.title}`}
                data-testid={`tree-more-${n.slug}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu((m) => (m?.id === n.id ? null : { id: n.id, left: rect.right, top: rect.bottom - 6 }));
                }}
                className="dk-icobtn"
                style={{ width: 22, height: 22, borderRadius: 5 }}
              >
                <Icon name="more" size={14} strokeWidth={1.8} />
              </button>
            </span>
          )}
          {renaming && (
            <div
              className="dk-hint"
              style={{
                position: 'absolute',
                left: 28,
                top: 'calc(100% + 4px)',
                zIndex: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 8,
                background: '#FFFFFF',
                border: '1px solid #E3E8E5',
                boxShadow: '0 8px 20px rgba(30,42,34,0.12)',
                fontSize: 11.5,
                color: '#5B6B60',
                fontWeight: 400,
                whiteSpace: 'nowrap',
              }}
            >
              <span className="dk-kbd">Enter</span> save <span className="dk-kbd">Esc</span> cancel
            </div>
          )}
          {nesting && (
            <div
              className="dk-tt"
              style={{ position: 'absolute', left: 100, top: -28, zIndex: 4, fontWeight: 400, pointerEvents: 'none' }}
            >
              Nest under <b>{n.title}</b>
            </div>
          )}
        </div>
        {dropLanding && drop?.zone === 'after' && drop.rowId === n.id && indicator(dropLanding.depth)}
        {lifted && (
          <div
            className="tr-reorder-btns"
            role="toolbar"
            aria-label={`Move ${n.title}`}
            data-testid="tree-reorder-buttons"
          >
            {(
              [
                ['up', 'Up', 'i34'],
                ['down', 'Down', 'i06'],
                ['out', 'Outdent', 'i16'],
                ['in', 'Indent', 'i45'],
              ] as const
            ).map(([dir, label, icon]) => (
              <button
                key={dir}
                type="button"
                className="tr-selbtn"
                disabled={!keyboardMove(nodes, n.id, dir) || movingId === n.id}
                onClick={() => void moveBy(n.id, dir)}
              >
                <Icon name={icon} size={14} strokeWidth={2} />
                {label}
              </button>
            ))}
            {onMoveTo && (
              <button type="button" className="tr-selbtn" onClick={() => onMoveTo(n)}>
                <Icon name="i35" size={14} strokeWidth={1.9} />
                Move to…
              </button>
            )}
          </div>
        )}
      </Fragment>
    );
  }

  return (
    <aside
      aria-label="Docs space"
      className="docs-root"
      style={{
        position: 'relative',
        width: Math.min(width, maxWidth()),
        flexShrink: 0,
        background: '#F6FAF7',
        borderRight: '1px solid #E3E8E5',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        minHeight: 0,
      }}
    >
      <ResizeHandle width={width} onChange={setWidth} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 12px 8px 14px' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#5B6B60',
            }}
          >
            Docs space
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: '#1E2A22',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontWeight: 500, color: '#5B6B60' }}>Space:</span> {projectName}
          </span>
        </div>
        {headerActions}
        {headerExtra}
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Collapse page tree"
          title="Collapse tree"
          onClick={onCollapse}
        >
          <Icon name="i16" size={16} strokeWidth={1.9} />
        </button>
      </div>
      <div
        style={{
          margin: q ? '0 10px 6px' : '0 10px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid #E3E8E5',
          background: '#FFFFFF',
          ...(filterFocus ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' } : null),
        }}
        onClick={() => filterRef.current?.focus()}
      >
        <Icon name="search" size={13} strokeWidth={2} style={{ color: filterFocus ? '#2E6F40' : '#9AA8A0' }} />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onFocus={() => setFilterFocus(true)}
          onBlur={() => setFilterFocus(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFilter('');
              e.currentTarget.blur();
            } else if (e.key === 'Enter' && q) onOpenSearch?.(q);
          }}
          placeholder="Search pages…"
          aria-label="Filter pages"
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'none',
            padding: 0,
            font: 'inherit',
            fontSize: 12.5,
            color: '#1E2A22',
          }}
        />
        {q ? (
          <button
            type="button"
            title="Clear filter"
            aria-label="Clear filter"
            onClick={() => {
              setFilter('');
              filterRef.current?.focus();
            }}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#E3E8E5',
              color: '#5B6B60',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            <Icon name="close" size={11} strokeWidth={2.4} />
          </button>
        ) : (
          <span className="dk-kbd">/</span>
        )}
      </div>
      {(onViewChange || onFiltersChange) && (
        <div className="tr-toolbar">
          {onViewChange && (
            <ViewMenu
              view={view}
              sort={sort}
              onView={onViewChange}
              onSort={(v) => onSortChange?.(v)}
              onSelectMode={
                onBulk
                  ? () => {
                      setReorder(false);
                      setSelectMode(true);
                    }
                  : undefined
              }
              onReorderMode={
                !readOnly
                  ? () => {
                      endSelect();
                      setReorder(true);
                    }
                  : undefined
              }
            />
          )}
          {onFiltersChange && (
            <FilterButton
              layout={layout}
              filters={filters}
              counts={counts}
              shown={filterShown}
              onChange={onFiltersChange}
            />
          )}
        </div>
      )}
      {onFiltersChange && <FilterChips filters={filters} onChange={onFiltersChange} />}
      {(q || filtering) && (
        <div role="status" style={{ padding: '0 14px 6px', fontSize: 11.5, color: '#5B6B60', minHeight: 18 }}>
          {matchCount === 0 ? '0 pages' : matchCount === 1 ? '1 page matches' : `${matchCount} pages match`}
        </div>
      )}
      {reorder && (
        <div className="tr-modebar" role="status" data-testid="tree-reorder-bar">
          <span>
            <b>Reorder pages</b>
            <small>
              {touch
                ? 'Drag a handle, or pick a page and use the buttons'
                : 'Drag a page, or pick one and use the buttons'}
            </small>
          </span>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            onClick={() => {
              setReorder(false);
              setReorderId(null);
            }}
          >
            Done
          </button>
        </div>
      )}
      {aiOn && (
        <div
          style={{ padding: '0 10px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}
          data-testid="docs-ai-rows"
        >
          <button type="button" className="dk-tree-airow is-ask" onClick={onAskDocs} data-testid="tree-ask-docs">
            <Icon name="comment" size={14} strokeWidth={1.9} />
            <span style={{ flex: 1, textAlign: 'left' }}>Ask the docs</span>
          </button>
          <button
            type="button"
            className="dk-tree-airow"
            aria-current={healthActive ? 'page' : undefined}
            onClick={onHealth}
            data-testid="tree-docs-health"
          >
            <Icon name="check" size={14} strokeWidth={1.9} />
            <span style={{ flex: 1, textAlign: 'left' }}>Docs health</span>
            {!!healthCount && <span className="dk-tree-count">{healthCount}</span>}
          </button>
        </div>
      )}
      <div ref={bodyRef} role="tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {nodes.length === 0 ? (
          <TreeEmpty />
        ) : filtering && rows.length === 0 ? (
          <NoMatch
            filters={filters}
            onClear={() => {
              onFiltersChange?.(NO_FILTERS);
              setFilter('');
            }}
          />
        ) : q && rows.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              padding: '34px 22px 0',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: '#F1F3F1',
                color: '#7A8A80',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="search" size={20} strokeWidth={1.8} />
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>No pages match “{q}”</div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
              Only page titles are filtered here. Search the text inside pages instead.
            </div>
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ marginTop: 4 }}
              onClick={() => onOpenSearch?.(q)}
            >
              <Icon name="search" size={13} strokeWidth={2} />
              Search page content
            </button>
            <button
              type="button"
              onClick={() => setFilter('')}
              style={{
                border: 'none',
                background: 'none',
                fontSize: 12,
                fontWeight: 600,
                color: '#2E6F40',
                cursor: 'pointer',
                padding: 4,
              }}
            >
              Clear filter
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '2px 10px' }}>
            {rows.map(renderRow)}
          </div>
        )}
      </div>
      {selectMode && (
        <SelectionBar
          selected={picked.size}
          affected={affected.size}
          readOnly={!!readOnly}
          onMove={() => bulk('move')}
          onDuplicate={() => bulk('duplicate')}
          onExport={() => bulk('export')}
          onDelete={() => bulk('delete')}
          onSelectAll={() => {
            // the pages shown (not the dimmed parents), counted once: a picked parent brings its children
            setPicked(new Set(selectionRoots(nodes, new Set(rows.filter((r) => !r.dim).map((r) => r.node.id)))));
          }}
          onDone={endSelect}
        />
      )}
      {onOpenBin && !selectMode && (
        <button type="button" className="tr-binrow" onClick={onOpenBin} data-testid="tree-recycle-bin">
          <Icon name="i12" size={14} strokeWidth={1.8} />
          <span style={{ flex: 1, textAlign: 'left' }}>Recycle Bin</span>
          {!!binCount && <span className="dk-tree-count">{binCount}</span>}
        </button>
      )}
      {!readOnly && !selectMode && (
        <div style={{ padding: '8px 10px 14px', display: 'flex', gap: 4, position: 'relative' }}>
          <button
            type="button"
            onClick={() => onNewPage(null)}
            data-testid="tree-new-page"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flex: 1,
              minWidth: 0,
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px dashed #C7D2CB',
              background: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12.5,
              fontWeight: 600,
              color: '#2E6F40',
              textAlign: 'left',
            }}
          >
            <Icon name="plus" size={12} strokeWidth={2.6} />
            New page
          </button>
          {renderNewPageMenu && (
            <button
              type="button"
              aria-label="More ways to start a page"
              aria-haspopup="menu"
              aria-expanded={newMenu}
              data-testid="tree-new-page-menu"
              // the open menu closes on a mousedown outside it: this button toggles it instead
              onMouseDown={(e) => newMenu && e.stopPropagation()}
              onClick={() => setNewMenu((v) => !v)}
              style={{
                width: 32,
                flexShrink: 0,
                borderRadius: 8,
                border: '1px dashed #C7D2CB',
                background: 'none',
                cursor: 'pointer',
                color: '#2E6F40',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="chevronDown" size={12} strokeWidth={2.4} />
            </button>
          )}
          {newMenu && renderNewPageMenu?.(() => setNewMenu(false))}
        </div>
      )}

      {menu && byId.get(menu.id) && (
        <div
          className="docs-root"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ position: 'fixed', left: menu.left, top: menu.top, width: 0, height: 0, zIndex: 300 }}
        >
          {renderMenu(byId.get(menu.id)!, () => setMenu(null))}
        </div>
      )}
      {drag && dragNode && (
        <div
          aria-hidden="true"
          data-testid="drag-chip"
          style={{
            position: 'fixed',
            left: drag.x + 12,
            top: drag.y - 14,
            zIndex: 500,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '6px 11px 6px 9px',
            borderRadius: 8,
            background: '#FFFFFF',
            border: '1px solid #2E6F40',
            boxShadow: '0 14px 30px rgba(30,42,34,0.24)',
            transform: 'rotate(-2deg)',
            fontSize: 13,
            fontWeight: 600,
            color: '#1E2A22',
          }}
        >
          <PageIcon icon={dragNode.icon} kind={dragNode.kind} active />
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span>
              {dragNode.title}
              {dragKids > 0 && <span className="tr-count">{dragKids + 1}</span>}
            </span>
            <span className="tr-drag-tip" data-testid="drag-tip">
              {dragTip}
            </span>
          </span>
        </div>
      )}
      {hover.shown && byId.get(hover.shown.id) && (
        <HoverCard node={byId.get(hover.shown.id)!} nodes={nodes} anchor={hover.shown.rect} />
      )}
      <div aria-live="polite" className="tr-sr" data-testid="tree-announce">
        {announce}
      </div>
    </aside>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        height: 24,
        padding: '0 6px',
        borderRadius: 5,
        border: '1px solid #2E6F40',
        background: '#FFFFFF',
        boxShadow: '0 0 0 3px rgba(46,111,64,0.18)',
        fontSize: 13,
        fontWeight: 600,
        color: '#1E2A22',
      }}
    >
      <input
        ref={ref}
        defaultValue={initial}
        aria-label="Page title"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={() => {
          if (!done.current) onCancel();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            done.current = true;
            onCommit(e.currentTarget.value.trim());
          } else if (e.key === 'Escape') {
            done.current = true;
            onCancel();
          }
        }}
        style={{
          width: '100%',
          border: 'none',
          outline: 'none',
          background: 'none',
          padding: 0,
          font: 'inherit',
          color: 'inherit',
        }}
      />
    </span>
  );
}
