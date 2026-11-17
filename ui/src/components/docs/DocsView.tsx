import { docToMarkdown } from '../../richdoc';
import { convertLock, convertLockTip, publishedDoc, replaceSectionRefs } from './richPage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  docsErrorDetail,
  useDocsPage,
  useDocsRecycleBin,
  useDocsTree,
  useDocsVersion,
  usePublishPage,
  useRestorePage,
  useRestoreVersion,
} from '../../api/docs';
import { bookOf } from './book';
import { openExport, type ExportFormat } from './docsExport';
import { ExportHost } from './export/ExportHost';
import { useRenameWithLinks } from '../../api/docsActions';
import { fetchRenameLinkCount } from '../../api/docsPage';
import { client } from '../../api/client';
import { useProject } from '../../api/projects';
import { useDocsAccess, useRequestDocsAccess } from '../../api/docsAccess';
import { useDocsAiState } from '../../api/docsAi';
import { useDocsHealthCount } from '../../api/docsAiCare';
import { DocsHealthView } from './ai/DocsHealthView';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { isPageId } from './SharePopover';
import { slugify as slugifyHeading } from '../../utils/docsMarkdown';
import { useToast } from '../Toast';
import { DeleteDialog } from './DeleteDialog';
import { DocPeekPanel, type PeekTarget } from './DocPeekPanel';
import { DocsPeekProvider } from './DocsRefsContext';
import { DocsEditScreen } from './DocsEditScreen';
import { DocsFollowToggle } from './DocsFollowToggle';
import { DocsHero } from './DocsHero';
import { SinceViewedDigest } from './ai/SinceViewedDigest';
import { DocsPageView, type PageAction } from './DocsPageView';
import { CanvasPageView } from './CanvasPageView';
import { DocsRail } from './DocsRail';
import {
  DeletedPage,
  DocsDisabled,
  LoadError,
  NoAccess,
  NotFound,
  PageSkeleton,
  SlowLoadNote,
  TopProgress,
  TreeSkeleton,
} from './DocsStates';
import { PopOutIcon } from './DocsWindowIcons';
import { GivePageDialog } from './GivePageDialog';
import { DocsTree } from './DocsTree';
import { DuplicateDialog } from './DuplicateDialog';
import { HistoryDrawer } from './HistoryDrawer';
import { Icon } from './Icon';
import { MoveToDialog } from './MoveToDialog';
import { NewPageDialog } from './NewPageDialog';
import type { GalleryChip } from './start/galleryRules';
import type { ImportSource } from './start/importConvert';
import { NewPageMenu } from './start/NewPageMenu';
import { SaveTemplateDialog } from './start/SaveTemplateDialog';
import { WhatsNewTour } from './start/WhatsNewTour';
import { PageMenu, usePageShortcuts, type PageMenuAction } from './PageMenu';
import { RenameDialog } from './RenameDialog';
import { SearchResults } from './SearchResults';
import { useDocsOffline } from './useDocsOffline';
import './docs.css';
import { useAppCommand } from '../../utils/appCommands';
import { useDocsLayout, type DocsLayout } from '../../hooks/useDocsLayout';
import { BottomSheet, DocsDrawer } from './DocsSheets';
import { PageSettingsPanel, type SettingsTab } from './PageSettingsPanel';
import { patchPageSettings, docsKeys } from '../../api/docs';
import { useQueryClient } from '@tanstack/react-query';
import { IconPicker } from './tree/IconPicker';
import { GalleryView, RecentView } from './tree/PageViews';
import { BulkDeleteDialog } from './tree/SelectionBar';
import { affectedPages } from './tree/treeModel';
import { useTreeActions } from './tree/useTreeActions';
import { useTreeViewState } from './tree/useTreeViewState';
import { SuggestionMarker } from './suggestions/extras';

/** The event that opens the app's Recycle Bin (the row under the page tree). */
export const OPEN_RECYCLE_BIN_EVENT = 'kb:open-recycle-bin';
import { isWidePage, readPageLook } from './pageSettings';
import { sketchesAsImages } from '../sketch/sketchRefs';
import { canvasesAsImages } from '../canvas/canvasRefs';

interface Props {
  projectId: string;
  projectName: string;
  requestedPageId?: string | null;
  /** Heading slug to scroll to once `requestedPageId` has rendered (search results, links to a section). */
  requestedAnchor?: string | null;
  onRequestHandled?: () => void;
  onOpenTicket: (ticketId: string) => void;
  /** "Import…" (hero, import strip, the tree's New page menu), with the source chosen (Markdown when not given). */
  onImport?: (source?: ImportSource) => void;
  /** Markdown, Word or HTML files or folders dropped anywhere on the Docs page, or picked with "Choose files…". */
  onDropFiles?: (files: File[]) => void;
  /** Docs switched off for the project (E6). */
  onOpenSettings?: () => void;
  onBack?: () => void;
  /** Pop the Docs space out into a window of its own, on this page (#268); absent in that window itself. */
  onPopOut?: (pageId: string | null) => void;
  /** Search palette / full results; `query` is passed when the tree filter's Enter or "Search page content" asks for it. */
  onSearch?: (query?: string) => void;
  /** "Ask the docs": opens the search palette in Ask mode (Docs AI). */
  onAskDocs?: () => void;
  /** Called with the element holding the rendered page body (find-in-page). */
  onBodyRef?: (el: HTMLElement | null) => void;
  /** Full search results shown in place of the page (the tree stays on the left); `null` shows the page. */
  resultsQuery?: string | null;
  onCloseResults?: () => void;
  /** One-shot request from the search palette: create a page with this title, or filter the tree. */
  intent?:
    | { kind: 'create-page'; title: string }
    | { kind: 'write-page'; question: string }
    | { kind: 'filter-tree'; q: string }
    | null;
  onIntentHandled?: () => void;
  /** Opens the project sidebar where the app hides it (tablet and phone); no menu button without it. */
  onOpenSidebar?: () => void;
  /** Called with true while the app bar should hide (editing on a tablet or a phone), false after. */
  onImmersiveChange?: (on: boolean) => void;
  /** Called with the layout the Docs area has (desktop, tablet, phone) whenever it changes. */
  onLayoutChange?: (layout: DocsLayout) => void;
}

