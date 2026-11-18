import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { docsErrorDetail, useDiscardDraft, useMarkDocsSeen, usePublishPage, useSaveDraft } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode, RichDoc } from '../../types/docs';
import { reportSavedEmbeds } from './embeds/cleanedHtml';
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
import { EditorTeamHost } from './suggestions/EditorTeamHost';
import { createEditorReplaceAdapter, setActiveReplaceAdapter } from './editorReplace';
import { Icon } from './Icon';
import { BackOnlineBanner, OfflineBanner, useOnline } from './OfflineBanners';
import { StIcon } from './states/stIcons';
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
import { client } from '../../api/client';
import { canonicalDoc, docToText } from '../../richdoc';
import { applyChoices, changedBlocks, type BlockChoice } from '../../richdoc/merge';
import { displayName } from './docsShared';
import { StateBar, StateBars } from './states/StateBar';
import { SaveStatus, type SaveView } from './states/SaveStatus';
import { KeepCopyDialog } from './states/KeepCopyDialog';
import { WaitingList, waitingRows } from './states/WaitingList';
import { MergedDialog } from './states/MergedDialog';
import { ConflictChooser, JoinedToast, KeepMineConfirm } from './states/ConflictChooser';
import {
  fmtSize,
  PAGE_SIZE_WARN,
  PAGE_SIZE_LIMIT,
  pageBytes,
  SizeWarningBar,
  SpaceList,
  TooLargeDialog,
} from './states/PageSize';
import { reconcile, type Reconciled } from './states/reconcile';
import { isSessionEnded, SessionEnded } from './states/SessionEnded';
import { fixColour, ReadabilityCheck, readabilityIssues } from './states/Readability';
import { isNoConnection, useQueuedWrites } from './states/offlineQueue';
import { subscribeUploads, uploadsVersion, waitingUploads } from './editor/blocks/imageUpload';
import { LinkCheckerPanel } from './links/LinkChecker';
import { useEditHighlights } from './highlights/EditHighlights';

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
/** A failed save is tried again after this long; after three tries the bar says "Not saved" (Docs states, C 13). */
const RETRY_MS = 3000;
const RETRY_SLOW_MS = 10000;
const TRIES_BEFORE_NOT_SAVED = 3;

/** A newer version found while editing, and (rich pages) the draft merged with it block by block. */
interface ConflictState {
  latestVersion: number;
  latestAuthor?: string | null;
  latestAt?: string | null;
  /** Null when a version is not rich (only Keep mine / Reload then). */
  rec?: Reconciled | null;
}

