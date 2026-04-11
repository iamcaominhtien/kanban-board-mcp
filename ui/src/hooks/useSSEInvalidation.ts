import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const SSE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000') + '/events';

export function useSSEInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let es: EventSource;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource(SSE_URL);
      queryClient.invalidateQueries();

      es.onmessage = (event) => {
        queryClient.invalidateQueries();
      };

      es.onerror = () => {
        es.close();
        retryTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      clearTimeout(retryTimeout);
      if (es) {
        es.close();
        // @ts-expect-error: intentionally nulling to prevent late callbacks
        es = null;
      }
    };
  }, [queryClient]);
}
