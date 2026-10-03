import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import styles from './MarkdownRenderer.module.css';

const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img', 'mark'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: ['src', 'alt', 'title'],
    mark: ['class', 'className'],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    src: ['http', 'https'],
  },
};

interface MarkdownRendererProps {
  children: string;
}

export function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
