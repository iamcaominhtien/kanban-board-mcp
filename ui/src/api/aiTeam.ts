import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import type { TeamNow, TeamRange } from '../types/aiTeam';

export const teamKeys = {
  now: (projectId: string, range: TeamRange) => ['ai', 'team', 'now', projectId, range] as const,
};

/** The AI Team view, Now tab. Refreshes on board events, and every few seconds while an AI works. */
export function useTeamNow(projectId: string, range: TeamRange = 'today') {
  return useQuery({
    queryKey: teamKeys.now(projectId, range),
    queryFn: async () => (await client.get<TeamNow>(`/projects/${projectId}/ai/team/now`, { params: { range } })).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.totals.running ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}
