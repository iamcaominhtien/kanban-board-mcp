import { useCallback, useEffect, useMemo, useState } from 'react';
import { docsErrorDetail, useDocsPage, useDocsRecycleBin, useDocsTree, useMovePage, usePublishPage, useRestorePage } from '../../api/docs';
import { useRenameWithLinks } from '../../api/docsActions';
import { fetchRenameLinkCount } from '../../api/docsPage';
import { client } from '../../api/client';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import { DeleteDialog } from './DeleteDialog';
import { DocsEditScreen } from './DocsEditScreen';
import { DocsFollowToggle } from './DocsFollowToggle';
import { DocsHero } from './DocsHero';
import { DocsPageView, type PageAction } from './DocsPageView';
import { DocsRail } from './DocsRail';
import { DeletedPage, DocsDisabled, LoadError, NotFound, PageSkeleton, SlowLoadNote, TopProgress, TreeSkeleton } from './DocsStates';
import { DocsTree } from './DocsTree';
import { DuplicateDialog } from './DuplicateDialog';
import { HistoryDrawer } from './HistoryDrawer';
import { Icon } from './Icon';
import { MoveToDialog } from './MoveToDialog';
import { NewPageDialog } from './NewPageDialog';
import { PageMenu, usePageShortcuts, type PageMenuAction } from './PageMenu';
import { RenameDialog } from './RenameDialog';
import { useDocsOffline } from './useDocsOffline';
import './docs.css';

interface Props {
  projectId: string;
  projectName: string;
  requestedPageId?: string | null;
  onRequestHandled?: () => void;
  onOpenTicket: (ticketId: string) => void;
  /** "Import Markdown" (hero) and the import strip. */
  onImport?: () => void;
  /** Markdown files or folders dropped anywhere on the Docs page, or picked with "Choose files…". */
  onDropFiles?: (files: File[]) => void;
  /** Docs switched off for the project (E6). */
  onOpenSettings?: () => void;
  onBack?: () => void;
  /** Search palette / full results; `query` is passed when the tree filter's Enter or "Search page content" asks for it. */
  onSearch?: (query?: string) => void;
  /** Called with the element holding the rendered page body (find-in-page). */
  onBodyRef?: (el: HTMLElement | null) => void;
}

const NARROW_PX = 1200;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
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
function TreePageMenu({ node, onAction, onClose }: { node: DocsTreeNode; onAction: (a: PageMenuAction) => void; onClose: () => void }) {
  const { data } = useDocsPage(node.id);
  if (!data) {
    return (
      <div className="dk-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 290, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[70, 50, 60].map((w) => <div key={w} className="skel" style={{ width: `${w}%`, height: 12 }} />)}
      </div>
    );
  }
  return <PageMenu page={data} onAction={onAction} onClose={onClose} />;
}

