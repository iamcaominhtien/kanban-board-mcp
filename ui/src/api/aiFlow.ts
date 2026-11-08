import { useQuery } from '@tanstack/react-query';
import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import { client } from './client';
import type { FlowMapData, FlowScopes } from '../types/aiFlow';

export interface FlowMapQuery {
  /** `all`: the whole life of the scope. */
  range: 'hour' | 'today' | '24h' | '7d' | 'all';
  ticketId?: string | null;
  teamId?: string | null;
}

/** The Map of the teams, the tickets and the edges between them (the response is lists, no ticket id is a key). */
export function useFlowMap(projectId: string, q: FlowMapQuery) {
  return useQuery({
    queryKey: ['ai', 'team', 'flow', projectId, q] as const,
    queryFn: async () =>
      (
        await client.get<FlowMapData>(`/projects/${projectId}/ai/team/flow`, {
          params: { range: q.range, ticket_id: q.ticketId ?? undefined, team_id: q.teamId ?? undefined },
        })
      ).data,
    enabled: !!projectId,
    // the error state (with its Retry) shows at once, not after react-query's three tries
    retry: false,
    // a new range of the same scope keeps the map on screen (open teams stay open); another scope draws anew
    placeholderData: (prev, prevQuery) => {
      const was = prevQuery?.queryKey[4] as FlowMapQuery | undefined;
      return was && was.ticketId === q.ticketId && was.teamId === q.teamId ? prev : undefined;
    },
    refetchInterval: (query) =>
      query.state.data?.edges.some((e) => e.live) || query.state.data?.tickets.some((t) => t.live)
        ? LIVE_POLL_MS
        : SAFETY_POLL_MS,
  });
}

/** What the scope picker lists: the teams, the Stories and the tickets with AI work. */
export function useFlowScopes(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'team', 'flow-scopes', projectId] as const,
    queryFn: async () => (await client.get<FlowScopes>(`/projects/${projectId}/ai/team/flow/scopes`)).data,
    enabled: !!projectId,
    retry: false,
    refetchInterval: SAFETY_POLL_MS,
  });
}
