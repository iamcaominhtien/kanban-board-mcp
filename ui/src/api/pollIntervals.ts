/**
 * How often a query asks again on its own. The server announces every change over SSE and the app refetches then, so
 * these polls are only a safety net for a missed announcement and for things that change with the clock. While a run
 * is going the net is tighter.
 */

/** While an AI is working. */
export const LIVE_POLL_MS = 10_000;

/** When nothing is going on. */
export const SAFETY_POLL_MS = 30_000;
