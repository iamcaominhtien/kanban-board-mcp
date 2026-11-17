/**
 * The review of an AI team's suggestions on the open page (design "AI teams on rich pages", A, B, C and I): the
 * pending list, the one the stepper is on, what was looked at ("Look at it" on a block that changed since the team
 * wrote it), what failed (Retry), Accept / Reject on one block, Accept all / Reject all, Undo after an accept, and
 * the tally that the quiet chip shows once everything is settled. The page's reader asks it how to draw each block
 * (`wrap`, `lead`, `tail`); the chip, the bar and the frames read it from {@link ReviewContext}.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { docsErrorDetail, useRestoreVersion } from '../../../api/docs';
import { usePageWork } from '../../../api/docsWork';
import { extractError } from '../../../api/extractError';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage, RichDoc } from '../../../types/docs';
import { useToast } from '../../Toast';
import { useSettleSuggestions, useSuggestions, type DocsSuggestion } from './api';
import { suggestionsWord } from './describe';

/** The words under a block whose Accept did not go through. */
export const ACCEPT_FAILED =
  'Couldn’t accept this change. The page was not saved. Check your connection and try again.';
/** The words when Reject did not go through. */
export const REJECT_FAILED = 'Couldn’t reject this change. Check your connection and try again.';

/** What the review of a page holds. */
export interface Review {
  page: DocsPage;
  /** The published page the suggestions are on. */
  doc: RichDoc | null;
  /** Pending suggestions, in page order. */
  list: DocsSuggestion[];
  /** Index of the suggestion the stepper is on. */
  current: number;
  /** Puts the stepper on a suggestion and scrolls the page to it. */
  focus: (id: string) => void;
  /** Moves the stepper one suggestion back (-1) or on (1). */
  step: (by: -1 | 1) => void;
  /** Suggestions whose change since the team wrote it the reviewer has looked at: Accept is on for them. */
  looked: ReadonlySet<string>;
  lookAt: (id: string) => void;
  /** Why the last Accept or Reject of a suggestion failed, by id. */
  errors: Readonly<Record<string, string>>;
  /** The suggestion being settled now, `all` for Accept all / Reject all, or null. */
  busy: string | null;
  online: boolean;
  /** The reader can edit the page: Accept and Reject are offered. */
  canEdit: boolean;
  layout: DocsLayout;
  accept: (s: DocsSuggestion) => Promise<void>;
  reject: (s: DocsSuggestion) => Promise<void>;
  acceptAll: () => Promise<void>;
  rejectAll: () => Promise<void>;
  /** What was settled while the page is open; set once nothing waits any more. */
  settled: Settled | null;
  /** The ticket of a run, when the page's work list knows it. */
  ticketOf: (runId: string | null) => string | null;
  /** The confirmation open now. */
  confirm: 'accept-all' | 'reject-all' | null;
  setConfirm: (c: 'accept-all' | 'reject-all' | null) => void;
  /** Phone: the suggestion whose sheet is open, and the list sheet. */
  sheet: string | null;
  setSheet: (id: string | null) => void;
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
  onOpenTicket?: (ticketId: string) => void;
  onCompare?: (from: number, to: number) => void;
  onHistory?: () => void;
}

/** What was settled while the page was open. */
export interface Settled {
  accepted: number;
  rejected: number;
  /** The team of the last one settled and its run. */
  author: string;
  runId: string | null;
  /** The page's version before the first accept (for "See changes"). */
  fromVersion: number | null;
}

/** The open page's review, given to the chip, the bar and the frames. */
export const ReviewContext = createContext<Review | null>(null);

