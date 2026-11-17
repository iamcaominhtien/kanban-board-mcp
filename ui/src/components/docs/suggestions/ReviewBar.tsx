/**
 * The page-level parts of a review (design "AI teams on rich pages", A 1–5, B 8, C 12–14, I 51–55): the header chip
 * ("Docs team suggested 3 edits and 1 new block · 2 min ago", or "No suggestions waiting"), the review bar with its
 * stepper and Accept all / Reject all (each asks first), the note once everything is settled, and on a phone the
 * list sheet and the sheet of one suggestion.
 */

import { useMemo } from 'react';
import { absoluteTime, relativeTime } from '../../../utils/relativeTime';
import { LineIcon } from '../../ui/LineIcon';
import { BottomSheet } from '../DocsSheets';
import { ModalShell, Spacer } from '../docsShared';
import type { DocsSuggestion } from './api';
import { authorsOf, chipLine, describeSuggestion, placeName, suggestionsWord } from './describe';
import { ChangeChip, ChangeTags, STALE_NOTE, StaleNote, SuggestionActions, SuggestionBody } from './SuggestionFrame';
import { useReview, type Review } from './useSuggestionReview';
import './suggestions.css';

const latest = (list: DocsSuggestion[]) => list.reduce((a, s) => (s.createdAt > a ? s.createdAt : a), '');

/** The header chip: what the team suggested and when; quiet once nothing waits. */
export function SuggestionChip() {
  const review = useReview();
  if (!review) return null;
  if (!review.list.length) {
    return (
      <span className="sg-chip sg-chip-quiet" data-testid="sg-chip-quiet">
        <span>No suggestions waiting</span>
      </span>
    );
  }
  const when = latest(review.list);
  return (
    <button
      type="button"
      className="sg-chip"
      data-testid="sg-chip"
      title={when ? absoluteTime(when) : undefined}
      onClick={() => {
        if (review.layout === 'phone') review.setListOpen(true);
        else review.focus(review.list[review.current]?.id ?? review.list[0].id);
      }}
    >
      <LineIcon name="sparkle" size={13} />
      <span>
        {chipLine(review.list)}
        {when ? ` · ${relativeTime(when)}` : ''}
      </span>
    </button>
  );
}

/** One row of a list of suggestions: where it is and what it does. */
function Row({ s, review }: { s: DocsSuggestion; review: Review }) {
  const view = describeSuggestion(s);
  return (
    <>
      <b>{placeName(s, review.doc)}</b>
      {s.stale ? (
        <span className="sg-tag sg-tag-stale">Changed since the team wrote it</span>
      ) : view.changes[0] ? (
        <ChangeChip change={view.changes[0]} />
      ) : null}
      <span className="sg-row-what">{view.detail && view.label === 'New block' ? view.detail : view.label}</span>
    </>
  );
}

