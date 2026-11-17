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
import { LineIcon } from '../../ui/LineIcon';
import { RichBlocks } from '../RichDocView';
import type { DocsSuggestion } from './api';
import { describeSuggestion, textDiff, type FormatChange, type SuggestionView } from './describe';
import { ACCEPT_FAILED, useReview, type Review } from './useSuggestionReview';
import './suggestions.css';

/** One formatting change in words: "Alignment: left → centre". */
export function ChangeChip({ change }: { change: FormatChange }) {
  return (
    <span className="sg-change">
      {change.what}: <span className="sg-from">{change.from}</span>
      <span className="sg-arrow" aria-label="to">
        →
      </span>
      <b>{change.to}</b>
    </span>
  );
}

/** The kind of change, its detail and the formatting it changes, as chips. */
export function ChangeTags({ s, view, compact }: { s: DocsSuggestion; view: SuggestionView; compact?: boolean }) {
  return (
    <>
      <span className="sg-tag" data-testid="sg-label">
        {view.label}
      </span>
      {view.detail && <span className="sg-tag sg-tag-muted">{view.detail}</span>}
      {s.stale && (
        <span className="sg-tag sg-tag-stale" data-testid="sg-stale">
          {compact ? 'Changed since' : 'Changed since the team wrote it'}
        </span>
      )}
      {!compact && view.changes.map((c, i) => <ChangeChip key={i} change={c} />)}
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

/** Before / After of a suggestion, one at a time. */
export function BeforeAfter({ view, initial = 'after' }: { view: SuggestionView; initial?: 'before' | 'after' }) {
  const [side, setSide] = useState<'before' | 'after'>(initial);
  const node = side === 'before' ? view.before : view.after;
  return (
    <div>
      <div className="sg-switch" role="group" aria-label="Before or after">
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
 */
export function SuggestionBody({
  view,
  rendered,
  sheet,
}: {
  view: SuggestionView;
  rendered: ReactNode;
  sheet?: boolean;
}) {
  if (view.mode === 'diff') return <DiffText view={view} />;
  if (view.mode === 'removed') return <>{rendered ?? <Block node={view.before} />}</>;
  if (view.mode === 'whole' || (sheet && view.before)) return <BeforeAfter view={view} />;
  return <Block node={view.after} />;
}

/** The words under a block that changed since the team wrote it. */
export const STALE_NOTE =
  'Someone changed this block after the team wrote it. Accept waits until you have looked at what changed. Reject keeps their version.';

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
        className="sg-btn"
        disabled={off}
        data-testid="sg-reject"
        onClick={() => void review.reject(s)}
      >
        <LineIcon name="close" size={13} />
        Reject
      </button>
      {needsLook ? (
        <button
          type="button"
          className="sg-btn sg-btn-look"
          disabled={!review.canEdit}
          data-testid="sg-look"
          title="Shows the block as it is now next to the team's version"
          onClick={() => review.lookAt(s.id)}
        >
          <LineIcon name="eye" size={13} />
          Look at it
        </button>
      ) : (
        <button
          type="button"
          className="sg-btn sg-btn-primary"
          disabled={off}
          data-testid="sg-accept"
          onClick={() => void review.accept(s)}
        >
          <LineIcon name={failed ? 'refresh' : 'check'} size={13} />
          {busy ? 'Saving…' : failed ? 'Retry' : 'Accept'}
        </button>
      )}
    </>
  );
}

/** "Changed since the team wrote it", and once looked at, the block as it is now next to the team's version. */
export function StaleNote({ s, view, review }: { s: DocsSuggestion; view: SuggestionView; review: Review }) {
  if (!s.stale) return null;
  if (!review.looked.has(s.id)) {
    return (
      <div className="sg-msg sg-msg-stale" data-testid="sg-stale-note">
        <LineIcon name="warning" size={14} />
        <span>{STALE_NOTE}</span>
      </div>
    );
  }
  const now = s.blockId ? (review.doc?.content ?? []).find((b) => b.attrs?.blockId === s.blockId) : null;
  return (
    <div className="sg-compare" data-testid="sg-compare">
      <div>
        <span className="sg-label-small">On the page now</span>
        <Block node={now ?? null} />
      </div>
      <div>
        <span className="sg-label-small">The team’s version</span>
        <Block node={view.after} />
      </div>
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
  const touch = review.layout !== 'desktop';
  const index = review.list.findIndex((x) => x.id === s.id);
  const error = review.errors[s.id];
  const cls = [
    'sg-block',
    touch ? 'sg-touch' : '',
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
      <div className="sg-head">
        <span className="sg-team">
          <LineIcon name="sparkle" size={12} />
          {s.author}
        </span>
        <ChangeTags s={s} view={view} compact={phone} />
        <span className="sg-actions">
          {phone ? (
            <button
              type="button"
              className="sg-btn sg-review-chip"
              data-testid="sg-review"
              onClick={() => {
                review.focus(s.id);
                review.setSheet(s.id);
              }}
            >
              Review
            </button>
          ) : (
            <SuggestionActions s={s} review={review} />
          )}
        </span>
      </div>
      <SuggestionBody view={view} rendered={rendered} />
      {!phone && <StaleNote s={s} view={view} review={review} />}
      {phone && s.stale && (
        <div className="sg-msg sg-msg-stale">Someone changed this block after the team wrote it.</div>
      )}
      {s.note && !phone && (
        <div className="sg-msg" style={{ color: '#5B6B60', padding: '2px 0' }}>
          {s.note}
        </div>
      )}
      {error && (
        <div className="sg-msg sg-msg-error" role="alert" data-testid="sg-error">
          {error}
        </div>
      )}
    </div>
  );
}
