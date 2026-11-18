/**
 * Shared highlights while reading (design board "Rich Docs — reading", K): an annotation layer over a page, not page
 * text (`GET/POST /docs/pages/{id}/highlights`, `POST …/highlights/clear`, `POST …/highlights/restore`,
 * `PATCH/DELETE /docs/highlights/{id}`, `POST /docs/highlights/{id}/to-page`; kb-docs docs_highlights.rs). The server announces every change as a
 * `docs_highlights` event, which refetches the page's list (hooks/invalidationTopics.ts). Writes go through the Docs
 * offline queue (docs/states/offlineQueue.ts): without a connection they wait in this browser ("Not sent yet", K 90)
 * and are sent in order when it returns; each function then answers `null`.
 */

import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { isNoConnection, queueWrite, queuedWrites, sendOrQueue } from '../components/docs/states/offlineQueue';

/** The 12 highlight colour names (server/contract/richdoc/palette.json, `highlightColors`). */
export type HighlightColor =
  'yellow' | 'lime' | 'green' | 'teal' | 'blue' | 'violet' | 'pink' | 'red' | 'orange' | 'sand' | 'grey' | 'slate';

/** One shared highlight as the server sends it. */
export interface DocsHighlight {
  id: string;
  /** The block the passage starts in (`blockId` attribute of the page JSON). */
  blockId: string;
  /** The block it ends in when it runs across blocks; null inside one block. */
  endBlockId: string | null;
  /** Start offset (characters) in the first block's text. */
  start: number;
  /** End offset (characters) in the last block's text. */
  end: number;
  quote: string;
  prefix: string | null;
  suffix: string | null;
  color: HighlightColor;
  /** Actor name of the person who made it. */
  author: string;
  createdAt: string;
  /** The comment thread written on it, when its author linked one. */
  threadId: string | null;
  /**
   * `ok`; `moved` (the words moved and the highlight followed); `changed` ("Passage changed": the words are gone);
   * `becoming` (an editor added it to the page draft: "Becoming page text" until a publish carries it).
   */
  state: 'ok' | 'moved' | 'changed' | 'becoming';
  /** Made by the caller. */
  mine: boolean;
  /** The caller may remove it (their own, or they can edit the page). */
  canRemove: boolean;
}

/** `GET /docs/pages/{id}/highlights`. */
export interface DocsHighlightsResult {
  /** Off for the page or the project. */
  enabled: boolean;
  /** Why they are off (the server's words), or null. */
  reason: string | null;
  /** The caller may add one (on, and not a Viewer). */
  canAdd: boolean;
  /** The caller may clear everybody's (they can edit the page). */
  canClear: boolean;
  limits: { perPerson: number; perPage: number };
  highlights: DocsHighlight[];
  /** Highlights removed in the last minutes: who made each and who removed it ("removed while you read", K 126). */
  removed?: { id: string; author: string; by: string | null }[];
}

/** What a reader sends to highlight a passage. */
export interface HighlightInput {
  blockId: string;
  endBlockId?: string | null;
  start: number;
  end: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  color: HighlightColor;
}

/** What `clear` answers: how many went, by whom, and their ids for Undo. */
export interface ClearResult {
  removed: number;
  byPerson: Record<string, number>;
  ids: string[];
}

/** The query key of a page's highlights (under `docs`, so a Docs-wide refresh reaches it too). */
export const highlightKeys = {
  page: (pageId: string) => ['docs', 'highlights', pageId] as const,
};

/**
 * Query a page's shared highlights.
 * @param pageId - The page.
 * @param enabled - False skips the request (not a rich page, offline, the public view).
 */
export function useDocsHighlights(pageId: string, enabled = true) {
  return useQuery({
    queryKey: highlightKeys.page(pageId),
    queryFn: async () => (await client.get<DocsHighlightsResult>(`/docs/pages/${pageId}/highlights`)).data,
    enabled: !!pageId && enabled,
    retry: 1,
  });
}

const LABEL = 'Highlight';

