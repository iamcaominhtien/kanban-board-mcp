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

      function handleMessage(event: MessageEvent<string>) {
        const eventType = event.data ?? '';

        if (!eventType.startsWith('idea_ticket_')) {
          // Generic invalidate or other events — full invalidation
          queryClient.invalidateQueries();
          return;
        }

        // e.g. "idea_ticket_created:proj-123" or "idea_ticket_updated:proj-123"
        const projectId: string = eventType.split(':')[1] ?? '';
        if (projectId) {
          queryClient.invalidateQueries({ queryKey: ['tickets', projectId, 'idea'] });
        } else {
          console.warn('[SSE] idea_ticket event missing project_id:', eventType);
          queryClient.invalidateQueries({ queryKey: ['tickets'] });
        }
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
