import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { buildRegex, type FindReplaceAdapter } from './FindInPage';

/** A match in the editor's document: positions of its first character and just after its last. */
export interface EditorMatch {
  from: number;
  to: number;
}

/** Stands for what is not searchable text inside a block (inline code, a chip, a formula): no match runs across it. */
const GAP = '￼';

/**
 * Every match of `find` in the document, in reading order. A match may run across bold, a link or a colour (the
 * text of one block is searched as a whole); text in inline code, chips and formulas is skipped.
 * @param doc - The editor's document.
 * @param find - The text searched for.
 * @param opts - Match case, whole word.
 */
export function findInDoc(doc: PMNode, find: string, opts: { matchCase: boolean; wholeWord: boolean }): EditorMatch[] {
  const re = buildRegex(find, opts.matchCase, opts.wholeWord);
  if (!re) return [];
  const hits: EditorMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText && child.text && !child.marks.some((m) => m.type.name === 'code')) {
        text += child.text;
        for (let i = 0; i < child.text.length; i++) at.push(start + i);
      } else {
        const n = child.isText ? (child.text?.length ?? 1) : 1;
        text += GAP.repeat(n);
        for (let i = 0; i < n; i++) at.push(-1);
      }
    });
    for (const m of text.matchAll(re)) {
      const a = m.index ?? 0;
      const b = a + m[0].length - 1;
      if (!m[0] || at.slice(a, b + 1).includes(-1)) continue;
      hits.push({ from: at[a], to: at[b] + 1 });
    }
    return false;
  });
  return hits;
}

/** Find & Replace through ProseMirror transactions (one undo step per replace). */
export function createEditorReplaceAdapter(getEditor: () => Editor | null): FindReplaceAdapter {
  return {
    replace(find, replaceWith, opts) {
      const ed = getEditor();
      if (!ed || !find) return 0;
      const hits = findInDoc(ed.state.doc, find, opts);
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
    find(find, opts) {
      const ed = getEditor();
      if (!ed || ed.isDestroyed) return [];
      const out: Range[] = [];
      for (const h of findInDoc(ed.state.doc, find, opts)) {
        try {
          const a = ed.view.domAtPos(h.from);
          const b = ed.view.domAtPos(h.to);
          const r = document.createRange();
          r.setStart(a.node, a.offset);
          r.setEnd(b.node, b.offset);
          out.push(r);
        } catch {
          /* a position the view does not draw (a collapsed block) */
        }
      }
      return out;
    },
  };
}

let active: FindReplaceAdapter | undefined;
/** The editor registers itself here while mounted so the find bar (in DocsSpace) can replace text. */
export function setActiveReplaceAdapter(a: FindReplaceAdapter | undefined) {
  active = a;
}
/** Return the mounted editor's find-and-replace adapter, if any. */
export function getActiveReplaceAdapter(): FindReplaceAdapter | undefined {
  return active;
}
