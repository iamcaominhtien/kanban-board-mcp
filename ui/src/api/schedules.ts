import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type {
  DryRun,
  Schedule,
  ScheduleCard,
  ScheduleDetail,
  ScheduleDraft,
  ScheduleEvent,
  ScheduleList,
  SchedulePreview,
  ScheduleRun,
  ScheduleWeek,
} from '../types/schedules';

export const scheduleKeys = {
  all: ['schedules'] as const,
  list: (projectId: string, ticketId?: string) => ['schedules', 'list', projectId, ticketId ?? ''] as const,
  history: (projectId: string) => ['schedules', 'history', projectId] as const,
  week: (projectId: string, start: string, days: number) => ['schedules', 'week', projectId, start, days] as const,
  cards: (projectId: string) => ['schedules', 'cards', projectId] as const,
  detail: (id: string) => ['schedules', 'detail', id] as const,
  events: (projectId: string) => ['schedules', 'events', projectId] as const,
};

/** Schedules of a project (or of one ticket) with the tab counts and the next-24 h badge. */
export function useScheduleList(projectId: string, ticketId?: string) {
  return useQuery({
    queryKey: scheduleKeys.list(projectId, ticketId),
    queryFn: async () =>
      (
        await client.get<ScheduleList>(`/projects/${projectId}/ai/schedules`, {
          params: ticketId ? { ticket_id: ticketId } : undefined,
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: 60000,
  });
}

/** Slots of the project, newest first (History tab). */
export function useScheduleHistory(projectId: string, enabled = true) {
  return useQuery({
    queryKey: scheduleKeys.history(projectId),
    queryFn: async () =>
      (await client.get<ScheduleRun[]>(`/projects/${projectId}/ai/schedules/history`, { params: { limit: 100 } })).data,
    enabled: !!projectId && enabled,
  });
}

/** Planned runs per AI from `start` (ISO) for `days` days (Week view, offline risks). */
export function useScheduleWeek(projectId: string, start: string, days = 7, enabled = true) {
  return useQuery({
    queryKey: scheduleKeys.week(projectId, start, days),
    queryFn: async () =>
      (await client.get<ScheduleWeek>(`/projects/${projectId}/ai/schedules/week`, { params: { start, days } })).data,
    enabled: !!projectId && enabled,
    refetchInterval: 60000,
  });
}

/** Card footer state per ticket; one request per project, shared by every card. */
export function useScheduleCards(projectId: string) {
  return useQuery({
    queryKey: scheduleKeys.cards(projectId),
    queryFn: async () => (await client.get<ScheduleCard[]>(`/projects/${projectId}/ai/schedules/cards`)).data,
    enabled: !!projectId,
    refetchInterval: 60000,
    select: (rows) => new Map(rows.map((r) => [r.ticketId, r])),
  });
}

/** One schedule with its stats, problems and run history. */
export function useScheduleDetail(id: string | null) {
  return useQuery({
    queryKey: scheduleKeys.detail(id ?? ''),
    queryFn: async () => (await client.get<ScheduleDetail>(`/ai/schedules/${id}`)).data,
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => ['running', 'reviewing', 'fixing', 'waiting', 'ask'].includes(r.state))
        ? 4000
        : 30000,
  });
}

/** Request body of a draft: empty optional fields become null. */
function body(d: Partial<ScheduleDraft>) {
  const { backupMemberId, windowEnd, runAt, endsOn, ...rest } = d;
  return {
    ...rest,
    ...(backupMemberId !== undefined ? { backupMemberId: backupMemberId || null } : {}),
    ...(windowEnd !== undefined ? { windowEnd: windowEnd || null } : {}),
    ...(runAt !== undefined ? { runAt: runAt || null } : {}),
    ...(endsOn !== undefined ? { endsOn: endsOn || null } : {}),
  };
}

/** Refresh every schedule query and what a run touches (tickets and AI state). */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: scheduleKeys.all });
    void qc.invalidateQueries({ queryKey: ['tickets'] });
    void qc.invalidateQueries({ queryKey: ['ai'] });
  };
}

/** Generic schedule mutation that refreshes the schedule, ticket and AI caches. */
export function useScheduleMutation<TVars, TOut>(fn: (v: TVars) => Promise<TOut>) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidate() });
}

export const scheduleApi = {
  preview: async (projectId: string, draft: Partial<ScheduleDraft>, scheduleId?: string) =>
    (
      await client.post<SchedulePreview>(`/projects/${projectId}/ai/schedules/preview`, {
        ...body(draft),
        scheduleId,
      })
    ).data,
  dryRun: async (projectId: string, draft: Partial<ScheduleDraft>, scheduleId?: string) =>
    (
      await client.post<DryRun>(`/projects/${projectId}/ai/schedules/dry-run`, {
        ...body(draft),
        scheduleId,
      })
    ).data,
  create: async (projectId: string, draft: Partial<ScheduleDraft>) =>
    (await client.post<Schedule>(`/projects/${projectId}/ai/schedules`, body(draft))).data,
  update: async (id: string, draft: Partial<ScheduleDraft>) =>
    (await client.patch<Schedule>(`/ai/schedules/${id}`, body(draft))).data,
  remove: async (id: string) => {
    await client.delete(`/ai/schedules/${id}`);
  },
  pause: async (id: string) => (await client.post<Schedule>(`/ai/schedules/${id}/pause`)).data,
  resume: async (id: string) => (await client.post<Schedule>(`/ai/schedules/${id}/resume`)).data,
  runNow: async (id: string) => (await client.post<ScheduleRun>(`/ai/schedules/${id}/run-now`)).data,
  slotAction: async (runId: string, action: 'start' | 'skip' | 'use_member', memberId?: string) =>
    (await client.post<ScheduleRun>(`/ai/schedule-runs/${runId}/action`, { action, memberId })).data,
  events: async (projectId: string, after: number) =>
    (await client.get<ScheduleEvent[]>(`/projects/${projectId}/ai/schedules/events`, { params: { after } })).data,
};
