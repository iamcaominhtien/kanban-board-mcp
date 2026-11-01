import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { CanvasEmbed } from '../../../canvas/CanvasEmbed';
import { CANVAS_LINE } from '../../../canvas/canvasRefs';

function CanvasView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const { id, label, fragment } = node.attrs as { id: string; label: string; fragment: string };
  return (
    <NodeViewWrapper className="dk-canvas" contentEditable={false} data-canvas={id}>
      <CanvasEmbed
        id={id}
        label={label}
        boardId={fragment.startsWith('b_') ? fragment : undefined}
        pageId={fragment.startsWith('p_') ? fragment : undefined}
        readOnly={!editor.isEditable}
        onReplace={(newId, newTitle) => updateAttributes({ id: newId, label: newTitle, fragment: '' })}
        onRemove={editor.isEditable ? () => deleteNode() : undefined}
      />
    </NodeViewWrapper>
  );
}

/** A canvas on its own line: stored as `![label](canvas:cv_…[#b_…])`, shown as an overview of its boards. */
export const Canvas = Node.create({
  name: 'canvas',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { id: { default: '' }, label: { default: 'Canvas' }, fragment: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-canvas]',
        getAttrs: (el) => ({
          id: (el as HTMLElement).dataset.canvas ?? '',
          label: (el as HTMLElement).dataset.label ?? 'Canvas',
          fragment: (el as HTMLElement).dataset.fragment ?? '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const a = node.attrs as { id: string; label: string; fragment: string };
    return [
      'div',
      mergeAttributes({ 'data-canvas': a.id, 'data-label': a.label, 'data-fragment': a.fragment }),
      a.label,
    ];
  },

  renderText({ node }) {
    return (node.attrs as { label: string }).label;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CanvasView);
  },

  markdownTokenName: 'canvas',

  markdownTokenizer: {
    name: 'canvas',
    level: 'block',
    start: (src: string) => src.search(/^!\[[^\]\n]*\]\(canvas:cv_/m),
    tokenize(src) {
      const m = /^(!\[[^\]\n]*\]\(canvas:cv_[0-9a-f]{8}(?:#(?:b|p)_[0-9a-f]{8})?\))[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      const parts = CANVAS_LINE.exec(m[1]);
      if (!parts) return undefined;
      return { type: 'canvas', raw: m[0], label: parts[1], canvasId: parts[2], fragment: parts[3] ?? '' };
    },
  },

  parseMarkdown(token, h) {
    const t = token as unknown as { label: string; canvasId: string; fragment: string };
    return h.createNode('canvas', { id: t.canvasId, label: t.label || 'Canvas', fragment: t.fragment });
  },

  renderMarkdown(node) {
    const a = node.attrs as { id: string; label: string; fragment: string };
    return `![${(a.label || 'Canvas').replace(/[[\]\n]+/g, ' ')}](canvas:${a.id}${a.fragment ? `#${a.fragment}` : ''})`;
  },
});
