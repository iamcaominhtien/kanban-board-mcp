/**
 * A comment started in the editor (selection bar, Ctrl+Alt+M, or the block menu's Comment): the selected text with
 * the block it is in, or a whole image, table or embed when the block itself is selected (its quote is its alt text,
 * first cell or title), or cells of a table (their text, "Table · 2 cells").
 */

import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { RichDoc } from '../../../types/docs';
import { anchorFromState } from '../editor/extensions/CommentHighlights';
import { WHOLE_COMMENT_BLOCKS, anchorForBlock, blockLabel } from './blockAnchor';
import type { Pick } from './SelectionComment';

const rectOf = (r: { left: number; right: number; top: number; bottom: number }) => ({
  left: r.left,
  right: r.right,
  top: r.top,
  bottom: r.bottom,
});

/**
 * The comment a selection in the editor starts, or null when there is nothing to comment on (an empty selection, or
 * text across blocks the anchor cannot hold).
 * @param ed - The editor.
 */
export function editorCommentPick(ed: Editor): Pick | null {
  const sel = ed.state.selection;
  if (sel instanceof NodeSelection && WHOLE_COMMENT_BLOCKS.has(sel.node.type.name)) {
    const node = sel.node.toJSON() as RichDoc;
    const dom = ed.view.nodeDOM(sel.from) as HTMLElement | null;
    const r = dom?.getBoundingClientRect ? dom.getBoundingClientRect() : ed.view.coordsAtPos(sel.from);
    return { anchor: anchorForBlock(node, ed.getJSON()), rect: rectOf(r), label: blockLabel(node) ?? undefined };
  }
  const hit = anchorFromState(ed.state);
  if (!hit) return null;
  const top = sel.$from.depth >= 1 ? sel.$from.node(1) : null;
  const blockId = top?.attrs.blockId;
  if (typeof blockId === 'string' && blockId) hit.anchor.blockId = blockId;
  const cells = top?.type.name === 'table' ? sel.ranges.length : 0;
  const a = ed.view.coordsAtPos(hit.from);
  const b = ed.view.coordsAtPos(hit.to);
  return {
    anchor: hit.anchor,
    rect: { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: a.top, bottom: b.bottom },
    ...(cells > 1 ? { label: `Table · ${cells} cells` } : {}),
  };
}
