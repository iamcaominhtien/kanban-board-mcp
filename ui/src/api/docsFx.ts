import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import type {
  DocsImportConflict,
  DocsImportDryRun,
  DocsImportEntry,
  DocsImportResult,
  DocsSearchParams,
  DocsSearchResponse,
} from '../types/docsFx';
import type { DocsTreeNode } from '../types/docs';

export const docsFxKeys = {
  search: (projectId: string, p: DocsSearchParams) => ['docs', 'search', projectId, p] as const,
  pageCount: (projectId: string) => ['docs', 'page-count', projectId] as const,
};

export async function searchDocs(
  projectId: string,
  p: DocsSearchParams,
  signal?: AbortSignal,
): Promise<DocsSearchResponse> {
  const params: Record<string, unknown> = { q: p.q, scope: p.scope ?? 'space' };
  if (p.mode) params.mode = p.mode;
  if (p.pageId) params.page_id = p.pageId;
  if (p.limit) params.limit = p.limit;
  if (p.offset) params.offset = p.offset;
  if (p.author?.length) params.author = p.author.join(',');
  if (p.editedSince) params.edited_since = p.editedSince;
  if (p.underPage) params.under_page = p.underPage;
  if (p.hasTickets) params.has_tickets = true;
  if (p.status?.length) params.status = p.status.join(',');
  if (p.sort) params.sort = p.sort;
  const res = await client.get<DocsSearchResponse>(`/projects/${projectId}/docs/search`, { params, signal });
  return res.data;
}

export function useDocsSearch(
  projectId: string,
  p: DocsSearchParams,
  opts: { enabled?: boolean; keepPrevious?: boolean } = {},
) {
  return useQuery({
    queryKey: docsFxKeys.search(projectId, p),
    queryFn: ({ signal }) => searchDocs(projectId, p, signal),
    enabled: (opts.enabled ?? true) && !!projectId && p.q.trim().length > 0,
    retry: false,
    staleTime: 10_000,
    placeholderData: opts.keepPrevious ? (prev) => prev : undefined,
  });
}

// ─── Import ───────────────────────────────────────────────────────────────────

function importForm(
  entries: DocsImportEntry[],
  parentId: string | null,
  onConflict: DocsImportConflict,
  dryRun = false,
) {
  const fd = new FormData();
  if (dryRun) fd.append('dry_run', 'true');
  for (const e of entries) {
    fd.append('files', e.file, e.file.name);
    fd.append('paths', e.path);
  }
  if (parentId) fd.append('parent_id', parentId);
  fd.append('on_conflict', onConflict);
  return fd;
}

export async function importDryRun(
  projectId: string,
  entries: DocsImportEntry[],
  parentId: string | null,
  onConflict: DocsImportConflict,
): Promise<DocsImportDryRun> {
  const res = await client.post<DocsImportDryRun>(
    `/projects/${projectId}/docs/import`,
    importForm(entries, parentId, onConflict, true),
  );
  return res.data;
}

/** Imports the given entries (the dialog sends one per request, parents first). */
export async function importFiles(
  projectId: string,
  entries: DocsImportEntry[],
  parentId: string | null,
  onConflict: DocsImportConflict,
): Promise<DocsImportResult> {
  const res = await client.post<DocsImportResult>(
    `/projects/${projectId}/docs/import`,
    importForm(entries, parentId, onConflict),
  );
  return res.data;
}

export async function importResolve(projectId: string, pageIds: string[]): Promise<void> {
  await client.post(`/projects/${projectId}/docs/import/resolve`, { page_ids: pageIds });
}

// ─── Settings: page count for the "N pages are hidden" note ───────────────────

const COUNT_KEY = (id: string) => `docsPageCount:${id}`;

export function readCachedPageCount(projectId: string): number | null {
  try {
    const v = localStorage.getItem(COUNT_KEY(projectId));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

/** Number of pages in a project's docs; remembers it locally so it is still known when Docs is switched off. */
export function useDocsPageCount(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: docsFxKeys.pageCount(projectId),
    enabled,
    retry: false,
    queryFn: async () => {
      const nodes = (await client.get<DocsTreeNode[]>(`/projects/${projectId}/docs/tree`)).data;
      try {
        localStorage.setItem(COUNT_KEY(projectId), String(nodes.length));
      } catch {
        /* ignore */
      }
      return nodes.length;
    },
  });
}
