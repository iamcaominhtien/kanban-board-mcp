/**
 * The hover card of a link to a block (RichDocsLinks E 27): the block itself — a table as a table, anything else as
 * its first lines — under its name and where it is, with Open in side panel and Open; and the card of a link whose
 * block is gone (G 37).
 */

import type { CSSProperties } from 'react';
import { useDocsPage } from '../../../api/docs';
import type { DocsLinkBlock, RichDoc } from '../../../types/docs';
import { cellText, docToText } from '../../../richdoc/text';
import { actorInitials, actorName, relativeTime } from '../../../utils/relativeTime';
import { avatarColors } from '../docsUi';
import { KindGlyph, KindTile, kindWord } from './BlockKind';

type Node = NonNullable<RichDoc['content']>[number];

/** The node of a block anywhere in a document. */
export function findNode(doc: RichDoc | null | undefined, blockId: string): Node | null {
  const walk = (nodes: Node[] | undefined): Node | null => {
    for (const n of nodes ?? []) {
      if ((n.attrs as { blockId?: string } | undefined)?.blockId === blockId) return n;
      const inner = walk(n.content as Node[] | undefined);
      if (inner) return inner;
    }
    return null;
  };
  return walk(doc?.content as Node[] | undefined);
}

const card: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  borderRadius: 12,
  background: '#FFFFFF',
  border: '1px solid #DCE3DE',
  boxShadow: '0 16px 40px rgba(30,42,34,0.2)',
  overflow: 'hidden',
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
};
const foot: CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '10px 14px',
  borderTop: '1px solid #E3E8E5',
  background: '#FBFCFB',
};
const th: CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: 11.5,
  background: '#F6FAF7',
  borderBottom: '1px solid #E3EAE5',
};
const td: CSSProperties = { padding: '6px 10px', fontSize: 12.5, borderBottom: '1px solid #EEF3EF' };

/** A table block as a small table: its first rows (the header row bold). */
function MiniTable({ node }: { node: Node }) {
  const rows = ((node.content ?? []) as Node[]).slice(0, 5);
  const [head, ...body] = rows;
  const cells = (r: Node) => ((r.content ?? []) as Node[]).slice(0, 4);
  return (
    <table
      style={{
        borderCollapse: 'collapse',
        border: '1px solid #E3EAE5',
        borderRadius: 8,
        width: '100%',
        fontFamily: "'Plus Jakarta Sans', sans-serif",
      }}
    >
      {head && (
        <thead>
          <tr>
            {cells(head).map((c, i) => (
              <th key={i} style={th}>
                {cellText(c)}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {body.map((r, i) => (
          <tr key={i}>
            {cells(r).map((c, j) => (
              <td key={j} style={td}>
                {cellText(c)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The hover card of a link to a block.
 * @param props.pageId - The page the block is on.
 * @param props.block - The block as the server names it.
 * @param props.onOpen - Open the page at the block.
 * @param props.onPeek - Open it in the side panel (the Docs page and tickets have one).
 */
export function BlockCard({
  pageId,
  block,
  onOpen,
  onPeek,
}: {
  pageId: string;
  block: DocsLinkBlock;
  onOpen: () => void;
  onPeek?: () => void;
}) {
  const { data: page } = useDocsPage(pageId);
  const node = page ? findNode(page.content ?? null, block.blockId) : null;
  const author = page ? actorName(page.updatedBy) : '';
  const text = node ? docToText({ type: 'doc', content: [node] }).trim() : '';
  return (
    <div className="docs-root" style={card} data-testid="block-card">
      <div style={{ padding: '13px 15px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KindTile kind={block.kind} box={30} radius={9} icon={15} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14.5,
                fontWeight: 700,
                color: '#1E2A22',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {block.label}
            </div>
            <div style={{ fontSize: 11.5, color: '#5B6B60' }}>
              {page?.title ?? ''} › {kindWord(block.kind)}
            </div>
          </div>
        </div>
        {node?.type === 'table' ? (
          <div style={{ marginTop: 10 }}>
            <MiniTable node={node} />
          </div>
        ) : (
          text && (
            <div
              style={{
                borderLeft: '2.5px solid #9CCBA8',
                paddingLeft: 11,
                marginTop: 10,
                fontSize: 12.5,
                lineHeight: 1.55,
                color: '#3A4A3E',
                whiteSpace: node?.type === 'codeBlock' ? 'pre' : 'normal',
                fontFamily: node?.type === 'codeBlock' ? "'JetBrains Mono', monospace" : undefined,
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {text}
            </div>
          )
        )}
        {page && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: '#5B6B60', marginTop: 9 }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                ...avatarColors(author),
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 7,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {actorInitials(page.updatedBy).slice(0, 2)}
            </span>
            <span>
              {author} · edited {relativeTime(page.updatedAt)}
            </span>
          </div>
        )}
      </div>
      <div style={foot}>
        {onPeek && (
          <button type="button" className="st-btn st-btn-sm" onClick={onPeek}>
            <svg
              aria-hidden="true"
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M15 4v16" />
            </svg>
            Open in side panel
          </button>
        )}
        <button type="button" className="st-btn st-btn-sm" onClick={onOpen}>
          Open
        </button>
      </div>
    </div>
  );
}

/**
 * The card of a link whose heading or block is gone (G 37): the words stay, the page still opens.
 * @param props.title - The page's title.
 * @param props.onOpen - Open the page.
 */
export function BlockGoneCard({ title, name, onOpen }: { title: string; name?: string | null; onOpen: () => void }) {
  return (
    <div
      className="docs-root"
      style={{ ...card, boxShadow: '0 12px 30px rgba(30,42,34,0.16)' }}
      data-testid="block-gone"
    >
      <div style={{ padding: '12px 14px', display: 'flex', gap: 10 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: '#C98A1B1A',
            color: '#C98A1B',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <KindGlyph kind="text" size={15} />
        </span>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>Block not found</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#3A4A3E', marginTop: 2 }}>
            {name
              ? `The block “${name}” was deleted from “${title}”.`
              : `The block this link points at was deleted from “${title}”.`}{' '}
            The page still opens.
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 14px 12px' }}>
        <button type="button" className="st-btn st-btn-sm" onClick={onOpen}>
          Open page
        </button>
      </div>
    </div>
  );
}
