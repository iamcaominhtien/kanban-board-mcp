/**
 * Reader for a rich Docs page (format 1, server/contract/richdoc): the page JSON drawn with React, with the same look
 * and behaviour as DocsMarkdown gives a Markdown page (heading ids and section links, reference chips, drawings, file
 * cards, code, callouts, tables, task lists, math, `[Needs input: …]` markers), plus the nodes and marks format 1
 * adds. Every block element carries `data-block-id`; the elements comments and find-in-page read
 * (`p, li, h1-h6, td, th, pre, .dk-code`) are the same as DocsMarkdown's.
 */

import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useResolveRefs } from '../../api/docs';
import type { DocsRefRequest, RichDoc } from '../../types/docs';
import { docToMarkdown, topLevelBlocks } from '../../richdoc';
import { inlineText } from '../../richdoc/text';
import { internalPageLink, pageRefKey, slugify } from '../../utils/docsMarkdown';
import { FileAttachmentCard } from '../FileAttachmentCard';
import { CanvasEmbed } from '../canvas/CanvasEmbed';
import { DiagramEmbed } from '../diagrams/DiagramEmbed';
import { SketchEmbed } from '../sketch/SketchEmbed';
import { useDocsPeek } from './DocsRefsContext';
import {
  ReaderCode,
  ReaderFile,
  ReaderHtmlEmbed,
  ReaderLinkEmbed,
  ReaderPageCard,
  ReaderTicketCard,
  ReaderVideo,
} from './embeds/readerEmbeds';
import { CALLOUT_STYLE, type CalloutKind } from './editor/constants';
import { Icon } from './Icon';
import {
  ChipCtx,
  Checkbox,
  DocsImage,
  METHOD_COLORS,
  PageRefChip,
  SectionAnchor,
  TicketRefChip,
  sectionOf,
  type ChipContext,
  type ReaderCallbacks,
  type RefResult,
} from './readerParts';

type Node = RichDoc;

/** Props of {@link RichDocView}. */
export interface RichDocViewProps extends ReaderCallbacks {
  /** The page: a TipTap JSON document. */
  doc: RichDoc;
  /** Project used to resolve references. */
  projectId: string;
  /** Space name used in reference tooltips. */
  projectName?: string;
  /** Plain-Markdown line (trimmed) -> version that added it: marks the top-level blocks "Changed in vN". */
  changedIn?: Map<string, number>;
  /** Render a long page in pieces of top-level blocks; the root carries `data-rendering` until all are there. */
  progressive?: boolean;
  /** Called once every piece is on the page (at once when not progressive). */
  onRendered?: () => void;
  /**
   * Draws around a top-level block (AI suggestions): gets the block and how it renders, returns what goes on the
   * page in its place. Keep it stable (a new function renders every block again).
   */
  blockWrap?: (node: RichDoc, rendered: ReactNode) => ReactNode;
  /** Drawn before the first block and after the last one, inside the reader (they can use {@link RichBlocks}). */
  lead?: ReactNode;
  tail?: ReactNode;
}

/** Top-level blocks per piece of a progressive render. */
const PIECE = 40;
const NO_REFS: DocsRefRequest[] = [];
const KEY_RE = /\b([A-Z][A-Z0-9]{1,5}-\d+)\b/g;
const NEEDS_INPUT_RE = /\\?\[Needs input:[^\]\n]*\\?\]/g;
const HEX_RE = /^#[0-9a-f]{6}$/i;

const TEXT_COLORS = new Set([
  'ink',
  'slate',
  'green',
  'olive',
  'teal',
  'blue',
  'violet',
  'pink',
  'red',
  'orange',
  'amber',
  'brown',
]);
const HIGHLIGHTS = new Set([
  'yellow',
  'lime',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'red',
  'orange',
  'sand',
  'grey',
  'slate',
]);

