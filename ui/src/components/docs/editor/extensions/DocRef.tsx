import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Icon } from '../../Icon';
import { useEditorEnv } from '../context';
import { useResolved } from '../useResolved';
import { dataOnly } from '../../../../richdoc/extensions/attr';
import { KindGlyph } from '../../links/BlockKind';
import '../../links/links.css';

export interface DocRefAttrs {
  page: string;
  section: string | null;
  label: string | null;
  /** The page's id (links made in the editor store it: they follow the page when it is renamed). */
  pageId?: string | null;
  /** The heading or block the link points at (`[[Page#` → a heading or a block). */
  targetBlockId?: string | null;
  /** The heading's or block's name when the link was made (shown when it is gone). */
  targetLabel?: string | null;
}

/** Serialize reference attrs to `[[Page#Section|label]]`. */
export function docRefMarkdown(a: DocRefAttrs): string {
  return `[[${a.page}${a.section ? `#${a.section}` : ''}${a.label ? `|${a.label}` : ''}]]`;
}

function DocRefView({ node, selected }: NodeViewProps) {
  const a = node.attrs as DocRefAttrs;
  const env = useEditorEnv();
  const chipStyle = selected ? { boxShadow: '0 0 0 2px rgba(46,111,64,0.35)' } : undefined;
  const res = useResolved({
    kind: 'page',
    title: a.page,
    anchor: a.section,
    ...(a.pageId ? { pageId: a.pageId, blockId: a.targetBlockId ?? null } : {}),
  });
  const missing = res?.status === 'missing' || res?.status === 'in_bin';
  const warn = res?.status === 'section_missing' || res?.status === 'ambiguous';
  const block = res?.status === 'ok' && res.block && res.block.kind !== 'heading' ? res.block : null;
  const goTo = a.pageId && a.targetBlockId && res?.status === 'ok' ? a.targetBlockId : res?.anchor;
  const title = res?.status === 'ok' && a.pageId && res.title ? res.title : a.page;
  const section = res?.status === 'ok' && res.block?.kind === 'heading' ? res.block.label : a.section;

  if (res?.status === 'block_missing') {
    return (
      <NodeViewWrapper
        as="span"
        className="dk-chip dk-chip-block-missing"
        style={chipStyle}
        data-ref="page"
        contentEditable={false}
        title="Block not found: it was deleted. The page still opens."
      >
        <Icon name="i00" size={11} />
        {a.label || res.title || a.page}
        {!a.label && (
          <>
            <span className="dk-chip-sep">›</span>
            <KindGlyph kind="text" size={11} />
            <span className="dk-chip-target">{a.section ?? a.targetLabel ?? 'block'}</span>
          </>
        )}
      </NodeViewWrapper>
    );
  }

  if (missing) {
    return (
      <NodeViewWrapper
        as="span"
        className="dk-chip dk-chip-missing"
        style={chipStyle}
        data-ref="page"
        contentEditable={false}
        title={
          res?.status === 'in_bin'
            ? 'This page is in the Recycle Bin'
            : 'Page deleted or renamed outside the editor. Click to relink or create it.'
        }
      >
        <Icon name="i22" size={13} />
        {a.label || a.page}
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper
      as="span"
      className="dk-chip dk-chip-page"
      data-ref="page"
      contentEditable={false}
      style={{ ...chipStyle, ...(warn ? { borderStyle: 'dashed' } : null) }}
      title={warn ? 'The page exists, but has no such section' : res?.path}
      onClick={(e: React.MouseEvent) => {
        // plain click edits around the chip; Ctrl/Cmd+click opens the page
        if ((e.metaKey || e.ctrlKey) && res?.pageId) env?.onOpenPage?.(res.pageId, goTo);
      }}
    >
      <Icon name="i00" size={13} />
      {a.label ? (
        a.label
      ) : block ? (
        <>
          {title}
          <span className="dk-chip-sep">›</span>
          <KindGlyph kind={block.kind} size={11} />
          <span className="dk-chip-target">{block.label}</span>
        </>
      ) : (
        <>
          {title}
          {section && (
            <>
              <span style={{ color: '#68BA7F', fontWeight: 500 }}>&#8250;</span>
              {section}
            </>
          )}
        </>
      )}
    </NodeViewWrapper>
  );
}

/** Inline `[[Page#Section|label]]` reference, shown as the board's page chip. */
export const DocRef = Node.create({
  name: 'docRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      page: { default: '' },
      section: { default: null },
      label: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-docref]',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return { page: e.dataset.page ?? '', section: e.dataset.section || null, label: e.dataset.label || null };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as DocRefAttrs;
    return [
      'span',
      mergeAttributes(dataOnly(HTMLAttributes), {
        'data-docref': '',
        'data-page': a.page,
        'data-section': a.section ?? '',
        'data-label': a.label ?? '',
      }),
      docRefMarkdown(a),
    ];
  },

  renderText({ node }) {
    return docRefMarkdown(node.attrs as DocRefAttrs);
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocRefView, { as: 'span' } as never);
  },

  markdownTokenName: 'docRef',

  markdownTokenizer: {
    name: 'docRef',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize(src) {
      const m = /^\[\[([^\]|#\n]+?)(?:#([^\]|\n]+?))?(?:\|([^\]\n]+?))?\]\]/.exec(src);
      if (!m) return undefined;
      return {
        type: 'docRef',
        raw: m[0],
        page: m[1].trim(),
        section: m[2]?.trim() || null,
        label: m[3]?.trim() || null,
      };
    },
  },

  parseMarkdown(token, h) {
    const t = token as unknown as DocRefAttrs;
    return h.createNode('docRef', { page: t.page, section: t.section, label: t.label });
  },

  renderMarkdown(node) {
    return docRefMarkdown(node.attrs as DocRefAttrs);
  },
});
