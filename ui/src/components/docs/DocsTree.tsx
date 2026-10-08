import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DocsTreeNode } from '../../types/docs';
import { Icon } from './Icon';
import { TreeEmpty } from './DocsStates';

interface Props {
  projectId: string;
  projectName: string;
  nodes: DocsTreeNode[];
  selectedId: string | null;
  /** Pages whose content is loading right now (row spinner). */
  loadingId?: string | null;
  onSelect: (id: string) => void;
  onNewPage: (parentId: string | null) => void;
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
  /** Slot in the header, next to the collapse button (Follow space). */
  headerExtra?: ReactNode;
}

interface Row {
  node: DocsTreeNode;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  childCount: number;
  dim: boolean;
}

type Zone = 'before' | 'after' | 'nest';
interface Drop {
  rowId: string;
  zone: Zone;
  /** nest zone held for 400 ms */
  nestReady: boolean;
}

const INDENT = 20;

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

/** Page tree with drag-to-reorder, filter, rename and row menu. */
export function DocsTree({
  projectId,
  projectName,
  nodes,
  selectedId,
  loadingId,
  onSelect,
  onNewPage,
  onRequestRename,
  renamingId,
  onRenamingChange,
  onMove,
  onCollapse,
  renderMenu,
  onOpenSearch,
  headerExtra,
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
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{ id: string; sx: number; sy: number; started: boolean } | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const suppressClick = useRef(false);

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
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (q) {
      const lc = q.toLowerCase();
      const matches = new Set(nodes.filter((n) => n.title.toLowerCase().includes(lc)).map((n) => n.id));
      const keep = new Set<string>(matches);
      for (const id of matches) {
        let cur = byId.get(id)?.parentId ?? null;
        while (cur) {
          keep.add(cur);
          cur = byId.get(cur)?.parentId ?? null;
        }
      }
      const walk = (parent: string | null, depth: number) => {
        for (const n of childrenOf.get(parent) ?? []) {
          if (!keep.has(n.id)) continue;
          const kids = (childrenOf.get(n.id) ?? []).filter((c) => keep.has(c.id));
          const total = (childrenOf.get(n.id) ?? []).length;
          const isMatch = matches.has(n.id);
          out.push({
            node: n,
            depth,
            hasChildren: total > 0,
            open: kids.length > 0 && !isMatch ? true : kids.length > 0,
            childCount: total,
            dim: !isMatch,
          });
          if (kids.length) walk(n.id, depth + 1);
        }
      };
      walk(null, 0);
      return out;
    }
    const walk = (parent: string | null, depth: number) => {
      for (const n of childrenOf.get(parent) ?? []) {
        const kids = childrenOf.get(n.id) ?? [];
        const open = kids.length > 0 && !closed.has(n.id);
        out.push({ node: n, depth, hasChildren: kids.length > 0, open, childCount: kids.length, dim: false });
        if (open) walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [nodes, byId, childrenOf, closed, q]);

  const matchCount = q ? rows.filter((r) => !r.dim).length : 0;

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
    if (e.button !== 0 || q || renamingId) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, started: false };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 5) return;
      d.started = true;
      setDrag({ id: d.id, x: ev.clientX, y: ev.clientY });
      setDrop(computeDrop(ev.clientX, ev.clientY, d.id));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', esc);
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
      if (ev.key === 'Escape') {
        dragRef.current = null;
        setDrag(null);
        setDrop(null);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('keydown', esc);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', esc);
  }

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

  function indicator(depth: number) {
    return (
      <div
        aria-hidden="true"
        data-testid="drop-line"
        style={{ position: 'relative', height: 0, margin: `0 4px 0 ${22 + depth * INDENT}px`, zIndex: 3 }}
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
    return (
      <Fragment key={n.id}>
        {dropLanding && drop?.zone === 'before' && drop.rowId === n.id && indicator(dropLanding.depth)}
        <div
          ref={(el) => {
            if (el) rowEls.current.set(n.id, el);
            else rowEls.current.delete(n.id);
          }}
          className={`dk-tree-row${active ? ' dk-tree-active' : ''}${isDrag ? ' dk-row-dim' : ''}${nesting ? ' dk-row-nest' : ''}${menu?.id === n.id ? ' dk-tree-hover' : ''}`}
          style={{ opacity: r.dim && !isDrag ? 0.6 : undefined, touchAction: 'none', userSelect: 'none' }}
          role="treeitem"
          aria-level={r.depth + 1}
          aria-selected={active}
          aria-expanded={r.hasChildren ? r.open : undefined}
          tabIndex={0}
          data-testid={`tree-row-${n.slug}`}
          data-page-id={n.id}
          onPointerDown={(e) => startPointer(e, n.id)}
          onClick={() => {
            if (suppressClick.current || renaming) return;
            onSelect(n.id);
          }}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === 'Enter' || e.key === ' ') {
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
            className="dk-hov"
            style={{ width: 14, display: 'flex', justifyContent: 'center', color: '#9AA8A0', cursor: 'grab' }}
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
          <span style={{ display: 'flex', color: active ? '#2E6F40' : '#9AA8A0' }}>
            <Icon name="page" size={15} strokeWidth={1.7} />
          </span>
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
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {highlight(n.title, q)}
            </span>
          )}
          {!renaming && n.status === 'draft' && (
            <span
              title="Draft"
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#B4791E',
                flexShrink: 0,
                margin: '0 3px',
              }}
            />
          )}
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
            <span className="dk-hov" style={{ display: 'flex', alignItems: 'center' }}>
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
      </Fragment>
    );
  }

  return (
    <aside
      aria-label="Docs space"
      className="docs-root"
      style={{
        width: 248,
        flexShrink: 0,
        background: '#F6FAF7',
        borderRight: '1px solid #E3E8E5',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        minHeight: 0,
      }}
    >
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
      {q && (
        <div role="status" style={{ padding: '0 14px 6px', fontSize: 11.5, color: '#5B6B60', minHeight: 18 }}>
          {matchCount === 0 ? '0 pages' : matchCount === 1 ? '1 page matches' : `${matchCount} pages match`}
        </div>
      )}
      <div ref={bodyRef} role="tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {nodes.length === 0 ? (
          <TreeEmpty />
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '2px 8px' }}>
            {rows.map(renderRow)}
          </div>
        )}
      </div>
      <div style={{ padding: '8px 10px 14px' }}>
        <button
          type="button"
          onClick={() => onNewPage(null)}
          data-testid="tree-new-page"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
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
      </div>

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
          <Icon name="page" size={15} strokeWidth={1.8} style={{ color: '#2E6F40' }} /> {dragNode.title}
        </div>
      )}
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
