/**
 * A small queue of Docs writes kept in this browser while it is offline (Docs states D 21-25: "Kept in this browser.
 * They are sent in order when the connection returns."). The page draft has its own queue in the editor; this one is
 * for the other small writes of a page, such as a highlight, that are one request each. A write that cannot reach the
 * server is stored with its method, path and body, and the queue sends the stored writes in order when the browser
 * is back online.
 *
 * Use {@link sendOrQueue} instead of calling `client` directly: it sends at once when it can and queues when there
 * is no connection. {@link useQueuedWrites} follows what waits (for a count in the bar).
 */

import { useSyncExternalStore } from 'react';
import { client } from '../../../api/client';

/** A write the queue can send later: one HTTP request with a JSON body. */
export interface QueuedWrite {
  /** The id of this queued write (made by the queue). */
  id: string;
  method: 'post' | 'put' | 'patch' | 'delete';
  /** The path under the API (`/docs/pages/…/highlights`). */
  path: string;
  /** The JSON body, already in the shape the client sends (camelCase; the client converts it). */
  data?: unknown;
  /** The page the write belongs to, so a page can show what waits for it. */
  pageId?: string;
  /** A short label for the list of changes waiting ("Highlight"). */
  label: string;
  /** When it was queued (ISO time). */
  at: string;
}

/** What {@link sendOrQueue} did: sent (with the server's answer) or queued for later. */
export type SendResult<T> = { sent: true; data: T } | { sent: false; queued: QueuedWrite };

const KEY = 'docsOfflineQueue';
const listeners = new Set<() => void>();
let cache: QueuedWrite[] | null = null;
let flushing: Promise<number> | null = null;

function load(): QueuedWrite[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function store(items: QueuedWrite[]) {
  cache = items;
  try {
    if (items.length) localStorage.setItem(KEY, JSON.stringify(items));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the queue lives as long as this tab */
  }
  listeners.forEach((l) => l());
}

/** True when an error is a request that never reached the server (no answer at all). */
export function isNoConnection(err: unknown): boolean {
  const e = err as { response?: unknown; code?: string; message?: string } | null;
  if (!e || e.response) return false;
  return e.code === 'ERR_NETWORK' || e.message === 'Network Error' || !navigator.onLine;
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Adds a write to the queue.
 * @param write - The request; the queue gives it an id and a time.
 * @returns The queued write.
 */
export function queueWrite(write: Omit<QueuedWrite, 'id' | 'at'>): QueuedWrite {
  const item: QueuedWrite = { ...write, id: newId(), at: new Date().toISOString() };
  store([...load(), item]);
  return item;
}

/**
 * The writes that wait, oldest first.
 * @param pageId - Only those of this page when given.
 */
export function queuedWrites(pageId?: string): QueuedWrite[] {
  const all = load();
  return pageId ? all.filter((w) => w.pageId === pageId) : all;
}

/**
 * Drops a queued write (the person removed it, or it no longer applies).
 * @param id - The queued write's id.
 */
export function dropWrite(id: string): void {
  store(load().filter((w) => w.id !== id));
}

/**
 * Sends a write now, or keeps it for later when there is no connection.
 * @param write - The request.
 * @returns `{ sent: true, data }` with the server's answer, or `{ sent: false, queued }`.
 * @throws What the server answered when it refused the write (a 4xx or 5xx is not queued: sending it again would
 *   get the same answer).
 */
export async function sendOrQueue<T = unknown>(write: Omit<QueuedWrite, 'id' | 'at'>): Promise<SendResult<T>> {
  if (navigator.onLine && load().length === 0) {
    try {
      const r = await client.request<T>({ method: write.method, url: write.path, data: write.data });
      return { sent: true, data: r.data };
    } catch (err) {
      if (!isNoConnection(err)) throw err;
    }
  }
  // offline, or older writes still wait: this one goes after them, so the order is kept
  return { sent: false, queued: queueWrite(write) };
}

/**
 * Sends the queued writes in order. A write the server refuses is dropped (it would be refused again); the queue
 * stops at the first one that finds no connection.
 * @returns How many writes were sent.
 */
export function flushQueue(): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    try {
      for (;;) {
        const [next] = load();
        if (!next) break;
        try {
          await client.request({ method: next.method, url: next.path, data: next.data });
          sent += 1;
        } catch (err) {
          if (isNoConnection(err)) break;
        }
        store(load().filter((w) => w.id !== next.id));
      }
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushQueue());
  // another tab changed the queue
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    cache = null;
    listeners.forEach((l) => l());
  });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The writes waiting in this browser (re-renders when the queue changes).
 * @param pageId - Only those of this page when given.
 */
export function useQueuedWrites(pageId?: string): QueuedWrite[] {
  const all = useSyncExternalStore(subscribe, load, load);
  return pageId ? all.filter((w) => w.pageId === pageId) : all;
}

/** Empties the queue and its cache (tests). */
export function resetQueueForTests(): void {
  cache = null;
  flushing = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing */
  }
}
