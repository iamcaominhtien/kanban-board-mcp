import { useSyncExternalStore } from 'react';

/** A thread's "choose where to send it" button: open the Send to AI box with that thread ticked. */
export interface SendToAiRequest {
  pageId: string;
  threadIds: string[];
  /** Grows with each request so a repeated one is seen. */
  n: number;
}

let current: SendToAiRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Ask the comments panel of a page to open its Send to AI box with these threads ticked. */
export function requestSendToAi(pageId: string, threadIds: string[]): void {
  current = { pageId, threadIds, n: (current?.n ?? 0) + 1 };
  emit();
}

/** The box took the request. */
export function clearSendToAiRequest(): void {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The pending request for a page, or null. */
export function useSendToAiRequest(pageId: string): SendToAiRequest | null {
  const req = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return req && req.pageId === pageId ? req : null;
}
