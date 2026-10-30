import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCommentActions, useDocsComments } from '../../../api/docsComments';
import type { DocsCommentsResult, DocsCommentThread } from '../../../types/docs';
import { mentionedAi, type DocsMentionIntent } from '../../../utils/docsThreadAiRules';
import type { CommentTab } from './CommentsPanel';
import { askDocsMentionIntent } from './DocsMentionIntent';

/** Raised when the person went back from "What does the mention mean?": the comment box keeps the text. */
export class MentionCancelled extends Error {
  constructor() {
    super('Not posted');
  }
}

/** The meaning of the AI mentions in a comment (asked once per comment), or undefined when it mentions no AI. */
async function intentFor(body: string, data: DocsCommentsResult | undefined): Promise<DocsMentionIntent | undefined> {
  if (!data?.docsAi) return undefined;
  const ais = mentionedAi(body, data.members);
  if (!ais.length) return undefined;
  const chosen = await askDocsMentionIntent(ais.map((a) => a.name));
  if (chosen === null) throw new MentionCancelled();
  return chosen;
}

/** Comment mutations where posting a comment that mentions an AI member first asks what the mention means. */
function useAskingActions(raw: ReturnType<typeof useCommentActions>, data: DocsCommentsResult | undefined) {
  const dataRef = useRef(data);
  dataRef.current = data;
  return useMemo(() => {
    const create = raw.createThread;
    const reply = raw.reply;
    const createAsync: typeof create.mutateAsync = async (v, opts) =>
      create.mutateAsync({ ...v, aiIntent: v.aiIntent ?? (await intentFor(v.body, dataRef.current)) }, opts);
    const replyAsync: typeof reply.mutateAsync = async (v, opts) =>
      reply.mutateAsync({ ...v, aiIntent: v.aiIntent ?? (await intentFor(v.body, dataRef.current)) }, opts);
    return {
      ...raw,
      createThread: { ...create, mutateAsync: createAsync },
      reply: { ...reply, mutateAsync: replyAsync },
    };
  }, [raw]);
}

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
  const actions = useAskingActions(useCommentActions(pageId), query.data);
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
