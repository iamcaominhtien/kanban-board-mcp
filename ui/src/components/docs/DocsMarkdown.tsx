import type { Element } from 'hast';
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import { splitMarkdown } from '../../utils/markdownChunks';
import { markNeedsInput, NEEDS_INPUT_SCHEME } from '../../utils/writeRules';
import {
  linkifyDocs,
  pageRefKey,
  parseDocRef,
  remarkDocs,
  slugify,
  REF_SCHEME,
  TICKET_SCHEME,
} from '../../utils/docsMarkdown';
import { FileAttachmentCard } from '../FileAttachmentCard';
import { galleryAround, previewAttrs, usePreview } from '../preview/PreviewContext';
import { highlight } from './docsHighlight';
import { useDocsPeek } from './DocsRefsContext';
import { Icon } from './Icon';
import { RefChip, type RefChipProps } from './RefChip';
import { DiagramEmbed } from '../diagrams/DiagramEmbed';
import { DIAGRAM_SCHEME, diagramIdOf, hasDiagram } from '../diagrams/diagramRefs';
import { SketchEmbed } from '../sketch/SketchEmbed';
import { SKETCH_SCHEME, hasSketch, sketchIdOf } from '../sketch/sketchRefs';
import { CanvasChip, CanvasEmbed } from '../canvas/CanvasEmbed';
import { CANVAS_SCHEME, canvasRefOf, hasCanvas } from '../canvas/canvasRefs';

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
    href: ['http', 'https', 'mailto', 'docref', 'dockey', 'diagram', 'sketch', 'canvas', 'needsinput'],
    src: ['http', 'https', 'diagram', 'sketch', 'canvas'],
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

/** Props that mark a block: changed since the viewer last looked. */
interface BlockMark {
  className?: string;
  'data-changed-in'?: string;
}

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
  /**
   * Render a long page piece by piece (utils/markdownChunks): the top shows at once and the rest follows frame by
   * frame, so opening a 4,000-line page neither waits for the whole page nor blocks typing and scrolling. While pieces
   * are still coming the root carries `data-rendering`.
   */
  progressive?: boolean;
  /** Called once every piece is on the page (at once when not progressive). */
  onRendered?: () => void;
}

type RefResult = NonNullable<ReturnType<typeof useResolveRefs>['data']>[number];

/** What the reference chips show and do. It reaches them through a context, so the parsed page (the slow part of
 *  rendering a long page) is not built again when the references resolve or a callback above changes. */
interface ChipContext {
  pages: Map<string, RefResult>;
  tickets: Map<string, RefResult>;
  projectId: string;
  projectName?: string;
  peek: ReturnType<typeof useDocsPeek>;
  onOpenPage?: DocsMarkdownProps['onOpenPage'];
  onOpenTicket?: DocsMarkdownProps['onOpenTicket'];
  onCreatePage?: DocsMarkdownProps['onCreatePage'];
  onRestorePage?: DocsMarkdownProps['onRestorePage'];
  onReplaceSection?: DocsMarkdownProps['onReplaceSection'];
}

const ChipCtx = createContext<ChipContext | null>(null);

function TicketRefChip({ ticketKey }: { ticketKey: string }) {
  const c = useContext(ChipCtx)!;
  return (
    <RefChip
      kind="ticket"
      label={ticketKey}
      result={c.tickets.get(ticketKey)}
      projectId={c.projectId}
      onOpenTicket={c.onOpenTicket}
    />
  );
}

function PageRefChip({
  label,
  pageTitle,
  anchor,
  custom,
  refKey,
}: {
  label: string;
  pageTitle?: string;
  anchor?: string | null;
  custom: boolean;
  refKey: string | null;
}) {
  const c = useContext(ChipCtx)!;
  return (
    <RefChip
      kind="page"
      label={label}
      pageTitle={pageTitle}
      anchor={anchor}
      custom={custom}
      result={refKey != null ? c.pages.get(refKey) : undefined}
      projectId={c.projectId}
      projectName={c.projectName}
      onOpenPage={c.onOpenPage}
      onPeek={c.peek ?? undefined}
      onCreatePage={c.onCreatePage}
      onRestorePage={c.onRestorePage}
      onReplaceSection={c.onReplaceSection}
    />
  );
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

/** The heading a `#section` link points at, in the page the link sits in (heading ids carry the `docs-` prefix). */
function sectionOf(from: HTMLElement, href: string): HTMLElement | null {
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep it as written */
  }
  const scope: ParentNode = from.closest('.dk-md') ?? document;
  const ids = [id, `docs-${id}`, `docs-${slugify(id.replace(/^docs-/, ''))}`];
  for (const candidate of ids) {
    const el = scope.querySelector<HTMLElement>(`[id="${CSS.escape(candidate)}"]`);
    if (el) return el;
  }
  return null;
}

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkDocs];

