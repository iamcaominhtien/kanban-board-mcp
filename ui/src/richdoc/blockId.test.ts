// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExtensions } from '../components/docs/editor/extensions';
import { BlockId } from './blockId';
import { BLOCK_ID_RE, ensureBlockIds, seqIds, stripBlockIds, topLevelBlocks } from './ids';
import { markdownToDoc } from '.';

const p = (text: string, blockId?: string): JSONContent => ({
  type: 'paragraph',
  ...(blockId ? { attrs: { blockId } } : {}),
  content: [{ type: 'text', text }],
});

describe('ensureBlockIds', () => {
  it('fills missing, malformed and duplicated ids; the first holder keeps a duplicate', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        p('a', 'b-aaaaaa'),
        p('b'),
        p('c', 'B-AAAAAA'),
        p('d', 'b-aaaaaa'),
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [p('e', 'b-000001')] }],
        },
      ],
    };
    const out = ensureBlockIds(doc, seqIds());
    const ids = (out.content ?? []).map((n) => n.attrs?.blockId);
    // b-000001 is taken further down, so the generator's first id is skipped
    expect(ids).toEqual(['b-aaaaaa', 'b-000002', 'b-000003', 'b-000004', 'b-000005']);
    const list = out.content![4];
    expect(list.content![0].attrs?.blockId).toBe('b-000006');
    expect(list.content![0].content![0].attrs?.blockId).toBe('b-000001');
    // pure
    expect(doc.content![1].attrs).toBeUndefined();
  });

  it('gives inline nodes, text and doc no id', () => {
    const out = ensureBlockIds(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'x' },
              { type: 'hardBreak' },
              { type: 'ticketRef', attrs: { key: 'KAN-1' } },
            ],
          },
        ],
      },
      seqIds(),
    );
    expect(out.attrs).toBeUndefined();
    expect(out.content![0].content!.map((n) => n.attrs?.blockId)).toEqual([undefined, undefined, undefined]);
  });

  it('strips ids', () => {
    const doc = ensureBlockIds({ type: 'doc', content: [p('a'), { type: 'heading', attrs: { level: 2 } }] }, seqIds());
    expect(stripBlockIds(doc)).toEqual({ type: 'doc', content: [p('a'), { type: 'heading', attrs: { level: 2 } }] });
  });

  it('lists the top-level blocks: doc children and column children', () => {
    const doc = markdownToDoc('# T\n\ntext', seqIds());
    const cols: JSONContent = {
      type: 'columns',
      content: [
        { type: 'column', content: [p('l1'), p('l2')] },
        { type: 'column', content: [p('r1')] },
      ],
    };
    const blocks = topLevelBlocks({ type: 'doc', content: [...doc.content!, cols, p('end')] });
    expect(blocks.map((b) => (b.type === 'paragraph' ? b.content![0].text : b.type))).toEqual([
      'heading',
      'text',
      'columns',
      'l1',
      'l2',
      'r1',
      'end',
    ]);
  });
});

describe('BlockId plugin', () => {
  let editor: Editor | null = null;
  afterEach(() => editor?.destroy());

  const make = (content: JSONContent) => {
    editor = new Editor({
      extensions: [
        ...buildExtensions({ isTicket: () => true, onLink: () => {} }).filter((e) => e.name !== 'richdocBlockId'),
        BlockId.configure({ generate: seqIds(0x100) }),
      ],
      content,
    });
    return editor;
  };
  const ids = (ed: Editor) => {
    const out: string[] = [];
    ed.state.doc.descendants((n) => {
      if ('blockId' in n.attrs) out.push(n.attrs.blockId as string);
    });
    return out;
  };

  it('puts data-block-id in the HTML and reads it back', () => {
    const ed = make({ type: 'doc', content: [p('one', 'b-0000aa')] });
    expect(ed.getHTML()).toContain('data-block-id="b-0000aa"');
    ed.commands.setContent('<p data-block-id="b-0000bb">x</p>');
    expect(ids(ed)).toEqual(['b-0000bb']);
  });

  it('gives a block split off a fresh id, the original keeps its own', () => {
    const ed = make({ type: 'doc', content: [p('hello world', 'b-0000aa')] });
    ed.commands.setTextSelection(7);
    ed.commands.splitBlock();
    expect(ed.state.doc.childCount).toBe(2);
    const [a, b] = ids(ed);
    expect(a).toBe('b-0000aa');
    expect(b).toMatch(BLOCK_ID_RE);
    expect(b).not.toBe(a);
  });

  it('gives a pasted copy a new id, even when it lands before the original', () => {
    const ed = make({ type: 'doc', content: [p('first', 'b-0000aa'), p('second', 'b-0000bb')] });
    ed.commands.insertContentAt(0, p('copy', 'b-0000bb'));
    const texts: string[] = [];
    ed.state.doc.forEach((n) => texts.push(`${n.textContent}:${n.attrs.blockId}`));
    expect(texts[1]).toBe('first:b-0000aa');
    expect(texts[2]).toBe('second:b-0000bb');
    expect(texts[0]).toMatch(/^copy:b-[0-9a-f]{6}$/);
    expect(texts[0]).not.toBe('copy:b-0000bb');
  });

  it('fills ids for new blocks and keeps them unique', () => {
    const ed = make({ type: 'doc', content: [p('a')] });
    ed.commands.insertContentAt(ed.state.doc.content.size, '<ul><li><p>x</p></li><li><p>y</p></li></ul>');
    const all = ids(ed);
    expect(all.every((id) => BLOCK_ID_RE.test(id))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not touch the drawing id of a diagram', () => {
    const ed = make({ type: 'doc', content: [p('a')] });
    ed.commands.insertContentAt(ed.state.doc.content.size, {
      type: 'diagram',
      attrs: { id: 'dg_abc12345', label: 'F' },
    });
    let d = ed.state.doc.firstChild!;
    ed.state.doc.forEach((n) => {
      if (n.type.name === 'diagram') d = n;
    });
    expect(d.attrs.id).toBe('dg_abc12345');
    expect(d.attrs.blockId).toMatch(BLOCK_ID_RE);
  });
});
