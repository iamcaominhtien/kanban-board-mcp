/**
 * The page-level parts of a review (design "AI teams on rich pages", A 1–5, B 8, C 12–14, I 51–55): the header chip
 * ("Docs team suggested 3 edits and 1 new block · 2 min ago", or "No suggestions waiting"), the review bar with its
 * stepper and Accept all / Reject all (each asks first), the note once everything is settled, and on a phone the
 * list sheet and the sheet of one suggestion.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { absoluteTime, relativeTime } from '../../../utils/relativeTime';
import { BottomSheet } from '../DocsSheets';
import { DOCS_SCRIM, useEscape } from '../docsShared';
import type { DocsSuggestion } from './api';
import { authorsOf, chipLine, describeSuggestion, placeName, suggestionsWord } from './describe';
import { SgIcon, Spark, rowIcon, type SgIconName } from './sgIcons';
import { ChangeTags, ErrorMsg, StaleMsg, StaleNote, SuggestionActions, SuggestionBody } from './SuggestionFrame';
import { useReview, type Review } from './useSuggestionReview';
import './suggestions.css';

const latest = (list: DocsSuggestion[]) => list.reduce((a, s) => (s.createdAt > a ? s.createdAt : a), '');

/**
 * The header chip: what the team suggested and when; quiet once nothing waits. Once everything was settled while
 * the page is open, the quiet chip opens a card with what was decided, the run's Report and the changes.
 */
export function SuggestionChip() {
  const review = useReview();
  const settled = review?.settled ?? null;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  // a fresh settlement opens its card once
  useEffect(() => setOpen(!!settled), [settled]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);
  if (!review) return null;
  if (!review.list.length) {
    return (
      <span className="sg-hchip-wrap" ref={wrap}>
        <button
          type="button"
          className="sg-hchip sg-hchip-quiet"
          data-testid="sg-chip-quiet"
          aria-expanded={settled ? open : undefined}
          disabled={!settled}
          onClick={() => setOpen((v) => !v)}
        >
          <Spark size={13} color="#5B6B60" />
          <span>No suggestions waiting</span>
          {settled && <SgIcon name={open ? 'chevUp' : 'chevDown'} size={12} sw={2.6} color="#5B6B60" />}
        </button>
        {settled && open && <SettledNote review={review} />}
      </span>
    );
  }
  const when = latest(review.list);
  return (
    <button
      type="button"
      className={`sg-hchip${review.layout === 'phone' ? ' sg-hchip-touch' : ''}`}
      data-testid="sg-chip"
      title={when ? absoluteTime(when) : undefined}
      onClick={() => {
        if (review.layout === 'phone') review.setListOpen(true);
        else review.focus(review.list[review.current]?.id ?? review.list[0].id);
      }}
    >
      <Spark size={13} color="#5B3AA6" />
      <span>
        {chipLine(review.list)}
        {when && review.layout !== 'phone' ? ` · ${relativeTime(when)}` : ''}
      </span>
      <SgIcon name="chevDown" size={12} sw={2.6} color="#5B3AA6" />
    </button>
  );
}

/** What a row says a suggestion does: its first formatting change ("Alignment: left → centre") or its label. */
function rowWhat(s: DocsSuggestion): { icon: SgIconName; what: string; change: string } {
  const view = describeSuggestion(s);
  const c = view.changes[0];
  const type = (view.after ?? view.before)?.type;
  const icon = rowIcon(view.label === 'Text edited' ? null : (c?.what ?? null), type);
  const change = c
    ? `${c.what}: ${c.from} → ${c.to}`
    : view.label === 'New block' && view.detail
      ? `New ${view.detail.toLowerCase()}`
      : view.label;
  return { icon, what: view.label === 'Format' && c ? c.what : view.label, change };
}

/** One row of a confirmation: the block's icon, where it is, and what it does (or that it changed since). */
function Row({ s, review }: { s: DocsSuggestion; review: Review }) {
  const r = rowWhat(s);
  return (
    <li className="sg-row">
      <SgIcon name={r.icon} size={14} color="#5B3AA6" />
      <span className="sg-row-place">{placeName(s, review.doc)}</span>
      {s.stale ? (
        <span className="sg-tag sg-tag-stale">Changed since the team wrote it</span>
      ) : (
        <span className="sg-row-what">{r.what}</span>
      )}
    </li>
  );
}

