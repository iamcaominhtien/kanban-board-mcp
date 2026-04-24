import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resolveOrigin } from '../api/resolveOrigin';

export function useSSEInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let es: EventSource | undefined;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let mounted = true;

    async function init() {
      const origin = await resolveOrigin();
      if (!mounted) return;

      function handleMessage(_event: MessageEvent<string>) {
        queryClient.invalidateQueries();
      }

      function connect() {
        if (!mounted) return;
        es = new EventSource(`${origin}/events`);
        queryClient.invalidateQueries();

        es.onmessage = handleMessage;

        es.onerror = () => {
          if (es) es.close();
          retryTimeout = setTimeout(connect, 3000);
        };
      }

      connect();
    }

    init();

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
