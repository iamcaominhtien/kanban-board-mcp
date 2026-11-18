// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockId } from '../../../../richdoc/blockId';
import { SharedHighlights, findHighlight, sharedHighlightKey, type EditHighlight } from './SharedHighlights';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const hl = (over: Partial<EditHighlight>): EditHighlight => ({
  id: 'h1',
  blockId: 'b-1',
  endBlockId: null,
  start: 4,
  end: 9,
  quote: 'brief',
  ink: '#8A5A00',
  shapeSvg: '<svg width="10" height="10"></svg>',
  dot: '#8A2655',
  label: 'Highlighted Yellow by Hoa Mai',
  ...over,
});

function make() {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BlockId, SharedHighlights],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: 'b-1' }, content: [{ type: 'text', text: 'One brief fits.' }] }],
    },
  });
  return editor;
}

describe('shared highlights in Edit mode (K 101)', () => {
  it('finds the words by block and quote, nearest to the offsets when they moved', () => {
    const ed = make();
    const r = findHighlight(ed.state.doc, hl({}));
    expect(r && ed.state.doc.textBetween(r.from, r.to)).toBe('brief');
    // the offsets are stale: the quote is still found in its block
    const moved = findHighlight(ed.state.doc, hl({ start: 0, end: 5 }));
    expect(moved && ed.state.doc.textBetween(moved.from, moved.to)).toBe('brief');
    expect(findHighlight(ed.state.doc, hl({ quote: 'gone' }))).toBeNull();
    expect(findHighlight(ed.state.doc, hl({ blockId: 'b-9' }))).toBeNull();
  });

  it('draws a dotted line and a marker, never in the text, and follows the words while typing', () => {
    const ed = make();
    ed.view.dispatch(ed.state.tr.setMeta(sharedHighlightKey, [hl({})]));
    const root = ed.view.dom;
    expect(root.querySelector('.dk-hl-edit')?.textContent).toBe('brief');
    expect(root.querySelector('[data-testid="hl-edit-marker"]')?.getAttribute('aria-label')).toBe(
      'Highlighted Yellow by Hoa Mai',
    );
    expect(ed.getText()).toBe('One brief fits.');
    ed.commands.insertContentAt(1, 'A ');
    expect(root.querySelector('.dk-hl-edit')?.textContent).toBe('brief');
    // Hide: an empty list
    ed.view.dispatch(ed.state.tr.setMeta(sharedHighlightKey, []));
    expect(root.querySelector('.dk-hl-edit')).toBeNull();
  });
});
