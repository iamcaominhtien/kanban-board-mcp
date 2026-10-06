import type { Editor } from '@tiptap/react';
import type { FindReplaceAdapter } from './FindInPage';

/** Find & Replace through ProseMirror transactions (one undo step per replace). */
export function createEditorReplaceAdapter(getEditor: () => Editor | null): FindReplaceAdapter {
  return {
    replace(find, replaceWith, opts) {
      const ed = getEditor();
      if (!ed || !find) return 0;
      const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(opts.wholeWord ? `\\b${esc}\\b` : esc, opts.matchCase ? 'g' : 'gi');
      const hits: { from: number; to: number }[] = [];
      ed.state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        if (node.marks.some((m) => m.type.name === 'code')) return;
        for (const m of node.text.matchAll(re)) hits.push({ from: pos + (m.index ?? 0), to: pos + (m.index ?? 0) + m[0].length });
      });
      const chosen = opts.all ? hits : hits.slice(opts.index, opts.index + 1);
      if (!chosen.length) return 0;
      const tr = ed.state.tr;
      for (const h of [...chosen].reverse()) {
        if (replaceWith) tr.insertText(replaceWith, h.from, h.to);
        else tr.delete(h.from, h.to);
      }
      ed.view.dispatch(tr);
      return chosen.length;
    },
    undo: () => {
      getEditor()?.commands.undo();
    },
  };
}

let active: FindReplaceAdapter | undefined;
/** The editor registers itself here while mounted so the find bar (in DocsSpace) can replace text. */
export function setActiveReplaceAdapter(a: FindReplaceAdapter | undefined) {
  active = a;
}
export function getActiveReplaceAdapter(): FindReplaceAdapter | undefined {
  return active;
}
