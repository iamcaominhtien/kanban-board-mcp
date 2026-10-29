import type { Element } from 'hast';
import { Children, isValidElement, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { resolveOrigin } from '../../api/resolveOrigin';
import { useResolveRefs } from '../../api/docs';
import type { DocsRefRequest } from '../../types/docs';
import { escapeStrayDollars } from '../../utils/mathDollars';
import { linkifyDocs, parseDocRef, remarkDocs, REF_SCHEME, TICKET_SCHEME } from '../../utils/docsMarkdown';
import { FileAttachmentCard } from '../FileAttachmentCard';
import { galleryAround, previewAttrs, usePreview } from '../preview/PreviewContext';
import { highlight } from './docsHighlight';
import { useDocsPeek } from './DocsRefsContext';
import { Icon } from './Icon';
import { RefChip, type RefChipProps } from './RefChip';
import { DiagramEmbed } from '../diagrams/DiagramEmbed';
import { DIAGRAM_SCHEME, diagramIdOf, hasDiagram } from '../diagrams/diagramRefs';

const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'img', 'mark', 'a'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    mark: ['class', 'className'],
    blockquote: ['dataCallout'],
    code: [['className', /^(language-[\w-]+|math-inline|math-display)$/]],
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
    href: ['http', 'https', 'mailto', 'docref', 'dockey', 'diagram'],
    src: ['http', 'https', 'diagram'],
  },
};

const CALLOUTS: Record<string, { bg: string; border: string; color: string; icon: string }> = {
  warning: { bg: '#FEF6E7', border: '#F0DBA8', color: '#B8860B', icon: 'i14' },
  info: { bg: '#E8F1FB', border: '#B9D3EE', color: '#2F6FB0', icon: 'i28' },
  tip: { bg: '#EAF5EE', border: '#B7D9C0', color: '#2E6F40', icon: 'i17' },
  danger: { bg: '#FBE7E4', border: '#E8A99B', color: '#C4432A', icon: 'i22' },
};

const METHOD_COLORS: Record<string, string> = {
  GET: '#2F6FB0',
  POST: '#2E6F40',
  PUT: '#B4791E',
  PATCH: '#B4791E',
  DELETE: '#C4432A',
  HEAD: '#5B6B60',
  OPTIONS: '#5B6B60',
};

const NO_REFS: DocsRefRequest[] = [];

export interface DocsMarkdownProps {
  children: string;
  projectId: string;
  projectName?: string;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  onCreatePage?: (title: string) => void;
  onRestorePage?: (pageId: string) => void;
  onReplaceSection?: RefChipProps['onReplaceSection'];
  /** Source line text -> version that added it: marks those blocks "Changed in vN" (since last viewed). */
  changedIn?: Map<string, number>;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="dk-code" data-lang={lang}>
      {highlight(code, lang)}
      <button
        type="button"
        className="dk-code-copy"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'i24'} size={12} strokeWidth={2} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return checked ? (
    <span
      role="checkbox"
      aria-checked="true"
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        background: '#2E6F40',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginTop: 3,
        color: '#FFFFFF',
      }}
    >
      <Icon name="check" size={11} strokeWidth={3} />
    </span>
  ) : (
    <span
      role="checkbox"
      aria-checked="false"
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: '1.5px solid #C7D2CB',
        background: '#FFFFFF',
        boxSizing: 'border-box',
        flexShrink: 0,
        marginTop: 3,
      }}
    />
  );
}

/** An image in a page: click (or Enter / Space) to open it in the viewer with the other images on the page. */
function DocsImage({ src, alt }: { src: string; alt: string }) {
  const preview = usePreview();
  const name = alt || src.split('/').pop() || 'image';
  function open(el: HTMLElement) {
    const { items, index } = galleryAround(el);
    preview.open(items, index);
  }
  return (
    <img
      src={src.startsWith('/uploads/') ? `${resolveOrigin()}${src}` : src}
      alt={alt}
      loading="lazy"
      {...previewAttrs(src, name)}
      tabIndex={0}
      role="button"
      aria-label={`Open ${name}`}
      style={{ cursor: 'zoom-in' }}
      onClick={(e) => open(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(e.currentTarget);
        }
      }}
    />
  );
}

/**
 * Reader for a Docs page: the board's dk-md typography with callouts, tables, code, task lists and reference chips.
 * @param props.children - Markdown source of the page.
 * @param props.projectId - Project used to resolve references.
 * @param props.projectName - Space name used in reference tooltips.
 * @param props.onOpenPage - Called with page id and anchor when a page reference is opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onCreatePage - Called with a title when a missing page reference is created.
 * @param props.onRestorePage - Called with a page id when a deleted referenced page is restored.
 * @param props.onReplaceSection - Called when a stale section reference is replaced.
 * @param props.changedIn - Marks blocks whose source lines were added by a later version ("Changed in vN").
 */
