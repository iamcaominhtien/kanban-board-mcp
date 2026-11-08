import { useQuery } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import { client } from './client';
import type { Timeline, TimelineRange } from '../types/aiTeam';

export interface TimelineQuery {
  /** `all`: the whole life of the Story (with `story`). */
  range: TimelineRange | 'all';
  since?: string;
  until?: string;
  ticketId?: string | null;
  /** One team: only its lead and roles (and the teams that wrote to it). */
  teamId?: string | null;
  /** One Story: a row per child ticket, the PM first. */
  story?: string | null;
}

/** The Timeline inside a Story: its rows, and the decisions the PM took (the blue diamonds). */
export type ScopedTimeline = Timeline & {
  rows?: { ticketId: string; title: string; status: string }[];
  decisions?: { at: string; kind: string; title: string; ticketId: string | null }[];
};

/**
 * The client turns every key of a response into camelCase, and `tickets` is keyed by ticket ("AGT-3" came back as
 * "agt3"): key it by the ids again, which the bars, arrows and waits carry as values.
 */
export function withTicketKeys<T extends Timeline>(t: T): T {
  const ids = new Set<string>();
  for (const b of t.bars) ids.add(b.ticketId);
  for (const a of t.arrows) if (a.ticketId) ids.add(a.ticketId);
  for (const w of t.waits) if (w.ticketId) ids.add(w.ticketId);
  for (const x of t.touches) if (x.ticketId) ids.add(x.ticketId);
  for (const x of t.live) if (x.ticketId) ids.add(x.ticketId);
  for (const r of (t as ScopedTimeline).rows ?? []) if (r.ticketId) ids.add(r.ticketId);
  if (t.scope?.ticketId) ids.add(t.scope.ticketId);
  const back = new Map<string, string>();
  for (const id of ids) back.set(Object.keys(camelcaseKeys({ [id]: 0 }))[0], id);
  const tickets: Timeline['tickets'] = {};
  for (const [k, v] of Object.entries(t.tickets ?? {})) tickets[back.get(k) ?? k] = v;
  return { ...t, tickets };
}

/** The AI Team view, Flow › Timeline. Refreshes every few seconds while it follows live and an AI works. */
export function useTimeline(projectId: string, q: TimelineQuery, live = true) {
  return useQuery({
    queryKey: ['ai', 'team', 'timeline', projectId, q] as const,
    queryFn: async () =>
      withTicketKeys(
        (
          await client.get<ScopedTimeline>(`/projects/${projectId}/ai/team/timeline`, {
            params: {
              range: q.range === 'custom' ? 'today' : q.range,
              since: q.since,
              until: q.until,
              ticket_id: q.ticketId ?? undefined,
              team_id: q.teamId ?? undefined,
              story: q.story ?? undefined,
            },
          })
        ).data,
      ),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!live || !d?.following) return SAFETY_POLL_MS;
      return d.live.length ? LIVE_POLL_MS : SAFETY_POLL_MS;
    },
  });
}
