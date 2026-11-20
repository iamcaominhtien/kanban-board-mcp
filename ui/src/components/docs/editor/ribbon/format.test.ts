// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../extensions';
import {
  applyStyle,
  changeIndent,
  clearFormatting,
  copyFormat,
  describeFormat,
  formatState,
  markState,
  openInsertMenu,
  pasteFormat,
  setAlign,
  setBlockAttrs,
  setDropCap,
  setFontFamily,
  setFontSize,
  setHighlight,
  setListStart,
  setTextColor,
  stepFontSize,
  styleOf,
  toggleMark,
} from './format';
import { RichFormatting, richStorage } from './RichFormatting';

let editor: Editor | null = null;
const opts = { onFocusMode: vi.fn(), onShortcuts: vi.fn() };

function make(content: JSONContent): Editor {
  editor = new Editor({
    extensions: [...buildExtensions({ isTicket: () => false, onLink: () => {} }), RichFormatting.configure(opts)],
    content,
  });
  return editor;
}

const para = (text: string, attrs?: Record<string, unknown>, marks?: JSONContent['marks']): JSONContent => ({
  type: 'paragraph',
  attrs,
  content: [{ type: 'text', text, ...(marks ? { marks } : null) }],
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

/** The marks of the first text node of the first block. */
const marksOf = (ed: Editor, block = 0) => ed.getJSON().content?.[block]?.content?.[0]?.marks ?? [];
const attrsOf = (ed: Editor, block = 0) => ed.getJSON().content?.[block]?.attrs ?? {};

afterEach(() => {
  editor?.destroy();
  editor = null;
  localStorage.clear();
});

describe('colour commands store palette names', () => {
  it('sets a named text colour, keeps the font, and Automatic removes the colour', () => {
    const ed = make(doc(para('The salt road')));
    ed.commands.setTextSelection({ from: 1, to: 9 });
    setFontFamily(ed, 'lora');
    setTextColor(ed, 'green');
    expect(marksOf(ed)).toEqual([{ type: 'textStyle', attrs: { color: 'green', fontFamily: 'lora', fontSize: null } }]);
    setTextColor(ed, null);
    expect(marksOf(ed)).toEqual([{ type: 'textStyle', attrs: { color: null, fontFamily: 'lora', fontSize: null } }]);
    setFontFamily(ed, null);
    // a text style with nothing left is removed
    expect(marksOf(ed)).toEqual([]);
  });

  it('stores a custom colour as #rrggbb and a highlight by name; No highlight removes it', () => {
    const ed = make(doc(para('Mai walked')));
    ed.commands.setTextSelection({ from: 1, to: 4 });
    setTextColor(ed, '#2e6f40');
    setHighlight(ed, 'teal');
    const marks = marksOf(ed);
    expect(marks).toContainEqual({ type: 'textStyle', attrs: { color: '#2e6f40', fontFamily: null, fontSize: null } });
    expect(marks).toContainEqual({ type: 'highlight', attrs: { color: 'teal' } });
    setHighlight(ed, null);
    expect(marksOf(ed).some((m) => m.type === 'highlight')).toBe(false);
  });

  it('draws a named colour through the page variable, not as a hex value', () => {
    const ed = make(doc(para('Green', undefined, [{ type: 'textStyle', attrs: { color: 'green' } }])));
    const span = ed.view.dom.querySelector('span[data-color="green"]') as HTMLElement;
    expect(span.getAttribute('style')).toContain('var(--rd-c-green');
    const json = JSON.stringify(ed.getJSON());
    expect(json).not.toContain('#2E6F40');
  });

  it('sets the size in px, clamped to 8 to 160, and steps through the size list', () => {
    const ed = make(doc(para('Big')));
    ed.commands.setTextSelection({ from: 1, to: 4 });
    setFontSize(ed, 300);
    expect(marksOf(ed)[0].attrs?.fontSize).toBe(160);
    setFontSize(ed, 3);
    expect(marksOf(ed)[0].attrs?.fontSize).toBe(8);
    expect(stepFontSize(18, 1)).toBe(20);
    expect(stepFontSize(18, -1)).toBe(16);
    expect(stepFontSize(17, -1)).toBe(16);
  });
});

describe('mark states', () => {
  it('is on, mixed or off over the selection; a mixed toggle makes it all on', () => {
    const ed = make(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' plain' },
        ],
      }),
    );
    ed.commands.setTextSelection({ from: 1, to: 5 });
    expect(markState(ed.state, 'bold')).toBe('on');
    ed.commands.setTextSelection({ from: 1, to: 11 });
    expect(markState(ed.state, 'bold')).toBe('mixed');
    toggleMark(ed, 'bold');
    expect(markState(ed.state, 'bold')).toBe('on');
    toggleMark(ed, 'bold');
    expect(markState(ed.state, 'bold')).toBe('off');
  });

  it('underline, superscript and subscript; super and sub exclude each other', () => {
    const ed = make(doc(para('H2O')));
    ed.commands.setTextSelection({ from: 2, to: 3 });
    toggleMark(ed, 'subscript');
    expect(markState(ed.state, 'subscript')).toBe('on');
    toggleMark(ed, 'superscript');
    expect(markState(ed.state, 'superscript')).toBe('on');
    expect(markState(ed.state, 'subscript')).toBe('off');
    toggleMark(ed, 'underline');
    expect(ed.getHTML()).toContain('<u>');
  });

  it('reads the colour as mixed when the selection holds two', () => {
    const ed = make(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'one', marks: [{ type: 'textStyle', attrs: { color: 'red' } }] },
          { type: 'text', text: 'two', marks: [{ type: 'textStyle', attrs: { color: 'blue' } }] },
        ],
      }),
    );
    ed.commands.setTextSelection({ from: 1, to: 7 });
    expect(formatState(ed).color).toBe('mixed');
    ed.commands.setTextSelection({ from: 1, to: 3 });
    expect(formatState(ed).color).toBe('red');
  });
});

