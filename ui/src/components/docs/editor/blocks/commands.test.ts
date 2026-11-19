// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_ID_RE } from '../../../../richdoc/ids';
import { buildExtensions } from '../extensions';
import { BlockKit, blockRange, chosenBlocks, setChosenBlocks } from './BlockKit';
import {
  blockAt,
  blockLink,
  canMergeCells,
  canSplitCell,
  deleteBlocks,
  dragRatio,
  duplicateBlock,
  insertColumns,
  insertDivider,
  insertTableSized,
  mergeSelectedCells,
  moveBlock,
  normalizeCrop,
  ratioFromWeights,
  setCellsAttr,
  setColumnCount,
  setNodeAttrs,
  setTableAttrs,
  snapWidth,
  splitSelectedCell,
  turnInto,
  weightsOf,
} from './commands';

let editor: Editor | null = null;

function make(content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: [...buildExtensions({ isTicket: () => false, onLink: () => {} }), BlockKit],
    content: { type: 'doc', content },
  });
  return editor;
}

const p = (text: string, blockId?: string): JSONContent => ({
  type: 'paragraph',
  ...(blockId ? { attrs: { blockId } } : {}),
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

/** Position of the n-th top-level block. */
function topPos(ed: Editor, n: number): number {
  let out = -1;
  ed.state.doc.forEach((_node, offset, i) => {
    if (i === n) out = offset;
  });
  return out;
}

/** Selects the cells from (r1, c1) to (r2, c2) of the first table. */
function selectCells(ed: Editor, from: [number, number], to: [number, number]) {
  const cells: Record<string, number> = {};
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    node.forEach((row, rowOff, r) => {
      row.forEach((_cell, cellOff, c) => {
        cells[`${r},${c}`] = pos + 1 + rowOff + 1 + cellOff;
      });
    });
    return false;
  });
  const sel = CellSelection.create(ed.state.doc, cells[from.join(',')], cells[to.join(',')]);
  ed.view.dispatch(ed.state.tr.setSelection(sel));
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('images', () => {
  it('snaps a resized width to 25, 50, 75 and 100 %', () => {
    expect(snapWidth(48)).toBe(50);
    expect(snapWidth(77)).toBe(75);
    expect(snapWidth(103)).toBe(100);
    expect(snapWidth(40)).toBe(40);
    expect(snapWidth(3)).toBe(10);
  });

  it('writes placement, width, wrap gap and crop as schema.json names them', () => {
    const ed = make([{ type: 'image', attrs: { src: '/uploads/a.png' } }, p('Text')]);
    setNodeAttrs(ed, 0, {
      placement: 'floatRight',
      widthPct: 40,
      wrapGap: 20,
      crop: normalizeCrop({ x: 0.1, y: 0, w: 0.5, h: 1 }),
    });
    const img = ed.getJSON().content?.[0];
    expect(img?.attrs).toMatchObject({
      placement: 'floatRight',
      widthPct: 40,
      wrapGap: 20,
      crop: { x: 0.1, y: 0, w: 0.5, h: 1 },
    });
    expect(img?.attrs?.src).toBe('/uploads/a.png');
  });

  it('keeps no crop for the whole picture and keeps a frame inside it', () => {
    expect(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    expect(normalizeCrop({ x: 0.8, y: -1, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });
});

describe('tables', () => {
  it('inserts a table of the size picked, with a header row and full width', () => {
    const ed = make([p('')]);
    insertTableSized(ed, { rows: 3, cols: 4, headerRow: true, fullWidth: true });
    const table = ed.getJSON().content?.find((n) => n.type === 'table');
    expect(table?.attrs?.width).toBe('full');
    expect(table?.content).toHaveLength(3);
    expect(table?.content?.[0].content).toHaveLength(4);
    expect(table?.content?.[0].content?.[0].type).toBe('tableHeader');
    expect(table?.content?.[1].content?.[0].type).toBe('tableCell');
  });

  it('merges a rectangle of cells and splits it back', () => {
    const ed = make([p('')]);
    insertTableSized(ed, { rows: 3, cols: 3, headerRow: false });
    selectCells(ed, [0, 0], [1, 1]);
    expect(canMergeCells(ed)).toBe('ok');
    expect(mergeSelectedCells(ed)).toBe('ok');
    const first = ed.getJSON().content?.find((n) => n.type === 'table')?.content?.[0].content?.[0];
    expect(first?.attrs).toMatchObject({ colspan: 2, rowspan: 2 });
    expect(canSplitCell(ed)).toBe(true);
    expect(splitSelectedCell(ed)).toBe(true);
    const after = ed.getJSON().content?.find((n) => n.type === 'table')?.content?.[0].content?.[0];
    expect(after?.attrs?.colspan ?? 1).toBe(1);
  });

  it('refuses to merge when a merged cell sticks out of the selection (not a rectangle)', () => {
    const ed = make([p('')]);
    insertTableSized(ed, { rows: 3, cols: 3, headerRow: false });
    selectCells(ed, [0, 0], [0, 1]);
    mergeSelectedCells(ed);
    // row 0: one cell spanning two columns, then one; select from row 0's last cell down to row 1, column 1
    selectCells(ed, [0, 1], [1, 1]);
    expect(canMergeCells(ed)).toBe('not-rectangle');
    expect(mergeSelectedCells(ed)).toBe('not-rectangle');
  });

  it('does not offer merge for one cell', () => {
    const ed = make([p('')]);
    insertTableSized(ed, { rows: 2, cols: 2, headerRow: false });
    selectCells(ed, [1, 1], [1, 1]);
    expect(canMergeCells(ed)).toBe('one-cell');
  });

  it('shades and aligns the selected cells with palette names, and styles the table', () => {
    const ed = make([p('')]);
    insertTableSized(ed, { rows: 2, cols: 2, headerRow: false });
    selectCells(ed, [0, 0], [0, 1]);
    setCellsAttr(ed, 'background', 'yellow');
    setCellsAttr(ed, 'verticalAlign', 'middle');
    setCellsAttr(ed, 'align', 'center');
    setTableAttrs(ed, { style: 'striped', width: 'fit' });
    const table = ed.getJSON().content?.find((n) => n.type === 'table');
    expect(table?.attrs).toMatchObject({ style: 'striped', width: 'fit' });
    for (const cell of table?.content?.[0].content ?? []) {
      expect(cell.attrs).toMatchObject({ background: 'yellow', verticalAlign: 'middle', align: 'center' });
    }
    expect(table?.content?.[1].content?.[0].attrs?.background ?? null).toBeNull();
  });
});

describe('columns', () => {
  it('inserts two empty columns', () => {
    const ed = make([p('')]);
    insertColumns(ed, 2);
    const cols = ed.getJSON().content?.find((n) => n.type === 'columns');
    expect(cols?.content).toHaveLength(2);
    expect(cols?.content?.every((c) => c.type === 'column')).toBe(true);
  });

  it('writes and reads ratios', () => {
    expect(ratioFromWeights([1, 1])).toBeNull();
    expect(ratioFromWeights([4, 8])).toBe('1:2');
    expect(ratioFromWeights([3, 6, 3])).toBe('1:2:1');
    expect(weightsOf('1:2', 2)).toEqual([1, 2]);
    expect(weightsOf('1:2', 3)).toEqual([1, 1, 1]);
  });

  it('snaps the dragged middle bar to a third', () => {
    expect(ratioFromWeights(dragRatio([1, 1], 0, 0.35))).toBe('1:2');
    expect(ratioFromWeights(dragRatio([1, 1], 0, 0.74))).toBe('3:1');
  });

  it('changes the number of columns without losing text', () => {
    const ed = make([
      {
        type: 'columns',
        attrs: { ratio: '1:2:1' },
        content: [
          { type: 'column', content: [p('One')] },
          { type: 'column', content: [p('Two')] },
          { type: 'column', content: [p('Three')] },
        ],
      },
    ]);
    setColumnCount(ed, 0, 2);
    const cols = ed.getJSON().content?.[0];
    expect(cols?.content).toHaveLength(2);
    expect(cols?.attrs?.ratio ?? null).toBeNull();
    expect(JSON.stringify(cols)).toContain('Three');
    setColumnCount(ed, 0, 3);
    expect(ed.getJSON().content?.[0].content).toHaveLength(3);
  });

  it('grows up to six columns, no more', () => {
    const ed = make([
      {
        type: 'columns',
        content: [
          { type: 'column', content: [p('One')] },
          { type: 'column', content: [p('Two')] },
        ],
      },
    ]);
    setColumnCount(ed, 0, 6);
    expect(ed.getJSON().content?.[0].content).toHaveLength(6);
    setColumnCount(ed, 0, 9);
    expect(ed.getJSON().content?.[0].content).toHaveLength(6);
  });
});

describe('callouts, dividers and lists', () => {
  it('sets a callout kind, colour, icon, style and title', () => {
    const ed = make([p('Note this')]);
    ed.commands.setTextSelection(2);
    ed.commands.setCallout('custom');
    setNodeAttrs(ed, 0, { color: 'violet', icon: '💡', style: 'bar', title: 'Idea' });
    expect(ed.getJSON().content?.[0].attrs).toMatchObject({
      kind: 'custom',
      color: 'violet',
      icon: '💡',
      style: 'bar',
      title: 'Idea',
    });
  });

  it('inserts a scene break as a divider style', () => {
    const ed = make([p('')]);
    insertDivider(ed, 'stars');
    expect(ed.getJSON().content?.some((n) => n.type === 'horizontalRule' && n.attrs?.style === 'stars')).toBe(true);
  });

  it('writes a list style and a start number', () => {
    const ed = make([{ type: 'orderedList', content: [{ type: 'listItem', content: [p('One')] }] }]);
    setNodeAttrs(ed, 0, { listStyle: 'lower-roman', start: 3 });
    expect(ed.getJSON().content?.[0].attrs).toMatchObject({ listStyle: 'lower-roman', start: 3 });
  });
});

describe('the block menu', () => {
  it('duplicates a block with a new block id', () => {
    const ed = make([p('First', 'b-00000a'), p('Second', 'b-00000b')]);
    duplicateBlock(ed, 0);
    const blocks = ed.getJSON().content ?? [];
    expect(blocks.map((b) => b.content?.[0].text)).toEqual(['First', 'First', 'Second']);
    expect(blocks[0].attrs?.blockId).toBe('b-00000a');
    expect(blocks[1].attrs?.blockId).not.toBe('b-00000a');
    expect(blocks[1].attrs?.blockId).toMatch(BLOCK_ID_RE);
  });

  it('gives every block inside a duplicated block a new id too', () => {
    const ed = make([
      {
        type: 'callout',
        attrs: { blockId: 'b-00000c' },
        content: [p('Inside', 'b-00000d')],
      },
    ]);
    duplicateBlock(ed, 0);
    const [a, b] = ed.getJSON().content ?? [];
    expect(b.attrs?.blockId).not.toBe(a.attrs?.blockId);
    expect(b.content?.[0].attrs?.blockId).not.toBe('b-00000d');
    expect(a.content?.[0].attrs?.blockId).toBe('b-00000d');
  });

  it('moves a block up and down and keeps its id', () => {
    const ed = make([p('A', 'b-00000a'), p('B', 'b-00000b'), p('C', 'b-00000c')]);
    moveBlock(ed, topPos(ed, 2), -1);
    expect(ed.getJSON().content?.map((b) => b.content?.[0].text)).toEqual(['A', 'C', 'B']);
    expect(ed.getJSON().content?.[1].attrs?.blockId).toBe('b-00000c');
    expect(moveBlock(ed, topPos(ed, 0), -1)).toBeNull();
    moveBlock(ed, topPos(ed, 0), 1);
    expect(ed.getJSON().content?.map((b) => b.content?.[0].text)).toEqual(['C', 'A', 'B']);
  });

  it('deletes several blocks and leaves an empty paragraph when nothing is left', () => {
    const ed = make([p('A'), p('B'), p('C')]);
    deleteBlocks(ed, [topPos(ed, 0), topPos(ed, 2)]);
    expect(ed.getJSON().content?.map((b) => b.content?.[0].text)).toEqual(['B']);
    deleteBlocks(ed, [0]);
    expect(ed.getJSON().content).toHaveLength(1);
    expect(ed.getJSON().content?.[0].type).toBe('paragraph');
  });

  it('turns a paragraph into a heading, a list and back, keeping the text', () => {
    const ed = make([p('Rollout plan')]);
    turnInto(ed, 0, 'h2');
    expect(ed.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    turnInto(ed, 0, 'bulletList');
    expect(ed.getJSON().content?.[0].type).toBe('bulletList');
    turnInto(ed, 0, 'orderedList');
    expect(ed.getJSON().content?.[0].type).toBe('orderedList');
    turnInto(ed, 0, 'paragraph');
    expect(ed.getJSON().content?.[0].type).toBe('paragraph');
    expect(ed.getText()).toContain('Rollout plan');
    turnInto(ed, 0, 'columns');
    expect(ed.getJSON().content?.[0].type).toBe('columns');
  });

  it('builds a link to a block', () => {
    expect(blockLink('https://kb.example/?docs=roadmap#old', 'b-1a2b3c')).toBe(
      'https://kb.example/?docs=roadmap#block-b-1a2b3c',
    );
  });

  it('finds the block of a position inside a column', () => {
    const ed = make([
      {
        type: 'columns',
        content: [
          { type: 'column', content: [p('Left')] },
          { type: 'column', content: [p('Right')] },
        ],
      },
    ]);
    const b = blockAt(ed.state, 4);
    expect(b?.node.type.name).toBe('paragraph');
  });

  it('chooses a range of blocks with Shift+click and duplicates them with Ctrl+D', () => {
    const ed = make([p('A'), p('B'), p('C'), p('D')]);
    setChosenBlocks(ed, blockRange(ed.state, topPos(ed, 1), topPos(ed, 2)));
    expect(chosenBlocks(ed.state)).toHaveLength(2);
    ed.commands.keyboardShortcut('Mod-d');
    expect(ed.getJSON().content?.map((b) => b.content?.[0].text)).toEqual(['A', 'B', 'C', 'B', 'C', 'D']);
  });
});