/** schema.json `fonts`: the font key -> its CSS family. */
const FONTS: Record<string, string> = {
  jakarta: "'Plus Jakarta Sans', sans-serif",
  lora: "'Lora', serif",
  'source-serif': "'Source Serif 4', serif",
  merriweather: "'Merriweather', serif",
  playfair: "'Playfair Display', serif",
  inter: "'Inter', sans-serif",
  'jetbrains-mono': "'JetBrains Mono', monospace",
  caveat: "'Caveat', cursive",
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The CSS value of a palette colour: a name becomes its variable (docs.css, from palette.json on the white
 * background), `#rrggbb` stays as it is; anything else is ignored.
 * @param kind - `c` for text colours, `hl` for highlights and cell shading.
 * @param value - The stored colour.
 */
function colorOf(kind: 'c' | 'hl', value: unknown): string | undefined {
  const v = str(value);
  if (HEX_RE.test(v)) return v;
  if ((kind === 'c' ? TEXT_COLORS : HIGHLIGHTS).has(v)) return `var(--rd-${kind}-${v})`;
  return undefined;
}

/** The text a heading's id is made from, as remarkDocs reads it from the Markdown. */
function headingSlugText(node: Node): string {
  return inlineText(node).replace(/[*_`~]/g, '');
}

/** The id of every heading in reading order (`docs-<slug>`, a repeat gets `-2`, `-3`…), as DocsMarkdown gives them. */
function headingIds(doc: Node): Map<Node, string> {
  const out = new Map<Node, string>();
  const seen = new Map<string, number>();
  const walk = (node: Node) => {
    if (node.type === 'heading') {
      const base = slugify(headingSlugText(node)) || 'section';
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.set(node, `docs-${n === 1 ? base : `${base}-${n}`}`);
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

const hasMark = (node: Node, type: string) => !!node.marks?.some((m) => m.type === type);
const linkOf = (node: Node) => node.marks?.find((m) => m.type === 'link');

/** The references of a page, each once, in the order they come: what the chips need resolved in one call. */
function collectRefs(doc: Node): DocsRefRequest[] {
  const refs: DocsRefRequest[] = [];
  const seen = new Set<string>();
  const add = (r: DocsRefRequest) => {
    const key = r.kind === 'page' ? `p:${pageRefKey(r)}` : `t:${r.key}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(r);
    }
  };
  const walk = (node: Node, code: boolean) => {
    const a = node.attrs ?? {};
    switch (node.type) {
      case 'docRef':
        if (str(a.page)) add({ kind: 'page', title: str(a.page), anchor: str(a.section) || null });
        return;
      case 'pageCard':
        if (str(a.page)) add({ kind: 'page', title: str(a.page), anchor: null });
        return;
      case 'ticketRef':
      case 'ticketCard':
        if (str(a.key)) add({ kind: 'ticket', key: str(a.key) });
        return;
      case 'text': {
        if (code || hasMark(node, 'code')) return;
        const link = linkOf(node);
        if (link) {
          const target = internalPageLink(str(link.attrs?.href));
          if (target) add({ kind: 'page', title: target.title, anchor: target.anchor, bySlug: true });
          return;
        }
        for (const m of (node.text ?? '').matchAll(KEY_RE)) add({ kind: 'ticket', key: m[1] });
        return;
      }
      default:
        node.content?.forEach((c) => walk(c, code || node.type === 'codeBlock'));
    }
  };
  walk(doc, false);
  return refs;
}

/** What a block element gets: its id, classes, style and the "Changed in vN" mark. */
interface BlockAttrs {
  'data-block-id'?: string;
  'data-changed-in'?: string;
  className?: string;
  style?: CSSProperties;
}

/** What the render functions read: the heading ids and the changed top-level blocks. */
interface Render {
  ids: Map<Node, string>;
  changed: Map<Node, number> | null;
  wrap?: (node: Node, rendered: ReactNode) => ReactNode;
}

/** Alignment, indent, line height and spacing of a text block. */
function textBlockStyle(a: Record<string, unknown>): CSSProperties | undefined {
  const s: CSSProperties = {};
  const align = str(a.textAlign);
  if (align) s.textAlign = align as CSSProperties['textAlign'];
  const indent = num(a.indent);
  if (indent) s.marginLeft = indent * 24;
  const lh = num(a.lineHeight);
  if (lh) s.lineHeight = lh;
  const before = num(a.spaceBefore);
  if (before != null) s.marginTop = before;
  const after = num(a.spaceAfter);
  if (after != null) s.marginBottom = after;
  return Object.keys(s).length ? s : undefined;
}

function blockAttrs(node: Node, r: Render, extraClass?: string | null, style?: CSSProperties): BlockAttrs {
  const out: BlockAttrs = {};
  const id = str(node.attrs?.blockId);
  if (id) out['data-block-id'] = id;
  const classes = extraClass ? [extraClass] : [];
  const v = r.changed?.get(node);
  if (v) {
    classes.push('dk-changed');
    out['data-changed-in'] = `Changed in v${v}`;
  }
  if (classes.length) out.className = classes.join(' ');
  if (style) out.style = style;
  return out;
}

/* ---------- inline ---------- */

/** Plain text with its `[Needs input: …]` markers and bare ticket keys drawn as chips. */
function richText(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(NEEDS_INPUT_RE);
  const markers = text.match(NEEDS_INPUT_RE) ?? [];
  parts.forEach((part, i) => {
    let last = 0;
    for (const m of part.matchAll(KEY_RE)) {
      const at = m.index ?? 0;
      if (at > last) out.push(part.slice(last, at));
      out.push(<TicketRefChip key={`${key}-k${i}-${at}`} ticketKey={m[1]} />);
      last = at + m[0].length;
    }
    if (last < part.length) out.push(part.slice(last));
    const marker = markers[i];
    if (marker) {
      const label = marker
        .replace(/\\/g, '')
        .slice(1, -1)
        .replace(/[[\]()]/g, '');
      out.push(
        <span key={`${key}-n${i}`} className="dk-needs-input">
          {label}
        </span>,
      );
    }
  });
  return out;
}

/** One text node with its marks, except the link (the caller wraps a run of linked text once). */
function markedText(node: Node, key: string): ReactNode {
  const text = node.text ?? '';
  const code = hasMark(node, 'code');
  let out: ReactNode = code || linkOf(node) ? text : richText(text, key);
  for (const mark of node.marks ?? []) {
    const a = mark.attrs ?? {};
    switch (mark.type) {
      case 'bold':
        out = <strong>{out}</strong>;
        break;
      case 'italic':
        out = <em>{out}</em>;
        break;
      case 'strike':
        out = <del>{out}</del>;
        break;
      case 'code':
        out = <code>{out}</code>;
        break;
      case 'underline':
        out = <u>{out}</u>;
        break;
      case 'superscript':
        out = <sup>{out}</sup>;
        break;
      case 'subscript':
        out = <sub>{out}</sub>;
        break;
      case 'highlight': {
        const bg = colorOf('hl', a.color);
        out = bg ? (
          <mark data-color={str(a.color)} style={{ background: bg }}>
            {out}
          </mark>
        ) : (
          <mark>{out}</mark>
        );
        break;
      }
      case 'textStyle': {
        const s: CSSProperties = {};
        const color = colorOf('c', a.color);
        if (color) s.color = color;
        const font = FONTS[str(a.fontFamily)];
        if (font) s.fontFamily = font;
        const size = num(a.fontSize);
        if (size) s.fontSize = size;
        if (Object.keys(s).length) out = <span style={s}>{out}</span>;
        break;
      }
      default:
    }
  }
  return out;
}

/** A link around already rendered text, as DocsMarkdown draws each kind of address. */
function LinkRun({ href, title, text, children }: { href: string; title?: string; text: string; children: ReactNode }) {
  const url = href.replace(/\/api\/uploads\//, '/uploads/');
  if (url.includes('/uploads/')) return <FileAttachmentCard url={url} fileName={text} />;
  if (url.startsWith('#')) {
    // a section of this page: scroll to it (a new window would open nothing in the desktop app)
    return (
      <a
        href={url}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          sectionOf(e.currentTarget, url)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      >
        {children}
      </a>
    );
  }
  const target = internalPageLink(url);
  if (target) {
    const dflt = target.anchor ? `${target.title} › ${target.anchor}` : target.title;
    return (
      <PageRefChip
        label={text || dflt}
        pageTitle={target.title}
        anchor={target.anchor}
        custom={!!text && text !== dflt}
        refKey={pageRefKey({ title: target.title, anchor: target.anchor, bySlug: true })}
      />
    );
  }
  return (
    <a className="dk-ext" href={url} title={title} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="i38" size={12} strokeWidth={2} />
    </a>
  );
}

function mathHtml(latex: string, display: boolean): string {
  return katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: 'ignore' });
}

