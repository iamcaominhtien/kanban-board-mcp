import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';

/** One ticket tied to a page, with the AI run on it now (or the last one). */
export interface PageWorkTicket {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  run: {
    id: string;
    memberId: string;
    member: string;
    mode: string;
    state: string;
    doing: string | null;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
}

export interface PageWork {
  tickets: PageWorkTicket[];
  active: number;
}

export const LIVE_STATES = ['queued', 'starting', 'running', 'needs_input'];

/** The tickets tied to a page and what the AI on each is doing (#268); refreshed while a run is live. */
export function usePageWork(pageId: string | null | undefined) {
  return useQuery({
    queryKey: ['docs', 'work', pageId],
    queryFn: async () => (await client.get<PageWork>(`/docs/pages/${pageId}/work`)).data,
    enabled: !!pageId,
    refetchInterval: (q) => ((q.state.data?.active ?? 0) > 0 ? 5000 : false),
  });
}

/** Give a page to an AI member to write or review: a linked ticket and its run. */
export function useAssignPage(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { memberId: string; kind: 'write' | 'review'; instruction?: string }) =>
      (
        await client.post<{ ticket: { id: string; title: string }; run: { id: string } | null; error?: string }>(
          `/docs/pages/${pageId}/assign`,
          { member_id: body.memberId, kind: body.kind, instruction: body.instruction || null },
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs', 'work', pageId] });
      void qc.invalidateQueries({ queryKey: ['docs', 'backlinks', pageId] });
    },
  });
}
