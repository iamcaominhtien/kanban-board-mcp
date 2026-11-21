import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { placeQuote, textBlocks, type HighlightThread } from './CommentHighlights';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', attrs: { blockId: { default: null } } },
    text: {},
  },
});
const SAME = 'Same words here.';
const doc = schema.node('doc', null, [
  schema.node('paragraph', { blockId: 'b-1' }, [schema.text(SAME)]),
  schema.node('paragraph', { blockId: 'b-2' }, [schema.text(SAME)]),
]);
const t = (extra: Partial<HighlightThread>): HighlightThread => ({
  id: 't',
  number: 1,
  quote: SAME,
  prefix: '',
  suffix: '',
  section: null,
  ...extra,
});
const blockAt = (pos: number) => doc.resolve(pos).parent.attrs.blockId;

describe('placeQuote: two identical paragraphs in the editor', () => {
  it('knows the block of each textblock', () => {
    expect(textBlocks(doc).map((b) => b.blockId)).toEqual(['b-1', 'b-2']);
  });

  it('places the thread in the block the server keeps it on', () => {
    expect(blockAt(placeQuote(textBlocks(doc), t({ blockId: 'b-2' }))!.from)).toBe('b-2');
    expect(blockAt(placeQuote(textBlocks(doc), t({ blockId: 'b-1' }))!.from)).toBe('b-1');
  });

  it('without a block id, takes the copy nearest the server position', () => {
    expect(blockAt(placeQuote(textBlocks(doc), t({ pos: 20 }))!.from)).toBe('b-2');
  });
});
