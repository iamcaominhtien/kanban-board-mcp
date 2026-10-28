import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useEffect, useMemo, useRef, useState } from 'react';

function MathView({ node, selected, updateAttributes }: NodeViewProps) {
  const block = node.type.name === 'mathBlock';
  const latex = (node.attrs as { latex: string }).latex;
  const [editing, setEditing] = useState(!latex);
  const [draft, setDraft] = useState(latex);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const html = useMemo(
    () => katex.renderToString(latex || '\\square', { displayMode: block, throwOnError: false, strict: 'ignore' }),
    [latex, block],
  );

  function commit() {
    setEditing(false);
    if (draft !== latex) updateAttributes({ latex: draft.trim() });
  }

  return (
    <NodeViewWrapper
      as={block ? 'div' : 'span'}
      className={block ? 'dk-math dk-math-block' : 'dk-math dk-math-inline'}
      data-selected={selected || editing ? 'true' : undefined}
      contentEditable={false}
    >
      {editing ? (
        <textarea
          ref={input}
          className="dk-math-input"
          value={draft}
          rows={block ? 3 : 1}
          spellCheck={false}
          aria-label="LaTeX formula"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || (e.key === 'Enter' && (!block || e.metaKey || e.ctrlKey))) {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title="Click to edit formula"
          onClick={() => {
            setDraft(latex);
            setEditing(true);
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </NodeViewWrapper>
  );
}

const attrs = () => ({ latex: { default: '' } });

/** Inline `$formula$`, rendered with KaTeX and edited in place. */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes: attrs,

  parseHTML() {
    return [{ tag: 'span[data-math-inline]', getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex ?? '' }) }];
  },

  renderHTML({ node }) {
    const latex = (node.attrs as { latex: string }).latex;
    return ['span', mergeAttributes({ 'data-math-inline': '', 'data-latex': latex }), `$${latex}$`];
  },

  renderText({ node }) {
    return `$${(node.attrs as { latex: string }).latex}$`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView, { as: 'span' } as never);
  },

  markdownTokenName: 'mathInline',

  markdownTokenizer: {
    name: 'mathInline',
    level: 'inline',
    start: (src: string) => src.indexOf('$'),
    tokenize(src) {
      // no space inside the delimiters and no digit right after the closing one, so "$5 and $6" stays text
      const m = /^\$(?!\s|\$)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src);
      if (!m) return undefined;
      return { type: 'mathInline', raw: m[0], latex: m[1] };
    },
  },

  parseMarkdown(token, h) {
    return h.createNode('mathInline', { latex: (token as unknown as { latex: string }).latex });
  },

  renderMarkdown(node) {
    return `$${(node.attrs as { latex: string }).latex}$`;
  },
});

/** Display `$$ ... $$` block, rendered with KaTeX and edited in place. */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes: attrs,

  parseHTML() {
    return [{ tag: 'div[data-math-block]', getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex ?? '' }) }];
  },

  renderHTML({ node }) {
    const latex = (node.attrs as { latex: string }).latex;
    return ['div', mergeAttributes({ 'data-math-block': '', 'data-latex': latex }), `$$${latex}$$`];
  },

  renderText({ node }) {
    return `$$\n${(node.attrs as { latex: string }).latex}\n$$`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },

  markdownTokenName: 'mathBlock',

  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block',
    start: (src: string) => src.indexOf('$$'),
    tokenize(src) {
      const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      return { type: 'mathBlock', raw: m[0], latex: m[1].trim() };
    },
  },

  parseMarkdown(token, h) {
    return h.createNode('mathBlock', { latex: (token as unknown as { latex: string }).latex });
  },

  renderMarkdown(node) {
    return `$$\n${(node.attrs as { latex: string }).latex}\n$$`;
  },
});
