import { useQuery } from '@tanstack/react-query';

/** Pages with a proposal from an AI member waiting for review (a purple dot in the tree). Owned by the proposals feature. */
export function useWaitingProposalPages(projectId: string): Set<string> {
  const q = useQuery({
    queryKey: ['docs-ai', 'proposal-pages', projectId],
    queryFn: async () => [] as string[],
    enabled: false,
  });
  return new Set(q.data ?? []);
}
