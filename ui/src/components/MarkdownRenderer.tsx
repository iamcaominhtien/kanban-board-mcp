import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { resolveOrigin } from '../api/resolveOrigin';
import { FileAttachmentCard } from './FileAttachmentCard';
import { FilePreviewModal } from './FilePreviewModal';
import styles from './MarkdownRenderer.module.css';

const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img', 'mark', 'a'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    mark: ['class', 'className'],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

interface MarkdownRendererProps {
  children: string;
}

function MarkdownImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  if (!src || src.startsWith('uploading:')) return null;
  const resolvedSrc = src.startsWith('/uploads/') ? `${resolveOrigin()}${src}` : src;

  let cleanAlt = alt || '';
  let imageWidth: string | undefined = undefined;
  if (alt) {
    const sizeMatch = alt.match(/^(.*?)\s*\|\s*(?:width=)?(\d+(?:%|px)?)(?:x(\d+(?:%|px)?))?$/i);
    const numOnlyMatch = !sizeMatch ? alt.match(/^(\d+(?:%|px)?)$/) : null;
    if (sizeMatch) {
      cleanAlt = sizeMatch[1].trim();
      const w = sizeMatch[2];
      imageWidth = /^\d+$/.test(w) ? `${w}px` : w;
    } else if (numOnlyMatch) {
      cleanAlt = '';
      const w = numOnlyMatch[1];
      imageWidth = /^\d+$/.test(w) ? `${w}px` : w;
    }
  }

  return (
    <>
      <img
        src={resolvedSrc}
        alt={cleanAlt}
        loading="lazy"
        style={{
          cursor: 'pointer',
          width: imageWidth,
          maxWidth: '100%',
          height: 'auto',
          borderRadius: '6px',
        }}
        onClick={() => setIsPreviewOpen(true)}
        title="Click to preview"
        {...props}
      />
      {isPreviewOpen && (
        <FilePreviewModal
          isOpen={isPreviewOpen}
          onClose={() => setIsPreviewOpen(false)}
          url={src}
          fileName={cleanAlt || src.split('/').pop()}
        />
      )}
    </>
  );
}

export function MarkdownRenderer({ children }: MarkdownRendererProps) {
  // Clean up any stray uploading:... placeholders before rendering, and preprocess raw <img> tags
  let cleanedContent = children ? children.replace(/!\[Uploading [^\]]*\]\(uploading:[^)]+\)/g, '') : '';
  if (cleanedContent.includes('<img')) {
    cleanedContent = cleanedContent.replace(/<img\s+([^>]*?)>/gi, (_match, attrs) => {
      const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
      const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
      const widthMatch = attrs.match(/width=["']([^"']*)["']/i);
      if (!srcMatch) return '';
      const src = srcMatch[1];
      const alt = altMatch ? altMatch[1] : '';
      const width = widthMatch ? widthMatch[1] : '';
      if (width) {
        return `![${alt ? `${alt}|${width}` : width}](${src})`;
      }
      return `![${alt}](${src})`;
    });
  }

  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
        components={{
          img: ({ src, alt, ...props }) => (
            <MarkdownImage src={src} alt={alt} {...props} />
          ),
          a: ({ href, children, ...props }) => {
            if (href && (href.startsWith('/uploads/') || href.includes('/uploads/'))) {
              const fileName = typeof children === 'string' ? children : String(children || '');
              return <FileAttachmentCard url={href} fileName={fileName} />;
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {cleanedContent}
      </ReactMarkdown>
    </div>
  );
}

