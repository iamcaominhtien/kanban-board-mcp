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
};

/** What an SSE message asks to refetch: topic names, or null for everything. */
export function topicsOf(data: string): string[] | null {
  if (!data || data[0] !== '{') return null;
  try {
    const j = JSON.parse(data) as { type?: unknown; topics?: unknown };
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
