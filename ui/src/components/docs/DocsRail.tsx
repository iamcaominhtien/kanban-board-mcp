import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocsTreeNode } from '../../types/docs';
import { Icon } from './Icon';

interface Props {
  nodes: DocsTreeNode[];
  selectedId: string | null;
  onExpand: () => void;
  onSearch: () => void;
  onNewPage: (parentId: string | null) => void;
  onSelect: (id: string) => void;
}

/** The 56px icon rail used below 1200 px or when the tree is collapsed: one icon per root page, hover flyout per folder. */
export function DocsRail({ nodes, selectedId, onExpand, onSearch, onNewPage, onSelect }: Props) {
  const roots = useMemo(
    () =>
      nodes
        .filter((n) => !n.parentId || !nodes.some((x) => x.id === n.parentId))
        .sort((a, b) => a.position - b.position),
    [nodes],
  );
  const kids = useMemo(() => {
    const m = new Map<string, DocsTreeNode[]>();
    for (const n of nodes) if (n.parentId) (m.get(n.parentId) ?? m.set(n.parentId, []).get(n.parentId)!).push(n);
    m.forEach((l) => l.sort((a, b) => a.position - b.position));
    return m;
  }, [nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const activeRoot = useMemo(() => {
    let cur = selectedId ? byId.get(selectedId) : undefined;
    while (cur?.parentId && byId.has(cur.parentId)) cur = byId.get(cur.parentId);
    return cur?.id ?? null;
  }, [selectedId, byId]);

  const asideRef = useRef<HTMLElement>(null);
  const [fly, setFly] = useState<{ id: string; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => clear, []);
  const openFly = (id: string, el: HTMLElement) => {
    clear();
    timer.current = setTimeout(() => setFly({ id, top: el.getBoundingClientRect().top }), 120);
  };
  const closeFly = () => {
    clear();
    timer.current = setTimeout(() => setFly(null), 200);
  };

  const flyNode = fly ? byId.get(fly.id) : null;
  const flatten = (id: string, depth: number): { n: DocsTreeNode; depth: number }[] =>
    (kids.get(id) ?? []).flatMap((c) => [{ n: c, depth }, ...flatten(c.id, depth + 1)]);

  return (
    <aside
      ref={asideRef}
      aria-label="Docs space (collapsed)"
      className="docs-root"
      style={{
        width: 56,
        flexShrink: 0,
        background: '#F6FAF7',
        borderRight: '1px solid #E3E8E5',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '14px 0',
        boxSizing: 'border-box',
        position: 'relative',
        overflowY: 'auto',
      }}
    >
      <button
        type="button"
        className="dk-rail-btn"
        aria-label="Expand page tree"
        title="Expand page tree"
        onClick={onExpand}
      >
        <Icon name="i45" size={18} strokeWidth={1.8} />
      </button>
      <button type="button" className="dk-rail-btn" aria-label="Search pages" title="Search pages" onClick={onSearch}>
        <Icon name="search" size={18} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="dk-rail-btn"
        aria-label="New page"
        title="New page"
        onClick={() => onNewPage(null)}
      >
        <Icon name="i23" size={18} strokeWidth={1.8} />
      </button>
      <div style={{ width: 24, height: 1, background: '#DCE6DF', margin: '6px 0', flexShrink: 0 }} />
      {roots.map((n) => {
        const folder = (kids.get(n.id)?.length ?? 0) > 0;
        return (
          <button
            key={n.id}
            type="button"
            className={`dk-rail-btn${n.id === activeRoot ? ' dk-rail-btn-on' : ''}`}
            aria-label={n.title}
            title={folder ? undefined : n.title}
            data-testid={`rail-${n.slug}`}
            onClick={() => onSelect(n.id)}
            onMouseEnter={(e) => folder && openFly(n.id, e.currentTarget)}
            onMouseLeave={closeFly}
            onFocus={(e) => folder && openFly(n.id, e.currentTarget)}
          >
            <Icon name={folder ? 'folder' : 'page'} size={18} strokeWidth={1.8} />
          </button>
        );
      })}
      {flyNode && fly && (
        <div
          className="dk-menu"
          role="menu"
          aria-label={flyNode.title}
          onMouseEnter={clear}
          onMouseLeave={closeFly}
          style={{
            position: 'fixed',
            left: (asideRef.current?.getBoundingClientRect().right ?? 56) + 6,
            top: fly.top,
            zIndex: 60,
            width: 214,
          }}
        >
          <div
            style={{
              padding: '6px 10px 4px',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#5B6B60',
            }}
          >
            {flyNode.title}
          </div>
          {flatten(flyNode.id, 0).map(({ n, depth }) => {
            const on = n.id === selectedId;
            return (
              <div
                key={n.id}
                role="menuitem"
                tabIndex={0}
                className={`dk-mi${on ? ' dk-mi-on' : ''}`}
                style={depth ? { paddingLeft: 10 + depth * 16 } : undefined}
                onClick={() => {
                  setFly(null);
                  onSelect(n.id);
                }}
                onKeyDown={(e) => e.key === 'Enter' && onSelect(n.id)}
              >
                <Icon name="page" size={15} strokeWidth={1.8} style={{ color: on ? '#2E6F40' : '#9AA8A0' }} />
                <span style={on ? { fontWeight: 700 } : undefined}>{n.title}</span>
              </div>
            );
          })}
          <div style={{ height: 1, background: '#EEF3EF', margin: '4px 6px' }} />
          <div
            role="menuitem"
            tabIndex={0}
            className="dk-mi"
            style={{ color: '#2E6F40', fontWeight: 600 }}
            onClick={() => {
              setFly(null);
              onNewPage(flyNode.id);
            }}
          >
            <Icon name="plus" size={14} strokeWidth={2.2} style={{ color: '#2E6F40' }} />
            <span>Add child page</span>
          </div>
        </div>
      )}
    </aside>
  );
}
