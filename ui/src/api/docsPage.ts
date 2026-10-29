import { useQuery } from '@tanstack/react-query';
import { client } from './client';

export interface SimilarPage {
  pageId: string;
  title: string;
  path: string[];
}

/**
 * Pages whose address looks like `slug` (shown on the 404 state).
 * @param projectId - Project to search in.
 * @param slug - Slug to find similar pages for.
 * @param enabled - Set false to skip fetching.
 */
export function useSimilarPages(projectId: string, slug: string, enabled = true) {
  return useQuery({
    queryKey: ['docs', 'similar', projectId, slug] as const,
    queryFn: async () =>
      (await client.get<SimilarPage[]>(`/projects/${projectId}/docs/similar`, { params: { slug } })).data,
    enabled: enabled && !!projectId && !!slug,
    retry: false,
  });
}

/**
 * How many other pages link to `pageId` by its title (decides between a plain rename and the rewrite-links dialog).
 * @param pageId - Page being renamed.
 * @param title - Proposed new title.
 * @returns Number of links affected by the rename, or 0 if the preview fails.
 */
export async function fetchRenameLinkCount(pageId: string, title: string): Promise<number> {
  try {
    const res = await client.get<{ total?: number; affectedPages?: unknown[] }>(
      `/docs/pages/${pageId}/rename-preview`,
      { params: { title } },
    );
    return res.data.total ?? res.data.affectedPages?.length ?? 0;
  } catch {
    return 0;
  }
}
