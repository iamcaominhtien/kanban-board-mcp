import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { docsKeys } from './docs';
import type { DocsPage } from '../types/docs';
import type {
  BacklinksEx,
  DeletePreview,
  DocsPageStats,
  DocsSuggestItem,
  RecycleEntry,
  RenamePreview,
  RenamedPage,
} from '../types/docsActions';

export function pageStats(page: DocsPage): DocsPageStats | null {
  return (page as DocsPage & { stats?: DocsPageStats }).stats ?? null;
}

export function useRenamePreview(pageId: string, title: string, enabled = true) {
  const t = title.trim();
  return useQuery({
    queryKey: ['docs', 'rename-preview', pageId, t] as const,
    queryFn: async () =>
      (
        await client.get<RenamePreview>(`/docs/pages/${pageId}/rename-preview`, {
          params: { title: t },
        })
      ).data,
    enabled: enabled && !!pageId && !!t,
    retry: false,
  });
}

export function useRenameWithLinks(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { pageId: string; title: string; rewriteLinks: boolean }) =>
      (
        await client.patch<RenamedPage>(`/docs/pages/${v.pageId}`, {
          title: v.title,
          rewriteLinks: v.rewriteLinks,
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    },
  });
}

export function useDeletePreview(pageId: string) {
  return useQuery({
    queryKey: ['docs', 'delete-preview', pageId] as const,
    queryFn: async () => (await client.get<DeletePreview>(`/docs/pages/${pageId}/delete-preview`)).data,
    enabled: !!pageId,
    retry: false,
  });
}

export function useRecycleEntries(projectId: string) {
  return useQuery({
    queryKey: docsKeys.recycle(projectId),
    queryFn: async () => (await client.get<RecycleEntry[]>(`/projects/${projectId}/docs/recycle-bin`)).data,
    enabled: !!projectId,
  });
}

export function useEmptyRecycleBin(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await client.delete(`/projects/${projectId}/docs/recycle-bin`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    },
  });
}

export function useBacklinksEx(pageId: string | null) {
  return useQuery({
    queryKey: docsKeys.backlinks(pageId ?? ''),
    queryFn: async () => (await client.get<BacklinksEx>(`/docs/pages/${pageId}/backlinks`)).data,
    enabled: !!pageId,
  });
}

export function useLinkTicketDoc(ticketId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['docs'] });
  const link = useMutation({
    mutationFn: async (pageId: string) => {
      await client.post(`/tickets/${ticketId}/docs`, { pageId });
    },
    onSuccess: done,
  });
  const unlink = useMutation({
    mutationFn: async (pageId: string) => {
      await client.delete(`/tickets/${ticketId}/docs/${pageId}`);
    },
    onSuccess: done,
  });
  return { link, unlink };
}

interface SearchResponse {
  pages?: {
    pageId: string;
    title: string;
    path?: string[];
    matches?: { section?: string; slug?: string }[];
  }[];
}

/** Pages and sections matching `q` in a project (the `[[` / "Link a doc" suggester). */
export function useDocsSuggest(projectId: string | undefined, q: string, enabled = true) {
  const query = q.trim();
  return useQuery({
    queryKey: ['docs', 'suggest', projectId, query] as const,
    enabled: enabled && !!projectId,
    staleTime: 10_000,
    queryFn: async (): Promise<DocsSuggestItem[]> => {
      const out: DocsSuggestItem[] = [];
      try {
        const res = (
          await client.get<SearchResponse>(`/projects/${projectId}/docs/search`, {
            params: { q: query, scope: 'space', limit: 6 },
          })
        ).data;
        for (const p of res.pages ?? []) {
          const path = p.path ?? [p.title];
          const pageHit = p.title.toLowerCase().includes(query.toLowerCase());
          if (pageHit || !(p.matches ?? []).some((m) => m.section)) {
            out.push({ kind: 'page', pageId: p.pageId, title: p.title, pageTitle: p.title, path });
          }
          for (const m of p.matches ?? []) {
            if (!m.section) continue;
            out.push({
              kind: 'section',
              pageId: p.pageId,
              title: m.section,
              pageTitle: p.title,
              path: [...path],
              slug: m.slug,
            });
          }
        }
        return out.slice(0, 8);
      } catch {
        // search endpoint unavailable: fall back to the page tree
        const tree = (
          await client.get<{ id: string; title: string; parentId: string | null }[]>(`/projects/${projectId}/docs/tree`)
        ).data;
        const byId = new Map(tree.map((n) => [n.id, n]));
        const pathOf = (id: string) => {
          const parts: string[] = [];
          let cur = byId.get(id);
          while (cur) {
            parts.unshift(cur.title);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
          }
          return parts;
        };
        return tree
          .filter((n) => n.title.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 6)
          .map((n) => ({
            kind: 'page' as const,
            pageId: n.id,
            title: n.title,
            pageTitle: n.title,
            path: pathOf(n.id),
          }));
      }
    },
  });
}
