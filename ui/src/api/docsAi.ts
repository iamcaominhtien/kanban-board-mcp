import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { client } from './client';

/** Docs AI for a project (Settings › Docs › AI). Off until an admin turns it on. */
export interface DocsAiState {
  enabled: boolean;
  /** The board-wide "Docs AI" feature switch (Settings › AI › Features). */
  master: boolean;
  /** `off` | `no_member` | `ready` */
  state: 'off' | 'no_member' | 'ready';
  memberId: string | null;
  member: { id: string; name: string; provider: string; model: string | null; metered: boolean } | null;
  candidates: { id: string; name: string; provider: string; connection: string; model: string | null }[];
  readScope: 'all' | 'except_hidden' | 'picked';
  pickedPages: string[];
  stylePageId: string | null;
  editsMode: 'proposal' | 'draft';
  proposalDays: number;
  freshnessOn: boolean;
  guidanceLimit: number;
  digestOn: boolean;
  guidancePages: { id: string; title: string }[];
  hiddenPages: { id: string; title: string }[];
}

export type DocsAiSettingsPatch = Partial<
  Pick<
    DocsAiState,
    | 'enabled'
    | 'memberId'
    | 'readScope'
    | 'pickedPages'
    | 'stylePageId'
    | 'editsMode'
    | 'proposalDays'
    | 'freshnessOn'
    | 'guidanceLimit'
    | 'digestOn'
  >
>;

/** One Docs AI call (ask, check, translate, thread reply, ...): the Docs counterpart of an AI run. */
export interface DocsAiJob {
  id: string;
  projectId: string;
  pageId: string | null;
  threadId: string | null;
  memberId: string | null;
  kind: string;
  state: 'queued' | 'running' | 'finished' | 'failed' | 'cancelled';
  startedBy: string;
  instruction: string;
  reads: { pageId: string; title: string; why?: string; cut?: boolean; skipped?: boolean }[];
  steps: { at: string; text: string }[];
  result: Record<string, unknown>;
  error: { code?: string; message?: string };
  tokensIn: number;
  tokensOut: number;
  cost: number;
  metered: boolean;
  replyCommentId: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export const docsAiKeys = {
  state: (projectId: string) => ['docs-ai', 'state', projectId] as const,
  job: (id: string) => ['docs-ai', 'job', id] as const,
  jobs: (projectId: string, key: string) => ['docs-ai', 'jobs', projectId, key] as const,
};

const ACTIVE_JOB = ['queued', 'running'];

/** Docs AI settings and state of a project; every Docs AI entry point reads `state === 'ready'` from here. */
export function useDocsAiState(projectId: string | null | undefined) {
  return useQuery({
    queryKey: docsAiKeys.state(projectId ?? ''),
    queryFn: async () => (await client.get<DocsAiState>(`/projects/${projectId}/docs/ai`)).data,
    enabled: !!projectId,
    staleTime: 15000,
    retry: false,
  });
}

/** Change the Docs AI settings (project admins). */
export function useUpdateDocsAi(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: DocsAiSettingsPatch) =>
      (await client.patch<DocsAiState>(`/projects/${projectId}/docs/ai`, patch)).data,
    onSuccess: (data) => {
      qc.setQueryData(docsAiKeys.state(projectId), data);
      void qc.invalidateQueries({ queryKey: ['docs', 'tree', projectId] });
    },
  });
}

/** Hide a page from AI and/or mark it as guidance every AI run reads. */
export function useSetPageAiFlags(projectId: string, pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { hidden?: boolean; guidance?: boolean }) =>
      (await client.patch<{ id: string; aiHidden: boolean; aiGuidance: boolean }>(`/docs/pages/${pageId}/ai`, patch))
        .data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docsAiKeys.state(projectId) });
      void qc.invalidateQueries({ queryKey: ['docs'] });
    },
  });
}

/** One Docs AI job; polls while it is queued or running. */
export function useDocsAiJob(id: string | null | undefined) {
  return useQuery({
    queryKey: docsAiKeys.job(id ?? ''),
    queryFn: async () => (await client.get<DocsAiJob>(`/docs/ai/jobs/${id}`)).data,
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ACTIVE_JOB.includes(q.state.data.state) ? 500 : false),
  });
}

/** Docs AI jobs of a page or a thread, newest first. */
export function useDocsAiJobs(projectId: string, filter: { pageId?: string; threadId?: string; kind?: string } = {}) {
  const key = JSON.stringify(filter);
  return useQuery({
    queryKey: docsAiKeys.jobs(projectId, key),
    queryFn: async () =>
      (
        await client.get<DocsAiJob[]>(`/projects/${projectId}/docs/ai/jobs`, {
          params: { page_id: filter.pageId, thread_id: filter.threadId, kind: filter.kind },
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.some((j) => ACTIVE_JOB.includes(j.state)) ? 800 : false),
  });
}

/** Stop a running Docs AI call. */
export function useCancelDocsAiJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await client.post<DocsAiJob>(`/docs/ai/jobs/${id}/cancel`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['docs-ai'] }),
  });
}

/** `{detail, code}` of a Docs AI error (the code maps to a state: docs_ai_off, no_member, paused, over_budget...). */
export function docsAiError(e: unknown): { code: string; detail: string } | null {
  if (axios.isAxiosError(e) && e.response?.data && typeof e.response.data === 'object') {
    const d = e.response.data as { code?: string; detail?: unknown };
    if (typeof d.detail === 'string') return { code: d.code ?? 'error', detail: d.detail };
  }
  return null;
}
