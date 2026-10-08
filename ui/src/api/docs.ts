import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import { client } from './client';
import type {
  DocsBacklinks,
  DocsDeletedEntry,
  DocsDiff,
  DocsErrorDetail,
  DocsPage,
  DocsRefRequest,
  DocsRefResult,
  DocsTemplate,
  DocsTicketDoc,
  DocsTreeNode,
  DocsVersionDetail,
  DocsVersionSummary,
} from '../types/docs';

/** The `{code, message, ...}` body of a failed docs request, if there is one. */
export function docsErrorDetail(err: unknown): (DocsErrorDetail & { status?: number }) | null {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } } };
  const detail = e?.response?.data?.detail;
  if (detail && typeof detail === 'object' && 'code' in detail) {
    // error bodies skip the client's response interceptor, so camelCase them here
    return { ...camelcaseKeys(detail as Record<string, unknown>), status: e.response?.status } as DocsErrorDetail & {
      status?: number;
    };
  }
  return null;
}

export const docsKeys = {
  tree: (projectId: string) => ['docs', 'tree', projectId] as const,
  page: (pageId: string) => ['docs', 'page', pageId] as const,
  versions: (pageId: string) => ['docs', 'versions', pageId] as const,
  diff: (pageId: string, a: number, b: number) => ['docs', 'diff', pageId, a, b] as const,
  backlinks: (pageId: string) => ['docs', 'backlinks', pageId] as const,
  recycle: (projectId: string) => ['docs', 'recycle', projectId] as const,
  templates: ['docs', 'templates'] as const,
  ticketDocs: (ticketId: string) => ['docs', 'ticket', ticketId] as const,
  resolve: (projectId: string, refs: DocsRefRequest[]) => ['docs', 'resolve', projectId, refs] as const,
};

/** Query a project's page tree. */
export function useDocsTree(projectId: string) {
  return useQuery({
    queryKey: docsKeys.tree(projectId),
    queryFn: async () => (await client.get<DocsTreeNode[]>(`/projects/${projectId}/docs/tree`)).data,
    enabled: !!projectId,
  });
}

/** Query one page (disabled while `pageId` is null). */
export function useDocsPage(pageId: string | null) {
  return useQuery({
    queryKey: docsKeys.page(pageId ?? ''),
    queryFn: async () => (await client.get<DocsPage>(`/docs/pages/${pageId}`)).data,
    enabled: !!pageId,
    retry: (count, err) => (docsErrorDetail(err) ? false : count < 2),
  });
}

/** Query the page templates. */
export function useDocsTemplates() {
  return useQuery({
    queryKey: docsKeys.templates,
    queryFn: async () => (await client.get<DocsTemplate[]>('/docs/templates')).data,
    staleTime: Infinity,
  });
}

/** Query a page's versions. */
export function useDocsVersions(pageId: string | null) {
  return useQuery({
    queryKey: docsKeys.versions(pageId ?? ''),
    queryFn: async () => (await client.get<DocsVersionSummary[]>(`/docs/pages/${pageId}/versions`)).data,
    enabled: !!pageId,
  });
}

/** Query one version of a page. */
export function useDocsVersion(pageId: string | null, version: number | null) {
  return useQuery({
    queryKey: ['docs', 'version', pageId, version] as const,
    queryFn: async () => (await client.get<DocsVersionDetail>(`/docs/pages/${pageId}/versions/${version}`)).data,
    enabled: !!pageId && version != null,
  });
}

/** Query the diff between two versions. */
export function useDocsDiff(pageId: string | null, a: number | null, b: number | null) {
  return useQuery({
    queryKey: docsKeys.diff(pageId ?? '', a ?? 0, b ?? 0),
    queryFn: async () => (await client.get<DocsDiff>(`/docs/pages/${pageId}/versions/${a}/diff/${b}`)).data,
    enabled: !!pageId && a != null && b != null,
  });
}

/** Query the pages and tickets that reference a page. */
export function useDocsBacklinks(pageId: string | null) {
  return useQuery({
    queryKey: docsKeys.backlinks(pageId ?? ''),
    queryFn: async () => (await client.get<DocsBacklinks>(`/docs/pages/${pageId}/backlinks`)).data,
    enabled: !!pageId,
  });
}

/** Query a project's Recycle Bin. */
export function useDocsRecycleBin(projectId: string) {
  return useQuery({
    queryKey: docsKeys.recycle(projectId),
    queryFn: async () => (await client.get<DocsDeletedEntry[]>(`/projects/${projectId}/docs/recycle-bin`)).data,
    enabled: !!projectId,
  });
}

/** Query the pages a ticket references or is linked to. */
export function useTicketDocs(ticketId: string) {
  return useQuery({
    queryKey: docsKeys.ticketDocs(ticketId),
    queryFn: async () => (await client.get<DocsTicketDoc[]>(`/tickets/${ticketId}/docs`)).data,
    enabled: !!ticketId,
  });
}