/** The inline content of a text block. */
function inline(nodes: Node[] | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const list = nodes ?? [];
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    const a = node.attrs ?? {};
    const k = `${key}.${i}`;
    switch (node.type) {
      case 'text': {
        const link = linkOf(node);
        if (!link) {
          out.push(<span key={k}>{markedText(node, k)}</span>);
          break;
        }
        // the run of text under the same link is one link (one icon, one chip)
        const href = str(link.attrs?.href);
        const run: Node[] = [node];
        while (i + 1 < list.length && list[i + 1].type === 'text' && str(linkOf(list[i + 1])?.attrs?.href) === href) {
          i += 1;
          run.push(list[i]);
        }
        out.push(
          <LinkRun
            key={k}
            href={href}
            title={str(link.attrs?.title) || undefined}
            text={run.map((n) => n.text).join('')}
          >
            {run.map((n, j) => (
              <span key={j}>{markedText(n, `${k}.${j}`)}</span>
            ))}
          </LinkRun>,
        );
        break;
      }
      case 'hardBreak':
        out.push(<br key={k} />);
        break;
      case 'docRef': {
        const page = str(a.page);
        const section = str(a.section) || null;
        const dflt = section ? `${page} › ${section}` : page;
        const label = str(a.label) || dflt;
        out.push(
          <PageRefChip
            key={k}
            label={label}
            pageTitle={page}
            anchor={section}
            custom={label !== dflt}
            refKey={page ? pageRefKey({ title: page, anchor: section }) : null}
          />,
        );
        break;
      }
      case 'ticketRef':
        out.push(<TicketRefChip key={k} ticketKey={str(a.key)} />);
        break;
      case 'mathInline':
        out.push(
          <span
            key={k}
            className="dk-math-inline"
            dangerouslySetInnerHTML={{ __html: mathHtml(str(a.latex), false) }}
          />,
        );
        break;
      case 'image':
        out.push(<RichImage key={k} node={node} inline />);
        break;
      default:
        if (node.content) out.push(...inline(node.content, k));
    }
  }
  return out;
}

