import { useCallback, useEffect, useState } from 'react';

/**
 * While you were away (design/screens/ai-story-flow.md, M2): the last time this person had the AI Team open, kept in
 * the browser per person, and the away window shown on Now until they close it. Storage may be missing (a private
 * window, blocked site data): then the card never shows, and nothing breaks.
 */

/** The card shows after this long away. */
export const AWAY_AFTER_MS = 30 * 60 * 1000;
/** How often the time is written while the view is open and visible. */
const BEAT_MS = 60 * 1000;

/** Who is looking: the member the app acts as, or the board's own user (as storyLinks.ts reads it). */
function personKey(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'me';
  } catch {
    return 'me';
  }
}

const seenKey = () => `kanban.aiTeam.lastSeen.${personKey()}`;
const awayKey = () => `kanban.aiTeam.awaySince.${personKey()}`;
const decidedKey = () => `kanban.aiTeam.decidedSeen.${personKey()}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: it lasts until the page reloads */
  }
}

/** The last time this person had the view open (ms), or null the first time. */
export function readLastSeen(): number | null {
  const v = Number(read(seenKey()));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The person is here now. */
export function markSeen(at: number = Date.now()): void {
  write(seenKey(), String(at));
}

/** The away window to show on arrival, if any: one not closed yet, or a new one after 30 minutes away. */
export function awayOnArrival(now: number = Date.now()): string | null {
  const open = read(awayKey());
  if (open) return open;
  const last = readLastSeen();
  if (last == null || now - last < AWAY_AFTER_MS) return null;
  const since = new Date(last).toISOString();
  write(awayKey(), since);
  return since;
}

/** Close the card: it hides until the person is away again. */
export function closeAway(now: number = Date.now()): void {
  write(awayKey(), null);
  markSeen(now);
}

/** Decided for you is marked NEW until the person opens it once. */
export function decidedIsNew(): boolean {
  return read(decidedKey()) !== '1';
}

/** The person opened Decided for you: it is no longer NEW for them. */
export function markDecidedSeen(): void {
  write(decidedKey(), '1');
}

/**
 * The away window of this person, and how to close it. Writes the time every minute while the page is visible, and
 * checks again when the page comes back (a laptop opened in the morning on a tab left open).
 */
export function useAwayWindow(): { since: string | null; close: () => void } {
  const [since, setSince] = useState<string | null>(() => awayOnArrival());
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (visible()) markSeen();
    const beat = window.setInterval(() => {
      if (visible()) markSeen();
    }, BEAT_MS);
    const back = () => {
      if (!visible()) return;
      const next = awayOnArrival();
      if (next) setSince((cur) => cur ?? next);
      markSeen();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      window.clearInterval(beat);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);
  const close = useCallback(() => {
    closeAway();
    setSince(null);
  }, []);
  return { since, close };
}
