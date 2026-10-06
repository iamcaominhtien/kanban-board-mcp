import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';

export const lowlight = createLowlight(common);

const LANGS = [
  ['', 'Plain text'],
  ['bash', 'Shell'],
  ['sh', 'sh'],
  ['json', 'JSON'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['sql', 'SQL'],
  ['yaml', 'YAML'],
  ['xml', 'HTML / XML'],
  ['css', 'CSS'],
  ['markdown', 'Markdown'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['java', 'Java'],
  ['ini', 'INI / TOML'],
];

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const lang = (node.attrs.language as string) ?? '';
  const known = LANGS.some(([v]) => v === lang);
  return (
    <NodeViewWrapper className="dk-code-wrap" data-language={lang || undefined} style={{ position: 'relative' }}>
      <pre className="dk-code" spellCheck={false}>
        <NodeViewContent as={'code' as 'div'} />
      </pre>
      <select
        className="dk-code-lang"
        aria-label="Code language"
        contentEditable={false}
        value={lang}
        disabled={!editor.isEditable}
        onChange={(e) => updateAttributes({ language: e.target.value || null })}
      >
        {!known && <option value={lang}>{lang}</option>}
        {LANGS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </NodeViewWrapper>
  );
}

/** Fenced code with lowlight highlighting (palette in editor.css: mc-k/s/p/c/f) and a language picker. */
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: null });