/* ---------- embeds ---------- */

function RichImage({ node, attrs, inline: isInline }: { node: Node; attrs?: BlockAttrs; inline?: boolean }) {
  const a = node.attrs ?? {};
  const src = str(a.src).replace(/\/api\/uploads\//, '/uploads/');
  if (!src || src.startsWith('uploading:')) return null;
  const width = num(a.width);
  const widthPct = num(a.widthPct);
  const radius = num(a.radius);
  const border = str(a.border);
  const style: CSSProperties = {
    ...(widthPct ? { width: '100%' } : width ? { width } : {}),
    ...(radius ? { borderRadius: radius } : {}),
    ...(border ? { border: `${border === 'thick' ? 3 : 1}px solid #D3DBD6` } : {}),
    ...(a.shadow ? { boxShadow: '0 6px 18px rgba(30,42,34,0.16)' } : {}),
  };
  const img = <DocsImage src={src} alt={str(a.alt)} style={style} />;
  if (isInline) return img;
  const href = str(a.href);
  const placement = str(a.placement) || 'block';
  const gap = num(a.wrapGap) ?? 16;
  const caption = str(a.caption);
  return (
    <figure
      {...attrs}
      className={[`dk-img dk-img-${placement}`, attrs?.className].filter(Boolean).join(' ')}
      style={{
        ...(widthPct ? { width: `${widthPct}%` } : {}),
        ...(placement === 'floatLeft' ? { marginRight: gap } : placement === 'floatRight' ? { marginLeft: gap } : {}),
      }}
    >
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {img}
        </a>
      ) : (
        img
      )}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/* ---------- blocks ---------- */

function children(node: Node, r: Render, key: string): ReactNode[] {
  return (node.content ?? []).map((c, i) => block(c, r, `${key}.${i}`));
}

function cellStyle(a: Record<string, unknown>, extra?: CSSProperties): CSSProperties | undefined {
  const s: CSSProperties = { ...extra };
  const bg = colorOf('hl', a.background);
  if (bg) s.background = bg;
  const align = str(a.align);
  if (align) s.textAlign = align as CSSProperties['textAlign'];
  const va = str(a.verticalAlign);
  if (va) s.verticalAlign = va as CSSProperties['verticalAlign'];
  const w = Array.isArray(a.colwidth) ? num(a.colwidth[0]) : null;
  if (w) s.width = w;
  return Object.keys(s).length ? s : undefined;
}

function tableCell(cell: Node, r: Render, key: string): ReactNode {
  const a = cell.attrs ?? {};
  const header = cell.type === 'tableHeader';
  const text = (cell.content ?? []).map(inlineText).join(' ').trim();
  const span = {
    colSpan: (num(a.colspan) ?? 1) > 1 ? (a.colspan as number) : undefined,
    rowSpan: (num(a.rowspan) ?? 1) > 1 ? (a.rowspan as number) : undefined,
  };
  if (header) {
    const width = text === 'Method' ? 78 : text === 'Auth' ? 70 : undefined;
    return (
      <th key={key} {...span} {...blockAttrs(cell, r, null, cellStyle(a, width ? { width } : undefined))}>
        {children(cell, r, key)}
      </th>
    );
  }
  return (
    <td key={key} {...span} {...blockAttrs(cell, r, null, cellStyle(a))}>
      {METHOD_COLORS[text] && cell.content?.length === 1 ? (
        // an HTTP method in an API table is drawn in its colour, as DocsMarkdown does
        <p {...blockAttrs(cell.content[0], r)}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: METHOD_COLORS[text] }}>
            {text}
          </span>
        </p>
      ) : (
        children(cell, r, key)
      )}
    </td>
  );
}

