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

/** Return a page's stats, or null when absent. */
export function pageStats(page: DocsPage): DocsPageStats | null {
  return (page as DocsPage & { stats?: DocsPageStats }).stats ?? null;
}

/**
 * Query which pages a rename would rewrite links in.
 * @param pageId - Page being renamed.
 * @param title - Proposed new title (trimmed; blank disables the query).
 * @param enabled - Set false to skip fetching.
 * @param withMentions - Also list the plain-text mentions of the current title in other pages.
 */
export function useRenamePreview(pageId: string, title: string, enabled = true, withMentions = false) {
  const t = title.trim();
  return useQuery({
    queryKey: ['docs', 'rename-preview', pageId, t, withMentions] as const,
    queryFn: async () =>
      (
        await client.get<RenamePreview>(`/docs/pages/${pageId}/rename-preview`, {
          params: withMentions ? { title: t, mentions: true } : { title: t },
        })
      ).data,
    enabled: enabled && !!pageId && !!t,
    retry: false,
  });
}

/** Mutation: rename a page and rewrite its links. */
export function useRenameWithLinks(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      pageId: string;
      title: string;
      rewriteLinks: boolean;
      /** The plain-text mentions to change with the rename (blocks of other pages). */
      rewriteMentions?: { pageId: string; blockId: string }[];
    }) =>
      (
        await client.patch<RenamedPage>(`/docs/pages/${v.pageId}`, {
          title: v.title,
          rewriteLinks: v.rewriteLinks,
          ...(v.rewriteMentions?.length ? { rewriteMentions: v.rewriteMentions } : {}),
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    },
  });
}

/** Query what deleting a page would affect. */
export function useDeletePreview(pageId: string) {
  return useQuery({
    queryKey: ['docs', 'delete-preview', pageId] as const,
    queryFn: async () => (await client.get<DeletePreview>(`/docs/pages/${pageId}/delete-preview`)).data,
    enabled: !!pageId,
    retry: false,
  });
}

/** Query the project's Recycle Bin entries. */
export function useRecycleEntries(projectId: string) {
  return useQuery({
    queryKey: docsKeys.recycle(projectId),
    queryFn: async () => (await client.get<RecycleEntry[]>(`/projects/${projectId}/docs/recycle-bin`)).data,
    enabled: !!projectId,
  });
}

/** Mutation: permanently delete everything in the Recycle Bin. */
export function useEmptyRecycleBin(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // the pages in the bin, read before they go: their queries are not fetched again (they could only answer 404)
      const gone = (qc.getQueryData<RecycleEntry[]>(docsKeys.recycle(projectId)) ?? []).map((e) => e.id);
      await client.delete(`/projects/${projectId}/docs/recycle-bin`);
      return gone;
    },
    onSuccess: (gone) => {
      void qc.invalidateQueries({ queryKey: ['docs'], predicate: (q) => !gone.some((id) => q.queryKey.includes(id)) });
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    },
  });
}

/** Query backlinks with their origin details. */
export function useBacklinksEx(pageId: string | null) {
  return useQuery({
    queryKey: docsKeys.backlinks(pageId ?? ''),
    queryFn: async () => (await client.get<BacklinksEx>(`/docs/pages/${pageId}/backlinks`)).data,
    enabled: !!pageId,
  });
}

/** Where Docs health's Relink points a group of broken links. */
export interface LinkFixTo {
  pageId: string;
  /** A heading of that page, by its text. */
  section?: string | null;
  /** A heading or block of that page, by its id. */
  blockId?: string | null;
  blockLabel?: string | null;
}

/** `POST /projects/{id}/docs/links/fix`: what changed. */
export interface LinkFixResult {
  links: number;
  pages: number;
  changed: { pageId: string; title: string; links: number; version: number }[];
  skipped: { pageId: string; title: string; reason: string }[];
}

/**
 * Mutation: fix a group of broken links in the pages that hold them (RichDocsLinks G 40): relink them, or remove them
 * and keep their words. Each changed page gets a new version.
 */
export function useFixLinks(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      page: string;
      anchor: string | null;
      pages: string[];
      action: 'relink' | 'remove';
      to?: LinkFixTo;
    }) => (await client.post<LinkFixResult>(`/projects/${projectId}/docs/links/fix`, v)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['docs'] }),
  });
}

/** Mutations to link and unlink a ticket and a page. */
export function useLinkTicketDoc(ticketId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['docs'] });
  const link = useMutation({
    /** A page, or a heading or block of it (`blockId`, Link a doc H 48). */
    mutationFn: async (target: string | { pageId: string; blockId?: string | null }) => {
      const body = typeof target === 'string' ? { pageId: target } : target;
      await client.post(`/tickets/${ticketId}/docs`, body.blockId ? body : { pageId: body.pageId });
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

/**
 * Pages and sections matching `q` in a project (the `[[` / "Link a doc" suggester).
 * @param projectId - Project to search; disabled while undefined.
 * @param q - Search text (trimmed).
 * @param enabled - Set false to skip fetching.
 */
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
