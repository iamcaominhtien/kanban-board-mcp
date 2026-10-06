import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import type { MenuHost } from '../menuHost';

interface Opts {
  name: string;
  char: string;
  host: MenuHost;
  allowSpaces?: boolean;
  allowedPrefixes?: string[] | null;
  startOfLine?: boolean;
  /** extra guard on the query text */
  accept?: (query: string) => boolean;
  command: (a: { editor: Editor; range: Range; payload: unknown }) => void;
}

/** A Tiptap suggestion trigger whose menu is drawn by React (see MenuHost). */
export function createSuggest(o: Opts) {
  const pluginKey = new PluginKey(o.name);
  return Extension.create({
    name: o.name,
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey,
          char: o.char,
          allowSpaces: o.allowSpaces ?? false,
          allowedPrefixes: o.allowedPrefixes === undefined ? [' '] : o.allowedPrefixes,
          startOfLine: o.startOfLine ?? false,
          shouldShow: ({ query }) => (o.accept ? o.accept(query) : true),
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            return $from.parent.type.name !== 'codeBlock' && !$from.parent.type.spec.code;
          },
          command: ({ editor, range, props }) => o.command({ editor, range, payload: props }),
          items: () => [],
          render: () => {
            const push = (p: {
              editor: Editor;
              range: Range;
              query: string;
              clientRect?: (() => DOMRect | null) | null;
              command: (props: unknown) => void;
            }) => {
              const $from = p.editor.state.doc.resolve(p.range.from);
              const lineBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, (leaf) =>
                String(leaf.attrs.label || leaf.attrs.page || leaf.attrs.key || ''),
              );
              o.host.set({
                editor: p.editor,
                range: p.range,
                query: p.query,
                lineBefore,
                rect: p.clientRect?.() ?? null,
                run: p.command,
              });
            };
            return {
              onStart: push,
              onUpdate: push,
              onExit: () => {
                o.host.keyHandler = null;
                o.host.set(null);
              },
              onKeyDown: ({ event }) => (o.host.keyHandler ? o.host.keyHandler(event) : false),
            };
          },
        }),
      ];
    },
  });
}
