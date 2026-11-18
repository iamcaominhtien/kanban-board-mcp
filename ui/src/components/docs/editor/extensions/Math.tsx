import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dataOnly } from '../../../../richdoc/extensions/attr';

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

  // the editing panel (design "Embeds", frames 68-69): the result under the LaTeX as it is typed, or why it cannot be read
  const live = useMemo(() => {
    if (!editing) return null;
    try {
      return {
        html: katex.renderToString(draft || '\\square', { displayMode: block, throwOnError: true, strict: 'ignore' }),
        error: null,
      };
    } catch (e) {
      return { html: null, error: e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, '') : 'unknown' };
    }
  }, [editing, draft, block]);

  function commit() {
    setEditing(false);
    if (draft !== latex) updateAttributes({ latex: draft.trim() });
  }

  const shown = (
    <span
      role="button"
      tabIndex={0}
      title="Click to edit formula"
      onClick={() => {
        if (editing) return;
        setDraft(latex);
        setEditing(true);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );

  // the formula stays in the page; editing opens a 420 px card under it (design "Embeds", frames 67-69)
  return (
    <NodeViewWrapper
      as={block ? 'div' : 'span'}
      className={block ? 'dk-math dk-math-block' : 'dk-math dk-math-inline'}
      data-selected={selected || editing ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      contentEditable={false}
    >
      {shown}
      {block && !editing && (
        <span className="dk-math-tip" aria-hidden="true">
          Click to edit formula
        </span>
      )}
      {editing && (
        <span className="dk-math-edit" role="dialog" aria-label="Formula">
          <span className="dk-math-title">Formula</span>
          <textarea
            ref={input}
            className="dk-math-input"
            value={draft}
            rows={block ? 3 : 2}
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
          {live?.html && (
            <span
              className="dk-math-live"
              aria-label="Result"
              contentEditable={false}
              dangerouslySetInnerHTML={{ __html: live.html }}
            />
          )}
          {live?.error && (
            <span className="dk-math-err" role="alert">
              The formula cannot be read: {live.error}
            </span>
          )}
          <span className="dk-math-hint">
            {block && <kbd>Ctrl</kbd>} <kbd>Enter</kbd> to apply, <kbd>Esc</kbd> to close
          </span>
        </span>
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

  renderHTML({ node, HTMLAttributes }) {
    const latex = (node.attrs as { latex: string }).latex;
    return [
      'div',
      mergeAttributes(dataOnly(HTMLAttributes), { 'data-math-block': '', 'data-latex': latex }),
      `$$${latex}$$`,
    ];
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
