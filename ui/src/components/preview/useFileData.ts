import { useCallback, useEffect, useState } from 'react';

/** Where a read stands. Every failure keeps Download available. */
export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; bytes: Uint8Array; truncated: boolean; total: number | null }
  | { status: 'missing' }
  | { status: 'offline' }
  | { status: 'error'; message: string };

interface Cached {
  bytes: Uint8Array;
  truncated: boolean;
  total: number | null;
}

/** Files opened in this session stay available when the connection drops. */
const cache = new Map<string, Cached>();
const CACHE_LIMIT = 24;

function remember(key: string, value: Cached) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Read the first `maxBytes` of a file. Stops reading once the cap is reached, so a very large file never fills memory.
 * @param url - File URL.
 * @param maxBytes - Most bytes to keep.
 * @param signal - Cancels the read.
 */
export async function readCapped(url: string, maxBytes: number, signal?: AbortSignal): Promise<Cached> {
  const res = await fetch(url, { signal });
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new HttpError(res.status);
  if (!res.ok) throw new HttpError(res.status);
  const lengthHeader = res.headers.get('content-length');
  const declared = lengthHeader ? Number(lengthHeader) : null;
  const total = declared !== null && Number.isFinite(declared) ? declared : null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf.slice(0, maxBytes), truncated: buf.length > maxBytes, total: buf.length };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= maxBytes) {
      truncated = size > maxBytes || (total !== null && total > maxBytes);
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const part = chunk.length + offset > out.length ? chunk.subarray(0, out.length - offset) : chunk;
    out.set(part, offset);
    offset += part.length;
  }
  return { bytes: out, truncated, total: total ?? (truncated ? null : size) };
}

/** A failed request, with the status the server answered. */
export class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * Load a file's bytes (the first `maxBytes`) for a reader.
 * @param url - File URL.
 * @param maxBytes - Most bytes to keep; the rest is reported as `truncated`.
 * @returns The state and a `retry` function.
 */
export function useFileData(url: string, maxBytes: number): [LoadState, () => void] {
  const [state, setState] = useState<LoadState>(() => {
    const hit = cache.get(url);
    return hit ? { status: 'ready', ...hit } : { status: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const hit = cache.get(url);
    if (hit && attempt === 0) {
      setState({ status: 'ready', ...hit });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    readCapped(url, maxBytes, controller.signal)
      .then((data) => {
        remember(url, data);
        setState({ status: 'ready', ...data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof HttpError) {
          setState(
            err.status === 404 || err.status === 403 || err.status === 401
              ? { status: 'missing' }
              : { status: 'error', message: err.message },
          );
        } else if (err instanceof TypeError) {
          setState({ status: 'offline' });
        } else {
          setState({ status: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        }
      });
    return () => controller.abort();
  }, [url, maxBytes, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}

/** Whether the bytes look like text: no NUL bytes in the first 8 KB. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/** Decode UTF-8 text, dropping a byte-order mark. */
export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
