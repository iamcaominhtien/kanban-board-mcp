/** Whether the cursor is inside a node view's node, kept up to date (the block's own controls show then). */

import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';

/**
 * True while the selection is inside (or on) the node at `getPos()` of size `size`.
 * @param getPos - The node view's getPos.
 * @param size - The node's size (`node.nodeSize`).
 */
export function useInside(editor: Editor, getPos: (() => number | undefined) | boolean, size: number): boolean {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    const check = () => {
      const p = typeof getPos === 'function' ? getPos() : undefined;
      if (p == null || editor.isDestroyed) return setInside(false);
      const { from, to } = editor.state.selection;
      setInside(editor.isEditable && from >= p && to <= p + size);
    };
    check();
    editor.on('selectionUpdate', check);
    editor.on('transaction', check);
    return () => {
      editor.off('selectionUpdate', check);
      editor.off('transaction', check);
    };
  }, [editor, getPos, size]);
  return inside;
}

/** Re-renders the component after every transaction of `editor` (for panels that read the document directly). */
export function useEditorTick(editor: Editor): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    editor.on('transaction', on);
    return () => {
      editor.off('transaction', on);
    };
  }, [editor]);
  return tick;
}
