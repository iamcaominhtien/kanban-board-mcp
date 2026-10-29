import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { docsErrorDetail, useDiscardDraft, useMarkDocsSeen, usePublishPage, useSaveDraft } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import { ConflictBanner } from './ConflictBanner';
import { HeadingRenameNote } from './HeadingRenameNote';
import { DiscardDialog } from './DiscardDialog';
import { previewOrphans } from '../../api/docsComments';
import { getAvatarColors } from '../MemberAvatar';
import { CommentsPanel } from './comments/CommentsPanel';
import { OrphanWarning } from './comments/OrphanWarning';
import { ComposePopover, type Pick } from './comments/SelectionComment';
import { useCommentsController } from './comments/useCommentsController';
import './comments/comments.css';
import { DocsEditor, type DocsEditorHandle, type EditorMode } from './editor/DocsEditor';
import { createEditorReplaceAdapter, setActiveReplaceAdapter } from './editorReplace';
import { Icon } from './Icon';
import { BackOnlineBanner, OfflineBanner, useOnline } from './OfflineBanners';
import { PublishDialog } from './PublishDialog';
import { lineDiffCounts } from '../../utils/lineDiff';
import { markOwnPublish } from './useDocsNotifications';
import './docs.css';
import { DocsAi, startSelectionDraft } from '../assist/DocsAi';
import { useAssist } from '../assist/AssistContext';
import { useQueryClient } from '@tanstack/react-query';

interface Props {
  projectId: string;
  /** Space root shown first in the breadcrumb. */
  projectName?: string;
  page: DocsPage;
  nodes: DocsTreeNode[];
  onExit: (page?: DocsPage) => void;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  /** Collapsed tree rail shown at the left while editing. */
  rail?: ReactNode;
  /** Ref to the ProseMirror root (for find-in-page). */
  onEditorRoot?: (el: HTMLElement | null) => void;
}

type SaveState = 'saved' | 'saving' | 'error' | 'dirty';
const AUTOSAVE_MS = 3000;
const offlineKey = (pageId: string) => `docsOfflineDraft:${pageId}`;

/**
 * Full-screen page editor with Publish, Discard and conflict handling.
 * @param props.projectId - Project the page belongs to.
 * @param props.projectName - Space root shown first in the breadcrumb.
 * @param props.page - Page being edited.
 * @param props.nodes - Page tree, used for `[[` suggestions.
 * @param props.onExit - Called when leaving the editor; receives the updated page after Publish, nothing after Discard.
 * @param props.onOpenPage - Called with page id and anchor when a page reference is opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.rail - Collapsed tree rail shown at the left while editing.
 * @param props.onEditorRoot - Receives the ProseMirror root element (for find-in-page).
 */
