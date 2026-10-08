import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { docsErrorDetail, useMovePage } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { FooterNote, ModalShell, Spacer, plural } from './docsShared';

interface MoveToDialogProps {
  projectId: string;
  page: DocsPage;
  nodes: DocsTreeNode[];
  onClose: () => void;
  onMoved?: (page: DocsPage) => void;
}

/** Where the page will land: under `parentId`, between `afterId` and `beforeId`. */
interface Target {
  parentId: string | null;
  afterId: string | null;
  beforeId: string | null;
  /** The page row that was clicked ("Move here" badge), if any. */
  via: string | null | undefined;
}

type Row =
  | {
      kind: 'row';
      id: string | null;
      title: string;
      depth: number;
      hasKids: boolean;
      open: boolean;
      reason: string | null;
    }
  | { kind: 'gap'; parentId: string | null; afterId: string | null; depth: number };

const MARK: React.CSSProperties = { background: 'rgba(232,185,58,0.35)', borderRadius: 2, color: '#1E2A22' };

function byPosition(a: DocsTreeNode, b: DocsTreeNode): number {
  return a.position - b.position;
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span style={MARK}>{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  );
}

/** Dialog to pick a new parent for a page. */
export function MoveToDialog({ projectId, page, nodes, onClose, onMoved }: MoveToDialogProps) {
  const toast = useToast();
  const move = useMovePage(projectId);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(true);
  const [target, setTarget] = useState<Target | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const kids = useMemo(() => {
    const m = new Map<string | null, DocsTreeNode[]>();
    for (const n of [...nodes].sort(byPosition)) {
      const arr = m.get(n.parentId) ?? [];
      arr.push(n);
      m.set(n.parentId, arr);
    }
    return m;
  }, [nodes]);
  const childrenOf = (id: string | null) => kids.get(id) ?? [];

  const descendants = useMemo(() => {
    const out = new Set<string>();
    const walk = (id: string) => {
      for (const c of kids.get(id) ?? []) {
        out.add(c.id);
        walk(c.id);
      }
    };
    walk(page.id);
    return out;
  }, [kids, page.id]);

  const reasonFor = (id: string): string | null =>
    id === page.id ? 'This page' : descendants.has(id) ? 'Inside this page' : null;

  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(' › ');
  };

  /** Target for "move under this page, at the end". */
  function underPage(parentId: string | null, via: string | null): Target {
    const sibs = childrenOf(parentId).filter((n) => n.id !== page.id);
    return { parentId, afterId: sibs.length ? sibs[sibs.length - 1].id : null, beforeId: null, via };
  }
  /** Target for a gap: after `afterId` (or first) under `parentId`. */
  function atGap(parentId: string | null, afterId: string | null): Target {
    const sibs = childrenOf(parentId).filter((n) => n.id !== page.id);
    if (afterId) {
      const i = sibs.findIndex((s) => s.id === afterId);
      return { parentId, afterId, beforeId: i >= 0 ? (sibs[i + 1]?.id ?? null) : null, via: undefined };
    }
    return { parentId, afterId: null, beforeId: sibs[0]?.id ?? null, via: undefined };
  }

  const searching = query.trim().length > 0;

  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .filter((n) => n.title.toLowerCase().includes(q) || pathOf(n.id).toLowerCase().includes(q))
      .sort(byPosition)
      .map((n) => ({
        id: n.id,
        title: n.title,
        path: n.parentId ? pathOf(n.id) : 'Top level',
        reason: reasonFor(n.id),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, query, descendants, page.id]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [
      { kind: 'row', id: null, title: 'Top level', depth: 0, hasKids: false, open: false, reason: null },
    ];
    const walk = (parentId: string | null, depth: number) => {
      const list = childrenOf(parentId);
      const inside = parentId !== null && (parentId === page.id || descendants.has(parentId));
      if (!inside) out.push({ kind: 'gap', parentId, afterId: null, depth });
      for (const n of list) {
        const kidsOf = childrenOf(n.id);
        const open = !closed.has(n.id);
        out.push({
          kind: 'row',
          id: n.id,
          title: n.title,
          depth,
          hasKids: kidsOf.length > 0,
          open,
          reason: reasonFor(n.id),
        });
        if (open) walk(n.id, depth + 1);
        if (!inside && n.id !== page.id) out.push({ kind: 'gap', parentId, afterId: n.id, depth });
      }
    };
    walk(null, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, closed, descendants, page.id]);

  const currentParent = page.parentId ? byId.get(page.parentId) : undefined;
  const childCount = descendants.size;
  const targetTitle = !target
    ? ''
    : target.parentId === null
      ? 'the top level'
      : (byId.get(target.parentId)?.title ?? '');
  const afterNode = target?.afterId ? byId.get(target.afterId) : undefined;

  function pickFlat(i: number) {
    const e = flat[i];
    if (!e || e.reason) return;
    setTarget(underPage(e.id, e.id));
    setError(null);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!searching) return;
    const enabled = flat.map((f, i) => (f.reason ? -1 : i)).filter((i) => i >= 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!enabled.length) return;
      const cur = enabled.indexOf(active);
      const next = e.key === 'ArrowDown' ? Math.min(enabled.length - 1, cur + 1) : Math.max(0, cur - 1);
      setActive(enabled[next < 0 ? 0 : next]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickFlat(enabled.includes(active) ? active : (enabled[0] ?? -1));
    }
  }

  async function confirm() {
    if (!target) return;
    setError(null);
    const prevSibs = childrenOf(page.parentId).filter((n) => n.id !== page.id);
    const idx = childrenOf(page.parentId).findIndex((n) => n.id === page.id);
    const oldAfter = idx > 0 ? (childrenOf(page.parentId)[idx - 1]?.id ?? null) : null;
    const oldBefore = idx === 0 ? (prevSibs[0]?.id ?? null) : null;
    const oldParent = page.parentId;
    try {
      const moved = await move.mutateAsync({
        pageId: page.id,
        parentId: target.parentId,
        afterId: target.afterId,
        beforeId: target.afterId ? null : target.beforeId,
      });
      const where = target.parentId === null ? 'to the top level' : `under ${targetTitle}`;
      toast.showToast({
        variant: 'success',
        title: `Moved “${page.title}” ${where}`,
        message:
          [
            afterNode ? `After ${afterNode.title}.` : '',
            childCount ? `${plural(childCount, 'child page')} moved with it.` : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => {
            move
              .mutateAsync({ pageId: page.id, parentId: oldParent, afterId: oldAfter, beforeId: oldBefore })
              .then(() => toast.success(`Moved “${page.title}” back`))
              .catch((err) =>
                toast.error("Couldn't undo the move", docsErrorDetail(err)?.message ?? extractError(err)),
              );
          },
        },
      });
      onMoved?.(moved);
      onClose();
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  const rowBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    height: 32,
    padding: '0 10px 0 8px',
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 500,
    color: '#3A4A3E',
    boxSizing: 'border-box',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
  };

  function ghost(depth: number) {
    return (
      <div
        key="ghost"
        data-testid="move-new-position"
        style={{
          ...rowBase,
          padding: `0 10px 0 ${8 + depth * 18}px`,
          border: '1.5px dashed #2E6F40',
          background: '#F1F8F3',
          color: '#2E6F40',
          fontWeight: 700,
          height: 30,
          cursor: 'default',
        }}
      >
        <span style={{ width: 12 }} />
        <Icon name="i00" size={15} strokeWidth={1.8} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {page.title}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#2E6F40' }}>New position</span>
      </div>
    );
  }

  function renderRow(r: Extract<Row, { kind: 'row' }>): ReactNode {
    const disabled = !!r.reason;
    const selected = !disabled && target?.via !== undefined && target.via === r.id;
    return (
      <button
        type="button"
        key={`row-${r.id ?? 'top'}`}
        role="option"
        aria-selected={selected}
        aria-disabled={disabled}
        disabled={false}
        onClick={() => {
          if (disabled) return;
          setTarget(underPage(r.id, r.id));
          setError(null);
        }}
        style={{
          ...rowBase,
          padding: `0 10px 0 ${8 + r.depth * 18}px`,
          ...(disabled ? { color: '#9AA8A0', cursor: 'not-allowed' } : {}),
          ...(selected
            ? { background: '#DCEEE1', boxShadow: '0 0 0 1.5px #2E6F40 inset', color: '#1E2A22', fontWeight: 700 }
            : {}),
        }}
      >
        {r.hasKids ? (
          <span
            role="presentation"
            onClick={(e) => {
              e.stopPropagation();
              setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(r.id as string)) next.delete(r.id as string);
                else next.add(r.id as string);
                return next;
              });
            }}
            style={{ display: 'flex', width: 12 }}
          >
            <Icon name={r.open ? 'i06' : 'i05'} size={12} strokeWidth={2.3} />
          </span>
        ) : (
          <span style={{ width: 12 }} />
        )}
        <Icon name={r.id === null ? 'i27' : 'i00'} size={15} strokeWidth={1.8} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.title}
        </span>
        {selected && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: '#2E6F40' }}>Move here</span>
        )}
        {disabled && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11.5,
              color: '#9AA8A0',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon name="i25" size={11} strokeWidth={2} />
            {r.reason}
          </span>
        )}
      </button>
    );
  }

  function renderGap(r: Extract<Row, { kind: 'gap' }>, i: number): ReactNode {
    const on = !!target && target.parentId === r.parentId && target.afterId === r.afterId;
    const ml = 8 + r.depth * 18 + 12;
    return (
      <Fragment key={`gap-${i}`}>
        <div
          className="mv-gap"
          role="separator"
          aria-label="Place here"
          data-testid="move-gap"
          onClick={() => {
            setTarget(atGap(r.parentId, r.afterId));
            setError(null);
          }}
          style={{ position: 'relative', height: 4, margin: `-1px 4px -1px ${ml}px`, cursor: 'pointer', zIndex: 1 }}
        >
          <div
            className="mv-line"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 1,
              height: 2,
              borderRadius: 1,
              background: '#2E6F40',
              opacity: on ? 1 : 0,
            }}
          />
          {on && (
            <div
              style={{
                position: 'absolute',
                left: -3,
                top: -2,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#FFFFFF',
                border: '2px solid #2E6F40',
                boxSizing: 'border-box',
              }}
            />
          )}
        </div>
        {on && ghost(r.depth)}
      </Fragment>
    );
  }

  // Ghost for "under this page at the end": the matching gap line already renders it.
  const preview = !target ? (
    <span style={{ color: '#5B6B60' }}>Choose where to move this page.</span>
  ) : (
    <span>
      Will be placed{' '}
      {target.parentId === null ? (
        'at the top level'
      ) : (
        <>
          under <b style={{ color: '#1E2A22', fontWeight: 700 }}>{targetTitle}</b>
        </>
      )}
      {afterNode ? (
        <>
          , after <b style={{ color: '#1E2A22', fontWeight: 700 }}>{afterNode.title}</b>
        </>
      ) : target.parentId === null ? (
        ', as the first page'
      ) : (
        ', as its first child'
      )}
      .
    </span>
  );

  return (
    <ModalShell
      width={560}
      ariaLabel={`Move “${page.title}”`}
      icon="i35"
      title={<>Move “{page.title}”</>}
      subtitle={
        <>
          {currentParent ? `Currently under ${currentParent.title}` : 'Currently at the top level'}
          {childCount > 0 && ` · ${plural(childCount, 'child page')} move with it`}
        </>
      }
      onClose={onClose}
      bodyStyle={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={
        <>
          <FooterNote>Links to this page keep working.</FooterNote>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            data-testid="confirm-move"
            disabled={!target || move.isPending}
            onClick={() => void confirm()}
          >
            <Icon name="i35" size={14} />
            {move.isPending ? 'Moving…' : 'Move'}
          </button>
        </>
      }
    >
      <style>{`.mv-gap:hover .mv-line{opacity:1!important}`}</style>
      <div
        className="st-input"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          ...(focused && searching ? { borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' } : {}),
        }}
      >
        <span style={{ display: 'flex', color: '#9AA8A0' }}>
          <Icon name="i09" size={14} strokeWidth={2} />
        </span>
        <input
          ref={searchRef}
          aria-label="Find a page"
          placeholder="Find a page…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onSearchKey}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            font: 'inherit',
            color: '#1E2A22',
            padding: 0,
          }}
        />
        {searching ? (
          <span style={{ fontSize: 11.5, color: '#9AA8A0' }}>{plural(flat.length, 'page')}</span>
        ) : (
          <span className="dk-kbd">/</span>
        )}
      </div>

      {searching && flat.length === 0 ? (
        <div
          style={{
            padding: 16,
            borderRadius: 10,
            border: '1px dashed #C7D2CB',
            textAlign: 'center',
            fontSize: 13,
            color: '#5B6B60',
            lineHeight: 1.5,
          }}
        >
          <b style={{ color: '#1E2A22', fontWeight: 700 }}>No pages match “{query.trim()}”</b>
          <br />
          Try part of a title.
        </div>
      ) : searching ? (
        <div
          role="listbox"
          aria-label="Pages"
          style={{ border: '1px solid #E3E8E5', borderRadius: 10, overflow: 'hidden' }}
        >
          {flat.map((f, i) => {
            const disabled = !!f.reason;
            const isActive = i === active && !disabled;
            const picked = target?.via === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="option"
                aria-selected={picked}
                aria-disabled={disabled}
                onClick={() => pickFlat(i)}
                onMouseEnter={() => !disabled && setActive(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '8px 12px',
                  borderBottom: '1px solid #EEF3EF',
                  borderTop: 'none',
                  borderLeft: 'none',
                  borderRight: 'none',
                  width: '100%',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  color: disabled ? '#9AA8A0' : '#1E2A22',
                  background: picked ? '#DCEEE1' : isActive ? '#F1F8F3' : '#FFFFFF',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={{ display: 'flex', color: disabled ? '#9AA8A0' : '#2E6F40' }}>
                  <Icon name="i00" size={15} strokeWidth={1.8} />
                </span>
                <span>{highlight(f.title, query)}</span>
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 500,
                    color: '#9AA8A0',
                    marginLeft: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {disabled ? (
                    <>
                      <Icon name="i25" size={11} strokeWidth={2} />
                      {f.reason}
                    </>
                  ) : (
                    highlight(f.path, query)
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div
          role="listbox"
          aria-label="Pages"
          style={{
            border: '1px solid #E3E8E5',
            borderRadius: 10,
            padding: 5,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            background: '#FFFFFF',
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {rows.map((r, i) => (r.kind === 'row' ? renderRow(r) : renderGap(r, i)))}
        </div>
      )}

      {searching && flat.length > 0 && (
        <div style={{ fontSize: 12, color: '#5B6B60' }}>
          <span className="dk-kbd">↑</span> <span className="dk-kbd">↓</span> move,{' '}
          <span className="dk-kbd">Enter</span> choose. Results are flat, with the path on the right.
        </div>
      )}

      <div
        aria-live="polite"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 12px',
          borderRadius: 8,
          background: '#F1F8F3',
          border: '1px solid #D7E8DC',
          fontSize: 13,
          color: '#1E2A22',
          lineHeight: 1.45,
        }}
      >
        <span style={{ color: '#2E6F40', display: 'flex' }}>
          <Icon name="i35" size={16} />
        </span>
        {preview}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
        Click a page to move under it, or a gap between pages to choose the exact position. Grayed pages can't be
        chosen: a page can't go inside itself.
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {error}
        </div>
      )}
    </ModalShell>
  );
}