describe('paragraph commands', () => {
  it('aligns every block of the selection; Left puts the default back', () => {
    const ed = make(
      doc(para('one'), para('two'), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'h' }] }),
    );
    ed.commands.setTextSelection({ from: 1, to: ed.state.doc.content.size - 1 });
    setAlign(ed, 'center');
    expect([0, 1, 2].map((i) => attrsOf(ed, i).textAlign)).toEqual(['center', 'center', 'center']);
    expect(formatState(ed).align).toBe('center');
    setAlign(ed, 'left');
    expect(attrsOf(ed, 0).textAlign).toBeNull();
  });

  it('indents a paragraph 0 to 8 and draws it in the editor', () => {
    const ed = make(doc(para('one')));
    ed.commands.setTextSelection(2);
    for (let i = 0; i < 10; i++) changeIndent(ed, 1);
    expect(attrsOf(ed).indent).toBe(8);
    changeIndent(ed, -1);
    expect(attrsOf(ed).indent).toBe(7);
    expect((ed.view.dom.querySelector('p') as HTMLElement).style.marginLeft).toBe('168px');
  });

  it('sets line height, spacing and a drop cap; headings get no drop cap', () => {
    const ed = make(
      doc(para('Nobody'), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'h' }] }),
    );
    ed.commands.setTextSelection({ from: 1, to: ed.state.doc.content.size - 1 });
    setBlockAttrs(ed, { lineHeight: 1.75, spaceBefore: 12, spaceAfter: 0 });
    setDropCap(ed, 3);
    expect(attrsOf(ed, 0)).toMatchObject({ lineHeight: 1.75, spaceBefore: 12, spaceAfter: 0, dropCap: 3 });
    expect(attrsOf(ed, 1)).not.toHaveProperty('dropCap');
    expect(ed.view.dom.querySelector('p')?.className).toContain('dk-dropcap-3');
  });

  it('styles: lead and small are paragraph variants, headings levels, quote wraps', () => {
    const ed = make(doc(para('text')));
    ed.commands.setTextSelection(2);
    applyStyle(ed, 'lead');
    expect(attrsOf(ed).variant).toBe('lead');
    expect(styleOf(ed.state)).toBe('lead');
    applyStyle(ed, 'h4');
    expect(ed.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 4 } });
    applyStyle(ed, 'quote');
    expect(ed.getJSON().content?.[0].type).toBe('blockquote');
    expect(styleOf(ed.state)).toBe('quote');
    applyStyle(ed, 'body');
    expect(ed.getJSON().content?.[0]).toMatchObject({ type: 'paragraph' });
    expect(styleOf(ed.state)).toBe('body');
  });

  it('clears text formatting but keeps links; clears paragraph formatting separately', () => {
    const ed = make(
      doc(
        para('link', { textAlign: 'right', indent: 2 }, [
          { type: 'bold' },
          { type: 'link', attrs: { href: 'https://x.test' } },
          { type: 'textStyle', attrs: { color: 'red' } },
        ]),
      ),
    );
    ed.commands.setTextSelection({ from: 1, to: 5 });
    clearFormatting(ed, 'text');
    expect(marksOf(ed).map((m) => m.type)).toEqual(['link']);
    expect(attrsOf(ed).textAlign).toBe('right');
    clearFormatting(ed, 'paragraph');
    expect(attrsOf(ed)).toMatchObject({ textAlign: null, indent: 0 });
  });

  it('starts a numbered list at a number', () => {
    const ed = make({
      type: 'doc',
      content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [para('a')] }] }],
    });
    ed.commands.setTextSelection(3);
    setListStart(ed, 4);
    expect(ed.getJSON().content?.[0].attrs?.start).toBe(4);
    expect(formatState(ed).listStart).toBe(4);
  });

  it('says a code block disables the text formats', () => {
    const ed = make({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'curl' }] }] });
    ed.commands.setTextSelection(2);
    expect(formatState(ed).inCode).toBe(true);
    expect(formatState(ed).style).toBe('code');
  });
});

