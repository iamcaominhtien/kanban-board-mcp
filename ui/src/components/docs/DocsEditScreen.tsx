import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { docsErrorDetail, useDiscardDraft, useMarkDocsSeen, usePublishPage, useSaveDraft } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode, RichDoc } from '../../types/docs';
import { docToMarkdown, markdownToDoc } from '../../richdoc';
import { clearLocalDraft, editableDoc, readLocalDraft, writeLocalDraft } from './richPage';
import { useToast } from '../Toast';
import { ConflictBanner } from './ConflictBanner';
import { HeadingRenameNote } from './HeadingRenameNote';
import { DiscardDialog } from './DiscardDialog';
import { previewOrphans } from '../../api/docsComments';
import { getAvatarColors } from '../MemberAvatar';
import { CommentsPanel } from './comments/CommentsPanel';
import { OrphanWarning } from './comments/OrphanWarning';
import { ComposePopover, type Pick } from './comments/SelectionComment';
import { personOf } from './comments/people';
import { useCommentsController } from './comments/useCommentsController';
import './comments/comments.css';
import { DocsEditor, type DocsEditorHandle } from './editor/DocsEditor';
import { EditorErrorBoundary } from './editor/EditorErrorBoundary';
import { createEditorReplaceAdapter, setActiveReplaceAdapter } from './editorReplace';
import { Icon } from './Icon';
import { BackOnlineBanner, OfflineBanner, useOnline } from './OfflineBanners';
import { PublishDialog } from './PublishDialog';
import { lineDiffCounts } from '../../utils/lineDiff';
import './docs.css';
import { DocsAi, docPrompt } from '../assist/DocsAi';
import { useAssist } from '../assist/AssistContext';
import { useDocsAiState } from '../../api/docsAi';
import { aiGate } from '../../utils/docsAiRules';
import { CreateTicketsDialog } from './ai/CreateTicketsDialog';
import { AiDraftChip, AiDraftPanel, goToText } from './ai/NeedsInput';
import { stripCitations } from '../../utils/writeRules';
import { consumeAiOnEdit } from './ai/editIntent';
import type { AiSlashId } from './editor/slashItems';
import { useKeyboardInset, type DocsLayout } from '../../hooks/useDocsLayout';
import { PageHeader, titleClass } from './PageHeader';
import { RichDocView } from './RichDocView';
import { BottomSheet, DocsDrawer } from './DocsSheets';
import { isWidePage, lookClass, lookVars, readPageLook } from './pageSettings';

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
  /** Desktop, tablet or phone: where the formatting bar sits and how much the header holds. */
  layout?: DocsLayout;
  /** Opens the Page settings panel; no Page settings button without it. */
  onOpenSettings?: () => void;
}

