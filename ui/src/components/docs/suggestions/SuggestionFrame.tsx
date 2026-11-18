/**
 * One AI suggestion on the page (design "AI teams on rich pages", B 6–8, C 11–14, D 15–22, I 53–55): the block
 * wrapped with the team's bar and name, the change named in words, Accept and Reject always visible, and the block
 * drawn as it would read — the words that changed for text, the new look for formatting, the old block struck through
 * for a removal, a whole object with a Before / After switch. A block a person changed since the team wrote it has
 * "Look at it" in place of Accept until it is looked at; a failed Accept keeps the suggestion with Retry. On a phone
 * the block keeps a Review chip that opens its sheet.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { RichDoc } from '../../../types/docs';
import { RichBlocks } from '../RichDocView';
import type { DocsSuggestion } from './api';
import { describeSuggestion, textDiff, type FormatChange, type SuggestionView } from './describe';
import { SgIcon, Spark, changeIcon } from './sgIcons';
import { ACCEPT_FAILED, useReview, type Review } from './useSuggestionReview';
import './suggestions.css';

/**
 * One formatting change in words with its icon: "Alignment: left → centre".
 * @param props.change - The change.
 * @param props.big - The phone sheet's taller chip.
 */
export function ChangeChip({ change, big }: { change: FormatChange; big?: boolean }) {
  return (
    <span className={`sg-change${big ? ' sg-change-big' : ''}`}>
      <SgIcon name={changeIcon(change.what)} size={12} color="#5B3AA6" />
      {change.what}: <span className="sg-from">{change.from}</span>
      <span className="sg-arrow" aria-label="to">
        →
      </span>
      <b>{change.to}</b>
    </span>
  );
}

/** The tone of a label: green for a new block, red for a removal, blue for a whole object replaced. */
export function labelTone(label: string): string {
  if (label === 'New block') return ' sg-tag-ok';
  if (label === 'Removed block') return ' sg-tag-del';
  if (/ replaced$|^Replaced$/.test(label)) return ' sg-tag-blue';
  return '';
}

/**
 * The kind of change, its detail and the formatting it changes, as chips.
 * @param props.compact - The phone page: no formatting chips, a short stale tag.
 * @param props.big - The phone sheet: taller formatting chips.
 */
export function ChangeTags({
  s,
  view,
  compact,
  big,
}: {
  s: DocsSuggestion;
  view: SuggestionView;
  compact?: boolean;
  big?: boolean;
}) {
  // the phone page names one thing: that the block changed since, or else what the change is
  if (compact && s.stale) {
    return (
      <span className="sg-tag sg-tag-stale" data-testid="sg-stale">
        Changed since
      </span>
    );
  }
  return (
    <>
      <span className={`sg-tag${labelTone(view.label)}`} data-testid="sg-label">
        {view.label}
      </span>
      {view.detail && !compact && <span className="sg-tag sg-tag-muted">{view.detail}</span>}
      {s.stale && (
        <span className="sg-tag sg-tag-stale" data-testid="sg-stale">
          {compact ? 'Changed since' : 'Changed since the team wrote it'}
        </span>
      )}
      {!compact && view.changes.map((c, i) => <ChangeChip key={i} change={c} big={big} />)}
    </>
  );
}

const TEXT_TAG: Record<string, string> = { blockquote: 'blockquote', pullQuote: 'blockquote' };

/** The words that changed, in the block's own kind of element (a heading stays a heading). */
function DiffText({ view }: { view: SuggestionView }) {
  const after = view.after ?? view.before;
  const a = after?.attrs ?? {};
  const level = typeof a.level === 'number' ? Math.min(6, Math.max(1, a.level)) : 2;
  const Tag = (after?.type === 'heading' ? `h${level}` : (TEXT_TAG[after?.type ?? ''] ?? 'p')) as 'p';
  const style: CSSProperties = {};
  if (typeof a.textAlign === 'string') style.textAlign = a.textAlign as CSSProperties['textAlign'];
  return (
    <div className="dk-md dk-rich">
      <Tag className="sg-diff" style={style} data-testid="sg-diff">
        {textDiff(view).map((seg, i) =>
          seg.kind === 'same' ? (
            <span key={i}>{seg.text}</span>
          ) : seg.kind === 'del' ? (
            <del key={i} className="sg-del">
              {seg.text}
            </del>
          ) : (
            <ins key={i} className="sg-ins">
              {seg.text}
            </ins>
          ),
        )}
      </Tag>
    </div>
  );
}