export function DocsMarkdown({
  children,
  projectId,
  projectName,
  onOpenPage,
  onOpenTicket,
  onCreatePage,
  onRestorePage,
  onReplaceSection,
  changedIn,
}: DocsMarkdownProps) {
  const cleaned = (children ?? '').replace(/\/api\/uploads\//g, '/uploads/');
  const linked = useMemo(() => linkifyDocs(escapeStrayDollars(cleaned)), [cleaned]);
  const resolved = useResolveRefs(projectId, linked.refs.length ? linked.refs : NO_REFS);
  const pages = new Map<string, NonNullable<typeof resolved.data>[number]>();
  const tickets = new Map<string, NonNullable<typeof resolved.data>[number]>();
  linked.refs.forEach((ref, i) => {
    const res = resolved.data?.[i];
    if (!res) return;
    if (ref.kind === 'page') pages.set(`${ref.title}#${ref.anchor ?? ''}`, res);
    else tickets.set(ref.key, res);
  });

  // The component map must keep one identity across renders: a new function per render makes React remount
  // every chip (and close its hover card) whenever anything above re-renders.
  const peek = useDocsPeek();
  const live = useRef({
    peek,
    projectId,
    projectName,
    onOpenPage,
    onOpenTicket,
    onCreatePage,
    onRestorePage,
    onReplaceSection,
    pages,
    tickets,
    changedIn,
    lines: cleaned.split('\n'),
  });
  live.current = {
    peek,
    projectId,
    projectName,
    onOpenPage,
    onOpenTicket,
    onCreatePage,
    onRestorePage,
    onReplaceSection,
    pages,
    tickets,
    changedIn,
    lines: cleaned.split('\n'),
  };
  // Props that flag a block as changed since the viewer last looked, from its source lines (hast position).
  const changedProps = (node: Element | undefined): { className?: string; 'data-changed-in'?: string } => {
    const { changedIn: map, lines } = live.current;
    const start = node?.position?.start.line;
    const end = node?.position?.end.line;
    if (!map?.size || !start || !end) return {};
    let version = 0;
    for (let n = start; n <= end; n += 1) version = Math.max(version, map.get((lines[n - 1] ?? '').trim()) ?? 0);
    return version ? { className: 'dk-changed', 'data-changed-in': `Changed in v${version}` } : {};
  };
  const components = useMemo<Components>(
    () => ({
      h2: ({ node, children: inner, id }) => {
        const slug = (id ?? '').replace(/^docs-/, '');
        return (
          <h2 id={id} {...changedProps(node)}>
            {inner}
            {slug && (
              <a
                className="dk-anchor"
                href={`#${slug}`}
                title="Copy link to this section"
                onClick={(e) => {
                  e.preventDefault();
                  const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${slug}`;
                  void navigator.clipboard?.writeText(url);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: '#2E6F40',
                  padding: '2px 7px',
                  borderRadius: 5,
                  background: '#F1F8F3',
                  textDecoration: 'none',
                  maxWidth: 180,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="link" size={12} strokeWidth={2} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>#{slug}</span>
              </a>
            )}
          </h2>
        );
      },
      h3: ({ node, children: inner, id }) => (
        <h3 id={id} {...changedProps(node)}>
          {inner}
        </h3>
      ),
      blockquote: ({ node, children: inner, ...props }) => {
        const kind = (node?.properties as { dataCallout?: string } | undefined)?.dataCallout;
        const pal = kind ? CALLOUTS[kind] : null;
        if (!pal) return <blockquote {...props}>{inner}</blockquote>;
        return (
          <div className="dk-callout" role="note" style={{ background: pal.bg, border: `1px solid ${pal.border}` }}>
            <span style={{ color: pal.color, marginTop: 2, display: 'flex' }}>
              <Icon name={pal.icon} size={17} strokeWidth={1.9} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>{inner}</div>
          </div>
        );
      },
      pre: ({ node: _n, children: inner }) => {
        const code = Children.toArray(inner).find((c) => isValidElement(c)) as
          React.ReactElement<{ className?: string; children?: ReactNode }> | undefined;
        const lang = /language-([\w-]+)/.exec(code?.props.className ?? '')?.[1];
        return <CodeBlock code={textOf(code?.props.children).replace(/\n$/, '')} lang={lang} />;
      },
      table: ({ node: _n, children: inner }) => <table className="dk-table">{inner}</table>,
      th: ({ node: _n, children: inner, style }) => {
        const t = textOf(inner).trim();
        const width = t === 'Method' ? 78 : t === 'Auth' ? 70 : undefined;
        return <th style={{ ...style, ...(width ? { width } : {}) }}>{inner}</th>;
      },
      td: ({ node: _n, children: inner, style }) => {
        const t = textOf(inner).trim();
        if (METHOD_COLORS[t]) {
          return (
            <td style={style}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: METHOD_COLORS[t] }}>
                {t}
              </span>
            </td>
          );
        }
        return <td style={style}>{inner}</td>;
      },
      ul: ({ node: _n, children: inner, className }) => (
        <ul className={className?.includes('contains-task-list') ? 'dk-tasks' : undefined}>{inner}</ul>
      ),
      li: ({ node, children: inner, className }) => {
        // a loose list item holds <p>s that carry the mark themselves
        const own = node?.children.some((c) => c.type === 'element' && c.tagName === 'p') ? {} : changedProps(node);
        if (!className?.includes('task-list-item')) return <li {...own}>{inner}</li>;
        const input = node?.children.find((c) => c.type === 'element' && c.tagName === 'input');
        const checked = !!(input && 'properties' in input && (input.properties as { checked?: boolean }).checked);
        const rest = Children.toArray(inner).filter((c) => !(isValidElement(c) && c.type === 'input'));
        return (
          <li
            className={own.className ? `dk-task ${own.className}` : 'dk-task'}
            data-changed-in={own['data-changed-in']}
          >
            <Checkbox checked={checked} />
            <span
              style={
                checked
                  ? { color: '#9AA8A0', textDecoration: 'line-through', textDecorationColor: '#C7D2CB' }
                  : undefined
              }
            >
              {rest}
            </span>
          </li>
        );
      },
      p: ({ node, children: inner }) =>
        hasDiagram(node) ? <div>{inner}</div> : <p {...changedProps(node)}>{inner}</p>,
      img: ({ src, alt }) => {
        const diagramId = diagramIdOf(src);
        if (diagramId) return <DiagramEmbed id={diagramId} label={alt ?? ''} />;
        if (!src || src.startsWith('uploading:')) return null;
        return <DocsImage src={src} alt={alt ?? ''} />;
      },
      a: ({ href, children: inner, ...props }) => {
        const diagramId = diagramIdOf(href);
        if (diagramId) return <DiagramEmbed id={diagramId} label={textOf(inner)} />;
        if (href?.startsWith(TICKET_SCHEME)) {
          const key = href.slice(TICKET_SCHEME.length);
          return (
            <RefChip
              kind="ticket"
              label={key}
              result={live.current.tickets.get(key)}
              projectId={live.current.projectId}
              onOpenTicket={live.current.onOpenTicket}
            />
          );
        }
        if (href?.startsWith(REF_SCHEME)) {
          const ref = parseDocRef(href);
          const label = textOf(inner);
          const dflt = ref ? (ref.anchor ? `${ref.title} › ${ref.anchor}` : ref.title) : label;
          return (
            <RefChip
              kind="page"
              label={label}
              pageTitle={ref?.title}
              anchor={ref?.anchor}
              custom={!!ref && label !== dflt}
              result={ref ? live.current.pages.get(`${ref.title}#${ref.anchor ?? ''}`) : undefined}
              projectId={live.current.projectId}
              projectName={live.current.projectName}
              onOpenPage={live.current.onOpenPage}
              onPeek={live.current.peek ?? undefined}
              onCreatePage={live.current.onCreatePage}
              onRestorePage={live.current.onRestorePage}
              onReplaceSection={live.current.onReplaceSection}
            />
          );
        }
        if (href && href.includes('/uploads/')) return <FileAttachmentCard url={href} fileName={textOf(inner)} />;
        return (
          <a className="dk-ext" href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {inner}
            <Icon name="i38" size={12} strokeWidth={2} />
          </a>
        );
      },
    }),
    [],
  );

  return (
    <div className="dk-md" data-preview-scope>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkDocs]}
        // KaTeX runs after sanitize: its own markup would be stripped, and its input is only the sanitized math code.
        rehypePlugins={[
          [rehypeSanitize, SCHEMA],
          [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
        ]}
        urlTransform={(url) =>
          url.startsWith(REF_SCHEME) || url.startsWith(TICKET_SCHEME) || url.startsWith(DIAGRAM_SCHEME)
            ? url
            : defaultUrlTransform(url)
        }
        components={components}
      >
        {linked.markdown}
      </ReactMarkdown>
    </div>
  );
}