/** Resolve [[page]] and ticket references from rendered markdown (chips, broken-link state). */
export function useResolveRefs(projectId: string, refs: DocsRefRequest[]) {
  return useQuery({
    queryKey: docsKeys.resolve(projectId, refs),
    queryFn: async () => (await client.post<DocsRefResult[]>(`/projects/${projectId}/docs/resolve`, { refs })).data,
    enabled: !!projectId && refs.length > 0,
  });
}

function useDocsMutation<TVars, TData = unknown>(fn: (vars: TVars) => Promise<TData>, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['docs'] });
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    },
  });
}

/** Mutation: create a page. */
export function useCreatePage(projectId: string) {
  return useDocsMutation(
    async (v: { title: string; parentId?: string | null; template?: string; markdown?: string }) =>
      (await client.post<DocsPage>(`/projects/${projectId}/docs/pages`, v)).data,
    projectId,
  );
}

/** Mutation: rename a page. */
export function useRenamePage(projectId: string) {
  return useDocsMutation(
    async (v: { pageId: string; title: string }) =>
      (await client.patch<DocsPage>(`/docs/pages/${v.pageId}`, { title: v.title })).data,
    projectId,
  );
}

/** Mutation: move a page. */
export function useMovePage(projectId: string) {
  return useDocsMutation(
    async (v: { pageId: string; parentId: string | null; beforeId?: string | null; afterId?: string | null }) =>
      (
        await client.post<DocsPage>(`/docs/pages/${v.pageId}/move`, {
          parentId: v.parentId,
          beforeId: v.beforeId ?? null,
          afterId: v.afterId ?? null,
        })
      ).data,
    projectId,
  );
}

/** Mutation: duplicate a page. */
export function useDuplicatePage(projectId: string) {
  return useDocsMutation(
    async (v: { pageId: string; title?: string; parentId?: string | null; includeChildren: boolean }) => {
      const body: Record<string, unknown> = { title: v.title, includeChildren: v.includeChildren };
      if (v.parentId !== undefined) body.parentId = v.parentId;
      return (await client.post<DocsPage>(`/docs/pages/${v.pageId}/duplicate`, body)).data;
    },
    projectId,
  );
}

/** Mutation: move a page to the Recycle Bin. */
export function useDeletePage(projectId: string) {
  return useDocsMutation(
    async (pageId: string) => (await client.delete<{ id: string; deletedPages: number }>(`/docs/pages/${pageId}`)).data,
    projectId,
  );
}

/** Mutation: restore a page from the Recycle Bin. */
export function useRestorePage(projectId: string) {
  return useDocsMutation(
    async (pageId: string) =>
      (
        await client.post<{ id: string; restoredPages: number; movedToTopLevel: boolean }>(
          `/docs/pages/${pageId}/restore`,
        )
      ).data,
    projectId,
  );
}

/** Mutation: permanently delete a page. */
export function usePurgePage(projectId: string) {
  return useDocsMutation(async (pageId: string) => {
    await client.delete(`/docs/pages/${pageId}/purge`);
  }, projectId);
}

/** Mutation: save your draft. */
export function useSaveDraft(projectId: string) {
  return useDocsMutation(
    async (v: { pageId: string; markdown: string; title?: string; baseVersion?: number }) =>
      (
        await client.put<DocsPage>(`/docs/pages/${v.pageId}/draft`, {
          markdown: v.markdown,
          title: v.title,
          baseVersion: v.baseVersion,
        })
      ).data,
    projectId,
  );
}

/** Mutation: discard your draft. */
export function useDiscardDraft(projectId: string) {
  return useDocsMutation(
    async (pageId: string) => (await client.delete<DocsPage>(`/docs/pages/${pageId}/draft`)).data,
    projectId,
  );
}

/** Mutation: publish the draft as a new version. */
export function usePublishPage(projectId: string) {
  return useDocsMutation(
    async (v: {
      pageId: string;
      baseVersion: number;
      note?: string;
      markdown?: string;
      title?: string;
      notify?: boolean;
    }) =>
      (
        await client.post<DocsPage>(`/docs/pages/${v.pageId}/publish`, {
          notify: v.notify ?? false,
          baseVersion: v.baseVersion,
          note: v.note,
          markdown: v.markdown,
          title: v.title,
        })
      ).data,
    projectId,
  );
}

/** Mutation: restore an old version as a new one. */
export function useRestoreVersion(projectId: string) {
  return useDocsMutation(
    async (v: { pageId: string; version: number; note?: string }) =>
      (
        await client.post<DocsPage>(`/docs/pages/${v.pageId}/versions/${v.version}/restore`, {
          note: v.note,
        })
      ).data,
    projectId,
  );
}
