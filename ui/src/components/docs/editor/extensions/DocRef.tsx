import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Icon } from '../../Icon';
import { useEditorEnv } from '../context';
import { useResolved } from '../useResolved';

export interface DocRefAttrs {
  page: string;
  section: string | null;
  label: string | null;
}

/** Serialize reference attrs to `[[Page#Section|label]]`. */
export function docRefMarkdown(a: DocRefAttrs): string {
  return `[[${a.page}${a.section ? `#${a.section}` : ''}${a.label ? `|${a.label}` : ''}]]`;
}

function DocRefView({ node, selected }: NodeViewProps) {
  const a = node.attrs as DocRefAttrs;
  const env = useEditorEnv();
  const res = useResolved({ kind: 'page', title: a.page, anchor: a.section });
  const missing = res?.status === 'missing' || res?.status === 'in_bin';
  const warn = res?.status === 'section_missing' || res?.status === 'ambiguous';
  const chipStyle = selected ? { boxShadow: '0 0 0 2px rgba(46,111,64,0.35)' } : undefined;

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
        if ((e.metaKey || e.ctrlKey) && res?.pageId) env?.onOpenPage?.(res.pageId, res.anchor);
      }}
    >
      <Icon name="i00" size={13} />
      {a.label ? (
        a.label
      ) : (
        <>
          {a.page}
          {a.section && (
            <>
              <span style={{ color: '#68BA7F', fontWeight: 500 }}>&#8250;</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Icon name="i04" size={11} strokeWidth={2.2} />
                {a.section}
              </span>
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

  renderHTML({ node }) {
    const a = node.attrs as DocRefAttrs;
    return [
      'span',
      mergeAttributes({
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
