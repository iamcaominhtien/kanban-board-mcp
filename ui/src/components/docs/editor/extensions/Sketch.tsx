import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { SketchEmbed } from '../../../sketch/SketchEmbed';
import { SKETCH_LINE } from '../../../sketch/sketchRefs';

function SketchView({ node, updateAttributes, editor }: NodeViewProps) {
  const { id, label } = node.attrs as { id: string; label: string };
  return (
    <NodeViewWrapper className="dk-sketch" contentEditable={false} data-sketch={id}>
      <SketchEmbed
        id={id}
        label={label}
        readOnly={!editor.isEditable}
        onReplace={(newId, newTitle) => updateAttributes({ id: newId, label: newTitle })}
        onChanged={(s) => s.title !== label && updateAttributes({ label: s.title })}
      />
    </NodeViewWrapper>
  );
}

/** A sketch on its own line: stored as `![label](sketch:sk_…)`, shown as the drawing. */
export const Sketch = Node.create({
  name: 'sketch',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { id: { default: '' }, label: { default: 'Sketch' } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-sketch]',
        getAttrs: (el) => ({
          id: (el as HTMLElement).dataset.sketch ?? '',
          label: (el as HTMLElement).dataset.label ?? 'Sketch',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const a = node.attrs as { id: string; label: string };
    return ['div', mergeAttributes({ 'data-sketch': a.id, 'data-label': a.label }), a.label];
  },

  renderText({ node }) {
    return (node.attrs as { label: string }).label;
  },

  addNodeView() {
    return ReactNodeViewRenderer(SketchView);
  },

  markdownTokenName: 'sketch',

  markdownTokenizer: {
    name: 'sketch',
    level: 'block',
    start: (src: string) => src.search(/^!?\[[^\]\n]*\]\(sketch:sk_/m),
    tokenize(src) {
      const m = /^(!?\[[^\]\n]*\]\(sketch:sk_[0-9a-f]{8}\))[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      const parts = SKETCH_LINE.exec(m[1]);
      if (!parts) return undefined;
      return { type: 'sketch', raw: m[0], label: parts[1], sketchId: parts[2] };
    },
  },

  parseMarkdown(token, h) {
    const t = token as unknown as { label: string; sketchId: string };
    return h.createNode('sketch', { id: t.sketchId, label: t.label || 'Sketch' });
  },

  renderMarkdown(node) {
    const a = node.attrs as { id: string; label: string };
    return `![${(a.label || 'Sketch').replace(/[[\]\n]+/g, ' ')}](sketch:${a.id})`;
  },
});
