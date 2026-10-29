import { resolveOrigin } from '../api/resolveOrigin';

type Listener = (data: string) => void;

// One shared, ref-counted EventSource for features that need the raw SSE messages (the board's
// useSSEInvalidation keeps its own connection and is intentionally untouched).
const listeners = new Set<Listener>();
let es: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect() {
  retry = undefined;
  if (listeners.size === 0) return;
  try {
    es = new EventSource(`${resolveOrigin()}/events`);
  } catch {
    retry = setTimeout(connect, 3000);
    return;
  }
  es.onmessage = (e: MessageEvent<string>) => {
    listeners.forEach((l) => l(e.data));
  };
  es.onerror = () => {
    es?.close();
    es = null;
    retry = setTimeout(connect, 3000);
  };
}

/** Subscribes to the raw `data:` strings of the SSE stream. Returns the unsubscribe function. */
export function subscribeSSE(listener: Listener): () => void {
  listeners.add(listener);
  if (!es && retry === undefined) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(retry);
      retry = undefined;
      es?.close();
      es = null;
    }
  };
}
