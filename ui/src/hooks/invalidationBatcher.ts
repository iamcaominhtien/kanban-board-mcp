/**
 * Gathers the server's change announcements into few refetches.
 *
 * A burst (an AI editing the board) is refetched once per burst. While announcements keep coming (a run streaming its
 * steps: about one a second) refetches are spaced at least `busyGapMs` apart (2.5 s), so a busy team does not make the app
 * ask for everything every second. What a refetch covers is the union of the topics gathered; an announcement with no
 * topic means "anything may have changed" and covers everything.
 */

export interface BatcherOptions {
  /** How long a quiet announcement waits to gather its burst. */
  flushMs?: number;
  /** Minimum time between refetches while announcements keep coming. */
  busyGapMs?: number;
  /** This many announcements within `windowMs` make it busy. */
  busyCount?: number;
  windowMs?: number;
}

export interface Batcher {
  /** An announcement arrived: the topics it names, or null for "anything". */
  push: (topics: readonly string[] | null) => void;
  cancel: () => void;
}

/** Create a batcher that calls `onFlush` with the topics to refetch, or null for everything. */
export function createBatcher(
  onFlush: (topics: ReadonlySet<string> | null) => void,
  opts: BatcherOptions = {},
): Batcher {
  const { flushMs = 150, busyGapMs = 2500, busyCount = 3, windowMs = 5000 } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recent: number[] = [];
  let lastFlush = -Infinity;
  let everything = false;
  let topics = new Set<string>();

  return {
    push(next) {
      const now = Date.now();
      recent = recent.filter((t) => now - t < windowMs);
      recent.push(now);
      if (next === null || next.length === 0) everything = true;
      else next.forEach((t) => topics.add(t));
      if (timer) return;
      const busy = recent.length >= busyCount;
      const wait = busy ? Math.max(flushMs, lastFlush + busyGapMs - now) : flushMs;
      timer = setTimeout(() => {
        timer = undefined;
        lastFlush = Date.now();
        const out = everything ? null : topics;
        everything = false;
        topics = new Set();
        onFlush(out);
      }, wait);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      everything = false;
      topics = new Set();
    },
  };
}
