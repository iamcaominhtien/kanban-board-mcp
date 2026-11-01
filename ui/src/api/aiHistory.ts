import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';
import type { AiRun } from '../types/ai';
import type {
  HistoryFilters,
  HistoryPage,
  SkillUsage,
  TranscriptInfo,
  TranscriptResponse,
  TranscriptUsage,
} from '../types/aiHistory';

export const PAGE_SIZE = 25;

export const DEFAULT_FILTERS: HistoryFilters = { view: 'all', memberId: '', ticketId: '', skill: '', days: 30, q: '' };

/** The states a view of the list stands for. */
export const VIEW_STATES: Record<HistoryFilters['view'], string | undefined> = {
  all: undefined,
  failed: 'failed,timed_out',
  needs: 'needs_input',
  pinned: undefined,
};

/** The start of "last N days" as an ISO time (the server reads snake_case names, so the query is built by hand). */
export function sinceOf(days: number, now: number = Date.now()): string | undefined {
  return days > 0 ? new Date(now - days * 86400000).toISOString() : undefined;
}

/**
 * The query string values of a filter set. Empty filters are left out.
 * @param projectId - Project of the list.
 * @param f - The filters.
 * @param page - Zero-based page.
 * @param now - The clock, for tests.
 */
export function historyParams(
  projectId: string,
  f: HistoryFilters,
  page = 0,
  now: number = Date.now(),
): Record<string, string | number | boolean> {
  const p: Record<string, string | number | boolean> = {
    project_id: projectId,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  if (f.memberId) p.member_id = f.memberId;
  if (f.ticketId.trim()) p.ticket_id = f.ticketId.trim();
  const state = VIEW_STATES[f.view];
  if (state) p.state = state;
  if (f.view === 'pinned') p.pinned = true;
  if (f.skill) p.skill = f.skill;
  const since = sinceOf(f.days, now);
  if (since) p.since = since;
  if (f.q.trim()) p.q = f.q.trim();
  return p;
}

export const historyKeys = {
  list: (params: Record<string, unknown>) => ['ai', 'history', 'list', params] as const,
  transcript: (runId: string) => ['ai', 'history', 'transcript', runId] as const,
  usage: ['ai', 'history', 'usage'] as const,
};

/** One page of the run history (best match first when there is a search text). */
export function useHistory(projectId: string, f: HistoryFilters, page: number) {
  const params = historyParams(projectId, f, page);
  return useQuery({
    queryKey: historyKeys.list(params),
    queryFn: async () => (await client.get<HistoryPage>('/ai/history', { params })).data,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
  });
}

/** The counts the filter chips show: the total of each view under the other filters. */
export function useHistoryCounts(projectId: string, f: HistoryFilters) {
  const views: HistoryFilters['view'][] = ['all', 'failed', 'needs', 'pinned'];
  const results = useQueries({
    queries: views.map((view) => {
      const params = { ...historyParams(projectId, { ...f, view }, 0), limit: 1 };
      return {
        queryKey: historyKeys.list(params),
        queryFn: async () => (await client.get<HistoryPage>('/ai/history', { params })).data.total,
        enabled: !!projectId,
        placeholderData: keepPreviousData,
      };
    }),
  });
  return Object.fromEntries(views.map((v, i) => [v, results[i].data])) as Record<
    HistoryFilters['view'],
    number | undefined
  >;
}

/** How many runs the other filters hold without the search text: the "1,104 runs" of "1,104 runs · 17 match". */
export function useHistoryTotal(projectId: string, f: HistoryFilters, enabled: boolean) {
  const params = { ...historyParams(projectId, { ...f, q: '' }, 0), limit: 1 };
  return useQuery({
    queryKey: historyKeys.list(params),
    queryFn: async () => (await client.get<HistoryPage>('/ai/history', { params })).data.total,
    enabled: !!projectId && enabled,
    placeholderData: keepPreviousData,
  });
}

/** What the board kept of one run. */
export function useTranscript(runId: string | null) {
  return useQuery({
    queryKey: historyKeys.transcript(runId ?? ''),
    queryFn: async () => (await client.get<TranscriptResponse>(`/ai/runs/${runId}/transcript`)).data,
    enabled: !!runId,
  });
}

/** The run itself (files, report, tokens), from the board's record. */
export function useRunRecord(runId: string | null) {
  return useQuery({
    queryKey: ['ai', 'history', 'run', runId ?? ''] as const,
    queryFn: async () => (await client.get<AiRun>(`/ai/runs/${runId}`)).data,
    enabled: !!runId,
  });
}

/** Pin or unpin a run's transcript; rejects with a 409 when there is no transcript to pin. */
export function usePinRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { runId: string; on: boolean }) =>
      (await client.post<TranscriptInfo>(`/ai/runs/${v.runId}/pin`, { on: v.on })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai', 'history'] }),
  });
}

/** Space the transcripts use. */
export function useTranscriptUsage() {
  return useQuery({
    queryKey: historyKeys.usage,
    queryFn: async () => (await client.get<TranscriptUsage>('/ai/transcripts/usage')).data,
    staleTime: 30000,
  });
}

/** Skills and subagents the project's runs used (the "Any skill" filter). */
export function useSkillUsage(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'history', 'skills', projectId] as const,
    queryFn: async () =>
      (await client.get<SkillUsage[]>('/ai/skills/usage', { params: { project_id: projectId } })).data,
    enabled: !!projectId,
    staleTime: 60000,
  });
}

/** The link that downloads one run as Markdown or JSON. */
export function exportRunUrl(runId: string, format: 'md' | 'json'): string {
  return `${resolveOrigin()}/ai/runs/${encodeURIComponent(runId)}/export?format=${format}`;
}
