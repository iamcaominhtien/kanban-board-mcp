import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const key = new PluginKey('tableMethods');
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** HTTP verbs in the first column of a table are coloured like in the board (GET blue, POST green, PATCH amber…). */
export const TableMethods = Extension.create({
  name: 'tableMethods',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'table') return;
              node.forEach((row, rowOffset) => {
                const cell = row.firstChild;
                if (!cell || cell.type.name !== 'tableCell') return;
                const text = cell.textContent.trim();
                if (!METHODS.has(text)) return;
                const cellPos = pos + 1 + rowOffset + 1;
                decos.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { class: `dk-method dk-method-${text.toLowerCase()}` }));
              });
              return false;
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
