/**
 * The board's own lines in a thread, which are not comments anyone wrote: `sent` (the thread went to an AI on a
 * ticket) and `anchor` (a publish changed the text the thread is on). They do not count as the thread's last word.
 */

import type { DocsCommentItem } from '../../../types/docs';

/** Whether a comment is the line a publish wrote when it changed the thread's text ("Text rewritten in v4"). */
export function isAnchorLine(c: DocsCommentItem): boolean {
  return c.ai?.kind === 'anchor';
}

/** Whether a comment is one of the board's own lines (`sent` or `anchor`). */
export function isBoardLine(c: DocsCommentItem): boolean {
  return c.ai?.kind === 'sent' || c.ai?.kind === 'anchor';
}

/** The comments people wrote (the board's lines left out). */
export function spoken(comments: DocsCommentItem[]): DocsCommentItem[] {
  return comments.filter((c) => !isBoardLine(c));
}
