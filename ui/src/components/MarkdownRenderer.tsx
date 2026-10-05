import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { resolveOrigin } from '../api/resolveOrigin';
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
  // Clean up any stray uploading:... placeholders before rendering
  const cleanedContent = children ? children.replace(/!\[Uploading [^\]]*\]\(uploading:[^)]+\)/g, '') : '';

  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
        components={{
          img: ({ src, alt, ...props }) => {
            if (!src || src.startsWith('uploading:')) return null;
            const resolvedSrc = src.startsWith('/uploads/') ? `${resolveOrigin()}${src}` : src;
            return (
              <img
                src={resolvedSrc}
                alt={alt || ''}
                loading="lazy"
                {...props}
              />
            );
          },
        }}
      >
        {cleanedContent}
      </ReactMarkdown>
    </div>
  );
}

