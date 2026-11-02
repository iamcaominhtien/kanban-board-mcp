import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import { client } from './client';
import { useDecisions } from './stories';
import type {
  FlowEdge,
  FlowMap,
  Health,
  Journey,
  SteppedFilters,
  SteppedIn,
  TeamNow,
  TeamRange,
  Timeline,
  TimelineRange,
} from '../types/aiTeam';
import type { WorkflowView } from '../types/aiWorkflow';

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

/** The query of the You stepped in tab. The server reads snake_case names (only request bodies are converted on the
 *  way out), so `memberId` must not travel as it is. */
export function steppedParams(range: TeamRange, filters: SteppedFilters) {
  return { range, mark: filters.mark, member_id: filters.memberId, person: filters.person, via: filters.via };
}

/** The AI Team view, You stepped in tab: every touch by a person, marked by rule, needed or avoidable. */
export function useTeamStepped(projectId: string, range: TeamRange, filters: SteppedFilters = {}) {
  return useQuery({
    queryKey: ['ai', 'team', 'stepped', projectId, range, filters] as const,
    queryFn: async () =>
      (
        await client.get<SteppedIn>(`/projects/${projectId}/ai/team/stepped-in`, {
          params: steppedParams(range, filters),
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** The AI Team view, Health tab: five measures, a row per AI and what to fix. */
export function useTeamHealth(projectId: string, range: TeamRange) {
  return useQuery({
    queryKey: ['ai', 'team', 'health', projectId, range] as const,
    queryFn: async () =>
      (await client.get<HealthWithStories>(`/projects/${projectId}/ai/team/health`, { params: { range } })).data,
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

// ---------------------------------------------------------------------------------------------------------------------
// Flow by scope (docs/specs/ai-story-flow-implementation.md, "Flow by scope"): the whole project, one Story, one ticket
// ---------------------------------------------------------------------------------------------------------------------

/** What Flow looks at: the whole project (both null), one Story, or one ticket (with the Story it is in, if any). */
export interface FlowScopeQuery {
  story?: string | null;
  ticket?: string | null;
}

export type FlowScopeLevel = 'project' | 'story' | 'ticket';

/** An arrow of the map, with the PM's plan as one more kind at the Story level. */
export type ScopedEdgeKind = FlowEdge['kind'] | 'plan';

export interface ScopedEdge extends Omit<FlowEdge, 'kind'> {
  kind: ScopedEdgeKind;
}

/** A Story's share of the arrows on the project map (`story_id` null: the tickets that are in no Story). */
export interface FlowCluster {
  storyId: string | null;
  title: string;
  state: StoryState | null;
  done: number;
  total: number;
  tickets: number;
  handoffs: number;
  edges: { from: string; to: string; kind: string; count: number }[];
}

/** The team map narrowed to a scope. Older answers have none of the scope fields, so all of them are optional. */
export type ScopedFlowMap = Omit<FlowMap, 'edges' | 'nodes'> & {
  nodes: (FlowMap['nodes'][number] & {
    tickets?: number;
    ticketIds?: string[];
    liveTicket?: string | null;
    /** The PM that runs the Story: the hub of the Story map. */
    hub?: boolean;
  })[];
  edges: ScopedEdge[];
  scope?: {
    level: FlowScopeLevel;
    story: { id: string; title: string; state: StoryState } | null;
    ticket: { id: string; title: string } | null;
  };
  clusters?: FlowCluster[];
  folded?: { count: number; edges: ScopedEdge[] } | null;
};

/**
 * The server sends a Story-level node's tickets as `tickets: [ticket_id]`, where the project map sends a count under
 * the same name: keep the count in `tickets` and the list in `ticketIds`.
 */
export function withNodeTickets(map: ScopedFlowMap): ScopedFlowMap {
  return {
    ...map,
    nodes: (map.nodes ?? []).map((n) => {
      const raw = (n as { tickets?: unknown }).tickets;
      if (Array.isArray(raw)) return { ...n, tickets: raw.length, ticketIds: raw.map(String) };
      return n;
    }),
  };
}

/** The query of the Flow map: the range only when one was picked (a Story or a ticket opens on its whole life). */
export function flowParams(range: TeamRange | null, scope: FlowScopeQuery = {}) {
  const params: Record<string, string> = {};
  if (range) params.range = range;
  if (scope.ticket) params.ticket = scope.ticket;
  else if (scope.story) params.story = scope.story;
  return params;
}

/** The AI Team view, Flow tab: the team map for a range, narrowed to a Story or a ticket. */
export function useTeamFlow(
  projectId: string,
  range: TeamRange | null,
  scope: FlowScopeQuery = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  const params = flowParams(range, scope);
  return useQuery({
    queryKey: ['ai', 'team', 'flow', projectId, params] as const,
    queryFn: async () =>
      withNodeTickets(
        (await client.get<ScopedFlowMap>(`/projects/${projectId}/ai/team/flow`, { params })).data ?? ({} as never),
      ),
    enabled: enabled && !!projectId,
    // quick while an AI is at work, so the map follows what is happening
    refetchInterval: (q) => (q.state.data?.live?.length ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

/** One ticket's journey, plus the steps of its workflow and the Story it is in. */
export type ScopedJourney = Journey & {
  workflow?: WorkflowView | null;
  story?: { id: string; title: string } | null;
};

/** One ticket from the first assignment to now. */
export function useTicketJourney(projectId: string, ticketId: string | null) {
  return useQuery({
    queryKey: ['ai', 'team', 'journey', projectId, ticketId] as const,
    queryFn: async () => (await client.get<ScopedJourney>(`/projects/${projectId}/ai/team/flow/${ticketId}`)).data,
    enabled: !!projectId && !!ticketId,
    refetchInterval: (q) => (q.state.data?.live?.length ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Stories, as the picker and the clusters read them (GET /projects/{pid}/stories, GET /stories/{id})
// ---------------------------------------------------------------------------------------------------------------------

export type StoryState = 'draft' | 'planning' | 'in_progress' | 'review' | 'done' | 'dropped';

/** The part of a StoryView that Flow reads. */
export interface FlowStory {
  id: string;
  projectId: string;
  title: string;
  state: StoryState;
  blocked: { kind: string; text: string; ticketId: string | null } | null;
  planWaiting: boolean;
  paused: boolean;
  pm: { id: string; name: string; color: string | null } | null;
  plan: {
    version: number;
    items: { order: number; ticketId: string; title: string; status: string; after: string[] }[];
  } | null;
  progress: { done: number; total: number; building: number; waiting: number };
  interventions: { count: number; needed: number; avoidable: number; byRule: number };
  handedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
}

export interface FlowDecision {
  id: string;
  at: string;
  kind: string;
  title: string;
  ticketId: string | null;
  state: 'in_effect' | 'overridden';
}

export type FlowStoryDetail = FlowStory & { decisions?: FlowDecision[]; children?: string[] };

/** The project's Stories (the picker and the clusters). */
export function useFlowStories(projectId: string) {
  return useQuery({
    queryKey: ['stories', 'flow', projectId] as const,
    queryFn: async () => (await client.get<FlowStory[]>(`/projects/${projectId}/stories`)).data ?? [],
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
    // a server without Stories yet answers 404: the picker then lists tickets only
    retry: false,
  });
}

/** One Story with the decisions its PM took (the PM decided tile, the diamonds). */
export function useFlowStory(storyId: string | null) {
  return useQuery({
    queryKey: ['stories', 'flow-one', storyId] as const,
    queryFn: async () => (await client.get<FlowStoryDetail>(`/stories/${storyId}`)).data,
    enabled: !!storyId,
    refetchInterval: SAFETY_POLL_MS,
    retry: false,
  });
}

export interface TimelineQuery {
  /** `all`: the whole life of the Story (with `story`). */
  range: TimelineRange | 'all';
  since?: string;
  until?: string;
  ticketId?: string | null;
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

// ---------------------------------------------------------------------------------------------------------------------
// Decided for you, While you were away, Autonomy by Story and the token cap on Now (design/screens/ai-story-flow.md
// M1, M2, R3 and O; docs/specs/ai-story-flow-implementation.md)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The start of a range as a time, for the endpoints that take `since`: today from midnight, else 7 or 30 days back.
 * Cut to the minute, so the tab and its count in the header ask the same question.
 */
export function rangeSince(range: TeamRange, now: Date = new Date()): string {
  const d = new Date(now);
  if (range === 'today') d.setHours(0, 0, 0, 0);
  else {
    d.setDate(d.getDate() - (range === '30d' ? 30 : 7));
    d.setSeconds(0, 0);
  }
  return d.toISOString();
}

/** Every decision the PM took in the range (the tiles, the Story picker and the count on the tab). */
export function useDecidedForYou(projectId: string, range: TeamRange) {
  return useDecisions(projectId, { since: rangeSince(range), limit: 500 });
}

/** A Story's Done count at a time (null: it did not exist yet). */
export interface AwayProgress {
  state: StoryState | null;
  done: number;
  total: number;
}

/** GET /projects/{pid}/ai/away?since=: what the team did while the person was away (M2). */
export interface TeamAway {
  since: string;
  until: string;
  /** False: nothing ran, nothing was decided and nobody was needed. */
  ran: boolean;
  pausedAll: boolean;
  stories: { id: string; title: string; from: AwayProgress | null; to: AwayProgress | null; runs: number }[];
  finished: {
    ticketId: string;
    title: string;
    storyId: string | null;
    at: string | null;
    memberId: string | null;
    sentBack: number;
  }[];
  needed: {
    at: string;
    kind: 'question' | 'approval' | 'step' | 'plan' | string;
    ticketId: string | null;
    memberId: string | null;
    text: string;
    open: boolean;
    storyId: string | null;
  }[];
  decided: { count: number; overridable: number };
  spent: {
    usd: number;
    tokens: number;
    byStory: { storyId: string | null; title: string; usd: number; tokens: number }[];
    dailyCap: number | null;
  };
  failed: {
    runId: string;
    ticketId: string;
    memberId: string | null;
    at: string | null;
    text: string;
    retried: boolean;
    retryState: string | null;
  }[];
  /** What waits for a person now (the rows of Needs you). */
  waiting: number;
}

/** While you were away, from a time (null: the person was not away). */
export function useTeamAway(projectId: string, since: string | null) {
  return useQuery({
    queryKey: ['ai', 'team', 'away', projectId, since] as const,
    queryFn: async () => (await client.get<TeamAway>(`/projects/${projectId}/ai/away`, { params: { since } })).data,
    enabled: !!projectId && !!since,
    refetchInterval: SAFETY_POLL_MS,
    retry: false,
  });
}

/** One Story in Autonomy by Story (the Health answer's `stories`, R3). */
export interface HealthStory {
  id: string;
  title: string;
  state: StoryState | null;
  ticketsDone: number;
  ticketsTotal: number;
  touches: { needed: number; avoidable: number; byRule: number };
  /** "Needed: You answered … on KAN-289. Why", oldest first, at most 10. */
  reasons: string[];
}

/** The Health answer with Autonomy by Story (older servers send no `stories`). */
export type HealthWithStories = Health & { stories?: HealthStory[] };

/**
 * A ticket whose workflow stopped at its token cap, as an AI's card on Now shows it (O, "Stopped at cap").
 * Not in the team Now answer yet: the card shows it once the server sends `cap_stop` on the member.
 */
export interface CapStop {
  ticketId: string;
  ticketTitle: string | null;
  used: number;
  cap: number;
  step: { n: number; total: number | null; label: string | null } | null;
  stoppedAt: string | null;
  runId: string | null;
  /** The ticket that waits for this one ("Next in line: KAN-306 (waits for KAN-305)"). */
  next: { ticketId: string; waitsFor: string } | null;
}

/** The Needs you row of a ticket stopped at its token cap (O). Not in the team Now answer yet. */
export interface CapNeed {
  kind: 'quota_cap';
  since: string | null;
  waitingS: number | null;
  memberId: string;
  memberName: string | null;
  ticketId: string;
  ticketTitle?: string | null;
  text?: string | null;
  used?: number | null;
  cap?: number | null;
  /** The tickets that wait for this one. */
  waitedBy?: string[];
  storyId?: string | null;
}
