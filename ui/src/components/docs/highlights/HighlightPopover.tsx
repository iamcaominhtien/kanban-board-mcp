/**
 * The bubble on a highlight (design board "Rich Docs — reading", K 75 states 2-4, 112): its colours (ringed and
 * changeable on your own, greyed on someone else's), Copy, Comment with its thread count, Link, Remove highlight
 * for its author ("yours") and people who can edit the page ("as editor"), Add to the page for them ("edit", 75.4),
 * and who made it and when.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { HighlightColor } from '../../../api/docsHighlights';
import { colorName, HL_FIRST_SIX } from './colors';
import { DOCS_PHONE_BELOW, useNarrowWindow } from '../../../hooks/useDocsLayout';
import { HlIcon } from './hlIcons';
import { AllColours, Swatch } from './SelectionSwatches';
import type { HlPerson } from './useHighlightLayer';
import type { HlItem } from './useHighlights';

/** "just now", "5 min ago", "2h ago", "3d ago", "Oct 3" (the boards' times). */
export function shortAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A round avatar with initials, `size` px. */
export function HlAvatar({ person, size = 16 }: { person: HlPerson; size?: number }) {
  return (
    <span
      className="hl-av"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: person.bg,
        color: person.color,
        fontSize: size <= 16 ? 6 : size <= 20 ? 8 : 9,
      }}
    >
      {person.initials}
    </span>
  );
}

interface Props {
  h: HlItem;
  person: HlPerson;
  /** Where the highlight is on screen. */
  rect: DOMRect;
  /** Comments in its thread (0: none). */
  comments: number;
  /** The reader can edit the page (removes anyone's, "as editor"). */
  canEdit: boolean;
  /** Tablet or phone: 44 px targets. */
  touch: boolean;
  /** Comments are off for this reader (Viewer, older version). */
  noComment: boolean;
  onRecolor: (c: HighlightColor) => void;
  onCopy: () => void;
  onComment: () => void;
  onLink: () => void;
  onRemove: () => void;
  /** "Add to the page" (people who can edit a rich page); absent: not offered. */
  onToPage?: () => void;
  onClose: () => void;
}

/**
 * The bubble on a highlight.
 * @param props - The highlight, who made it, where it is, and what each action does.
 */
