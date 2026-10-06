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

/** Hint on the empty top-level line that holds the caret (board: "Type / for blocks, or [[ ...") */
export const Placeholder = Extension.create({
  name: 'docsPlaceholder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const { selection } = state;
            if (!selection.empty) return null;
            const { $from } = selection;
            if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget($from.pos, widget, { side: -1, key: 'ph' }),
              Decoration.node($from.before(), $from.after(), { class: 'dk-empty' }),
            ]);
          },
        },
      }),
    ];
  },
});