const ORDERED_STYLES: Record<string, string> = {
  decimal: 'decimal',
  'lower-alpha': 'lower-alpha',
  'upper-alpha': 'upper-alpha',
  'lower-roman': 'lower-roman',
  'upper-roman': 'upper-roman',
};

const RULE_GLYPHS: Record<string, string> = { dots: '•  •  •', stars: '*  *  *', fleuron: '❦' };

/** One block and what it holds. */
function block(node: Node, r: Render, key: string): ReactNode {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'paragraph': {
      const drop = num(a.dropCap);
      const variant = str(a.variant);
      const cls = [drop ? `dk-dropcap dk-dropcap-${drop}` : '', variant ? `dk-p-${variant}` : '']
        .filter(Boolean)
        .join(' ');
      return (
        <p key={key} {...blockAttrs(node, r, cls || null, textBlockStyle(a))}>
          {inline(node.content, key)}
        </p>
      );
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, num(a.level) ?? 1));
      const id = r.ids.get(node);
      const Tag = `h${level}` as 'h1';
      return (
        <Tag key={key} id={id} {...blockAttrs(node, r, null, textBlockStyle(a))}>
          {inline(node.content, key)}
          {level === 2 && id && <SectionAnchor slug={id.replace(/^docs-/, '')} />}
        </Tag>
      );
    }
    case 'blockquote': {
      const variant = str(a.variant) || 'plain';
      return (
        <blockquote key={key} {...blockAttrs(node, r, variant !== 'plain' ? `dk-quote-${variant}` : null)}>
          {children(node, r, key)}
          {str(a.source) && <footer className="dk-quote-source">— {str(a.source)}</footer>}
        </blockquote>
      );
    }
    case 'pullQuote':
      return (
        <figure
          key={key}
          {...blockAttrs(node, r, 'dk-pullquote', { textAlign: (str(a.textAlign) || 'center') as 'center' })}
        >
          <p>{inline(node.content, key)}</p>
          {str(a.source) && <figcaption>— {str(a.source)}</figcaption>}
        </figure>
      );
    case 'bulletList': {
      const ls = str(a.listStyle);
      return (
        <ul
          key={key}
          {...blockAttrs(
            node,
            r,
            ls === 'dash' ? 'dk-list-dash' : null,
            ls && ls !== 'dash' ? { listStyleType: ls } : undefined,
          )}
        >
          {children(node, r, key)}
        </ul>
      );
    }
    case 'orderedList': {
      const ls = str(a.listStyle);
      const start = num(a.start) ?? 1;
      return (
        <ol
          key={key}
          start={start !== 1 ? start : undefined}
          {...blockAttrs(
            node,
            r,
            ls === 'decimal-paren' ? 'dk-list-paren' : null,
            ORDERED_STYLES[ls] ? { listStyleType: ORDERED_STYLES[ls] } : undefined,
          )}
        >
          {children(node, r, key)}
        </ol>
      );
    }
    case 'listItem':
      return (
        <li key={key} {...blockAttrs(node, r)}>
          {children(node, r, key)}
        </li>
      );
    case 'taskList':
      return (
        <ul key={key} {...blockAttrs(node, r, 'dk-tasks')}>
          {children(node, r, key)}
        </ul>
      );
    case 'taskItem': {
      const checked = !!a.checked;
      return (
        <li key={key} {...blockAttrs(node, r, 'dk-task')}>
          <Checkbox checked={checked} />
          <div
            className="dk-task-body"
            style={
              checked ? { color: '#9AA8A0', textDecoration: 'line-through', textDecorationColor: '#C7D2CB' } : undefined
            }
          >
            {children(node, r, key)}
          </div>
        </li>
      );
    }
    case 'codeBlock':
      return <ReaderCode key={key} attrs={a} block={blockAttrs(node, r)} code={inlineText(node)} />;
    case 'horizontalRule': {
      const style = str(a.style) || 'line';
      const glyphs = RULE_GLYPHS[style];
      return glyphs ? (
        <div key={key} role="separator" {...blockAttrs(node, r, `dk-rule dk-rule-${style}`)}>
          {glyphs}
        </div>
      ) : (
        <hr key={key} {...blockAttrs(node, r, style !== 'line' ? `dk-rule dk-rule-${style}` : null)} />
      );
    }
    case 'table': {
      const rows = node.content ?? [];
      const head = rows[0]?.content?.length && rows[0].content.every((c) => c.type === 'tableHeader') ? rows[0] : null;
      const body = head ? rows.slice(1) : rows;
      const row = (rowNode: Node, i: number) => (
        <tr key={i} {...blockAttrs(rowNode, r)}>
          {(rowNode.content ?? []).map((c, j) => tableCell(c, r, `${key}.${i}.${j}`))}
        </tr>
      );
      const own = blockAttrs(node, r);
      const style = str(a.style);
      const table = (
        <div key={key} className="dk-table-wrap">
          <table
            className={['dk-table', style ? `dk-table-${style}` : '', str(a.width) === 'full' ? 'dk-table-full' : '']
              .filter(Boolean)
              .join(' ')}
            data-block-id={own['data-block-id']}
          >
            {head && <thead>{row(head, 0)}</thead>}
            <tbody>{body.map((b, i) => row(b, head ? i + 1 : i))}</tbody>
          </table>
        </div>
      );
      // the table clips its own overflow, so a "Changed in" mark sits on a wrapper
      return own.className ? (
        <div key={key} className={own.className} data-changed-in={own['data-changed-in']}>
          {table}
        </div>
      ) : (
        table
      );
    }
    case 'image':
      return <RichImage key={key} node={node} attrs={blockAttrs(node, r)} />;
    case 'callout': {
      const kind = ((str(a.kind) || 'info') in CALLOUT_STYLE ? str(a.kind) || 'info' : 'info') as CalloutKind;
      const pal = CALLOUT_STYLE[kind];
      const fg = colorOf('c', a.color) ?? pal.fg;
      const bg = colorOf('hl', a.color) ?? pal.bg;
      const look = str(a.style) || 'soft';
      const style: CSSProperties =
        look === 'bar'
          ? { background: bg, border: 'none', borderLeft: `3px solid ${fg}`, borderRadius: 4 }
          : look === 'outline'
            ? { background: 'transparent', border: `1px solid ${colorOf('c', a.color) ?? pal.border}` }
            : { background: bg, border: `1px solid ${a.color ? 'transparent' : pal.border}` };
      const icon = str(a.icon);
      const emoji = icon && !/^[\w:-]+$/.test(icon) ? icon : null;
      const own = blockAttrs(node, r, 'dk-callout', style);
      return (
        <div key={key} {...own} role="note" data-callout={kind} data-callout-style={look}>
          <span style={{ color: fg, marginTop: 2, display: 'flex' }}>
            {emoji ? <span aria-hidden="true">{emoji}</span> : <Icon name={pal.icon} size={17} strokeWidth={1.9} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {str(a.title) && (
              <p className="dk-callout-title">
                <strong>{str(a.title)}</strong>
              </p>
            )}
            {children(node, r, key)}
          </div>
        </div>
      );
    }
    case 'mathBlock':
      return (
        <div
          key={key}
          {...blockAttrs(node, r, 'dk-math-block')}
          dangerouslySetInnerHTML={{ __html: mathHtml(str(a.latex), true) }}
        />
      );
    case 'diagram': {
      const w = num(a.widthPct);
      return (
        <div key={key} {...blockAttrs(node, r, 'dk-embed', w ? { width: `${w}%` } : undefined)}>
          <DiagramEmbed id={str(a.id)} label={str(a.label)} version={num(a.version) ?? undefined} />
        </div>
      );
    }
    case 'sketch':
      return (
        <div key={key} {...blockAttrs(node, r, 'dk-embed')}>
          <SketchEmbed id={str(a.id)} label={str(a.label)} />
        </div>
      );
    case 'canvas': {
      const frag = str(a.fragment);
      return (
        <div key={key} {...blockAttrs(node, r, 'dk-embed')}>
          <CanvasEmbed
            id={str(a.id)}
            label={str(a.label)}
            boardId={frag.startsWith('b_') ? frag : undefined}
            pageId={frag.startsWith('p_') ? frag : undefined}
          />
        </div>
      );
    }
    case 'columns': {
      const cols = node.content ?? [];
      const ratio = str(a.ratio)
        .split(':')
        .map(Number)
        .filter((n) => n > 0);
      const template = (ratio.length === cols.length ? ratio : cols.map(() => 1)).map((n) => `${n}fr`).join(' ');
      return (
        <div
          key={key}
          {...blockAttrs(node, r, a.line ? 'dk-columns dk-columns-line' : 'dk-columns', {
            gridTemplateColumns: template,
            columnGap: num(a.gap) ?? 24,
          })}
        >
          {cols.map((col, i) => (
            <div key={i} {...blockAttrs(col, r, 'dk-column')}>
              {children(col, r, `${key}.${i}`)}
            </div>
          ))}
        </div>
      );
    }
    case 'video':
      return <ReaderVideo key={key} attrs={a} block={blockAttrs(node, r)} />;
    case 'htmlEmbed':
      return <ReaderHtmlEmbed key={key} attrs={a} block={blockAttrs(node, r)} />;
    case 'linkEmbed':
      return <ReaderLinkEmbed key={key} attrs={a} block={blockAttrs(node, r)} />;
    case 'fileCard':
      return <ReaderFile key={key} attrs={a} block={blockAttrs(node, r)} />;
    case 'pageCard':
      return <ReaderPageCard key={key} attrs={a} block={blockAttrs(node, r)} />;
    case 'ticketCard':
      return <ReaderTicketCard key={key} attrs={a} block={blockAttrs(node, r)} />;
    default:
      // a node this reader does not know: its blocks, or its text
      if (!node.content?.length) return null;
      return node.content.some((c) => c.type === 'text') ? (
        <p key={key} {...blockAttrs(node, r)}>
          {inline(node.content, key)}
        </p>
      ) : (
        <div key={key} {...blockAttrs(node, r)}>
          {children(node, r, key)}
        </div>
      );
  }
}

