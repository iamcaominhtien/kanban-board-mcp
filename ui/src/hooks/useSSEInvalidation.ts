import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveOrigin } from '../api/resolveOrigin';

export function useSSEInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let es: EventSource | undefined;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let mounted = true;

    function handleMessage(_event: MessageEvent<string>) {
      queryClient.invalidateQueries();
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

    return () => {
      mounted = false;
      clearTimeout(retryTimeout);
      if (es) {
        es.close();
        // @ts-expect-error: intentionally nulling to prevent late callbacks
        es = null;
      }
    };
  }, [queryClient]);
}
