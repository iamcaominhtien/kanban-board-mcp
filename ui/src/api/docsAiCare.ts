import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { DocsAiJob } from './docsAi';
import type { CareChange, CareReason, DismissLevel, HealthCounts, TicketDraft } from '../utils/careRules';

/** Keeping pages true, Docs health and tickets from a page (docs-ai-care A and C). */

const ACTIVE = ['queued', 'running'];

/** Poll a Docs AI job until it ends; a failed job throws an axios-like error carrying `{code, detail}`. */
export async function waitForJob(id: string, timeoutMs = 180000): Promise<DocsAiJob> {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const job = (await client.get<DocsAiJob>(`/docs/ai/jobs/${id}`)).data;
    if (!ACTIVE.includes(job.state)) {
      if (job.state !== 'finished') {
        throw Object.assign(new Error(job.error.message ?? 'Docs AI could not finish.'), {
          isAxiosError: true,
          response: {
            data: { code: job.error.code ?? 'error', detail: job.error.message ?? 'Docs AI could not finish.' },
          },
        });
      }
      return job;
    }
    if (Date.now() > stop) throw new Error('Docs AI took too long.');
    await new Promise((r) => setTimeout(r, 600));
  }
}

export const careKeys = {
  freshness: (pageId: string) => ['docs-ai', 'freshness', pageId] as const,
  proposals: (pageId: string) => ['docs-ai', 'care-proposals', pageId] as const,
  health: (projectId: string) => ['docs-ai', 'health', projectId] as const,
  healthCount: (projectId: string) => ['docs-ai', 'health-count', projectId] as const,
};

// --- freshness -------------------------------------------------------------------------------------------------

export interface FreshnessCheck {
  pageId: string;
  state: 'unchecked' | 'ok' | 'stale';
  /** The banner shows (stale, not dismissed, not "Still correct"). */
  stale: boolean;
  reasons: CareReason[];
  hidden: number;
  checkedAt: string | null;
  basedOnVersion: number;
  currentVersion: number;
  okUntil: string | null;
}

/** The banner data of a page. Only editors call it (viewers get 403). */
export function useFreshness(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: careKeys.freshness(pageId),
    queryFn: async () => (await client.get<FreshnessCheck>(`/docs/pages/${pageId}/ai/freshness`)).data,
    enabled: enabled && !!pageId,
    staleTime: 30000,
    retry: false,
  });
}

/** Check now (the page AI menu's "Check if up to date"): returns the check. */
export function useCheckFreshness(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const job = (await client.post<DocsAiJob>(`/docs/pages/${pageId}/ai/freshness`)).data;
      return waitForJob(job.id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: careKeys.freshness(pageId) });
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'health'] });
    },
  });
}

/** "Still correct": hides the banner for 30 days. */
export function useStillCorrect(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await client.post<FreshnessCheck>(`/docs/pages/${pageId}/ai/freshness/still-correct`)).data,
    onSuccess: (data) => {
      qc.setQueryData(careKeys.freshness(pageId), data);
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'health'] });
    },
  });
}

/** Dismiss one reason: this time, 30 days or never for this kind of reason. */
export function useDismissReason(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { key: string; level: DismissLevel }) =>
      (await client.post<FreshnessCheck>(`/docs/pages/${pageId}/ai/freshness/dismiss`, v)).data,
    onSuccess: (data) => {
      qc.setQueryData(careKeys.freshness(pageId), data);
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'health'] });
    },
  });
}

/** "Review suggested edits": the AI writes ONE proposal; resolves with its id. */
export function useSuggestEdits(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const job = (await client.post<DocsAiJob>(`/docs/pages/${pageId}/ai/freshness/suggest`)).data;
      const done = await waitForJob(job.id);
      return {
        proposalId: String(done.result.proposalId ?? ''),
        cost: Number(done.result.cost ?? 0),
        metered: done.metered,
      };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: careKeys.proposals(pageId) });
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'proposal-pages'] });
    },
  });
}

export interface CareProposal {
  id: string;
  memberName: string | null;
  status: string;
  summary: string;
  changes: CareChange[];
  changedSince: boolean;
  canDecide: boolean;
  expiresInDays: number | null;
}

/** The proposals of a page (accept / skip / edit go through the proposal endpoints). */
export function useCareProposals(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: careKeys.proposals(pageId),
    queryFn: async () =>
      (await client.get<{ proposals: CareProposal[]; canReview: boolean }>(`/docs/pages/${pageId}/ai/proposals`)).data,
    enabled: enabled && !!pageId,
    retry: false,
  });
}

/** Accept, skip (reject), edit one change, or accept all, then refresh the proposal and the page's draft. */
export function useChangeAction(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: {
      proposalId: string;
      n?: number;
      action: 'accept' | 'reject' | 'edit' | 'acceptAll';
      text?: string;
    }) => {
      const base = `/docs/ai/proposals/${a.proposalId}`;
      if (a.action === 'acceptAll') return (await client.post(`${base}/accept-all`)).data;
      if (a.action === 'edit') return (await client.post(`${base}/changes/${a.n}`, { new: a.text ?? '' })).data;
      return (await client.post(`${base}/changes/${a.n}/${a.action}`)).data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: careKeys.proposals(pageId) });
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'proposal-pages'] });
    },
  });
}

// --- Docs health -----------------------------------------------------------------------------------------------

