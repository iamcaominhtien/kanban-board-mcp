import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type {
  CommentAnchorInput,
  DocsCommentEvent,
  DocsCommentsResult,
  DocsCommentThread,
  SendToAiResult,
  SendToAiTargets,
} from '../types/docs';
import type { DocsAiJob } from './docsAi';
import { aiBusy, type DocsMentionIntent } from '../utils/docsThreadAiRules';

export const commentKeys = {
  page: (pageId: string) => ['docs', 'comments', pageId] as const,
  events: (projectId: string, recipient: string) => ['docs', 'comment-events', projectId, recipient] as const,
};

/**
 * Query a page's comment threads, counts and your role.
 * @param pageId - Page to load; disabled while null.
 */
export function useDocsComments(pageId: string | null) {
  return useQuery({
    queryKey: commentKeys.page(pageId ?? ''),
    queryFn: async () => (await client.get<DocsCommentsResult>(`/docs/pages/${pageId}/comments`)).data,
    enabled: !!pageId,
    retry: 1,
    // while an AI member answers in a thread, its reply shows up without a reload
    refetchInterval: (q) => (aiBusy(q.state.data?.threads) ? 1500 : false),
  });
}

/**
 * Query comment Activity for a project (who commented, replied, resolved).
 * @param projectId - Project to load.
 * @param recipient - Only events that notify this person.
 */
export function useDocsCommentEvents(projectId: string, recipient = '') {
  return useQuery({
    queryKey: commentKeys.events(projectId, recipient),
    queryFn: async () =>
      (
        await client.get<DocsCommentEvent[]>(`/projects/${projectId}/docs/comment-events`, {
          params: recipient ? { recipient } : undefined,
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: 10_000,
  });
}

/** Mutations for one page's comments; each refreshes the page's list. */
export function useCommentActions(pageId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['docs', 'comments', pageId] });
  const opts = { onSuccess: refresh };
  return {
    createThread: useMutation({
      mutationFn: async (v: {
        kind: 'inline' | 'page';
        body: string;
        anchor?: CommentAnchorInput;
        /** What a mention of an AI member means (Docs AI). */
        aiIntent?: DocsMentionIntent;
      }) => (await client.post<DocsCommentThread>(`/docs/pages/${pageId}/comments`, v)).data,
      ...opts,
    }),
    reply: useMutation({
      mutationFn: async (v: { threadId: string; body: string; aiIntent?: DocsMentionIntent }) =>
        (
          await client.post<DocsCommentThread>(`/docs/comments/threads/${v.threadId}/replies`, {
            body: v.body,
            aiIntent: v.aiIntent,
          })
        ).data,
      ...opts,
    }),
    edit: useMutation({
      mutationFn: async (v: { commentId: string; body: string }) =>
        (await client.patch<DocsCommentThread>(`/docs/comments/${v.commentId}`, { body: v.body })).data,
      ...opts,
    }),
    remove: useMutation({
      mutationFn: async (commentId: string) =>
        (await client.delete<{ deleted: 'comment' | 'thread'; threadId: string }>(`/docs/comments/${commentId}`)).data,
      ...opts,
    }),
    setStatus: useMutation({
      mutationFn: async (v: { threadId: string; status: 'resolved' | 'open' }) =>
        (
          await client.post<DocsCommentThread>(
            `/docs/comments/threads/${v.threadId}/${v.status === 'resolved' ? 'resolve' : 'reopen'}`,
          )
        ).data,
      ...opts,
    }),
    reattach: useMutation({
      mutationFn: async (v: { threadId: string; anchor: CommentAnchorInput }) =>
        (await client.post<DocsCommentThread>(`/docs/comments/threads/${v.threadId}/reattach`, v.anchor)).data,
      ...opts,
    }),
    markRead: useMutation({
      mutationFn: async (threadId: string) =>
        (await client.post<DocsCommentThread>(`/docs/comments/threads/${threadId}/read`)).data,
      ...opts,
    }),
  };
}

/**
 * Ask which open comments would lose their text if this Markdown were published.
 * @param pageId - Page being published.
 * @param markdown - Markdown about to be published.
 */
export async function previewOrphans(
  pageId: string,
  markdown: string,
): Promise<{ count: number; orphaned: { id: string; quote: string }[] }> {
  return (await client.post(`/docs/pages/${pageId}/comments/anchor-preview`, { markdown })).data;
}

/** Docs AI in a thread: "Suggest an edit" on an AI answer, and the summary of a long thread. */
export function useThreadAiActions(pageId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['docs', 'comments', pageId] });
  return {
    suggestEdit: useMutation({
      mutationFn: async (v: { threadId: string; commentId: string }) =>
        (await client.post<DocsAiJob>(`/docs/ai/threads/${v.threadId}/suggest-edit`, { commentId: v.commentId })).data,
      onSuccess: refresh,
    }),
    summarise: useMutation({
      mutationFn: async (threadId: string) =>
        (await client.post<DocsAiJob>(`/docs/ai/threads/${threadId}/summary`)).data,
      onSuccess: refresh,
    }),
  };
}

/**
 * The tickets a page names, with the AI each would send to, and each open thread's default ticket.
 * @param pageId - Page whose comments would be sent.
 * @param enabled - Load only while the picker is open.
 */
export function useSendToAiTargets(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['docs', 'send-to-ai', pageId] as const,
    queryFn: async () => (await client.get<SendToAiTargets>(`/docs/pages/${pageId}/send-to-ai`)).data,
    enabled: enabled && !!pageId,
  });
}

/** Send open threads to the AI of a ticket: a message to the run holding it, else a new work run. */
export function useSendToAi(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { threadIds: string[]; ticketId: string; memberId?: string }) =>
      (await client.post<SendToAiResult>(`/docs/pages/${pageId}/send-to-ai`, v)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs', 'comments', pageId] });
      void qc.invalidateQueries({ queryKey: ['docs', 'send-to-ai', pageId] });
    },
  });
}

/** What a send did, in a sentence. */
export function sentWords(r: SendToAiResult): string {
  const what = `${r.threads} comment${r.threads === 1 ? '' : 's'}`;
  if (r.delivered === 'run' && r.after)
    return `${what} went to ${r.memberName} on ${r.ticketId}: run #${r.runNumber} starts after ${r.after}'s run.`;
  return r.delivered === 'run'
    ? `${r.memberName} is on it: ${what} went to ${r.ticketId} as run #${r.runNumber}.`
    : `${what} went to ${r.memberName}, already working on ${r.ticketId} (run #${r.runNumber}).`;
}