export function HighlightPopover({
  h,
  person,
  rect,
  comments,
  canEdit,
  touch,
  noComment,
  onRecolor,
  onCopy,
  onComment,
  onLink,
  onRemove,
  onToPage,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 8 });
  const [all, setAll] = useState(false);
  const mine = h.mine;
  const removable = h.canRemove || mine;
  // Reader7 112: a tap on a phone shows a 310 px card: who and when first, then 44 px rows (14.5/500)
  const phone = useNarrowWindow(DOCS_PHONE_BELOW) && touch;

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 292;
    const ht = el?.offsetHeight ?? 200;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, (rect.left + rect.right) / 2 - w / 2));
    // above the words, never under a finger or the keyboard; below when there is no room above
    let top = rect.top - ht - 8;
    if (top < 8) top = Math.min(window.innerHeight - ht - 8, rect.bottom + 8);
    setPos({ left, top: Math.max(8, top) });
  }, [rect, all, phone]);

  // closes on a click elsewhere and on Esc
  useLayoutEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (ref.current?.contains(t) || t?.closest('.dk-hl-mark')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const who = mine ? 'you' : person.name;
  if (phone) {
    return (
      <div
        ref={ref}
        className="hl-pop is-touch is-phone"
        style={{ left: pos.left, top: pos.top }}
        role="dialog"
        aria-label={`Highlight by ${who}`}
        data-testid="hl-popover"
        data-nocomment
      >
        <div className="hl-pop-who" data-testid="hl-popover-who">
          <HlAvatar person={person} size={20} />
          <span>
            Highlighted {colorName(h.color)} by {who} · {shortAgo(h.createdAt)}
          </span>
        </div>
        <span className="hl-pop-rule" />
        {mine && (
          <div className="hl-sw-row" role="group" aria-label="Colour">
            {HL_FIRST_SIX.map((c) => (
              <Swatch key={c} color={c} ring={c === h.color} onApply={onRecolor} testId={`hl-recolor-${c}`} />
            ))}
          </div>
        )}
        <button
          type="button"
          className="hl-pop-row"
          disabled={noComment && comments === 0}
          onClick={onComment}
          data-testid="hl-comment"
        >
          <HlIcon name="comment" size={16} color="#3A4A3E" />
          <span style={{ flex: 1 }}>{comments > 0 ? 'Open the thread' : 'Comment'}</span>
          {comments > 0 && <span className="hl-pop-count">{comments}</span>}
        </button>
        <button type="button" className="hl-pop-row" onClick={onCopy} data-testid="hl-copy">
          <HlIcon name="copy" size={16} color="#3A4A3E" />
          <span style={{ flex: 1 }}>Copy</span>
        </button>
        <button type="button" className="hl-pop-row" onClick={onLink} data-testid="hl-link">
          <HlIcon name="link" size={16} color="#3A4A3E" />
          <span style={{ flex: 1 }}>Copy link to this passage</span>
        </button>
        {onToPage && (
          <button type="button" className="hl-pop-row hl-pop-topage" onClick={onToPage} data-testid="hl-to-page">
            <HlIcon name="pen" size={16} color="#1F5A31" />
            <span style={{ flex: 1 }}>Add to the page</span>
          </button>
        )}
        {removable && (
          <button type="button" className="hl-pop-row hl-pop-row-red" onClick={onRemove} data-testid="hl-remove">
            <HlIcon name="trash" size={16} color="#C4432A" />
            <span style={{ flex: 1 }}>Remove highlight</span>
            {!mine && canEdit && <span className="hl-pop-tag">as editor</span>}
          </button>
        )}
        {!mine && (
          <div className="hl-pop-note">
            {removable ? 'Not yours: you cannot recolour it.' : 'Not yours: you cannot recolour or remove it.'}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={`hl-pop${touch ? ' is-touch' : ''}`}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={`Highlight by ${who}`}
      data-testid="hl-popover"
      data-nocomment
    >
      <div className={`hl-sw-row${mine ? '' : ' is-off'}`} role="group" aria-label="Colour">
        {HL_FIRST_SIX.map((c) => (
          <Swatch
            key={c}
            color={c}
            ring={mine && c === h.color}
            disabled={!mine}
            onApply={onRecolor}
            testId={`hl-recolor-${c}`}
          />
        ))}
        <button
          type="button"
          className="hl-sw-more"
          aria-label="All 12 colours"
          aria-expanded={all}
          disabled={!mine}
          onClick={() => setAll((v) => !v)}
        >
          <HlIcon name="dots" size={16} stroke={2} />
        </button>
      </div>
      {all && mine && (
        <AllColours
          current={h.color}
          onApply={(c) => {
            setAll(false);
            onRecolor(c);
          }}
          onClose={() => setAll(false)}
        />
      )}
      <span className="hl-pop-rule" />
      <div className="hl-acts">
        <button type="button" className="hl-act" onClick={onCopy} data-testid="hl-copy">
          <HlIcon name="copy" size={16} color="#3A4A3E" />
          Copy
        </button>
        <button
          type="button"
          className="hl-act"
          disabled={noComment && comments === 0}
          onClick={onComment}
          data-testid="hl-comment"
        >
          <HlIcon name="comment" size={16} color="#3A4A3E" />
          {comments > 0 ? 'Comments' : 'Comment'}
          {comments > 0 && <span className="hl-act-count">{comments}</span>}
        </button>
        <button type="button" className="hl-act" onClick={onLink} data-testid="hl-link">
          <HlIcon name="link" size={16} color="#3A4A3E" />
          Link
        </button>
      </div>
      {removable && (
        <>
          <span className="hl-pop-rule" />
          <button type="button" className="hl-pop-remove" onClick={onRemove} data-testid="hl-remove">
            <HlIcon name="trash" size={16} color="#C4432A" />
            <span style={{ flex: 1 }}>Remove highlight</span>
            <span className="hl-pop-tag">{mine ? 'yours' : canEdit ? 'as editor' : ''}</span>
          </button>
        </>
      )}
      {onToPage && (
        <>
          <span className="hl-pop-rule" />
          <button type="button" className="hl-pop-remove hl-pop-topage" onClick={onToPage} data-testid="hl-to-page">
            <HlIcon name="pen" size={16} color="#1F5A31" />
            <span style={{ flex: 1 }}>Add to the page</span>
            <span className="hl-pop-tag">edit</span>
          </button>
        </>
      )}
      <div className="hl-pop-foot" data-testid="hl-popover-who">
        <HlAvatar person={person} />
        <span style={{ flex: 1 }}>
          Highlighted by {who} · {shortAgo(h.createdAt)}
          {touch && !removable && (
            <>
              <br />
              Not yours: you cannot recolour or remove it.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
