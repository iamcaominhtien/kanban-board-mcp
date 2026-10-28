import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CommentAnchorInput } from '../../../types/docs';
import { Icon } from '../Icon';
import { CommentBox } from './CommentBox';
import { anchorFromRange } from './anchorDom';

export interface Pick {
  anchor: CommentAnchorInput;
  /** Viewport rect of the selection. */
  rect: { left: number; right: number; top: number; bottom: number };
  /** The selected DOM range (view mode), kept highlighted while the box is open. */
  range?: Range;
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
  const r = range.getBoundingClientRect();
  return { anchor, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, range: range.cloneRange() };
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
}: {
  root: HTMLElement | null;
  label: string;
  enabled: boolean;
  onPick: (p: Pick) => void;
}) {
  const [pick, setPick] = useState<Pick | null>(null);

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

  useCommentShortcut(() => {
    const p = pickFromSelection(root);
    if (p) onPick(p);
  }, enabled && !!root);

  if (!enabled || !pick) return null;
  const left = Math.max(8, Math.min(window.innerWidth - 130, (pick.rect.left + pick.rect.right) / 2 - 55));
  const top = pick.rect.top > 56 ? pick.rect.top - 44 : pick.rect.bottom + 8;
  return (
    <div className="dc-selbar" style={{ left, top }} data-testid="selection-toolbar" data-nocomment>
      <button
        type="button"
        data-testid="selection-comment"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onPick(pick);
          setPick(null);
        }}
      >
        <Icon name="comment" size={14} strokeWidth={1.9} />
        {label}
        <kbd>{SHORTCUT_LABEL}</kbd>
      </button>
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
 */
export function ComposePopover({
  pick,
  projectId,
  members,
  onSubmit,
  onCancel,
}: {
  pick: Pick;
  projectId: string;
  members: { id: string; name: string; bg: string; color: string }[];
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
      <div className="dc-compose-title">New comment</div>
      <div className="dc-quote">
        <Icon name="comment" size={13} strokeWidth={1.8} />
        <span>“{pick.anchor.quote}”</span>
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
        <kbd>Enter</kbd> to post · <kbd>Esc</kbd> to cancel
      </div>
    </div>
  );
}