/** The server's answer, or null when the write was kept for later. */
async function write<T>(method: 'post' | 'patch' | 'delete', path: string, data: unknown, pageId?: string) {
  const r = await sendOrQueue<T>({ method, path, data, pageId, label: LABEL });
  return r.sent ? r.data : null;
}

/**
 * Highlights a passage.
 * @returns The saved highlight, or `{ queued }` (the queued write's id) when it waits to be sent (offline).
 * @throws The request's error: 403 `viewers_cannot_highlight`, 409 `highlights_off` / `limit_person` / `limit_page`,
 *   422 `bad_highlight`.
 */
export async function addHighlight(pageId: string, input: HighlightInput): Promise<DocsHighlight | { queued: string }> {
  const r = await sendOrQueue<DocsHighlight>({
    method: 'post',
    path: `/docs/pages/${pageId}/highlights`,
    data: input,
    pageId,
    label: LABEL,
  });
  return r.sent ? r.data : { queued: r.queued.id };
}

/**
 * Changes one of your highlights: its colour, its thread, or where it sits (Re-attach, Use the new quote).
 * @param pageId - Its page (the queue lists what waits per page).
 * @returns The changed highlight, or null when the change waits to be sent.
 * @throws 403 `not_yours`, 422 `bad_highlight`.
 */
export async function patchHighlight(
  id: string,
  changes: Partial<Pick<DocsHighlight, 'color' | 'threadId' | 'blockId' | 'endBlockId' | 'start' | 'end' | 'quote'>>,
  pageId?: string,
): Promise<DocsHighlight | null> {
  return write<DocsHighlight>('patch', `/docs/highlights/${id}`, changes, pageId);
}

/**
 * Removes a highlight (Undo brings it back with {@link restoreHighlights}); offline it waits to be sent.
 * @param pageId - Its page.
 * @throws 403 `not_yours`.
 */
export async function removeHighlight(id: string, pageId?: string): Promise<void> {
  await write('delete', `/docs/highlights/${id}`, undefined, pageId);
}

/**
 * Removes all my highlights of a page (`mine`), or everybody's (`all`, people who can edit the page).
 * @returns The count, the count per person (names as stored) and the ids for Undo; null when it waits to be sent
 *   (offline: no Undo then).
 */
export async function clearHighlights(pageId: string, scope: 'mine' | 'all'): Promise<ClearResult | null> {
  const path = `/docs/pages/${pageId}/highlights/clear`;
  const later = () => {
    queueWrite({ method: 'post', path, data: { scope }, pageId, label: LABEL });
    return null;
  };
  // offline, or older writes wait: after them, in order (the queue's own rule)
  if (!navigator.onLine || queuedWrites().length > 0) return later();
  try {
    // keys as stored: `by_person` is keyed by people's names, which camelCasing would change (so not sendOrQueue)
    const r = (
      await client.post<{ removed: number; by_person: Record<string, number>; ids: string[] }>(
        path,
        { scope },
        { keepKeys: true },
      )
    ).data;
    return { removed: r.removed, byPerson: r.by_person ?? {}, ids: r.ids ?? [] };
  } catch (e) {
    if (isNoConnection(e)) return later();
    throw e;
  }
}

/**
 * Brings removed highlights back (Undo): only the ones the caller removed.
 * @returns The page's list after it, or null when it waits to be sent.
 */
export async function restoreHighlights(pageId: string, ids: string[]): Promise<DocsHighlightsResult | null> {
  return write<DocsHighlightsResult>('post', `/docs/pages/${pageId}/highlights/restore`, { ids }, pageId);
}

/**
 * "Add to the page" (K 92): the highlight's words get a highlight mark in the caller's draft; the shared one is
 * `becoming` page text until a publish carries it.
 * @returns The highlight, now `becoming`.
 * @throws 403 `edit_needed`, 409 `highlights_off` / `not_rich` / `passage_changed` / `page_converting`.
 */
export async function highlightToPage(id: string): Promise<DocsHighlight> {
  return (await client.post<DocsHighlight>(`/docs/highlights/${id}/to-page`, {})).data;
}
