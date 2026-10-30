import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { docsAiError, useDocsAiState } from './docsAi';

/** One change of a proposal: the exact text it replaces on the page and the text it puts there. */
export interface ProposalChange {
  n: number;
  kind: 'text' | 'title';
  title: string;
  reason: string;
  section: string | null;
  old: string;
  new: string;
  status: 'pending' | 'accepted' | 'rejected';
  /** The page no longer has `old`: "Needs a new look", it cannot be accepted. */
  stale: boolean;
  note?: string;
  decidedBy?: string;
  editedBy?: string;
}

/** Changes an AI member proposes for a page (docs-ai-care B). Accepting puts text into your draft. */
export interface DocsAiProposal {
  id: string;
  projectId: string;
  pageId: string;
  memberId: string;
  memberName: string | null;
  memberProvider: string | null;
  runId: string | null;
  jobId: string | null;
  ticketId: string | null;
  approvalId: string | null;
  onBehalfOf: string | null;
  baseVersion: number;
  status: 'waiting' | 'accepted' | 'partial' | 'rejected' | 'expired';
  summary: string;
  changes: ProposalChange[];
  createdAt: string;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  pageTitle: string;
  pageVersion: number;
  changedSince: boolean;
  stillApply: number;
  pending: number;
  expiresInDays: number | null;
  canDecide: boolean;
}

export const proposalKeys = {
  pages: (projectId: string) => ['docs-ai', 'proposal-pages', projectId] as const,
  page: (pageId: string) => ['docs-ai', 'proposals', pageId] as const,
};

/** Pages with a proposal from an AI member waiting for review (a purple dot in the tree). */
export function useWaitingProposalPages(projectId: string): Set<string> {
  const state = useDocsAiState(projectId);
  const q = useQuery({
    queryKey: proposalKeys.pages(projectId),
    queryFn: async () => {
      try {
        return (await client.get<string[]>(`/projects/${projectId}/docs/ai/proposals/pages`)).data;
      } catch (e) {
        if (docsAiError(e)) return [];
        throw e;
      }
    },
    enabled: !!projectId && state.data?.state === 'ready',
    refetchInterval: 30_000,
  });
  return new Set(q.data ?? []);
}

/** Waiting and recent proposals of a page (empty for people who cannot edit it). */
export function usePageProposals(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: proposalKeys.page(pageId),
    queryFn: async () =>
      (await client.get<{ proposals: DocsAiProposal[]; canReview: boolean }>(`/docs/pages/${pageId}/ai/proposals`))
        .data,
    enabled: !!pageId && enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Accept, reject and edit the changes of a proposal. Each refreshes the page, its draft and the tree dot. */
export function useProposalActions(pageId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: proposalKeys.page(pageId) });
    void qc.invalidateQueries({ queryKey: ['docs-ai', 'proposal-pages'] });
    void qc.invalidateQueries({ queryKey: ['docs'] });
  };
  const post = async (url: string, body?: object) => (await client.post<DocsAiProposal>(url, body ?? {})).data;
  return {
    accept: useMutation({
      mutationFn: (v: { id: string; n: number }) => post(`/docs/ai/proposals/${v.id}/changes/${v.n}/accept`),
      onSuccess: done,
    }),
    reject: useMutation({
      mutationFn: (v: { id: string; n: number; note?: string }) =>
        post(`/docs/ai/proposals/${v.id}/changes/${v.n}/reject`, { note: v.note }),
      onSuccess: done,
    }),
    edit: useMutation({
      mutationFn: (v: { id: string; n: number; text: string }) =>
        post(`/docs/ai/proposals/${v.id}/changes/${v.n}`, { new: v.text }),
      onSuccess: done,
    }),
    acceptAll: useMutation({
      mutationFn: (v: { id: string }) => post(`/docs/ai/proposals/${v.id}/accept-all`),
      onSuccess: done,
    }),
    rejectAll: useMutation({
      mutationFn: (v: { id: string; note?: string }) => post(`/docs/ai/proposals/${v.id}/reject-all`, { note: v.note }),
      onSuccess: done,
    }),
  };
}
