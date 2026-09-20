import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';
import { remarkAlignDirectives, remarkHighlight } from './markdownPlugins';
import styles from './MarkdownRenderer.module.css';

const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img', 'mark'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: ['src', 'alt', 'title'],
    // `div` is already allowed by the default schema; restrict the `style`
    // attribute we add (for the align-center/align-right blocks) to a
    // `text-align` value only, rather than allowing arbitrary style
    // injection.
    div: [...(defaultSchema.attributes?.div ?? []), ['style', /^text-align:\s*(left|center|right)$/]],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    src: ['http', 'https'],
  },
};

interface MarkdownRendererProps {
  children: string;
}

// `remark-directive`'s container syntax is `:::name` (no space before the
// name), but the editor's Align toolbar buttons insert `::: center` /
// `::: right` (with a space) to match the design. Normalize just those two
// known directive lines before parsing so both forms render the same way.
function normalizeAlignDirectives(markdown: string): string {
  return markdown.replace(/^:::[ \t]+(center|right)\b/gm, ':::$1');
}

export function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, remarkAlignDirectives, remarkHighlight]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
      >
        {normalizeAlignDirectives(children)}
      </ReactMarkdown>
    </div>
  );
}
