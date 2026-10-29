import { InputRule, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { TICKET_DOT, TICKET_KEY_SRC } from '../constants';
import { useEditorEnv } from '../context';
import { useResolved } from '../useResolved';

function TicketRefView({ node, selected }: NodeViewProps) {
  const key = node.attrs.key as string;
  const env = useEditorEnv();
  const res = useResolved({ kind: 'ticket', key });

  // keys that are no ticket (ISO-8601, UTF-8, …) stay plain text
  if (res && res.status !== 'ok') {
    return (
      <NodeViewWrapper
        as="span"
        data-ref="ticket-plain"
        style={{ outline: selected ? '2px solid rgba(46,111,64,0.35)' : undefined }}
      >
        {key}
      </NodeViewWrapper>
    );
  }
  const dot = TICKET_DOT[res?.ticketStatus ?? ''] ?? '#9AA8A0';
  return (
    <NodeViewWrapper
      as="span"
      className="dk-chip dk-chip-ticket"
      data-ref="ticket"
      contentEditable={false}
      style={selected ? { boxShadow: '0 0 0 2px rgba(46,111,64,0.35)' } : undefined}
      title={res?.title ? `${key} · ${res.title}` : key}
      onClick={(e: React.MouseEvent) => {
        if (e.metaKey || e.ctrlKey) env?.onOpenTicket?.(key);
      }}
    >
      <span
        style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0, display: 'inline-block' }}
      />
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{key}</span>
    </NodeViewWrapper>
  );
}

/** Inline ticket key (KAN-12) shown as the board's ticket chip with a live status dot. */
export const TicketRef = Node.create<{ isTicket: (key: string) => boolean }>({
  name: 'ticketRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { isTicket: () => true };
  },

  addAttributes() {
    return { key: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-ticketref]', getAttrs: (el) => ({ key: (el as HTMLElement).dataset.ticketref ?? '' }) }];
  },

  renderHTML({ node }) {
    return ['span', { 'data-ticketref': node.attrs.key }, node.attrs.key];
  },

  renderText({ node }) {
    return node.attrs.key;
  },

  addNodeView() {
    return ReactNodeViewRenderer(TicketRefView, { as: 'span' } as never);
  },

  addInputRules() {
    const isTicket = this.options.isTicket;
    const type = this.type;
    return [
      // "KAN-12 " typed in the editor becomes a chip, but only for keys that exist in the project
      new InputRule({
        find: new RegExp(`(?:^|[\\s(])(${TICKET_KEY_SRC})([\\s.,;:)!?])$`),
        handler: ({ state, range, match }) => {
          const key = match[1];
          if (!isTicket(key)) return null;
          const tail = match[2];
          const keyStart = range.to - tail.length - key.length;
          state.tr.replaceWith(keyStart, range.to, [type.create({ key }), state.schema.text(tail)]);
        },
      }),
    ];
  },

  markdownTokenName: 'ticketRef',

  markdownTokenizer: {
    name: 'ticketRef',
    level: 'inline',
    start: (src: string) => {
      const m = new RegExp(`(?<![\\w\\-/])${TICKET_KEY_SRC}\\b`).exec(src);
      return m ? m.index : -1;
    },
    tokenize(src) {
      const m = new RegExp(`^${TICKET_KEY_SRC}\\b(?!-)`).exec(src);
      if (!m) return undefined;
      return { type: 'ticketRef', raw: m[0], key: m[0] };
    },
  },

  parseMarkdown(token, h) {
    return h.createNode('ticketRef', { key: (token as unknown as { key: string }).key });
  },

  renderMarkdown(node) {
    return node.attrs?.key ?? '';
  },
});