/** The open page's review, or null outside a page with suggestions. */
export function useReview(): Review | null {
  return useContext(ReviewContext);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Options of {@link useSuggestionReview}. */
export interface ReviewOptions {
  page: DocsPage;
  projectId: string;
  /** The published page as rich JSON; null on a Markdown page. */
  doc: RichDoc | null;
  /** False skips the request (a draft, an offline copy, an older version, a translation). */
  enabled: boolean;
  canEdit: boolean;
  layout: DocsLayout;
  onOpenTicket?: (ticketId: string) => void;
  onCompare?: (from: number, to: number) => void;
  onHistory?: () => void;
  /** Draws one suggestion on the page (SuggestionFrame); given here so the hook stays free of the frame's imports. */
  frame: (s: DocsSuggestion, rendered: ReactNode) => ReactNode;
}

/**
 * The review of the open page's suggestions, and what the reader needs to draw them.
 * @returns `review` (null while nothing waits and nothing was settled), and `wrap`, `lead`, `tail` for RichDocView.
 */
export function useSuggestionReview(o: ReviewOptions) {
  const { page, projectId, doc, enabled, canEdit, layout } = o;
  const toast = useToast();
  const q = useSuggestions(page.id, enabled);
  const settle = useSettleSuggestions(page.id, projectId);
  const restore = useRestoreVersion(projectId);
  const work = usePageWork(enabled ? page.id : null);
  const list = useMemo(() => (enabled ? (q.data?.suggestions ?? []) : []), [enabled, q.data]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [looked, setLooked] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [confirm, setConfirm] = useState<'accept-all' | 'reject-all' | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // another page: a fresh review
  useEffect(() => {
    setCurrentId(null);
    setLooked(new Set());
    setErrors({});
    setSettled(null);
    setSheet(null);
    setListOpen(false);
  }, [page.id]);

  const index = Math.max(
    0,
    list.findIndex((s) => s.id === currentId),
  );
  const live = useRef({ list, page, toast });
  live.current = { list, page, toast };

  const focus = useCallback((id: string) => {
    setCurrentId(id);
    // after the frame has re-rendered as the current one
    window.setTimeout(() => {
      document
        .querySelector<HTMLElement>(`[data-sg-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 0);
  }, []);

  const step = useCallback(
    (by: -1 | 1) => {
      const all = live.current.list;
      if (!all.length) return;
      const next = all[(index + by + all.length) % all.length];
      focus(next.id);
      if (sheet) setSheet(next.id);
    },
    [index, focus, sheet],
  );

  const lookAt = useCallback((id: string) => setLooked((prev) => new Set(prev).add(id)), []);

  const note = useCallback((s: DocsSuggestion, what: 'accepted' | 'rejected', n = 1, fromVersion?: number) => {
    setSettled((prev) => ({
      accepted: (prev?.accepted ?? 0) + (what === 'accepted' ? n : 0),
      rejected: (prev?.rejected ?? 0) + (what === 'rejected' ? n : 0),
      author: s.author,
      runId: s.runId,
      fromVersion: prev?.fromVersion ?? fromVersion ?? null,
    }));
  }, []);

  const undo = useCallback(
    async (version: number) => {
      try {
        const p = await restore.mutateAsync({ pageId: live.current.page.id, version });
        live.current.toast.success(
          `Restored v${version}`,
          `The page is v${p.version} now, with the text of v${version}.`,
        );
      } catch (e) {
        live.current.toast.error("Couldn't undo the change", extractError(e));
      }
    },
    [restore],
  );

  const setError = (id: string, text: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (text) next[id] = text;
      else delete next[id];
      return next;
    });

  const accept = useCallback(
    async (s: DocsSuggestion) => {
      const stale = s.stale && !looked.has(s.id);
      if (stale || busy) return;
      const total = live.current.list.length;
      const before = live.current.page.version;
      setBusy(s.id);
      setError(s.id, null);
      try {
        await settle.accept.mutateAsync({ ids: [s.id], ...(s.stale ? { looked: true } : {}) });
        note(s, 'accepted', 1, before);
        live.current.toast.success(`Accepted 1 of ${suggestionsWord(total)}`, `Saved as v${before + 1}.`, undefined, {
          label: 'Undo',
          onClick: () => void undo(before),
        });
      } catch (e) {
        const d = docsErrorDetail(e);
        if (d?.code === 'suggestion_stale') {
          // it changed under the reviewer since the list was read: look at it first
          setLooked((prev) => {
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
          void q.refetch();
          live.current.toast.info('Changed since the team wrote it', 'Look at it first, then accept it.');
        } else if (d?.code === 'suggestion_settled' || d?.status === 404) {
          void q.refetch();
          live.current.toast.info('Already settled', 'Someone accepted or rejected this suggestion.');
        } else {
          setError(s.id, ACCEPT_FAILED);
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, looked, note, q, settle.accept, undo],
  );

  const reject = useCallback(
    async (s: DocsSuggestion) => {
      if (busy) return;
      const total = live.current.list.length;
      setBusy(s.id);
      setError(s.id, null);
      try {
        await settle.reject.mutateAsync([s.id]);
        note(s, 'rejected');
        live.current.toast.success(
          `Rejected 1 of ${suggestionsWord(total)}`,
          'The page stays as it is, so there is nothing to undo.',
        );
      } catch {
        setError(s.id, REJECT_FAILED);
      } finally {
        setBusy(null);
      }
    },
    [busy, note, settle.reject],
  );

  const acceptAll = useCallback(async () => {
    if (busy) return;
    const all = live.current.list;
    const before = live.current.page.version;
    setBusy('all');
    try {
      const r = await settle.acceptAll.mutateAsync();
      setConfirm(null);
      const last = all.filter((s) => !s.stale).pop() ?? all[0];
      if (r.accepted && last) note(last, 'accepted', r.accepted, before);
      const skipped = r.skippedStale
        ? `${r.skippedStale} changed since the team wrote it and ${r.skippedStale === 1 ? 'is' : 'are'} still waiting for you.`
        : `Saved as v${before + 1}.`;
      if (r.accepted) {
        live.current.toast.success(`Accepted ${r.accepted} of ${suggestionsWord(all.length)}`, skipped, undefined, {
          label: 'Undo',
          onClick: () => void undo(before),
        });
      } else {
        live.current.toast.info('Nothing was accepted', skipped);
      }
    } catch (e) {
      live.current.toast.error("Couldn't accept the suggestions", docsErrorDetail(e)?.message ?? ACCEPT_FAILED);
    } finally {
      setBusy(null);
    }
  }, [busy, note, settle.acceptAll, undo]);

  const rejectAll = useCallback(async () => {
    if (busy) return;
    const all = live.current.list;
    setBusy('all');
    try {
      const r = await settle.reject.mutateAsync([]);
      setConfirm(null);
      if (all[0]) note(all[all.length - 1], 'rejected', r.rejected);
      live.current.toast.success(
        `Rejected ${suggestionsWord(r.rejected)}`,
        'The page stays as it is, so there is nothing to undo.',
      );
    } catch (e) {
      live.current.toast.error("Couldn't reject the suggestions", docsErrorDetail(e)?.message ?? REJECT_FAILED);
    } finally {
      setBusy(null);
    }
  }, [busy, note, settle.reject]);

  const tickets = work.data?.tickets;
  const ticketOf = useCallback(
    (runId: string | null) => (runId ? (tickets?.find((t) => t.run?.id === runId)?.id ?? null) : null),
    [tickets],
  );

  // a sheet whose suggestion was settled closes
  useEffect(() => {
    if (sheet && !list.some((s) => s.id === sheet)) setSheet(null);
  }, [sheet, list]);

  const review: Review | null =
    list.length || settled
      ? {
          page,
          doc,
          list,
          current: index,
          focus,
          step,
          looked,
          lookAt,
          errors,
          busy,
          online,
          canEdit,
          layout,
          accept,
          reject,
          acceptAll,
          rejectAll,
          settled: list.length ? null : settled,
          ticketOf,
          confirm,
          setConfirm,
          sheet,
          setSheet,
          listOpen,
          setListOpen,
          onOpenTicket: o.onOpenTicket,
          onCompare: o.onCompare,
          onHistory: o.onHistory,
        }
      : null;

  // where each suggestion goes on the page: on its block, after its block, or (block gone) at the end
  const frame = useRef(o.frame);
  frame.current = o.frame;
  const placed = useMemo(() => {
    const ids = new Set((doc?.content ?? []).map((b) => str(b.attrs?.blockId)).filter(Boolean));
    const onBlock = new Map<string, DocsSuggestion>();
    const after = new Map<string, DocsSuggestion[]>();
    const unplaced: DocsSuggestion[] = [];
    for (const s of list) {
      if (s.kind === 'insert') {
        const key = s.afterBlockId ?? '';
        if (key && !ids.has(key)) unplaced.push(s);
        else after.set(key, [...(after.get(key) ?? []), s]);
      } else if (s.blockId && ids.has(s.blockId) && !onBlock.has(s.blockId)) onBlock.set(s.blockId, s);
      else unplaced.push(s);
    }
    return { onBlock, after, unplaced };
  }, [doc, list]);
  // the reader renders every block again when `wrap` changes: it changes only with where suggestions sit
  // (and with the suggestions themselves: a frame gets its suggestion when the reader renders the block)
  const shape = list.length ? list.map((s) => `${s.id}${s.stale ? '!' : ''}`).join(',') : '';
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const wrap = useMemo(() => {
    if (!shape) return undefined;
    return (node: RichDoc, rendered: ReactNode): ReactNode => {
      const id = str(node.attrs?.blockId);
      const p = placedRef.current;
      const own = id ? p.onBlock.get(id) : undefined;
      const added = id ? (p.after.get(id) ?? []) : [];
      if (!own && !added.length) return rendered;
      return (
        <>
          {own ? frame.current(own, rendered) : rendered}
          {added.map((s) => frame.current(s, null))}
        </>
      );
    };
  }, [shape]);
  const lead = placed.after.get('')?.map((s) => frame.current(s, null));
  const tail = placed.unplaced.length ? placed.unplaced.map((s) => frame.current(s, null)) : null;

  return { review, wrap, lead, tail };
}
