import { useEffect, useMemo, useRef, useState } from 'react';
import { docsErrorDetail, useDuplicatePage } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import styles from './DuplicateDialog.module.css';

interface DuplicateDialogProps {
  projectId: string;
  page: DocsPage;
  nodes: DocsTreeNode[];
  onClose: () => void;
  onDuplicated?: (page: DocsPage) => void;
}

interface Option {
  id: string | null;
  label: string;
}

function sortedChildren(nodes: DocsTreeNode[], parentId: string | null): DocsTreeNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.position - b.position);
}

export function DuplicateDialog({ projectId, page, nodes, onClose, onDuplicated }: DuplicateDialogProps) {
  const toast = useToast();
  const duplicate = useDuplicatePage(projectId);
  const [title, setTitle] = useState(`${page.title} (copy)`);
  const [parentId, setParentId] = useState<string | null>(page.parentId);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const options: Option[] = useMemo(() => {
    const out: Option[] = [{ id: null, label: 'Top level' }];
    const walk = (pid: string | null, depth: number) => {
      for (const n of sortedChildren(nodes, pid)) {
        out.push({ id: n.id, label: `${'  '.repeat(depth)}${n.title}` });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [nodes]);

  /** Sub-pages that would be copied, in tree order, with their depth under the page. */
  const subPages = useMemo(() => {
    const out: { id: string; title: string; depth: number }[] = [];
    const walk = (pid: string, depth: number) => {
      for (const n of sortedChildren(nodes, pid)) {
        out.push({ id: n.id, title: n.title, depth });
        walk(n.id, depth + 1);
      }
    };
    walk(page.id, 1);
    return out;
  }, [nodes, page.id]);

  const location = useMemo(() => {
    const parts: string[] = [];
    let cur = page.parentId ? byId.get(page.parentId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.length ? parts.join(' › ') : 'Top level';
  }, [byId, page.parentId]);

  const hasChildren = subPages.length > 0;
  const on = hasChildren && includeChildren;
  const trimmed = title.trim();

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!trimmed) return;
    setError(null);
    try {
      const copy = await duplicate.mutateAsync({
        pageId: page.id,
        title: trimmed,
        parentId,
        includeChildren: on,
      });
      toast.success(`Duplicated “${page.title}”`, 'The copy is a draft.');
      onDuplicated?.(copy);
      onClose();
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Duplicate “${page.title}”`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Duplicate “{page.title}”</h2>
            <p className={styles.subtitle}>
              {location}
              {hasChildren && ` · ${subPages.length} child ${subPages.length === 1 ? 'page' : 'pages'}`}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} aria-label="Close" onClick={onClose}>×</button>
        </header>

        <label className={styles.label} htmlFor="dup-title">Title</label>
        <input
          id="dup-title"
          ref={titleRef}
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className={styles.label} htmlFor="dup-parent">Location</label>
        <select
          id="dup-parent"
          className={styles.input}
          value={parentId ?? ''}
          onChange={(e) => setParentId(e.target.value || null)}
        >
          {options.map((o) => (
            <option key={o.id ?? 'top'} value={o.id ?? ''}>{o.label}</option>
          ))}
        </select>
        <p className={styles.hint}>Same place as the original. Choose another to copy it elsewhere.</p>

        <label className={`${styles.toggleRow} ${hasChildren ? '' : styles.toggleDisabled}`}>
          <input
            type="checkbox"
            role="switch"
            checked={on}
            disabled={!hasChildren}
            onChange={(e) => setIncludeChildren(e.target.checked)}
          />
          <span>
            <span className={styles.toggleTitle}>Include child pages</span>
            <span className={styles.toggleDesc}>
              {hasChildren
                ? `Copies ${subPages.map((s) => s.title).join(', ')} as well, under the new page.`
                : `${page.title} has no child pages.`}
            </span>
          </span>
        </label>

        {on && (
          <ul className={styles.preview} aria-label="Pages that will be created">
            <li>
              <span>{trimmed || `${page.title} (copy)`}</span>
              <span className={styles.tag}>New</span>
            </li>
            {subPages.map((s) => (
              <li key={s.id} style={{ paddingLeft: 12 + s.depth * 16 }}>
                <span>{s.title}</span>
                <span className={styles.tagMuted}>Copy of {s.title}</span>
              </li>
            ))}
          </ul>
        )}

        <ul className={styles.checks}>
          <li><span className={styles.yes} aria-hidden="true">✓</span> Content as of v{page.version}, headings and tables</li>
          <li><span className={styles.yes} aria-hidden="true">✓</span> Links and ticket chips, unchanged</li>
          <li><span className={styles.no} aria-hidden="true">✕</span> Version history, comments and Referenced by (the copy starts at v1)</li>
        </ul>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <footer className={styles.footer}>
          <span className={styles.muted}>The copy is created as a draft.</span>
          <div className={styles.btns}>
            <button type="button" className={styles.ghostBtn} onClick={onClose}>Cancel</button>
            <button type="submit" className={styles.primaryBtn} disabled={!trimmed || duplicate.isPending}>
              {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
