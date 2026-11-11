import type { QueryKey } from '@tanstack/react-query';

/**
 * What a server announcement names, and which cached queries depend on it. A run's steps no longer come through
 * here: they are typed SSE events (`ai.step`, `ai.run`) that patch the cache (api/aiRunCache.ts).
 * An announcement with no topic, a topic nobody here knows, or an event of another kind means anything may have
 * changed, and everything is refetched.
 */
const TOPIC_KEYS: Record<string, QueryKey[]> = {
  // The bell, the panel, the page and the feed of toasts (server/services/notifications.py publishes this)
  notifications: [['notifications']],
  // A ticket comment was added, edited, deleted or restored (server/api/tickets.py): the ticket, the lists that show
  // it, its activity, and the Docs pages and ticket links it names
  comments: [['ticket'], ['tickets'], ['wont_do_tickets'], ['project_activities'], ['docs']],
};

/** What an SSE message asks to refetch: topic names, or null for everything. */
export function topicsOf(data: string): string[] | null {
  if (!data || data[0] !== '{') return null;
  try {
    const j = JSON.parse(data) as { type?: unknown; topics?: unknown };
    // who a new comment notified (server/api/tickets.py): it comes right after the comment's own announcement
    if (j.type === 'comment_added') return ['comments'];
    if (j.type !== 'invalidate' || !Array.isArray(j.topics) || j.topics.length === 0) return null;
    return j.topics.filter((t): t is string => typeof t === 'string');
  } catch {
    return null;
  }
}

/** The query keys to refetch for these topics, or null when everything should be (null in, or an unknown topic). */
export function keysFor(topics: ReadonlySet<string> | null): QueryKey[] | null {
  if (!topics) return null;
  const keys: QueryKey[] = [];
  for (const t of topics) {
    const k = TOPIC_KEYS[t];
    if (!k) return null;
    keys.push(...k);
  }
  return keys;
}