/**
 * The small card of a confirmation over the page (Accept all, Reject all): a title, a line under it, the rows and
 * the two buttons; Escape or a click outside cancels.
 */
function ConfirmCard({
  label,
  title,
  sub,
  testId,
  onClose,
  children,
  footer,
}: {
  label: string;
  title: string;
  sub: ReactNode;
  testId: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  useEscape(onClose);
  return (
    <div className="sg-confirm-scrim docs-root" style={{ background: DOCS_SCRIM }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="sg-confirm"
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sg-confirm-title">{title}</div>
        <div className="sg-confirm-sub">{sub}</div>
        {children}
        <div className="sg-confirm-foot">{footer}</div>
      </div>
    </div>
  );
}

/** "Accept 3 of 4 suggestions?": a block changed since the team wrote it stays a suggestion. */
function ConfirmAcceptAll({ review }: { review: Review }) {
  const fresh = review.list.filter((s) => !s.stale);
  const stale = review.list.length - fresh.length;
  return (
    <ConfirmCard
      label="Accept all suggestions"
      title={`Accept ${fresh.length} of ${suggestionsWord(review.list.length)}?`}
      sub={`They are saved as v${review.page.version + 1}. Undo is in History.`}
      onClose={() => review.setConfirm(null)}
      testId="sg-confirm-accept"
      footer={
        <>
          <button type="button" className="sg-btn sg-btn-dlg" onClick={() => review.setConfirm(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="sg-btn sg-btn-dlg sg-btn-primary"
            disabled={!fresh.length || review.busy === 'all'}
            data-testid="sg-confirm-accept-yes"
            onClick={() => void review.acceptAll()}
          >
            <SgIcon name="check" size={14} sw={2.4} />
            {review.busy === 'all' ? 'Accepting…' : `Accept ${fresh.length}`}
          </button>
        </>
      }
    >
      <ul className="sg-rows">
        {review.list.map((s) => (
          <Row key={s.id} s={s} review={review} />
        ))}
      </ul>
      {stale > 0 && (
        <div className="sg-msg sg-msg-stale" data-testid="sg-confirm-stale">
          <SgIcon name="warning" size={14} sw={2.2} color="#8A5A00" />
          <div>
            <b>{stale} changed since the team wrote it.</b> {stale === 1 ? 'That one stays' : 'Those stay'} as a
            suggestion for you to look at.
          </div>
        </div>
      )}
    </ConfirmCard>
  );
}

/** "Reject all 4 suggestions?": the page stays as it is. */
function ConfirmRejectAll({ review }: { review: Review }) {
  const ticket = review.ticketOf(review.list[0]?.runId ?? null);
  return (
    <ConfirmCard
      label="Reject all suggestions"
      title={`Reject all ${suggestionsWord(review.list.length)}?`}
      sub={`The page stays as it is. The team’s changes are discarded; its run and Report stay on ${ticket ?? 'its ticket'}. To keep one, accept it first, then reject the rest.`}
      onClose={() => review.setConfirm(null)}
      testId="sg-confirm-reject"
      footer={
        <>
          <button type="button" className="sg-btn sg-btn-dlg" onClick={() => review.setConfirm(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="sg-btn sg-btn-dlg sg-btn-danger"
            disabled={review.busy === 'all'}
            data-testid="sg-confirm-reject-yes"
            onClick={() => void review.rejectAll()}
          >
            <SgIcon name="close" size={14} sw={2.4} />
            {review.busy === 'all' ? 'Rejecting…' : 'Reject all'}
          </button>
        </>
      }
    >
      <ul className="sg-rows">
        {review.list.map((s) => (
          <Row key={s.id} s={s} review={review} />
        ))}
      </ul>
    </ConfirmCard>
  );
}

/** The head of a phone sheet: its title and a green text button (Done, Cancel) or a count. */
export function SheetHead({ title, action, onAction }: { title: string; action: string; onAction?: () => void }) {
  return (
    <div className="sg-sheet-head">
      <span>{title}</span>
      {onAction ? (
        <button type="button" className="sg-sheet-act" onClick={onAction}>
          {action}
        </button>
      ) : (
        <span className="sg-sheet-act">{action}</span>
      )}
    </div>
  );
}

/** Phone: every suggestion in a list; a tap jumps to it. */
function ListSheet({ review }: { review: Review }) {
  const label = `${review.list.length} change${review.list.length === 1 ? '' : 's'}`;
  return (
    <BottomSheet label={label} onClose={() => review.setListOpen(false)} testId="sg-list" hideTitle>
      <SheetHead title={label} action="Done" onAction={() => review.setListOpen(false)} />
      <div className="sg-list">
        {review.list.map((s) => {
          const r = rowWhat(s);
          return (
            <button
              key={s.id}
              type="button"
              className="sg-list-row"
              onClick={() => {
                review.setListOpen(false);
                review.focus(s.id);
              }}
            >
              <span className="sg-list-icon">
                <SgIcon name={r.icon} size={16} />
              </span>
              <span className="sg-list-main">
                <span className="sg-list-place">{placeName(s, review.doc)}</span>
                <span className="sg-list-change">{s.stale ? 'Changed since the team wrote it' : r.change}</span>
              </span>
              <SgIcon name="chevRight" size={16} sw={2.2} color="#5B6B60" />
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

/** Phone: one suggestion as it would read, its change in words, and the two big buttons. */
function SuggestionSheet({ review, id }: { review: Review; id: string }) {
  const index = review.list.findIndex((x) => x.id === id);
  const s = review.list[index];
  if (!s) return null;
  const view = describeSuggestion(s);
  const error = review.errors[s.id];
  const label = `Suggestion ${index + 1} of ${review.list.length}`;
  return (
    <BottomSheet label={label} onClose={() => review.setSheet(null)} testId="sg-sheet" hideTitle>
      <SheetHead title={label} action="Done" onAction={() => review.setSheet(null)} />
      <div className="sg-sheet-body sg-touch sg-phone">
        <div className="sg-sheet-tags">
          <ChangeTags s={s} view={view} big />
        </div>
        <div className={view.mode === 'diff' ? 'sg-sheet-box' : undefined}>
          <SuggestionBody view={view} rendered={null} sheet />
        </div>
        {s.stale && !review.looked.has(s.id) ? <StaleMsg /> : <StaleNote s={s} view={view} review={review} />}
        {s.stale && !review.looked.has(s.id) && (
          <button
            type="button"
            className="sg-btn sg-btn-look"
            disabled={!review.canEdit}
            data-testid="sg-look"
            onClick={() => review.lookAt(s.id)}
          >
            <SgIcon name="eye" size={15.5} sw={2.4} />
            Look at it
          </button>
        )}
        {error && <ErrorMsg text={error} />}
        <div className="sg-sheet-actions">
          <SuggestionActions s={s} review={review} />
        </div>
        {review.list.length > 1 && (
          <div className="sg-sheet-nav">
            <button
              type="button"
              className="sg-nav-btn"
              aria-label="Previous suggestion"
              onClick={() => review.step(-1)}
            >
              <SgIcon name="chevLeft" size={18} />
            </button>
            <span>Swipe or tap for the next</span>
            <button type="button" className="sg-nav-btn" aria-label="Next suggestion" onClick={() => review.step(1)}>
              <SgIcon name="chevRight" size={18} />
            </button>
          </div>
        )}
      </div>
    </BottomSheet>
  );
}

/** Once everything is settled: what was decided, the run's Report and the changes (the quiet chip's card). */
function SettledNote({ review }: { review: Review }) {
  const st = review.settled;
  if (!st) return null;
  const ticket = review.ticketOf(st.runId);
  const parts = [st.accepted ? `${st.accepted} accepted` : '', st.rejected ? `${st.rejected} rejected` : '']
    .filter(Boolean)
    .join(', ');
  const from = st.fromVersion;
  return (
    <div className="sg-settled docs-root" data-testid="sg-settled" role="status">
      <div className="sg-settled-title">No suggestions waiting</div>
      <div className="sg-settled-text">
        Settled just now: {parts}. The last run was {st.author}
        {ticket ? ` on ${ticket}` : ''}.
      </div>
      <div className="sg-settled-actions">
        {ticket && review.onOpenTicket && (
          <button type="button" className="sg-btn" onClick={() => review.onOpenTicket?.(ticket)}>
            Read its Report
          </button>
        )}
        {from != null && st.accepted > 0 && review.onCompare ? (
          <button type="button" className="sg-btn" onClick={() => review.onCompare?.(from, review.page.version)}>
            See changes
          </button>
        ) : review.onHistory ? (
          <button type="button" className="sg-btn" onClick={() => review.onHistory?.()}>
            History
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The review bar: how many suggestions and from whom, the stepper, Reject all and Accept all; on a phone it sits at
 * the bottom of the screen. Renders the confirmations and the phone sheets too.
 */
export function ReviewBar() {
  const review = useReview();
  const stale = useMemo(() => review?.list.filter((s) => s.stale).length ?? 0, [review?.list]);
  if (!review) return null;
  if (!review.list.length) return null;
  const n = review.list.length;
  const phone = review.layout === 'phone';
  const touch = review.layout !== 'desktop';
  const off = !review.online || !review.canEdit || !!review.busy;
  return (
    <>
      <div
        className={`sg-bar docs-root${touch ? ' sg-touch' : ''}${phone ? ' sg-bar-phone' : ''}`}
        role="region"
        aria-label="Suggestions"
        data-testid="sg-bar"
      >
        {!phone && (
          <span className="sg-bar-text">
            <Spark size={14} color="#5B3AA6" />
            <span className="sg-bar-words">
              <b>{suggestionsWord(n)}</b> from {authorsOf(review.list)}
              {stale > 0 && (
                <>
                  {' '}
                  <span className="sg-tag sg-tag-stale" data-testid="sg-bar-stale">
                    {stale} changed since the team wrote it
                  </span>
                </>
              )}
            </span>
          </span>
        )}
        <span className="sg-stepper">
          <button
            type="button"
            className="sg-nav-btn"
            aria-label="Previous suggestion"
            disabled={n < 2}
            onClick={() => review.step(-1)}
          >
            <SgIcon name="chevLeft" size={15} />
          </button>
          <button
            type="button"
            className="sg-count"
            data-testid="sg-count"
            aria-label={phone ? 'All suggestions' : undefined}
            onClick={() => (phone ? review.setListOpen(true) : review.focus(review.list[review.current].id))}
          >
            {review.current + 1} of {n}
          </button>
          <button
            type="button"
            className="sg-nav-btn"
            aria-label="Next suggestion"
            disabled={n < 2}
            onClick={() => review.step(1)}
          >
            <SgIcon name="chevRight" size={15} />
          </button>
        </span>
        {phone && <span style={{ flex: 1 }} />}
        {review.canEdit && (
          <>
            <button
              type="button"
              className="sg-btn"
              disabled={off}
              data-testid="sg-reject-all"
              onClick={() => review.setConfirm('reject-all')}
            >
              Reject all
            </button>
            <button
              type="button"
              className="sg-btn sg-btn-primary"
              disabled={off}
              data-testid="sg-accept-all"
              onClick={() => review.setConfirm('accept-all')}
            >
              {!phone && <SgIcon name="check" size={13} sw={2.4} />}
              Accept all
            </button>
          </>
        )}
        {!review.online && (
          <span className="sg-note-offline" role="status">
            You are offline. Suggestions stay here. Accept and Reject work again when you are back.
          </span>
        )}
      </div>
      {review.confirm === 'accept-all' && <ConfirmAcceptAll review={review} />}
      {review.confirm === 'reject-all' && <ConfirmRejectAll review={review} />}
      {phone && review.listOpen && <ListSheet review={review} />}
      {phone && review.sheet && <SuggestionSheet review={review} id={review.sheet} />}
    </>
  );
}
