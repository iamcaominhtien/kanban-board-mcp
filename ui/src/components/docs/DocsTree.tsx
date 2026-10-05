import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocsTreeNode } from '../../types/docs';
import styles from './DocsTree.module.css';

export type TreeAction = 'rename' | 'add-child' | 'duplicate' | 'copy-link' | 'move' | 'export' | 'delete';

interface Props {
  projectName: string;
  nodes: DocsTreeNode[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNewPage: (parentId: string | null) => void;
  onAction: (action: TreeAction, node: DocsTreeNode) => void;
  onRename: (node: DocsTreeNode, title: string) => void;
  onMove: (id: string, parentId: string | null, beforeId: string | null, afterId: string | null) => void;
  onCollapse: () => void;
}

type Drop = { id: string; zone: 'before' | 'after' | 'nest' } | null;

const MENU: { action: TreeAction; label: string; key?: string; danger?: boolean }[] = [
  { action: 'rename', label: 'Rename', key: 'F2' },
  { action: 'add-child', label: 'Add child page' },
  { action: 'duplicate', label: 'Duplicate' },
  { action: 'copy-link', label: 'Copy link' },
  { action: 'move', label: 'Move to…' },
  { action: 'export', label: 'Export as Markdown' },
  { action: 'delete', label: 'Delete page', danger: true },
];

export function DocsTree({
  projectName,
  nodes,
  selectedId,
  loading,
  onSelect,
  onNewPage,
  onAction,
  onRename,
  onMove,
  onCollapse,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const nestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const children = useMemo(() => {
    const map = new Map<string | null, DocsTreeNode[]>();
    for (const n of nodes) {
      const list = map.get(n.parentId) ?? [];
      list.push(n);
      map.set(n.parentId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [nodes]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // quick filter: titles only, parents of matches stay visible
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const keep = new Set<string>();
    const matches = new Set<string>();
    for (const n of nodes) {
      if (!n.title.toLowerCase().includes(q)) continue;
      matches.add(n.id);
      let cur: DocsTreeNode | undefined = n;
      while (cur) {
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    return { keep, matches };
  }, [filter, nodes, byId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        filterRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  function isDescendant(id: string, ancestorId: string): boolean {
    let cur = byId.get(id);
    while (cur?.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  }

  function handleDragOver(e: React.DragEvent, node: DocsTreeNode) {
    if (!dragId || dragId === node.id || isDescendant(node.id, dragId)) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const zone = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'nest';
    setDrop((d) => (d && d.id === node.id && d.zone === zone ? d : { id: node.id, zone }));
    if (nestTimer.current) clearTimeout(nestTimer.current);
    if (zone === 'nest' && collapsed.has(node.id)) {
      nestTimer.current = setTimeout(() => setCollapsed((s) => { const n = new Set(s); n.delete(node.id); return n; }), 800);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (nestTimer.current) clearTimeout(nestTimer.current);
    const d = drop;
    const id = dragId;
    setDrop(null);
    setDragId(null);
    if (!d || !id) return;
    const target = byId.get(d.id);
    if (!target) return;
    if (d.zone === 'nest') onMove(id, target.id, null, null);
    else if (d.zone === 'before') onMove(id, target.parentId, target.id, null);
    else onMove(id, target.parentId, null, target.id);
  }

  function renderNodes(parentId: string | null, depth: number): React.ReactNode {
    const list = children.get(parentId) ?? [];
    return list.map((n) => {
      if (visible && !visible.keep.has(n.id)) return null;
      const kids = children.get(n.id) ?? [];
      const isCollapsed = !visible && collapsed.has(n.id);
      const dimmed = visible && !visible.matches.has(n.id);
      const dropClass =
        drop?.id === n.id ? (drop.zone === 'before' ? styles.dropBefore : drop.zone === 'after' ? styles.dropAfter : styles.dropNest) : '';
      return (
        <div key={n.id} role="treeitem" aria-expanded={kids.length ? !isCollapsed : undefined} aria-selected={selectedId === n.id}>
          <div
            className={`${styles.row} ${selectedId === n.id ? styles.selected : ''} ${dragId === n.id ? styles.dragging : ''} ${dropClass} ${dimmed ? styles.dim : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            draggable={renaming !== n.id}
            onDragStart={(e) => {
              setDragId(n.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', n.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDrop(null);
            }}
            onDragOver={(e) => handleDragOver(e, n)}
            onDrop={handleDrop}
            onClick={() => renaming !== n.id && onSelect(n.id)}
            onKeyDown={(e) => {
              if (e.key === 'F2') setRenaming(n.id);
              if (e.key === 'Enter') onSelect(n.id);
            }}
            tabIndex={0}
            data-testid={`tree-row-${n.slug}`}
          >
            <span className={styles.grip} aria-hidden="true">⋮⋮</span>
            <button
              type="button"
              className={styles.chev}
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              style={{ visibility: kids.length ? 'visible' : 'hidden' }}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((s) => {
                  const next = new Set(s);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                });
              }}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
            {renaming === n.id ? (
              <input
                className={styles.renameInput}
                autoFocus
                defaultValue={n.title}
                aria-label="Page title"
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') setRenaming(null);
                  if (e.key === 'Enter') {
                    const v = e.currentTarget.value.trim();
                    setRenaming(null);
                    if (v && v !== n.title) onRename(n, v);
                  }
                }}
              />
            ) : (
              <span className={styles.title}>{n.title}</span>
            )}
            {n.status === 'draft' && <span className={styles.draftDot} title="Draft (never published)" />}
            {isCollapsed && kids.length > 0 && <span className={styles.count}>{kids.length}</span>}
            <span className={styles.actions}>
              <button
                type="button"
                className={styles.iconBtn}
                title="Add child page"
                aria-label={`Add child page under ${n.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewPage(n.id);
                }}
              >
                +
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                title="More"
                aria-label={`Page actions for ${n.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === n.id ? null : n.id);
                }}
              >
                ···
              </button>
            </span>
            {menuFor === n.id && (
              <div className={styles.menu} role="menu" onClick={(e) => e.stopPropagation()}>
                {MENU.map((m, i) => (
                  <div key={m.action}>
                    {m.danger && <div className={styles.menuSep} />}
                    <button
                      type="button"
                      role="menuitem"
                      className={`${styles.menuItem} ${m.danger ? styles.menuDanger : ''}`}
                      onClick={() => {
                        setMenuFor(null);
                        if (m.action === 'rename') setRenaming(n.id);
                        else onAction(m.action, n);
                      }}
                      data-testid={`tree-menu-${m.action}`}
                      autoFocus={i === 0}
                    >
                      {m.label}
                      {m.key && <kbd>{m.key}</kbd>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {!isCollapsed && kids.length > 0 && <div role="group">{renderNodes(n.id, depth + 1)}</div>}
        </div>
      );
    });
  }

  const topLevel = children.get(null) ?? [];

  return (
    <aside className={styles.tree} aria-label="Docs space">
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Docs space</div>
          <div className={styles.space}>Space: {projectName}</div>
        </div>
        <button type="button" className={styles.iconBtn} onClick={onCollapse} title="Collapse tree" aria-label="Collapse tree">
          «
        </button>
      </div>
      <div className={styles.search}>
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search pages…"
          aria-label="Filter pages"
          onKeyDown={(e) => e.key === 'Escape' && (setFilter(''), e.currentTarget.blur())}
        />
        <kbd>/</kbd>
      </div>
      <div className={styles.list} role="tree" onDragLeave={(e) => e.currentTarget === e.target && setDrop(null)}>
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <div key={i} className={styles.skel} style={{ width: `${60 + ((i * 17) % 35)}%`, marginLeft: i % 3 === 1 ? 20 : 8 }} />)
        ) : topLevel.length === 0 ? (
          <div className={styles.empty}>
            <strong>No pages yet</strong>
            <span>Pages you create show up here as a tree you can reorder by dragging.</span>
          </div>
        ) : visible && visible.matches.size === 0 ? (
          <div className={styles.empty}>
            <strong>No page matches “{filter}”</strong>
          </div>
        ) : (
          renderNodes(null, 0)
        )}
      </div>
      <div className={styles.foot}>
        <button type="button" className={styles.newBtn} onClick={() => onNewPage(null)}>
          + New page
        </button>
      </div>
    </aside>
  );
}
