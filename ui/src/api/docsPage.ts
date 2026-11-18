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
 * How many links to `pageId` by its title, and blocks of other pages that name it in plain text, a rename touches
 * (decides between a plain rename and the rename dialog).
 * @param pageId - Page being renamed.
 * @param title - Proposed new title.
 * @returns Links plus mention blocks affected by the rename, or 0 if the preview fails.
 */
export async function fetchRenameLinkCount(pageId: string, title: string): Promise<number> {
  try {
    // plain-text mentions count too: the dialog offers to change them (RichDocsLinks H 44)
    const res = await client.get<{ total?: number; affectedPages?: unknown[]; mentions?: unknown[] }>(
      `/docs/pages/${pageId}/rename-preview`,
      { params: { title, mentions: true } },
    );
    return (res.data.total ?? res.data.affectedPages?.length ?? 0) + (res.data.mentions?.length ?? 0);
  } catch {
    return 0;
  }
}
