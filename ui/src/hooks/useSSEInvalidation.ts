import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveOrigin } from '../api/resolveOrigin';

/** How long events are gathered into one refetch. */
const FLUSH_MS = 150;

/** Subscribe to server events and invalidate React Query caches, reconnecting on failure. */
export function useSSEInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let es: EventSource | undefined;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let mounted = true;
    let flush: ReturnType<typeof setTimeout> | undefined;

    // An AI editing the board fires a burst of events; refetch once per burst, not once per event.
    function handleMessage(_event: MessageEvent<string>) {
      if (flush) return;
      flush = setTimeout(() => {
        flush = undefined;
        queryClient.invalidateQueries();
      }, FLUSH_MS);
    }

    // A tab that slept (laptop lid, background throttling) may hold a dead stream and miss changes.
    function handleVisible() {
      if (document.visibilityState !== 'visible' || !mounted) return;
      if (!es || es.readyState === EventSource.CLOSED) {
        clearTimeout(retryTimeout);
        connect();
      } else {
        queryClient.invalidateQueries();
      }
    }

    function connect() {
      if (!mounted) return;
      // Re-resolve on every attempt (not just once) - in Electron the real
      // port is only known after the backend-ready IPC event fires, which
      // can happen after this effect first runs. Re-resolving on each retry
      // means a stale/wrong origin self-corrects instead of looping forever.
      const origin = resolveOrigin();
      es = new EventSource(`${origin}/events`);
      queryClient.invalidateQueries();

      es.onmessage = handleMessage;

      es.onerror = () => {
        if (es) es.close();
        retryTimeout = setTimeout(connect, 3000);
      };
    }

    connect();
    document.addEventListener('visibilitychange', handleVisible);

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisible);
      clearTimeout(retryTimeout);
      clearTimeout(flush);
      if (es) {
        es.close();
        // @ts-expect-error: intentionally nulling to prevent late callbacks
        es = null;
      }
    };
  }, [queryClient]);
}
