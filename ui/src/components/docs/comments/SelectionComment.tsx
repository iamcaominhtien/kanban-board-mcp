import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CommentAnchorInput } from '../../../types/docs';
import { Icon } from '../Icon';
import { CommentBox } from './CommentBox';
import { anchorFromRange } from './anchorDom';
import { topBlockOf } from './blockAnchor';
import type { SuggestMember } from '../RefSuggester';
import type { CommentPerson } from './people';

export interface Pick {
  anchor: CommentAnchorInput;
  /** Viewport rect of the selection. */
  rect: { left: number; right: number; top: number; bottom: number };
  /** The selected DOM range (view mode), kept highlighted while the box is open. */
  range?: Range;
  /** What a comment on a whole block is about ("Image · Float right"), shown in place of the quote. */
  label?: string;
}

export const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform)
  ? '⌃⌥M'
  : 'Ctrl+Alt+M';

/**
 * Run `start` when Ctrl+Alt+M (Control+Option+M on Mac) is pressed.
 * @param start - Called on the shortcut.
 * @param enabled - Listen only while true.
 */
export function useCommentShortcut(start: () => void, enabled: boolean) {
  const ref = useRef(start);
  ref.current = start;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** The current selection inside `root` as an anchor, or null. */
export function pickFromSelection(root: HTMLElement | null): Pick | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const anchor = anchorFromRange(root, range);
  if (!anchor) return null;
  // on a rich page the comment also carries the block it starts in, so it follows that block through edits
  const top = topBlockOf(range.startContainer);
  const blockId = top?.getAttribute('data-block-id');
  if (blockId) anchor.blockId = blockId;
  // cells of a table: the quote is their text, the comment says how many cells
  const cells = top ? Array.from(top.querySelectorAll('td,th')).filter((c) => range.intersectsNode(c)).length : 0;
  const r = range.getBoundingClientRect();
  return {
    anchor,
    rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    range: range.cloneRange(),
    ...(cells > 1 ? { label: `Table · ${cells} cells` } : {}),
  };
}

/**
 * Floating "Comment" button above a text selection in the rendered page, plus the shortcut.
 * @param props.root - Element holding the rendered page body.
 * @param props.label - Button label: "Comment", or "Attach here" while re-attaching a thread.
 * @param props.enabled - Show only for people who can comment.
 * @param props.onPick - Called with the selection when the button or shortcut is used.
 */
