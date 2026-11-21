// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DocsCommentThread } from '../../../types/docs';
import { collectBlocks, rangeForThread } from './anchorDom';

const SAME = 'Same words here.';

function page(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <h2 id="docs-scan" data-block-id="b-h">Scan</h2>
    <p data-block-id="b-1">${SAME}</p>
    <p data-block-id="b-2">${SAME}</p>
    <p data-block-id="b-3">Last line.</p>`;
  document.body.appendChild(root);
  return root;
}

const thread = (anchor: Partial<NonNullable<DocsCommentThread['anchor']>>) =>
  ({
    id: 't',
    anchor: { quote: SAME, prefix: '', suffix: '', section: null, state: 'attached', pos: null, ...anchor },
  }) as unknown as DocsCommentThread;

const blockOf = (r: Range | null) =>
  (r?.startContainer.parentElement?.closest('[data-block-id]') as HTMLElement | null)?.dataset.blockId;

describe('rangeForThread: two identical paragraphs', () => {
  it('draws the thread in the block the server keeps it on', () => {
    const root = page();
    expect(blockOf(rangeForThread(collectBlocks(root), thread({ blockId: 'b-2' })))).toBe('b-2');
    expect(blockOf(rangeForThread(collectBlocks(root), thread({ blockId: 'b-1' })))).toBe('b-1');
  });

  it('without a block id, takes the copy nearest the server position', () => {
    const root = page();
    expect(blockOf(rangeForThread(collectBlocks(root), thread({ pos: 25 })))).toBe('b-2');
    expect(blockOf(rangeForThread(collectBlocks(root), thread({ pos: 4 })))).toBe('b-1');
  });
});
