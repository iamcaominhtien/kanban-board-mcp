/** The "Parent page" field of the New page dialog: a button that opens a searchable list of the page tree. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocsTreeNode } from '../../../types/docs';
import { Icon } from '../Icon';

/** The titles from the top of the tree down to a page, joined with ›. */
export function pathOf(nodes: DocsTreeNode[], id: string | null): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    parts.unshift(cur.title);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' › ');
}

/**
 * The parent picker.
 * @param props.nodes - The page tree.
 * @param props.parentId - The chosen parent (`null`: top level).
 * @param props.onChange - Called with the new parent.
 * @param props.onOpenChange - Called when the list opens or closes (Escape closes the list before the dialog).
 * @param props.below - Open the list under the button (it opens above by default, the field sits low in a dialog).
 */
export function ParentPicker({
  nodes,
  parentId,
  onChange,
  onOpenChange,
  below = false,
}: {
  nodes: DocsTreeNode[];
  parentId: string | null;
  onChange: (id: string | null) => void;
  onOpenChange?: (open: boolean) => void;
  below?: boolean;
}) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpenState(false);
        onOpenChange?.(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open, onOpenChange]);

  const flat = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const kids = new Map<string | null, DocsTreeNode[]>();
    for (const n of nodes) {
      const k = n.parentId && ids.has(n.parentId) ? n.parentId : null;
      const list = kids.get(k) ?? [];
      list.push(n);
      kids.set(k, list);
    }
    kids.forEach((l) => l.sort((a, b) => a.position - b.position));
    const out: { n: DocsTreeNode; depth: number }[] = [];
    const walk = (p: string | null, depth: number) => {
      for (const n of kids.get(p) ?? []) {
        out.push({ n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [nodes]);
  const q = query.trim().toLowerCase();
  const shown = q ? flat.filter(({ n }) => pathOf(nodes, n.id).toLowerCase().includes(q)) : flat;
  const parent = parentId ? nodes.find((n) => n.id === parentId) : null;
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="st-field-label" style={{ fontSize: 11 }}>
          Parent page
        </span>
        <button
          type="button"
          className="st-input"
          aria-label="Parent page"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="parent-select"
          onClick={() => {
            setOpen(!open);
            setQuery('');
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textAlign: 'left',
            cursor: 'pointer',
            ...(open ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' } : null),
          }}
        >
          <span style={{ display: 'flex', color: '#2E6F40' }}>
            <Icon name={parent ? 'page' : 'i27'} size={15} strokeWidth={1.8} />
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {parent ? parent.title : 'Top level (no parent)'}
          </span>
          <Icon name="chevronDown" size={12} strokeWidth={2.3} style={{ color: '#9AA8A0' }} />
        </button>
      </div>
      {open && (
        <div
          className="dk-menu"
          role="listbox"
          style={{
            position: 'absolute',
            right: 0,
            ...(below ? { top: 'calc(100% + 6px)' } : { bottom: 'calc(100% + 6px)' }),
            width: 320,
            maxWidth: '100%',
            padding: 6,
            zIndex: 20,
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 9px',
              marginBottom: 4,
              borderRadius: 7,
              border: '1px solid #E3E8E5',
              background: '#FBFCFB',
            }}
          >
            <Icon name="search" size={13} strokeWidth={2} style={{ color: '#9AA8A0' }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && shown[0]) choose(shown[0].n.id);
              }}
              placeholder="Find a page…"
              aria-label="Find a page"
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
          </div>
          {!q && (
            <div
              role="option"
              aria-selected={parentId === null}
              className={`dk-mi${parentId === null ? ' dk-mi-on' : ''}`}
              style={parentId === null ? { fontWeight: 700 } : undefined}
              onClick={() => choose(null)}
            >
              <span style={{ color: '#5B6B60', display: 'flex' }}>
                <Icon name="i27" size={15} strokeWidth={1.8} />
              </span>
              <span>Top level (no parent)</span>
              {parentId === null && (
                <span style={{ marginLeft: 'auto', display: 'flex' }}>
                  <Icon name="check" size={14} strokeWidth={2.6} style={{ color: '#2E6F40' }} />
                </span>
              )}
            </div>
          )}
          {shown.map(({ n, depth }) => {
            const on = n.id === parentId;
            return (
              <div
                key={n.id}
                role="option"
                aria-selected={on}
                className={`dk-mi${on ? ' dk-mi-on' : ''}`}
                style={{ paddingLeft: q ? 10 : 10 + depth * 18, fontWeight: on ? 700 : undefined }}
                onClick={() => choose(n.id)}
              >
                <Icon
                  name="page"
                  size={15}
                  strokeWidth={1.8}
                  style={{ color: on ? '#2E6F40' : depth ? '#9AA8A0' : '#5B6B60' }}
                />
                <span>{q ? pathOf(nodes, n.id) : n.title}</span>
                {on && (
                  <span style={{ marginLeft: 'auto', display: 'flex' }}>
                    <Icon name="check" size={14} strokeWidth={2.6} style={{ color: '#2E6F40' }} />
                  </span>
                )}
              </div>
            );
          })}
          {shown.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12.5, color: '#9AA8A0' }}>No page matches “{query}”</div>
          )}
        </div>
      )}
    </div>
  );
}
