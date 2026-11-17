/**
 * AI suggestions on a rich page (design "AI teams on rich pages", A–C and I): the server's block-level suggestions
 * (`GET /docs/pages/{id}/suggestions`), accepting (`…/accept`, `…/accept-all`) and rejecting them (`…/reject`), and
 * the two settings that say how a team's changes arrive: the page's `aiApply` and the project's `aiApply` per team.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from '../../../api/client';
import { docsKeys } from '../../../api/docs';
import type { DocsPage, RichDoc } from '../../../types/docs';

/** What a suggestion does to its block. */
export type SuggestionKind = 'replace' | 'insert' | 'delete' | 'attrs';

/** One pending suggestion of an AI team on a top-level block. */
export interface DocsSuggestion {
  id: string;
  kind: SuggestionKind;
  /** The block it changes (replace, delete, attrs) or the new block's id (insert). */
  blockId: string | null;
  /** Where an inserted block goes: after this block; null at the start of the page. */
  afterBlockId: string | null;
  /** The new block (replace, insert) or the block's new attrs (attrs); null for delete. */
  after: RichDoc | Record<string, unknown> | null;
  /** The block as the team saw it (replace, delete, attrs); null for insert. */
  before: RichDoc | null;
  /** Who wrote it: the team's name. */
  author: string;
  memberId: string | null;
  runId: string | null;
  note: string | null;
  baseVersion: number;
  createdAt: string;
  /** A person changed the block since the team saw it: Accept waits for "Look at it". */
  stale: boolean;
}

/** `GET /docs/pages/{id}/suggestions`. */
export interface SuggestionList {
  count: number;
  suggestions: DocsSuggestion[];
}

/** `POST …/suggestions/accept-all`. */
export interface AcceptAllResult {
  accepted: number;
  skippedStale: number;
  page: DocsPage;
}

/** How a team's changes reach a page: wait for a person, or saved at once. */
export type AiApply = 'suggest' | 'direct';

/** The query key of a page's pending suggestions (under `docs`, so a `docs` announcement refetches it). */
export const suggestionKeys = {
  page: (pageId: string) => ['docs', 'suggestions', pageId] as const,
  space: (projectId: string) => ['docs', 'space-settings-raw', projectId] as const,
};

/**
 * The page's pending suggestions, in page order.
 * @param pageId - The page; empty switches the query off.
 * @param enabled - False skips the request (a draft, an offline copy, an older version).
 */
export function useSuggestions(pageId: string, enabled = true) {
  return useQuery({
    queryKey: suggestionKeys.page(pageId),
    queryFn: async () => (await client.get<SuggestionList>(`/docs/pages/${pageId}/suggestions`)).data,
    enabled: !!pageId && enabled,
    staleTime: 5_000,
    retry: 1,
  });
}

/** The calls that settle suggestions; each puts the new page in the cache and refetches what shows the counts. */
export function useSettleSuggestions(pageId: string, projectId: string) {
  const qc = useQueryClient();
  const refresh = (page?: DocsPage) => {
    if (page) qc.setQueryData<DocsPage>(docsKeys.page(pageId), (old) => (old ? { ...old, ...page } : page));
    void qc.invalidateQueries({ queryKey: suggestionKeys.page(pageId) });
    void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    void qc.invalidateQueries({ queryKey: docsKeys.versions(pageId) });
  };
  const accept = useMutation({
    mutationFn: async (v: { ids: string[]; looked?: boolean }) =>
      (await client.post<DocsPage>(`/docs/pages/${pageId}/suggestions/accept`, v)).data,
    onSuccess: (page) => refresh(page),
  });
  const acceptAll = useMutation({
    mutationFn: async () => (await client.post<AcceptAllResult>(`/docs/pages/${pageId}/suggestions/accept-all`)).data,
    onSuccess: (r) => refresh(r.page),
  });
  const reject = useMutation({
    mutationFn: async (ids: string[]) =>
      (await client.post<{ rejected: number }>(`/docs/pages/${pageId}/suggestions/reject`, { ids })).data,
    onSuccess: () => refresh(),
  });
  return { accept, acceptAll, reject };
}

/** The project's Docs settings as stored, keys untouched (`aiApply` is keyed by member ids). */
export interface SpaceAiSettings {
  aiApply?: Record<string, AiApply>;
}

/**
 * How each team of the project changes pages (`aiApply` of the project's Docs settings).
 * @param projectId - The project; empty switches the query off.
 */
export function useTeamApply(projectId: string | null | undefined) {
  return useQuery({
    queryKey: suggestionKeys.space(projectId ?? ''),
    queryFn: async () =>
      (await client.get<SpaceAiSettings>(`/projects/${projectId}/docs/settings`, { keepKeys: true })).data,
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Mutation: set how one team changes pages (admins only). The server merges `aiApply` key by key.
 * @param projectId - The project.
 */
export function useSetTeamApply(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { memberId: string; apply: AiApply }) =>
      (
        await client.patch<SpaceAiSettings>(
          `/projects/${projectId}/docs/settings`,
          { settings: { aiApply: { [v.memberId]: v.apply } } },
          { rawKeys: ['settings'], keepKeys: true },
        )
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(suggestionKeys.space(projectId), data);
      void qc.invalidateQueries({ queryKey: ['docs', 'space-settings', projectId] });
    },
  });
}
