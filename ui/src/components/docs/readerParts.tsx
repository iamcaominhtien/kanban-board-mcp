/**
 * The parts the two page readers share: DocsMarkdown (a page stored as Markdown) and RichDocView (a rich page,
 * format 1). Reference chips and how they reach their data, code blocks, task checkboxes, images, the section link of
 * an h2 and `#section` links.
 */

import { createContext, isValidElement, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { resolveOrigin } from '../../api/resolveOrigin';
import type { useResolveRefs } from '../../api/docs';
import { slugify } from '../../utils/docsMarkdown';
import { galleryAround, previewAttrs, usePreview } from '../preview/PreviewContext';
import { highlight } from './docsHighlight';
import type { useDocsPeek } from './DocsRefsContext';
import { Icon } from './Icon';
import { RefChip, type RefChipProps } from './RefChip';

/** What a reader calls when a reference is used. */
export interface ReaderCallbacks {
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  onCreatePage?: (title: string) => void;
  onRestorePage?: (pageId: string) => void;
  onReplaceSection?: RefChipProps['onReplaceSection'];
}

export const METHOD_COLORS: Record<string, string> = {
  GET: '#2F6FB0',
  POST: '#2E6F40',
  PUT: '#B4791E',
  PATCH: '#B4791E',
  DELETE: '#C4432A',
  HEAD: '#5B6B60',
  OPTIONS: '#5B6B60',
};

/** What the server says about one reference (resolved, missing, in the bin…). */
export type RefResult = NonNullable<ReturnType<typeof useResolveRefs>['data']>[number];

/** What the reference chips show and do. It reaches them through a context, so the parsed page (the slow part of
 *  rendering a long page) is not built again when the references resolve or a callback above changes. */
export interface ChipContext {
  pages: Map<string, RefResult>;
  tickets: Map<string, RefResult>;
  projectId: string;
  projectName?: string;
  peek: ReturnType<typeof useDocsPeek>;
  onOpenPage?: ReaderCallbacks['onOpenPage'];
  onOpenTicket?: ReaderCallbacks['onOpenTicket'];
  onCreatePage?: ReaderCallbacks['onCreatePage'];
  onRestorePage?: ReaderCallbacks['onRestorePage'];
  onReplaceSection?: ReaderCallbacks['onReplaceSection'];
}

/** The reference chips' context (see {@link ChipContext}). */
export const ChipCtx = createContext<ChipContext | null>(null);

/** A ticket key drawn as a chip, resolved through {@link ChipCtx}. */
export function TicketRefChip({ ticketKey }: { ticketKey: string }) {
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

/** A page reference drawn as a chip, resolved through {@link ChipCtx}. */
export function PageRefChip({
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

/** The text of a React node and its children. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/**
 * A code block with highlighting and a Copy button (class `dk-code`).
 * @param props.code - The code.
 * @param props.lang - Its language, for highlighting.
 * @param props.blockId - The rich page's block id (`data-block-id`), when there is one.
 * @param props.className - Classes added after `dk-code` (e.g. `dk-changed`).
 * @param props.changedIn - The "Changed in vN" label of a changed block.
 */
export function CodeBlock({
  code,
  lang,
  blockId,
  className,
  changedIn,
}: {
  code: string;
  lang?: string;
  blockId?: string;
  className?: string;
  changedIn?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={className ? `dk-code ${className}` : 'dk-code'}
      data-lang={lang}
      data-block-id={blockId}
      data-changed-in={changedIn}
    >
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

/** The read-only checkbox of a task item. */
export function Checkbox({ checked }: { checked: boolean }) {
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

/**
 * An image in a page: click (or Enter / Space) to open it in the viewer with the other images on the page.
 * @param props.src - Its address (`/uploads/…` is served by the board).
 * @param props.alt - Its alt text.
 * @param props.style - Extra style (a rich page's width, border, radius…).
 */
export function DocsImage({ src, alt, style }: { src: string; alt: string; style?: CSSProperties }) {
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
      style={{ cursor: 'zoom-in', ...style }}
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
export function sectionOf(from: HTMLElement, href: string): HTMLElement | null {
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

const ANCHOR_STYLE: CSSProperties = {
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
};

/**
 * The "#slug" link after an h2: a click copies the address of the section.
 * @param props.slug - The heading's slug (its id without the `docs-` prefix).
 */
export function SectionAnchor({ slug }: { slug: string }) {
  return (
    <a
      className="dk-anchor"
      href={`#${slug}`}
      title="Copy link to this section"
      onClick={(e) => {
        e.preventDefault();
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${slug}`;
        void navigator.clipboard?.writeText(url);
      }}
      style={ANCHOR_STYLE}
    >
      <Icon name="link" size={12} strokeWidth={2} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>#{slug}</span>
    </a>
  );
}