export function DocsEditScreen({
  projectId,
  projectName,
  page,
  nodes,
  onExit,
  onOpenPage,
  onOpenTicket,
  rail,
  onEditorRoot,
}: Props) {
  const toast = useToast();
  const assist = useAssist();
  const qc = useQueryClient();
  const [aiMenu, setAiMenu] = useState(false);
  const saveDraft = useSaveDraft(projectId);
  const publish = usePublishPage(projectId);
  const markSeen = useMarkDocsSeen();
  const discard = useDiscardDraft(projectId);
  const { online, setOnline, justBack, clearJustBack } = useOnline();

  const baseMarkdown = page.markdown;
  // a draft typed offline and never synced wins over the server copy
  const localDraft = (() => {
    try {
      const raw = localStorage.getItem(offlineKey(page.id));
      return raw ? (JSON.parse(raw) as { markdown: string; title: string; at: string }) : null;
    } catch {
      return null;
    }
  })();
  const [markdown, setMarkdown] = useState(localDraft?.markdown ?? page.draft?.markdown ?? page.markdown);
  const [title, setTitle] = useState(localDraft?.title ?? page.draft?.title ?? page.title);
  const [baseVersion] = useState(page.draft?.baseVersion ?? page.version);
  const [mode, setMode] = useState<EditorMode>('visual');
  const [saveState, setSaveState] = useState<SaveState>(localDraft ? 'dirty' : 'saved');
  const [savedAt, setSavedAt] = useState<Date | null>(page.draft ? new Date(page.draft.updatedAt) : null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [orphans, setOrphans] = useState<{ id: string; quote: string }[] | null>(null);
  const [compose, setCompose] = useState<Pick | null>(null);
  const cc = useCommentsController(page.id);
  const commentsData = cc.query.data;
  const commentTotal = commentsData ? commentsData.counts.all + commentsData.counts.page : 0;
  const canComment = commentsData?.role !== 'viewer';
  const highlightThreads = useMemo(
    () =>
      (commentsData?.threads ?? []).flatMap((t) =>
        t.kind === 'inline' && t.status === 'open' && t.number != null && t.anchor?.quote
          ? [
              {
                id: t.id,
                number: t.number,
                quote: t.anchor.quote,
                prefix: t.anchor.prefix,
                suffix: t.anchor.suffix,
                section: t.anchor.section,
              },
            ]
          : [],
      ),
    [commentsData],
  );
  const suggest = useMemo(
    () => (commentsData?.members ?? []).map((m) => ({ id: m.id, name: m.name, ...getAvatarColors(m.color) })),
    [commentsData],
  );

  function onPick(p: Pick) {
    if (cc.reattachId) {
      const threadId = cc.reattachId;
      void cc.actions.reattach.mutateAsync({ threadId, anchor: p.anchor }).then(() => {
        cc.setReattachId(null);
        cc.activate(threadId);
      });
      return;
    }
    setCompose(p);
  }
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    latestVersion: number;
    latestAuthor?: string | null;
    latestAt?: string | null;
  } | null>(null);

  const editor = useRef<DocsEditorHandle>(null);
  const mountedAt = useRef(Date.now());
  const userInput = useRef(false);
  const latest = useRef({ markdown, title, baseVersion });
  latest.current = { markdown, title, baseVersion };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(Boolean(localDraft));

  const keepLocal = useCallback(() => {
    try {
      localStorage.setItem(
        offlineKey(page.id),
        JSON.stringify({
          markdown: latest.current.markdown,
          title: latest.current.title,
          at: new Date().toISOString(),
        }),
      );
    } catch {
      /* storage full or blocked: the in-memory copy still exists */
    }
  }, [page.id]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    editor.current?.flush();
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
      try {
        localStorage.removeItem(offlineKey(page.id));
      } catch {
        /* ignore */
      }
      setSavedAt(new Date());
      setSaveState('saved');
      setOnline(true);
      return true;
    } catch (err) {
      keepLocal();
      setSaveState('error');
      if (!docsErrorDetail(err)) setOnline(false);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, keepLocal]);

  const touch = useCallback(() => {
    dirty.current = true;
    setSaveState('dirty');
    keepLocal();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush, keepLocal]);

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

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // find-in-page can replace text through the editor
  useEffect(() => {
    setActiveReplaceAdapter(createEditorReplaceAdapter(() => editor.current?.getEditor() ?? null));
    return () => setActiveReplaceAdapter(undefined);
  }, []);

  // reconnect: push the locally kept draft
  useEffect(() => {
    if (online && dirty.current && saveState === 'error') void flush();
  }, [online, saveState, flush]);

  async function doPublish(note: string, notify: boolean, base = baseVersion) {
    setError(null);
    if (!title.trim()) {
      setError('Give the page a title before publishing.');
      return;
    }
    const md = editor.current?.flush() ?? markdown;
    try {
      markOwnPublish(page.id);
      const updated = await publish.mutateAsync({
        pageId: page.id,
        baseVersion: base,
        note: note.trim() || undefined,
        markdown: md,
        title: title.trim(),
        notify,
      });
      dirty.current = false;
      try {
        localStorage.removeItem(offlineKey(page.id));
      } catch {
        /* ignore */
      }
      setPublishOpen(false);
      setConflict(null);
      markSeen(page.id, updated.version);
      toast.success(`Published v${updated.version}`, updated.title);
      onExit(updated);
    } catch (err) {
      const d = docsErrorDetail(err);
      if (d?.code === 'conflict') {
        setPublishOpen(false);
        setConflict({ latestVersion: d.latestVersion ?? base + 1, latestAuthor: d.latestAuthor, latestAt: d.latestAt });
      } else {
        setError(d?.message ?? extractError(err));
        if (!d) setOnline(false);
      }
    }
  }

  async function doDiscard() {
    try {
      await discard.mutateAsync(page.id);
      dirty.current = false;
      try {
        localStorage.removeItem(offlineKey(page.id));
      } catch {
        /* ignore */
      }
      setDiscardOpen(false);
      onExit();
    } catch (err) {
      setError(extractError(err));
      setDiscardOpen(false);
    }
  }

  // lines this edit changed against the version it started from (the conflict banner quotes it)
  const ownLines = conflict
    ? (() => {
        const d = lineDiffCounts(baseMarkdown, markdown);
        return d.added + d.removed;
      })()
    : undefined;

  const openPublish = () => {
    if (conflict || !online) return;
    void flush().then(async () => {
      // comments whose text the edits removed would be orphaned: warn first
      try {
        const res = await previewOrphans(page.id, editor.current?.flush() ?? latest.current.markdown);
        if (res.count > 0) {
          setOrphans(res.orphaned);
          return;
        }
      } catch {
        /* the warning is a courtesy: publishing still works without it */
      }
      setPublishOpen(true);
    });
  };

  // From the first keystroke until the autosave lands the draft is not up to date: "Saving…" (design/docs-editor A).
  // A keystroke that changed nothing never reaches touch(): settle the label again.
  useEffect(() => {
    if (saveState !== 'dirty') return;
    const t = setTimeout(() => {
      if (!dirty.current) setSaveState('saved');
    }, AUTOSAVE_MS + 1500);
    return () => clearTimeout(t);
  }, [saveState]);

  // Cmd/Ctrl+S saves the draft now, Cmd/Ctrl+Enter opens Publish, Cmd/Ctrl+Shift+M flips Visual/Markdown.
  // Captured before the editor sees the key (Mod-Enter would otherwise leave a code block or add a break).
  const keys = useRef({ openPublish, flush, mode, blocked: false });
  keys.current = {
    openPublish,
    flush,
    mode,
    blocked: publishOpen || discardOpen || Boolean(orphans) || Boolean(compose),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      const act =
        k === 's' && !e.shiftKey
          ? 'save'
          : k === 'enter' && !e.shiftKey
            ? 'publish'
            : k === 'm' && e.shiftKey
              ? 'mode'
              : null;
      if (!act) return;
      e.preventDefault();
      if (keys.current.blocked) return;
      e.stopPropagation();
      if (act === 'save') void keys.current.flush();
      else if (act === 'publish') keys.current.openPublish();
      else {
        editor.current?.flush();
        setMode(keys.current.mode === 'visual' ? 'markdown' : 'visual');
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const saveLabel =
    saveState === 'saving' || saveState === 'dirty'
      ? 'Saving…'
      : saveState === 'error'
        ? 'Not saved — will retry'
        : 'Saved';

  return (
    <div
      className="docs-root"
      data-testid="docs-edit-screen"
      style={{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0, background: '#FFFFFF' }}
    >
      {rail}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            height: 56,
            padding: '0 24px',
            borderBottom: '1px solid #E3E8E5',
            background: '#FFFFFF',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            {projectName && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: '#5B6B60' }}>{projectName}</span>
                <Icon name="i05" size={12} style={{ color: '#9AA8A0' }} />
              </span>
            )}
            {page.path.map((p) => (
              <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: '#5B6B60' }}>{p.title}</span>
                <Icon name="i05" size={12} style={{ color: '#9AA8A0' }} />
              </span>
            ))}
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: '#1E2A22',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {title || 'Untitled'}
            </span>
          </div>
          <span className="mc-chip" style={{ background: '#FCEFD9', color: '#7A4F08' }}>
            <span className="mc-dot" style={{ background: '#B4791E' }} />
            {page.version === 0 ? 'Draft' : `Draft · based on v${baseVersion}`}
          </span>
          <div style={{ flex: 1 }} />
          {!online ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 26,
                padding: '0 10px',
                borderRadius: 999,
                background: '#FCEFD9',
                fontSize: 12,
                fontWeight: 700,
                color: '#7A4F08',
                whiteSpace: 'nowrap',
              }}
              data-testid="save-state"
            >
              <Icon name="i37" size={13} />
              Offline — changes kept locally
            </span>
          ) : (
            <span
              role="status"
              data-testid="save-state"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                color: saveState === 'error' ? '#C4432A' : saveState === 'saved' ? '#2E6F40' : '#5B6B60',
              }}
            >
              {saveState === 'saving' || saveState === 'dirty' ? (
                <span className="mc-spin" />
              ) : saveState === 'saved' ? (
                <Icon name="i17" size={14} />
              ) : null}
              {saveLabel}
              {saveState === 'saved' && savedAt && (
                <span style={{ fontWeight: 500, color: '#9AA8A0' }}>
                  {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
            </span>
          )}
          <div
            role="group"
            aria-label="Editor mode"
            style={{ display: 'flex', padding: 3, borderRadius: 8, background: '#EEF3EF', gap: 2 }}
          >
            {(['visual', 'markdown'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`mb-view-btn ${mode === m ? 'mb-view-btn-active' : ''}`}
                data-testid={m === 'markdown' ? 'mode-markdown' : 'mode-visual'}
                onClick={() => {
                  editor.current?.flush();
                  setMode(m);
                }}
                style={{
                  padding: '5px 11px',
                  borderRadius: 6,
                  border: 'none',
                  background: mode === m ? '#FFFFFF' : 'none',
                  boxShadow: mode === m ? '0 1px 2px rgba(30,42,34,0.10)' : 'none',
                  color: mode === m ? '#1E2A22' : '#5B6B60',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {m === 'visual' ? 'Visual' : 'Markdown'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="st-btn st-btn-sm"
            aria-pressed={cc.open}
            data-testid="comments-button"
            onClick={() => cc.setOpen((v) => !v)}
          >
            <Icon name="comment" size={13} strokeWidth={1.9} />
            Comments
            <span className="dc-btn-count" data-testid="comments-count">
              {commentTotal}
            </span>
          </button>
          <button
            type="button"
            className="st-btn st-btn-danger-outline st-btn-sm"
            onClick={() => setDiscardOpen(true)}
            data-testid="discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            disabled={Boolean(conflict) || !online}
            onClick={openPublish}
            data-testid="publish"
          >
            <Icon name="i46" size={13} />
            Publish
          </button>
        </header>

        {conflict && (
          <ConflictBanner
            pageId={page.id}
            baseVersion={baseVersion}
            latestVersion={conflict.latestVersion}
            latestAuthor={conflict.latestAuthor}
            latestAt={conflict.latestAt}
            ownLines={ownLines}
            busy={publish.isPending}
            onKeepMine={() => void doPublish('', false, conflict.latestVersion)}
            onReload={() => void doDiscard()}
          />
        )}
        {!online && <OfflineBanner onRetry={() => void flush().then((ok) => ok && setOnline(true))} />}
        {online && justBack && <BackOnlineBanner onDismiss={clearJustBack} />}
        <HeadingRenameNote pageId={page.id} published={page.headings} markdown={markdown} />
        {error && !publishOpen && (
          <div role="alert" style={{ padding: '8px 24px', background: '#FBE7E4', color: '#A5321E', fontSize: 12.5 }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <DocsEditor
              ref={editor}
              projectId={projectId}
              markdown={markdown}
              mode={mode}
              nodes={nodes}
              currentPageId={page.id}
              pageTitle={title}
              filename={`${page.slug}.md`}
              onOpenPage={onOpenPage}
              onOpenTicket={onOpenTicket}
              onChange={(md) => {
                if (md === latest.current.markdown) return;
                setMarkdown(md);
                // the editor re-serialises the markdown right after loading: that is not an edit
                if (!userInput.current && Date.now() - mountedAt.current < 2500 && !dirty.current) return;
                touch();
              }}
              comments={
                canComment
                  ? { threads: highlightThreads, activeId: cc.activeId, onSelect: cc.activate, onPick }
                  : undefined
              }
              onBlur={() => void flush()}
              onUserInput={() => {
                userInput.current = true;
                // the editor reports changes after a short debounce: flag the draft as behind right away
                setSaveState((s) => (s === 'saved' ? 'dirty' : s));
              }}
              ai={{
                onAsk: () => setAiMenu((v) => !v),
                onSelection: (action, text) => {
                  if (action === 'ask') {
                    assist?.ask({
                      scope: 'doc',
                      docId: page.id,
                      fresh: true,
                      text: `About this passage of the page: “${text.slice(0, 600)}” — what does it mean, and is anything missing?`,
                    });
                    return;
                  }
                  void startSelectionDraft(projectId, page.id, action, text)
                    .then(() => qc.invalidateQueries({ queryKey: ['assist', 'doc-drafts', projectId, page.id] }))
                    .catch((e: unknown) => toast.error('Board AI', extractError(e)));
                },
              }}
              header={
                <div style={{ paddingBottom: 12, marginBottom: 6, borderBottom: '1px solid #E3E8E5' }}>
                  <input
                    aria-label="Page title"
                    placeholder="Page title"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      touch();
                    }}
                    style={{
                      width: '100%',
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      fontFamily: 'inherit',
                      fontSize: 32,
                      fontWeight: 800,
                      lineHeight: 1.15,
                      letterSpacing: '-0.01em',
                      color: '#1E2A22',
                      padding: 0,
                    }}
                  />
                  <DocsAi
                    projectId={projectId}
                    pageId={page.id}
                    pageTitle={title}
                    menuOpen={aiMenu}
                    setMenuOpen={setAiMenu}
                    ed={{
                      getEditor: () => editor.current?.getEditor() ?? null,
                      getMarkdown: () => editor.current?.flush() ?? latest.current.markdown,
                      setMarkdown: (md) => {
                        editor.current
                          ?.getEditor()
                          ?.commands.setContent(md, { contentType: 'markdown', emitUpdate: true } as never);
                        userInput.current = true;
                        setMarkdown(md);
                        touch();
                      },
                    }}
                  />
                </div>
              }
            />
          </div>
          {cc.open && (
            <CommentsPanel
              pageId={page.id}
              projectId={projectId}
              version={page.version}
              data={commentsData}
              loading={cc.query.isLoading}
              error={cc.query.isError}
              onRetry={() => void cc.query.refetch()}
              actions={cc.actions}
              tab={cc.tab}
              onTab={cc.setTab}
              activeId={cc.activeId}
              onActivate={cc.activate}
              reattachId={cc.reattachId}
              onReattach={cc.setReattachId}
              onClose={() => cc.setOpen(false)}
            />
          )}
        </div>
        <EditorRootBridge editor={editor} onEditorRoot={onEditorRoot} mode={mode} />
      </div>

      {publishOpen && (
        <PublishDialog
          projectId={projectId}
          pageTitle={title || page.title}
          fromVersion={baseVersion}
          baseMarkdown={baseMarkdown}
          draftMarkdown={editor.current?.flush() ?? markdown}
          publishing={publish.isPending}
          error={error}
          onClose={() => setPublishOpen(false)}
          onReview={() => {
            setPublishOpen(false);
            toast.info('Review changes', 'Open Page history to compare your draft with the published version.');
          }}
          onPublish={(note, notify) => void doPublish(note, notify)}
        />
      )}
      {orphans && (
        <OrphanWarning
          count={orphans.length}
          quotes={orphans.map((o) => o.quote)}
          onClose={() => setOrphans(null)}
          onReview={() => {
            setOrphans(null);
            cc.setTab('open');
            cc.setOpen(true);
          }}
          onPublish={() => {
            setOrphans(null);
            setPublishOpen(true);
          }}
        />
      )}
      {compose && (
        <ComposePopover
          pick={compose}
          projectId={projectId}
          members={suggest}
          onCancel={() => setCompose(null)}
          onSubmit={async (text) => {
            const t = await cc.actions.createThread.mutateAsync({ kind: 'inline', body: text, anchor: compose.anchor });
            setCompose(null);
            cc.created(t);
          }}
        />
      )}
      {discardOpen && (
        <DiscardDialog
          pageTitle={title || page.title}
          version={page.version}
          baseMarkdown={baseMarkdown}
          draftMarkdown={markdown}
          savedAt={savedAt}
          onClose={() => setDiscardOpen(false)}
          onDiscard={() => void doDiscard()}
        />
      )}
    </div>
  );
}

/** Hands the ProseMirror root to the parent (find-in-page) once it exists. */
function EditorRootBridge({
  editor,
  onEditorRoot,
  mode,
}: {
  editor: React.RefObject<DocsEditorHandle>;
  onEditorRoot?: (el: HTMLElement | null) => void;
  mode: EditorMode;
}) {
  useEffect(() => {
    onEditorRoot?.(mode === 'visual' ? (editor.current?.getRoot() ?? null) : null);
    return () => onEditorRoot?.(null);
  }, [editor, onEditorRoot, mode]);
  return null;
}
