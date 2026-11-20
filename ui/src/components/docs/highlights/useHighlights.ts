/**
 * The state of a page's shared highlights for one reader (design board "Rich Docs — reading", K): the server's list,
 * the reader's own highlights still being sent or that could not be saved (125), the other people's new ones held
 * back until "Show" (115-117), the limits (98), Undo after a removal (99, 119) and the last colour used (96).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  addHighlight,
  clearHighlights,
  highlightKeys,
  highlightToPage,
  patchHighlight,
  removeHighlight,
  restoreHighlights,
  useDocsHighlights,
  type DocsHighlight,
  type DocsHighlightsResult,
  type HighlightColor,
  type HighlightInput,
} from '../../../api/docsHighlights';
import { docsErrorDetail } from '../../../api/docs';
import { dropWrite, useQueuedWrites } from '../states/offlineQueue';
import { isHlColor } from './colors';

/** A highlight as the reader draws it: the server's, or one of yours not saved yet. */
export interface HlItem extends DocsHighlight {
  /**
   * One of yours on its way to the server, waiting in this browser while offline ("Not sent yet", K 90; sent when the
   * connection returns), or that the server did not take (dashed red, "Try again").
   */
  local?: 'saving' | 'queued' | 'failed';
  /** The queued write of a `queued` one. */
  queuedId?: string;
}

/** Which limit the reader is at (98). */
export type HlLimit = 'person' | 'page' | null;

/** What Undo brings back. */
export interface HlUndo {
  ids: string[];
  /** "Highlight removed · Yellow", "7 highlights cleared". */
  text: string;
}

const COLOR_KEY = 'kb.docs.highlightColor';

/** The colour last used on this device (96: "The last colour you used is remembered"); Yellow at first. */
export function readLastColor(): HighlightColor {
  try {
    const v = window.localStorage.getItem(COLOR_KEY);
    return isHlColor(v) ? v : 'yellow';
  } catch {
    return 'yellow';
  }
}

function writeLastColor(c: HighlightColor) {
  try {
    window.localStorage.setItem(COLOR_KEY, c);
  } catch {
    // private window or blocked storage: the colour is only remembered for this visit
  }
}

/**
 * Which limit a reader is at.
 * @param list - The page's highlights (yours not saved yet count too).
 * @param limits - The server's limits.
 */
export function limitOf(
  list: Pick<HlItem, 'mine' | 'local'>[],
  limits: { perPerson: number; perPage: number },
): HlLimit {
  const live = list.filter((h) => h.local !== 'failed');
  if (live.length >= limits.perPage) return 'page';
  if (live.filter((h) => h.mine).length >= limits.perPerson) return 'person';
  return null;
}

/**
 * Splits the server's list into what is drawn and other people's new ones waiting behind the "N new" chip.
 * @param list - The server's highlights.
 * @param seen - Ids the reader has already been shown (or made).
 * @returns `shown` and `fresh` (others' highlights that came in since the page was opened).
 */
export function splitFresh(
  list: DocsHighlight[],
  seen: ReadonlySet<string> | null,
): { shown: DocsHighlight[]; fresh: DocsHighlight[] } {
  if (!seen) return { shown: list, fresh: [] };
  const shown: DocsHighlight[] = [];
  const fresh: DocsHighlight[] = [];
  for (const h of list) (h.mine || seen.has(h.id) ? shown : fresh).push(h);
  return { shown, fresh };
}

let tempSeq = 0;

/**
 * The highlights of a page for the reader, and what they can do with them.
 * @param pageId - The page.
 * @param enabled - False asks nothing (not a rich published page, offline).
 * @param me - The reader's actor name (from the comments' `me`), for the highlights not saved yet.
 */
