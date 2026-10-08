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

/**
 * Search pages and tickets.
 * @param projectId - Project (docs space) to search.
 * @param p - Search query and options; `q` is required, scope defaults to `space`, empty filters are omitted.
 * @param signal - Optional abort signal to cancel the request.
 */
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

/**
 * Query search results (disabled for an empty query).
 * @param projectId - Project (docs space) to search.
 * @param p - Search query and options.
 * @param opts.enabled - Set false to skip fetching; also skipped while the project is empty or `p.q` is blank.
 * @param opts.keepPrevious - Keep the previous results visible while a new search loads.
 */
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

/**
 * Report what importing the files would create, without writing.
 * @param projectId - Project to import into.
 * @param entries - Files with their relative paths.
 * @param parentId - Page the import is nested under, or `null` for the root.
 * @param onConflict - How to handle existing pages with the same name.
 */
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

/**
 * Imports the given entries (the dialog sends one per request, parents first).
 * @param projectId - Project to import into.
 * @param entries - Files with their relative paths.
 * @param parentId - Page the import is nested under, or `null` for the root.
 * @param onConflict - How to handle existing pages with the same name.
 */
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

/**
 * Re-index links of the pages an import created.
 * @param projectId - Project owning the pages.
 * @param pageIds - Imported pages whose references are resolved.
 */
export async function importResolve(projectId: string, pageIds: string[]): Promise<void> {
  await client.post(`/projects/${projectId}/docs/import/resolve`, { page_ids: pageIds });
}

// ─── Settings: page count for the "N pages are hidden" note ───────────────────

const COUNT_KEY = (id: string) => `docsPageCount:${id}`;

/** Read a project's last known page count from local storage. */
export function readCachedPageCount(projectId: string): number | null {
  try {
    const v = localStorage.getItem(COUNT_KEY(projectId));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

/**
 * Number of pages in a project's docs; remembers it locally so it is still known when Docs is switched off.
 * @param projectId - Project whose pages are counted.
 * @param enabled - Set false to skip fetching; a successful fetch also caches the count in localStorage.
 */
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
