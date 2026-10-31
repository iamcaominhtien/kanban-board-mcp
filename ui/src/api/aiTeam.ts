import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { FlowMap, Health, Journey, SteppedFilters, SteppedIn, TeamNow, TeamRange } from '../types/aiTeam';

export const teamKeys = {
  now: (projectId: string, range: TeamRange) => ['ai', 'team', 'now', projectId, range] as const,
};

/** The AI Team view, Now tab. Refreshes on board events, and every few seconds while an AI works. */
export function useTeamNow(projectId: string, range: TeamRange = 'today') {
  return useQuery({
    queryKey: teamKeys.now(projectId, range),
    queryFn: async () => (await client.get<TeamNow>(`/projects/${projectId}/ai/team/now`, { params: { range } })).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.totals.running ? 3000 : 15000),
  });
}

/** The AI Team view, You stepped in tab: every touch by a person, marked by rule, needed or avoidable. */
export function useTeamStepped(projectId: string, range: TeamRange, filters: SteppedFilters = {}) {
  return useQuery({
    queryKey: ['ai', 'team', 'stepped', projectId, range, filters] as const,
    queryFn: async () =>
      (
        await client.get<SteppedIn>(`/projects/${projectId}/ai/team/stepped-in`, {
          params: { range, ...filters },
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

/** The AI Team view, Health tab: five measures, a row per AI and what to fix. */
export function useTeamHealth(projectId: string, range: TeamRange) {
  return useQuery({
    queryKey: ['ai', 'team', 'health', projectId, range] as const,
    queryFn: async () =>
      (await client.get<Health>(`/projects/${projectId}/ai/team/health`, { params: { range } })).data,
    enabled: !!projectId,
    refetchInterval: 30000,
  });
}

/** Hide a "What to fix" suggestion; nothing about the AI team is changed. */
export function useDismissSuggestion(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) =>
      (await client.post(`/projects/${projectId}/ai/team/health/dismiss`, { key })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai', 'team', 'health'] }),
  });
}

/** The AI Team view, Flow tab: the team map for a range. */
export function useTeamFlow(projectId: string, range: TeamRange) {
  return useQuery({
    queryKey: ['ai', 'team', 'flow', projectId, range] as const,
    queryFn: async () => (await client.get<FlowMap>(`/projects/${projectId}/ai/team/flow`, { params: { range } })).data,
    enabled: !!projectId,
    // quick while an AI is at work, so the map follows what is happening
    refetchInterval: (q) => (q.state.data?.live?.length ? 4000 : 20000),
  });
}

/** One ticket from the first assignment to now. */
export function useTicketJourney(projectId: string, ticketId: string | null) {
  return useQuery({
    queryKey: ['ai', 'team', 'journey', projectId, ticketId] as const,
    queryFn: async () => (await client.get<Journey>(`/projects/${projectId}/ai/team/flow/${ticketId}`)).data,
    enabled: !!projectId && !!ticketId,
    refetchInterval: (q) => (q.state.data?.live?.length ? 3000 : 10000),
  });
}