export function useHighlights(pageId: string, enabled: boolean, me: string) {
  const qc = useQueryClient();
  const q = useDocsHighlights(pageId, enabled);
  const data = q.data;
  const [locals, setLocals] = useState<HlItem[]>([]);
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const [undo, setUndo] = useState<HlUndo | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [limitHit, setLimitHit] = useState<HlLimit>(null);
  const [lastColor, setLastColor] = useState<HighlightColor>(readLastColor);
  const inputs = useRef(new Map<string, HighlightInput>());

  // a new page starts afresh
  useEffect(() => {
    setLocals([]);
    setSeen(null);
    setUndo(null);
    setFailure(null);
    setLimitHit(null);
  }, [pageId]);

  // everything there when the page opens is shown; what others add later waits for "Show"
  useEffect(() => {
    if (data && !seen) setSeen(new Set(data.highlights.map((h) => h.id)));
  }, [data, seen]);

  const { shown, fresh } = useMemo(() => splitFresh(data?.highlights ?? [], seen), [data, seen]);
  const items: HlItem[] = useMemo(() => [...shown, ...locals], [shown, locals]);
  const limits = data?.limits ?? { perPerson: 200, perPage: 500 };
  const limit = limitOf([...(data?.highlights ?? []), ...locals], limits);

  const markSeen = useCallback((ids: string[]) => {
    setSeen((s) => {
      const next = new Set(s ?? []);
      ids.forEach((i) => next.add(i));
      return next;
    });
  }, []);

  const setList = useCallback(
    (fn: (old: DocsHighlightsResult) => DocsHighlightsResult) =>
      qc.setQueryData<DocsHighlightsResult>(highlightKeys.page(pageId), (old) => (old ? fn(old) : old)),
    [qc, pageId],
  );
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: highlightKeys.page(pageId) }), [qc, pageId]);

  const send = useCallback(
    async (tempId: string, input: HighlightInput) => {
      try {
        const saved = await addHighlight(pageId, input);
        if ('queued' in saved) {
          setLocals((l) => l.map((h) => (h.id === tempId ? { ...h, local: 'queued', queuedId: saved.queued } : h)));
          return null;
        }
        markSeen([saved.id]);
        setList((old) => ({ ...old, highlights: [...old.highlights.filter((h) => h.id !== saved.id), saved] }));
        setLocals((l) => l.filter((h) => h.id !== tempId));
        inputs.current.delete(tempId);
        setFailure((f) => (f?.id === tempId ? null : f));
        return saved;
      } catch (e) {
        const code = docsErrorDetail(e)?.code;
        if (code === 'limit_person' || code === 'limit_page') {
          // nothing is cut silently (98): the bubble says why, the passage is not kept
          setLocals((l) => l.filter((h) => h.id !== tempId));
          setLimitHit(code === 'limit_page' ? 'page' : 'person');
          refresh();
          return null;
        }
        setLocals((l) => l.map((h) => (h.id === tempId ? { ...h, local: 'failed' } : h)));
        setFailure({ id: tempId, message: docsErrorDetail(e)?.message ?? '' });
        return null;
      }
    },
    [pageId, markSeen, setList, refresh],
  );

  /** Highlights a passage in a colour (the colour becomes the last used). */
  const add = useCallback(
    (anchor: Omit<HighlightInput, 'color'>, color: HighlightColor) => {
      setLastColor(color);
      writeLastColor(color);
      const id = `local-${(tempSeq += 1)}`;
      const input = { ...anchor, color };
      inputs.current.set(id, input);
      const item: HlItem = {
        id,
        blockId: anchor.blockId,
        endBlockId: anchor.endBlockId ?? null,
        start: anchor.start,
        end: anchor.end,
        quote: anchor.quote,
        prefix: anchor.prefix ?? null,
        suffix: anchor.suffix ?? null,
        color,
        author: me,
        createdAt: new Date().toISOString(),
        threadId: null,
        state: 'ok',
        mine: true,
        canRemove: true,
        local: 'saving',
      };
      setLocals((l) => [...l, item]);
      return send(id, input);
    },
    [me, send],
  );

  /** "Try again" on one that did not save. */
  const retry = useCallback(
    (id: string) => {
      const input = inputs.current.get(id);
      if (!input) return;
      setFailure(null);
      setLocals((l) => l.map((h) => (h.id === id ? { ...h, local: 'saving' } : h)));
      void send(id, input);
    },
    [send],
  );

  /** Drops one that did not save. */
  const discard = useCallback((id: string) => {
    inputs.current.delete(id);
    // one kept for later does not go out any more
    setLocals((l) => {
      const q = l.find((h) => h.id === id)?.queuedId;
      if (q) dropWrite(q);
      return l.filter((h) => h.id !== id);
    });
    setFailure((f) => (f?.id === id ? null : f));
  }, []);

  /** Recolours one of yours. */
  const recolor = useCallback(
    async (id: string, color: HighlightColor) => {
      setLastColor(color);
      writeLastColor(color);
      setList((old) => ({ ...old, highlights: old.highlights.map((h) => (h.id === id ? { ...h, color } : h)) }));
      try {
        const saved = await patchHighlight(id, { color }, pageId);
        if (saved) setList((old) => ({ ...old, highlights: old.highlights.map((h) => (h.id === id ? saved : h)) }));
      } catch {
        refresh();
      }
    },
    [setList, refresh, pageId],
  );

  /** Links the first comment thread written on a highlight. */
  const linkThread = useCallback(
    async (id: string, threadId: string) => {
      setList((old) => ({ ...old, highlights: old.highlights.map((h) => (h.id === id ? { ...h, threadId } : h)) }));
      try {
        await patchHighlight(id, { threadId }, pageId);
      } catch {
        refresh();
      }
    },
    [setList, refresh, pageId],
  );

  /**
   * Puts one of yours on other words (Re-attach, Use the new quote, K 87): it is drawn there again, not "changed".
   * @returns Whether the server took it.
   */
  const reanchor = useCallback(
    async (id: string, anchor: Omit<HighlightInput, 'color' | 'prefix' | 'suffix'>) => {
      const changes = {
        blockId: anchor.blockId,
        endBlockId: anchor.endBlockId ?? null,
        start: anchor.start,
        end: anchor.end,
        quote: anchor.quote,
      };
      setList((old) => ({
        ...old,
        highlights: old.highlights.map((h) => (h.id === id ? { ...h, ...changes, state: 'ok' } : h)),
      }));
      try {
        const saved = await patchHighlight(id, changes, pageId);
        if (saved) setList((old) => ({ ...old, highlights: old.highlights.map((h) => (h.id === id ? saved : h)) }));
        return true;
      } catch {
        refresh();
        return false;
      }
    },
    [setList, refresh, pageId],
  );

  /**
   * "Add to the page" (K 92): the words go into the editor's draft; the shared highlight is "Becoming page text".
   * @returns null when it worked, else the server's words.
   */
  const toPage = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const saved = await highlightToPage(id);
        setList((old) => ({ ...old, highlights: old.highlights.map((h) => (h.id === id ? saved : h)) }));
        return null;
      } catch (e) {
        refresh();
        return docsErrorDetail(e)?.message ?? 'Could not add it to the page.';
      }
    },
    [setList, refresh],
  );

  const offerUndo = useCallback((u: HlUndo) => setUndo(u), []);

  /** Removes one highlight; Undo brings it back for 8 seconds. */
  const remove = useCallback(
    async (h: HlItem, text: string) => {
      if (h.local) {
        discard(h.id);
        return;
      }
      setList((old) => ({ ...old, highlights: old.highlights.filter((x) => x.id !== h.id) }));
      try {
        await removeHighlight(h.id, pageId);
        offerUndo({ ids: [h.id], text });
      } catch {
        refresh();
      }
    },
    [discard, setList, offerUndo, refresh, pageId],
  );

  /** Removes all mine, or (admins) everybody's; Undo for 8 seconds. */
  const clear = useCallback(
    async (scope: 'mine' | 'all') => {
      setList((old) => ({ ...old, highlights: scope === 'all' ? [] : old.highlights.filter((h) => !h.mine) }));
      try {
        const r = await clearHighlights(pageId, scope);
        // offline: it waits to be sent, with no Undo
        if (!r) return;
        const n = r.removed;
        offerUndo({
          ids: r.ids,
          text:
            scope === 'all'
              ? `${n} ${n === 1 ? 'highlight' : 'highlights'} cleared`
              : `${n} ${n === 1 ? 'highlight' : 'highlights'} removed`,
        });
      } catch {
        refresh();
      }
    },
    [pageId, setList, offerUndo, refresh],
  );

  /** Undo: brings back what was just removed. */
  const restore = useCallback(async () => {
    const u = undo;
    setUndo(null);
    if (!u) return;
    try {
      const list = await restoreHighlights(pageId, u.ids);
      if (!list) return;
      markSeen(list.highlights.map((h) => h.id));
      qc.setQueryData(highlightKeys.page(pageId), list);
    } catch {
      refresh();
    }
  }, [undo, pageId, markSeen, qc, refresh]);

  // a highlight kept in this browser while offline is sent when the connection returns (offlineQueue.ts): once its
  // write has left the queue, the server's list carries it
  const waiting = useQueuedWrites(pageId);
  useEffect(() => {
    const ids = new Set(waiting.map((w) => w.id));
    const sent = locals.filter((h) => h.local === 'queued' && h.queuedId && !ids.has(h.queuedId));
    if (!sent.length) return;
    setLocals((l) => l.filter((h) => !sent.includes(h)));
    sent.forEach((h) => inputs.current.delete(h.id));
    refresh();
  }, [waiting, locals, refresh]);

  // Undo stays for 8 seconds (99, 119)
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo]);

  // the limit message goes once the reader is under it again
  useEffect(() => {
    if (limitHit && !limit) setLimitHit(null);
  }, [limit, limitHit]);

  return {
    query: q,
    data,
    /** Drawn on the page and listed. */
    items,
    /** Others' new highlights waiting for "Show". */
    fresh,
    showFresh: () => markSeen(fresh.map((h) => h.id)),
    limit: limit ?? limitHit,
    lastColor,
    add,
    retry,
    discard,
    recolor,
    linkThread,
    reanchor,
    toPage,
    remove,
    clear,
    undo,
    restore,
    dismissUndo: () => setUndo(null),
    failure,
    dismissFailure: () => setFailure(null),
  };
}

/** What {@link useHighlights} gives. */
export type HighlightsModel = ReturnType<typeof useHighlights>;