/** A run of top-level blocks; renders again only when its blocks or the marks change (chips update via ChipCtx). */
const Piece = memo(function Piece({ blocks, start, r }: { blocks: Node[]; start: number; r: Render }) {
  const { wrap } = r;
  if (!wrap) return <>{blocks.map((b, i) => block(b, r, String(start + i)))}</>;
  return (
    <>
      {blocks.map((b, i) => (
        <Fragment key={start + i}>{wrap(b, block(b, r, String(start + i)))}</Fragment>
      ))}
    </>
  );
});

/**
 * Some blocks of a rich page drawn as the reader draws them (an AI suggestion's block as it was or would be). Use it
 * inside a {@link RichDocView} (its `blockWrap`, `lead` or `tail`): reference chips read the reader's context.
 * @param props.nodes - The blocks.
 */
export function RichBlocks({ nodes }: { nodes: Node[] }) {
  const r = useMemo<Render>(() => ({ ids: headingIds({ type: 'doc', content: nodes }), changed: null }), [nodes]);
  return <>{nodes.map((n, i) => block(n, r, `x${i}`))}</>;
}

/** The top-level blocks (columns' blocks included) that a version changed, from the plain-Markdown lines it added. */
function changedBlocks(doc: Node, changedIn: Map<string, number> | undefined): Map<Node, number> | null {
  if (!changedIn?.size) return null;
  const out = new Map<Node, number>();
  for (const b of topLevelBlocks(doc)) {
    if (b.type === 'columns') continue;
    let v = 0;
    for (const line of docToMarkdown({ type: 'doc', content: [b] }).split('\n')) {
      const t = line.trim();
      if (t) v = Math.max(v, changedIn.get(t) ?? 0);
    }
    if (v) out.set(b, v);
  }
  return out;
}