/** A block drawn by the reader (inside the page's reader, so references resolve). */
function Block({ node }: { node: RichDoc | null }) {
  if (!node) return <div className="sg-empty">No block here</div>;
  return (
    <div className="dk-md dk-rich">
      <RichBlocks nodes={[node]} />
    </div>
  );
}

/**
 * Before and After of a whole object side by side (desktop) or one above the other (tablet), each in its card.
 * @param props.view - The suggestion in words.
 * @param props.stacked - One above the other, with a down arrow.
 */
export function BeforeAfterCards({ view, stacked }: { view: SuggestionView; stacked?: boolean }) {
  const card = (side: 'before' | 'after') => {
    const node = side === 'before' ? view.before : view.after;
    const removed = side === 'after' && !node;
    return (
      <div
        className={`sg-side${node ? '' : ' sg-side-none'}${side === 'after' ? (removed ? ' sg-side-gone' : ' sg-side-after') : ''}`}
        data-testid={`sg-side-${side}`}
      >
        <div>
          <span className={`sg-tag ${side === 'before' ? 'sg-tag-muted' : removed ? 'sg-tag-del' : 'sg-tag-ok'}`}>
            {side === 'before' ? 'Before' : removed ? 'Removed' : 'After'}
          </span>
        </div>
        {node ? <Block node={node} /> : <div className="sg-side-empty">No block here</div>}
      </div>
    );
  };
  return (
    <div className={`sg-sides${stacked ? ' sg-sides-stacked' : ''}`}>
      {card('before')}
      <span className="sg-sides-arrow" aria-hidden="true">
        <SgIcon name={stacked ? 'arrowDown' : 'chevRight'} size={18} sw={2.4} color="#5B3AA6" />
      </span>
      {card('after')}
    </div>
  );
}

/** Before / After of a suggestion, one at a time (the phone sheet). */
export function BeforeAfter({ view, initial = 'after' }: { view: SuggestionView; initial?: 'before' | 'after' }) {
  const [side, setSide] = useState<'before' | 'after'>(initial);
  const node = side === 'before' ? view.before : view.after;
  return (
    <div>
      <div className="sg-switch sg-switch-wide" role="group" aria-label="Before or after">
        {(['before', 'after'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={side === k} onClick={() => setSide(k)}>
            {k === 'before' ? 'Before' : 'After'}
          </button>
        ))}
      </div>
      {node ? (
        <Block node={node} />
      ) : (
        <div className="sg-empty">{side === 'before' ? 'No block here' : 'Removed from the page'}</div>
      )}
    </div>
  );
}

/**
 * The block as the suggestion would make it read.
 * @param props.view - The suggestion in words.
 * @param props.rendered - The block as it is on the page now (a removal shows it struck through).
 * @param props.sheet - In the phone sheet: formatting and objects get the Before / After switch.
 * @param props.stacked - A whole object's Before and After one above the other (tablet).
 */
export function SuggestionBody({
  view,
  rendered,
  sheet,
  stacked,
}: {
  view: SuggestionView;
  rendered: ReactNode;
  sheet?: boolean;
  stacked?: boolean;
}) {
  if (view.mode === 'diff') return <DiffText view={view} />;
  if (view.mode === 'removed') return <>{rendered ?? <Block node={view.before} />}</>;
  if (sheet && (view.mode === 'whole' || view.before)) return <BeforeAfter view={view} />;
  if (view.mode === 'whole') return <BeforeAfterCards view={view} stacked={stacked} />;
  return <Block node={view.after} />;
}

/** The first, bold sentence of the note under a block that changed since the team wrote it. */
export const STALE_LEAD = 'Someone changed this block after the team wrote it.';
/** The rest of that note. */
export const STALE_REST = 'Accept waits until you have looked at what changed. Reject keeps their version.';
/** The whole note, in words. */
export const STALE_NOTE = `${STALE_LEAD} ${STALE_REST}`;