type SaveState = 'saved' | 'saving' | 'error' | 'dirty';
const AUTOSAVE_MS = 3000;

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
 * @param props.layout - Desktop (bar on top), tablet (a strip that scrolls sideways) or phone (a compact header, the
 *   bar at the bottom above the on-screen keyboard, Discard and the rest in a "…" menu).
 * @param props.onOpenSettings - Opens the Page settings panel.
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
  layout = 'desktop',
  onOpenSettings,
}: Props) {
  const toast = useToast();
  const assist = useAssist();
  const [aiMenu, setAiMenu] = useState(false);
  const [aiCommand, setAiCommand] = useState<{ id: AiSlashId; n: number } | null>(null);
  const [ticketsFrom, setTicketsFrom] = useState<string | null>(null);
  const docsAiState = useDocsAiState(projectId);
  const docsAiNow = aiGate(docsAiState.data);
  const docsAiOn = docsAiNow.show && docsAiNow.reason === null;
  // "Edit with AI…" in the reader opens the editor with the AI menu ready
  useEffect(() => {
    if (consumeAiOnEdit(page.id)) setAiMenu(true);
  }, [page.id]);
  const saveDraft = useSaveDraft(projectId);
  const publish = usePublishPage(projectId);
  const markSeen = useMarkDocsSeen();
  const discard = useDiscardDraft(projectId);
  const { online, setOnline, justBack, clearJustBack } = useOnline();

  const baseMarkdown = page.markdown;
  // a draft typed offline and never synced wins over the server copy (read once, when the editor opens)
  const [localDraft] = useState(() => readLocalDraft(page.id));
  // the page is edited as rich JSON; its plain Markdown is kept beside it for the diffs, the heading note and the AI
  const [content, setContent] = useState<RichDoc>(() => localDraft?.content ?? editableDoc(page));
  const [markdown, setMarkdown] = useState(() => docToMarkdown(content));
  const [title, setTitle] = useState(localDraft ? localDraft.title : (page.draft?.title ?? page.title));
  const [baseVersion] = useState(page.draft?.baseVersion ?? page.version);
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
  // the page as readers will see it (Preview): the text at the moment Preview was turned on
  const [preview, setPreview] = useState<RichDoc | null>(null);
  const [more, setMore] = useState(false);
  const phone = layout === 'phone';
  const look = readPageLook(page.settings);
  const settingsKey = JSON.stringify(page.settings ?? {});
  const surface = useMemo(
    () => ({ className: lookClass(readPageLook(page.settings)), style: lookVars(readPageLook(page.settings), layout) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsKey, layout],
  );
  const keyboard = useKeyboardInset(phone);
  const [conflict, setConflict] = useState<{
    latestVersion: number;
    latestAuthor?: string | null;
    latestAt?: string | null;
  } | null>(null);

  const editor = useRef<DocsEditorHandle>(null);
  const mountedAt = useRef(Date.now());
  const userInput = useRef(false);
  const latest = useRef({ content, markdown, title, baseVersion });
  latest.current = { content, markdown, title, baseVersion };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(Boolean(localDraft));

  const keepLocal = useCallback(() => {
    writeLocalDraft(page.id, { content: latest.current.content, title: latest.current.title });
  }, [page.id]);

  /** Take the editor's text as it is now (the editor reports edits after a short debounce). */
  const settle = useCallback((doc: RichDoc) => {
    if (JSON.stringify(doc) === JSON.stringify(latest.current.content)) return false;
    const md = docToMarkdown(doc);
    latest.current = { ...latest.current, content: doc, markdown: md };
    setContent(doc);
    setMarkdown(md);
    return true;
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    editor.current?.flushContent();
    if (!dirty.current) return true;
    setSaveState('saving');
    try {
      await saveDraft.mutateAsync({
        pageId: page.id,
        content: latest.current.content,
        title: latest.current.title,
        baseVersion: latest.current.baseVersion,
      });
      dirty.current = false;
      clearLocalDraft(page.id);
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

  // the AI (or "Remove citations") rewrites the whole page as Markdown: it goes through the editor, as an edit
  const replaceWithMarkdown = (md: string) => {
    userInput.current = true;
    const ed = editor.current?.getEditor();
    if (ed && !ed.isDestroyed) {
      ed.commands.setContent(md, { contentType: 'markdown', emitUpdate: true } as never);
      const doc = editor.current?.flushContent();
      if (doc) settle(doc);
    } else settle(markdownToDoc(md));
    touch();
  };

  // a pending draft is saved when the screen goes away (e.g. another page is opened)
  useEffect(
    () => () => {
      if (dirty.current) {
        saveDraft.mutate({
          pageId: page.id,
          content: latest.current.content,
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
    const doc = editor.current?.flushContent() ?? latest.current.content;
    try {
      const updated = await publish.mutateAsync({
        pageId: page.id,
        baseVersion: base,
        note: note.trim() || undefined,
        content: doc,
        title: title.trim(),
        notify,
      });
      dirty.current = false;
      clearLocalDraft(page.id);
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
      clearLocalDraft(page.id);
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

  // Cmd/Ctrl+S saves the draft now, Cmd/Ctrl+Enter opens Publish.
  // Captured before the editor sees the key (Mod-Enter would otherwise leave a code block or add a break).
  const keys = useRef({ openPublish, flush, blocked: false });
  keys.current = {
    openPublish,
    flush,
    blocked: publishOpen || discardOpen || Boolean(orphans) || Boolean(compose),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      const act = k === 's' && !e.shiftKey ? 'save' : k === 'enter' && !e.shiftKey ? 'publish' : null;
      if (!act) return;
      e.preventDefault();
      if (keys.current.blocked) return;
      e.stopPropagation();
      if (act === 'save') void keys.current.flush();
      else keys.current.openPublish();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  function togglePreview() {
    setMore(false);
    setPreview((cur) => (cur ? null : (editor.current?.flushContent() ?? latest.current.content)));
  }

  const saveLabel =
    saveState === 'saving' || saveState === 'dirty'
      ? 'Saving…'
      : saveState === 'error'
        ? 'Not saved — will retry'
        : 'Saved';

  const saveStatus = !online ? (
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
  );

  return (
    <div
      className={`docs-root dk-edit-${layout}`}
      data-testid="docs-edit-screen"
      data-layout={layout}
      style={
        {
          flex: 1,
          minWidth: 0,
          display: 'flex',
          minHeight: 0,
          background: '#FFFFFF',
          '--dk-kb': `${keyboard}px`,
        } as CSSProperties
      }
    >
      {rail}
      <div
        className="dk-find-push"
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {phone ? (
          <header className="dk-edit-head dk-edit-head-phone" data-testid="edit-header">
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="dk-edit-title">{title || 'Untitled'}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#7A4F08' }}>
                <span>Draft</span>
                <span aria-hidden="true">·</span>
                {saveStatus}
              </span>
            </div>
            <button
              type="button"
              className="st-btn st-btn-primary"
              disabled={Boolean(conflict) || !online}
              onClick={openPublish}
              data-testid="publish"
            >
              Publish
            </button>
            <button
              type="button"
              className="dk-icobtn dk-bar-ico"
              aria-label="More"
              aria-expanded={more}
              data-testid="edit-more"
              onClick={() => setMore(true)}
            >
              <Icon name="more" size={18} strokeWidth={1.8} />
            </button>
          </header>
        ) : (
          <header
            className="dk-edit-head"
            data-layout={layout}
            data-testid="edit-header"
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
            {saveStatus}
            <button
              type="button"
              className="st-btn"
              aria-pressed={cc.open}
              data-testid="comments-button"
              title={`${commentsData?.counts.all ?? 0} inline · ${commentsData?.counts.page ?? 0} on the page`}
              onClick={() => cc.setOpen((v) => !v)}
            >
              <Icon name="comment" size={13} strokeWidth={1.9} />
              Comments
              <span className="dc-btn-count" data-testid="comments-count">
                {commentTotal}
              </span>
            </button>
            {onOpenSettings && (
              <button
                type="button"
                className="dk-icobtn dk-bar-ico"
                aria-label="Page settings"
                title="Page settings"
                data-testid="edit-page-settings"
                onClick={onOpenSettings}
              >
                <Icon name="i42" size={16} strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              className="st-btn"
              aria-pressed={!!preview}
              data-testid="preview-toggle"
              onClick={togglePreview}
            >
              <Icon name="eye" size={13} strokeWidth={1.9} />
              Preview
            </button>
            <button
              type="button"
              className="st-btn st-btn-danger-outline"
              onClick={() => setDiscardOpen(true)}
              data-testid="discard"
            >
              Discard
            </button>
            <button
              type="button"
              className="st-btn st-btn-primary"
              disabled={Boolean(conflict) || !online}
              onClick={openPublish}
              data-testid="publish"
            >
              <Icon name="i46" size={13} />
              Publish
            </button>
          </header>
        )}

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
        {docsAiOn && page.draft?.aiSource && (
          <div style={{ padding: '8px 24px', borderBottom: '1px solid #E3E8E5' }}>
            <AiDraftChip source={page.draft.aiSource} />
          </div>
        )}
        {error && !publishOpen && (
          <div role="alert" style={{ padding: '8px 24px', background: '#FBE7E4', color: '#A5321E', fontSize: 12.5 }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <EditorErrorBoundary>
              <DocsEditor
                ref={editor}
                projectId={projectId}
                content={content}
                nodes={nodes}
                currentPageId={page.id}
                pageTitle={title}
                onOpenPage={onOpenPage}
                onOpenTicket={onOpenTicket}
                onContentChange={(doc) => {
                  if (!settle(doc)) return;
                  // a change the editor makes on its own right after loading (block ids) is not an edit
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
                inlineAi={{ surface: 'doc', projectId }}
                ai={{
                  onAsk: () => setAiMenu((v) => !v),
                  onSlash: (id) => setAiCommand((c) => ({ id, n: (c?.n ?? 0) + 1 })),
                  docsAi: docsAiOn,
                  onSelection: (action, text) => {
                    assist?.ask({ scope: 'doc', docId: page.id, text: docPrompt(action, text) });
                  },
                }}
                surface={surface}
                toolbarVariant={phone ? 'bottom' : layout === 'tablet' ? 'strip' : 'top'}
                hidden={!!preview}
                // "On this page" beside the text only on a desktop, for a page that has it and is not Wide or Full
                toc={layout !== 'desktop' || isWidePage(look) || !look.showOutline ? null : undefined}
                header={
                  <div className="dk-edit-titlebox">
                    <PageHeader
                      look={look}
                      fallbackEyebrow={page.path[page.path.length - 1]?.title}
                      title={
                        <input
                          aria-label="Page title"
                          placeholder="Page title"
                          value={title}
                          className={`${titleClass(look)} dk-title-input`}
                          onChange={(e) => {
                            setTitle(e.target.value);
                            touch();
                          }}
                        />
                      }
                    />
                    <DocsAi
                      projectId={projectId}
                      pageId={page.id}
                      pageTitle={title}
                      menuOpen={aiMenu}
                      setMenuOpen={setAiMenu}
                      command={aiCommand}
                      onCreateTickets={setTicketsFrom}
                      ed={{
                        getEditor: () => editor.current?.getEditor() ?? null,
                        getMarkdown: () => editor.current?.flush() ?? latest.current.markdown,
                        setMarkdown: replaceWithMarkdown,
                      }}
                    />
                  </div>
                }
              />
            </EditorErrorBoundary>
            {preview && (
              <div
                className={`dk-page-scroll ${surface.className}`}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', ...surface.style }}
                data-testid="editor-preview"
              >
                <div className="dk-preview-note" role="status">
                  <Icon name="eye" size={14} strokeWidth={1.9} />
                  Preview: the page as readers will see it once it is published.
                  <button type="button" className="st-btn st-btn-sm" onClick={togglePreview}>
                    Back to editing
                  </button>
                </div>
                <div className="dk-doc-col">
                  <PageHeader
                    look={look}
                    fallbackEyebrow={page.path[page.path.length - 1]?.title}
                    title={<h1 className={titleClass(look)}>{title || 'Untitled'}</h1>}
                  />
                  <div className="dk-doc-rule" />
                  <RichDocView
                    doc={preview}
                    projectId={projectId}
                    projectName={projectName}
                    onOpenPage={onOpenPage}
                    onOpenTicket={onOpenTicket}
                  />
                </div>
              </div>
            )}
          </div>
          {docsAiOn && page.draft?.aiSource && (
            <AiDraftPanel
              source={page.draft.aiSource}
              markdown={markdown}
              onGoTo={(text) => goToText(editor.current?.getEditor() ?? null, text)}
              onStripCitations={() => replaceWithMarkdown(stripCitations(editor.current?.flush() ?? markdown))}
            />
          )}
          {cc.open && layout === 'desktop' && (
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
          {cc.open && layout !== 'desktop' && (
            <DocsDrawer
              side="right"
              width={420}
              label="Comments"
              onClose={() => cc.setOpen(false)}
              testId="comments-drawer"
            >
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
            </DocsDrawer>
          )}
        </div>
        <EditorRootBridge editor={editor} onEditorRoot={onEditorRoot} />
      </div>

      {more && (
        <BottomSheet label="Page" onClose={() => setMore(false)} testId="edit-more-sheet">
          <div className="dk-menu-sheet" role="menu" aria-label="Page">
            <button
              type="button"
              role="menuitem"
              className="dk-mi"
              onClick={togglePreview}
              data-testid="preview-toggle"
            >
              <Icon name="eye" size={15} strokeWidth={1.8} />
              <span>{preview ? 'Back to editing' : 'Preview'}</span>
            </button>
            {onOpenSettings && (
              <button
                type="button"
                role="menuitem"
                className="dk-mi"
                onClick={() => {
                  setMore(false);
                  onOpenSettings();
                }}
              >
                <Icon name="i42" size={15} strokeWidth={1.8} />
                <span>Page settings…</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="dk-mi"
              data-testid="comments-button"
              onClick={() => {
                setMore(false);
                cc.setOpen(true);
              }}
            >
              <Icon name="comment" size={15} strokeWidth={1.8} />
              <span>Comments</span>
              <span className="dc-btn-count" style={{ marginLeft: 'auto' }}>
                {commentTotal}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dk-mi"
              style={{ color: '#C4432A' }}
              data-testid="discard"
              onClick={() => {
                setMore(false);
                setDiscardOpen(true);
              }}
            >
              <Icon name="i12" size={15} strokeWidth={1.8} />
              <span>Discard draft</span>
            </button>
          </div>
        </BottomSheet>
      )}
      {ticketsFrom !== null && (
        <CreateTicketsDialog
          projectId={projectId}
          page={page}
          selection={ticketsFrom || undefined}
          onClose={() => setTicketsFrom(null)}
          onOpenTicket={onOpenTicket}
        />
      )}
      {publishOpen && (
        <PublishDialog
          projectId={projectId}
          pageId={page.id}
          onGoToMarker={(text) => {
            setPublishOpen(false);
            window.setTimeout(() => goToText(editor.current?.getEditor() ?? null, text), 60);
          }}
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
          me={commentsData ? personOf(commentsData.me, commentsData.members, commentsData.me) : undefined}
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
}: {
  editor: React.RefObject<DocsEditorHandle>;
  onEditorRoot?: (el: HTMLElement | null) => void;
}) {
  useEffect(() => {
    onEditorRoot?.(editor.current?.getRoot() ?? null);
    return () => onEditorRoot?.(null);
  }, [editor, onEditorRoot]);
  return null;
}
