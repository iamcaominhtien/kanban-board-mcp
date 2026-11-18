/**
 * Docs health · Overlaps block by block (RichDocsLinks I 61): each pair of alike blocks of two rich pages, the block of
 * each side named with its kind, and how much of the text is the same; a side opens its page at that block.
 */

import type { OverlapBlock } from '../../../api/docsAiCare';
import { KindGlyph, kindWord } from './BlockKind';

function Side({ page, block, onOpen }: { page: string; block: OverlapBlock; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${page} at this ${kindWord(block.kind)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
        maxWidth: '45%',
        height: 24,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid #E8D9A0',
        background: '#FFF6D6',
        color: '#1E2A22',
        font: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <KindGlyph kind={block.kind} size={11} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {page} › {block.label}
      </span>
    </button>
  );
}

/**
 * The alike blocks of an overlap.
 * @param props.pages - The two pages.
 * @param props.blocks - Their alike blocks.
 * @param props.onOpenPage - Opens a page at a block.
 */
export function OverlapBlocks({
  pages,
  blocks,
  onOpenPage,
}: {
  pages: { pageId: string; title: string }[];
  blocks: { a: OverlapBlock; b: OverlapBlock; percent: number }[];
  onOpenPage: (id: string, anchor?: string) => void;
}) {
  const [pa, pb] = pages;
  if (!pa || !pb) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }} data-testid="overlap-blocks">
      {blocks.slice(0, 4).map((x, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Side page={pa.title} block={x.a} onOpen={() => onOpenPage(pa.pageId, x.a.blockId)} />
          <span style={{ fontSize: 11.5, color: '#5B6B60' }}>≈</span>
          <Side page={pb.title} block={x.b} onOpen={() => onOpenPage(pb.pageId, x.b.blockId)} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: '#8A5A00' }}>{x.percent}% alike</span>
        </div>
      ))}
      {blocks.length > 4 && (
        <span style={{ fontSize: 11.5, color: '#5B6B60' }}>and {blocks.length - 4} more alike blocks</span>
      )}
    </div>
  );
}
