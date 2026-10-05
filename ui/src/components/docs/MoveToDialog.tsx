import { useEffect, useMemo, useRef, useState } from 'react';
import { docsErrorDetail, useMovePage } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import styles from './MoveToDialog.module.css';

interface MoveToDialogProps {
  projectId: string;
  page: DocsPage;
  nodes: DocsTreeNode[];
  onClose: () => void;
  onMoved?: (page: DocsPage) => void;
}

interface Entry {
  /** null is the "Top level" target. */
  id: string | null;
  title: string;
  depth: number;
  path: string;
  disabledReason: string | null;
}

function byPosition(a: DocsTreeNode, b: DocsTreeNode): number {
  return a.position - b.position;
}

function childrenOf(nodes: DocsTreeNode[], parentId: string | null): DocsTreeNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort(byPosition);
}

function highlight(text: string, query: string) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className={styles.mark}>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

export function MoveToDialog({ projectId, page, nodes, onClose, onMoved }: MoveToDialogProps) {
  const toast = useToast();
  const move = useMovePage(projectId);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => searchRef.current?.focus(), []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const descendants = useMemo(() => {
    const out = new Set<string>();
    const walk = (id: string) => {
      for (const c of childrenOf(nodes, id)) {
        out.add(c.id);
        walk(c.id);
      }
    };
    walk(page.id);
    return out;
  }, [nodes, page.id]);

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

  const reasonFor = (id: string): string | null =>
    id === page.id ? 'This page' : descendants.has(id) ? 'Inside this page' : null;

  const entries: Entry[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return nodes
        .filter((n) => n.title.toLowerCase().includes(q))
        .sort(byPosition)
        .map((n) => ({
          id: n.id,
          title: n.title,
          depth: 0,
          path: n.parentId ? pathOf(n.parentId) : 'Top level',
          disabledReason: reasonFor(n.id),
        }));
    }
    const out: Entry[] = [{ id: null, title: 'Top level', depth: 0, path: '', disabledReason: null }];
    const walk = (parentId: string | null, depth: number) => {
      for (const n of childrenOf(nodes, parentId)) {
        out.push({ id: n.id, title: n.title, depth, path: '', disabledReason: reasonFor(n.id) });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, query, page.id, descendants]);

  const enabledIdx = entries.map((e, i) => (e.disabledReason ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => setActive(0), [query]);

  const siblings = useMemo(
    () => (target === undefined ? [] : childrenOf(nodes, target).filter((n) => n.id !== page.id)),
    [nodes, target, page.id],
  );
  const afterNode = siblings.length ? siblings[siblings.length - 1] : null;
  const targetTitle = target === undefined ? '' : target === null ? 'the top level' : byId.get(target)?.title ?? '';

  const currentParent = page.parentId ? byId.get(page.parentId) : undefined;
  const childCount = descendants.size;

  function pick(i: number) {
    const e = entries[i];
    if (!e || e.disabledReason) return;
    setTarget(e.id);
    setError(null);
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!enabledIdx.length) return;
      const cur = enabledIdx.indexOf(active);
      const next = e.key === 'ArrowDown' ? Math.min(enabledIdx.length - 1, cur + 1) : Math.max(0, cur - 1);
      setActive(enabledIdx[next < 0 ? 0 : next]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(enabledIdx.includes(active) ? active : (enabledIdx[0] ?? -1));
    }
  }

  async function confirm() {
    if (target === undefined) return;
    setError(null);
    try {
      const moved = await move.mutateAsync({ pageId: page.id, parentId: target, afterId: afterNode?.id ?? null });
      toast.success(
        `Moved “${page.title}” ${target === null ? 'to the top level' : `under ${targetTitle}`}`,
        childCount ? `${childCount} child ${childCount === 1 ? 'page' : 'pages'} moved with it.` : undefined,
      );
      onMoved?.(moved);
      onClose();
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const searching = query.trim().length > 0;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Move “${page.title}”`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Move “{page.title}”</h2>
            <p className={styles.subtitle}>
              {currentParent ? `Currently under ${currentParent.title}` : 'Currently at the top level'}
              {childCount > 0 && ` · ${childCount} child ${childCount === 1 ? 'page' : 'pages'} move with it`}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} aria-label="Close" onClick={onClose}>×</button>
        </header>

        <div className={styles.searchRow}>
          <input
            ref={searchRef}
            className={styles.search}
            placeholder="Find a page…"
            aria-label="Find a page"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {searching && <span className={styles.count}>{entries.length} {entries.length === 1 ? 'page' : 'pages'}</span>}
        </div>

        {searching && entries.length === 0 ? (
          <div className={styles.noResults}>
            <strong>No pages match “{query.trim()}”</strong>
            <span>Try part of a title.</span>
          </div>
        ) : (
          <ul className={styles.tree} role="listbox" aria-label="Pages">
            {entries.map((e, i) => {
              const disabled = !!e.disabledReason;
              const selected = target !== undefined && target === e.id;
              return (
                <li
                  key={e.id ?? 'top'}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled}
                  className={[
                    styles.item,
                    selected ? styles.selected : '',
                    disabled ? styles.disabled : '',
                    searching && i === active && !disabled ? styles.active : '',
                  ].join(' ')}
                  style={{ paddingLeft: 12 + e.depth * 18 }}
                  onClick={() => pick(i)}
                >
                  <span className={styles.itemTitle}>
                    {disabled && <span aria-hidden="true">🔒 </span>}
                    {searching ? highlight(e.title, query) : e.title}
                  </span>
                  {e.path && <span className={styles.path}>{e.path}</span>}
                  {disabled && <span className={styles.reason}>{e.disabledReason}</span>}
                  {selected && <span className={styles.badge}>Move here</span>}
                </li>
              );
            })}
          </ul>
        )}

        <p className={styles.preview} aria-live="polite">
          {target === undefined
            ? 'Choose where to move this page.'
            : `Will be placed ${target === null ? 'at the top level' : `under ${targetTitle}`}, ${
                afterNode ? `after ${afterNode.title}` : target === null ? 'as the first page' : 'as its first child'
              }.`}
        </p>
        <p className={styles.help}>
          Click a page to move under it. Grayed pages can’t be chosen: a page can’t go inside itself.
        </p>
        {error && <p className={styles.error} role="alert">{error}</p>}

        <footer className={styles.footer}>
          <span className={styles.muted}>Links to this page keep working.</span>
          <div className={styles.btns}>
            <button type="button" className={styles.ghostBtn} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={target === undefined || move.isPending}
              onClick={() => void confirm()}
            >
              {move.isPending ? 'Moving…' : 'Move'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
