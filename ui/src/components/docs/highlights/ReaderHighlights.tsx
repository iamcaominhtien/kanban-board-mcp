/**
 * Highlight while reading (design board "Rich Docs — reading", K 74-128), put together for the reading view: the
 * layer on the page, the colours in the selection bar, the bubble on a highlight, the Highlights button with its
 * count (page bar; the phone's bottom bar), the list (a rail beside the page on a desktop, a drawer on a tablet, a
 * sheet on a phone), the confirms and Undo, the first-time tip and the "N new highlights" chip, Re-attach and Use the
 * new quote (87), Add to the page (92), Send to the team (94), "removed while you read" (126) and the copy of the
 * page a print takes (93). DocsPageView mounts
 * the pieces this hook returns; everything else lives here.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DocsCommentsResult, DocsPage } from '../../../types/docs';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { pickFromSelection, type Pick } from '../comments/SelectionComment';
import { personOf as commentPerson } from '../comments/people';
import { BottomSheet, DocsDrawer } from '../DocsSheets';
import { HL_INK, HlShape, colorName, tintOf } from './colors';
import { HlAvatar, shortAgo } from './HighlightPopover';
import { HlConfirm, HlTip, HlToast, NewChip, PeopleChips, RemovedNote, SaveFailed } from './HighlightDialogs';
import { HighlightPopover } from './HighlightPopover';
import { HighlightsPanel, type HlThreadInfo } from './HighlightsPanel';
import { HlIcon } from './hlIcons';
import { anchorFromRange, newQuoteOf, placeOf as blockPlace } from './hlAnchor';
import { printBody } from './hlPrint';
import { SendToTeamDialog } from './SendToTeam';
import { SelectionSwatches, type AddBlock } from './SelectionSwatches';
import { flashRange, useHighlightLayer, type HlPerson } from './useHighlightLayer';
import { useHighlights, type HlItem } from './useHighlights';
import { useReaderPrefs } from '../readerPrefs';
import './highlights.css';

const TIP_KEY = 'kb.docs.highlightTip';

function tipSeen(): boolean {
  try {
    return window.localStorage.getItem(TIP_KEY) === '1';
  } catch {
    return true;
  }
}

/** What the reading view passes in. */
export interface ReaderHighlightsOpts {
  page: DocsPage;
  /** The rendered page body, and the scrolling pane around it. */
  bodyEl: HTMLElement | null;
  scrollEl: HTMLElement | null;
  layout: DocsLayout;
  /** A rich page is on screen (published or an older version, not a translation): the layer works on its blocks. */
  rich: boolean;
  older: boolean;
  offline: boolean;
  /** Changes when the text on screen changes. */
  revision: string;
  comments: DocsCommentsResult | undefined;
  /** The reader can edit the page. */
  canEdit: boolean;
  commentsOpen: boolean;
  setCommentsOpen: (open: boolean) => void;
  activateThread: (threadId: string) => void;
  /** Opens the page's comment box on a passage. */
  startComment: (p: Pick) => void;
  /** The outline is beside the page (desktop): the list is a tab next to it. */
  outlineBeside: boolean;
  /** Called by the Outline tab (shows the outline again). */
  onOutline?: () => void;
  /**
   * Draws a comment thread (its comments, the reply box, Resolve). With it, a highlight's thread opens in the side
   * panel on a desktop, in place of the list (Reader 114); without it, in the comments panel.
   */
  renderThread?: (threadId: string) => ReactNode;
}

type Confirm =
  | { kind: 'one'; h: HlItem; comments: number }
  | { kind: 'mine'; n: number }
  | { kind: 'to-page'; h: HlItem; comments: number }
  | { kind: 'to-page-all'; items: HlItem[] }
  | { kind: 'all'; n: number; people: { person: HlPerson; n: number }[] };

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

/**
 * The reading view's highlights.
 * @param o - The page, the elements it is drawn in, and the comment flow a note on a highlight goes through.
 */
