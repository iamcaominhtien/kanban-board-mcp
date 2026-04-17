import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: ['src', 'alt', 'title'],
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
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
    >
      {children}
    </ReactMarkdown>
  );
}
