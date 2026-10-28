import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { DiagramEmbed } from '../../../diagrams/DiagramEmbed';
import { DIAGRAM_LINE } from '../../../diagrams/diagramRefs';

function DiagramView({ node, updateAttributes, editor }: NodeViewProps) {
  const { id, label } = node.attrs as { id: string; label: string };
  return (
    <NodeViewWrapper className="dk-diagram" contentEditable={false} data-diagram={id}>
      <DiagramEmbed
        id={id}
        label={label}
        readOnly={!editor.isEditable}
        onReplace={(newId, newLabel) => updateAttributes({ id: newId, label: newLabel })}
        onChanged={(d) => d.label !== label && updateAttributes({ label: d.label })}
      />
    </NodeViewWrapper>
  );
}

/** A draw.io diagram on its own line: stored as `[label](diagram:dg_…)`, shown as the drawing. */
export const Diagram = Node.create({
  name: 'diagram',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { id: { default: '' }, label: { default: 'Diagram' } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-diagram]',
        getAttrs: (el) => ({
          id: (el as HTMLElement).dataset.diagram ?? '',
          label: (el as HTMLElement).dataset.label ?? 'Diagram',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const a = node.attrs as { id: string; label: string };
    return ['div', mergeAttributes({ 'data-diagram': a.id, 'data-label': a.label }), a.label];
  },

  renderText({ node }) {
    return (node.attrs as { label: string }).label;
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramView);
  },

  markdownTokenName: 'diagram',

  markdownTokenizer: {
    name: 'diagram',
    level: 'block',
    start: (src: string) => src.search(/^!?\[[^\]\n]*\]\(diagram:dg_/m),
    tokenize(src) {
      const m = /^(!?\[[^\]\n]*\]\(diagram:dg_[0-9a-f]{8}\))[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      const parts = DIAGRAM_LINE.exec(m[1]);
      if (!parts) return undefined;
      return { type: 'diagram', raw: m[0], label: parts[1], diagramId: parts[2] };
    },
  },

  parseMarkdown(token, h) {
    const t = token as unknown as { label: string; diagramId: string };
    return h.createNode('diagram', { id: t.diagramId, label: t.label || 'Diagram' });
  },

  renderMarkdown(node) {
    const a = node.attrs as { id: string; label: string };
    return `[${(a.label || 'Diagram').replace(/[[\]\n]+/g, ' ')}](diagram:${a.id})`;
  },
});
