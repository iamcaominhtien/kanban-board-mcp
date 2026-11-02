import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NeedsItem } from '../types/aiTeam';
import { client } from './client';

/** One line of AI Team › Flow › Live commentary (server/services/ai/live_feed.py). */
export interface LiveFeedItem {
  id: string;
  /** Full ISO time of what happened. */
  at: string;
  /** null for the board's own lines ("Board"). */
  memberId: string | null;
  memberName: string;
  glyph: string | null;
  color: string | null;
  /** The member's role pack key (dev, reviewer, …), and its name. */
  role: string | null;
  roleLabel: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  kind: string;
  text: string;
  tone: 'info' | 'good' | 'warn' | 'bad';
  /** A command's result points at the command's line (the feed shows them as one line). */
  ref: string | null;
  /** Kept by Highlights: a step finished, work sent back, a PM decision, a pull request, anything that needs you.
   * Missing on an older server: every line then counts as one. */
  highlight?: boolean;
  /** The Story the line's ticket is in. */
  storyId?: string | null;
  /** The run the line came from, when the server says it. */
  runId?: string | null;
}

interface FeedPage {
  items: LiveFeedItem[];
  cursor: string;
  working: string[];
  more?: boolean;
  needsYou?: NeedsItem[];
}

export interface LiveFeed {
  items: LiveFeedItem[];
  cursor: string | null;
  /** The AIs that have a run going right now. */
  working: string[];
  /** The Now tab's Needs you rows, in the scope (the whole list on every answer). */
  needsYou: NeedsItem[];
}

/** What the feed follows: the Flow tab's scope bar (both null: the whole project). */
export interface FeedScope {
  story?: string | null;
  ticket?: string | null;
}

export const LIVE_FEED_POLL_MS = 2_000;
export const LIVE_FEED_KEEP = 500;

/** The query key of a project's live feed in a scope (its cached answer holds the cursor of that scope). */
export const liveFeedKey = (projectId: string, scope: FeedScope = {}) =>
  [
    'ai',
    'live-feed',
    projectId,
    scope.ticket ? `t:${scope.ticket}` : scope.story ? `s:${scope.story}` : 'all',
  ] as const;

/** New lines merged into the ones already held: once each, in time order, the newest `keep`. */
export function mergeFeed(prev: LiveFeedItem[], fresh: LiveFeedItem[], keep = LIVE_FEED_KEEP): LiveFeedItem[] {
  if (!fresh.length) return prev;
  const seen = new Set(prev.map((i) => i.id));
  const add = fresh.filter((i) => !seen.has(i.id));
  if (!add.length) return prev;
  const all = [...prev, ...add];
  // a line committed a moment late can be older than the newest one held: keep the order stable by time
  if (prev.length && add.some((i) => i.at < prev[prev.length - 1].at)) {
    all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  return all.length > keep ? all.slice(all.length - keep) : all;
}

/**
 * The live feed: asks every 2 s for the lines after the cursor it holds and keeps the last 500. Each answer carries
 * only what is new, so a poll is cheap.
 */
export function useLiveFeed(
  projectId: string,
  { enabled = true, scope = {} }: { enabled?: boolean; scope?: FeedScope } = {},
) {
  const qc = useQueryClient();
  const key = liveFeedKey(projectId, scope);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<LiveFeed> => {
      const prev = qc.getQueryData<LiveFeed>(key);
      const params: Record<string, string | number> = { limit: 200 };
      if (prev?.cursor) params.after = prev.cursor;
      if (scope.ticket) params.ticket = scope.ticket;
      else if (scope.story) params.story = scope.story;
      const page = (await client.get<FeedPage>(`/projects/${projectId}/ai/live-feed`, { params })).data;
      return {
        items: mergeFeed(prev?.items ?? [], page.items ?? []),
        cursor: page.cursor ?? prev?.cursor ?? null,
        working: page.working ?? [],
        needsYou: page.needsYou ?? prev?.needsYou ?? [],
      };
    },
    enabled: enabled && !!projectId,
    refetchInterval: enabled ? LIVE_FEED_POLL_MS : false,
    refetchIntervalInBackground: false,
    // the cursor lives in the cached answer: never throw it away while the panel is open
    staleTime: 0,
    gcTime: 10 * 60_000,
  });
}
