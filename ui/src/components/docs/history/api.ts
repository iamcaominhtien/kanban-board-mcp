/**
 * What History reads and writes beyond `api/docs.ts`: every version's content at once (the rows count the blocks each
 * version changed), and "Copy as new page" (a version becomes a draft page of its own).
 */

import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { client } from '../../../api/client';
import { docsKeys } from '../../../api/docs';
import type { DocsPage, DocsVersionDetail, RichDoc } from '../../../types/docs';

/** The query key `useDocsVersion` uses, so the rows and the comparison share what they fetched. */
export const versionKey = (pageId: string, version: number) => ['docs', 'version', pageId, version] as const;

/** Rows past this many (newest first) are not counted: their content is fetched only when opened. */
export const COUNTED_ROWS = 40;

/**
 * Query the content of several versions of a page.
 * @param pageId - The page.
 * @param versions - Version numbers.
 * @returns Version number -> its detail (missing while it loads or when it failed).
 */
export function useVersionDetails(pageId: string, versions: number[]): Map<number, DocsVersionDetail> {
  const results = useQueries({
    queries: versions.map((v) => ({
      queryKey: versionKey(pageId, v),
      queryFn: async () => (await client.get<DocsVersionDetail>(`/docs/pages/${pageId}/versions/${v}`)).data,
      enabled: !!pageId && v > 0,
      staleTime: Infinity,
    })),
  });
  const out = new Map<number, DocsVersionDetail>();
  results.forEach((r, i) => {
    if (r.data) out.set(versions[i], r.data);
  });
  return out;
}

/** What "Copy as new page" sends: the new page's title and place, and the version's content. */
export interface CopyVersionInput {
  title: string;
  parentId: string | null;
  /** The version's rich JSON (null for a Markdown version: `markdown` is sent instead). */
  content: RichDoc | null;
  markdown: string;
}

/**
 * Make a draft page from a version: create the page (`POST /projects/{id}/docs/pages`), then save the version's
 * content as its draft (`PUT /docs/pages/{id}/draft`). The copy's history starts at v1 when it is published;
 * comments and versions stay on the original page.
 * @param projectId - The project.
 * @param input - Title, place and content.
 * @returns The new page as the draft save returns it.
 */
export async function copyVersionAsPage(projectId: string, input: CopyVersionInput): Promise<DocsPage> {
  const created = (
    await client.post<DocsPage>(`/projects/${projectId}/docs/pages`, { title: input.title, parentId: input.parentId })
  ).data;
  const body = input.content
    ? { content: input.content, title: input.title }
    : { markdown: input.markdown, title: input.title };
  return (await client.put<DocsPage>(`/docs/pages/${created.id}/draft`, body, { rawKeys: ['content'] })).data;
}

/** Mutation: {@link copyVersionAsPage}; refreshes the tree. */
export function useCopyVersionAsPage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CopyVersionInput) => copyVersionAsPage(projectId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    },
  });
}

/**
 * Change one version's note (`PATCH /docs/pages/{id}/versions/{n}`): the history's "Edit note". The list and that
 * version are fetched again.
 * @param pageId - The page.
 */
export function useEditVersionNote(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ version, note }: { version: number; note: string }) =>
      (await client.patch<DocsVersionDetail>(`/docs/pages/${pageId}/versions/${version}`, { note })).data,
    onSuccess: (detail, { version }) => {
      qc.setQueryData(versionKey(pageId, version), detail);
      void qc.invalidateQueries({ queryKey: docsKeys.versions(pageId) });
    },
  });
}

/**
 * The link that opens a page on one of its versions, read-only (`?docs=<page>&version=<n>`).
 * @param pageId - The page.
 * @param version - The version.
 */
export function versionLink(pageId: string, version: number): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('docs', pageId);
  url.searchParams.set('version', String(version));
  return url.toString();
}