export function SelectionToolbar({
  root,
  label,
  enabled,
  onPick,
  extra,
  hideComment,
  lead,
  card = false,
}: {
  root: HTMLElement | null;
  label: string;
  enabled: boolean;
  onPick: (p: Pick) => void;
  /** More buttons after Comment (Docs AI: Explain, Summarise, Ask…). `close` hides the bar. */
  extra?: (pick: Pick, close: () => void) => ReactNode;
  /** Show only `extra` (a person who cannot comment can still use AI). */
  hideComment?: boolean;
  /** What comes before Comment: the highlight colours (highlights/SelectionSwatches.tsx). `close` hides the bar. */
  lead?: (pick: Pick, close: () => void) => ReactNode;
  /**
   * Draw the reader's bubble (Reader 74-75, 96): a 292 px card with the colours on top, then Copy, Comment, Link and
   * More (`extra`, opened under the card), and who will see it at the foot.
   */
  card?: boolean;
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [more, setMore] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // with the colours in front the bar is wider and taller: it is centred on the selection by its measured size
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!lead || !el) return;
    const next = { w: el.offsetWidth, h: el.offsetHeight };
    setSize((s) => (s && s.w === next.w && s.h === next.h ? s : next));
  }, [lead, pick, hideComment, extra, card]);
  useEffect(() => setMore(false), [pick?.anchor.quote]);

  useEffect(() => {
    if (!enabled || !root) return;
    const update = () => setPick(pickFromSelection(root));
    const onUp = () => setTimeout(update, 0);
    document.addEventListener('selectionchange', update);
    root.addEventListener('mouseup', onUp);
    root.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('selectionchange', update);
      root.removeEventListener('mouseup', onUp);
      root.removeEventListener('keyup', onUp);
    };
  }, [root, enabled]);

  useCommentShortcut(
    () => {
      const p = pickFromSelection(root);
      if (p) onPick(p);
    },
    enabled && !hideComment && !!root,
  );

  if (!enabled || !pick) return null;
  let left = Math.max(8, Math.min(window.innerWidth - 130, (pick.rect.left + pick.rect.right) / 2 - 55));
  let top = pick.rect.top > 56 ? pick.rect.top - 44 : pick.rect.bottom + 8;
  if (lead) {
    const w = size?.w ?? 300;
    const h = size?.h ?? 42;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, (pick.rect.left + pick.rect.right) / 2 - w / 2));
    // above the selection; below it when there is no room above, never out of sight (K 88: a long selection)
    top =
      pick.rect.top - h - 8 > 56 ? pick.rect.top - h - 8 : Math.min(window.innerHeight - h - 8, pick.rect.bottom + 8);
  }
  const close = () => setPick(null);
  if (card && lead) {
    const act = (name: 'copy' | 'comment' | 'link' | 'more', text: string, run: () => void, testId: string) => (
      <button
        type="button"
        className="dc-selcard-act"
        data-testid={testId}
        aria-expanded={name === 'more' ? more : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run}
      >
        <SelIcon name={name} />
        {text}
      </button>
    );
    return (
      <div
        ref={barRef}
        className="dc-selbar dc-selcard"
        style={{ left, top }}
        data-testid="selection-toolbar"
        data-nocomment
      >
        {lead(pick, close)}
        <span className="dc-selcard-rule" aria-hidden="true" />
        <div className="dc-selcard-acts">
          {act(
            'copy',
            'Copy',
            () => {
              void navigator.clipboard?.writeText(pick.anchor.quote).catch(() => undefined);
              close();
            },
            'selection-copy',
          )}
          {!hideComment &&
            act(
              'comment',
              label,
              () => {
                onPick(pick);
                setPick(null);
              },
              'selection-comment',
            )}
          {pick.anchor.blockId &&
            act(
              'link',
              'Link',
              () => {
                const url = `${window.location.href.replace(/#.*$/, '')}#block-${pick.anchor.blockId}`;
                void navigator.clipboard?.writeText(url).catch(() => undefined);
                close();
              },
              'selection-link',
            )}
          {extra && act('more', 'More', () => setMore((v) => !v), 'selection-more')}
        </div>
        {more && extra && (
          <div className="dc-selcard-more" role="menu" aria-label="More">
            {extra(pick, close)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div ref={barRef} className="dc-selbar" style={{ left, top }} data-testid="selection-toolbar" data-nocomment>
      {lead && lead(pick, close)}
      {lead && (!hideComment || extra) && <span className="dc-selbar-sep" aria-hidden="true" />}
      {!hideComment && (
        <button
          type="button"
          data-testid="selection-comment"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onPick(pick);
            setPick(null);
          }}
        >
          <Icon name="comment" size={13} strokeWidth={2} />
          {label}
          <kbd>{SHORTCUT_LABEL}</kbd>
        </button>
      )}
      {!hideComment && extra && <span className="dc-selbar-sep" aria-hidden="true" />}
      {extra?.(pick, close)}
    </div>
  );
}

/**
 * The box that opens next to the selection to write a new inline comment.
 * @param props.pick - The selection being commented on.
 * @param props.projectId - Project used by the suggestion menu.
 * @param props.members - Members offered after `@`.
 * @param props.onSubmit - Posts the comment; reject to keep the text.
 * @param props.onCancel - Close the box.
 * @param props.me - The writer, shown as the avatar in the header ("ME New comment").
 */
export function ComposePopover({
  pick,
  projectId,
  members,
  onSubmit,
  onCancel,
  me,
}: {
  pick: Pick;
  projectId: string;
  members: SuggestMember[];
  me?: CommentPerson;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: pick.rect.left, top: pick.rect.bottom + 10 });
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 220;
    const w = 340;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, pick.rect.left));
    let top = pick.rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(8, pick.rect.top - h - 10);
    setPos({ left, top });
  }, [pick]);
  return (
    <div
      ref={ref}
      className="dc-compose"
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label="New comment"
      data-testid="compose-popover"
      data-nocomment
    >
      <div className="dc-compose-head">
        <span
          className="dc-compose-avatar"
          title={me?.name ?? 'You'}
          style={{ background: me?.bg ?? '#1E2A22', color: me?.color ?? '#FFFFFF' }}
        >
          {me?.initials ?? 'ME'}
        </span>
        <span className="dc-compose-title">New comment</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Close"
          data-testid="compose-close"
          style={{ width: 22, height: 22 }}
          onClick={onCancel}
        >
          <Icon name="close" size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="dc-quote" data-testid="compose-about">
        <Icon name="comment" size={13} strokeWidth={1.8} />
        <span>{pick.label ?? `“${pick.anchor.quote}”`}</span>
      </div>
      <CommentBox
        projectId={projectId}
        members={members}
        autoFocus
        placeholder="Write a comment…"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
      <div className="dc-hint">
        <span className="dk-kbd">Enter</span> to post · <span className="dk-kbd">Shift</span>{' '}
        <span className="dk-kbd">Enter</span> new line · <span className="dk-kbd">Esc</span> to cancel
      </div>
    </div>
  );
}

/** The 16 px icons of the bubble's actions (Reader 75): Copy, Comment, Link and More. */
function SelIcon({ name }: { name: 'copy' | 'comment' | 'link' | 'more' }) {
  const paths: Record<typeof name, string[]> = {
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
    comment: ['M4 5h16v11H9l-5 4z'],
    link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
    more: ['M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z'],
  };
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#3A4A3E"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