/** "Accept 3 of 4 suggestions?": a block changed since the team wrote it stays a suggestion. */
function ConfirmAcceptAll({ review }: { review: Review }) {
  const fresh = review.list.filter((s) => !s.stale);
  const stale = review.list.length - fresh.length;
  return (
    <ModalShell
      width={460}
      ariaLabel="Accept all suggestions"
      title={`Accept ${fresh.length} of ${suggestionsWord(review.list.length)}?`}
      subtitle={`They are saved as v${review.page.version + 1}. Undo is in History.`}
      onClose={() => review.setConfirm(null)}
      testId="sg-confirm-accept"
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={() => review.setConfirm(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={!fresh.length || review.busy === 'all'}
            data-testid="sg-confirm-accept-yes"
            onClick={() => void review.acceptAll()}
          >
            {review.busy === 'all' ? 'Accepting…' : `Accept ${fresh.length}`}
          </button>
        </>
      }
    >
      <ul className="sg-rows">
        {review.list.map((s) => (
          <li key={s.id} className="sg-row">
            <Row s={s} review={review} />
          </li>
        ))}
      </ul>
      {stale > 0 && (
        <p className="sg-msg sg-msg-stale" data-testid="sg-confirm-stale">
          {stale} changed since the team wrote it. {stale === 1 ? 'That one stays' : 'Those stay'} as a suggestion for
          you to look at.
        </p>
      )}
    </ModalShell>
  );
}

/** "Reject all 4 suggestions?": the page stays as it is. */
function ConfirmRejectAll({ review }: { review: Review }) {
  const ticket = review.ticketOf(review.list[0]?.runId ?? null);
  return (
    <ModalShell
      width={460}
      ariaLabel="Reject all suggestions"
      iconTone="red"
      title={`Reject all ${suggestionsWord(review.list.length)}?`}
      onClose={() => review.setConfirm(null)}
      testId="sg-confirm-reject"
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={() => review.setConfirm(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-danger"
            disabled={review.busy === 'all'}
            data-testid="sg-confirm-reject-yes"
            onClick={() => void review.rejectAll()}
          >
            {review.busy === 'all' ? 'Rejecting…' : 'Reject all'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13.5, color: '#3A4A3E', lineHeight: 1.5 }}>
        The page stays as it is. The team’s changes are discarded; its run and Report stay on {ticket ?? 'its ticket'}.
        To keep one, accept it first, then reject the rest.
      </p>
      <ul className="sg-rows">
        {review.list.map((s) => (
          <li key={s.id} className="sg-row">
            <Row s={s} review={review} />
          </li>
        ))}
      </ul>
    </ModalShell>
  );
}

/** Phone: every suggestion in a list; a tap jumps to it. */
function ListSheet({ review }: { review: Review }) {
  return (
    <BottomSheet
      label={`${review.list.length} change${review.list.length === 1 ? '' : 's'}`}
      onClose={() => review.setListOpen(false)}
      testId="sg-list"
    >
      <div className="sg-rows" style={{ marginTop: 0 }}>
        {review.list.map((s) => (
          <button
            key={s.id}
            type="button"
            className="sg-row"
            onClick={() => {
              review.setListOpen(false);
              review.focus(s.id);
            }}
          >
            <Row s={s} review={review} />
          </button>
        ))}
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
  return (
    <BottomSheet
      label={`Suggestion ${index + 1} of ${review.list.length}`}
      onClose={() => review.setSheet(null)}
      testId="sg-sheet"
    >
      <div className="sg-sheet-body sg-touch">
        <div className="sg-head">
          <ChangeTags s={s} view={view} />
        </div>
        <SuggestionBody view={view} rendered={null} sheet />
        {s.stale && !review.looked.has(s.id) ? (
          <div className="sg-msg sg-msg-stale">{STALE_NOTE}</div>
        ) : (
          <StaleNote s={s} view={view} review={review} />
        )}
        {error && (
          <div className="sg-msg sg-msg-error" role="alert">
            {error}
          </div>
        )}
        <div className="sg-sheet-actions">
          <SuggestionActions s={s} review={review} />
        </div>
        {review.list.length > 1 && (
          <button type="button" className="sg-btn" onClick={() => review.step(1)}>
            Next suggestion
          </button>
        )}
      </div>
    </BottomSheet>
  );
}

/** Once everything is settled: what was decided, the run's Report and the changes. */
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
      <LineIcon name="checkCircle" size={15} />
      <span>
        <b>No suggestions waiting.</b> Settled just now: {parts}. The last run was {st.author}
        {ticket ? ` on ${ticket}` : ''}.
      </span>
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
  if (!review.list.length) return <SettledNote review={review} />;
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
            <span style={{ display: 'flex', color: '#5B3AA6' }}>
              <LineIcon name="sparkle" size={14} />
            </span>
            <span>
              <b>{suggestionsWord(n)}</b> from {authorsOf(review.list)}
            </span>
            {stale > 0 && (
              <span className="sg-bar-stale" data-testid="sg-bar-stale">
                {stale} changed since the team wrote it
              </span>
            )}
          </span>
        )}
        <span className="sg-stepper">
          <button
            type="button"
            className="sg-step"
            aria-label="Previous suggestion"
            disabled={n < 2}
            onClick={() => review.step(-1)}
          >
            <LineIcon name="chevronLeft" size={14} />
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
            className="sg-step"
            aria-label="Next suggestion"
            disabled={n < 2}
            onClick={() => review.step(1)}
          >
            <LineIcon name="chevronRight" size={14} />
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
              <LineIcon name="check" size={13} />
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