/** The heading-id counts at the end of each piece of a page, filled as the pieces are parsed in order. */
type SlugCounts = Map<string, number>[];
// KaTeX runs after sanitize: its own markup would be stripped, and its input is only the sanitized math code.
const REHYPE_PLUGINS = [
  [rehypeSanitize, SCHEMA],
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
] as NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']>;

function docsUrlTransform(url: string): string {
  return url.startsWith(REF_SCHEME) ||
    url.startsWith(TICKET_SCHEME) ||
    url.startsWith(DIAGRAM_SCHEME) ||
    url.startsWith(SKETCH_SCHEME) ||
    url.startsWith(CANVAS_SCHEME) ||
    url.startsWith(NEEDS_INPUT_SCHEME)
    ? url
    : defaultUrlTransform(url);
}

/**
 * One piece of the page. Parsing it (remark, rehype, sanitize, KaTeX) is the cost of rendering, and ReactMarkdown does
 * it on every render: a piece renders again only when its text, the component map or the "Changed in" marks change.
 * The chips update through ChipCtx without it.
 */
const MarkdownPiece = memo(function MarkdownPiece({
  text,
  components,
  index,
  slugCounts,
}: {
  text: string;
  components: Components;
  /** Not read here: a new map of marks must render the piece again (`changedProps` reads it). */
  changedIn?: Map<string, number>;
  /** Which piece of the page this is, and the shared counts: a heading repeated in a later piece keeps the id the
   *  whole page gives it (`-2`, `-3`…), as the server's headings, the outline and `#section` links expect. */
  index?: number;
  slugCounts?: SlugCounts;
}) {
  const plugins = useMemo(
    () =>
      index === undefined || !slugCounts
        ? REMARK_PLUGINS
        : [
            remarkGfm,
            remarkMath,
            [
              remarkDocs,
              {
                seen: index > 0 ? slugCounts[index - 1] : undefined,
                done: (seen: Map<string, number>) => {
                  slugCounts[index] = seen;
                },
              },
            ] as const,
          ],
    [index, slugCounts],
  );
  return (
    <ReactMarkdown
      remarkPlugins={plugins as NonNullable<Parameters<typeof ReactMarkdown>[0]['remarkPlugins']>}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={docsUrlTransform}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});

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
 * @param props.progressive - Render a long page piece by piece.
 * @param props.onRendered - Called once the whole page is on the page.
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
  progressive = false,
  onRendered,
}: DocsMarkdownProps) {
  const cleaned = (children ?? '').replace(/\/api\/uploads\//g, '/uploads/');
  const linked = useMemo(
    () => linkifyDocs(markNeedsInput(escapeStrayDollars(cleaned)), { pageLinks: true }),
    [cleaned],
  );
  const resolved = useResolveRefs(projectId, linked.refs.length ? linked.refs : NO_REFS);
  const { pages, tickets } = useMemo(() => {
    const byPage = new Map<string, RefResult>();
    const byTicket = new Map<string, RefResult>();
    linked.refs.forEach((ref, i) => {
      const res = resolved.data?.[i];
      if (!res) return;
      if (ref.kind === 'page') byPage.set(pageRefKey(ref), res);
      else byTicket.set(ref.key, res);
    });
    return { pages: byPage, tickets: byTicket };
  }, [linked.refs, resolved.data]);

  const peek = useDocsPeek();
  const chips = useMemo<ChipContext>(
    () => ({
      pages,
      tickets,
      projectId,
      projectName,
      peek,
      onOpenPage,
      onOpenTicket,
      onCreatePage,
      onRestorePage,
      onReplaceSection,
    }),
    [
      pages,
      tickets,
      projectId,
      projectName,
      peek,
      onOpenPage,
      onOpenTicket,
      onCreatePage,
      onRestorePage,
      onReplaceSection,
    ],
  );
  // The component map must keep one identity across renders: a new function per render makes React remount
  // every chip (and close its hover card) whenever anything above re-renders.
  const lines = useMemo(() => cleaned.split('\n'), [cleaned]);
  const live = useRef({ changedIn, lines });
  live.current = { changedIn, lines };
  // Props that flag a block as changed since the viewer last looked, from its source lines (hast position).
  const changedProps = (node: Element | undefined): BlockMark => {
    const { changedIn: map, lines } = live.current;
    const start = node?.position?.start.line;
    const end = node?.position?.end.line;
    if (!start || !end) return {};
    let version = 0;
    for (let n = start; n <= end; n += 1) {
      const line = (lines[n - 1] ?? '').trim();
      version = Math.max(version, map?.get(line) ?? 0);
    }
    const out: BlockMark = {};
    const classes: string[] = [];
    if (version) {
      classes.push('dk-changed');
      out['data-changed-in'] = `Changed in v${version}`;
    }
    if (classes.length) out.className = classes.join(' ');
    return out;
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
        // AC-2: an edited callout is marked as a whole, with the bar and "Changed in vN" outside its box (the marks
        // of the paragraphs inside are hidden in docs.css), so they never cross its icon or border
        const { className: markClass, ...mark } = changedProps(node);
        const changed = markClass?.split(' ').includes('dk-changed');
        return (
          <div
            className={changed ? 'dk-callout dk-changed' : 'dk-callout'}
            {...(changed ? { 'data-changed-in': mark['data-changed-in'] } : {})}
            role="note"
            style={{ background: pal.bg, border: `1px solid ${pal.border}` }}
          >
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
      table: ({ node, children: inner }) => {
        // a table is one block: a row edited since last viewed marks the whole
        // table. The mark sits on a wrapper because the table clips its own overflow.
        const own = changedProps(node);
        // a table wider than the page (a column it cannot wrap) scrolls instead of being cut off
        const table = (
          <div className="dk-table-wrap">
            <table className="dk-table">{inner}</table>
          </div>
        );
        return own.className ? <div {...own}>{table}</div> : table;
      },
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
        hasDiagram(node) || hasSketch(node) || hasCanvas(node) ? (
          <div>{inner}</div>
        ) : (
          <p {...changedProps(node)}>{inner}</p>
        ),
      img: ({ src, alt }) => {
        const diagramId = diagramIdOf(src);
        if (diagramId) return <DiagramEmbed id={diagramId} label={alt ?? ''} />;
        const sketchId = sketchIdOf(src);
        if (sketchId) return <SketchEmbed id={sketchId} label={alt ?? ''} />;
        const canvasRef = canvasRefOf(src);
        if (canvasRef)
          return (
            <CanvasEmbed id={canvasRef.id} label={alt ?? ''} boardId={canvasRef.boardId} pageId={canvasRef.pageId} />
          );
        if (!src || src.startsWith('uploading:')) return null;
        return <DocsImage src={src} alt={alt ?? ''} />;
      },
      a: ({ href, children: inner, ...props }) => {
        const diagramId = diagramIdOf(href);
        if (diagramId) return <DiagramEmbed id={diagramId} label={textOf(inner)} />;
        const sketchId = sketchIdOf(href);
        if (sketchId) return <SketchEmbed id={sketchId} label={textOf(inner)} />;
        const canvasRef = canvasRefOf(href);
        if (canvasRef) return <CanvasChip id={canvasRef.id} label={textOf(inner)} boardId={canvasRef.boardId} />;
        if (href?.startsWith(NEEDS_INPUT_SCHEME)) return <span className="dk-needs-input">{inner}</span>;
        if (href?.startsWith(TICKET_SCHEME)) {
          const key = href.slice(TICKET_SCHEME.length);
          return <TicketRefChip ticketKey={key} />;
        }
        if (href?.startsWith(REF_SCHEME)) {
          const ref = parseDocRef(href);
          const label = textOf(inner);
          const dflt = ref ? (ref.anchor ? `${ref.title} › ${ref.anchor}` : ref.title) : label;
          return (
            <PageRefChip
              label={label}
              pageTitle={ref?.title}
              anchor={ref?.anchor}
              custom={!!ref && label !== dflt}
              refKey={ref ? pageRefKey(ref) : null}
            />
          );
        }
        if (href && href.includes('/uploads/')) return <FileAttachmentCard url={href} fileName={textOf(inner)} />;
        if (href?.startsWith('#')) {
          // A section of this page: scroll to it (a new window would open nothing in the desktop app)
          return (
            <a
              href={href}
              {...props}
              onClick={(e) => {
                e.preventDefault();
                const target = sectionOf(e.currentTarget, href);
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {inner}
            </a>
          );
        }
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

  // The page in pieces (one when not progressive), and how many are on the page yet: a new text starts over
  const pieces = useMemo(
    () => (progressive ? splitMarkdown(linked.markdown) : [{ text: linked.markdown, start: 0 }]),
    [progressive, linked.markdown],
  );
  // heading-id counts carried from one piece to the next (pieces render in order, each after the one before)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new page (new pieces) starts its counts over
  const slugCounts = useMemo<SlugCounts>(() => [], [pieces]);
  const [shown, setShown] = useState({ of: pieces, count: 1 });
  const count = shown.of === pieces ? shown.count : 1;
  const done = count >= pieces.length;
  const rendered = useRef(onRendered);
  rendered.current = onRendered;
  useEffect(() => {
    if (done) {
      rendered.current?.();
      return;
    }
    // after the browser has painted what is there: one piece per frame, with input handled in between
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setShown({ of: pieces, count: count + 1 }), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [done, count, pieces]);

  return (
    <ChipCtx.Provider value={chips}>
      <div className="dk-md" data-preview-scope data-rendering={done ? undefined : ''}>
        {pieces.slice(0, count).map((p, i) => (
          <MarkdownPiece
            key={p.start}
            text={p.text}
            components={components}
            changedIn={changedIn}
            index={pieces.length > 1 ? i : undefined}
            slugCounts={slugCounts}
          />
        ))}
      </div>
    </ChipCtx.Provider>
  );
}
