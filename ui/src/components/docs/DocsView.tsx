import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  docsErrorDetail,
  useDeletePage,
  useDocsPage,
  useDocsTree,
  useMovePage,
  useRenamePage,
  useRestorePage,
} from '../../api/docs';
import { client } from '../../api/client';
import { extractError } from '../../api/extractError';
import type { DocsPage, DocsTreeNode } from '../../types/docs';
import { useToast } from '../Toast';
import { DocsEditScreen } from './DocsEditScreen';
import { DocsPageView, type PageAction } from './DocsPageView';
import { DocsTree, type TreeAction } from './DocsTree';
import { DuplicateDialog } from './DuplicateDialog';
import { HistoryDrawer } from './HistoryDrawer';
import { MoveToDialog } from './MoveToDialog';
import { NewPageDialog } from './NewPageDialog';
import styles from './DocsView.module.css';

interface Props {
  projectId: string;
  projectName: string;
  requestedPageId?: string | null;
  onRequestHandled?: () => void;
  onOpenTicket: (ticketId: string) => void;
}

const NARROW_PX = 1200;
const TEMPLATE_CARDS = [
  { id: 'blank', name: 'Blank', text: 'Start from an empty page' },
  { id: 'requirements', name: 'Requirements', text: 'Goals, scope and criteria' },
  { id: 'meeting-notes', name: 'Meeting notes', text: 'Attendees, notes, action items' },
  { id: 'decision-log', name: 'Decision log', text: 'Context, options, outcome' },
  { id: 'technical-design', name: 'Technical design', text: 'Overview, diagram, API, rollout' },
];

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function DocsView({ projectId, projectName, requestedPageId, onRequestHandled, onOpenTicket }: Props) {
  const toast = useToast();
  const tree = useDocsTree(projectId);
  const nodes = useMemo<DocsTreeNode[]>(() => tree.data ?? [], [tree.data]);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(`docsPage:${projectId}`));
  const [editing, setEditing] = useState(false);
  const [newPage, setNewPage] = useState<{ parentId: string | null; template?: string } | null>(null);
  const [moveFor, setMoveFor] = useState<DocsPage | null>(null);
  const [dupFor, setDupFor] = useState<DocsPage | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<{ id: string; title: string } | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  const [railOpen, setRailOpen] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem('docsTreeCollapsed') === '1');

  const rename = useRenamePage(projectId);
  const move = useMovePage(projectId);
  const del = useDeletePage(projectId);
  const restore = useRestorePage(projectId);

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
  const page = pageQuery.data;
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
    url.searchParams.set('docs', id);
    return url.toString();
  }

  async function pageForNode(node: DocsTreeNode): Promise<DocsPage | null> {
    if (page && page.id === node.id) return page;
    try {
      return (await client.get<DocsPage>(`/docs/pages/${node.id}`)).data;
    } catch {
      return null;
    }
  }

  async function runAction(action: TreeAction | PageAction, target: { id: string; title: string }) {
    const node = nodes.find((n) => n.id === target.id);
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
        setDeleteFor(target);
        return;
      case 'history':
        select(target.id);
        setHistoryOpen(true);
        return;
      default:
    }
    const full = node ? await pageForNode(node) : page;
    if (!full) return;
    if (action === 'move') setMoveFor(full);
    else if (action === 'duplicate') setDupFor(full);
    else if (action === 'copy-markdown') await copy(`# ${full.title}\n\n${full.markdown}`, 'Markdown copied');
    else if (action === 'export') download(`${full.slug}.md`, `# ${full.title}\n\n${full.markdown}\n`);
  }

  async function confirmDelete() {
    if (!deleteFor) return;
    const { id, title } = deleteFor;
    try {
      const res = await del.mutateAsync(id);
      setDeleteFor(null);
      toast.success(`Moved “${title}” to the Recycle Bin`, res.deletedPages > 1 ? `${res.deletedPages} pages, kept for 30 days` : 'Kept for 30 days');
      if (selectedId === id) {
        localStorage.removeItem(`docsPage:${projectId}`);
        setSelectedId(null);
        setEditing(false);
      }
    } catch (err) {
      setDeleteFor(null);
      toast.error("Couldn't delete the page", extractError(err));
    }
  }

  function startNewPage(parentId: string | null, template?: string) {
    setNewPage({ parentId, template });
  }

  const error = pageQuery.error ? docsErrorDetail(pageQuery.error) : null;
  const subCount = deleteFor ? nodes.filter((n) => { let c: DocsTreeNode | undefined = n; while (c?.parentId) { if (c.parentId === deleteFor.id) return true; c = nodes.find((x) => x.id === c!.parentId); } return false; }).length : 0;

  const treeEl = (
    <DocsTree
      projectName={projectName}
      nodes={nodes}
      selectedId={selectedId}
      loading={tree.isLoading}
      onSelect={select}
      onNewPage={(parentId) => startNewPage(parentId)}
      onAction={(a, n) => void runAction(a, n)}
      onRename={(n, title) =>
        rename.mutate({ pageId: n.id, title }, { onError: (e) => toast.error("Couldn't rename", extractError(e)) })
      }
      onMove={(id, parentId, beforeId, afterId) =>
        move.mutate({ pageId: id, parentId, beforeId, afterId }, { onError: (e) => toast.error("Couldn't move the page", docsErrorDetail(e)?.message ?? extractError(e)) })
      }
      onCollapse={() => setCollapsed(true)}
    />
  );

  const rail = (
    <aside className={styles.rail} aria-label="Docs space (collapsed)">
      <button type="button" title="Expand page tree" aria-label="Expand page tree" onClick={() => (narrow ? setRailOpen((v) => !v) : setCollapsed(false))}>»</button>
      <button type="button" title="New page" aria-label="New page" onClick={() => startNewPage(null)}>＋</button>
      <div className={styles.railPages}>
        {nodes.filter((n) => !n.parentId).map((n) => (
          <button key={n.id} type="button" title={n.title} aria-label={n.title} className={n.id === selectedId ? styles.railOn : ''} onClick={() => select(n.id)}>
            {nodes.some((c) => c.parentId === n.id) ? '🗀' : '🗎'}
          </button>
        ))}
      </div>
    </aside>
  );

  const empty = tree.isSuccess && nodes.length === 0;

  let content: React.ReactNode;
  if (tree.isError) {
    content = (
      <StateMessage title="Couldn't load the Docs space" text="The server didn't answer. Nothing was changed.">
        <button type="button" className={styles.primary} onClick={() => void tree.refetch()}>Retry</button>
      </StateMessage>
    );
  } else if (empty) {
    content = (
      <div className={styles.hero} data-testid="docs-empty">
        <div className={styles.eyebrow}>Docs space · {projectName}</div>
        <h1>Write down how {projectName} works</h1>
        <p>
          One shared space for requirements, designs and decisions. Link pages to each other with <code>[[Page#Section]]</code> and to tickets like <code>KAN-12</code>, and they stay connected as the project changes.
        </p>
        <div className={styles.heroBtns}>
          <button type="button" className={styles.primary} onClick={() => startNewPage(null, 'blank')} data-testid="create-first-page">Create the first page</button>
        </div>
        <h3>Start from a template</h3>
        <div className={styles.cards}>
          {TEMPLATE_CARDS.map((t) => (
            <button key={t.id} type="button" className={styles.card} onClick={() => startNewPage(null, t.id)} data-testid={`hero-template-${t.id}`}>
              <strong>{t.name}</strong>
              <span>{t.text}</span>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (!selectedId) {
    content = tree.isLoading ? <PageSkeleton /> : <StateMessage title="Pick a page" text="Choose a page in the tree, or create a new one." />;
  } else if (pageQuery.isLoading) {
    content = <PageSkeleton />;
  } else if (error?.code === 'page_deleted') {
    content = (
      <StateMessage title="This page was deleted" text={`${error.deletedBy ?? 'Someone'} moved it to the Recycle Bin. It is kept for 30 days.`}>
        <button type="button" className={styles.primary} onClick={() => restore.mutate(selectedId, { onSuccess: () => toast.success('Page restored') })}>Restore page</button>
      </StateMessage>
    );
  } else if (error?.code === 'page_not_found') {
    content = (
      <StateMessage title="Page not found" text="It may have been renamed, moved or never existed.">
        <button type="button" className={styles.ghost} onClick={() => { setSelectedId(null); localStorage.removeItem(`docsPage:${projectId}`); }}>Back to the first page</button>
      </StateMessage>
    );
  } else if (pageQuery.isError || !page) {
    content = (
      <StateMessage title="Couldn't load this page" text="The server didn't answer in time. Nothing was changed on the page.">
        <button type="button" className={styles.primary} onClick={() => void pageQuery.refetch()}>Retry</button>
      </StateMessage>
    );
  } else if (editing) {
    content = <DocsEditScreen key={page.id} projectId={projectId} page={page} nodes={nodes} onExit={(updated) => { setEditing(false); if (updated) setSelectedId(updated.id); }} />;
  } else {
    content = (
      <DocsPageView
        key={page.id}
        page={page}
        projectName={projectName}
        narrow={narrow}
        onAction={(a) => void runAction(a, page)}
        onOpenPage={(id, anchor) => {
          select(id);
          if (anchor) setTimeout(() => document.getElementById(`docs-${anchor}`)?.scrollIntoView({ behavior: 'smooth' }), 300);
        }}
        onOpenTicket={onOpenTicket}
      />
    );
  }

  return (
    <div className={styles.docs} data-testid="docs-view">
      {empty ? (
        <aside className={styles.emptyTreeWrap}>{treeEl}</aside>
      ) : showRail ? (
        <>
          {rail}
          {narrow && railOpen && <div className={styles.flyout}>{treeEl}</div>}
        </>
      ) : (
        treeEl
      )}
      {content}

      {newPage && (
        <NewPageDialog
          projectId={projectId}
          nodes={nodes}
          initialParentId={newPage.parentId}
          initialTemplate={newPage.template}
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
      {historyOpen && page && <HistoryDrawer projectId={projectId} page={page} onClose={() => setHistoryOpen(false)} />}
      {deleteFor && (
        <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && setDeleteFor(null)}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Delete page">
            <h3>Delete “{deleteFor.title}”?</h3>
            <p>
              {subCount > 0
                ? `The page and its ${subCount} sub-page${subCount > 1 ? 's' : ''} move to the Recycle Bin and can be restored for 30 days.`
                : 'The page moves to the Recycle Bin and can be restored for 30 days.'}{' '}
              Links to it show “In Recycle Bin” until it is restored.
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.ghost} onClick={() => setDeleteFor(null)}>Cancel</button>
              <button type="button" className={styles.danger} onClick={() => void confirmDelete()} data-testid="confirm-delete">Delete page</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StateMessage({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className={styles.state} role="status">
      <h2>{title}</h2>
      <p>{text}</p>
      <div>{children}</div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading page">
      <div style={{ width: '40%', height: 30 }} />
      <div style={{ width: '25%' }} />
      {[90, 82, 95, 70, 88, 60].map((w, i) => (
        <div key={i} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
