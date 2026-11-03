import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const key = new PluginKey('docsPlaceholder');

function widget(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'dk-ph';
  el.setAttribute('contenteditable', 'false');
  el.innerHTML =
    'Type <span class="dk-kbd">/</span> for blocks, or <span class="dk-kbd">[[</span> to link a page or ticket';
  return el;
}

/** Hint on the empty top-level line that holds the caret, or on the page's empty last line (board: "Type / for blocks, or [[ ...") */
export const Placeholder = Extension.create({
  name: 'docsPlaceholder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const { selection, doc } = state;
            const { $from } = selection;
            // the empty line holding the caret, else the page's empty last line (DocsEditor board A shows the hint
            // there while the caret is elsewhere; the editor always keeps that trailing line, nothing is added)
            let at: number | null = null;
            if (
              selection.empty &&
              $from.depth === 1 &&
              $from.parent.type.name === 'paragraph' &&
              $from.parent.content.size === 0
            )
              at = $from.before();
            else {
              const last = doc.lastChild;
              if (doc.childCount > 1 && last?.type.name === 'paragraph' && last.content.size === 0)
                at = doc.content.size - last.nodeSize;
            }
            if (at == null) return null;
            const node = doc.nodeAt(at)!;
            return DecorationSet.create(doc, [
              Decoration.widget(at + 1, widget, { side: -1, key: 'ph' }),
              Decoration.node(at, at + node.nodeSize, { class: 'dk-empty' }),
            ]);
          },
        },
      }),
    ];
  },
});