function cachedToPage(c: NonNullable<ReturnType<ReturnType<typeof useDocsOffline>['getCachedPage']>>, projectId: string, nodes: DocsTreeNode[]): DocsPage {
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

export function DocsView({ projectId, projectName, requestedPageId, onRequestHandled, onOpenTicket, onImport, onDropFiles, onOpenSettings, onBack, onSearch, onBodyRef }: Props) {
  const toast = useToast();
  const offlineApi = useDocsOffline(projectId);
  const tree = useDocsTree(projectId);
  const liveNodes = useMemo<DocsTreeNode[]>(() => tree.data ?? [], [tree.data]);
  const cachedTree = tree.isError && !docsErrorDetail(tree.error) ? offlineApi.getCachedTree() : null;
  const nodes = tree.data ? liveNodes : (cachedTree ?? liveNodes);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(`docsPage:${projectId}`));
  const [editing, setEditing] = useState(false);
  const [newPage, setNewPage] = useState<{ parentId: string | null; template?: string; title?: string } | null>(null);
  const [moveFor, setMoveFor] = useState<DocsPage | null>(null);
  const [dupFor, setDupFor] = useState<DocsPage | null>(null);
  const [history, setHistory] = useState<{ compare?: { from: number; to: number } } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; title: string } | null>(null);
  const [renameFor, setRenameFor] = useState<{ node: { id: string; title: string }; newTitle: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  const [railOpen, setRailOpen] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem('docsTreeCollapsed') === '1');
  const [dragFiles, setDragFiles] = useState<number | null>(null);
  const [failedAt, setFailedAt] = useState(() => new Date());

  const move = useMovePage(projectId);
  const restore = useRestorePage(projectId);
  const publish = usePublishPage(projectId);
  const renameApi = useRenameWithLinks(projectId);
  const recycle = useDocsRecycleBin(projectId);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // switching projects resets the selection to that project's last page
  useEffect(() => {
    setSelectedId(localStorage.getItem(`docsPage:${projectId}`));
    setEditing(false);
  }, [projectId]);

  useEffect(() => {
    if (requestedPageId) {
      setSelectedId(requestedPageId);
      setEditing(false);
      onRequestHandled?.();
    }
  }, [requestedPageId, onRequestHandled]);

  // open the first top-level page when nothing is selected yet
  useEffect(() => {
    if (!tree.isSuccess || nodes.length === 0 || selectedId) return;
    const first = nodes.filter((n) => !n.parentId).sort((x, y) => x.position - y.position)[0];
    if (first) setSelectedId(first.id);
  }, [tree.isSuccess, nodes, selectedId]);

  useEffect(() => {
    if (selectedId) localStorage.setItem(`docsPage:${projectId}`, selectedId);
  }, [selectedId, projectId]);

  const pageQuery = useDocsPage(selectedId);
  const livePage = pageQuery.data;
  const pageError = pageQuery.error ? docsErrorDetail(pageQuery.error) : null;
  const treeError = tree.error ? docsErrorDetail(tree.error) : null;
  const networkDown = (pageQuery.isError && !pageError) || (tree.isError && !treeError);
  const cachedPage = selectedId && !livePage ? offlineApi.getCachedPage(selectedId) : null;
  const offlineCopy = !livePage && networkDown && cachedPage ? cachedToPage(cachedPage, projectId, nodes) : null;
  const page = livePage ?? offlineCopy;
  useEffect(() => {
    if (pageQuery.isError || tree.isError) setFailedAt(new Date());
  }, [pageQuery.isError, pageQuery.errorUpdatedAt, tree.isError, tree.errorUpdatedAt]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setEditing(false);
    setRailOpen(false);
  }, []);

  const showRail = narrow || treeCollapsed;
  function setCollapsed(v: boolean) {
    setTreeCollapsed(v);
    localStorage.setItem('docsTreeCollapsed', v ? '1' : '0');
  }
  function showTree() {
    if (narrow) setRailOpen(true);
    else setCollapsed(false);
  }

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

  async function runAction(action: PageAction, target: { id: string; title: string }) {
    switch (action) {
      case 'edit':
        select(target.id);
        setEditing(true);
        return;
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
      case 'history':
        select(target.id);
        setHistory({});
        return;
      case 'rename':
        if (showRail) showTree();
        setRenamingId(target.id);
        return;
      default:
    }
    const full = await pageForNode(target.id);
    if (!full) return;
    if (action === 'move') setMoveFor(full);
    else if (action === 'duplicate') setDupFor(full);
    else if (action === 'copy-markdown') await copy(`# ${full.title}\n\n${full.markdown}`, 'Markdown copied');
    else if (action === 'export') download(`${full.slug}.md`, `# ${full.title}\n\n${full.markdown}\n`);
  }

  const anyDialog = !!(newPage || moveFor || dupFor || history || deleteFor || renameFor);
  usePageShortcuts((a) => { if (page) void runAction(a, page); }, !!page && !editing && !anyDialog && !offlineCopy);

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
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const md = livePage.markdown.replace(new RegExp(`\\[\\[${esc(from.title)}#${esc(from.anchor)}(?=[\\]|])`, 'g'), `[[${from.title}#${to}`);
    if (md === livePage.markdown) return;
    try {
      await publish.mutateAsync({ pageId: livePage.id, baseVersion: livePage.version, markdown: md, note: `Link to ${from.title} › ${to} updated` });
      toast.success(`Link now points to “${to}”`);
    } catch (e) {
      toast.error("Couldn't update the link", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }

  // dropping .md files or folders anywhere on the Docs page
  useEffect(() => {
    if (!onDropFiles) return;
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
  }, [onDropFiles]);

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

  const treeEl = (
    <DocsTree
      projectId={projectId}
      projectName={projectName}
      nodes={nodes}
      selectedId={selectedId}
      loadingId={pageQuery.isLoading ? selectedId : null}
      onSelect={select}
      onNewPage={(parentId) => setNewPage({ parentId })}
      onRequestRename={(n, t) => void requestRename(n, t)}
      renamingId={renamingId}
      onRenamingChange={setRenamingId}
      onMove={(id, parentId, beforeId, afterId) =>
        move.mutateAsync({ pageId: id, parentId, beforeId, afterId }).catch((e) => {
          toast.error("Couldn't move the page", docsErrorDetail(e)?.message ?? extractError(e));
        })
      }
      onCollapse={() => (narrow ? setRailOpen(false) : setCollapsed(true))}
      renderMenu={(node, close) => (
        <TreePageMenu
          node={node}
          onClose={close}
          onAction={(a) => {
            close();
            void runAction(a, node);
          }}
        />
      )}
      onOpenSearch={(q) => onSearch?.(q)}
      headerExtra={<DocsFollowToggle projectId={projectId} />}
    />
  );

  let content: React.ReactNode;
  let leftOverride: React.ReactNode = null;
  if (docsDisabled) {
    leftOverride = <></>;
    content = <DocsDisabled onOpenSettings={onOpenSettings} onBack={onBack} />;
  } else if (treeLoading) {
    leftOverride = <TreeSkeleton />;
    content =
      stage === 2 ? (
        <LoadError title="Couldn't load the Docs space" message="The server didn't answer in time. Nothing was changed." error={tree.error} path={`/projects/${projectId}/docs/tree`} failedAt={failedAt} onRetry={() => void tree.refetch()} onBack={onBack} backLabel="Back to Board" autoRetry={false} />
      ) : (
        <PageSkeleton note={stage === 1 ? <SlowLoadNote onRetry={() => void tree.refetch()} /> : undefined} />
      );
  } else if (tree.isError && !cachedTree) {
    content = <LoadError title="Couldn't load the Docs space" message="The server didn't answer in time. Nothing was changed." error={tree.error} path={`/projects/${projectId}/docs/tree`} failedAt={failedAt} onRetry={() => void tree.refetch()} onBack={onBack} backLabel="Back to Board" />;
  } else if (empty) {
    content = <DocsHero projectName={projectName} onCreate={(t) => setNewPage({ parentId: null, template: t })} onImport={onImport} onDropFiles={onDropFiles} />;
  } else if (!selectedId) {
    content = <PageSkeleton />;
  } else if (pageQuery.isLoading && !page) {
    content = (
      <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopProgress />
        {pageLoadingStage === 2 ? (
          <LoadError error={pageQuery.error} path={`/docs/pages/${selectedId}`} failedAt={failedAt} onRetry={() => void pageQuery.refetch()} onBack={goOverview} autoRetry={false} />
        ) : (
          <PageSkeleton title={selNode?.title} crumbs={selNode ? crumbsFor(selNode) : undefined} note={pageLoadingStage === 1 ? <SlowLoadNote onRetry={() => void pageQuery.refetch()} /> : undefined} />
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
        onRestore={() => restore.mutate(selectedId, { onSuccess: () => toast.success('Page restored'), onError: (e) => toast.error("Couldn't restore the page", extractError(e)) })}
        onHome={goOverview}
      />
    );
  } else if (pageError?.code === 'page_not_found') {
    content = <NotFound projectId={projectId} path={selectedId} onOpenPage={select} onHome={goOverview} onSearch={onSearch ? () => onSearch() : undefined} />;
  } else if (!page) {
    content = <LoadError error={pageQuery.error} path={`/docs/pages/${selectedId}`} failedAt={failedAt} onRetry={() => void pageQuery.refetch()} onBack={goOverview} />;
  } else if (editing && !offlineCopy) {
    content = <DocsEditScreen key={page.id} projectId={projectId} page={page} nodes={nodes} onOpenPage={select} onOpenTicket={onOpenTicket} onEditorRoot={onBodyRef} onExit={(updated) => { setEditing(false); if (updated) setSelectedId(updated.id); }} />;
  } else {
    content = (
      <DocsPageView
        key={page.id}
        page={page}
        projectId={projectId}
        projectName={projectName}
        narrow={narrow}
        offline={offlineCopy ? { savedAt: cachedPage!.savedAt, version: cachedPage!.version } : null}
        onTryAgain={() => { void pageQuery.refetch(); void tree.refetch(); }}
        onAction={(a) => void runAction(a, page)}
        onOpenPage={(id, anchor) => {
          select(id);
          if (anchor) setTimeout(() => document.getElementById(`docs-${anchor}`)?.scrollIntoView({ behavior: 'smooth' }), 300);
        }}
        onOpenTicket={onOpenTicket}
        onCompare={(from, to) => setHistory({ compare: { from, to } })}
        onCreatePage={(title) => setNewPage({ parentId: page.id, title })}
        onRestorePage={(id) => restore.mutate(id, { onSuccess: () => toast.success('Page restored') })}
        onReplaceSection={(f, t) => void replaceSection(f, t)}
        onBodyRef={onBodyRef}
      />
    );
  }

  const left =
    leftOverride ??
    (empty ? treeEl : showRail ? (
      <>
        <DocsRail nodes={nodes} selectedId={selectedId} onExpand={showTree} onSearch={() => onSearch?.()} onNewPage={(p) => setNewPage({ parentId: p })} onSelect={select} />
        {narrow && railOpen && (
          <div style={{ position: 'absolute', left: 56, top: 0, bottom: 0, zIndex: 25, boxShadow: '8px 0 24px rgba(30,42,34,0.14)', display: 'flex' }}>{treeEl}</div>
        )}
      </>
    ) : (
      treeEl
    ));

  return (
    <div className="docs-root" data-testid="docs-view" style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative', overflow: 'hidden', background: '#FFFFFF' }}>
      {left}
      {content}

      {dragFiles != null && (
        <div role="presentation" style={{ position: 'absolute', inset: 12, zIndex: 150, borderRadius: 12, border: '2px dashed #2E6F40', background: 'rgba(241,248,243,0.94)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, pointerEvents: 'none' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#DCEEE1', color: '#2E6F40', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="i26" size={22} strokeWidth={1.8} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>Drop to add {dragFiles} file{dragFiles === 1 ? '' : 's'}</div>
        </div>
      )}

      {newPage && (
        <NewPageDialog
          projectId={projectId}
          nodes={nodes}
          initialParentId={newPage.parentId}
          initialTemplate={newPage.template}
          initialTitle={newPage.title}
          onClose={() => setNewPage(null)}
          onCreated={(p) => {
            setNewPage(null);
            setSelectedId(p.id);
            setEditing(true);
            toast.success('Page created', 'It is a draft until you publish it.');
          }}
        />
      )}
      {moveFor && <MoveToDialog projectId={projectId} page={moveFor} nodes={nodes} onClose={() => setMoveFor(null)} onMoved={() => setMoveFor(null)} />}
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
      {history && page && <HistoryDrawer projectId={projectId} page={page} initialCompare={history.compare} onClose={() => setHistory(null)} />}
      {deleteFor && (
        <DeleteDialog
          projectId={projectId}
          page={deleteFor}
          onClose={() => setDeleteFor(null)}
          onDeleted={(count) => {
            const { id, title } = deleteFor;
            setDeleteFor(null);
            toast.success(`Moved “${title}” to the Recycle Bin`, count > 1 ? `${count} pages, kept for 30 days` : 'Kept for 30 days');
            if (selectedId === id) {
              localStorage.removeItem(`docsPage:${projectId}`);
              setSelectedId(null);
              setEditing(false);
            }
          }}
        />
      )}
      {renameFor && (
        <RenameDialog
          projectId={projectId}
          page={renameFor.node}
          newTitle={renameFor.newTitle}
          onClose={() => setRenameFor(null)}
          onRenamed={() => setRenameFor(null)}
        />
      )}
    </div>
  );
}

/** Files from a drop, walking dropped folders and keeping the relative path on `webkitRelativePath`. */
async function collectFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const isMd = (n: string) => /\.(md|markdown)$/i.test(n);
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
  const entries = Array.from(dt.items ?? []).map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length) {
    for (const e of entries) await walk(e, '');
  } else {
    out.push(...Array.from(dt.files).filter((f) => isMd(f.name)));
  }
  return out;
}
