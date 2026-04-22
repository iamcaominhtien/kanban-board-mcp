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

      function connect() {
        if (!mounted) return;
        es = new EventSource(`${origin}/events`);
        queryClient.invalidateQueries();

        es.onmessage = (event) => {
          const data: string = event.data ?? '';

          // idea_ticket_created:{projectId} or idea_ticket_updated:{projectId}
          if (data.startsWith('idea_ticket_')) {
            const parts = data.split(':');
            const projectId = parts[1];
            if (projectId) {
              // Targeted: only invalidate the idea board for this project
              queryClient.invalidateQueries({ queryKey: ['tickets', projectId, 'idea'] });
            } else {
              // Fallback if no project ID encoded
              queryClient.invalidateQueries({ queryKey: ['tickets'] });
            }
          } else {
            // Generic invalidate or other events — full invalidation
            queryClient.invalidateQueries();
          }
        };

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