export interface HealthOutOfDate {
  pageId: string;
  title: string;
  parent: string | null;
  reasons: CareReason[];
  editedAt: string | null;
  checkedAt: string | null;
}
export interface HealthMissing {
  ticketId: string;
  title: string;
  doneAt: string | null;
  note: string;
}
export interface HealthBroken {
  pageId: string;
  title: string;
  ref: string;
  status: 'missing' | 'in_bin' | 'section_missing';
}
export interface HealthOverlap {
  pages: { pageId: string; title: string }[];
  why: string;
}
export interface DocsHealth {
  checkedAt: string | null;
  digest: { on: boolean; schedule: string; lastSent: string | null };
  outOfDate: HealthOutOfDate[];
  missing: HealthMissing[];
  broken: HealthBroken[];
  overlaps: HealthOverlap[];
  counts: HealthCounts;
}

/** The id the server uses for a Docs health row when it is dismissed. */
export function healthItemId(kind: 'out_of_date' | 'missing' | 'broken' | 'overlaps', item: unknown): string {
  if (kind === 'missing') return (item as HealthMissing).ticketId;
  if (kind === 'broken') return `${(item as HealthBroken).pageId}|${(item as HealthBroken).ref}`;
  if (kind === 'overlaps') {
    return (item as HealthOverlap).pages
      .map((p) => p.pageId)
      .sort()
      .join(',');
  }
  return (item as HealthOutOfDate).pageId;
}

/** The Docs health lists of a project. */
export function useDocsHealth(projectId: string, enabled = true) {
  return useQuery({
    queryKey: careKeys.health(projectId),
    queryFn: async () => (await client.get<DocsHealth>(`/projects/${projectId}/docs/ai/health`)).data,
    enabled: enabled && !!projectId,
    retry: false,
  });
}

/** The number beside "Docs health" in the tree: cheap, nothing is recomputed. */
export function useDocsHealthCount(projectId: string, enabled: boolean): number {
  const q = useQuery({
    queryKey: careKeys.healthCount(projectId),
    queryFn: async () =>
      (await client.get<{ count: number }>(`/projects/${projectId}/docs/ai/health/count`)).data.count,
    enabled: enabled && !!projectId,
    staleTime: 60000,
    refetchInterval: 300000,
    retry: false,
  });
  return q.data ?? 0;
}

function refreshHealth(qc: ReturnType<typeof useQueryClient>, projectId: string, data?: DocsHealth) {
  if (data) qc.setQueryData(careKeys.health(projectId), data);
  void qc.invalidateQueries({ queryKey: careKeys.healthCount(projectId) });
}

/** Run now. */
export function useRunHealth(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await client.post<DocsHealth>(`/projects/${projectId}/docs/ai/health/run`)).data,
    onSuccess: (data) => {
      refreshHealth(qc, projectId, data);
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'freshness'] });
    },
  });
}

/** Dismiss one row: this time, 30 days or never. */
export function useDismissHealth(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      kind: 'out_of_date' | 'missing' | 'broken' | 'overlaps';
      id: string;
      level: DismissLevel;
    }) => (await client.post<DocsHealth>(`/projects/${projectId}/docs/ai/health/dismiss`, v)).data,
    onSuccess: (data) => refreshHealth(qc, projectId, data),
  });
}

// --- tickets from a page ---------------------------------------------------------------------------------------

export interface TicketDraftsResult {
  drafts: TicketDraft[];
  skipped: { text: string; reason: 'ticked' | 'has_ticket'; key?: string; note: string }[];
  message: string | null;
  cost: number;
  metered: boolean;
}

/** Draft tickets from the unchecked items of a page or a selection. Creates nothing. */
export function useDraftTickets(pageId: string, selection?: string) {
  // A query, not a mutation started from an effect: React StrictMode runs that effect twice in development, and
  // a mutation's per-call callbacks are dropped when the component re-subscribes. The query is shared by both runs
  // (one job) and only lives while the dialog is open.
  return useQuery({
    queryKey: ['docs-ai', 'ticket-drafts', pageId, selection ?? ''],
    queryFn: async (): Promise<TicketDraftsResult> => {
      const job = (
        await client.post<DocsAiJob>(`/docs/pages/${pageId}/ai/tickets/draft`, { selection: selection ?? null })
      ).data;
      const done = await waitForJob(job.id);
      return { ...(done.result as unknown as Omit<TicketDraftsResult, 'metered'>), metered: done.metered };
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export interface CreatedTickets {
  tickets: {
    id: string;
    title: string;
    projectId: string;
    status: string;
    type: string;
    assignee: string | null;
    dueDate: string | null;
  }[];
  undoToken: string;
  replaced: number;
  notReplaced: string[];
  linked: number;
  draftMarkdown: string | null;
}

/** Create the reviewed drafts. */
export function useCreateTickets(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { drafts: unknown[]; replaceText: boolean; link: boolean }) =>
      (await client.post<CreatedTickets>(`/docs/pages/${pageId}/ai/tickets/create`, body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'health'] });
    },
  });
}

/** Undo a creation: deletes the tickets and restores the draft text if it did not change. */
export function useUndoTickets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (undoToken: string) =>
      (await client.post<{ deleted: number; draftRestored: boolean }>('/docs/ai/tickets/undo', { undoToken })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: ['docs-ai', 'health'] });
    },
  });
}

/** "Add to a page": link a ticket to a page by hand. */
export function useLinkTicketToPage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { ticketId: string; pageId: string }) =>
      (await client.post(`/tickets/${v.ticketId}/docs`, { pageId: v.pageId })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: careKeys.health(projectId) });
    },
  });
}
