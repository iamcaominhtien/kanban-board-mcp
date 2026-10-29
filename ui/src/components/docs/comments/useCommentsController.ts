import { useCallback, useEffect, useState } from 'react';
import { useCommentActions, useDocsComments } from '../../../api/docsComments';
import type { DocsCommentThread } from '../../../types/docs';
import type { CommentTab } from './CommentsPanel';

/** Scroll the page to the highlight of a thread (view mode badge or editor highlight). */
export function scrollToHighlight(threadId: string) {
  const el =
    document.querySelector(`[data-testid="comment-badge"][data-thread="${threadId}"]`) ??
    document.querySelector(`.dk-cmt-hl[data-thread="${threadId}"]`);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * State shared by the comments button, panel, highlights and page comments of one page.
 * @param pageId - Page being shown.
 * @returns Query result, mutations and the panel state.
 */
export function useCommentsController(pageId: string) {
  const query = useDocsComments(pageId);
  const actions = useCommentActions(pageId);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CommentTab>('open');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reattachId, setReattachId] = useState<string | null>(null);
  const markRead = actions.markRead.mutate;

  const activate = useCallback(
    (id: string) => {
      setActiveId(id);
      setOpen(true);
      const t = query.data?.threads.find((x) => x.id === id);
      if (t?.unread) markRead(id);
      if (t && t.status === 'resolved') setTab((cur) => (cur === 'open' ? 'all' : cur));
      scrollToHighlight(id);
    },
    [query.data, markRead],
  );

  // a copied link (#comment-<id>) opens its thread
  const loaded = !!query.data;
  useEffect(() => {
    const m = /^#comment-(.+)$/.exec(window.location.hash);
    if (m && loaded) {
      setActiveId(m[1]);
      setOpen(true);
      setTab('all');
    }
    // only once the first load finishes
  }, [loaded, pageId]);

  useEffect(() => {
    setActiveId(null);
    setReattachId(null);
  }, [pageId]);

  const created = useCallback((t: DocsCommentThread) => {
    setOpen(true);
    setActiveId(t.id);
    setTab((cur) => (cur === 'resolved' ? 'all' : cur));
  }, []);

  return {
    query,
    actions,
    open,
    setOpen,
    tab,
    setTab,
    activeId,
    setActiveId,
    reattachId,
    setReattachId,
    activate,
    created,
  };
}
