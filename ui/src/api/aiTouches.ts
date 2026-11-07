import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { SAFETY_POLL_MS } from './pollIntervals';
import { aiKeys } from './ai';
import type { Lesson } from '../types/aiKnowledge';

/** What a person did: the kinds of the tab "You stepped in" (AI v2). */
export type TouchKind = 'answer' | 'run_by_hand' | 'stop' | 'retry' | 'message' | 'edit' | 'signin' | 'pause';
/** The mark a person gives a touch. */
export type TouchMark = 'needed' | 'avoidable';
export type TouchRange = '24h' | '7d' | '30d' | '90d';

export interface Touch {
  /** Stable key, e.g. `answer:run_ab12`: the mark and the lesson are kept under it. */
  id: string;
  kind: TouchKind;
  label: string;
  at: string;
  who: string;
  /** `mcp` when a tool acted for the person. */
  via: string | null;
  teamIds: string[];
  teamId: string | null;
  teamName: string;
  ticketId: string | null;
  runId: string | null;
  details: string;
  mark: TouchMark | null;
  markedBy: string | null;
  markedAt: string | null;
  lessonId: string | null;
}

export interface TouchTeam {
  id: string;
  name: string;
  removed: boolean;
  touches: number;
  runs: number;
  per10Runs: number | null;
}

export interface SteppedIn {
  range: TouchRange;
  since: string;
  totals: {
    touches: number;
    needed: number;
    avoidable: number;
    unmarked: number;
    tickets: number;
    runs: number;
    perTicket: number | null;
  };
  kinds: { key: TouchKind; label: string; total: number }[];
  allKinds: { key: TouchKind; label: string }[];
  teams: TouchTeam[];
  items: Touch[];
  truncated: boolean;
}

export interface TouchFilters {
  teamId?: string;
  kind?: TouchKind;
  /** needed | avoidable | unmarked */
  mark?: TouchMark | 'unmarked';
}

export const touchKeys = {
  list: (projectId: string, range: TouchRange, f: TouchFilters) =>
    ['ai', 'touches', projectId, range, f.teamId ?? '', f.kind ?? '', f.mark ?? ''] as const,
};

/** The touches of a range (the totals, the rows per kind and team are the range's; the items follow the filters). */
export function useTouches(projectId: string, range: TouchRange = '7d', filters: TouchFilters = {}) {
  return useQuery({
    queryKey: touchKeys.list(projectId, range, filters),
    queryFn: async () =>
      (
        await client.get<SteppedIn>(`/projects/${projectId}/ai/team/touches`, {
          params: { range, team_id: filters.teamId, kind: filters.kind, mark: filters.mark },
        })
      ).data,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** Mark a touch Needed or Avoidable (null takes the mark away) and make a lesson from an avoidable one. */
export function useTouchActions(projectId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: aiKeys.all });
  };
  const mark = useMutation({
    mutationFn: async (v: { key: string; mark: TouchMark | null }) =>
      (await client.put(`/projects/${projectId}/ai/team/touches/mark`, v)).data,
    onSuccess: done,
  });
  const lesson = useMutation({
    mutationFn: async (v: { key: string; text?: string }) =>
      (
        await client.post<{ id: string; lessonId: string; lesson: Lesson }>(
          `/projects/${projectId}/ai/team/touches/lesson`,
          v,
        )
      ).data,
    onSuccess: done,
  });
  return { mark, lesson };
}