describe('format painter', () => {
  it('copies font, size, bold and colour (not links) and paints them on another selection', () => {
    const ed = make(
      doc(
        para('The ferry', undefined, [
          { type: 'bold' },
          { type: 'link', attrs: { href: 'https://x.test' } },
          { type: 'textStyle', attrs: { color: 'green', fontFamily: 'lora', fontSize: 18 } },
        ]),
        para('Forty-one', undefined, [{ type: 'italic' }]),
      ),
    );
    ed.commands.setTextSelection({ from: 1, to: 4 });
    const f = copyFormat(ed);
    expect(f.marks.map((m) => m.type).sort()).toEqual(['bold', 'textStyle']);
    expect(describeFormat(f)).toBe('Lora 18 · bold · Green');
    const second = ed.state.doc.child(0).nodeSize + 1;
    ed.commands.setTextSelection({ from: second, to: second + 5 });
    pasteFormat(ed, f);
    const marks = ed.getJSON().content?.[1].content?.[0].marks ?? [];
    expect(marks.map((m) => m.type).sort()).toEqual(['bold', 'textStyle']);
  });

  it('Ctrl+Alt+C copies and Ctrl+Alt+V pastes the format', () => {
    const ed = make(doc(para('red', undefined, [{ type: 'textStyle', attrs: { color: 'red' } }]), para('plain')));
    ed.commands.setTextSelection({ from: 1, to: 3 });
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, altKey: true, bubbles: true }));
    expect(richStorage(ed)?.painter.get().format?.marks[0].attrs.color).toBe('red');
    ed.commands.setTextSelection({ from: 6, to: 11 });
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true, bubbles: true }));
    expect(ed.getJSON().content?.[1].content?.[0].marks).toEqual([
      { type: 'textStyle', attrs: { color: 'red', fontFamily: null, fontSize: null } },
    ]);
  });
});

describe('insert menu', () => {
  it('types "/" on an empty line, or opens a new line after the block', () => {
    const ed = make(doc(para('words'), { type: 'paragraph' }));
    ed.commands.setTextSelection(3);
    openInsertMenu(ed);
    expect(ed.getJSON().content?.[1]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: '/' }] });
  });
});