/** Coming back online or publishing over a newer version: merging, joined by itself, or a choice to make. */
type SyncState =
  | { kind: 'merging' }
  | { kind: 'synced' }
  | { kind: 'joined'; rec: Reconciled; doc: RichDoc; reason: 'online' | 'publish' }
  | { kind: 'same'; rec: Reconciled };

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
  const [baseVersion, setBaseVersion] = useState(page.draft?.baseVersion ?? page.version);
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
  // the readers' shared highlights stay visible while editing, as dotted lines (highlights/EditHighlights.tsx)
  const sharedHl = useEditHighlights(page.id, page.version > 0 && online, commentsData);
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
  const [linksOpen, setLinksOpen] = useState(false);
  const phone = layout === 'phone';
  const look = readPageLook(page.settings);
  const settingsKey = JSON.stringify(page.settings ?? {});
  const surface = useMemo(
    () => ({ className: lookClass(readPageLook(page.settings)), style: lookVars(readPageLook(page.settings), layout) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsKey, layout],
  );
  const keyboard = useKeyboardInset(phone);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  // the states of saving, offline and merging (Docs states, C-G)
  const [failures, setFailures] = useState(0);
  const [tooLarge, setTooLarge] = useState<number | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [dialog, setDialog] = useState<null | 'keep-copy' | 'merged' | 'choose' | 'keep-mine' | 'too-large'>(null);
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [sizeHidden, setSizeHidden] = useState(false);
  const [bytes, setBytes] = useState(() => pageBytes(content));
  // the server stopped taking this window's changes (F 38): 'open' shows the dialog, 'later' only the bar
  const [sessionEnded, setSessionEnded] = useState<null | 'open' | 'later'>(null);
  const [joinedToast, setJoinedToast] = useState<{ version: number; undo: () => void } | null>(null);
  // the draft as the server last stored it: what is queued is what differs from it
  const savedDoc = useRef<RichDoc>(localDraft ? editableDoc(page) : content);
  const savedTitle = useRef(page.draft?.title ?? page.title);

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
      const sent = latest.current.content;
      const saved = await saveDraft.mutateAsync({
        pageId: page.id,
        content: sent,
        title: latest.current.title,
        baseVersion: latest.current.baseVersion,
      });
      // what the server cleaned out of HTML embeds is said on each embed ("Saved. N things were removed…")
      reportSavedEmbeds(sent, (saved as DocsPage | undefined)?.draft?.content);
      savedDoc.current = sent;
      savedTitle.current = latest.current.title;
      setSessionEnded(null);
      // a change typed while this save was on its way is still to be sent
      dirty.current = latest.current.content !== sent;
      if (!dirty.current) clearLocalDraft(page.id);
      setSavedAt(new Date());
      setSaveState(dirty.current ? 'dirty' : 'saved');
      setFailures(0);
      setTooLarge(null);
      setBytes(pageBytes(sent));
      setOnline(true);
      return true;
    } catch (err) {
      keepLocal();
      setSaveState('error');
      setFailures((n) => n + 1);
      const d = docsErrorDetail(err);
      if (isSessionEnded(err)) {
        // signed out: the draft waits in this browser; the dialog says so once (F 38)
        setSessionEnded((cur) => cur ?? 'open');
      } else if (d?.code === 'too_large') {
        const size = pageBytes(latest.current.content);
        setTooLarge(size);
        setBytes(size);
        setDialog((cur) => cur ?? 'too-large');
      } else if (isNoConnection(err)) setOnline(false);
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

  // a failed save is tried again every few seconds while the browser has a connection (C 15: "We keep trying")
  useEffect(() => {
    if (saveState !== 'error' || tooLarge != null || conflict || sync?.kind === 'merging' || sessionEnded)
      return undefined;
    if (!navigator.onLine) return undefined;
    const t = setTimeout(() => void flush(), failures < TRIES_BEFORE_NOT_SAVED ? RETRY_MS : RETRY_SLOW_MS);
    return () => clearTimeout(t);
  }, [saveState, failures, tooLarge, conflict, sync, flush, sessionEnded]);

  // signed out: try again whenever this window comes back to the front (after signing in in the other tab)
  useEffect(() => {
    if (!sessionEnded) return undefined;
    const again = () => {
      if (document.visibilityState === 'visible') void flush();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [sessionEnded, flush]);

  /** Put a page into the editor as an edit of its own (a merge, a choice, Undo): it is saved like typing. */
  const applyDoc = useCallback(
    (doc: RichDoc) => {
      userInput.current = true;
      settle(doc);
      touch();
    },
    [settle, touch],
  );

  /** Merge the draft with a newer version: joined by itself, or the blocks both changed are left to choose. */
  const joinNewer = useCallback(
    async (
      meta: { latestVersion: number; latestAuthor?: string | null; latestAt?: string | null },
      reason: 'online' | 'publish',
    ) => {
      const doc = editor.current?.flushContent() ?? latest.current.content;
      const rec = await reconcile(page.id, latest.current.baseVersion, meta.latestVersion, doc).catch(() => null);
      if (rec && rec.merge.conflicts.length === 0) {
        const merged = applyChoices(rec.merge, {}) as RichDoc;
        setBaseVersion(rec.theirs.version);
        latest.current = { ...latest.current, baseVersion: rec.theirs.version };
        applyDoc(merged);
        setConflict(null);
        setSync({ kind: 'joined', rec, doc: merged, reason });
        return;
      }
      setConflict({ ...meta, rec });
      setSync(rec && reason === 'online' ? { kind: 'same', rec } : null);
    },
    [page.id, applyDoc],
  );

  /** Back online with changes queued: read the page, merge with what others published meanwhile, then save. */
  const syncBack = useCallback(async () => {
    editor.current?.flushContent();
    if (!dirty.current) {
      setSync((cur) => (cur && cur.kind !== 'synced' ? cur : { kind: 'synced' }));
      return;
    }
    setSync({ kind: 'merging' });
    try {
      const live = (await client.get<DocsPage>(`/docs/pages/${page.id}`)).data;
      if (live.version > latest.current.baseVersion) {
        await joinNewer(
          { latestVersion: live.version, latestAuthor: live.updatedBy, latestAt: live.updatedAt },
          'online',
        );
        return;
      }
      setSync(null);
      if (await flush()) setSync({ kind: 'synced' });
    } catch {
      setSync(null);
      setSaveState('error');
    }
  }, [page.id, joinNewer, flush]);

  // reconnect (and opening a page whose changes were kept in this browser): send what is queued
  const syncRef = useRef(syncBack);
  syncRef.current = syncBack;
  useEffect(() => {
    // syncBack takes the editor's last keystrokes first: they may not have reached the screen yet
    if (!justBack) return;
    clearJustBack();
    void syncRef.current();
  }, [justBack, clearJustBack]);
  useEffect(() => {
    if (localDraft && navigator.onLine) void syncRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doPublish(note: string, notify: boolean, base = baseVersion, override?: RichDoc) {
    setError(null);
    if (!title.trim()) {
      setError('Give the page a title before publishing.');
      return;
    }
    const doc = override ?? editor.current?.flushContent() ?? latest.current.content;
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
        const meta = { latestVersion: d.latestVersion ?? base + 1, latestAuthor: d.latestAuthor, latestAt: d.latestAt };
        // shown at once; the block-by-block merge fills in when the versions are read
        setConflict(meta);
        void joinNewer(meta, 'publish');
      } else if (isSessionEnded(err)) {
        setPublishOpen(false);
        setSessionEnded('open');
      } else {
        setError(d?.message ?? extractError(err));
        if (isNoConnection(err)) setOnline(false);
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
    if (conflict || !online || sync?.kind === 'merging') return;
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

  // the readability check (J 74): what may be hard to read, checked as the page changes; it never blocks Publish
  const pageHex = (lookVars(look, layout) as Record<string, string>)['--dp-page'] ?? '#FFFFFF';
  const readIssues = useMemo(() => readabilityIssues(content, pageHex), [content, pageHex]);
  const [readOpen, setReadOpen] = useState(false);

  // what waits in this browser: the blocks that differ from the draft the server has, and the title
  const queued = !online || saveState === 'error';
  const waitingBlocks = useMemo(
    () => (queued ? changedBlocks(canonicalDoc(savedDoc.current), canonicalDoc(content)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queued, content, savedAt],
  );
  const titleChanged = queued && title !== savedTitle.current;
  // pictures that wait to upload, and the page's other writes kept in this browser (highlights…)
  useSyncExternalStore(subscribeUploads, uploadsVersion);
  const upWaiting = waitingUploads();
  const writes = useQueuedWrites(page.id);
  const writeRows = Object.entries(
    writes.reduce<Record<string, number>>((m, w) => ({ ...m, [w.label]: (m[w.label] ?? 0) + 1 }), {}),
  ).map(([label, count]) => ({ label, count }));
  const waiting =
    Math.max(waitingBlocks.length + (titleChanged ? 1 : 0), dirty.current ? 1 : 0) + upWaiting.length + writes.length;

  const saveView: SaveView = conflict
    ? { kind: 'paused' }
    : sync?.kind === 'merging'
      ? { kind: 'merging' }
      : !online
        ? { kind: 'offline', waiting }
        : // a retry on its way does not hide "Not saved" (the bar would jump away under the pointer)
          saveState !== 'saved' && (failures >= TRIES_BEFORE_NOT_SAVED || tooLarge != null || sessionEnded)
          ? { kind: 'error' }
          : saveState === 'saved'
            ? { kind: 'saved', at: savedAt }
            : { kind: 'saving' };
  const notSaved = saveView.kind === 'error';
  const retryNow = () => {
    setFailures(0);
    void flush().then((ok) => ok && setOnline(true));
  };

  const readButton =
    readIssues.length > 0 && !phone ? (
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          type="button"
          className="dst-read-btn"
          data-testid="readability-button"
          aria-expanded={readOpen}
          onClick={() => setReadOpen((v) => !v)}
        >
          <StIcon name="eye" size={12} sw={2} />
          {readIssues.length} to look at
        </button>
        {readOpen && (
          <ReadabilityCheck
            issues={readIssues}
            pageHex={pageHex}
            onFix={(x) => {
              if (!x.suggestion) return;
              applyDoc(
                fixColour(editor.current?.flushContent() ?? latest.current.content, x.blockId, x.hex, x.suggestion),
              );
            }}
            onAdd={(x) => {
              setReadOpen(false);
              goToBlock(x.blockId);
            }}
            onClose={() => setReadOpen(false)}
          />
        )}
      </span>
    ) : null;

  const saveStatus = (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {readButton}
      <SaveStatus
        view={saveView}
        compact={phone}
        onRetry={retryNow}
        onOpenWaiting={() => setWaitingOpen((v) => !v)}
        waitingOpen={waitingOpen}
      />
      {waitingOpen && !online && !phone && (
        <WaitingList
          total={waiting}
          rows={waitingRows(waitingBlocks)}
          titleChanged={titleChanged}
          uploads={upWaiting.map((u) => ({ name: u.name, size: fmtSize(u.size) }))}
          writes={writeRows}
          onRetry={retryNow}
          onClose={() => setWaitingOpen(false)}
        />
      )}
    </span>
  );
  const goToBlock = (id: string) => {
    setDialog(null);
    setSpaceOpen(false);
    window.requestAnimationFrame(() => {
      const root = editor.current?.getRoot();
      const el = root?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    });
  };
  const keepMineNow = () => {
    const c = conflict;
    if (!c) return;
    setDialog(null);
    if (!c.rec) {
      void doPublish('', false, c.latestVersion);
      return;
    }
    const all = Object.fromEntries(c.rec.merge.conflicts.map((x) => [x.id, 'mine' as BlockChoice]));
    const merged = applyChoices(c.rec.merge, all) as RichDoc;
    applyDoc(merged);
    void doPublish('', false, c.latestVersion, merged);
  };
  const applyChosen = (choices: Record<string, BlockChoice>) => {
    const c = conflict;
    if (!c?.rec) return;
    const before = { doc: latest.current.content, base: latest.current.baseVersion, conflict: c };
    const merged = applyChoices(c.rec.merge, choices) as RichDoc;
    setBaseVersion(c.rec.theirs.version);
    latest.current = { ...latest.current, baseVersion: c.rec.theirs.version };
    applyDoc(merged);
    setConflict(null);
    setSync(null);
    setDialog(null);
    setJoinedToast({
      version: c.rec.theirs.version,
      undo: () => {
        setBaseVersion(before.base);
        latest.current = { ...latest.current, baseVersion: before.base };
        applyDoc(before.doc);
        setConflict(before.conflict);
      },
    });
  };
  const dismissSync = useCallback(() => setSync(null), []);
  // signing in happens in a new tab, so this page and its kept changes stay as they are (F 38)
  const signInAgain = () => {
    window.open(window.location.href, '_blank', 'noopener');
    setSessionEnded('later');
  };
  const copyText = () => {
    const text = docToText(editor.current?.flushContent() ?? latest.current.content);
    void navigator.clipboard?.writeText(text).then(
      () => toast.success('Text copied', title || page.title),
      () => toast.error('Could not copy the text', 'Use Keep a copy to download it instead.'),
    );
  };
  const sizeWarn = !tooLarge && !sizeHidden && bytes >= PAGE_SIZE_LIMIT * PAGE_SIZE_WARN;

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
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 2 }}>
              <span className="dk-edit-title">{title || 'Untitled'}</span>
              <span className="dk-edit-sub">
                <span className="dk-edit-sub-dot" aria-hidden="true" />
                <span>Draft</span>
                <span aria-hidden="true" style={{ color: '#C7D2CB' }}>
                  ·
                </span>
                {saveStatus}
              </span>
            </div>
            <button
              type="button"
              className="st-btn st-btn-primary"
              style={{ height: 40, boxSizing: 'border-box', margin: '0 2px' }}
              disabled={Boolean(conflict) || !online || sync?.kind === 'merging'}
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
              padding: '0 20px',
              borderBottom: '1px solid #F0F3F1',
              background: '#FFFFFF',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, overflow: 'hidden' }}>
              <Icon name="folder" size={14} strokeWidth={1.7} style={{ color: '#7A8A80', flexShrink: 0 }} />
              {projectName && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 13, color: '#5B6B60' }}>{projectName}</span>
                  <Icon name="i05" size={11} strokeWidth={2} style={{ color: '#9AA8A0' }} />
                </span>
              )}
              {page.path.map((p) => (
                <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 13, color: '#5B6B60' }}>{p.title}</span>
                  <Icon name="i05" size={11} strokeWidth={2} style={{ color: '#9AA8A0' }} />
                </span>
              ))}
              <span
                style={{
                  fontSize: 13,
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
            <span
              className="mc-chip"
              style={{ height: 24, padding: '0 10px', fontSize: 11.5, background: '#FDF3E3', color: '#8A5A00' }}
            >
              <span className="mc-dot" style={{ width: 6, height: 6, background: '#8A5A00' }} />
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
            <button
              type="button"
              className="st-btn"
              aria-pressed={linksOpen}
              data-testid="check-links"
              onClick={() => setLinksOpen((v) => !v)}
            >
              <Icon name="link" size={13} strokeWidth={1.9} />
              Check links
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
              disabled={Boolean(conflict) || !online || sync?.kind === 'merging'}
              onClick={openPublish}
              data-testid="publish"
            >
              <Icon name="i46" size={13} />
              Publish
            </button>
          </header>
        )}

        <StateBars phone={phone}>
          {conflict && sync?.kind !== 'same' && (
            <ConflictBanner
              pageId={page.id}
              baseVersion={baseVersion}
              latestVersion={conflict.latestVersion}
              latestAuthor={conflict.latestAuthor ?? conflict.rec?.theirs.author}
              latestAt={conflict.latestAt ?? conflict.rec?.theirs.at}
              ownLines={ownLines}
              busy={publish.isPending}
              needChoice={conflict.rec?.merge.conflicts.length}
              onChoose={conflict.rec ? () => setDialog('choose') : undefined}
              onKeepMine={() => (conflict.rec ? setDialog('keep-mine') : keepMineNow())}
              onReload={() => void doDiscard()}
              phone={phone}
            />
          )}
          {!online && <OfflineBanner phone={phone} onRetry={retryNow} />}
          {online && sessionEnded && (
            <StateBar
              tone="amber"
              icon="warn"
              role="alert"
              testId="session-ended-bar"
              title="Your session ended"
              text="Your changes are kept in this browser and saved when you sign in again."
              actions={
                <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={signInAgain}>
                  <StIcon name="person" size={13} sw={2} />
                  Sign in again
                </button>
              }
            />
          )}
          {online && notSaved && tooLarge == null && !sessionEnded && (
            <StateBar
              tone="red"
              icon="warn"
              role="alert"
              testId="save-failed-bar"
              title="Couldn't save your changes"
              text={
                phone
                  ? 'Your text is still here and a copy is kept in this browser.'
                  : 'Your text is still here, and a copy is kept in this browser. We keep trying every few seconds.'
              }
              actions={
                <>
                  <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={retryNow}>
                    <StIcon name="retry" size={13} sw={2} />
                    Retry now
                  </button>
                  {!phone && (
                    <button type="button" className="st-btn st-btn-sm" onClick={() => setDialog('keep-copy')}>
                      <StIcon name="download" size={13} sw={2} />
                      Keep a copy
                    </button>
                  )}
                </>
              }
            />
          )}
          {online && tooLarge != null && (
            <StateBar
              tone="red"
              icon="storage"
              role="alert"
              testId="too-large-bar"
              title="This page is too large to save"
              text="Your text is kept in this browser. Make the page smaller and it saves by itself."
              actions={
                <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => setSpaceOpen(true)}>
                  See what takes space
                </button>
              }
            />
          )}
          {online && sync && (
            <BackOnlineBanner
              state={sync.kind}
              who={sync.kind === 'joined' || sync.kind === 'same' ? displayName(sync.rec.theirs.author) : undefined}
              count={
                sync.kind === 'joined'
                  ? sync.rec.merge.joined.filter((j) => j.by !== 'mine').length
                  : sync.kind === 'same'
                    ? sync.rec.merge.conflicts.length
                    : 0
              }
              publish={sync.kind === 'joined' && sync.reason === 'publish'}
              version={sync.kind === 'joined' || sync.kind === 'same' ? sync.rec.theirs.version : undefined}
              onReview={() => setDialog('merged')}
              onChoose={() => setDialog('choose')}
              onDismiss={dismissSync}
            />
          )}
          {sizeWarn && (
            <SizeWarningBar bytes={bytes} onShow={() => setSpaceOpen(true)} onClose={() => setSizeHidden(true)} />
          )}
          {spaceOpen && (
            <div style={{ position: 'relative', height: 0 }}>
              <SpaceList doc={content} onShow={goToBlock} onClose={() => setSpaceOpen(false)} />
            </div>
          )}
        </StateBars>
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
            <EditorTeamHost page={page} projectId={projectId} layout={layout} onOpenTicket={onOpenTicket}>
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
                sharedHighlights={sharedHl.items}
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
                    {sharedHl.strip}
                  </div>
                }
              />
            </EditorTeamHost>
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

      {linksOpen && (
        <LinkCheckerPanel
          getEditor={() => editor.current?.getEditor() ?? null}
          projectId={projectId}
          nodes={nodes}
          onClose={() => setLinksOpen(false)}
        />
      )}
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
      {dialog === 'keep-copy' && (
        <KeepCopyDialog
          pageTitle={title || page.title}
          sheet={phone}
          getHtml={() => editor.current?.getEditor()?.getHTML() ?? ''}
          getText={() => docToText(editor.current?.flushContent() ?? latest.current.content)}
          onClose={() => setDialog(null)}
          onDone={(what) => toast.success(what === 'download' ? 'Copy downloaded' : 'Text copied', title || page.title)}
        />
      )}
      {dialog === 'too-large' && tooLarge != null && (
        <TooLargeDialog
          bytes={tooLarge}
          onClose={() => setDialog(null)}
          onShowSpace={() => {
            setDialog(null);
            setSpaceOpen(true);
          }}
          onKeepCopy={() => setDialog('keep-copy')}
        />
      )}
      {dialog === 'merged' && sync?.kind === 'joined' && (
        <MergedDialog
          joined={sync.rec.merge.joined}
          baseOf={(id) => sync.rec.base.content.content?.find((b) => b.attrs?.blockId === id) ?? null}
          doc={sync.doc}
          fromVersion={sync.rec.base.version}
          toVersion={sync.rec.theirs.version}
          author={sync.rec.theirs.author}
          me={commentsData?.me}
          sheet={phone}
          onGoTo={goToBlock}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'choose' && conflict?.rec && conflict.rec.merge.conflicts.length > 0 && (
        <ConflictChooser
          conflicts={conflict.rec.merge.conflicts}
          joined={conflict.rec.merge.joined}
          theirs={conflict.rec.theirs}
          baseVersion={conflict.rec.base.version}
          mineAt={savedAt}
          me={commentsData?.me}
          doc={applyChoices(conflict.rec.merge, {})}
          layout={layout}
          onApply={applyChosen}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'keep-mine' && conflict?.rec && (
        <KeepMineConfirm
          count={conflict.rec.merge.conflicts.length}
          joinedCount={conflict.rec.merge.joined.length}
          who={conflict.rec.theirs.author}
          version={conflict.rec.theirs.version}
          pageTitle={title || page.title}
          sheet={phone}
          onConfirm={keepMineNow}
          onClose={() => setDialog(null)}
        />
      )}
      {sessionEnded === 'open' && (
        <SessionEnded
          waiting={waiting}
          sheet={phone}
          onSignIn={signInAgain}
          onCopy={copyText}
          onClose={() => setSessionEnded('later')}
        />
      )}
      {joinedToast && (
        <JoinedToast version={joinedToast.version} onUndo={joinedToast.undo} onClose={() => setJoinedToast(null)} />
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
