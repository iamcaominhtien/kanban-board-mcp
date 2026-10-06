import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { slugify } from '../../../../utils/docsMarkdown';

const key = new PluginKey('headingAnchors');

/** Slug ids on headings (`example-request`, duplicates `-2`, `-3`), computed like the server does. */
export const HeadingAnchors = Extension.create({
  name: 'headingAnchors',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const decos: Decoration[] = [];
            const seen = new Map<string, number>();
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'heading') return;
              const text = node.textBetween(0, node.content.size, '', (leaf) =>
                String(leaf.attrs.label || leaf.attrs.page || leaf.attrs.key || ''),
              );
              const base = slugify(text) || 'section';
              const n = (seen.get(base) ?? 0) + 1;
              seen.set(base, n);
              decos.push(Decoration.node(pos, pos + node.nodeSize, { id: n === 1 ? base : `${base}-${n}` }));
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
