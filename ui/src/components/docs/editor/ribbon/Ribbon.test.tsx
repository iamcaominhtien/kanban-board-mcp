// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../extensions';
import { EditorToolbar } from '../EditorToolbar';
import { RichFormatting } from './RichFormatting';
import { PainterBar } from './PainterBar';
import { ShortcutSheet } from './ShortcutSheet';

let editor: Editor | null = null;

function make(content: JSONContent): Editor {
  editor = new Editor({
    extensions: [
      ...buildExtensions({ isTicket: () => false, onLink: () => {} }),
      RichFormatting.configure({ onFocusMode: () => {}, onShortcuts: () => {} }),
    ],
    content,
  });
  return editor;
}

const PAGE: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and plain' },
      ],
    },
    { type: 'codeBlock', content: [{ type: 'text', text: 'curl -X POST' }] },
  ],
};

function bar(ed: Editor, variant: 'top' | 'strip' | 'bottom' = 'top', extra = {}) {
  render(
    <EditorToolbar
      editor={ed as never}
      variant={variant}
      onLink={vi.fn()}
      onPickImage={vi.fn()}
      ticketPrefix="KAN"
      onFind={vi.fn()}
      onFocusMode={vi.fn()}
      onShortcuts={vi.fn()}
      {...extra}
    />,
  );
  return screen.getByRole('toolbar', { name: 'Formatting' });
}

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  localStorage.clear();
});

