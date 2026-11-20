import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CalloutView } from '../blocks/CalloutView';
import { CALLOUT_ALIASES, CALLOUT_STYLE, type CalloutKind } from '../constants';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (kind?: CalloutKind) => ReturnType;
      toggleCallout: (kind?: CalloutKind) => ReturnType;
      setCalloutKind: (kind: CalloutKind) => ReturnType;
    };
  }
}

const focusKey = new PluginKey('calloutFocus');

/** Callout block, stored as a GitHub alert: `> [!WARNING]` followed by `> ` lines. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return { kind: { default: 'info' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]', getAttrs: (el) => ({ kind: (el as HTMLElement).dataset.callout || 'info' }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': node.attrs.kind, class: 'dk-callout' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },

  addCommands() {
    return {
      setCallout:
        (kind = 'info') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { kind }),
      toggleCallout:
        (kind = 'info') =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { kind }),
      setCalloutKind:
        (kind) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { kind }),
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^:::(info|warn|warning|ok|success)\s$/,
        type: this.type,
        getAttributes: (m) => ({ kind: CALLOUT_ALIASES[m[1].toUpperCase()] ?? 'info' }),
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Enter twice on an empty last line leaves the callout
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty) return false;
        let depth = $from.depth;
        while (depth > 0 && $from.node(depth).type.name !== this.name) depth -= 1;
        if (depth === 0) return false;
        const callout = $from.node(depth);
        const para = $from.parent;
        if (para.type.name !== 'paragraph' || para.content.size > 0) return false;
        if ($from.index(depth) !== callout.childCount - 1 || callout.childCount < 2) return false;
        const start = $from.before();
        const end = $from.after();
        const afterCallout = $from.after(depth) - (end - start);
        const tr = state.tr.delete(start, end);
        const pos = afterCallout;
        tr.insert(pos, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const parent = $from.node($from.depth - 1);
        // backspace at the very start of a callout unwraps it
        if (parent?.type.name === this.name && $from.index($from.depth - 1) === 0) {
          return editor.commands.lift(this.name);
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: focusKey,
        props: {
          decorations: (state) => {
            const { $from } = state.selection;
            for (let d = $from.depth; d > 0; d -= 1) {
              if ($from.node(d).type.name === this.name) {
                return DecorationSet.create(state.doc, [
                  Decoration.node($from.before(d), $from.after(d), { class: 'is-focused' }),
                ]);
              }
            }
            return null;
          },
        },
      }),
    ];
  },

  markdownTokenName: 'callout',

  markdownTokenizer: {
    name: 'callout',
    level: 'block',
    start: (src: string) => src.search(/^ {0,3}>[ \t]?\[!\w+\]/m),
    tokenize(src, _tokens, lexer) {
      const m = /^ {0,3}>[ \t]?\[!(\w+)\][ \t]*([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/.exec(src);
      if (!m) return undefined;
      const kind = CALLOUT_ALIASES[m[1].toUpperCase()];
      if (!kind) return undefined;
      const body = m[3]
        .split('\n')
        .map((l) => l.replace(/^ {0,3}> ?/, ''))
        .join('\n')
        .trimEnd();
      const inner = [m[2], body].filter((x) => x !== '').join('\n');
      return { type: 'callout', raw: m[0], kind, tokens: lexer.blockTokens(inner || '') };
    },
  },

  parseMarkdown(token, h) {
    const children = h.parseChildren((token.tokens as never) ?? []);
    return h.createNode(
      'callout',
      { kind: (token as unknown as { kind: string }).kind },
      children.length ? children : [h.createNode('paragraph')],
    );
  },

  renderMarkdown(node, h) {
    const kind = (node.attrs?.kind as CalloutKind) ?? 'info';
    const body = h.renderChildren(node.content ?? [], '\n\n');
    const lines = body.split('\n').map((l) => (l ? `> ${l}` : '>'));
    // a title (format 1) goes on the marker line: read back, it is the first line of the body (today's rule)
    const title = typeof node.attrs?.title === 'string' ? node.attrs.title.replace(/\s+/g, ' ').trim() : '';
    return [`> [!${CALLOUT_STYLE[kind]?.marker ?? 'INFO'}]${title ? ` ${title}` : ''}`, ...lines].join('\n');
  },
});
