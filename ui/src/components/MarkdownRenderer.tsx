import { useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { resolveOrigin } from '../api/resolveOrigin';
import { FileAttachmentCard } from './FileAttachmentCard';
import { FilePreviewModal } from './FilePreviewModal';
import { useResolveRefs, useRestorePage } from '../api/docs';
import { useToast } from './Toast';
import { RefChip } from './docs/RefChip';
import { useDocsRefs } from './docs/DocsRefsContext';
import { linkifyDocs, parseDocRef, remarkDocs, REF_SCHEME, TICKET_SCHEME } from '../utils/docsMarkdown';
import type { DocsRefRequest } from '../types/docs';
import styles from './MarkdownRenderer.module.css';

const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img', 'mark', 'a'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    mark: ['class', 'className'],
    blockquote: ['dataCallout'],
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
  },
  clobberPrefix: 'docs-',
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ['http', 'https', 'mailto', 'docref', 'dockey', 'member'],
    src: ['http', 'https'],
  },
};

/** Turns on the Docs extras: [[page]] and ticket-key chips, callouts and heading anchors. */
export interface DocsRenderOptions {
  projectId: string;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
}

const NO_REFS: DocsRefRequest[] = [];
const CALLOUT_ICONS: Record<string, string> = { info: 'ℹ', warning: '⚠', danger: '⛔', tip: '💡' };

interface MarkdownRendererProps {
  children: string;
  docs?: DocsRenderOptions;
  /** Never turn references into pills (e.g. raw previews). */
  plain?: boolean;
  /** Render a single line inline (acceptance criteria): paragraphs are unwrapped. */
  inline?: boolean;
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

/** Render Markdown with callouts, images, file cards and doc-reference pills. */
export function MarkdownRenderer({ children, docs: docsProp, plain, inline }: MarkdownRendererProps) {
  const Wrapper = (inline ? 'span' : 'div') as 'div';
  const refs = useDocsRefs();
  const toast = useToast();
  const restorePage = useRestorePage(refs?.projectId ?? '');
  const ticketSurface = !docsProp && !!refs && !plain;
  const docs: DocsRenderOptions | undefined =
    docsProp ??
    (refs && !plain
      ? { projectId: refs.projectId, onOpenPage: (id, a) => refs.peek(id, a), onOpenTicket: refs.openTicket }
      : undefined);
  // Clean up any stray uploading:... placeholders before rendering, and preprocess raw <img> tags
  let cleanedContent = children ? children.replace(/!\[Uploading [^\]]*\]\(uploading:[^)]+\)/g, '') : '';
  // Support both /api/uploads/ and /uploads/ interchangeably
  cleanedContent = cleanedContent.replace(/\/api\/uploads\//g, '/uploads/');

  // Convert Pandoc/Kramdown/Obsidian style image attributes: ![alt](url){width=...} -> ![alt|width](url)
  cleanedContent = cleanedContent.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\{(?:width=)?(\d+(?:%|px)?)[^}]*\}/gi,
    (_match, alt, url, width) => `![${alt ? `${alt}|${width}` : width}](${url})`,
  );

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

  // @[Name](member:id) is stored as written; render it as a link so the `a` renderer can make the chip
  cleanedContent = cleanedContent.replace(/@\[([^\]]+)\]\(member:([^)\s]+)\)/g, '[@$1](member:$2)');

  const linked = useMemo(
    () => (docs ? linkifyDocs(cleanedContent) : { markdown: cleanedContent, refs: NO_REFS }),
    [docs, cleanedContent],
  );
  const resolved = useResolveRefs(docs?.projectId ?? '', linked.refs);
  const resolvedPages = new Map<string, NonNullable<typeof resolved.data>[number]>();
  const resolvedTickets = new Map<string, NonNullable<typeof resolved.data>[number]>();
  linked.refs.forEach((ref, i) => {
    const res = resolved.data?.[i];
    if (!res) return;
    if (ref.kind === 'page') resolvedPages.set(`${ref.title}#${ref.anchor ?? ''}`, res);
    else resolvedTickets.set(ref.key, res);
  });

  return (
    <Wrapper className={styles.markdown} style={inline ? { display: 'inline' } : undefined}>
      <ReactMarkdown
        remarkPlugins={docs ? [remarkGfm, remarkDocs] : [remarkGfm]}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
        urlTransform={(url) =>
          url.startsWith(REF_SCHEME) || url.startsWith(TICKET_SCHEME) || url.startsWith('member:')
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          ...(inline ? { p: ({ children: inner }: { children?: React.ReactNode }) => <>{inner}</> } : {}),
          blockquote: ({ node, children: inner, ...props }) => {
            const kind = (node?.properties as { dataCallout?: string } | undefined)?.dataCallout;
            if (!kind) return <blockquote {...props}>{inner}</blockquote>;
            return (
              <div className={`${styles.callout} ${styles[`callout_${kind}`] ?? ''}`} role="note">
                <span className={styles.calloutIcon} aria-hidden="true">
                  {CALLOUT_ICONS[kind]}
                </span>
                <div className={styles.calloutBody}>{inner}</div>
              </div>
            );
          },
          img: ({ src, alt, ...props }) => <MarkdownImage src={src} alt={alt} {...props} />,
          a: ({ href, children, ...props }) => {
            if (href?.startsWith('member:')) {
              return (
                <span
                  data-testid="mention-chip"
                  data-member={href.slice(7)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 999,
                    background: '#E8F1FB',
                    border: '1px solid #B9D3EE',
                    color: '#2F6FB0',
                    fontSize: 13,
                    fontWeight: 600,
                    verticalAlign: 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {children}
                </span>
              );
            }
            if (docs && href?.startsWith(TICKET_SCHEME)) {
              const key = href.slice(TICKET_SCHEME.length);
              return (
                <RefChip
                  kind="ticket"
                  label={key}
                  result={resolvedTickets.get(key)}
                  surface={ticketSurface ? 'ticket' : 'docs'}
                  onOpenTicket={docs.onOpenTicket}
                />
              );
            }
            if (docs && href?.startsWith(REF_SCHEME)) {
              const ref = parseDocRef(href);
              return (
                <RefChip
                  kind="page"
                  label={String(children)}
                  result={ref ? resolvedPages.get(`${ref.title}#${ref.anchor ?? ''}`) : undefined}
                  projectId={docs.projectId}
                  pageTitle={ref?.title}
                  anchor={ref?.anchor ?? null}
                  surface={ticketSurface ? 'ticket' : 'docs'}
                  onPeek={ticketSurface ? refs?.peek : undefined}
                  onOpenInDocs={ticketSurface ? refs?.openInDocs : undefined}
                  onOpenPage={docs.onOpenPage}
                  onRestorePage={
                    ticketSurface
                      ? (id) => restorePage.mutate(id, { onSuccess: () => toast.success('Page restored') })
                      : undefined
                  }
                />
              );
            }
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
        {linked.markdown}
      </ReactMarkdown>
    </Wrapper>
  );
}