describe('the ribbon', () => {
  it('has two rows on a desktop and shows on, mixed and disabled', () => {
    const ed = make(PAGE);
    const tb = bar(ed);
    expect(within(tb).getByRole('group', { name: 'Text' })).toBeTruthy();
    expect(within(tb).getByRole('group', { name: 'Paragraph, insert and tools' })).toBeTruthy();
    const bold = () => within(tb).getByRole('button', { name: 'Bold' });
    act(() => {
      ed.commands.setTextSelection({ from: 1, to: 5 });
    });
    expect(bold().getAttribute('aria-pressed')).toBe('true');
    act(() => {
      ed.commands.setTextSelection({ from: 1, to: 10 });
    });
    expect(bold().getAttribute('aria-pressed')).toBe('mixed');
    expect(bold().className).toContain('dk-rb-mixed');
    // in a code block the text formats are dimmed, the style says Code
    act(() => {
      ed.commands.setTextSelection(ed.state.doc.child(0).nodeSize + 3);
    });
    expect((bold() as HTMLButtonElement).disabled).toBe(true);
    expect(within(tb).getByRole('button', { name: 'Style: Code' })).toBeTruthy();
    // the tooltip names the shortcut
    expect(within(tb).getByRole('button', { name: 'Align centre' }).getAttribute('title')).toBe(
      'Align centre (Ctrl+Shift+E)',
    );
  });

  it('picks a named text colour and a highlight from their menus', () => {
    const ed = make(PAGE);
    const tb = bar(ed);
    act(() => {
      ed.commands.setTextSelection({ from: 6, to: 9 });
    });
    fireEvent.click(within(tb).getByRole('button', { name: 'Text colour' }));
    const pop = screen.getByTestId('ribbon-pop-color');
    // placed under its button, not left off screen (the button must be read before the click event is gone)
    expect(pop.style.left).not.toBe('-9999px');
    fireEvent.click(within(pop).getByRole('menuitemradio', { name: 'Green' }));
    expect(JSON.stringify(ed.getJSON())).toContain('"color":"green"');
    fireEvent.click(within(tb).getByRole('button', { name: 'Highlight colours' }));
    fireEvent.click(within(screen.getByTestId('ribbon-pop-hl')).getByRole('menuitemradio', { name: 'Teal' }));
    expect(JSON.stringify(ed.getJSON())).toContain('{"type":"highlight","attrs":{"color":"teal"}}');
    // the colour is remembered for Recent
    fireEvent.click(within(tb).getByRole('button', { name: 'Text colour' }));
    expect(screen.getByText('Recent')).toBeTruthy();
  });

  it('warns about a custom colour with low contrast, and still uses it', () => {
    const ed = make(PAGE);
    const tb = bar(ed);
    act(() => {
      ed.commands.setTextSelection({ from: 6, to: 9 });
    });
    fireEvent.click(within(tb).getByRole('button', { name: 'Text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Hex colour' }), { target: { value: '#E8B93A' } });
    expect(screen.getByTestId('color-contrast').textContent).toMatch(/Hard to read on white\. Try Amber\./);
    fireEvent.click(screen.getByRole('button', { name: 'Use colour' }));
    expect(JSON.stringify(ed.getJSON())).toContain('"color":"#e8b93a"');
  });

  it('applies a style from the Styles menu and an alignment', () => {
    const ed = make(PAGE);
    const tb = bar(ed);
    act(() => {
      ed.commands.setTextSelection(3);
    });
    fireEvent.click(within(tb).getByRole('button', { name: 'Style: Body' }));
    fireEvent.click(within(screen.getByTestId('style-menu')).getByRole('menuitemradio', { name: /Heading 2/ }));
    expect(ed.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    fireEvent.click(within(tb).getByRole('button', { name: 'Align right' }));
    expect(ed.getJSON().content?.[0].attrs?.textAlign).toBe('right');
  });

  it('a tablet strip keeps Undo, Redo and Insert pinned', () => {
    const ed = make(PAGE);
    const onInsert = vi.fn();
    const tb = bar(ed, 'strip', { onInsert });
    const pinned = tb.querySelector('.dk-rb-pinned') as HTMLElement;
    expect(within(pinned).getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(within(pinned).getByRole('button', { name: 'Redo' })).toBeTruthy();
    fireEvent.click(within(pinned).getByRole('button', { name: 'Insert' }));
    expect(onInsert).toHaveBeenCalled();
  });

  it('a phone gets eight buttons, the Aa sheet and the More sheet', () => {
    const ed = make(PAGE);
    const tb = bar(ed, 'bottom');
    const buttons = within(screen.getByTestId('phone-bar')).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Insert',
      'Format',
      'Bold',
      'Italic',
      'Text colour',
      'Bulleted list',
      'Alignment',
      'More',
    ]);
    fireEvent.click(within(tb).getByRole('button', { name: 'Format' }));
    const sheet = screen.getByTestId('format-sheet');
    act(() => {
      ed.commands.setTextSelection(3);
    });
    fireEvent.click(within(sheet).getByRole('menuitemradio', { name: 'Lead' }));
    expect(ed.getJSON().content?.[0].attrs?.variant).toBe('lead');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(tb).getByRole('button', { name: 'More' }));
    expect(within(screen.getByTestId('more-sheet')).getByRole('menuitem', { name: 'Find and replace' })).toBeTruthy();
  });

  it('the format painter: one click paints once, the bar says what was copied', () => {
    const ed = make(PAGE);
    const tb = bar(ed);
    render(<PainterBar editor={ed} />);
    act(() => {
      ed.commands.setTextSelection({ from: 1, to: 5 });
    });
    fireEvent.click(within(tb).getByRole('button', { name: 'Format painter' }), { detail: 1 });
    expect(screen.getByTestId('painter-bar').textContent).toContain('Format copied · bold');
    act(() => {
      ed.commands.setTextSelection({ from: 7, to: 10 });
      ed.view.dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(
          ed.state.doc
            .child(0)
            .nodeAt(7)
            ?.marks.map((m) => m.type.name),
        ).toEqual(['bold']);
        expect(screen.queryByTestId('painter-bar')).toBeNull();
        done();
      }, 10),
    );
  });
});

describe('the shortcut sheet', () => {
  it('lists the shortcuts in groups, searches them and shows Mac keys', () => {
    const onClose = vi.fn();
    render(<ShortcutSheet onClose={onClose} />);
    const sheet = screen.getByTestId('shortcut-sheet');
    expect(within(sheet).getByText('Superscript')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search shortcuts' }), { target: { value: 'justify' } });
    expect(within(sheet).queryByText('Superscript')).toBeNull();
    expect(within(sheet).getByText('Ctrl Shift J')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Mac' }));
    expect(within(sheet).getByText('⌘⇧J')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