/** The amber note "Someone changed this block after the team wrote it." with its warning sign. */
export function StaleMsg() {
  return (
    <div className="sg-msg sg-msg-stale" data-testid="sg-stale-note">
      <SgIcon name="warning" size={14} sw={2.2} color="#8A5A00" />
      <div>
        <b>{STALE_LEAD}</b> {STALE_REST}
      </div>
    </div>
  );
}

/**
 * Reject and Accept (or Look at it, or Retry) of one suggestion.
 * @param props.s - The suggestion.
 * @param props.review - The page's review.
 */
export function SuggestionActions({ s, review }: { s: DocsSuggestion; review: Review }) {
  const busy = review.busy === s.id || review.busy === 'all';
  const off = !review.online || !review.canEdit || !!review.busy;
  const needsLook = s.stale && !review.looked.has(s.id);
  const failed = review.errors[s.id] === ACCEPT_FAILED;
  return (
    <>
      <button
        type="button"
        className="sg-btn sg-btn-reject"
        disabled={off}
        data-testid="sg-reject"
        onClick={() => void review.reject(s)}
      >
        <SgIcon name="close" size={13} sw={2.4} />
        Reject
      </button>
      {needsLook ? (
        <button
          type="button"
          className="sg-btn sg-btn-accept"
          disabled
          data-testid="sg-accept-wait"
          title="Look at what changed first"
        >
          <SgIcon name="check" size={13} sw={2.4} />
          Accept
        </button>
      ) : (
        <button
          type="button"
          className="sg-btn sg-btn-primary sg-btn-accept"
          disabled={off}
          data-testid="sg-accept"
          onClick={() => void review.accept(s)}
        >
          <SgIcon name="check" size={13} sw={2.4} />
          {busy ? 'Saving…' : failed ? 'Retry' : 'Accept'}
        </button>
      )}
    </>
  );
}

/**
 * "Changed since the team wrote it" with "Look at it", and once looked at, the block as it is now next to the team's
 * version.
 */
export function StaleNote({ s, view, review }: { s: DocsSuggestion; view: SuggestionView; review: Review }) {
  if (!s.stale) return null;
  if (!review.looked.has(s.id)) {
    return (
      <div className="sg-stale-wrap">
        <StaleMsg />
        <div className="sg-look-row">
          <button
            type="button"
            className="sg-btn sg-btn-look"
            disabled={!review.canEdit}
            data-testid="sg-look"
            onClick={() => review.lookAt(s.id)}
          >
            <SgIcon name="eye" size={13} sw={2.4} />
            Look at it
          </button>
          <span className="sg-look-hint">Shows their edit next to the team's</span>
        </div>
      </div>
    );
  }
  const now = s.blockId ? (review.doc?.content ?? []).find((b) => b.attrs?.blockId === s.blockId) : null;
  return (
    <div className="sg-sides sg-compare" data-testid="sg-compare">
      <div className="sg-side">
        <div>
          <span className="sg-tag sg-tag-muted">On the page now</span>
        </div>
        <Block node={now ?? null} />
      </div>
      <div className="sg-side sg-side-after">
        <div>
          <span className="sg-tag sg-tag-ok">The team’s version</span>
        </div>
        <Block node={view.after} />
      </div>
    </div>
  );
}

/**
 * The red note under a block whose Accept did not go through: the first sentence bold.
 * @param props.text - The error ("Couldn’t accept this change. The page was not saved. …").
 */
export function ErrorMsg({ text }: { text: string }) {
  const cut = text.indexOf('. ');
  const lead = cut > 0 ? text.slice(0, cut + 1) : text;
  const rest = cut > 0 ? text.slice(cut + 2) : '';
  return (
    <div className="sg-msg sg-msg-error" role="alert" data-testid="sg-error">
      <SgIcon name="warning" size={14} sw={2.2} color="#C4432A" />
      <div>
        <b>{lead}</b>
        {rest ? ` ${rest}` : ''}
      </div>
    </div>
  );
}

/**
 * A person and the team changed the same block while the team was working (G 37): the person's edit stays on the
 * page, the team's version waits beside it, and Keep mine or Use the team's settles it.
 */