/** A touch that starts this close to the left edge of the Docs area (px) and moves right opens the tree. */
const EDGE_PX = 24;
/** How far it has to move (px). */
const SWIPE_PX = 60;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Scroll a heading into view once its page has rendered (waits up to ~3 s for it) and flash it. */
function scrollToSection(slug: string) {
  let tries = 0;
  const tick = () => {
    const el = document.getElementById(`docs-${slug}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('dk-flash');
      setTimeout(() => el.classList.remove('dk-flash'), 1800);
    } else if (++tries < 30) {
      setTimeout(tick, 100);
    }
  };
  setTimeout(tick, 150);
}

/** 0 = fine, 1 = slow (8 s), 2 = give up (20 s). */
function useLoadingStage(active: boolean): 0 | 1 | 2 {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    setStage(0);
    if (!active) return;
    const a = setTimeout(() => setStage(1), 8000);
    const b = setTimeout(() => setStage(2), 20000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [active]);
  return stage;
}

/** Row "···" menu: loads the page, then shows the shared PageMenu. */
function TreePageMenu({
  node,
  onAction,
  onClose,
  sheet,
}: {
  node: DocsTreeNode;
  onAction: (a: PageMenuAction) => void;
  onClose: () => void;
  /** A phone: the menu is an action sheet. */
  sheet?: boolean;
}) {
  const { data } = useDocsPage(node.id);
  if (sheet)
    return (
      <BottomSheet label={node.title} onClose={onClose} testId="tree-menu-sheet">
        {data ? (
          <PageMenu
            page={data}
            onAction={onAction}
            onClose={onClose}
            variant="sheet"
            hidden={node.kind === 'canvas' ? TREE_CANVAS_HIDDEN : undefined}
          />
        ) : (
          <div className="skel" style={{ height: 120, margin: 16 }} />
        )}
      </BottomSheet>
    );
  if (!data) {
    return (
      <div
        className="dk-menu"
        style={{
          position: 'absolute',
          right: 0,
          top: 'calc(100% + 6px)',
          width: 290,
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {[70, 50, 60].map((w) => (
          <div key={w} className="skel" style={{ width: `${w}%`, height: 12 }} />
        ))}
      </div>
    );
  }
  return (
    <PageMenu
      page={data}
      onAction={onAction}
      onClose={onClose}
      hidden={node.kind === 'canvas' ? TREE_CANVAS_HIDDEN : undefined}
    />
  );
}

/** A canvas page has no Page settings, so no book either. */
const TREE_CANVAS_HIDDEN: readonly PageMenuAction[] = ['settings', 'save-template', 'book'];

/** A page object for a dialog that only needs the tree's facts about it (Move to for several pages). */
function cachedToPageStub(n: DocsTreeNode, projectId: string): Partial<DocsPage> {
  return {
    id: n.id,
    projectId,
    parentId: n.parentId,
    title: n.title,
    slug: n.slug,
    status: n.status,
    version: n.version,
    markdown: '',
    headings: [],
    path: [],
    createdBy: '',
    updatedBy: '',
    updatedAt: n.updatedAt,
    createdAt: n.updatedAt,
    hasUnpublishedChanges: n.hasDraft,
    draft: null,
  };
}

function cachedToPage(
  c: NonNullable<ReturnType<ReturnType<typeof useDocsOffline>['getCachedPage']>>,
  projectId: string,
  nodes: DocsTreeNode[],
): DocsPage {
  const path: DocsPage['path'] = [];
  let cur = c.parentId ? nodes.find((n) => n.id === c.parentId) : undefined;
  while (cur) {
    path.unshift({ id: cur.id, title: cur.title, slug: cur.slug });
    cur = cur.parentId ? nodes.find((n) => n.id === cur!.parentId) : undefined;
  }
  return {
    id: c.id,
    projectId,
    parentId: c.parentId,
    title: c.title,
    slug: nodes.find((n) => n.id === c.id)?.slug ?? '',
    status: c.status,
    version: c.version,
    markdown: c.markdown,
    format: c.format,
    content: c.content ?? null,
    headings: c.headings,
    path,
    createdBy: c.updatedBy,
    updatedBy: c.updatedBy,
    updatedAt: c.updatedAt,
    createdAt: c.updatedAt,
    hasUnpublishedChanges: false,
    draft: null,
  };
}

/**
 * Docs space: tree, page view, editor, search, history and dialogs.
 * @param props.requestedPageId - Page to open once, e.g. from a linked doc or `?docs=` link.
 * @param props.requestedAnchor - Heading slug to scroll to once the requested page has rendered.
 * @param props.onRequestHandled - Called after `requestedPageId` has been opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onImport - Called by "Import Markdown" (hero and import strip).
 * @param props.onDropFiles - Called with Markdown files or folders dropped on the page or picked with "Choose files".
 * @param props.onOpenSettings - Called to open project settings when Docs is disabled.
 * @param props.onBack - Called to leave the Docs view.
 * @param props.onPopOut - Called with the open page to move the Docs space into a window of its own.
 * @param props.onSearch - Called to open search, with the query when the tree filter asks for it.
 * @param props.onBodyRef - Receives the element holding the rendered page body (for find-in-page).
 * @param props.resultsQuery - Query of the full search results shown in place of the page, or `null`.
 * @param props.onCloseResults - Called to leave the full results.
 * @param props.intent - One-shot request from the search palette (create a page / filter the tree).
 * @param props.onIntentHandled - Called once `intent` has been acted on.
 * @param props.onOpenSidebar - Opens the project sidebar the app hides on a tablet or a phone.
 * @param props.onImmersiveChange - Called with true while the app bar should hide (editing on touch layouts).
 * @param props.onLayoutChange - Called with the Docs area's layout when it changes.
 */
export function DocsView({
  projectId,
  projectName,
  requestedPageId,
  requestedAnchor,
  onRequestHandled,
  onOpenTicket,
  onImport,
  onDropFiles,
  onOpenSettings,
  onBack,
  onPopOut,
  onSearch,
  onAskDocs,
  onBodyRef,
  resultsQuery = null,
  onCloseResults,
  intent,
  onIntentHandled,
  onOpenSidebar,
  onImmersiveChange,
  onLayoutChange,
}: Props) {
  const toast = useToast();
  const offlineApi = useDocsOffline(projectId);
  // the empty space's example key uses this project's prefix (MOB-12 in Mobile App, not KAN-12)
  const heroPrefix = useProject(projectId).data?.prefix;
  const tree = useDocsTree(projectId);
  const liveNodes = useMemo<DocsTreeNode[]>(() => tree.data ?? [], [tree.data]);
  const cachedTree = tree.isError && !docsErrorDetail(tree.error) ? offlineApi.getCachedTree() : null;
  const nodes = tree.data ? liveNodes : (cachedTree ?? liveNodes);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(`docsPage:${projectId}`));
  const [editing, setEditing] = useState(false);
  const [newPage, setNewPage] = useState<{
    parentId: string | null;
    template?: string;
    title?: string;
    /** Opens the dialog with Write with AI preselected. */
    aiFrom?: { kind: 'ticket' | 'idea' | 'notes' | 'prompt'; ticketId?: string; text?: string };
    /** The gallery chip to open on. */
    chip?: GalleryChip;
  } | null>(null);
  // "Save as template…" from a page menu
  const [saveTplFor, setSaveTplFor] = useState<DocsPage | null>(null);
  // Desktop menu: File › New Doc Page
  useAppCommand('new-doc', () => setNewPage({ parentId: null }));
  const [moveFor, setMoveFor] = useState<DocsPage | null>(null);
  const [dupFor, setDupFor] = useState<DocsPage | null>(null);
  const [history, setHistory] = useState<{ compare?: { from: number; to: number } } | null>(null);
  // an older version opened from History to read (read-only), for the page it belongs to
  const [reading, setReading] = useState<{ pageId: string; version: number } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; title: string } | null>(null);
  // a page given to an AI member to write or review (#268)
  const [giveFor, setGiveFor] = useState<{ id: string; title: string } | null>(null);
  const [renameFor, setRenameFor] = useState<{ node: { id: string; title: string }; newTitle: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const layout = useDocsLayout(rootEl);
  const narrow = layout !== 'desktop';
  const [railOpen, setRailOpen] = useState(false);
  // the page whose Page settings panel is open (it closes when another page opens)
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  // the tree's view, sort and filters; the page icon picker; several pages picked
  const treeView = useTreeViewState(projectId);
  const [iconFor, setIconFor] = useState<{ id: string; title: string; icon: string | null } | null>(null);
  const [bulkMove, setBulkMove] = useState<string[] | null>(null);
  const [bulkDelete, setBulkDelete] = useState<string[] | null>(null);
  // the "···" of a gallery card or a recent row
  const [viewMenu, setViewMenu] = useState<{ node: DocsTreeNode; at: DOMRect } | null>(null);
  const qc = useQueryClient();
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem('docsTreeCollapsed') === '1');
  const [dragFiles, setDragFiles] = useState<number | null>(null);
  const [failedAt, setFailedAt] = useState(() => new Date());

  const restore = useRestorePage(projectId);
  const publish = usePublishPage(projectId);
  const renameApi = useRenameWithLinks(projectId);
  const recycle = useDocsRecycleBin(projectId);
  const treeActions = useTreeActions(projectId, nodes);

  /** Saves a page's icon (or removes it) and shows it in the tree at once. */
  async function saveIcon(pageId: string, icon: string | null) {
    const tree = docsKeys.tree(projectId);
    const before = qc.getQueryData<DocsTreeNode[]>(tree);
    qc.setQueryData<DocsTreeNode[]>(tree, (old) => old?.map((n) => (n.id === pageId ? { ...n, icon } : n)));
    try {
      const saved = await patchPageSettings(pageId, { icon });
      qc.setQueryData<DocsPage>(docsKeys.page(pageId), (old) => (old ? { ...old, ...saved } : saved));
      void qc.invalidateQueries({ queryKey: tree });
    } catch (e) {
      qc.setQueryData(tree, before);
      toast.error("Couldn't change the page icon", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }

  const layoutRef = useRef(onLayoutChange);
  layoutRef.current = onLayoutChange;
  useEffect(() => {
    layoutRef.current?.(layout);
    // a drawer of the layout before is not one of this one
    setRailOpen(false);
  }, [layout]);

  // switching projects resets the selection to that project's last page
  useEffect(() => {
    setSelectedId(localStorage.getItem(`docsPage:${projectId}`));
    setEditing(false);
  }, [projectId]);

  const handledRef = useRef(onRequestHandled);
  handledRef.current = onRequestHandled;
  useEffect(() => {
    if (!requestedPageId) return;
    if (!isPageId(requestedPageId)) {
      if (!projectId) return undefined; // the project of the link is not open yet
      // a share link by slug path (`?docs=architecture/api`, AC-4): find the page it names, then open it
      let live = true;
      client
        .get<DocsPage>(`/projects/${projectId}/docs/by-path`, { params: { path: requestedPageId } })
        .then((r) => {
          if (!live) return;
          setSelectedId(r.data.id);
          setEditing(false);
          if (requestedAnchor) scrollToSection(requestedAnchor);
        })
        .catch(() => live && toast.error('No page at this link', `Nothing in this space is at “${requestedPageId}”.`))
        .finally(() => live && handledRef.current?.());
      return () => {
        live = false;
      };
    }
    setSelectedId(requestedPageId);
    setEditing(false);
    if (requestedAnchor) scrollToSection(requestedAnchor);
    handledRef.current?.();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPageId, requestedAnchor, projectId]);

  // open the first top-level page when nothing is selected yet
  useEffect(() => {
    if (!tree.isSuccess || nodes.length === 0 || selectedId || requestedPageId) return;
    const first = nodes.filter((n) => !n.parentId).sort((x, y) => x.position - y.position)[0];
    if (first) setSelectedId(first.id);
  }, [tree.isSuccess, nodes, selectedId, requestedPageId]);

  useEffect(() => {
    if (selectedId) localStorage.setItem(`docsPage:${projectId}`, selectedId);
  }, [selectedId, projectId]);

  const pageQuery = useDocsPage(selectedId);
  const readingVersion = reading && reading.pageId === selectedId ? reading.version : null;
  const versionQuery = useDocsVersion(readingVersion ? selectedId : null, readingVersion);
  const restoreVersion = useRestoreVersion(projectId);
  const livePage = pageQuery.data;
  const pageError = pageQuery.error ? docsErrorDetail(pageQuery.error) : null;
  const treeError = tree.error ? docsErrorDetail(tree.error) : null;
  const networkDown = (pageQuery.isError && !pageError) || (tree.isError && !treeError);
  const access = useDocsAccess(projectId);
  // who is looking and when, for the filters of the gallery and the recent list (a new "now" with each tree)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewCtx = useMemo(() => ({ me: access.data?.me ?? '', now: new Date() }), [access.data?.me, nodes]);
  const aiState = useDocsAiState(projectId);
  const aiOn = aiState.data?.state === 'ready' || aiState.data?.state === 'no_member';
  const healthCount = useDocsHealthCount(projectId, aiState.data?.state === 'ready');
  const [healthOpen, setHealthOpen] = useState(false);
  const requestAccess = useRequestDocsAccess(projectId);
  const readOnly =
    access.data && access.data.access && !access.data.canEdit
      ? access.data.policy === 'admins'
        ? 'Only project admins can edit pages in this space'
        : 'Only project members can edit pages in this space'
      : null;
  const cachedPage = selectedId && !livePage ? offlineApi.getCachedPage(selectedId) : null;
  const offlineCopy = !livePage && networkDown && cachedPage ? cachedToPage(cachedPage, projectId, nodes) : null;
  const page = livePage ?? offlineCopy;
  useEffect(() => {
    if (pageQuery.isError || tree.isError) setFailedAt(new Date());
  }, [pageQuery.isError, pageQuery.errorUpdatedAt, tree.isError, tree.errorUpdatedAt]);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setEditing(false);
      setRailOpen(false);
      onCloseResults?.();
    },
    [onCloseResults],
  );
  const [peekTarget, setPeekTarget] = useState<PeekTarget | null>(null);
  const peek = useCallback(
    (pageId: string, anchor?: string | null, hint?: PeekTarget['hint']) =>
      setPeekTarget({ pageId, anchor: anchor ?? null, hint }),
    [],
  );
  const [filterRequest, setFilterRequest] = useState<{ q: string; n: number } | null>(null);

  // Wide and Full pages fold the tree to its rail (design board "app frame", B), and a book's pages read in focus
  const pageWide =
    !!page && page.kind !== 'canvas' && (isWidePage(readPageLook(page.settings)) || !!bookOf(page, nodes));
  // a tablet shows the rail; a phone has no rail (the Pages button and the left edge open the tree)
  const folded = layout === 'tablet' || (layout === 'desktop' && (editing || pageWide));
  const showRail = layout === 'tablet' || (layout === 'desktop' && (treeCollapsed || editing || pageWide));
  function setCollapsed(v: boolean) {
    setTreeCollapsed(v);
    localStorage.setItem('docsTreeCollapsed', v ? '1' : '0');
  }
  function showTree() {
    if (layout === 'phone' || folded) setRailOpen(true);
    else setCollapsed(false);
  }

  // the app bar hides while editing on a tablet or a phone, so the page and the formatting get the screen
  const immersive = editing && layout !== 'desktop';
  const immersiveRef = useRef(onImmersiveChange);
  immersiveRef.current = onImmersiveChange;
  useEffect(() => {
    immersiveRef.current?.(immersive);
  }, [immersive]);
  useEffect(() => () => immersiveRef.current?.(false), []);

  // a swipe from the left edge opens the tree on touch screens (the Pages button and the rail do the same)
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const left = rootEl?.getBoundingClientRect().left ?? 0;
    swipe.current =
      layout !== 'desktop' && !railOpen && t && t.clientX - left < EDGE_PX ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const from = swipe.current;
    swipe.current = null;
    const t = e.changedTouches[0];
    if (from && t && t.clientX - from.x > SWIPE_PX && Math.abs(t.clientY - from.y) < SWIPE_PX) setRailOpen(true);
  };

  // palette hand-offs: "Create page “…”" and "Filter the tree instead"
  useEffect(() => {
    if (!intent) return;
    if (intent.kind === 'write-page') {
      setNewPage({ parentId: null, aiFrom: { kind: 'prompt', text: intent.question } });
    } else if (intent.kind === 'create-page') {
      setNewPage({ parentId: null, title: intent.title });
    } else {
      onCloseResults?.();
      if (narrow || folded) setRailOpen(true);
      else {
        setTreeCollapsed(false);
        localStorage.setItem('docsTreeCollapsed', '0');
      }
      setFilterRequest((r) => ({ q: intent.q, n: (r?.n ?? 0) + 1 }));
    }
    onIntentHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  }
  function pageLink(id: string) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('docs', id);
    return url.toString();
  }
  async function pageForNode(id: string): Promise<DocsPage | null> {
    if (page && page.id === id) return page;
    try {
      return (await client.get<DocsPage>(`/docs/pages/${id}`)).data;
    } catch {
      return null;
    }
  }

  /** Opens the export dialog (ExportHost) with a format; without it (never here), Markdown downloads as before. */
  function exportPage(full: DocsPage, format: ExportFormat | null) {
    if (openExport(full.id, format)) return;
    const doc = publishedDoc(full);
    const md = doc ? docToMarkdown(doc) : full.markdown;
    download(`${full.slug}.md`, `# ${full.title}\n\n${canvasesAsImages(sketchesAsImages(md))}\n`);
  }

  async function restoreRead(pageId: string, version: number) {
    try {
      const updated = await restoreVersion.mutateAsync({ pageId, version, note: `Restored from v${version}` });
      setReading(null);
      toast.success(`Restored v${version} as v${updated.version}`);
    } catch (e) {
      toast.error("Couldn't restore the version", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }

  async function runAction(action: PageAction, target: { id: string; title: string }) {
    switch (action) {
      case 'edit': {
        // a page converting to the rich format (or whose conversion failed) is not editable
        const lock = page?.id === target.id ? convertLock(page) : null;
        if (lock) {
          toast.info(lock === 'converting' ? 'Not yet' : 'Read-only', convertLockTip(lock));
          return;
        }
        select(target.id);
        setEditing(true);
        return;
      }
      case 'add-child':
        setNewPage({ parentId: target.id });
        return;
      case 'copy-link':
      case 'share':
        await copy(pageLink(target.id), 'Link copied');
        return;
      case 'delete':
        setDeleteFor({ id: target.id, title: target.title });
        return;
      case 'give-ai':
        setGiveFor({ id: target.id, title: target.title });
        return;
      case 'history':
        select(target.id);
        setHistory({});
        return;
      case 'rename':
        // the dialog: the icon is part of the name, and it says what happens to links (F2 on a row renames inline)
        setRenameFor({ node: { id: target.id, title: target.title }, newTitle: target.title });
        return;
      case 'settings':
      case 'book':
        if (page?.id !== target.id) select(target.id);
        treeView.setView('tree');
        setSettingsTab(action === 'book' ? 'book' : undefined);
        setSettingsFor(target.id);
        return;
      case 'icon': {
        const known = nodes.find((n) => n.id === target.id)?.icon ?? null;
        setIconFor({ id: target.id, title: target.title, icon: known });
        return;
      }
      case 'save-template':
        if (readOnly) {
          toast.info('Read-only', readOnly);
          return;
        }
        break;
      default:
    }
    const full = await pageForNode(target.id);
    if (!full) return;
    if (action === 'move') setMoveFor(full);
    else if (action === 'duplicate') setDupFor(full);
    else if (action === 'export') exportPage(full, null);
    else if (action === 'save-template') setSaveTplFor(full);
    else if (action === 'copy-markdown') {
      // a rich page's Markdown is written from its JSON, as the editor writes it (the server's projection otherwise)
      const doc = publishedDoc(full);
      const md = doc ? docToMarkdown(doc) : full.markdown;
      await copy(`# ${full.title}\n\n${md}`, 'Markdown copied');
    }
  }

  const anyDialog = !!(
    newPage ||
    moveFor ||
    dupFor ||
    history ||
    deleteFor ||
    renameFor ||
    giveFor ||
    saveTplFor ||
    iconFor ||
    bulkMove ||
    bulkDelete
  );
  usePageShortcuts(
    (a) => {
      if (page) void runAction(a, page);
    },
    !!page && !editing && !anyDialog && !offlineCopy,
  );

  async function requestRename(node: DocsTreeNode, title: string) {
    const links = await fetchRenameLinkCount(node.id, title);
    if (links > 0) {
      setRenameFor({ node, newTitle: title });
      return;
    }
    try {
      await renameApi.mutateAsync({ pageId: node.id, title, rewriteLinks: false });
      toast.success(`Renamed to “${title}”`);
    } catch (e) {
      toast.error("Couldn't rename", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }

  async function replaceSection(from: { title: string; anchor: string }, to: string) {
    if (!livePage || livePage.version < 1) return;
    const doc = publishedDoc(livePage);
    if (doc) {
      // a rich page: the reference nodes themselves point at the new section
      const next = replaceSectionRefs(doc, from, to);
      if (!next) return;
      try {
        await publish.mutateAsync({
          pageId: livePage.id,
          baseVersion: livePage.version,
          content: next,
          note: `Link to ${from.title} › ${to} updated`,
        });
        toast.success(`Link now points to “${to}”`);
      } catch (e) {
        toast.error("Couldn't update the link", docsErrorDetail(e)?.message ?? extractError(e));
      }
      return;
    }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const md = livePage.markdown.replace(
      new RegExp(`\\[\\[${esc(from.title)}#${esc(from.anchor)}(?=[\\]|])`, 'g'),
      `[[${from.title}#${to}`,
    );
    if (md === livePage.markdown) return;
    try {
      await publish.mutateAsync({
        pageId: livePage.id,
        baseVersion: livePage.version,
        markdown: md,
        note: `Link to ${from.title} › ${to} updated`,
      });
      toast.success(`Link now points to “${to}”`);
    } catch (e) {
      toast.error("Couldn't update the link", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }

  // dropping .md files or folders anywhere on the Docs page (the editor takes dropped files itself)
  useEffect(() => {
    if (!onDropFiles || editing) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragFiles(Math.max(1, Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file').length));
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragFiles(null);
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragFiles(null);
      const files = await collectFiles(e.dataTransfer!);
      if (files.length) onDropFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [onDropFiles, editing]);

  const firstPage = () => nodes.filter((n) => !n.parentId).sort((a, b) => a.position - b.position)[0];
  const goOverview = () => {
    const f = firstPage();
    if (f) select(f.id);
    else {
      setSelectedId(null);
      localStorage.removeItem(`docsPage:${projectId}`);
    }
  };

  const empty = tree.isSuccess && nodes.length === 0;
  const treeLoading = tree.isLoading && !cachedTree;
  const stage = useLoadingStage(treeLoading);
  const pageLoadingStage = useLoadingStage(!!selectedId && pageQuery.isLoading && !tree.isLoading);
  const selNode = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
  const crumbsFor = (n?: DocsTreeNode) => {
    const out: string[] = [];
    let cur = n;
    while (cur) {
      out.unshift(cur.title);
      cur = cur.parentId ? nodes.find((x) => x.id === cur!.parentId) : undefined;
    }
    return out;
  };

  const docsDisabled = treeError?.code === 'docs_disabled' || pageError?.code === 'docs_disabled';
  const noAccess =
    access.data?.access === false || treeError?.code === 'docs_no_access' || pageError?.code === 'docs_no_access';
  const disabledRole = treeError?.role ?? pageError?.role;

  const treeEl = (
    <DocsTree
      projectId={projectId}
      projectName={projectName}
      nodes={nodes}
      selectedId={selectedId}
      loadingId={pageQuery.isLoading ? selectedId : null}
      onSelect={(id) => {
        setHealthOpen(false);
        treeView.setView('tree');
        select(id);
      }}
      onNewPage={(parentId) => setNewPage({ parentId })}
      renderNewPageMenu={(close) => (
        <NewPageMenu
          touch={narrow}
          onClose={close}
          onChoose={(c) => {
            if (c.kind === 'blank') setNewPage({ parentId: null, template: 'blank' });
            else if (c.kind === 'gallery') setNewPage({ parentId: null });
            else if (c.kind === 'template') setNewPage({ parentId: null, template: c.id });
            else onImport?.(c.kind === 'paste' ? 'paste' : undefined);
          }}
        />
      )}
      headerActions={
        onPopOut ? (
          <button
            type="button"
            className="dk-icobtn"
            aria-label="Open Docs in its own window"
            title="Open in its own window"
            data-testid="docs-pop-out"
            onClick={() => onPopOut(selectedId)}
          >
            <PopOutIcon size={15} />
          </button>
        ) : undefined
      }
      readOnly={!!readOnly}
      onRequestRename={(n, t) => void requestRename(n, t)}
      renamingId={renamingId}
      onRenamingChange={setRenamingId}
      onMove={(id, parentId, beforeId, afterId) => treeActions.moveOne(id, { parentId, beforeId, afterId })}
      layout={layout}
      view={treeView.view}
      onViewChange={(v) => {
        treeView.setView(v);
        setHealthOpen(false);
        if (v !== 'tree') {
          onCloseResults?.();
          setEditing(false);
          setRailOpen(false);
        }
      }}
      sort={treeView.sort}
      onSortChange={treeView.setSort}
      filters={treeView.filters}
      onFiltersChange={treeView.setFilters}
      me={access.data?.me ?? ''}
      onBulk={(action, roots) => {
        if (action === 'move') setBulkMove(roots);
        else if (action === 'delete') setBulkDelete(roots);
        else if (action === 'duplicate') void treeActions.duplicateMany(roots);
        else treeActions.exportMany(roots);
      }}
      onMoveTo={(n) => void runAction('move', n)}
      binCount={recycle.data?.length}
      onOpenBin={() => window.dispatchEvent(new CustomEvent(OPEN_RECYCLE_BIN_EVENT))}
      onCollapse={() => (railOpen ? setRailOpen(false) : setCollapsed(true))}
      aiOn={aiOn}
      onAskDocs={onAskDocs}
      onHealth={() => setHealthOpen(true)}
      healthActive={healthOpen}
      healthCount={healthCount}
      renderMenu={(node, close) => (
        <TreePageMenu
          node={node}
          sheet={layout === 'phone'}
          onClose={close}
          onAction={(a) => {
            close();
            void runAction(a, node);
          }}
        />
      )}
      onOpenSearch={(q) => onSearch?.(q)}
      filterRequest={filterRequest}
      headerExtra={<DocsFollowToggle projectId={projectId} />}
    />
  );

  let content: React.ReactNode;
  let leftOverride: React.ReactNode = null;
  if (docsDisabled) {
    leftOverride = <></>;
    content = (
      <DocsDisabled
        onOpenSettings={onOpenSettings}
        onBack={onBack}
        isAdmin={!disabledRole || disabledRole === 'admin'}
      />
    );
  } else if (noAccess) {
    leftOverride = <></>;
    content = (
      <NoAccess
        projectName={projectName}
        admins={access.data?.admins ?? []}
        onRequest={async (note) => (await requestAccess.mutateAsync(note)).sent}
        onBack={onBack}
      />
    );
  } else if (healthOpen && aiOn) {
    content = (
      <DocsHealthView
        projectId={projectId}
        onOpenPage={(id) => {
          setHealthOpen(false);
          select(id);
        }}
        onOpenTicket={onOpenTicket}
        onWritePage={(ticketId) => {
          setHealthOpen(false);
          setNewPage({ parentId: null, aiFrom: { kind: 'ticket', ticketId } });
        }}
        onClose={() => setHealthOpen(false)}
      />
    );
  } else if (treeLoading) {
    leftOverride = <TreeSkeleton />;
    content =
      stage === 2 ? (
        <LoadError
          title="Couldn't load the Docs space"
          message="The server didn't answer in time. Nothing was changed."
          error={tree.error}
          path={`/projects/${projectId}/docs/tree`}
          failedAt={failedAt}
          onRetry={() => void tree.refetch()}
          onBack={onBack}
          backLabel="Back to Board"
          autoRetry={false}
        />
      ) : (
        <PageSkeleton note={stage === 1 ? <SlowLoadNote onRetry={() => void tree.refetch()} /> : undefined} />
      );
  } else if (tree.isError && !cachedTree) {
    content = (
      <LoadError
        title="Couldn't load the Docs space"
        message="The server didn't answer in time. Nothing was changed."
        error={tree.error}
        path={`/projects/${projectId}/docs/tree`}
        failedAt={failedAt}
        onRetry={() => void tree.refetch()}
        onBack={onBack}
        backLabel="Back to Board"
      />
    );
  } else if (empty) {
    content = (
      <DocsHero
        projectName={projectName}
        projectId={projectId}
        ticketPrefix={heroPrefix}
        layout={layout}
        onBrowseTemplates={() => setNewPage({ parentId: null })}
        onCreate={(t) => setNewPage({ parentId: null, template: t })}
        onImport={onImport}
        onDropFiles={onDropFiles}
      />
    );
  } else if (!selectedId) {
    content = <PageSkeleton />;
  } else if (pageQuery.isLoading && !page) {
    content = (
      <div
        style={{
          flex: 1,
          minWidth: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <TopProgress />
        {pageLoadingStage === 2 ? (
          <LoadError
            error={pageQuery.error}
            path={`/docs/pages/${selectedId}`}
            failedAt={failedAt}
            onRetry={() => void pageQuery.refetch()}
            onBack={goOverview}
            autoRetry={false}
          />
        ) : (
          <PageSkeleton
            title={selNode?.title}
            cover={!!selNode?.cover}
            crumbs={selNode ? crumbsFor(selNode) : undefined}
            note={pageLoadingStage === 1 ? <SlowLoadNote onRetry={() => void pageQuery.refetch()} /> : undefined}
          />
        )}
      </div>
    );
  } else if (pageError?.code === 'page_deleted') {
    const entry = recycle.data?.find((d) => d.id === selectedId);
    content = (
      <DeletedPage
        title={entry?.title}
        deletedBy={pageError.deletedBy}
        deletedAt={pageError.deletedAt ?? entry?.deletedAt}
        daysLeft={entry?.daysLeft}
        restoring={restore.isPending}
        onRestore={() =>
          restore.mutate(selectedId, {
            onSuccess: () => toast.success('Page restored'),
            onError: (e) => toast.error("Couldn't restore the page", extractError(e)),
          })
        }
        onHome={goOverview}
      />
    );
  } else if (pageError?.code === 'page_not_found') {
    content = (
      <NotFound
        projectId={projectId}
        path={selectedId}
        onOpenPage={select}
        onHome={goOverview}
        onSearch={onSearch ? () => onSearch() : undefined}
      />
    );
  } else if (!page) {
    content = (
      <LoadError
        error={pageQuery.error}
        path={`/docs/pages/${selectedId}`}
        failedAt={failedAt}
        onRetry={() => void pageQuery.refetch()}
        onBack={goOverview}
      />
    );
  } else if (page.kind === 'canvas' && !offlineCopy) {
    content = (
      <CanvasPageView
        key={page.id}
        page={page}
        projectId={projectId}
        projectName={projectName}
        onAction={(a) => void runAction(a, page)}
        onOpenPage={select}
      />
    );
  } else if (editing && !offlineCopy && !(livePage && convertLock(livePage))) {
    content = (
      <DocsEditScreen
        key={page.id}
        projectId={projectId}
        projectName={projectName}
        page={page}
        nodes={nodes}
        onOpenPage={select}
        onOpenTicket={onOpenTicket}
        // The editor clears its root in a passive cleanup, which runs after the page view that replaces it has
        // already announced its body: forwarding that null would wipe the new root (Find in page found nothing
        // right after publishing). A root that left the document is dropped by the consumer instead.
        onEditorRoot={(el) => {
          if (el) onBodyRef?.(el);
        }}
        onExit={(updated) => {
          setEditing(false);
          if (updated) setSelectedId(updated.id);
        }}
        layout={layout}
        onOpenSettings={() => setSettingsFor(page.id)}
      />
    );
  } else {
    content = (
      <DocsPageView
        key={page.id}
        page={page}
        projectId={projectId}
        projectName={projectName}
        // the history drawer takes 420px of the row: use the compact page layout while it is open
        narrow={narrow || history !== null}
        offline={offlineCopy ? { savedAt: cachedPage!.savedAt, version: cachedPage!.version } : null}
        readOnly={readOnly}
        onTryAgain={() => {
          void pageQuery.refetch();
          void tree.refetch();
        }}
        onAction={(a) => void runAction(a, page)}
        onOpenPage={(id, anchor) => {
          select(id);
          if (anchor) scrollToSection(anchor);
        }}
        onOpenTicket={onOpenTicket}
        onCompare={(from, to) => setHistory({ compare: { from, to } })}
        onCreatePage={(title) => setNewPage({ parentId: page.id, title })}
        onRestorePage={(id) => restore.mutate(id, { onSuccess: () => toast.success('Page restored') })}
        onReplaceSection={(f, t) => void replaceSection(f, t)}
        onBodyRef={onBodyRef}
        layout={layout}
        // on a tablet the rail has the menu button
        onOpenSidebar={layout === 'phone' ? onOpenSidebar : undefined}
        onOpenTree={() => setRailOpen(true)}
        onSearch={onSearch ? () => onSearch() : undefined}
        nodes={nodes}
        onExport={(f) => exportPage(page, f)}
        olderVersion={
          readingVersion
            ? {
                version: readingVersion,
                detail: versionQuery.data ?? null,
                onBack: () => setReading(null),
                onRestore: () => void restoreRead(page.id, readingVersion),
                restoring: restoreVersion.isPending,
              }
            : null
        }
      />
    );
  }

  if (resultsQuery !== null && !docsDisabled && !treeLoading) {
    content = (
      <SearchResults
        key={resultsQuery}
        projectId={projectId}
        projectName={projectName}
        initialQuery={resultsQuery}
        onOpenPage={(id, anchor) => {
          select(id);
          if (anchor) scrollToSection(anchor);
        }}
        onOpenTicket={onOpenTicket}
        onBack={() => onCloseResults?.()}
      />
    );
  }

  // Gallery and Recent take the page's place (the tree stays on the left)
  const otherView =
    treeView.view !== 'tree' &&
    resultsQuery === null &&
    !leftOverride &&
    !docsDisabled &&
    !noAccess &&
    !treeLoading &&
    !empty &&
    !(healthOpen && aiOn);
  if (otherView) {
    const viewProps = {
      nodes,
      layout,
      filters: treeView.filters,
      onFiltersChange: treeView.setFilters,
      ctx: viewCtx,
      sort: treeView.sort,
      onSortChange: treeView.setSort,
      onOpen: (id: string) => {
        treeView.setView('tree');
        select(id);
      },
      onMenu: (node: DocsTreeNode, at: DOMRect) => setViewMenu({ node, at }),
      renderSuggestions: (n: DocsTreeNode) => <SuggestionMarker count={n.suggestions} />,
    };
    content =
      treeView.view === 'gallery' ? (
        <GalleryView
          {...viewProps}
          onMove={readOnly ? undefined : (id, t) => void treeActions.moveOne(id, t)}
          onAddChild={readOnly ? undefined : (parentId) => setNewPage({ parentId })}
        />
      ) : (
        <RecentView {...viewProps} />
      );
  }

  const treeDrawer = railOpen && !leftOverride && (
    <DocsDrawer
      label="Pages"
      width={layout === 'phone' ? 336 : 340}
      onClose={() => setRailOpen(false)}
      testId="tree-drawer"
    >
      {treeEl}
    </DocsDrawer>
  );
  // a phone has no tree beside the page (it is a drawer); an empty space keeps the full tree for its New page
  const left =
    leftOverride ??
    (layout === 'phone' ? null : showRail && !empty ? (
      <DocsRail
        nodes={nodes}
        selectedId={selectedId}
        onExpand={showTree}
        onSearch={() => onSearch?.()}
        onNewPage={readOnly ? undefined : (p) => setNewPage({ parentId: p })}
        onSelect={select}
        onOpenSidebar={layout === 'tablet' ? onOpenSidebar : undefined}
      />
    ) : (
      treeEl
    ));
  const settingsPage = page && settingsFor === page.id && page.kind !== 'canvas' && !leftOverride ? page : null;
  const settingsPanel = settingsPage && (
    <PageSettingsPanel
      key={`${settingsPage.id}:${settingsTab ?? ''}`}
      page={settingsPage}
      initialTab={settingsTab}
      nodes={nodes}
      layout={layout}
      readOnly={readOnly ?? (offlineCopy ? 'Reconnect to change the page settings.' : null)}
      onClose={() => setSettingsFor(null)}
      onSaveTemplate={() => setSaveTplFor(settingsPage)}
    />
  );

  return (
    <DocsPeekProvider value={peek}>
      <div
        ref={setRootEl}
        className={`docs-root dk-layout-${layout}${narrow ? ' dk-touch' : ''}`}
        data-testid="docs-view"
        data-layout={layout}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          position: 'relative',
          overflow: 'hidden',
          background: '#FFFFFF',
        }}
      >
        {left}
        {content}
        {settingsPanel}
        {treeDrawer}
        {!editing && !empty && !docsDisabled && (
          <SinceViewedDigest projectId={projectId} nodes={nodes} onOpenPage={select} />
        )}

        {dragFiles != null && (
          <div
            role="presentation"
            style={{
              position: 'absolute',
              inset: 12,
              zIndex: 150,
              borderRadius: 12,
              border: '2px dashed #2E6F40',
              background: 'rgba(241,248,243,0.94)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: '#DCEEE1',
                color: '#2E6F40',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="i26" size={22} strokeWidth={1.8} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>
              Drop to add {dragFiles} file{dragFiles === 1 ? '' : 's'}
            </div>
            <div style={{ fontSize: 12.5, color: '#2E6F40' }}>
              Markdown, Word and HTML files. Folders become a page tree.
            </div>
          </div>
        )}

        {newPage && (
          <NewPageDialog
            projectId={projectId}
            nodes={nodes}
            initialParentId={newPage.parentId}
            initialTemplate={newPage.template}
            initialTitle={newPage.title}
            aiFrom={newPage.aiFrom}
            initialChip={newPage.chip}
            layout={layout}
            onClose={() => setNewPage(null)}
            onCreated={(p) => {
              setNewPage(null);
              setSelectedId(p.id);
              setEditing(true);
              toast.success('Page created', 'It is a draft until you publish it.');
            }}
          />
        )}
        {saveTplFor && (
          <SaveTemplateDialog
            projectId={projectId}
            page={saveTplFor}
            layout={layout}
            onClose={() => setSaveTplFor(null)}
            onSaved={() => {
              setSaveTplFor(null);
              toast.success('Saved as a template.', 'Find it in New page › Yours.', 8000, {
                label: 'Open the gallery',
                onClick: () => setNewPage({ parentId: null, chip: 'yours' }),
              });
            }}
          />
        )}
        {editing && page?.convertState === 'done' && !readOnly && <WhatsNewTour layout={layout} />}
        {moveFor && (
          <MoveToDialog
            projectId={projectId}
            page={moveFor}
            nodes={nodes}
            onClose={() => setMoveFor(null)}
            onMoved={() => setMoveFor(null)}
          />
        )}
        {dupFor && (
          <DuplicateDialog
            projectId={projectId}
            page={dupFor}
            nodes={nodes}
            onClose={() => setDupFor(null)}
            onDuplicated={(p) => {
              setDupFor(null);
              select(p.id);
            }}
          />
        )}
        {history && page && (
          <HistoryDrawer
            projectId={projectId}
            page={page}
            initialCompare={history.compare}
            onClose={() => setHistory(null)}
            onReopen={() => setHistory({})}
            onOpenPage={select}
            layout={layout}
            onRead={(v) => {
              setReading({ pageId: page.id, version: v });
              setHistory(null);
            }}
          />
        )}
        {deleteFor && (
          <DeleteDialog
            projectId={projectId}
            page={deleteFor}
            onClose={() => setDeleteFor(null)}
            onDeleted={(count) => {
              const { id, title } = deleteFor;
              setDeleteFor(null);
              toast.success(
                `Moved “${title}” to the Recycle Bin`,
                count > 1 ? `${count} pages, kept for 30 days` : 'Kept for 30 days',
              );
              if (selectedId === id) {
                localStorage.removeItem(`docsPage:${projectId}`);
                setSelectedId(null);
                setEditing(false);
              }
            }}
          />
        )}
        {giveFor && (
          <GivePageDialog
            projectId={projectId}
            page={giveFor}
            onClose={() => setGiveFor(null)}
            onGiven={(ticketId, member) => {
              setGiveFor(null);
              toast.success(`${member} has the page`, `${ticketId} is linked to it; its work shows on the page.`);
            }}
          />
        )}
        {iconFor && (
          <IconPicker
            projectId={projectId}
            title={iconFor.title}
            current={iconFor.icon}
            layout={layout}
            onClose={() => setIconFor(null)}
            onPick={(icon) => {
              const id = iconFor.id;
              setIconFor(null);
              void saveIcon(id, icon);
            }}
          />
        )}
        {bulkMove && nodes.find((n) => n.id === bulkMove[0]) && (
          <MoveToDialog
            projectId={projectId}
            page={
              cachedToPageStub(
                nodes.find((n) => n.id === bulkMove[0])!,
                projectId,
              ) as DocsPage
            }
            nodes={nodes.filter((n) => !bulkMove.slice(1).includes(n.id))}
            heading={bulkMove.length > 1 ? `Move ${bulkMove.length} pages` : undefined}
            onClose={() => setBulkMove(null)}
            onChoose={(t) => void treeActions.moveMany(bulkMove, t)}
          />
        )}
        {bulkDelete && (
          <BulkDeleteDialog
            roots={nodes.filter((n) => bulkDelete.includes(n.id))}
            affected={affectedPages(nodes, bulkDelete).size}
            layout={layout}
            onClose={() => setBulkDelete(null)}
            onConfirm={() => {
              const roots = bulkDelete;
              setBulkDelete(null);
              if (selectedId && affectedPages(nodes, roots).has(selectedId)) {
                localStorage.removeItem(`docsPage:${projectId}`);
                setSelectedId(null);
                setEditing(false);
              }
              void treeActions.deleteMany(roots);
            }}
          />
        )}
        {viewMenu && (
          <div
            className="docs-root"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: viewMenu.at.right,
              top: viewMenu.at.bottom - 6,
              width: 0,
              height: 0,
              zIndex: 300,
            }}
          >
            <TreePageMenu
              node={viewMenu.node}
              sheet={layout === 'phone'}
              onClose={() => setViewMenu(null)}
              onAction={(a) => {
                const n = viewMenu.node;
                setViewMenu(null);
                void runAction(a, n);
              }}
            />
          </div>
        )}
        {renameFor && (
          <RenameDialog
            projectId={projectId}
            page={renameFor.node}
            newTitle={renameFor.newTitle}
            nodes={nodes}
            layout={layout}
            onClose={() => setRenameFor(null)}
            onRenamed={() => setRenameFor(null)}
          />
        )}
        <ExportHost
          projectId={projectId}
          projectName={projectName}
          nodes={nodes}
          canEdit={!!access.data?.canEdit}
          layout={layout}
          currentPage={page}
        />
        {peekTarget && (
          <DocPeekPanel
            target={peekTarget}
            projectId={projectId}
            onSwitch={setPeekTarget}
            onClose={() => setPeekTarget(null)}
            onOpenInDocs={(id, anchor) => {
              setPeekTarget(null);
              select(id);
              if (anchor) scrollToSection(slugifyHeading(anchor));
            }}
            onOpenTicket={(id) => {
              setPeekTarget(null);
              onOpenTicket(id);
            }}
          />
        )}
      </div>
    </DocsPeekProvider>
  );
}

/** Files from a drop, walking dropped folders and keeping the relative path on `webkitRelativePath`. */
async function collectFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const isMd = (n: string) => /\.(md|markdown|docx|html?)$/i.test(n);
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      if (!isMd(file.name)) return;
      const rel = `${prefix}${file.name}`;
      if (prefix) Object.defineProperty(file, 'webkitRelativePath', { value: rel });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = Array.from(dt.items ?? [])
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length) {
    for (const e of entries) await walk(e, '');
  } else {
    out.push(...Array.from(dt.files).filter((f) => isMd(f.name)));
  }
  return out;
}
