import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const key = new PluginKey('docsNeedsInput');
const MARKER = /\\?\[Needs input:[^\]\n]*\\?\]/g;

/** Draws the `[Needs input: ...]` markers an AI draft leaves as warning chips; the text itself is not changed. */
export const NeedsInput = Extension.create({
  name: 'docsNeedsInput',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const found: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text || !node.text.includes('Needs input:')) return;
              for (const m of node.text.matchAll(MARKER)) {
                const from = pos + (m.index ?? 0);
                found.push(
                  Decoration.inline(from, from + m[0].length, { class: 'dk-needs-input', title: 'Needs input' }),
                );
              }
            });
            return found.length ? DecorationSet.create(state.doc, found) : null;
          },
        },
      }),
    ];
  },
});