function ClashFrame({
  s,
  view,
  review,
  index,
}: {
  s: DocsSuggestion;
  view: SuggestionView;
  review: Review;
  index: number;
}) {
  const now = s.blockId ? (review.doc?.content ?? []).find((b) => b.attrs?.blockId === s.blockId) : null;
  const off = !review.online || !review.canEdit || !!review.busy;
  const error = review.errors[s.id];
  return (
    <div
      className={`sg-block sg-stale${index === review.current ? ' sg-current' : ''}`}
      data-sg-id={s.id}
      data-testid="sg-block"
      data-clash="true"
      aria-label={`Suggestion ${index + 1} of ${review.list.length}`}
    >
      <div className="sg-bhead">
        <span className="sg-team">
          <Spark size={12} />
          {s.author}
        </span>
        <span className="sg-tag sg-tag-clash">Edited at the same time</span>
        <span className="sg-actions">
          <button
            type="button"
            className="sg-btn"
            disabled={off}
            data-testid="sg-keep-mine"
            onClick={() => void review.reject(s)}
          >
            <SgIcon name="close" size={13} sw={2.4} />
            Keep mine
          </button>
          <button
            type="button"
            className="sg-btn sg-btn-primary"
            disabled={off}
            data-testid="sg-use-team"
            onClick={() => void review.accept(s, true)}
          >
            <SgIcon name="check" size={13} sw={2.4} />
            Use the team’s
          </button>
        </span>
      </div>
      <div className="sg-sides">
        <div className="sg-side">
          <div>
            <span className="sg-tag sg-tag-muted">Your block now</span>
          </div>
          <Block node={now ?? null} />
        </div>
        <div className="sg-side sg-side-after">
          <div>
            <span className="sg-tag sg-tag-ok">{s.author}’s version</span>
          </div>
          <Block node={view.after} />
        </div>
      </div>
      <div className="sg-clash-line" data-testid="sg-clash-line">
        {s.changedBy || 'Someone'} changed this block while {s.author} was working on it. Use the team’s version, or
        keep yours.
      </div>
      {error && <ErrorMsg text={error} />}
    </div>
  );
}

/**
 * A suggested block on the page.
 * @param props.s - The suggestion.
 * @param props.rendered - The block as it is on the page now (null for a new block).
 */
export function SuggestionFrame({ s, rendered }: { s: DocsSuggestion; rendered: ReactNode }) {
  const review = useReview();
  if (!review) return <>{rendered}</>;
  const view = describeSuggestion(s);
  const phone = review.layout === 'phone';
  if (s.stale && s.atSameTime && !phone) {
    return <ClashFrame s={s} view={view} review={review} index={review.list.findIndex((x) => x.id === s.id)} />;
  }
  const touch = review.layout !== 'desktop';
  const index = review.list.findIndex((x) => x.id === s.id);
  const error = review.errors[s.id];
  const cls = [
    'sg-block',
    touch ? 'sg-touch' : '',
    phone ? 'sg-phone' : '',
    index === review.current ? 'sg-current' : '',
    s.stale ? 'sg-stale' : '',
    view.mode === 'removed' ? 'sg-removed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      data-sg-id={s.id}
      data-testid="sg-block"
      aria-label={`Suggestion ${index + 1} of ${review.list.length}`}
    >
      <div className="sg-bhead">
        <span className="sg-team">
          <Spark size={12} />
          {s.author}
        </span>
        <ChangeTags s={s} view={view} compact={phone} />
        <span className="sg-actions">
          {phone ? (
            <button
              type="button"
              className="sg-review-chip"
              data-testid="sg-review"
              onClick={() => {
                review.focus(s.id);
                review.setSheet(s.id);
              }}
            >
              Review
              <SgIcon name="chevRight" size={14} sw={2.6} />
            </button>
          ) : (
            <SuggestionActions s={s} review={review} />
          )}
        </span>
      </div>
      <SuggestionBody view={view} rendered={rendered} stacked={touch} />
      {!phone && <StaleNote s={s} view={view} review={review} />}
      {phone && s.stale && <div className="sg-stale-line">{STALE_LEAD}</div>}
      {s.note && !phone && <div className="sg-note">{s.note}</div>}
      {error && <ErrorMsg text={error} />}
    </div>
  );
}