export function useReaderHighlights(o: ReaderHighlightsOpts) {
  const { page, bodyEl, scrollEl, layout, rich, older, offline, comments } = o;
  const touch = layout !== 'desktop';
  const phone = layout === 'phone';
  const published = page.version > 0;
  // the layer is for signed-in readers of a rich page; a public page never gets here (PublicPageApp)
  const available = rich && !offline && (published || older);
  const me = comments?.me ?? '';
  const m = useHighlights(page.id, available, me);
  const data = m.data;
  const pageOff = page.settings?.highlights === 'off';
  const projectOff = !!data && !data.enabled && !pageOff && /project/i.test(data.reason ?? '');
  const off = pageOff || (!!data && !data.enabled);
  // "Show highlights" in the reader settings: this reader's own view, the layer only (the list stays)
  const [readerPrefs] = useReaderPrefs();
  const viewer = comments?.role === 'viewer';
  const block: AddBlock = older ? 'older' : off ? (projectOff ? 'project-off' : 'off') : viewer ? 'viewer' : null;
  const canAdd = available && !!data && !block && data.canAdd;

  const [panel, setPanel] = useState(false);
  // the highlight whose thread is open in the side panel (desktop, Reader 114)
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [laid, setLaid] = useState<{ order: string[]; missing: Set<string> }>({ order: [], missing: new Set() });
  const missing = laid.missing;
  const [tip, setTip] = useState(false);
  const [dismissedFresh, setDismissedFresh] = useState(false);
  const pendingComment = useRef<string | null>(null);
  /** Re-attach: the highlight whose words the next selection gives (87). */
  const [reattach, setReattach] = useState<HlItem | null>(null);
  /** The highlights chosen for the team (94). */
  const [sending, setSending] = useState<HlItem[] | null>(null);
  /** A plain message at the foot ("Added to the page draft…"). */
  const [note, setNote] = useState<string | null>(null);
  /** Who removed the highlight this reader had open (126). */
  const [removedBy, setRemovedBy] = useState<string | null>(null);
  const watching = useRef<string | null>(null);

  const personOf = useCallback(
    (author: string): HlPerson => {
      const p = commentPerson(author, comments?.members ?? [], me);
      return { name: p.name, initials: p.initials, bg: p.bg, color: p.color };
    },
    [comments, me],
  );

  const ranges = useHighlightLayer({
    root: available ? bodyEl : null,
    items: m.items,
    hidden: off || !readerPrefs.highlights,
    revision: o.revision,
    personOf,
    onOpen: (id, rect) => setOpen({ id, rect }),
    onLayout: ({ order, missing: gone }) => setLaid({ order, missing: new Set(gone) }),
  });

  // the tip shows once, to someone who can highlight (85)
  useEffect(() => {
    if (canAdd && !tipSeen()) setTip(true);
  }, [canAdd]);
  const tipDone = () => {
    setTip(false);
    try {
      window.localStorage.setItem(TIP_KEY, '1');
    } catch {
      // storage blocked: the tip may show again next time
    }
  };

  // the list and the comments panel share the side of the page: one at a time
  useEffect(() => {
    if (o.commentsOpen) setPanel(false);
  }, [o.commentsOpen]);
  useEffect(() => {
    setPanel(false);
    setOpen(null);
    setConfirm(null);
    setReattach(null);
    setSending(null);
    watching.current = null;
  }, [page.id]);
  // the highlight this reader is looking at (its bubble is open)
  useEffect(() => {
    watching.current = open?.id ?? null;
  }, [open]);
  // someone else removed the highlight this reader had open: it goes, and one short message says who (126)
  useEffect(() => {
    const id = watching.current;
    if (!id || !data || data.highlights.some((h) => h.id === id)) return;
    watching.current = null;
    const gone = data.removed?.find((r) => r.id === id);
    if (gone?.by && gone.by !== me) setRemovedBy(gone.by);
    setOpen((o) => (o?.id === id ? null : o));
  }, [data, me]);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);
  useEffect(() => setDismissedFresh(false), [m.fresh.length]);

  const threadOf = useCallback(
    (h: HlItem): HlThreadInfo | null => {
      if (!h.threadId) return null;
      const t = comments?.threads.find((x) => x.id === h.threadId);
      if (!t) return null;
      return { count: t.comments.length, first: t.comments[0]?.body ?? '' };
    },
    [comments],
  );

  // in the page's order; the ones whose words are gone at the end, oldest first
  const ordered = useMemo(() => {
    const at = new Map(laid.order.map((id, i) => [id, i]));
    return [...m.items].sort((a, b) => {
      const ia = at.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const ib = at.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ia !== ib ? ia - ib : a.createdAt.localeCompare(b.createdAt);
    });
  }, [m.items, laid.order]);

  const placeOf = useCallback((h: HlItem) => (bodyEl ? blockPlace(bodyEl, h.blockId) : ''), [bodyEl]);

  /** Highlights the current selection (the bar's colours, Ctrl+Alt+H). */
  const apply = useCallback(
    (color = m.lastColor, pick?: Pick) => {
      if (!bodyEl || !canAdd || m.limit) return;
      const range = pick?.range ?? (window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null);
      if (!range) return;
      const anchor = anchorFromRange(bodyEl, range);
      if (!anchor) return;
      window.getSelection()?.removeAllRanges();
      void m.add(anchor, color);
    },
    [bodyEl, canAdd, m],
  );

  // Ctrl+Alt+H highlights the selection with the last colour (100)
  useEffect(() => {
    if (!canAdd) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.altKey) || !(e.code === 'KeyH' || e.key.toLowerCase() === 'h')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !bodyEl?.contains(sel.anchorNode)) return;
      e.preventDefault();
      apply();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAdd, bodyEl, apply]);

  const go = useCallback(
    (h: HlItem) => {
      const r = ranges.current.get(h.id);
      if (!r) return;
      if (touch) setPanel(false);
      flashRange(r, scrollEl);
    },
    [ranges, scrollEl, touch],
  );

  /** A note on a highlight is a comment thread: its thread, or a new one on its words. */
  const commentOn = useCallback(
    (h: HlItem) => {
      setOpen(null);
      if (h.threadId && comments?.threads.some((t) => t.id === h.threadId)) {
        // desktop: the thread takes the list's place beside the page, with a way back (Reader 114)
        if (!touch && o.outlineBeside && o.renderThread) {
          setThreadFor(h.id);
          setPanel(true);
          return;
        }
        setPanel(false);
        o.activateThread(h.threadId);
        return;
      }
      const r = ranges.current.get(h.id);
      if (!r || !bodyEl) return;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r.cloneRange());
      const p = pickFromSelection(bodyEl);
      if (!p) return;
      pendingComment.current = h.id;
      o.startComment(p);
    },
    [comments, o, ranges, bodyEl, touch],
  );

  /** DocsPageView tells this when the comment box posted its thread (null: it was cancelled). */
  const threadCreated = useCallback(
    (threadId: string | null) => {
      const id = pendingComment.current;
      pendingComment.current = null;
      if (id && threadId) void m.linkThread(id, threadId);
    },
    [m],
  );

  const askRemove = useCallback(
    (h: HlItem) => {
      setOpen(null);
      watching.current = null;
      const n = threadOf(h)?.count ?? 0;
      // your own without a thread goes at once, with Undo; one with a thread, or someone else's, asks first (99, 118)
      if (h.mine && n === 0) void m.remove(h, `Highlight removed · ${colorName(h.color)}`);
      else setConfirm({ kind: 'one', h, comments: n });
    },
    [m, threadOf],
  );

  const askClearAll = useCallback(() => {
    const counts = new Map<string, number>();
    for (const h of m.items) counts.set(h.author, (counts.get(h.author) ?? 0) + 1);
    const people = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => ({ person: personOf(a), n }));
    setConfirm({ kind: 'all', n: m.items.length, people });
  }, [m.items, personOf]);

  /** Re-attach with the current selection (the bar's "Attach here"). */
  const attachHere = useCallback(
    (pick?: Pick) => {
      const h = reattach;
      const range = pick?.range ?? (window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null);
      if (!h || !bodyEl || !range) return;
      const anchor = anchorFromRange(bodyEl, range);
      if (!anchor) return;
      window.getSelection()?.removeAllRanges();
      setReattach(null);
      void m.reanchor(h.id, anchor);
    },
    [reattach, bodyEl, m],
  );

  const newQuote = useCallback(
    (h: HlItem) => {
      const anchor = bodyEl ? newQuoteOf(bodyEl, h) : null;
      return anchor ? () => void m.reanchor(h.id, anchor) : null;
    },
    [bodyEl, m],
  );

  // Add to the page: people who can edit a rich page, on a highlight whose words are there (75.4, 92)
  const canToPage = o.canEdit && !older && published && !off;
  const toPageable = useCallback(
    (h: HlItem) => canToPage && !h.local && h.state !== 'becoming' && !missing.has(h.id),
    [canToPage, missing],
  );
  const askToPage = useCallback(
    (h: HlItem) => {
      setOpen(null);
      setConfirm({ kind: 'to-page', h, comments: threadOf(h)?.count ?? 0 });
    },
    [threadOf],
  );
  const doToPage = useCallback(
    async (list: HlItem[]) => {
      let failed: string | null = null;
      for (const h of list) failed = (await m.toPage(h.id)) ?? failed;
      setNote(
        failed ??
          (list.length === 1
            ? 'Added to the page draft. Readers see it when you publish.'
            : `${list.length} highlights added to the page draft. Readers see them when you publish.`),
      );
    },
    [m],
  );

  const copyAll = useCallback(() => {
    const lines = ordered.map((h) => `“${h.quote}” — ${colorName(h.color)}, ${personOf(h.author).name}`);
    copy(`${page.title}\n\n${lines.join('\n')}`);
  }, [ordered, personOf, page.title]);

  const total = off ? 0 : m.items.length;
  const offReason =
    block === 'off' || block === 'project-off'
      ? projectOff
        ? 'An admin turned highlights off for this project.'
        : 'Highlights are off for this page. People who can edit the page can turn them on in Page settings › Access.'
      : null;

  const togglePanel = () => {
    if (off) return;
    setPanel((v) => {
      if (!v) o.setCommentsOpen(false);
      return !v;
    });
  };

  const headerButton: ReactNode =
    available && !phone ? (
      <button
        type="button"
        className="st-btn dk-hbtn dk-hico"
        aria-label={`Highlights, ${total}`}
        aria-pressed={panel}
        aria-disabled={off || undefined}
        title={offReason ?? 'Highlights'}
        data-testid="highlights-button"
        onClick={togglePanel}
        style={off ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      >
        <HlIcon name="marker" size={16} />
        {!off && (
          <span className="dc-btn-count" data-testid="highlights-count">
            {total}
          </span>
        )}
      </button>
    ) : null;

  const readBarButton: ReactNode =
    available && phone ? (
      <button
        type="button"
        className="dk-readbar-btn"
        aria-expanded={panel}
        aria-disabled={off || undefined}
        title={offReason ?? undefined}
        onClick={togglePanel}
        data-testid="read-highlights"
        style={off ? { opacity: 0.5 } : undefined}
      >
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <HlIcon name="marker" size={20} stroke={1.8} />
          {!off && total > 0 && <span className="hl-readbar-count">{total}</span>}
        </span>
        Highlights
      </button>
    ) : null;

  const tabs = (active: 'outline' | 'highlights') => (
    <div className="hl-tabs" role="tablist" aria-label="Beside the page">
      <button
        type="button"
        role="tab"
        aria-selected={active === 'outline'}
        className={active === 'outline' ? 'is-on' : ''}
        onClick={() => {
          setPanel(false);
          o.onOutline?.();
        }}
        data-testid="tab-outline"
      >
        Outline
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'highlights'}
        aria-disabled={off || undefined}
        title={offReason ?? undefined}
        className={active === 'highlights' ? 'is-on' : ''}
        onClick={() => !off && setPanel(true)}
        data-testid="tab-highlights"
      >
        Highlights
        {!off && <span className="hl-tab-count">{total}</span>}
      </button>
    </div>
  );

  const list = (withTabs: boolean) => (
    <HighlightsPanel
      items={ordered}
      missing={missing}
      personOf={personOf}
      placeOf={placeOf}
      threadOf={threadOf}
      loading={m.query.isLoading}
      canClear={!!data?.canClear}
      noComment={viewer || older}
      touch={touch}
      tabs={withTabs ? tabs('highlights') : null}
      onClose={() => setPanel(false)}
      onGo={go}
      onComments={commentOn}
      onRemove={askRemove}
      onCopyQuote={(h) => copy(h.quote)}
      onCopyAll={copyAll}
      onRemoveAllMine={() => setConfirm({ kind: 'mine', n: m.items.filter((h) => h.mine && !h.local).length })}
      onClearAll={askClearAll}
      onReattach={(h) => {
        setReattach(h);
        if (touch) setPanel(false);
      }}
      newQuote={newQuote}
      onAddAllToPage={
        canToPage && m.items.some(toPageable)
          ? () => setConfirm({ kind: 'to-page-all', items: m.items.filter(toPageable) })
          : undefined
      }
      onSend={older ? undefined : (chosen) => setSending(chosen)}
    />
  );

  const threadItem = threadFor ? m.items.find((h) => h.id === threadFor && h.threadId) : null;
  const threadView = (h: HlItem) => {
    const person = personOf(h.author);
    return (
      <div className="hl-thread" data-testid="hl-thread">
        {tabs('highlights')}
        <button
          type="button"
          className="hl-thread-back"
          onClick={() => setThreadFor(null)}
          data-testid="hl-thread-back"
        >
          <svg
            aria-hidden="true"
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Highlights
        </button>
        <div className="hl-thread-quote">
          <span className="hl-thread-shape">
            <HlShape color={h.color} size={12} />
          </span>
          <span>
            <span className="hl-row-quote" style={{ background: tintOf(h.color), borderBottomColor: HL_INK[h.color] }}>
              “{h.quote}”
            </span>
            <span className="hl-thread-who">
              {colorName(h.color)} · {h.mine ? 'You' : person.name} · {shortAgo(h.createdAt)}
            </span>
          </span>
        </div>
        {h.threadId && o.renderThread?.(h.threadId)}
      </div>
    );
  };
  const rail: ReactNode =
    available && panel && !touch ? (
      <aside className="hl-rail" aria-label="Highlights">
        {threadItem ? threadView(threadItem) : list(o.outlineBeside)}
      </aside>
    ) : null;
  const outlineTabs: ReactNode = available && o.outlineBeside ? tabs('outline') : null;

  const openItem = open ? m.items.find((h) => h.id === open.id) : null;
  const freshPeople = useMemo(() => {
    const names = [...new Set(m.fresh.map((h) => h.author))];
    return names.map(personOf);
  }, [m.fresh, personOf]);

  const strips: ReactNode = available ? (
    <>
      {tip && <HlTip touch={touch} onDone={tipDone} />}
      {reattach && (
        <div className="hl-tip hl-reattach-strip" data-testid="hl-reattach-strip">
          <span className="hl-tip-ico">
            <HlIcon name="link" size={14} stroke={2} color="#8A5A00" />
          </span>
          <div style={{ flex: 1 }}>
            <b>Re-attach the highlight.</b> Select the words it should be on, then Attach here. Its comments stay with
            it.
          </div>
          <button type="button" className="st-btn st-btn-sm hl-tip-ok" onClick={() => setReattach(null)}>
            Cancel
          </button>
        </div>
      )}
      {!off && m.fresh.length > 0 && !dismissedFresh && (
        <NewChip
          people={freshPeople}
          count={m.fresh.length}
          onShow={() => {
            const first = m.fresh[0]?.id;
            m.showFresh();
            // once drawn, scroll to the first and mark it
            window.setTimeout(() => {
              const r = first ? ranges.current.get(first) : null;
              if (r) flashRange(r, scrollEl);
            }, 60);
          }}
          onDismiss={() => {
            m.showFresh();
            setDismissedFresh(true);
          }}
        />
      )}
    </>
  ) : null;

  const confirmBox = confirm ? (
    confirm.kind === 'one' ? (
      <HlConfirm
        touch={touch}
        width={440}
        title={confirm.h.mine ? 'Remove this highlight?' : `Remove ${personOf(confirm.h.author).name}’s highlight?`}
        sub={`${colorName(confirm.h.color)} · “${confirm.h.quote}”`}
        action="Remove highlight"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const h = confirm.h;
          setConfirm(null);
          void m.remove(h, `Highlight removed · ${colorName(h.color)}`);
        }}
      >
        {confirm.h.mine ? (
          <>
            It has {confirm.comments === 1 ? '1 comment' : `${confirm.comments} comments`}.{' '}
            {confirm.comments === 1 ? 'The comment stays' : 'The comments stay'} on the page, with the quote, so nothing
            anyone wrote is lost.
          </>
        ) : (
          <>
            You can remove it because you can edit this page.
            {confirm.comments > 0 && (
              <>
                {' '}
                <b>
                  {confirm.comments === 1 ? 'Its comment stays' : `Its ${confirm.comments} comments stay`} on the page.
                </b>
              </>
            )}
          </>
        )}
      </HlConfirm>
    ) : confirm.kind === 'to-page' ? (
      <HlConfirm
        touch={touch}
        width={500}
        icon="pen"
        primary
        title="Add to the page?"
        sub="Needs edit rights. People who can only read do not get this option."
        action="Add to the page"
        testId="hl-to-page-confirm"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const h = confirm.h;
          setConfirm(null);
          void doToPage([h]);
        }}
      >
        <div className="hl-dlg-quote">
          <span style={{ background: tintOf(confirm.h.color), borderBottom: `2px dotted ${HL_INK[confirm.h.color]}` }}>
            “{confirm.h.quote}”
          </span>
          <div className="hl-dlg-quote-who">
            <HlAvatar person={personOf(confirm.h.author)} />
            Highlighted by {confirm.h.mine ? 'you' : personOf(confirm.h.author).name}
            {confirm.comments > 0 && ` · ${confirm.comments === 1 ? '1 comment' : `${confirm.comments} comments`}`}
          </div>
        </div>
        <div className="hl-dlg-line">
          <HlIcon name="pen" size={15} stroke={2.2} color="#244E78" />
          <span>
            The words become a real highlight in the page text, in the colour {colorName(confirm.h.color)}. This is an
            edit: it goes into the page draft, and readers see it when you publish.
          </span>
        </div>
        <div className="hl-dlg-line">
          <HlIcon name="marker" size={15} stroke={2.2} color="#5B6B60" />
          <span>
            The shared highlight stays, marked <b>Becoming page text</b>, until you publish the page. Then the page text
            carries it and the shared one goes away. Cancel keeps everything as it is.
          </span>
        </div>
        {confirm.comments > 0 && (
          <div className="hl-dlg-line">
            <HlIcon name="comment" size={15} stroke={2.2} color="#2E6F40" />
            <span>
              {confirm.comments === 1 ? 'The comment stays' : `The ${confirm.comments} comments stay`} on the page,
              anchored to the same words.
            </span>
          </div>
        )}
      </HlConfirm>
    ) : confirm.kind === 'to-page-all' ? (
      <HlConfirm
        touch={touch}
        width={500}
        icon="pen"
        primary
        title="Add all to the page?"
        sub="Needs edit rights. People who can only read do not get this option."
        action={`Add ${confirm.items.length} to the page`}
        testId="hl-to-page-confirm"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const list = confirm.items;
          setConfirm(null);
          void doToPage(list);
        }}
      >
        <div>
          The words of <b>{confirm.items.length === 1 ? '1 highlight' : `${confirm.items.length} highlights`}</b> become
          real highlights in the page text, in their colours. This is an edit: it goes into the page draft, and readers
          see it when you publish. The shared highlights stay, marked <b>Becoming page text</b>, until then; all
          comments stay.
        </div>
      </HlConfirm>
    ) : confirm.kind === 'mine' ? (
      <HlConfirm
        touch={touch}
        title="Remove all my highlights?"
        sub={page.title}
        action={`Remove ${confirm.n} ${confirm.n === 1 ? 'highlight' : 'highlights'}`}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void m.clear('mine');
        }}
      >
        This removes <b>{confirm.n === 1 ? 'your highlight' : `all ${confirm.n} of your highlights`}</b> on this page.
        Other people’s highlights stay. Comments on your highlights stay on the page.
      </HlConfirm>
    ) : (
      <HlConfirm
        touch={touch}
        width={480}
        title="Clear all highlights on this page?"
        sub="Admins only"
        action={`Clear ${confirm.n} ${confirm.n === 1 ? 'highlight' : 'highlights'}`}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void m.clear('all');
        }}
      >
        <div>
          This removes <b>{confirm.n === 1 ? 'the 1 highlight' : `all ${confirm.n} highlights`}</b> on this page:{' '}
          {confirm.people.map((p) => `${p.n} by ${p.person.name}`).join(', ')}. The page text does not change and all
          comments stay.
        </div>
        <PeopleChips people={confirm.people} />
      </HlConfirm>
    )
  ) : null;

  const overlays: ReactNode = available ? (
    <>
      {openItem && open && (
        <HighlightPopover
          h={openItem}
          person={personOf(openItem.author)}
          rect={open.rect}
          comments={threadOf(openItem)?.count ?? 0}
          canEdit={o.canEdit}
          touch={touch}
          noComment={viewer || older}
          onRecolor={(c) => void m.recolor(openItem.id, c)}
          onCopy={() => {
            copy(openItem.quote);
            setOpen(null);
          }}
          onComment={() => commentOn(openItem)}
          onLink={() => {
            const url = `${window.location.href.replace(/#.*$/, '')}#block-${openItem.blockId}`;
            copy(url);
            setOpen(null);
          }}
          onRemove={() => askRemove(openItem)}
          onToPage={toPageable(openItem) ? () => askToPage(openItem) : undefined}
          onClose={() => setOpen(null)}
        />
      )}
      {panel && touch && !phone && (
        // Reader 80: a 400 px drawer from the right over a light scrim
        <DocsDrawer
          side="right"
          width={400}
          label="Highlights"
          onClose={() => setPanel(false)}
          testId="hl-drawer"
          look="read"
        >
          {list(false)}
        </DocsDrawer>
      )}
      {panel && phone && (
        <BottomSheet label="Highlights" hideTitle onClose={() => setPanel(false)} testId="hl-sheet" look="read">
          {list(false)}
        </BottomSheet>
      )}
      {confirmBox}
      {sending && (
        <SendToTeamDialog
          pageId={page.id}
          pageTitle={page.title}
          items={sending}
          personOf={personOf}
          threadOf={threadOf}
          touch={touch}
          onClose={() => setSending(null)}
        />
      )}
      {removedBy && <RemovedNote person={personOf(removedBy)} onClose={() => setRemovedBy(null)} />}
      {note && !m.undo && <HlToast text={note} onClose={() => setNote(null)} testId="hl-note" />}
      {m.undo && <HlToast text={m.undo.text} onUndo={() => void m.restore()} onClose={m.dismissUndo} />}
      {m.failure && (
        <SaveFailed
          onRetry={() => m.failure && m.retry(m.failure.id)}
          onClose={() => {
            if (m.failure) m.discard(m.failure.id);
          }}
        />
      )}
    </>
  ) : null;

  // when adding is off the colours still show, greyed, with the reason (75, 98, 120)
  const selectable = available && !!data;
  const selectionLead = selectable
    ? (pick: Pick, close: () => void) =>
        reattach ? (
          <button
            type="button"
            className="hl-attach-here"
            onClick={() => {
              attachHere(pick);
              close();
            }}
            data-testid="hl-attach-here"
          >
            <HlIcon name="link" size={16} stroke={2} />
            Attach here
          </button>
        ) : (
          <SelectionSwatches
            lastColor={m.lastColor}
            block={block}
            limit={m.limit}
            card
            onApply={(c) => {
              apply(c, pick);
              close();
            }}
          />
        )
    : undefined;
  // the colours come in the reader's card (Reader 74-75); re-attaching keeps the slim bar of its one button
  const selectionCard = selectable && !reattach;

  /**
   * The copy of the page body a print takes (93): the reader's markers out and, with "Include highlights" on, the
   * highlights drawn in with their markers and the list at the foot.
   * @param body - The rendered page body.
   * @param include - "Include highlights" is on.
   */
  const printCopy = (body: HTMLElement | null, include: boolean) =>
    printBody(body, include && available && !off, m.items, personOf, (h) => threadOf(h)?.count ?? 0);

  return {
    /** The layer is on for this page. */
    available,
    /** Someone can select to see the bar's colours (greyed with the reason when adding is off). */
    selectable,
    panelOpen: panel,
    setPanelOpen: setPanel,
    headerButton,
    readBarButton,
    strips,
    rail,
    outlineTabs,
    overlays,
    selectionLead,
    selectionCard,
    threadCreated,
    printCopy,
  };
}
