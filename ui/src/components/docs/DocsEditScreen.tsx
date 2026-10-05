import { useCallback, useEffect, useRef, useState } from 'react';
import { docsErrorDetail, useDiscardDraft, usePublishPage, useSaveDraft } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { actorName } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { DocsEditor, type EditorMode } from './DocsEditor';
import styles from './DocsEditScreen.module.css';

interface Props {
  projectId: string;
  page: DocsPage;
  nodes: DocsTreeNode[];
  onExit: (page?: DocsPage) => void;
}

type SaveState = 'saved' | 'saving' | 'error' | 'dirty';
const AUTOSAVE_MS = 3000;

export function DocsEditScreen({ projectId, page, nodes, onExit }: Props) {
  const toast = useToast();
  const saveDraft = useSaveDraft(projectId);
  const publish = usePublishPage(projectId);
  const discard = useDiscardDraft(projectId);

  const [markdown, setMarkdown] = useState(page.draft?.markdown ?? page.markdown);
  const [title, setTitle] = useState(page.draft?.title ?? page.title);
  const [baseVersion] = useState(page.draft?.baseVersion ?? page.version);
  const [mode, setMode] = useState<EditorMode>('visual');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<Date | null>(page.draft ? new Date(page.draft.updatedAt) : null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ latestVersion: number; latestAuthor?: string | null } | null>(null);

  const latest = useRef({ markdown, title, baseVersion });
  latest.current = { markdown, title, baseVersion };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (!dirty.current) return true;
    setSaveState('saving');
    try {
      await saveDraft.mutateAsync({
        pageId: page.id,
        markdown: latest.current.markdown,
        title: latest.current.title,
        baseVersion: latest.current.baseVersion,
      });
      dirty.current = false;
      setSavedAt(new Date());
      setSaveState('saved');
      return true;
    } catch {
      setSaveState('error');
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  const touch = useCallback(() => {
    dirty.current = true;
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // a pending draft is saved when the screen goes away (e.g. another page is opened)
  useEffect(
    () => () => {
      if (dirty.current) {
        saveDraft.mutate({
          pageId: page.id,
          markdown: latest.current.markdown,
          title: latest.current.title,
          baseVersion: latest.current.baseVersion,
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.id],
  );

  // warn before the window closes with unsaved changes
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  async function doPublish(base = baseVersion) {
    setError(null);
    if (!title.trim()) {
      setError('Give the page a title before publishing.');
      return;
    }
    try {
      const updated = await publish.mutateAsync({
        pageId: page.id,
        baseVersion: base,
        note: note.trim() || undefined,
        markdown,
        title: title.trim(),
      });
      dirty.current = false;
      setPublishOpen(false);
      setConflict(null);
      toast.success(`Published v${updated.version}`, updated.title);
      onExit(updated);
    } catch (err) {
      const d = docsErrorDetail(err);
      if (d?.code === 'conflict') {
        setPublishOpen(false);
        setConflict({ latestVersion: d.latestVersion ?? base + 1, latestAuthor: d.latestAuthor });
      } else {
        setError(d?.message ?? extractError(err));
      }
    }
  }

  async function doDiscard() {
    try {
      await discard.mutateAsync(page.id);
      dirty.current = false;
      setDiscardOpen(false);
      onExit();
    } catch (err) {
      setError(extractError(err));
    }
  }

  const statusLabel =
    saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Offline — will retry' : saveState === 'dirty' ? 'Unsaved changes' : 'Saved';

  return (
    <div className={styles.screen} data-testid="docs-edit-screen">
      <header className={styles.header}>
        <div className={styles.crumbs}>
          {page.path.map((p) => (
            <span key={p.id}>{p.title} › </span>
          ))}
          <b>{title || 'Untitled'}</b>
        </div>
        <div className={styles.row}>
          <span className={styles.badge}>
            {page.version === 0 ? 'Draft' : `Draft · based on v${baseVersion}`}
          </span>
          <span className={`${styles.save} ${saveState === 'error' ? styles.saveErr : ''}`} role="status" data-testid="save-state">
            {statusLabel}
            {saveState === 'saved' && savedAt && <> · {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</>}
          </span>
          <span className={styles.spacer} />
          <div className={styles.toggle} role="group" aria-label="Editor mode">
            <button type="button" className={mode === 'visual' ? styles.on : ''} onClick={() => setMode('visual')}>Visual</button>
            <button type="button" className={mode === 'markdown' ? styles.on : ''} onClick={() => setMode('markdown')} data-testid="mode-markdown">Markdown</button>
          </div>
          <button type="button" className={styles.ghost} onClick={() => setDiscardOpen(true)} data-testid="discard">Discard</button>
          <button type="button" className={styles.primary} onClick={() => void flush().then(() => setPublishOpen(true))} data-testid="publish">Publish</button>
        </div>
      </header>

      {conflict && (
        <div className={styles.conflict} role="alert" data-testid="conflict-banner">
          <div>
            <strong>{actorName(conflict.latestAuthor ?? 'someone')} published v{conflict.latestVersion} while you were editing.</strong>
            <span>
              Keep mine publishes your text as v{conflict.latestVersion + 1}; their version stays in the page history. Reload drops your draft.
            </span>
          </div>
          <button type="button" className={styles.primary} onClick={() => void doPublish(conflict.latestVersion)} data-testid="keep-mine">Keep mine</button>
          <button type="button" className={styles.ghost} onClick={() => void doDiscard()} data-testid="reload-theirs">Reload</button>
        </div>
      )}
      {error && <div className={styles.errorBar} role="alert">{error}</div>}

      <div className={styles.column}>
        <input
          className={styles.title}
          value={title}
          placeholder="Page title"
          aria-label="Page title"
          onChange={(e) => {
            setTitle(e.target.value);
            touch();
          }}
        />
        <DocsEditor
          projectId={projectId}
          markdown={markdown}
          mode={mode}
          nodes={nodes}
          currentPageId={page.id}
          onChange={(md) => {
            if (md !== latest.current.markdown) {
              setMarkdown(md);
              touch();
            }
          }}
          onSave={() => void flush()}
          onPublish={() => void flush().then(() => setPublishOpen(true))}
          onToggleMode={() => setMode((m) => (m === 'visual' ? 'markdown' : 'visual'))}
        />
      </div>

      {publishOpen && (
        <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && setPublishOpen(false)}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Publish page">
            <h3>Publish {title || 'page'}</h3>
            <p>Creates v{baseVersion + 1}. Everyone in the project sees this version.</p>
            <label>
              <span>Note (optional)</span>
              <input
                autoFocus
                value={note}
                placeholder="What changed?"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doPublish()}
                aria-label="Version note"
              />
            </label>
            <div className={styles.actions}>
              <button type="button" className={styles.ghost} onClick={() => setPublishOpen(false)}>Cancel</button>
              <button type="button" className={styles.primary} disabled={publish.isPending} onClick={() => void doPublish()} data-testid="confirm-publish">
                {publish.isPending ? 'Publishing…' : `Publish v${baseVersion + 1}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {discardOpen && (
        <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && setDiscardOpen(false)}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Discard draft">
            <h3>Discard this draft?</h3>
            <p>
              {page.version === 0
                ? 'This page has never been published; its content will be emptied.'
                : `Your changes are deleted and the published v${page.version} stays as it is.`}
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.ghost} onClick={() => setDiscardOpen(false)}>Keep editing</button>
              <button type="button" className={styles.danger} onClick={() => void doDiscard()} data-testid="confirm-discard">Discard draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
