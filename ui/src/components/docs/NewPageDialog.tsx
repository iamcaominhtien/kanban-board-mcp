import { useEffect, useMemo, useState } from 'react';
import { docsErrorDetail, useCreatePage, useDocsTemplates } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { MarkdownRenderer } from '../MarkdownRenderer';
import styles from './NewPageDialog.module.css';

interface Props {
  projectId: string;
  nodes: DocsTreeNode[];
  initialParentId: string | null;
  initialTemplate?: string;
  onClose: () => void;
  onCreated: (page: DocsPage) => void;
}

function pathOf(nodes: DocsTreeNode[], id: string | null): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    parts.unshift(cur.title);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' › ');
}

export function NewPageDialog({ projectId, nodes, initialParentId, initialTemplate = 'blank', onClose, onCreated }: Props) {
  const { data: templates = [] } = useDocsTemplates();
  const create = useCreatePage(projectId);
  const [template, setTemplate] = useState(initialTemplate);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [error, setError] = useState<string | null>(null);
  const tpl = templates.find((t) => t.id === template);

  // the title defaults to the template name until the user types their own
  useEffect(() => {
    if (!titleTouched && tpl) setTitle(tpl.id === 'blank' ? '' : tpl.name);
  }, [tpl, titleTouched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const options = useMemo(
    () =>
      nodes
        .map((n) => ({ id: n.id, label: pathOf(nodes, n.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [nodes],
  );
  const clash = useMemo(
    () =>
      title.trim() &&
      nodes.some((n) => n.parentId === parentId && n.title.toLowerCase() === title.trim().toLowerCase()),
    [nodes, parentId, title],
  );
  const empty = titleTouched && !title.trim();

  async function submit() {
    if (!title.trim()) {
      setTitleTouched(true);
      return;
    }
    setError(null);
    try {
      const page = await create.mutateAsync({ title: title.trim(), parentId, template });
      onCreated(page);
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="New page">
        <div className={styles.head}>
          <div>
            <h2>New page</h2>
            <p>Choose a template, then name the page</p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.body}>
          <div className={styles.templates} role="radiogroup" aria-label="Template">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={template === t.id}
                className={`${styles.tpl} ${template === t.id ? styles.tplOn : ''}`}
                onClick={() => setTemplate(t.id)}
                data-testid={`template-${t.id}`}
              >
                <strong>{t.name}</strong>
                <span>{t.description}</span>
                {template === t.id && <i aria-hidden="true">✓</i>}
              </button>
            ))}
          </div>
          <div className={styles.right}>
            <div className={styles.preview}>
              <div className={styles.previewLabel}>Preview · {tpl?.name ?? ''}</div>
              {tpl && tpl.markdown ? (
                <MarkdownRenderer>{tpl.markdown}</MarkdownRenderer>
              ) : (
                <p className={styles.blank}>Type <kbd>/</kbd> to start</p>
              )}
            </div>
            <label className={styles.field}>
              <span>Title</span>
              <input
                autoFocus
                value={title}
                placeholder="Page title"
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                aria-invalid={empty}
                aria-label="Title"
              />
              {empty && <em className={styles.err}>Give the page a title to create it.</em>}
              {clash && !empty && (
                <em className={styles.warn}>
                  A page named “{title.trim()}” already exists here. You can still create it; the new page gets its own address.
                </em>
              )}
            </label>
            <label className={styles.field}>
              <span>Parent page</span>
              <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)} aria-label="Parent page">
                <option value="">Top level (no parent)</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <small>
                The new page will be placed at the end of {parentId ? <b>{pathOf(nodes, parentId)}</b> : 'the top level'}. You can drag it elsewhere later.
              </small>
            </label>
            {error && <div className={styles.fail} role="alert">{error}</div>}
          </div>
        </div>
        <div className={styles.foot}>
          <span>Created as a draft. Only you can see its content until you publish.</span>
          <button type="button" className={styles.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={styles.primary} disabled={create.isPending} onClick={() => void submit()} data-testid="create-page">
            {create.isPending ? 'Creating…' : 'Create page'}
          </button>
        </div>
      </div>
    </div>
  );
}