/**
 * Reader for a rich Docs page.
 * @param props.doc - The page JSON.
 * @param props.projectId - Project used to resolve references.
 * @param props.projectName - Space name used in reference tooltips.
 * @param props.onOpenPage - Called with page id and anchor when a page reference is opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onCreatePage - Called with a title when a missing page reference is created.
 * @param props.onRestorePage - Called with a page id when a deleted referenced page is restored.
 * @param props.onReplaceSection - Called when a stale section reference is replaced.
 * @param props.changedIn - Marks top-level blocks whose Markdown lines a later version added ("Changed in vN").
 * @param props.progressive - Render a long page in pieces.
 * @param props.onRendered - Called once the whole page is on the page.
 * @param props.blockWrap - Draws around each top-level block (AI suggestions).
 * @param props.lead - Drawn before the first block.
 * @param props.tail - Drawn after the last block, once the whole page is there.
 */
export function RichDocView({
  doc,
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
  blockWrap,
  lead,
  tail,
}: RichDocViewProps) {
  const refs = useMemo(() => collectRefs(doc), [doc]);
  const resolved = useResolveRefs(projectId, refs.length ? refs : NO_REFS);
  const { pages, tickets } = useMemo(() => {
    const byPage = new Map<string, RefResult>();
    const byTicket = new Map<string, RefResult>();
    refs.forEach((ref, i) => {
      const res = resolved.data?.[i];
      if (!res) return;
      if (ref.kind === 'page') byPage.set(pageRefKey(ref), res);
      else byTicket.set(ref.key, res);
    });
    return { pages: byPage, tickets: byTicket };
  }, [refs, resolved.data]);
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

  const r = useMemo<Render>(
    () => ({ ids: headingIds(doc), changed: changedBlocks(doc, changedIn), wrap: blockWrap }),
    [doc, changedIn, blockWrap],
  );

  // the page in pieces of top-level blocks (one when not progressive), and how many are on the page yet
  const pieces = useMemo(() => {
    const blocks = doc.content ?? [];
    if (!progressive || blocks.length <= PIECE) return [{ start: 0, blocks }];
    const out: { start: number; blocks: Node[] }[] = [];
    for (let i = 0; i < blocks.length; i += PIECE) out.push({ start: i, blocks: blocks.slice(i, i + PIECE) });
    return out;
  }, [doc, progressive]);
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
      <div className="dk-md dk-rich" data-preview-scope data-rendering={done ? undefined : ''}>
        {lead}
        {pieces.slice(0, count).map((p) => (
          <Piece key={p.start} blocks={p.blocks} start={p.start} r={r} />
        ))}
        {done && tail}
      </div>
    </ChipCtx.Provider>
  );
}
